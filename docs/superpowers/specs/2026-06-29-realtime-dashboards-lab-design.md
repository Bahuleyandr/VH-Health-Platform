# Real-time dashboards — Slice 7: Lab Critical-Value board (`staff:lab`)

- **Date:** 2026-06-29
- **Epic:** #4 Real-time-first dashboards
- **Status:** Design approved → spec
- **Builds on:** the **event-driven** `useRealtimeInvalidation` recipe (beds/ED/OR/ICU). Converts the EXISTING `dashboard/lab` page (tab orchestrator, like ICU). **New twist:** producers live in the **service layer** (`labResultsService.js`), not the route layer, because lab results arrive via three ingestion paths that all funnel through one function.

## 1. Context & goal

The admin **Laboratory** page (`apps/admin/src/app/(with-auth)/dashboard/lab/page.tsx`) is a two-tab board:
- **Pathologist worklist** (`["lab","pathologist","pending"]`) — results pending sign-off. **No poll today** (mount + manual Refresh + post-mutation invalidate only) — so a freshly-ingested result is invisible until someone reloads.
- **Critical alerts** (`["lab","alerts","critical"]`, polls 60s) — the NABH 5.6 critical-value acknowledgement (read-back) workflow.

Critical-value lab results (STAT troponin, K⁺, panic glucose) are among the most time-sensitive, medico-legally tracked signals in the hospital, and the worklist's *no-poll* gap means new results can sit unseen.

**Goal:** convert both tabs to **event-driven real-time** — a new `staff:lab` channel with producers at the lab write sites; the page subscribes and invalidates both tab keys on each event. The pathologist worklist gains real-time it never had; the alerts tab pushes instantly with a relaxed safety poll.

## 2. Scope

**In scope**
- New `staff:lab` channel + `emitLabEvent` emitter + **3 producer call-sites in `labResultsService.js`**.
- Frontend: `useRealtimeInvalidation` on both tab keys, a relaxed live poll (cadence helper) for the alerts tab, a `●Live/○Polling` indicator.
- Tests: channel RBAC, emitter, cadence helper, page wiring; **+ a lab-unit-test regression gate** (the service emit lands in tested code).

**Out of scope (YAGNI)**
- No `routePolicy` change — `dashboard/lab` already exists with a `lab: { minRank: STAFF }` entry.
- No new persisted rows / migration / channel beyond `staff:lab`.
- No change to `labClosedLoopService.js` — its interface-ingest path already routes through `detectCriticalsForResults` (covered for free).
- No change to the lab data model, the routes, or the sign-off/ack/ingest behaviour (emits are additive best-effort).
- The staff Flutter lab screens are a future `staff:lab` consumer — not wired here.

## 3. Architecture & data flow

```
3 ingestion paths:
  POST /lab/results        → recordResultManual ─────┐
  POST /lab/oru/ingest     → ingestOruMessage ───────┤  (each INSERTs lab_results,
  POST /lab/interface/...  → labClosedLoop ───────────┤   then calls ↓ with the new rows)
                                                      ▼
                          detectCriticalsForResults(results)   ◄── universal post-insert chokepoint
                             │  if (results.length) emit 'result-pending'   → worklist tab
                             │  if (alerts.length)  emit 'alert-fired'      → critical-alerts tab
  POST /lab/pathologist/signoff → signOffResults ─────> emit 'result-signed'
  POST /lab/alerts/critical/:id/ack → acknowledgeAlert ─> emit 'alert-acked'
                             └──> broadcast('staff:lab', {kind,at}, {tenantId})
                                   │ (Redis fan-out, per-broadcast tenant filter)
                                   ▼
LabPage ── useRealtimeInvalidation('staff:lab', [["lab","pathologist"],["lab","alerts"]])
            └─> invalidate both keys → the mounted tab refetches through its existing query fn
```

The WS push is a **PHI-free invalidation signal** (`{kind, at}` only — no patient/value data); the existing query functions refetch the authoritative data through the RBAC-guarded REST routes. `detectCriticalsForResults` is the single chokepoint **all three ingestion paths** call right after inserting `lab_results` (verified: `ingestOruMessage:208`, `recordResultManual:578`, `labClosedLoopService:322`), so emitting both `result-pending` and `alert-fired` there covers every path.

## 4. Backend design

### 4.1 Channel (`apps/backend/src/utils/websocket/channelAuth.js`)
Add to `CHANNEL_CATALOG` (after `staff:icu-board`):
```js
'staff:lab': { description: 'Lab — critical-value alerts + pathologist sign-off worklist', roles: 'staff' },
```
No `authorizeChannel` change: `staff:*` → `isStaff`. The lab REST is gated by `LAB_ROUTE_ROLES` (lab/diagnostics + clinical staff) — narrower than `isStaff`; the **channel-broader-than-REST** asymmetry is the same accepted pattern as the ICU slice (all REST-authorized users can subscribe; the WS carries no PHI).

### 4.2 Emitter (`apps/backend/src/utils/websocket/realtimeEmitter.js`)
```js
/** Lab board change (critical-value alert fired/acked, result pending/signed). */
export function emitLabEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:lab', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitLabEvent failed:', err.message);
  }
}
```
Mirrors `emitIcuBoardEvent`; internal try/catch → never throws into the lab write.

### 4.3 Producers — `apps/backend/src/services/lab/labResultsService.js` (import + 3 sites)
Import: `import { emitLabEvent } from '../../utils/websocket/realtimeEmitter.js';`

| Function | Placement | Emit(s) |
|---|---|---|
| `detectCriticalsForResults({ tenantId, results })` | after the `for` loop, before `return alerts;` | `if (results.length) emitLabEvent('result-pending', { tenantId }); if (alerts.length) emitLabEvent('alert-fired', { tenantId });` |
| `signOffResults({ tenantId, … })` | after the `UPDATE lab_results … signed_off_at` statement | `emitLabEvent('result-signed', { tenantId });` |
| `acknowledgeAlert(alertId, { tenantId, … })` | after the existing `emitCriticalLabAlertAcknowledged(…)`, before `return rows[0];` | `emitLabEvent('alert-acked', { tenantId });` |

All best-effort, post-write (the functions are not in a `$transaction`); `emitLabEvent` never throws. `result-pending`/`alert-fired` fire once per ingestion batch (an invalidation signal, not per-row). `tenantId` is already a parameter of all three functions. **No change to `labClosedLoopService.js`** (it calls `detectCriticalsForResults`).

## 5. Frontend design

### 5.1 Cadence helper — new `apps/admin/src/app/(with-auth)/dashboard/lab/realtime.ts`
```ts
export const LAB_CHANNEL = "staff:lab";
// The pathologist worklist had NO poll (push-only now); the critical-alerts tab polled 60s. While
// subscribed we relax the alerts poll to a 2-min safety net (push makes it instant), reverting to 60s when
// WS is down so behaviour is never worse than before.
export const LAB_LIVE_POLL_MS = 120_000;
export function labRefetchMs(subscribed: boolean, baseMs: number): number {
  return subscribed ? LAB_LIVE_POLL_MS : baseMs;
}
```

### 5.2 Page wiring — `lab/page.tsx`
- Import `useRealtimeInvalidation`, `LAB_CHANNEL`, `labRefetchMs`.
- In `LabPage` (the always-mounted tab orchestrator), after the `useState`:
  `const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(LAB_CHANNEL, [["lab","pathologist"], ["lab","alerts"]]);`
  (two prefixes cover `["lab","pathologist","pending"]` + `["lab","alerts","critical"]`; the mounted tab refetches, the other goes stale and refetches on switch.)
- Add a `●Live/○Polling` indicator next to the `<h1>Laboratory</h1>` (`data-testid="lab-realtime-indicator"`, `role="status"`, `aria-label`, `title`), same markup as ICU/OR. Move the `mb-6` onto a wrapping flex `div`.
- Pass `subscribed` to the alerts tab: `{tab === "alerts" && <CriticalAlerts subscribed={subscribed} />}`. The worklist tab is unchanged (`<PathologistWorklist />`) — it gains real-time purely via the invalidation (it had no poll to relax).
- `CriticalAlerts`: add a `subscribed: boolean` prop; change its query `refetchInterval: 60_000` → `refetchInterval: labRefetchMs(subscribed, 60_000)` (import `labRefetchMs`).

## 6. Tenant scoping & PHI
Each emit passes the function's `{ tenantId }` (resolved upstream from `resolveTenantOrThrow` at the route, or the ingest tenant) → the per-broadcast tenant filter delivers each signal only to that tenant's lab staff. No cross-tenant signal leak. The WS payload is `{kind, at}` only — **no PHI**; the board's PHI stays behind the RBAC-guarded REST refetch (`phiAccessLogger('LAB_RESULT')` on the `/lab` mount).

## 7. Testing
- **Backend** `labRealtimeChannel.test.js` — `CHANNEL_CATALOG['staff:lab']` present with `roles:'staff'`; `authorizeChannel('staff:lab', …)` allowed for `NURSING_STAFF`/`PATHOLOGIST`/`ADMIN`, denied for `PATIENT`.
- **Backend** `labRealtimeEmitter.test.js` (ESM-mock `wsServer`) — `emitLabEvent('alert-fired', { tenantId })` broadcasts `'staff:lab'` with `{kind, at}` + `{tenantId}`; never throws when `broadcast` throws.
- **★ Backend regression gate:** the `detectCriticalsForResults`/`signOffResults`/`acknowledgeAlert` emits land in unit-tested code. Run the lab unit tests that exercise these — `labResultsService`, `labResultsServiceResultsInbox`, `labClosedLoopSecurity`, `cdsEngineCoverage` — and confirm they still pass. The emit is best-effort (`broadcast` no-ops without clients; `emitLabEvent` swallows), so they should pass unmodified; **if any breaks, add `jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({ emitLabEvent: jest.fn() }))` to it** (the `vitalSignMonitorAtomicPersist.test.js` precedent for a service that emits). No new producer-wiring test (covered by the emitter test + this regression gate). DB-gated integration lab tests (`clinical-safety`, `lab-result-ready-*`, etc.) aren't run locally (no Postgres) but the swallowed emit is low-risk + CI-covered.
- **Frontend** `lab/realtime.test.ts` — `labRefetchMs(true, 60_000)===120_000`, `labRefetchMs(false, 60_000)===60_000`.
- **Frontend** `lab/page.test.tsx` — `jest.mock("@/hooks/useRealtimeInvalidation")` + `@/lib/api`; assert the hook is called with `(LAB_CHANNEL, [["lab","pathologist"],["lab","alerts"]])`; indicator Polling when not subscribed, Live when subscribed. (`LabPage` renders `PathologistWorklist` by default → mock `fetchAdminAPI`→`[]`.)

**Honest limitations:** live WS push not auto-tested (no WS in jsdom; deploy HELD) — same as every slice.

## 8. Resilience / error handling
- Emits are best-effort, post-write, non-blocking (`emitLabEvent` try/catches internally — matches `emitVitalAnomaly`/`emitIcuBoardEvent` and the CLAUDE.md Phase-1.5 rule). A WS failure can never abort a lab result write, sign-off, or acknowledgement.
- WS bus is at-most-once; the alerts tab keeps a 120s live safety poll (60s when WS down). The worklist had no poll before and is push-only now (strict improvement; refetches on the next event or manual Refresh).
- No new auth surface (`staff:*` → `isStaff`). PHI stays behind the REST refetch.

## 9. Verification
- **Gates:** backend `lint` + `labRealtimeChannel`/`labRealtimeEmitter` + the lab-unit regression set; admin `type-check`/`lint`/`test`/`build`.
- **Manual (deploy HELD → local):** open the lab board (`●Live`); from a second client `POST /lab/results` (a critical value) → the worklist + alerts tab repaint within ~1s without the poll; acknowledge an alert → it moves to Acknowledged live; sign off a result → it leaves the worklist live.

## 10. File-change inventory
- `apps/backend/src/utils/websocket/channelAuth.js` — +1 catalog entry.
- `apps/backend/src/utils/websocket/realtimeEmitter.js` — +`emitLabEvent`.
- `apps/backend/src/services/lab/labResultsService.js` — import + 3 emit sites (4 emit calls).
- `apps/backend/src/tests/unit/labRealtimeChannel.test.js` — new.
- `apps/backend/src/tests/unit/labRealtimeEmitter.test.js` — new.
- `apps/admin/src/app/(with-auth)/dashboard/lab/realtime.ts` — new.
- `apps/admin/src/app/(with-auth)/dashboard/lab/page.tsx` — hook + indicator + `subscribed` prop + `labRefetchMs`.
- `apps/admin/src/__tests__/dashboard/lab/realtime.test.ts` — new.
- `apps/admin/src/__tests__/dashboard/lab/page.test.tsx` — new.

## 11. Risks
| Risk | Mitigation |
|---|---|
| Emit lands in heavily-tested service code | Best-effort/swallowed; run the lab-unit regression set; mock `realtimeEmitter` in any test that breaks. |
| Channel scope mismatch (DELTA-002) | `staff:lab` (isStaff) matches the lab routes' staff/clinical audience; asserted in the channel test. NOT `admin:`. |
| Cross-tenant signal leak | Explicit `{ tenantId }` on each broadcast + per-broadcast tenant filter. |
| Emit blocks a lab write | Emitter try/catches; post-write, non-blocking. |
| Interface-ingest path missed | It routes through `detectCriticalsForResults` (verified `labClosedLoopService:322`) — covered by the one chokepoint emit. |
| Adding the hook breaks the page test | New `lab/page.test.tsx` mocks the hook from the start. |
| `result-pending` over-fires (batch) | Once per ingestion (not per-row) — it's an invalidation signal; the refetch pulls the authoritative worklist. |
