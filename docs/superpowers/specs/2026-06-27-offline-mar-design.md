# Offline-First Clinical Writes — Slice 1 (MAR) Design

**Date:** 2026-06-27
**Epic:** ROADMAP §0 Tier-2 #9 (Offline-first clinical capture), surfaced by the 2026-06-22 audit
**Status:** Approved design → ready for implementation plan
**Scope:** The Flutter STAFF app MAR (medication administration) bedside flow. First slice of a multi-slice epic — proves "wire a clinical write screen through the existing offline queue, with full client-side safety verify" on the safest-dedup, highest-value screen. Later slices (drug-chart/CPOE orders, then e-Rx) reuse the pattern.

## Goal

Make bedside medication administration (MAR / BCMA) work when a ward loses connectivity, WITHOUT losing the safety guarantee or risking a double-administration. Today the MAR scan screen calls the server directly and blocking; a network blip shows an error and the nurse must re-scan the whole flow (a HIGH data-loss path the audit flagged). After this slice: the nurse scans, gets the **same 5-rights check client-side**, administers, and the write is queued + auto-synced on reconnect — with any server-side rejection surfaced as a clinical conflict for review, never a silent drop.

## Background — current state (explored 2026-06-27)

The "no offline queue" framing is wrong: a mature offline-write stack already exists in `packages/vhhealth_core`, but the clinical write SCREENS aren't wired to it.

**Already built (reuse, don't reinvent):**
- **`OfflineQueue`** (`lib/services/offline_queue.dart`) — sqflite `pending_writes` table (v4): endpoint, method, AES-256-GCM-encrypted body, `idempotency_key`, `staff_id` (owner-scoped for shared ward devices), status (pending/conflict), retry_count, context_label.
- **`ConnectivitySyncService`** (`lib/services/connectivity_sync_service.dart`, a `ChangeNotifier`) — `connectivity_plus` listener, auto-drains on reconnect, `enqueue(endpoint, method, body, contextLabel?)`, `syncPending()`, 409/422→conflict, `discardConflict`/`retryConflict`.
- **`VHHttpClient`** (`lib/services/http_client.dart`) — the single write chokepoint; injects a stable `Idempotency-Key` (minted once per write via `IdempotencyKey.generate()`, reused across retries/redrains).
- **`OfflineSyncBadge` + `SyncStatusSheet`** (`lib/widgets/offline_sync_badge.dart`) — pending/syncing/conflict UI already built.

**The gap:** the MAR screen (`apps/staff/lib/features/nursing/screens/mar_scan_screen.dart`) calls `MedicalApiService.administerWithScan()` → `VHHttpClient` directly and blocking. On network failure it shows an error with no queue → the scan + verify are lost.

**MAR dedup safety (why MAR is the safest first slice):**
- `POST /clinical/mar/:id/administer-with-scan` targets an EXISTING MAR row id; the row's status FSM (`scheduled`→`administered`) makes a re-send return 409 (already administered), and the DB unique index `uniq_mar_administered_dose` (migration 327: `(patient_uid, medication_name, scheduled_time) WHERE status='administered'`) **physically prevents a double-administration** regardless of retries/concurrency. So a queued re-send is correctness-safe with NO backend change to the dedup path.

**The offline-verify problem:** the safety value of MAR is the **5-rights check**, which today is a server round-trip (`POST /clinical/mar/verify` dry-run → `administer-with-scan` re-verifies). Offline, the server is unreachable — so to administer safely offline, the device must (a) have the patient's due MAR rows cached and (b) run the 5-rights client-side. The server's `evaluate5Rights` (`src/services/clinical/marFiveRightsService.js`) is deterministic and portable: patient = normalized-uuid equality; drug = medication-name substring (either direction) [or a `vhmp-` pack-barcode lookup — server-only]; dose = `dose||dosage` present; route = present; time = `|minutesFromScheduled| ≤ windowMinutes` (default 60).

## Chosen approach

**Full client-side 5-rights at the bedside + queue the administer** (vs scan-and-defer-verify-to-drain [unsafe — nurse administers with no check], or block-MAR-when-offline [useless in the dead-zone you need it]). Only this approach preserves the BCMA safety guarantee offline.

## Architecture — five tight units

### Unit 1 — MAR due-dose cache (`vhhealth_core`)

`packages/vhhealth_core/lib/services/mar_offline_cache.dart`: when the MAR/patient view loads online, persist the patient's due/scheduled MAR rows locally, **encrypted at rest** (reuse the offline-queue's AES-256-GCM key/secure-storage pattern), keyed by `(staff_id, patient_uid, service_date)`. Source = the existing `GET /clinical/mar/patient/{patientUid}` (returns `id, status, medication_name, dose, route, scheduled_time, …` per the `MarRecord` contract). Exposes `cacheDueDoses(patientUid, rows)` + `getCachedDose(patientUid, maId)` / `getCachedDoses(patientUid)`. Interface: what it does = "give the bedside flow the MAR rows to verify against offline"; depends on = secure storage + the crypto helper. Stale-data guard: cache carries `cached_at`; the UI shows a "cached Ns ago — offline" note so the nurse knows they're working off a snapshot.

### Unit 2 — Client-side 5-rights (`vhhealth_core`, pure function)

`packages/vhhealth_core/lib/services/mar_five_rights.dart`: a pure `evaluateFiveRights({ dose (cached MAR row), scannedPatientUid, scannedBarcode, at })` → `{ patient, drug, dose, route, time, allPassed }`, a faithful port of the server algorithm (window 60 min, computed against `at` = the bedside time). **Hard-stops (patient or drug fail) → the flow ABORTS offline and forces a re-scan; we never queue a wrong administration.** Soft-fails (dose/route/time) require the same structured override reason the online path demands. **Fidelity note (in spec + UI):** the server's `vhmp-` pack-barcode drug match needs a pharmacy lookup unavailable offline, so offline drug-right is name-match only — a slightly weaker (never stronger) drug check; the server re-verifies fully on drain.

### Unit 3 — Offline administer (staff app + the seam)

In `mar_scan_screen.dart` / `MedicalApiService.administerWithScan`: try the write online first; on a network failure (not a 4xx — a real connectivity error), **enqueue** `POST /clinical/mar/{id}/administer-with-scan` via `ConnectivitySyncService.enqueue()` (idempotency key + body encryption + owner-scoping already handled), with the body carrying `scanned_patient_uid`, `scanned_barcode`, `override_reason?`, and the captured **`administered_at`** (the real bedside time). The screen shows "Recorded ✓ — pending sync" (distinct from the online "Recorded ✓") + the `OfflineSyncBadge`. On reconnect the queue auto-drains. When OFFLINE is detected up front (connectivity already down), the flow uses Unit 1's cache + Unit 2's client verify instead of the server `verify` round-trip.

### Unit 4 — Backend: bedside-time accommodation

`POST /clinical/mar/{id}/administer-with-scan` (`marFiveRightsService.administerWithScan`) accepts an optional `administered_at` (ISO, the bedside time):
- The **time-right** is evaluated against `administered_at` (not drain-time `NOW()`), so a dose given offline at 10:00 but drained at 10:45 isn't spuriously time-rejected.
- The recorded `administered_at` (+ `patient_scanned_at`/`medication_scanned_at`) use the bedside time, so the MAR records WHEN the drug was given, not when it synced — a clinical-correctness requirement.
- `administered_at` is bounded (reject a future time or one absurdly far in the past) to prevent a bad client clock corrupting the record.
- Re-send/dedup semantics are UNCHANGED (row-id FSM + `uniq_mar_administered_dose` still guarantee no double-administration). Backed by a backend deep test (offline-stamped administer records the bedside time + passes time-right when drain-delayed; a re-send 409s without double-charting).

### Unit 5 — MAR conflict UX

The inherent tension: offline, the drug was **physically given** on the client-side verify; on drain the server is authoritative and may reject (order discontinued meanwhile, already administered by another nurse, dose window grossly exceeded, etc.). The existing `SyncStatusSheet` surfaces these — this slice gives MAR conflicts a **clinically clear** message ("This administration couldn't be recorded on the server — review: <reason>. The medication was given offline at <time>.") so a nurse/charge-nurse reviews rather than the record silently vanishing. Discarding a MAR conflict requires confirmation (it means an un-recorded administration). The DB unique index guarantees no double-charting even across repeated re-drains.

## The load-bearing safety principle (called out, not buried)

Offline, the physical administration proceeds on the **client-side 5-rights** (hard-stops still block wrong-patient/wrong-drug). On drain, the **server is authoritative** and the **DB guard prevents double-charting**. **Any** server rejection becomes a **visible conflict for clinical review — never a lost record.** Offline lowers the drug-right fidelity to name-match only (pack-barcode is server-only); everything else is identical to online.

## Data flow

```
ONLINE (unchanged): scan → POST /verify → 5-rights → administer-with-scan (NOW()).
OFFLINE: scan → cache lookup (Unit 1) → client 5-rights at bedside time (Unit 2)
  → hard-stop? abort + re-scan : (soft-fail? override) → enqueue administer-with-scan
    {scanned_*, override_reason?, administered_at} (Unit 3) → "Recorded — pending sync".
DRAIN (reconnect): ConnectivitySyncService re-sends with the stable idempotency key
  → server re-verifies against administered_at (Unit 4) + DB guard
    → 2xx: recorded; 409/422: conflict surfaced for review (Unit 5).
```

## Testing

- **Unit 2 (the safety core):** Dart unit tests for `evaluateFiveRights` — patient/drug hard-stops, dose/route presence, the 60-min time window around `at`, allPassed; parity cases mirrored from the server algorithm. This is the highest-value test (it's the offline safety check).
- **Unit 1:** Dart tests for cache round-trip (encrypt→store→read), `cached_at`, owner-scoping.
- **Unit 3:** Dart widget/flow test of the MAR screen with a mocked `ConnectivitySyncService` + a forced offline state — assert: hard-stop aborts (no enqueue); a passing scan enqueues exactly one `administer-with-scan` with the right body incl. `administered_at`; the "pending sync" affordance shows. (No real socket/DB — mock the seam, like the admin real-time slice mocked its hook.)
- **Unit 4 (backend):** a deep test on the QA cluster — `administer-with-scan` with a past `administered_at` records that time + evaluates time-right against it (not NOW); a re-send 409s without a second `administered` row (the DB guard); a future/absurd `administered_at` is rejected.
- **Honest boundary:** the true offline→reconnect→drain round-trip on a real device is **manual** (no emulated airplane-mode in CI; deploy HELD). The Dart tests cover the client logic with a mocked seam; the backend test covers the server change. The spec/PR document the manual device recipe and claim nothing more.

### Manual device-verification recipe (honest boundary — NOT automatable)

This round-trip cannot be unit-tested: there is no emulated airplane-mode in
CI, and the deploy is HELD, so the steps below are run **by hand** on a real
emulator/device against a live backend. The automated tests already cover every
*deterministic* piece (client 5-rights / Unit 2, due-dose cache / Unit 1,
offline-administer intent + body incl. `administered_at` / Unit 3, the
MAR conflict-row clinical copy + confirm-on-discard / Unit 5, and the backend
`administered_at` accommodation + dedup / Unit 4). What's left to eyeball is
only the airplane-mode → reconnect → drain seam between them.

**Happy path (offline administer → drain → recorded):**
1. Boot an Android emulator (or a device) and log into the STAFF app online.
2. Open a patient's MAR while still **online** — this primes Unit 1's
   encrypted due-dose cache (the screen shows the "cached Ns ago" note).
3. Put the device in **airplane mode** (offline).
4. Scan + administer a due dose. The client-side 5-rights runs (Unit 2);
   on pass, expect **"Recorded — pending sync"** (distinct from the online
   "Recorded ✓") and the `OfflineSyncBadge` shows the write **queued**.
5. Turn airplane mode **off** (online). On reconnect `ConnectivitySyncService`
   auto-drains the queue; the badge clears and the administration appears on the
   server-side MAR with the **bedside** `administered_at` (not the drain time).

**Conflict path (server rejects on drain → clinical conflict for review):**
1. Steps 1–4 above, but BEFORE reconnecting, **discontinue the order**
   server-side (admin/another nurse) so the queued administer is no longer
   valid.
2. Reconnect. The drain re-sends; the server returns 409/422 and the write is
   marked a conflict.
3. Open the `SyncStatusSheet` from the badge. Confirm the MAR conflict shows the
   **clinical copy** — "Administration not recorded on the server — review
   needed. <reason>. The medication was given offline." — and that tapping
   **Discard** raises the **confirmation dialog** ("Discard this administration
   record? The medication was given but will NOT be recorded.") before anything
   is removed. Retry re-queues without a dialog. The DB unique index
   (`uniq_mar_administered_dose`) guarantees no double-charting even if the same
   write drains more than once.

State honestly: only the airplane-mode/drain seam is manual; the client logic
(5-rights, cache, offline-administer intent, conflict-row UX) and the backend
`administered_at` behaviour are covered by the automated suites above.

## Out of scope / follow-ups (later slices)

- Drug-chart / CPOE orders (`POST /emr/orders`) and e-Rx (`POST /prescriptions/create`) — reuse Units 1/3/5, but each is a POST-create with **optional** idempotency, so before going offline their middleware should flip to `required: true` (defense-in-depth; the queue already sends the key). Their own slices.
- Background queue drain for the staff app (today drain is on-reconnect / manual) — only if ward devices prove to need it.
- Caching the `vhmp-` pack-barcode → drug map offline to restore full drug-right fidelity — a later hardening.
- A periodic prefetch of due doses (vs cache-on-view) so a device that never opened the patient still has the data — later.
