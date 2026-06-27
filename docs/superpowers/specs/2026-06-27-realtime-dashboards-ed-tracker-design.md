# Real-time dashboards — Slice 2: ED Tracking Board (`admin:ed-board`)

- **Date:** 2026-06-27
- **Epic:** #4 Real-time-first dashboards
- **Status:** Design approved → spec
- **Builds on:** Slice 1 (beds) — `docs/superpowers/specs/2026-06-27-realtime-dashboards-beds-design.md`,
  the reusable `apps/admin/src/hooks/useRealtimeInvalidation.ts`, and the WS fabric
  (`apps/backend/src/utils/websocket/`).

## 1. Context & goal

The admin **ED Tracking Board** (`apps/admin/src/app/(with-auth)/dashboard/ed-tracker/page.tsx`)
is a kanban of emergency-department visits grouped by status. It currently **polls every
30 seconds** (`refetchInterval: 30_000`) and has no real-time path, even though the backend
already mutates ED state through well-defined service functions.

**Goal:** convert it to **event-driven real-time** by reusing the slice-1 pattern — a new
backend WS channel `admin:ed-board` with producers at the ED write sites, and the existing
`useRealtimeInvalidation` hook on the frontend.

**Guarantee (same as slice 1):** strict improvement. When the WS subscription is live, the
board updates within ~1s of any ED write *and* keeps a relaxed safety poll; when WS is
down/denied, behaviour is identical to today (30s poll). No regression in any failure mode.

## 2. Scope

**In scope**
- New admin-only channel `admin:ed-board`.
- A backend emitter `emitEdBoardEvent` + producer calls at the 3 ED board-mutating handlers.
- Frontend: subscribe via `useRealtimeInvalidation`, dynamic poll fallback, `●Live/○Polling` indicator.
- Tests: frontend (hook wiring, cadence helper, indicator) + backend (channel catalog, emitter).

**Out of scope (YAGNI)**
- No `staff:ed-board` variant. The staff Flutter app has a Bed Board but **no ED board**
  (verified: `apps/staff/lib/features/beds/screens/bed_board_screen.dart` exists; no ED screen).
  If a staff ED board is ever built, dual-broadcast is a trivial one-line follow-on.
- No change to ED data model, endpoints, or the kanban UI itself.
- No fix to the pre-existing `openOnly`/`open_only` query-param mismatch (see §9) — unrelated.
- No new persisted rows; the canonical clinical timeline invariant is untouched (we add only an
  ephemeral WS broadcast on top of existing writes).

## 3. Architecture & data flow

```
ED write (admin) ──> edRoutes.js handler ──> edOperationsService (UPDATE/INSERT)
                                   │
                                   └─(after success, inside request)─> emitEdBoardEvent(kind, row, { tenantId: req.tenantId })
                                                                          │
                                                                          └─> broadcast('admin:ed-board', payload, { tenantId })
                                                                                │  (Redis fan-out, per-broadcast tenant filter)
                                                                                ▼
admin browser ──ws──> useRealtimeChannel('admin:ed-board') ──> useRealtimeInvalidation invalidates [["ed"]]
                                                                  │
                                                                  └─> react-query refetches ["ed","visits","active"] ──> board repaints
```

The WS push carries no board data — it is a **signal to invalidate**. The existing query
function refetches the authoritative list, so there is one source of truth and no risk of the
WS payload and the REST payload diverging. This mirrors slice 1 exactly.

## 4. Backend design

### 4.1 Channel (`apps/backend/src/utils/websocket/channelAuth.js`)
Add to `CHANNEL_CATALOG`:
```js
'admin:ed-board': { description: 'ED tracking board — visit arrivals, transitions, triage priority', roles: 'admin' },
```
No `authorizeChannel` change needed: it already gates any `admin:*` channel on `isAdmin(user.role)`.

### 4.2 Emitter (`apps/backend/src/utils/websocket/realtimeEmitter.js`)
Add, mirroring `emitBedEvent` (internal try/catch — never throws into the caller):
```js
/** ED tracking-board change (arrival / transition / triage-priority). */
export function emitEdBoardEvent(kind, visit, { tenantId } = {}) {
  try {
    broadcast('admin:ed-board', {
      kind,                                            // 'arrival' | 'transition' | 'priority'
      id: visit?.id ?? null,
      visitNumber: visit?.visit_number ?? null,
      status: visit?.status ?? null,
      triagePriority: visit?.triage_priority ?? null,
      disposition: visit?.disposition ?? null,
      at: new Date().toISOString(),
    }, { tenantId });
  } catch (err) {
    logger.warn('emitEdBoardEvent failed:', err.message);
  }
}
```
Payload is intentionally lean (ids/status only, no chief complaint/name) — PHI-minimal, and the
client only needs a change signal.

### 4.3 Tenant scoping
`broadcast(channel, data, { tenantId })` resolves the tenant via `resolveTenantId(opts.tenantId)`,
which uses the explicit `tenantId` if given, else falls back to the request-scoped
`getCurrentTenantId()` (AsyncLocalStorage). We **pass `{ tenantId: req.tenantId }` explicitly** from
each handler (it is already on `req`), so the broadcast is tenant-scoped even if the emit ever moves
outside the request ALS context. (Beds relies on ALS implicitly; ED is explicit — strictly safer,
same mechanism.)

### 4.4 Producers — `apps/backend/src/routes/admin/edRoutes.js` (inline handlers, existing style)
Emit **after the service call succeeds, before `success(res, …)`**, inside the request (ALS live).
The emitter never throws, so it cannot break the response.

| Handler (line) | Service | Emit |
|---|---|---|
| `POST /visits` (L28) | `createEmergencyVisit` | `emitEdBoardEvent('arrival', row, { tenantId: req.tenantId })` |
| `PATCH /visits/:id/transition` (L59) | `transitionEmergencyVisit` | `emitEdBoardEvent('transition', row, { tenantId: req.tenantId })` |
| `PATCH /visits/:id/triage-priority` (L70) | `setVisitTriagePriority` | `emitEdBoardEvent('priority', row, { tenantId: req.tenantId })` |

Example:
```js
const row = await transitionEmergencyVisit({ tenantId: req.tenantId, id: req.params.id, nextStatus: req.body?.next_status, disposition: req.body?.disposition });
emitEdBoardEvent('transition', row, { tenantId: req.tenantId });
return success(res, row, 'Emergency visit transitioned');
```
Import `emitEdBoardEvent` from `../../utils/websocket/realtimeEmitter.js`.

`recordTriageAssessment` is **not** a producer: it inserts into `triage_assessments` and does not
mutate the `emergency_visits` row the board reads (and the board never calls it).

## 5. Frontend design

### 5.1 Cadence helper — new `apps/admin/src/app/(with-auth)/dashboard/ed-tracker/realtime.ts`
Mirrors `beds/realtime.ts`. Fallback equals today's cadence (30s); live is a relaxed safety net.
```ts
// Poll cadence for the ED board. Live: a 2-min safety poll backstops the at-most-once WS bus.
// WS down/denied: revert to the original 30s poll so behaviour is never worse than before.
export const ED_LIVE_POLL_MS = 120_000;
export const ED_FALLBACK_POLL_MS = 30_000;
export function edRefetchMs(subscribed: boolean): number {
  return subscribed ? ED_LIVE_POLL_MS : ED_FALLBACK_POLL_MS;
}
```

### 5.2 Page wiring — `ed-tracker/page.tsx`
- Add `import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";` and
  `import { edRefetchMs } from "./realtime";`.
- In `EdTrackerPage`, after `qc`:
  ```ts
  const { subscribed } = useRealtimeInvalidation("admin:ed-board", [["ed"]]);
  ```
  `[["ed"]]` prefix-covers the board's `["ed","visits","active"]` key (and any future `["ed",…]`).
- Replace the query's `refetchInterval: 30_000` with `refetchInterval: edRefetchMs(subscribed)`.
- Replace the static subtitle "Live emergency department flow. Auto-refreshes every 30s." with a
  `●Live / ○Polling` indicator (`role="status"`, `aria-label`), identical pattern to the beds page.
  Keep the existing manual "Refresh" button.

No other UI change. Mutations already `invalidateQueries(["ed"])`, so the optimistic local refresh
is preserved.

## 6. Cadence decision (resolved)
- Live: **120s** (4× the current poll — relaxed but ED-appropriate safety backstop for the
  at-most-once bus). Fallback: **30s** (== current behaviour when WS is down).

## 7. Testing

**Frontend (admin jest)** — new `apps/admin/src/__tests__/dashboard/ed-tracker/`:
- `page.test.tsx` — `jest.mock("@/hooks/useRealtimeInvalidation")` (mandatory — a real WS in jsdom
  breaks the test). Assert the hook is called with `("admin:ed-board", [["ed"]])`; assert the
  indicator renders `Polling` when `subscribed:false` and `Live` when `subscribed:true`. Mock typing
  per slice-1 note: `jest.fn((..._args: unknown[]) => ({ connected, subscribed, denied: null as string|null, lastEventAt: null as number|null }))`.
- `realtime.test.ts` — `edRefetchMs(true) === 120_000`, `edRefetchMs(false) === 30_000`.

**Backend (jest)**:
- Channel catalog/authorization unit test: `authorizeChannel('admin:ed-board', { role:'ADMIN' })` allowed;
  `{ role:'PATIENT' }` / staff denied. Extend the existing realtime/channel test
  (`src/tests/contracts/realtime-flow.test.js` or the channelAuth unit test, matching slice-1 precedent).
- Emitter unit test mirroring any `emitBedEvent` test: stub `broadcast`, assert `emitEdBoardEvent`
  calls it with `'admin:ed-board'`, the right `kind`, and `{ tenantId }`.

**Honest limitation:** the live WS push is **not** automatically tested (no WS in jsdom; deploy HELD).
Manual verification recipe in §10. The suites cover the wiring, cadence, indicator, channel RBAC, and
emitter — not an end-to-end live push.

## 8. Resilience / error handling
- Emit is **best-effort, post-mutation, non-blocking**: `emitEdBoardEvent` try/catches internally, so
  a WS/Redis failure logs a warning and never affects the HTTP response or the DB write (matches the
  CLAUDE.md Phase 1.5 rule and the `emitBedEvent` precedent).
- WS bus is at-most-once; the live safety poll (120s) is the backstop for a dropped event.
- Channel RBAC unchanged (`admin:*` → `isAdmin`); no new auth surface.

## 9. Pre-existing issue noted (out of scope)
`ed-tracker/page.tsx` requests `/admin/ed/visits?openOnly=true` (camelCase) but `edRoutes.js` reads
`req.query.open_only` (snake_case), so the open-only filter is currently a no-op (backend returns all
visits up to `limit`). Unrelated to real-time; flagged for a separate fix, not touched here.

## 10. Verification
- **Gates:** admin `npm run type-check`, `npm run lint`, `npm test`, `npm run build`; backend
  `npm run lint`, `npm test` (the new channel/emitter tests). All must be green.
- **Manual live-WS check (deploy HELD, so local):** run backend + admin dev, open the ED board, confirm
  `●Live`; from a second client `PATCH /admin/ed/visits/:id/transition`; the board repaints within ~1s
  without the 30s poll. Kill the WS → indicator flips to `○Polling` and the 30s poll resumes.

## 11. File-change inventory
- `apps/backend/src/utils/websocket/channelAuth.js` — +1 catalog entry.
- `apps/backend/src/utils/websocket/realtimeEmitter.js` — +`emitEdBoardEvent`.
- `apps/backend/src/routes/admin/edRoutes.js` — import + 3 emit calls.
- `apps/admin/src/app/(with-auth)/dashboard/ed-tracker/realtime.ts` — new.
- `apps/admin/src/app/(with-auth)/dashboard/ed-tracker/page.tsx` — hook + cadence + indicator.
- `apps/admin/src/__tests__/dashboard/ed-tracker/page.test.tsx` — new.
- `apps/admin/src/__tests__/dashboard/ed-tracker/realtime.test.ts` — new.
- backend channel/emitter test — new or extended.

## 12. Risks
| Risk | Mitigation |
|---|---|
| WS/Redis failure blocks an ED write | Emitter try/catches; emit is post-commit, non-blocking. |
| Cross-tenant leak of ED events | Explicit `{ tenantId: req.tenantId }` + per-broadcast tenant filter. |
| Adding the hook breaks the page test | No existing ed-tracker test; new test mocks the hook from the start. |
| Live push silently fails | 120s safety poll backstops; indicator shows real subscription state. |
