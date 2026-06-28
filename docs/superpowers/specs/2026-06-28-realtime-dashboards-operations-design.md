# Real-time dashboards — Slice 3: Operations Snapshot (`admin:daily-ops`)

- **Date:** 2026-06-28
- **Epic:** #4 Real-time-first dashboards
- **Status:** Design approved → spec
- **Builds on:** Slice 1 (beds) + Slice 2 (ED) and the WS fabric (`apps/backend/src/utils/websocket/`). Introduces the **broadcast-snapshot** pattern (the cron-fed sibling of the event/invalidate pattern), mirroring the existing `admin:kpi` aggregator.

## 1. Context & goal

The admin **Daily Operations Snapshot** (`apps/admin/src/app/(with-auth)/dashboard/operations/page.tsx`)
shows morning-huddle headline numbers (OPD, IP in-house, OR cases, critical lab alerts, collections,
pre-auths, claims) from a single query `["dashboards","daily-ops"]` →
`GET /dashboards/snapshot/daily-ops`, polling every 60s. The endpoint is **admin-only** (`requireAdmin`).

**Goal:** make it **server-pushed**. A per-tenant cron computes `getDailyOpsSnapshot` once and broadcasts
the snapshot on `admin:daily-ops`; each admin client renders the pushed data live without refetching.
Strict improvement: live push + a slow safety poll when the socket is up; identical 60s poll when it is down.

**Why broadcast-snapshot (not invalidate→refetch):** the snapshot is a cron-fed aggregate. Broadcasting
the computed data means the 8-subquery snapshot runs **once per tenant per tick** regardless of viewer
count (true fan-out), matching the `admin:kpi` precedent. Because the WS push and the REST poll both call
the **same** `getDailyOpsSnapshot`, the two payloads are byte-identical — no drift to manage.

## 2. Scope

**In scope**
- New admin-only channel `admin:daily-ops`.
- A backend emitter `emitDailyOps` + a per-tenant cron producer (`tickDailyOps`) registered in the scheduler.
- A new reusable frontend hook `useRealtimeData` (the "snapshot" sibling of `useRealtimeInvalidation`).
- Frontend: subscribe via `useRealtimeData`, dynamic poll fallback, `●Live/○Polling` indicator.
- Tests: channel RBAC, emitter, `tickDailyOps` fan-out, the hook, cadence helper, page wiring.

**Out of scope (YAGNI)**
- No change to the snapshot SQL, the route, or the metric cards.
- No new persisted rows (ephemeral WS only; canonical-timeline invariant untouched).
- Not converting the other `/snapshot/*` dashboards (opd-daily, ip-occupancy, …) — this slice does
  daily-ops only; the new `useRealtimeData` hook makes follow-ons trivial.
- Not changing `admin:kpi`'s global (non-per-tenant) tick — out of scope.

## 3. Architecture & data flow

```
cron (every 60s, withJobLock) ─> tickDailyOps()
    └─ runForEachTenant('daily-ops-tick', (tenantId) =>            // runs each tenant in runInTenantContext (ALS)
         snap = await getDailyOpsSnapshot({ tenantId })            // per-tenant 8-subquery snapshot
         if (snap) emitDailyOps(snap, { tenantId }))              // broadcast('admin:daily-ops', snap, {tenantId})
                                   │  (Redis fan-out, per-broadcast tenant filter → that tenant's admins only)
                                   ▼
admin browser ── useRealtimeData("admin:daily-ops", ["dashboards","daily-ops"])
                     └─ useRealtimeChannel.lastMessage ──> queryClient.setQueryData(key, msg.data)
                                                              │
                                                              └─> the existing use<DailyOpsSnapshot> renders live
                                                                  (its queryFn still does initial load + fallback poll)
```

The broadcast payload **is** the `getDailyOpsSnapshot` output, the same shape the REST `queryFn` unwraps —
so `setQueryData` and a fallback refetch produce identical data.

## 4. Backend design

### 4.1 Channel (`apps/backend/src/utils/websocket/channelAuth.js`)
Add to `CHANNEL_CATALOG`:
```js
'admin:daily-ops': { description: 'Daily operations snapshot — OPD/IP/OR/collections/claims headline numbers', roles: 'admin' },
```
No `authorizeChannel` change: `admin:*` is already gated on `isAdmin`, matching the route's `requireAdmin`.

### 4.2 Emitter (`apps/backend/src/utils/websocket/realtimeEmitter.js`)
```js
/** Daily operations snapshot push (per-tenant cron). Payload is the getDailyOpsSnapshot row. */
export function emitDailyOps(snapshot, { tenantId } = {}) {
  try {
    broadcast('admin:daily-ops', snapshot, { tenantId });
  } catch (err) {
    logger.warn('emitDailyOps failed:', err.message);
  }
}
```
The snapshot is broadcast as the bare payload (no wrapper) so it equals the query's data shape.

### 4.3 Producer (`apps/backend/src/utils/dailyOpsBroadcaster.js` — new, mirrors `kpiAggregator.js`)
```js
import logger from '../logging/logger.js';
import { getDailyOpsSnapshot } from '../services/dashboards/snapshotService.js';
import { emitDailyOps } from './websocket/realtimeEmitter.js';
import { runForEachTenant } from './tenantFanout.js';

/** Compute the daily-ops snapshot per active tenant and broadcast it on admin:daily-ops. */
export async function tickDailyOps() {
  await runForEachTenant('daily-ops-tick', async (tenantId) => {
    try {
      const snap = await getDailyOpsSnapshot({ tenantId });
      if (snap) emitDailyOps(snap, { tenantId });
    } catch (err) {
      logger.warn(`daily-ops-tick: snapshot failed for tenant ${tenantId}: ${err.message}`);
    }
  });
}

export default { tickDailyOps };
```
`runForEachTenant` runs each tenant inside `runInTenantContext` (sets the ALS tenant); we also pass
`{ tenantId }` explicitly to the emit so the broadcast is tenant-scoped either way (DELTA-002-style belt-and-suspenders).

### 4.4 Scheduler (`apps/backend/src/utils/scheduler.js`)
- Import `tickDailyOps` and register alongside the `admin-kpi-tick`:
  ```js
  // Every 60s — daily-ops snapshot push (per-tenant). withJobLock = one runner across processes.
  registerCron('0 * * * * *', withJobLock('daily-ops-tick', tickDailyOps));
  ```
- Add an initial tick at startup (mirroring the `admin:kpi` initial tick) so freshly-connected clients
  get a push without waiting a full minute:
  ```js
  try { await tickDailyOps(); } catch (e) { logger.warn('Initial daily-ops tick failed:', e.message); }
  ```

## 5. Frontend design

### 5.1 New hook — `apps/admin/src/hooks/useRealtimeData.ts`
The "snapshot" sibling of `useRealtimeInvalidation`. Reads `lastMessage` (latest-wins, ideal for a
snapshot) and writes it into react-query via `setQueryData`:
```ts
"use client";
import { useEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useRealtimeChannel } from "./useRealtimeChannel";

/** Subscribe to a channel that broadcasts a full snapshot; push each message into react-query. */
export function useRealtimeData<T = unknown>(
  channel: string,
  queryKey: QueryKey,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;
  const lastEventAtRef = useRef<number | null>(null);

  const { lastMessage, connected, subscribed, denied } = useRealtimeChannel<T>(channel, { enabled });

  useEffect(() => {
    if (!lastMessage) return;
    lastEventAtRef.current = lastMessage.receivedAt;
    queryClient.setQueryData(keyRef.current, lastMessage.data);
  }, [lastMessage, queryClient]);

  return { connected, subscribed, denied, lastEventAt: lastEventAtRef.current };
}
```

### 5.2 Cadence helper — `apps/admin/src/app/(with-auth)/dashboard/operations/realtime.ts`
```ts
// Poll cadence for the Operations snapshot. The WS push keeps it fresh, so while subscribed we drop to a
// 5-min safety poll; if the socket drops, revert to the original 60s so behaviour is never worse than before.
export const OPS_LIVE_POLL_MS = 300_000;
export const OPS_FALLBACK_POLL_MS = 60_000;
export function opsRefetchMs(subscribed: boolean): number {
  return subscribed ? OPS_LIVE_POLL_MS : OPS_FALLBACK_POLL_MS;
}
```

### 5.3 Page wiring — `operations/page.tsx`
- Import `useRealtimeData`, `opsRefetchMs`, and the `DailyOpsSnapshot` type (already in-file).
- `const { subscribed, connected, lastEventAt } = useRealtimeData<DailyOpsSnapshot>("admin:daily-ops", ["dashboards","daily-ops"]);`
- Replace `refetchInterval: 60_000` with `refetchInterval: opsRefetchMs(subscribed)`.
- Add a `●Live/○Polling` indicator next to the `<h1>` (`role="status"`, `aria-label`, `title`), same
  pattern as beds/ED; drop "Auto-refreshes every 60s" from the subtitle. Keep the existing
  "Updated {dataUpdatedAt}" + "Refresh now" — `setQueryData` updates `dataUpdatedAt`, so "Updated"
  already reflects live pushes.

## 6. Tenant scoping
`getDailyOpsSnapshot` is strictly per-tenant (`requireTenantId`). The cron uses `runForEachTenant`, which
runs each active tenant in `runInTenantContext` (ALS), and the emit passes `{ tenantId }` explicitly. The
`broadcast` per-tenant filter then delivers each snapshot only to that tenant's admin subscribers. No
cross-tenant leak; computed once per tenant per tick.

## 7. Cadence decisions (resolved)
- Cron tick: **60s** (`'0 * * * * *'`) — same freshness as today, lower idle DB load than 30s for an
  8-subquery snapshot. Frontend fallback poll: **300s live / 60s down**.

## 8. Testing

**Backend (jest, `src/tests/unit/`)**
- `dailyOpsChannel.test.js` — `CHANNEL_CATALOG['admin:daily-ops']` defined with `roles:'admin'`;
  `authorizeChannel('admin:daily-ops', …)` allowed for ADMIN, denied for PATIENT/NURSING_STAFF.
- `emitDailyOps` unit (ESM-mock `wsServer`) — broadcasts `'admin:daily-ops'` with the snapshot object and
  `{ tenantId }`; never throws when `broadcast` throws.
- `tickDailyOps` unit (ESM-mock `tenantFanout`, `snapshotService`, `realtimeEmitter`) — `runForEachTenant`
  callback runs per tenant → `getDailyOpsSnapshot({tenantId})` then `emitDailyOps(snap, {tenantId})`;
  a null snapshot is skipped (no emit); a per-tenant throw is swallowed (other tenants still run).

**Frontend (admin jest)**
- `useRealtimeData.test.tsx` — mock `useRealtimeChannel` to emit a `lastMessage`; assert
  `queryClient.setQueryData(queryKey, msg.data)` is called with the payload.
- `operations/realtime.test.ts` — `opsRefetchMs(true)===300_000`, `(false)===60_000`.
- `operations/page.test.tsx` — `jest.mock("@/hooks/useRealtimeData")` (avoids a real WS in jsdom); assert
  it's called with `("admin:daily-ops", ["dashboards","daily-ops"])`; indicator shows Polling when not
  subscribed, Live when subscribed.

**Honest limitation:** the live WS push is **not** auto-tested (no WS in jsdom; deploy HELD) — same as
slices 1–2. Manual recipe in §10.

## 9. Resilience / error handling
- `emitDailyOps` try/catches internally (never throws). `tickDailyOps` wraps each tenant in try/catch so one
  tenant's failure doesn't abort the rest; `runForEachTenant` also isolates per-tenant errors.
- `withJobLock` guarantees a single runner across processes; the 60s tick + `runForEachTenant` mirror the
  existing per-tenant crons.
- WS bus is at-most-once; the 300s live safety poll backstops a dropped push.
- No new auth surface (`admin:*` → `isAdmin`).

## 10. Verification
- **Gates:** admin `type-check` / `lint` / `test` / `build`; backend `lint` + the new unit tests (no DB
  needed for the unit tests; the full backend integration suite is DB-gated and out of scope here).
- **Manual live-WS check (deploy HELD → local):** run backend + admin dev, open the Operations page,
  confirm `●Live` and that the numbers + "Updated" timestamp refresh on the ~60s server tick without the
  page polling; kill the WS → `○Polling` and the 60s poll resumes.

## 11. File-change inventory
- `apps/backend/src/utils/websocket/channelAuth.js` — +1 catalog entry.
- `apps/backend/src/utils/websocket/realtimeEmitter.js` — +`emitDailyOps`.
- `apps/backend/src/utils/dailyOpsBroadcaster.js` — new (`tickDailyOps`).
- `apps/backend/src/utils/scheduler.js` — import + `registerCron` + initial tick.
- `apps/backend/src/tests/unit/dailyOpsChannel.test.js` — new.
- `apps/backend/src/tests/unit/dailyOpsBroadcaster.test.js` — new (emitter + tick).
- `apps/admin/src/hooks/useRealtimeData.ts` — new.
- `apps/admin/src/app/(with-auth)/dashboard/operations/realtime.ts` — new.
- `apps/admin/src/app/(with-auth)/dashboard/operations/page.tsx` — hook + cadence + indicator.
- `apps/admin/src/__tests__/hooks/useRealtimeData.test.tsx` — new.
- `apps/admin/src/__tests__/dashboard/operations/realtime.test.ts` — new.
- `apps/admin/src/__tests__/dashboard/operations/page.test.tsx` — new.

## 12. Risks
| Risk | Mitigation |
|---|---|
| Cross-tenant snapshot leak | Per-tenant cron (`runForEachTenant` ALS) + explicit `{ tenantId }` on the broadcast. |
| WS payload drifts from REST | Both call the SAME `getDailyOpsSnapshot` — identical by construction. |
| Cron idle DB load | 60s cadence + `withJobLock` single-runner; 8 subqueries/tenant/min is modest. |
| `setQueryData` vs fallback poll race | Same shape from one source fn; latest write wins; fallback refetch is just another identical snapshot. |
| Adding the hook breaks the page test | New operations page test mocks `useRealtimeData` from the start. |
