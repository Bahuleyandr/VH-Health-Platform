# Real-time dashboards — Slice 4: OR Board (`staff:or-board`)

- **Date:** 2026-06-28
- **Epic:** #4 Real-time-first dashboards
- **Status:** Design approved → spec
- **Builds on:** Slice 1 (beds) + Slice 2 (ED) — same event-driven `useRealtimeInvalidation` pattern. (Slice 3 Operations used the broadcast-snapshot variant; OR Board is event-driven because its board query is parameterized by date/room.)

## 1. Context & goal

The admin **OR Board** (`apps/admin/src/app/(with-auth)/dashboard/or-board/page.tsx`) is the OT coordinator's
single-screen view of today's surgical cases per room (status, WHO 3-phase safety dots, pre-op checklist,
note counts, complications). It polls every 60s via `["theatre","board",{date,room}]` →
`GET /theatre/board`. The route is gated by `THEATRE_ROUTE_ROLES` (doctors/nurses/theatre roles + admin).

**Goal:** convert it to **event-driven real-time** by reusing the slice-1/2 pattern — a new WS channel
`staff:or-board` with producers at the case-lifecycle write sites; the board subscribes and invalidates
its react-query key on each event. New cases, status transitions, and cancellations push instantly;
strict improvement with a safety poll; identical 60s poll when WS is down.

**Why event-driven (not snapshot):** the board query is **parameterized by date + room**, so a cron can't
know each client's view. An invalidation signal makes each client refetch *its own* `date/room` board.

## 2. Scope

**In scope**
- New `staff:or-board` channel.
- A backend emitter `emitOrBoardEvent` + producer calls at the 3 case-lifecycle handlers (schedule / status / cancel).
- Frontend: subscribe via `useRealtimeInvalidation`, dynamic poll fallback, `●Live/○Polling` indicator.
- Tests: channel RBAC, emitter, cadence helper, page wiring.

**Out of scope (YAGNI)**
- The **secondary** board fields — WHO safety phases (sign_in/time_out/sign_out), pre-op checklist
  (consent/blood), complications, note counts — do **not** get producers; they refresh on the 120s safety
  poll. Wiring them (Approach B) is a clean follow-on.
- No change to the board UI, the theatre data model, or the route.
- The **staff Flutter theatre screen** (`apps/staff/lib/features/theatre/`) is a natural future
  `staff:or-board` consumer — not wired here.
- No new persisted rows (ephemeral WS only; canonical-timeline invariant untouched).

## 3. Architecture & data flow

```
OT write (any client) ──> theatreRoutes handler ──> theatreService (mutation)
                                   │
                                   └─(after success, inside request)─> emitOrBoardEvent(kind, { scheduleId, status, tenantId: tenantOf(req) })
                                                                          │
                                                                          └─> broadcast('staff:or-board', {kind,…}, { tenantId })
                                                                                │  (Redis fan-out, per-broadcast tenant filter)
                                                                                ▼
admin browser ──ws──> useRealtimeInvalidation('staff:or-board') ──> invalidate [["theatre","board"]]
                                                                      └─> react-query refetches ["theatre","board",{date,room}] ──> board repaints
```

The WS push is a **signal to invalidate** (bare ids/status, no PHI); the existing query function refetches
the authoritative board, so there's one source of truth.

## 4. Backend design

### 4.1 Channel (`apps/backend/src/utils/websocket/channelAuth.js`)
Add to `CHANNEL_CATALOG` (near the other `staff:` entries, e.g. after `staff:appointments`):
```js
'staff:or-board': { description: 'OR board — surgical case schedule/status/cancellation changes', roles: 'staff' },
```
No `authorizeChannel` change: `staff:*` is already gated on `isStaff` — admits all theatre clinical roles
+ admins, matching the route audience. The emit carries no PHI, so the (mild) over-grant vs the exact
`THEATRE_ROUTE_ROLES` set is harmless; the board DATA stays gated by the REST route.

### 4.2 Emitter (`apps/backend/src/utils/websocket/realtimeEmitter.js`)
```js
/** OR board change (case scheduled / status changed / cancelled). */
export function emitOrBoardEvent(kind, { scheduleId, status, tenantId } = {}) {
  try {
    broadcast('staff:or-board', {
      kind,
      scheduleId: scheduleId ?? null,
      status: status ?? null,
      at: new Date().toISOString(),
    }, { tenantId });
  } catch (err) {
    logger.warn('emitOrBoardEvent failed:', err.message);
  }
}
```

### 4.3 Producers — `apps/backend/src/routes/theatre/theatreRoutes.js` (inline handlers; emit post-mutation, before `success`)
| Handler | Service | Emit |
|---|---|---|
| `POST /schedule` | `scheduleSurgery` → `schedule` | `emitOrBoardEvent('scheduled', { scheduleId: schedule?.id, status: schedule?.status, tenantId: tenantOf(req) })` |
| `PUT /:id/status` | `updateStatus` → `result` | `emitOrBoardEvent('status-changed', { scheduleId: result?.id, status: result?.status, tenantId: tenantOf(req) })` |
| `DELETE /:id` | `cancelSurgery` → `result` | `emitOrBoardEvent('cancelled', { scheduleId: Number(id), status: 'cancelled', tenantId: tenantOf(req) })` |

`emitOrBoardEvent` never throws (internal try/catch), so it can't disturb the response. Not wired:
`PUT /:id/checklist` (pre-op checklist) — secondary, rides the poll.

## 5. Frontend design

### 5.1 Cadence helper — new `apps/admin/src/app/(with-auth)/dashboard/or-board/realtime.ts`
```ts
// Poll cadence for the OR Board. Status/schedule/cancel push live; the secondary fields (WHO phases,
// checklist, complications) ride this poll, so the live interval stays a modest 2 min (vs the original 60s
// fallback when WS is down) — never worse than before, status changes far fresher.
export const OR_LIVE_POLL_MS = 120_000;
export const OR_FALLBACK_POLL_MS = 60_000;
export function orRefetchMs(subscribed: boolean): number {
  return subscribed ? OR_LIVE_POLL_MS : OR_FALLBACK_POLL_MS;
}
```

### 5.2 Page wiring — `or-board/page.tsx`
- Import `useRealtimeInvalidation` and `orRefetchMs, OR_FALLBACK_POLL_MS`.
- In `OrBoardPage`, after the `useState`s: `const { connected, subscribed, lastEventAt } = useRealtimeInvalidation("staff:or-board", [["theatre","board"]]);`
- Change the board query's `refetchInterval: 60_000` → `refetchInterval: orRefetchMs(subscribed)`. (Leave the `["theatre","rooms"]` query unchanged — `[["theatre","board"]]` does not match it.)
- Add a `●Live/○Polling` indicator next to the `<h1>` (`role="status"`, `aria-label`, `title`), same
  pattern as beds/ED; keep the existing "Updated {dataUpdatedAt}" + "Refresh now". Drop "Auto-refreshes
  every 60s" from the subtitle. Tooltip fallback derives "Polling every Ns" from `OR_FALLBACK_POLL_MS / 1000`.

## 6. Tenant scoping
Each emit passes `{ tenantId: tenantOf(req) }` explicitly (and the request ALS context backs it up), so
the per-broadcast tenant filter delivers each signal only to that tenant's theatre staff. No cross-tenant
invalidation-signal leak (which would otherwise needlessly refetch + reveal cross-tenant OT-event timing).

## 7. Cadence decision (resolved)
- Live: **120s** (status/schedule/cancel are instant via WS; the un-emitted secondary fields stay within
  120s). Fallback: **60s** (== today's behaviour when WS is down).

## 8. Testing
- Backend: `orBoardChannel.test.js` — `CHANNEL_CATALOG['staff:or-board']` present with `roles:'staff'`;
  `authorizeChannel('staff:or-board', …)` allowed for `NURSING_STAFF`/`DOCTOR`/`ADMIN`, denied for `PATIENT`.
- Backend: `orBoardEmitter.test.js` (ESM-mock `wsServer`) — `emitOrBoardEvent('status-changed', {scheduleId, status, tenantId})` broadcasts `'staff:or-board'` with the payload + `{tenantId}`; never throws when `broadcast` throws.
- Frontend: `or-board/realtime.test.ts` — `orRefetchMs(true)===120_000`, `(false)===60_000`.
- Frontend: `or-board/page.test.tsx` — `jest.mock("@/hooks/useRealtimeInvalidation")`; assert called with
  `("staff:or-board", [["theatre","board"]])`; indicator Polling when not subscribed, Live when subscribed.

**Honest limitations:** live WS push not auto-tested (no WS in jsdom; deploy HELD) — same as slices 1-2.
Only the 3 lifecycle events emit; WHO-phase/checklist/complications freshness rides the 120s poll.

## 9. Resilience / error handling
- Emit is best-effort, post-mutation, non-blocking (`emitOrBoardEvent` try/catches internally — matches the
  `emitBedEvent`/`emitEdBoardEvent` precedent and the CLAUDE.md Phase-1.5 rule).
- WS bus is at-most-once; the 120s live safety poll backstops a dropped event.
- No new auth surface (`staff:*` → `isStaff`).

## 10. Verification
- **Gates:** admin `type-check`/`lint`/`test`/`build`; backend `lint` + the new unit tests (no DB needed
  for the unit tests; full backend integration suite is DB-gated and out of scope here).
- **Manual live-WS check (deploy HELD → local):** open the OR Board (`●Live`); from a second client
  `PUT /theatre/:id/status`; the board repaints within ~1s without waiting for the poll; kill the WS →
  `○Polling` + the 60s poll resumes.

## 11. File-change inventory
- `apps/backend/src/utils/websocket/channelAuth.js` — +1 catalog entry.
- `apps/backend/src/utils/websocket/realtimeEmitter.js` — +`emitOrBoardEvent`.
- `apps/backend/src/routes/theatre/theatreRoutes.js` — import + 3 emit calls.
- `apps/backend/src/tests/unit/orBoardChannel.test.js` — new.
- `apps/backend/src/tests/unit/orBoardEmitter.test.js` — new.
- `apps/admin/src/app/(with-auth)/dashboard/or-board/realtime.ts` — new.
- `apps/admin/src/app/(with-auth)/dashboard/or-board/page.tsx` — hook + cadence + indicator.
- `apps/admin/src/__tests__/dashboard/or-board/realtime.test.ts` — new.
- `apps/admin/src/__tests__/dashboard/or-board/page.test.tsx` — new.

## 12. Risks
| Risk | Mitigation |
|---|---|
| Cross-tenant signal leak | Explicit `{ tenantId: tenantOf(req) }` on the broadcast + per-broadcast tenant filter. |
| Secondary fields feel stale | 120s live poll keeps WHO-phase/checklist/complications ≤120s; the emit's refetch pulls the whole board anyway. WHO-phase emits are a documented follow-on. |
| Emit blocks an OT write | Emitter try/catches; post-mutation, non-blocking. |
| Adding the hook breaks the page test | New or-board page test mocks the hook from the start. |
