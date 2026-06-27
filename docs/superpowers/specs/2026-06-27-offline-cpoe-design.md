# Offline-first drug-chart medication orders — Design Spec

**Date:** 2026-06-27
**Epic:** ROADMAP §0 Tier-2 Epic #9 (offline-first clinical writes), **slice 2**
**Branch:** `feat/offline-cpoe`
**Status:** Approved (design), pre-implementation
**Predecessor:** slice 1 (MAR) — see `2026-06-27-offline-mar-design.md`

---

## 1. Goal

Let a ward clinician place a **single inpatient medication order** from the drug-chart
screen while the device is offline, queue it safely, and — on reconnect — either record
it on the server or surface a **loud, clinically-framed conflict** if the server rejects
it (CDS blocker, device-posture, duplicate). No clinical write is ever dropped silently.

Slice 1 (MAR) proved the offline *administration* path; this slice proves the offline
*order-creation* path on the narrowest safe surface.

## 2. Grounding (what the 4 scouts established)

- **Write path.** Two staff screens create orders, both blocking, both hitting
  `POST /emr/orders` (single) or `/emr/orders/bulk` (atomic basket):
  - `OrderComposerScreen` (`apps/staff/lib/features/emr/screens/order_composer_screen.dart`)
    — the canonical CPOE composer, 8 order types, basket → advisory CDS pre-check →
    atomic bulk submit. **Out of scope** for this slice.
  - `DrugChartScreen` (`apps/staff/lib/features/ipd/screens/drug_chart_screen.dart`)
    — IPD bedside inline **single medication-order** entry via `_saveDraftRow`
    (POST `/emr/orders`). **This slice's target.**
  - Pure payload logic is already extracted into
    `apps/staff/lib/features/emr/models/order_draft.dart` (no Flutter imports) —
    reused so the offline body is byte-identical to the online one.

- **Dedup gap is real.** `POST /emr/orders` uses
  `requireIdempotencyKey({ required: false, scope: 'clinical_order' })`
  (`apps/backend/src/routes/emr/orderRoutes.js:152`). `clinical_orders` is unique only on
  `(tenant_id, order_number)`, and `order_number` is generated fresh per request — so a
  re-send **without** the idempotency key creates a **second order**. There is no
  MAR-style content-unique index.

- **Device-posture gate.** `rejectMobileClinicalWrite`
  (`apps/backend/src/middleware/rejectMobileClinicalWriteMiddleware.js`) sits in front of
  all three order routes and gates on the JWT `deviceType` claim:
  - non-staff role → exempt;
  - `deviceType` missing → **403 `DEVICE_TYPE_MISSING`**;
  - `deviceType === 'mobile'` → **403 `CLINICAL_WRITE_DESKTOP_ONLY`**;
  - `desktop`/`tablet` → pass.
  Clinical orders are therefore **desktop/tablet-only by policy**. The offline scenario
  is a ward **tablet** losing wifi, not a phone. Refresh preserves `deviceType`
  (`apps/backend/src/services/auth/authService.js:962` re-mints from `decoded.deviceType`),
  so a drain after the 8h token rotation still passes the gate.

- **CDS is server-side, blocking, fail-closed.** Medication orders run
  `validatePrescriptionSafety` (8-check suite) + `checkAntithromboticInteractions` before
  persist; a blocker returns `400 CDS_BLOCKER` unless overridden. There is **no
  client-side CDS** in the staff app (unlike MAR's ported 5-rights). An order-create has
  no cached state to verify against.

- **The silent-drop hole.** `ConnectivitySyncService.syncPending`
  (`packages/vhhealth_core/lib/services/connectivity_sync_service.dart`) treats only
  **409/422** as conflicts; every other 4xx (including `400 CDS_BLOCKER` and the
  device-posture `403`s) is treated as a transient, retried 5×, then **dropped with no UI
  indicator**. Fixing this is the core of the slice.

- **Reuse map.** Generic, carries straight over: `SecureBlobCodec`, `OfflineQueue`,
  `ConnectivitySyncService.instance.enqueue` (the sole write chokepoint), the
  idempotency-key plumbing (`VHHttpClient` auto-mints + reuses a stable key on every
  POST/PUT/PATCH — `packages/vhhealth_core/lib/services/http_client.dart:158`), the
  `ConflictRow` UX (needs a CPOE matcher + copy), staff-id owner scoping, tenant
  namespacing. **N/A for CPOE:** `MarOfflineCache`, `evaluateFiveRights`, the
  scan/hard-stop intent — order-create has no due-dose to cache or verify against.

## 3. Decisions (from brainstorming)

1. **Slice scope:** drug-chart single medication order only.
2. **Conflict model:** **review-only** — show the server's rejection reason; clinician
   Discards (confirmed) or Retries. No inline CDS override from the sync sheet (a blocked
   order must be re-entered deliberately online, seeing the blocker live).
3. **No client-side CDS / no cache priming in slice 1.** Orders queue CDS-unchecked; the
   server validates on drain. Safe because an *order* is not clinically effective until
   the server accepts it (contrast: an *administration*, which the drug was physically
   given for — MAR slice).
4. **Conflict classification = principled (approach B):** classify a drain response by
   whether a blind retry could ever succeed.
   - **400 / 403 / 409 / 422 → conflict** (definitive client-side rejection, needs a human).
   - **408 / 429 / 5xx → transient retry** (unchanged).
   This is one coherent rule, closes every silent-drop hole at once, and strengthens MAR
   too (a MAR 400 stops vanishing).
5. **Idempotency flip scoped to single `POST /orders` only** — `required:true`.
   `/orders/bulk` and `/orders/apply-set` stay `required:false` (composer follow-on).
   Safe: the admin portal only does `GET /emr/orders/patient/{uid}`; the only POST callers
   are key-bearing staff-app methods + backend tests.

## 4. Architecture

Mirror the MAR slice's shape, minus cache-priming and client-side clinical checks. Work
concentrates in two places: a **safe enqueue decision** (pure, testable) and making a
**server rejection on drain loud** (shared sync service + conflict UX).

## 5. Components / files

### 5.1 Backend (1 small change + test)

- **Modify** `apps/backend/src/routes/emr/orderRoutes.js:152` — flip `POST /orders` to
  `requireIdempotencyKey({ required: true, scope: 'clinical_order' })`. Leave
  `/orders/apply-set` (line 205) and `/orders/bulk` (line 250) at `required:false`.
- **Test** (deep, QA cluster): same order + same `Idempotency-Key` → exactly one
  `clinical_orders` row and the second call replays the first response; **missing key →
  400** (idempotency-required). Audit/adjust any existing backend test that POSTs
  `/emr/orders` without a key.

### 5.2 Shared core (`packages/vhhealth_core`)

- **Modify** `lib/services/connectivity_sync_service.dart` — the load-bearing change. In
  the drain loop, classify the response status (checked in this order):
  - `>= 200 && < 300` → success, remove from queue (unchanged).
  - status `∈ {400, 403, 409, 422}` → `markConflict(id, <server message>)` (was: only
    409/422). These are the definitive clinical rejections for this path: `400 CDS_BLOCKER`,
    device-posture `403`, plus the existing dedup/validation `409`/`422`.
  - **else (default, including 401/404/408/429/5xx)** → transient: `incrementRetry` /
    leave pending (unchanged behavior). Notably **401 stays transient** — `VHHttpClient`
    already refresh-retries a 401 internally, and a persistent auth failure is a re-login
    problem the next online session resolves, **not** a clinical conflict (turning it into
    one would be noisy). The conflict set is exactly the four codes above; everything else
    retries.
  Carry the server's `message`/`code` into `conflict_reason`.
- **Modify** `lib/widgets/offline_sync_badge.dart` — extend `ConflictRow`:
  - add a CPOE matcher: `endpoint.contains('/emr/orders')` →
  - clinical copy: *"Medication order not placed on the server — review needed"* +
    show the `conflict_reason` (server's blocker text) +
  - **confirm-on-discard** dialog (discarding = the ordered drug was never ordered).
  - MAR matcher (`/clinical/mar/`) and the generic path unchanged.

### 5.3 Staff app (`apps/staff`)

- **Create** `lib/features/ipd/drug_chart_offline_order.dart` (pure, no Flutter imports) —
  `OfflineOrderIntent { bool block; bool enqueue; String endpoint; Map<String,dynamic> body; String? reason; }`
  and `OfflineOrderIntent buildOfflineOrderIntent({ required Map<String,dynamic> draft, required String deviceType, required bool isOnline })`.
  - **Safety invariant:** `block = deviceType.trim().toLowerCase() == 'mobile' || deviceType.trim().isEmpty;`
    `enqueue = !block;` — a phone-mode (or unknown-device) session **never enqueues** (it
    would 403 on drain). `endpoint = '/emr/orders'`. `body` is built by reusing
    `order_draft.dart`'s single-order/`buildBulkOrderItem` payload builder so it is
    byte-identical to the online request.
- **Modify** `lib/features/ipd/screens/drug_chart_screen.dart` `_saveDraftRow`:
  - if `ConnectivitySyncService.instance.isOnline` → existing blocking online call
    (unchanged).
  - else → `final intent = buildOfflineOrderIntent(draft: …, deviceType: <local>, isOnline: false);`
    - `intent.block` → error toast ("Medication orders can't be queued on this device"),
      **no enqueue**, keep the row.
    - else → `ConnectivitySyncService.instance.enqueue(endpoint: intent.endpoint, method: 'POST', body: intent.body, contextLabel: 'Medication order — <drug>')`,
      mark the row "pending sync", refresh the chart.
  - `deviceType` source: the staff app's local auth state / token claim (the app sets its
    own mode at login). The screen is already only reachable in a clinical-write-capable
    mode, so the guard is defense-in-depth.

## 6. Data flow

- **Online:** unchanged — blocking POST, server CDS runs, SnackBar success/CDS-blocker.
- **Offline:** row entry → `buildOfflineOrderIntent` → (phone-mode? block & toast) →
  `enqueue` (AES-256-GCM at rest, staff-scoped, stable idempotency key) → row shows
  "pending sync" → on reconnect `syncPending` drains:
  - **2xx** → clears the queued write;
  - **400 CDS_BLOCKER / 403 / 409 / 422** → conflict surfaced in the `OfflineSyncBadge`
    with the server's reason; clinician Discards (confirmed) or Retries;
  - **408/429/5xx** → silent transient retry (legitimate; will succeed later).

No order is acted on clinically until the server accepts it — which is exactly why
queuing CDS-unchecked is safe for an *order*.

## 7. Safety invariants (the load-bearing checks)

1. **Phone-mode never enqueues** — pure-helper `block` guard + the screen's existing
   desktop/tablet gating. (Two independent guards, MAR-style.)
2. **No clinical write silently dropped** — approach (B) makes every definitive rejection
   (400/403/409/422) a visible conflict.
3. **Re-send can't double-order** — `required:true` idempotency + the stable key
   `VHHttpClient` already reuses across redrains.
4. **Discarding a med-order conflict requires confirmation.**
5. **Online path byte-identical**; the only shared-component change (syncPending
   classification) is strictly safer for existing MAR traffic.

## 8. Testing

- **Backend deep test** (QA cluster): idempotency `required:true` — replay returns one
  row; missing key → 400.
- **Dart unit** (`buildOfflineOrderIntent`): phone-mode/empty-device → `block`, no
  enqueue; desktop/tablet → enqueue with `endpoint == '/emr/orders'` and a body equal to
  the online builder's output.
- **Dart unit** (`syncPending` classification, mock client): 400/403/409/422 → conflict;
  401/408/429/5xx → retry (not conflict).
- **Dart widget** (`ConflictRow`): CPOE endpoint → clinical copy + confirm-on-discard;
  MAR + generic paths unchanged.
- **Regression:** full `vhhealth_core` + `apps/staff` flutter test + analyze; backend
  MAR + order deep tests green (the syncPending change must not regress MAR).

### Honest boundary

The live **offline → reconnect → drain** round-trip is **manual** (no airplane-mode in
CI). Deploy stays **HELD** (plain pushes don't deploy; only tags publish images).
Automated tests cover the client logic (intent, classification, conflict UX) + backend
idempotency.

## 9. Out of scope (follow-ons)

- CPOE composer offline (`OrderComposerScreen`, `/orders/bulk` atomic partial-failure,
  advisory CDS pre-check).
- Non-medication order types (lab/radiology/ecg/consultation/nursing/diet/other).
- Offline allergy pre-warn (would need MAR-style cache priming).
- `deviceType`-on-refresh regression test (refresh already preserves it; a belt-and-
  suspenders test is a nice-to-have).
- `order_number` generation race (`generateOrderNumbers` reads MAX then increments) —
  pre-existing, unrelated to offline; flagged by scout B for a future hardening pass.

## 10. Closeout (per standing workflow)

Subagent-driven build on `feat/offline-cpoe` → full gate → merge `--no-ff` to main →
push **both** remotes (`github` + `origin`) → delete branch → tick ROADMAP §9 slice 2 →
update `project_vh_health_offline_clinical_writes` memory. **Deploy HELD.**
