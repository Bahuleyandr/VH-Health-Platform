# Real-time dashboards — Slice 12: Radiology board (`staff:radiology`) + contract reconciliation + RQ migration

- **Date:** 2026-06-29
- **Epic:** #4 Real-time-first dashboards
- **Status:** Design approved → spec
- **Builds on:** the event-driven `useRealtimeInvalidation` recipe (route-layer emits like blood-bank; purely-additive no-poll like incidents/blood-bank). **The most-involved slice so far** — the admin board is broken end-to-end by contract drift, so making it real-time first means making it WORK. Prerequisite **PR0 (RADIOLOGY_STAFF → ALL_STAFF_ROLES)** already merged (`main 923772ca`).

## 1. Context & goal

The admin **Radiology** board (`apps/admin/src/app/(with-auth)/dashboard/radiology/page.tsx`, 345 LOC, single file) is a two-tab orchestrator: **Worklist** (order list + Report/Cancel actions) and **New Order** (create form). It uses raw `useState`/`useEffect`/`fetch` (no react-query) and — critically — was written against an **API contract the backend never implemented**, so it is broken end-to-end:

| Interaction | Frontend sends/reads | Backend expects/returns | Result today |
|---|---|---|---|
| Worklist display | `study_type`, `ordered_at` | `modality`, `created_at` | Study-Type column blank, date `—` |
| Create order | `{study_type, priority, notes}` | requires `modality` + `body_part` + `clinical_indication` | **400 every time** |
| Submit report | `{result_summary, report_url}` | requires `report` (+ optional findings/impression); no `report_url` column | **400 every time** |

Only `cancel` works. **Goal:** make the board work (reconcile the contract — dictated by the real backend, not product guesswork), migrate it to react-query, then push it live — a new `staff:radiology` channel with producers at the order/report lifecycle write paths; the page subscribes and invalidates the `["radiology"]` root, so the worklist refreshes the moment any order/report changes.

## 2. Scope

**In scope (one branch, two commits)**
- **Commit A — contract reconciliation + RQ migration** (`apps/admin`): fix the three broken interactions (worklist read, create form, report modal) per the backend contract, and migrate the page to `useQuery`/`useMutation` (invalidate `["radiology"]` on mutation). Behavior-changing only where the board was broken; UX otherwise preserved (`alert()` on mutation error, inline error div on query error — no new toast).
- **Commit B — realtime:** new `staff:radiology` channel + `emitRadiologyEvent(kind,{tenantId})` + **6 route-layer producers** in `radiologyRoutes.js`. Frontend: one `useRealtimeInvalidation("staff:radiology", [["radiology"]])` in `RadiologyContent` + a `●Live/○Connecting/○Offline` indicator.
- Tests: channel RBAC (incl. the RADIOLOGY_STAFF case), emitter, page wiring; `radiology-deep.test.js` as a regression guard.

**Out of scope (YAGNI)**
- No new poll / cadence helper — the board never polled; realtime is purely additive (WS-down behavior == today's manual refresh). Indicator has no "Polling" state.
- No `tenant_id` migration for `radiology_orders` — the table genuinely has no `tenant_id` (no migration adds it). The emit scopes correctly via `req.tenantId` (the subscriber's JWT tenant); the DB-level gap is pre-existing and a separate concern.
- No new order-form fields beyond the two the backend requires (`body_part`, `clinical_indication`). No report findings/impression structured inputs (the backend accepts them optionally; the single `report` field is enough to unbreak the modal). No addendum UI (D50, backend-only).
- No god-page split (345 LOC, under the ~500 threshold). No `routePolicy` work (radiology's REST gate is in `app.js`; the admin page is reachable).
- No emit on GET handlers (`/worklist`, `/patient/:uid`, `/:id`).

## 3. Architecture & data flow

```
radiology write (any clinical / radiology-staff client):
  POST /radiology/orders        (createOrder)            ─┐
  PUT  /radiology/:id/report    (submitReport)            │
  POST /radiology/:id/acquire   (markAcquired)            │  (in each handler's try,
  POST /radiology/:id/sign-off  (signOffReport)           ├─  after the service call
  POST /radiology/:id/addendum  (appendReportAddendum)    │   succeeds, before success())
  PUT  /radiology/:id/cancel    (cancelOrder)            ─┘
                                                           └─> emitRadiologyEvent(kind, { tenantId: req.tenantId })
                                                                 └─> broadcast('staff:radiology', {kind,at}, {tenantId})
                                                                       │  (Redis fan-out, per-broadcast tenant filter)
                                                                       ▼
RadiologyContent ── useRealtimeInvalidation('staff:radiology', [["radiology"]]) ──> invalidate the ["radiology"] root
                                                                       └─> Worklist refetches
```

## 4. Backend (Commit B)

### 4.1 Channel — `apps/backend/src/utils/websocket/channelAuth.js`
Add one `CHANNEL_CATALOG` entry after `'staff:blood-bank'`:
```js
'staff:radiology': { description: 'Radiology board — order lifecycle, acquisition, report submission, sign-off, addendum', roles: 'staff' },
```
**Scope = `staff:` (isStaff), verified by computation.** The REST gate is `app.js:1119` `requireRole(...RADIOLOGY_ROUTE_ROLES)` (no in-router gate except the `/acquire` inner `RADIOLOGY_STAFF`-only check). `RADIOLOGY_ROUTE_ROLES = mergeRoles(DIAGNOSTICS_ROUTE_ROLES, ['DOCTOR','NURSING_STAFF','IP_STAFF_NURSE','OP_STAFF_NURSE'])`. Two radiology roles split: `RADIOLOGIST` (`isStaff`+`isClinical`) and **`RADIOLOGY_STAFF`** (the radiographer hard-gated for `/acquire`). RADIOLOGY_STAFF was `isStaff=false` (a known gap) until **PR0 (`923772ca`)** added it to `ALL_STAFF_ROLES`; it is now `isStaff=true`, `isClinical=false` — so `staff:radiology` admits it but `staff:clinical:radiology` would NOT (the micro/blood-bank trap). `staff:` over-grants vs the capability-narrowed `RADIOLOGY_ROUTE_ROLES` (bounded safe by the PHI-free `{kind,at}` payload; systemic across lab/micro/icu/dialysis/blood-bank; no role-subset channel). SUPER_ADMIN via the slice-9 bypass.

### 4.2 Emitter — `apps/backend/src/utils/websocket/realtimeEmitter.js`
Append after `emitBloodBankEvent` (last function):
```js
/** Radiology-board change (order lifecycle, acquisition, report submission, sign-off, addendum). */
export function emitRadiologyEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:radiology', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitRadiologyEvent failed:', err.message);
  }
}
```
PHI-free `{kind, at}` nudge; try/catch → never throws into the radiology write. `tenantId` passed EXPLICITLY (`req.tenantId`, set by `tenantContextMiddleware` before the route).

### 4.3 Producers — `apps/backend/src/routes/radiology/radiologyRoutes.js` (import + 6 sites)
Import after the existing imports:
```js
import { emitRadiologyEvent } from '../../utils/websocket/realtimeEmitter.js';
```
Every handler is controller-style: `try { const X = await radiologyService.Y(...); return success(res, X, ...); } catch ... }`. Insert the emit after the awaited service call, before `return success(...)` (post-service; emit on the success path only). `req.tenantId` is available in every handler.

| # | Method + path | service call (var) | `kind` |
|---|---|---|---|
| 1 | `POST /orders` | createOrder (`order`) | `order-created` |
| 2 | `PUT /:id/report` | submitReport (`result`) | `report-submitted` |
| 3 | `POST /:id/acquire` | markAcquired (`result`) | `order-acquired` |
| 4 | `POST /:id/sign-off` | signOffReport (`result`) | `report-signed-off` |
| 5 | `POST /:id/addendum` | appendReportAddendum (`result`) | `report-addendum` |
| 6 | `PUT /:id/cancel` | cancelOrder (`result`) | `order-cancelled` |

Example (site 1):
```js
    const order = await radiologyService.createOrder(orderData);
    emitRadiologyEvent('order-created', { tenantId: req.tenantId });
    return success(res, order, 'Radiology order created successfully', 201);
```
Do **NOT** emit on the GET handlers (`/worklist`, `/patient/:uid`, `/:id`).

## 5. Frontend

### 5.1 Commit A — contract reconciliation + RQ migration
`apps/admin/src/app/(with-auth)/dashboard/radiology/page.tsx`:

**(a) Type `RadiologyOrder`:** rename `study_type` → `modality`; `ordered_at` → `created_at`. Drop `result_summary` / `report_url` (no such backend fields); add optional `body_part?: string` and `clinical_indication?: string` (returned by the worklist).

**(b) WorklistTab — `useQuery` + display fix:**
```ts
const { data: orders = [], isLoading: loading, error, refetch } = useQuery({
  queryKey: ["radiology", "worklist"],
  queryFn: async () => {
    const r = await fetchAdminAPI<{ data: RadiologyOrder[] }>("/radiology/worklist");
    const data = (r as Record<string, unknown>).data ?? r;
    return Array.isArray(data) ? (data as RadiologyOrder[]) : [];
  },
});
```
Display: `{o.modality}` (column header "Study Type" → "Modality"); `fmtDate(o.created_at)`. Refresh → `refetch()`; error → `error instanceof Error ? error.message : "Failed to load worklist"`. The Report/Cancel mutations become `useMutation` with `onSuccess: () => qc.invalidateQueries({ queryKey: ["radiology"] })`, `onError: alert`. Cancel keeps the `confirm()` guard before `.mutate()`.

**(c) Report modal:** replace the `{result_summary, report_url}` form with a single `report` textarea. The submit mutation sends `{ report: reportForm.report }` (the backend reads `req.body.report`; `reported_by` is server-side). Drop the `report_url` input. (No prefill — the worklist row doesn't carry the report text; the modal is for entering one.)

**(d) NewOrderTab — fix the create form (currently 400s):** rename `study_type` → `modality`; add a required **Body part** input and a required **Clinical indication** input. The submit mutation sends `{ patient_uid, modality, body_part, clinical_indication, priority, notes }`. Required-check before `.mutate()`: `patient_uid && modality && body_part && clinical_indication`. Priority (`NORMAL/HIGH/URGENT/STAT`) and free-text modality (`X-RAY/CT/MRI`) are normalized backend-side (`normalisePriority`/`normaliseModality`), so they pass as-is. Keep `success`/`setSuccess` banner; `saving` → `create.isPending`.

The app-root `QueryClientProvider` already exists; imports add `useQuery`/`useMutation`/`useQueryClient`, drop `useEffect`/`useCallback`.

### 5.2 Commit B — realtime subscribe + indicator
In `RadiologyContent` (the always-mounted orchestrator):
- `import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";` + a module const `const RADIOLOGY_CHANNEL = "staff:radiology";`.
- `const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(RADIOLOGY_CHANNEL, [["radiology"]]);`
- A `●Live / ○Connecting / ○Offline` indicator (`data-testid="radiology-realtime-indicator"`, `role="status"`, aria-label + title) next to the `<h1>Radiology</h1>` in a `flex items-center gap-2`.

No cadence helper (no poll). One root invalidation (`[["radiology"]]`) covers the worklist query by prefix.

## 6. Tenant scoping & PHI
`radiology_orders` has **no `tenant_id`** column (no migration adds it — unlike blood_requests/blood_units which got it in 239/280). The emit passes `req.tenantId` (set by `tenantContextMiddleware`); `broadcast`'s `tenantMatches` delivers only to subscribers whose JWT tenant equals it — so the WS nudge is correctly tenant-scoped even though the rows themselves are not RLS-scoped. WS payload is `{kind, at}` only — **no PHI** (no patient UID, modality, or report text); the board's data stays behind the REST-gated refetch. (DB-level tenant scoping of `radiology_orders` is a pre-existing gap, separate from this slice.)

## 7. Testing
- **`apps/backend/src/tests/unit/radiologyRealtimeChannel.test.js`** — `CHANNEL_CATALOG['staff:radiology']` defined, `roles:'staff'`; `authorizeChannel('staff:radiology', {role})` allowed for `RADIOLOGY_STAFF` (the radiographer — the key post-PR0 assertion), `RADIOLOGIST`, `DOCTOR`, `ADMIN`; denied for `PATIENT`; allowed for `SUPER_ADMIN`.
- **`apps/backend/src/tests/unit/radiologyRealtimeEmitter.test.js`** — mocks `wsServer.js`, imports the real `realtimeEmitter`; `emitRadiologyEvent('order-created', { tenantId: 't1' })` calls `broadcast` once with `'staff:radiology'`, `{kind:'order-created',…}`, `{tenantId:'t1'}`; never throws when `broadcast` throws.
- **Backend regression:** run `apps/backend/src/tests/radiology-deep.test.js` (DB-gated on QA PG `:55432`) — the route emits are post-service, side-effect-free on the response, must stay green.
- **`apps/admin/src/__tests__/dashboard/radiology/page.test.tsx`** (new) — wrap in `QueryClientProvider`; mock `@/lib/api` (`fetchAdminAPI`→`[]`, `postJSON`/`putJSON`→resolved) + `@/hooks/useRealtimeInvalidation`; assert the hook called with `("staff:radiology", [["radiology"]])` and the indicator renders `○ Offline` when down and `● Live` when subscribed.
- **Honest limit:** live WS push not auto-tested (no WS in jsdom); tests cover channel RBAC, emitter, indicator, wiring. The contract reconciliation is covered by type-check + the (now-correct) payloads matching the backend contract; manual recipe in §9.

## 8. Risks
| Risk | Mitigation |
|---|---|
| Channel denies the radiographer | Post-PR0, `RADIOLOGY_STAFF` is `isStaff` → `staff:radiology` admits it; `staff:clinical:` would not. Asserted in the channel test. |
| Channel over-grants vs REST | Accepted + bounded: PHI-free `{kind,at}` payload; refetch stays REST-gated; systemic; no role-subset channel. Documented §4.1. |
| Contract reconciliation introduces a new break | Each fix is dictated by the real backend (validators + service requireds + worklist SELECT, all read from source); create now sends the 3 required fields; report sends `report`; worklist reads `modality`/`created_at`. `radiology-deep.test.js` re-run as a backend regression guard. |
| Emit blocks/breaks a radiology write | Emitter try/catches; emit is post-service, side-effect-free on the response. |
| Adding the hook breaks a page test | New page test mocks the hook + `@/lib/api`; no existing radiology admin test. |

## 9. Manual verification (deploy HELD)
1. `cd apps/backend && npm run dev` (dev PG :5433) + `cd apps/admin && npm run dev`.
2. Open `/dashboard/radiology`; confirm the worklist shows the **Modality** + **Ordered** columns populated, creating an order succeeds (no 400), submitting a report succeeds, and the indicator shows `● Live` once subscribed.
3. In a second tab, create/cancel an order or submit a report; confirm the first tab's worklist updates within ~1s with no manual Refresh.
4. Stop the backend; confirm the indicator falls to `○ Offline` and the board still works via manual Refresh.
