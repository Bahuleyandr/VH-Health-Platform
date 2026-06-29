# Real-time dashboards — Slice 8: Microbiology board (`staff:micro`)

- **Date:** 2026-06-29
- **Epic:** #4 Real-time-first dashboards
- **Status:** Design approved → spec
- **Builds on:** the event-driven `useRealtimeInvalidation` recipe (ICU/lab). Converts the EXISTING `dashboard/microbiology` tab page. **Route-layer emits** (like ICU) — micro writes arrive only via the admin routes (no multi-path ingestion), so no service change.

## 1. Context & goal

The admin **Microbiology** page (`apps/admin/src/app/(with-auth)/dashboard/microbiology/page.tsx`) is a three-tab board — **Orders** (`["micro","orders",{statusFilter}]`, no poll), **Antibiogram (90d)** (`["micro","antibiogram",{organism,antibiotic}]`, no poll), **Resistance (30d)** (`["micro","resistant"]`, polls 60s) — plus an **OrderDetail modal** (`["micro","order",orderId]`, no poll). It is antimicrobial-stewardship- and infection-control-critical: positive cultures, S/I/R sensitivity postings, and new MDR isolates (MRSA/ESBL/carbapenemase/VRE/XDR) drive empirical-therapy and contact-precaution decisions. Today only the Resistance tab refreshes (60s); Orders/Antibiogram/OrderDetail need a manual refresh.

**Goal:** convert the board to **event-driven real-time** — a new `staff:micro` channel with producers at the four micro write routes; the page subscribes and invalidates the `["micro"]` query family on each event. Orders/Antibiogram/OrderDetail gain real-time they never had; the Resistance tab pushes instantly with a relaxed safety poll.

## 2. Scope

**In scope**
- New `staff:micro` channel + `emitMicroEvent` emitter + **4 route-layer producers** in `microbiologyRoutes.js`.
- Frontend: `useRealtimeInvalidation` on `[["micro"]]`, a relaxed live poll for the Resistance tab, a `●Live/○Polling` indicator.
- Tests: channel RBAC, emitter, cadence helper, page wiring.

**Out of scope (YAGNI)**
- No `routePolicy` change — `dashboard/microbiology` exists with a `microbiology: { minRank: STAFF }` entry.
- No `microbiologyService.js` change (route-layer emits; the service functions are unchanged).
- No new persisted rows / migration / channel beyond `staff:micro`.
- No change to the micro data model, the order/isolate/sensitivity workflow, or the antibiogram view.

## 3. Architecture & data flow

```
admin write (any client):
  POST /microbiology/orders                  → createOrder      ─┐
  POST /microbiology/orders/:id/transition   → transitionOrder  ─┤  (after the service call, in the
  POST /microbiology/orders/:id/isolates     → addIsolate       ─┤   wrap block) emitMicroEvent(kind,
  POST /microbiology/isolates/:id/sensitivities → addSensitivity ┘   { tenantId: tenantOf(req) })
                                                                       └─> broadcast('staff:micro', {kind,at}, {tenantId})
                                                                             │  (Redis fan-out, per-broadcast tenant filter)
                                                                             ▼
MicrobiologyPage ── useRealtimeInvalidation('staff:micro', [["micro"]]) ──> invalidate ["micro"]
                                                                             └─> the mounted tab (+ open OrderDetail modal) refetches
```

The WS push is a **PHI-free invalidation signal** (`{kind, at}` only); the existing query functions refetch the authoritative data through the RBAC-guarded REST routes. All four micro mutations go only through these routes (no HL7/analyzer ingestion), so **route-layer emits cover every write** — `microbiologyService.js` is untouched.

## 4. Backend design

### 4.1 Channel (`apps/backend/src/utils/websocket/channelAuth.js`)
Add to `CHANNEL_CATALOG` (after `staff:lab`):
```js
'staff:micro': { description: 'Microbiology — culture orders, isolates, sensitivities, MDR resistance', roles: 'staff' },
```
**`staff:` (isStaff), NOT `staff:clinical:`.** Every `microbiologyRoutes.js` handler gates on `requireStaffOrAdmin` (isStaff‖isAdmin), and the board's primary users are **lab staff** — `LAB_STAFF` is **not** in `CLINICAL_ROLES` (it's a diagnostics/support role), so a `staff:clinical:` channel (isClinical‖isAdmin) would **deny lab staff** their own board (DELTA-002). `staff:micro` matches the route's isStaff gate exactly (same as the lab slice). The emit carries no PHI; the mild over-grant vs the exact `MICROBIOLOGY_ROUTE_ROLES` mount is harmless (board DATA stays gated by the REST route).

### 4.2 Emitter (`apps/backend/src/utils/websocket/realtimeEmitter.js`)
```js
/** Microbiology board change (order created/transitioned, isolate/sensitivity added). */
export function emitMicroEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:micro', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitMicroEvent failed:', err.message);
  }
}
```
Mirrors `emitLabEvent`/`emitIcuBoardEvent`; internal try/catch → never throws into the micro write.

### 4.3 Producers — `apps/backend/src/routes/lab/microbiologyRoutes.js` (import + 4 sites)
These handlers use the `wrap(async (req) => micro.X(...))` concise-arrow form (handler returns data). Convert each to a block that captures `tenantId` once, awaits the service, emits best-effort, returns the row (ICU pattern). `emitMicroEvent` never throws.

| Handler | kind |
|---|---|
| `POST /orders` → `createOrder` | `'order-created'` |
| `POST /orders/:id/transition` → `transitionOrder` | `'order-transition'` |
| `POST /orders/:id/isolates` → `addIsolate` | `'isolate-added'` |
| `POST /isolates/:id/sensitivities` → `addSensitivity` | `'sensitivity-added'` |

Reference conversion (createOrder):
```js
router.post('/orders', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await micro.createOrder({ tenantId, ordered_by: req.user?.uid, ...req.body });
  emitMicroEvent('order-created', { tenantId });
  return row;
}));
```
Import: `import { emitMicroEvent } from '../../utils/websocket/realtimeEmitter.js';`. Tenant via `tenantOf(req)` (= `resolveTenantOrThrow(req)`). The GET handlers (orders/order/antibiogram/resistant-isolates) are unchanged.

## 5. Frontend design

### 5.1 Cadence helper — new `apps/admin/src/app/(with-auth)/dashboard/microbiology/realtime.ts`
```ts
export const MICRO_CHANNEL = "staff:micro";
// The Resistance tab polled 60s; Orders/Antibiogram/OrderDetail had no poll (push-only now). While
// subscribed we relax the Resistance poll to a 2-min safety net (push makes it instant), reverting to 60s
// when WS is down so behaviour is never worse than before.
export const MICRO_LIVE_POLL_MS = 120_000;
export function microRefetchMs(subscribed: boolean, baseMs: number): number {
  return subscribed ? MICRO_LIVE_POLL_MS : baseMs;
}
```

### 5.2 Page wiring — `microbiology/page.tsx`
- Import `useRealtimeInvalidation`, `MICRO_CHANNEL`, `microRefetchMs`.
- In `MicrobiologyPage` (the always-mounted tab orchestrator), after the `useState`:
  `const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(MICRO_CHANNEL, [["micro"]]);`
  (one root prefix covers `["micro","orders"]` / `["micro","antibiogram"]` / `["micro","resistant"]` / `["micro","order",id]`.)
- Add a `●Live/○Polling` indicator next to the `<h1>Microbiology</h1>` (`data-testid="micro-realtime-indicator"`, `role="status"`, `aria-label`, `title`), same markup as lab/ICU. Wrap the `<h1>` + indicator in a flex `div` (keep the existing subtitle `<p>` and tab bar).
- Pass `subscribed` to the Resistance tab: `{tab === "resistance" && <ResistanceTab subscribed={subscribed} />}`. Orders/Antibiogram tabs are unchanged (`<OrdersTab />`, `<AntibiogramTab />`) — they gain real-time purely via the invalidation (no poll to relax).
- `ResistanceTab`: add a `subscribed: boolean` prop; change its query `refetchInterval: 60_000` → `refetchInterval: microRefetchMs(subscribed, 60_000)` (import `microRefetchMs`).

## 6. Tenant scoping & PHI
Each emit passes `{ tenantId: tenantOf(req) }` → the per-broadcast tenant filter delivers each signal only to that tenant's micro staff. No cross-tenant signal leak. The WS payload is `{kind, at}` only — **no PHI**; the board's PHI stays behind the RBAC-guarded REST refetch (`patientAccessGuard('MICROBIOLOGY')` + `phiAccessLogger('MICROBIOLOGY')` on the `/microbiology` mount).

## 7. Testing
- **Backend** `microRealtimeChannel.test.js` — `CHANNEL_CATALOG['staff:micro']` present with `roles:'staff'`; `authorizeChannel('staff:micro', …)` allowed for `NURSING_STAFF`/`LAB_STAFF`/`ADMIN`, denied for `PATIENT`.
- **Backend** `microRealtimeEmitter.test.js` (ESM-mock `wsServer`) — `emitMicroEvent('isolate-added', { tenantId })` broadcasts `'staff:micro'` with `{kind, at}` + `{tenantId}`; never throws when `broadcast` throws.
- **Producer wiring:** no new automated test (route-handler wiring; the emit logic is covered by `microRealtimeEmitter.test.js`; mounting the micro router needs auth/DB scaffolding) — verified by `npm run lint` + the channel/emitter unit tests. Same precedent as the ICU/OR slices.
- **Frontend** `micro/realtime.test.ts` — `microRefetchMs(true, 60_000)===120_000`, `microRefetchMs(false, 60_000)===60_000`.
- **Frontend** `micro/page.test.tsx` — `jest.mock("@/hooks/useRealtimeInvalidation")` + `@/lib/api`; assert the hook is called with `(MICRO_CHANNEL, [["micro"]])`; indicator Polling when not subscribed, Live when subscribed. (`MicrobiologyPage` renders `OrdersTab` by default → mock `fetchAdminAPI`→`[]`.)

**Honest limitations:** live WS push not auto-tested (no WS in jsdom; deploy HELD) — same as every slice.

## 8. Resilience / error handling
- Emits are best-effort, post-mutation, non-blocking (`emitMicroEvent` try/catches internally — matches `emitLabEvent`/`emitIcuBoardEvent` and the CLAUDE.md Phase-1.5 rule). A WS failure can never abort a micro write.
- WS bus is at-most-once; the Resistance tab keeps a 120s live safety poll (60s when WS down). Orders/Antibiogram/OrderDetail had no poll before and are push-only now (strict improvement; refetch on the next event or manual Refresh).
- No new auth surface (`staff:*` → `isStaff`). PHI stays behind the REST refetch.

## 9. Verification
- **Gates:** backend `lint` + `microRealtimeChannel`/`microRealtimeEmitter` unit tests; admin `type-check`/`lint`/`test`/`build`.
- **Manual (deploy HELD → local):** open the micro board (`●Live`); from a second client `POST /microbiology/orders` (or add an isolate/sensitivity) → the Orders tab / open OrderDetail modal repaint within ~1s without the poll; a new MDR isolate appears on the Resistance tab live.

## 10. File-change inventory
- `apps/backend/src/utils/websocket/channelAuth.js` — +1 catalog entry.
- `apps/backend/src/utils/websocket/realtimeEmitter.js` — +`emitMicroEvent`.
- `apps/backend/src/routes/lab/microbiologyRoutes.js` — import + 4 emit calls (concise-arrow → block conversions).
- `apps/backend/src/tests/unit/microRealtimeChannel.test.js` — new.
- `apps/backend/src/tests/unit/microRealtimeEmitter.test.js` — new.
- `apps/admin/src/app/(with-auth)/dashboard/microbiology/realtime.ts` — new.
- `apps/admin/src/app/(with-auth)/dashboard/microbiology/page.tsx` — hook + indicator + `subscribed` prop + `microRefetchMs`.
- `apps/admin/src/__tests__/dashboard/microbiology/realtime.test.ts` — new.
- `apps/admin/src/__tests__/dashboard/microbiology/page.test.tsx` — new.

## 11. Risks
| Risk | Mitigation |
|---|---|
| Channel scope mismatch (DELTA-002) | `staff:micro` (isStaff) matches the route's `requireStaffOrAdmin` gate — NOT `staff:clinical:` (would deny LAB_STAFF, the primary user; verified `LAB_STAFF` ∉ `CLINICAL_ROLES`). Asserted in the channel test. |
| Cross-tenant signal leak | Explicit `{ tenantId: tenantOf(req) }` on each broadcast + per-broadcast tenant filter. |
| Emit blocks a micro write | Emitter try/catches; post-mutation, non-blocking. |
| `sensitivity-added` upsert fires on insert+update | The frontend invalidates the whole `["micro"]` family regardless of kind — a corrected S→R sensitivity (the upsert's update path) pushes the same as an insert; the refetch pulls the authoritative OrderDetail/antibiogram. |
| Adding the hook breaks the page test | New `micro/page.test.tsx` mocks the hook from the start. |
| Antibiogram reads the `antibiogram_90d` VIEW | Invalidating the shared `["micro"]` prefix refetches it through its existing query fn — no special handling. |
