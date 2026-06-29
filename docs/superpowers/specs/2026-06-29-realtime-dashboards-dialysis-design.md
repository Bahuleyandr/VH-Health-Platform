# Real-time dashboards — Slice 10: Dialysis board (`staff:dialysis-board`)

- **Date:** 2026-06-29
- **Epic:** #4 Real-time-first dashboards
- **Status:** Design approved → spec
- **Builds on:** the event-driven `useRealtimeInvalidation` recipe + the ICU tab-orchestrator cadence-relax pattern (slice 5) + route-layer emits (slice 8 micro). The 10th slice; a textbook application of the proven recipe, no new pattern.

## 1. Context & goal

The admin **Dialysis Unit** board (`apps/admin/src/app/(with-auth)/dashboard/dialysis/page.tsx`) is a thin tab orchestrator over three tabs: **Today's Board** (today's stations/sessions + KPIs), **Patient Roster** (enrolled patients + vascular access + serology + dry weight), and **Session** (a selected run's intra-dialysis observations + Kt/V). Every tab **polls** today — `["dialysis","today"]` @30s, `["dialysis","session",id]` @30s, `["dialysis","obs",id]` @30s, `["dialysis","patients"]` @60s — so a session start/complete, a fresh intra-dialysis observation, or a new complication is invisible to a watching charge nurse until the next poll tick.

**Goal:** push the board live — a new `staff:dialysis-board` channel with producers at the dialysis write paths; the page subscribes once and invalidates the `["dialysis"]` root, so all three tabs refresh the moment any dialysis state changes. While subscribed, the per-tab polls relax to a 2-min safety net (revert to 30/60s when WS is down). Zero behavior change when WS is unavailable.

## 2. Scope

**In scope**
- New `staff:dialysis-board` channel + `emitDialysisEvent(kind, { tenantId })` emitter.
- **12 route-layer producers** in `dialysisRoutes.js` (the user-approved "all 12" board+roster set; device machine-ingest excluded).
- Frontend: one `useRealtimeInvalidation("staff:dialysis-board", [["dialysis"]])` in `page.tsx` + a `●Live/○Connecting/○Polling` indicator; `subscribed` threaded into the 3 tabs to relax their polls; a new `dialysis/realtime.ts` cadence helper.
- Tests: channel RBAC, emitter, cadence helper, page wiring.

**Out of scope (YAGNI)**
- No `routePolicy` change — `dialysis: { minRank: STAFF }` already exists.
- No emit on `POST /dialysis/machines/ingest` — device-initiated raw machine telemetry, not a staff-UI board action; trivial follow-up if device integration ever needs the board to react.
- No new persisted rows / migration / channel beyond `staff:dialysis-board`.
- No change to the dialysis workflow, the service queries, the tab UIs (beyond the `subscribed` prop + indicator), or the modals.
- No SUPER_ADMIN bypass work — that landed in slice 9 (`authorizeChannel` already bypasses SUPER_ADMIN globally).

## 3. Architecture & data flow

```
dialysis write (any staff client):
  POST  /dialysis/sessions            (scheduleSession)      ─┐
  POST  /dialysis/sessions/:id/start  (startSession)          │
  POST  /dialysis/sessions/:id/complete (completeSession)     │
  POST  /dialysis/sessions/:id/cancel (cancelSession)         │
  POST  /dialysis/sessions/:id/obs    (logObservation)        │  (in the route wrap,
  POST  /dialysis/sessions/:id/events (recordSessionEvent)    ├─  after the service
  PATCH /dialysis/patients/:id/dry-weight (updateDryWeight)   │   returns = post-commit,
  POST  /dialysis/patients/:id/access (addAccess)             │   before wrap's success())
  POST  /dialysis/access/:id/abandon  (abandonAccess)         │
  POST  /dialysis/patients/:id/serology (recordSerology)      │
  POST  /dialysis/patients            (enrolPatient)          │
  POST  /dialysis/patients/:id/prescription (prescribe)      ─┘
                                                               └─> emitDialysisEvent(kind, { tenantId: tenantOf(req) })
                                                                     └─> broadcast('staff:dialysis-board', {kind,at}, {tenantId})
                                                                           │  (Redis fan-out, per-broadcast tenant filter)
                                                                           ▼
DialysisPage ── useRealtimeInvalidation('staff:dialysis-board', [["dialysis"]]) ──> invalidate the ["dialysis"] root
                                                                           └─> Today / Roster / Session tabs all refetch
```

## 4. Backend

### 4.1 Channel — `apps/backend/src/utils/websocket/channelAuth.js`
Add one `CHANNEL_CATALOG` entry after `'staff:incidents'`:
```js
'staff:dialysis-board': { description: 'Dialysis unit — session lifecycle, intra-dialysis observations, complications, vascular access, serology', roles: 'staff' },
```
**Scope = `staff:` (isStaff), and it is airtight.** Every dialysis route is gated by `requireStaffOrAdmin`, whose body is exactly `!isStaff(role) && !isAdmin(role) → 403`. Because `isStaff(role) = ALL_STAFF_ROLES.includes(role) || isAdmin(role)`, that gate is precisely `isStaff(role)`. The `staff:` channel prefix resolves to the **same `isStaff(user.role)` predicate** in `authorizeChannel`. So channel-subscribe authorization mirrors route authorization by construction — any role that can read/mutate the board can subscribe, any role that can't, can't. There is **no** DELTA-002 over/under-grant gap here (unlike micro, where LAB_STAFF-vs-isClinical needed reasoning; here the gate and the channel use the identical predicate). SUPER_ADMIN is also admitted via the slice-9 `authorizeChannel` bypass. (Aside: `DIALYSIS_TECHNICIAN` appears only in the admin's frontend `routePolicy.ts` rank table, not in backend `ALL_STAFF_ROLES`/`roles.js`, so it is not an assignable backend role today — out of scope to reconcile.)

### 4.2 Emitter — `apps/backend/src/utils/websocket/realtimeEmitter.js`
Append after `emitIncidentEvent` (last function):
```js
/** Dialysis-board change (session lifecycle, intra-dialysis obs, complications, vascular access, serology). */
export function emitDialysisEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:dialysis-board', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitDialysisEvent failed:', err.message);
  }
}
```
PHI-free `{kind, at}` nudge — clients refetch through the RBAC-gated REST endpoints. Internal try/catch → never throws into the dialysis write. **`tenantId` is passed EXPLICITLY** (every handler has `tenantOf(req)` in hand) — stronger than incidents' ALS fallback; the `dialysis_*` tables are all tenant-scoped (`tenant_id uuid NOT NULL`).

### 4.3 Producers — `apps/backend/src/routes/clinical/dialysisRoutes.js` (import + 12 sites)
Import after the `resolveTenantOrThrow` import:
```js
import { emitDialysisEvent } from '../../utils/websocket/realtimeEmitter.js';
```
Every target handler is a concise-arrow `wrap(async (req) => svc.X({...}))`. Convert each to a block: hoist `const tenantId = tenantOf(req);`, capture the row, emit, return (the ICU concise-arrow→block pattern). Emit goes **after** the service call (post-commit, even for the two `setTenantTx` services `prescribe`/`recordSessionEvent`, because the route emit runs after the service returns) and **before** `wrap` calls `success()`.

| # | Method + path | Handler | `kind` |
|---|---|---|---|
| 1 | `POST /sessions` | scheduleSession | `session-scheduled` |
| 2 | `POST /sessions/:id/start` | startSession | `session-started` |
| 3 | `POST /sessions/:id/complete` | completeSession | `session-completed` |
| 4 | `POST /sessions/:id/cancel` | cancelSession | `session-cancelled` |
| 5 | `POST /sessions/:id/obs` | logObservation | `observation-logged` |
| 6 | `POST /sessions/:id/events` | recordSessionEvent | `session-event-recorded` |
| 7 | `PATCH /patients/:id/dry-weight` | updateDryWeight | `dry-weight-updated` |
| 8 | `POST /patients/:id/access` | addAccess | `access-created` |
| 9 | `POST /access/:id/abandon` | abandonAccess | `access-abandoned` |
| 10 | `POST /patients/:id/serology` | recordSerology | `serology-recorded` |
| 11 | `POST /patients` | enrolPatient | `patient-enrolled` |
| 12 | `POST /patients/:id/prescription` | prescribe | `prescription-created` |

Example (site 2):
```js
router.post('/sessions/:id/start', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.startSession({ tenantId, id: req.params.id, ...req.body });
  emitDialysisEvent('session-started', { tenantId });
  return row;
}));
```
Site 12 already has a block body (the `isDoctor` guard) — hoist `tenantId`, capture `svc.prescribe(...)`, emit `prescription-created`, return. **No emit on `POST /machines/ingest`** (out of scope).

## 5. Frontend

### 5.1 `apps/admin/src/app/(with-auth)/dashboard/dialysis/realtime.ts` (new)
```ts
export const DIALYSIS_CHANNEL = "staff:dialysis-board";

// While the WS channel is subscribed, dialysis events push refetches; relax the
// per-tab safety polls to 2 min. When WS is down, revert to the original cadence.
export const DIALYSIS_LIVE_POLL_MS = 120_000;

export function dialysisRefetchMs(subscribed: boolean, baseMs: number): number {
  return subscribed ? DIALYSIS_LIVE_POLL_MS : baseMs;
}
```

### 5.2 `page.tsx` (orchestrator) — subscribe once + indicator + thread `subscribed`
- `import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";` + `import { DIALYSIS_CHANNEL } from "./realtime";`
- `const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(DIALYSIS_CHANNEL, [["dialysis"]]);`
- A `●Live / ○Connecting / ○Polling` indicator (`data-testid="dialysis-realtime-indicator"`, `role="status"`, aria-label + title) next to the `<h1>Dialysis Unit</h1>` in a `flex items-center gap-2`.
- Pass `subscribed` to all three tabs: `<TodayBoardTab subscribed={subscribed} onOpenSession=… />`, `<RosterTab subscribed={subscribed} />`, `<SessionTab sessionId=… subscribed={subscribed} />`.

### 5.3 Tab cadence relax (the only tab changes)
Each tab gains a required `subscribed: boolean` prop (the page always passes it; no admin dialysis test renders a tab standalone), and routes its `refetchInterval` through `dialysisRefetchMs(subscribed, base)`:
- **TodayBoardTab** — `["dialysis","today"]` `refetchInterval: dialysisRefetchMs(subscribed, 30_000)`.
- **SessionTab** — both `["dialysis","session",id]` and `["dialysis","obs",id]` → `dialysisRefetchMs(subscribed, 30_000)`.
- **RosterTab** — `["dialysis","patients"]` → `dialysisRefetchMs(subscribed, 60_000)`. (The `["dialysis","patient",selected]` detail query has no poll → untouched.)

The page itself has no query; one root invalidation (`[["dialysis"]]`) refreshes every tab's queries by react-query prefix match.

## 6. Tenant scoping & PHI
The `dialysis_patients` / `dialysis_sessions` / `dialysis_intra_obs` / `dialysis_session_events` tables are tenant-scoped (`tenant_id uuid NOT NULL`); the routes resolve tenant via `tenantOf(req) = resolveTenantOrThrow(req)` and every service query filters `tenant_id`. The emit passes that same `tenantId` explicitly, so `broadcast`'s per-broadcast `tenantMatches` filter delivers only to same-tenant subscribers. WS payload is `{kind, at}` only — **no PHI** (no patient UID, no session detail, no vitals); the board's data stays behind the staff-gated REST refetch.

## 7. Testing
- **`apps/backend/src/tests/unit/dialysisRealtimeChannel.test.js`** — `CHANNEL_CATALOG['staff:dialysis-board']` defined, `roles:'staff'`; `authorizeChannel('staff:dialysis-board', {role})` allowed for `NURSING_STAFF` / `DOCTOR` / `ADMIN`, denied for `PATIENT`; allowed for `SUPER_ADMIN` (slice-9 bypass).
- **`apps/backend/src/tests/unit/dialysisRealtimeEmitter.test.js`** — mocks `wsServer.js`, imports the real `realtimeEmitter`; `emitDialysisEvent('session-started', { tenantId: 't1' })` calls `broadcast` once with `'staff:dialysis-board'`, `{kind:'session-started', ...}`, and `{tenantId:'t1'}`; never throws when `broadcast` throws. (Separate file from any test that mocks the emitter — the ESM mock-after-import rule.)
- **Backend regression:** run the existing `apps/backend/src/tests/unit/dialysis.test.js` (no DB) — the route emits are post-service, side-effect-free on the response, must stay green. `dialysis-depth.deep.test.js` is DB-gated (Postgres :5433) — run if the DB is up.
- **`apps/admin/.../dashboard/dialysis/realtime.test.ts`** — `dialysisRefetchMs(true, 30_000) === 120_000`; `dialysisRefetchMs(false, 30_000) === 30_000`; `(false, 60_000) === 60_000`.
- **`apps/admin/src/__tests__/dashboard/dialysis/page.test.tsx`** (new) — mock `@/hooks/useRealtimeInvalidation` + the three tab components (trivial stubs) so no real WS/fetch; assert the hook called with `("staff:dialysis-board", [["dialysis"]])` and the indicator renders `○ Polling` when `subscribed:false`/`connected:false` and `● Live` when `subscribed:true`.
- **Honest limit:** the live WS push is not auto-tested (no WS in jsdom); tests cover channel RBAC, emitter, cadence, indicator, and wiring. Manual recipe in §9.

## 8. Risks
| Risk | Mitigation |
|---|---|
| Channel denies a real board user | `staff:dialysis-board` uses the identical `isStaff` predicate as the `requireStaffOrAdmin` route gate — subscribe auth == route auth, no gap. Asserted in the channel test. |
| Emit blocks/breaks a dialysis write | Emitter try/catches; emit is post-service (post-commit) and side-effect-free on the response. Existing `dialysis.test.js` re-run as a regression guard. |
| `setTenantTx` services (prescribe / recordSessionEvent) | Emit in the ROUTE handler after the service returns = always post-commit; never inside the tx callback. |
| Refetch amplification (12 sites × all-tab invalidation) | Dialysis mutation rate is low (sessions run for hours); event-driven refetch on real mutations is the intent. Cadence already relaxed under subscription. |
| Adding `subscribed` prop breaks a tab test | No existing admin dialysis tests; the new page test mocks the tabs (won't render real tabs), so the required prop breaks nothing. |
| Machine-ingest not live | Out of scope (device-initiated); documented as a trivial follow-up. |

## 9. Manual verification (deploy HELD)
1. `cd apps/backend && npm run dev` (Postgres :5433) + `cd apps/admin && npm run dev`.
2. Open `/dashboard/incidents`… → `/dashboard/dialysis`; confirm the indicator shows `● Live` once subscribed.
3. In a second tab, start/complete a session or log an observation; confirm the first tab's board/run-chart updates within ~1s without a manual refresh.
4. Stop the backend; confirm the indicator falls to `○ Polling` and the tabs resume 30/60s polling.
