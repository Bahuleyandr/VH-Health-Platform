# Real-Time-First Dashboards — Slice 1 (Beds) Design

**Date:** 2026-06-27
**Epic:** ROADMAP §0 Tier-2 #4 (Real-time-first dashboards)
**Status:** Approved design → ready for implementation plan
**Scope:** Admin-web (Next.js). First slice of a multi-slice epic — establishes the reusable poll→push pattern on ONE dashboard (Beds), which later slices (more admin dashboards, then the Flutter clients) reuse.

## Goal

Make the admin **Beds / occupancy** dashboard update in real time by subscribing to the **already-broadcast `admin:beds` channel** instead of polling every 60s — and ship the **reusable hook** (`useRealtimeInvalidation`) that turns any polled react-query dashboard into a real-time-first one with a poll fallback. Zero backend change for this slice (the producer + channel already exist).

## Background — current state (explored 2026-06-27)

The real-time infrastructure already exists end-to-end; the ROADMAP's "WS fabric exists, used in 1 tile" understates it:

- **Backend** (`apps/backend/src/utils/websocket/`): `broadcast(channel, data, opts)` / `sendToUser()` over a Redis pub/sub fan-out (`wsRedisAdapter.js`) with a per-broadcast tenant filter and channel RBAC (`channelAuth.js`, `CHANNEL_CATALOG`). **`admin:beds` is already broadcast on EVERY bed event** — `bedController.js` emits `bed-created`/`bed-updated`/`bed-deleted`/`patient-admitted`/`patient-discharged`/`bed-notes-updated` to `staff:beds` + `admin:beds`. The bus is **at-most-once** (a message published mid-Sentinel-failover is silently dropped; see the observability epic's `ws_broadcast_dropped_total`).
- **Admin client** (`apps/admin/src/hooks/useRealtimeChannel.ts`): a production-grade hook — ticket auth (`POST /api/realtime-ticket` → `/ws`, auth as first frame), ping/pong keep-alive, reconnect with backoff. Signature `useRealtimeChannel<T>(channel, { enabled, onEvent })` → `{ lastMessage, connected, subscribed, denied, latencyMs }`. It already exposes an `onEvent` callback fired on every channel event.
- **The gap:** the Beds dashboard (`apps/admin/src/app/(with-auth)/dashboard/beds/page.tsx`) still **polls 3 queries at 60s** (`["beds","occupancy"]`, `["beds","list"]`, `["wards","list"]`) even though `admin:beds` already pushes every change. (Other polled admin dashboards — OR Board, Audit, Anesthesia — would need NEW backend channels; out of scope for slice 1.)

## Chosen approach

**Invalidate-and-refetch + dynamic poll fallback** (vs a full `useRealtimeQuery` wrapper, or merge-events-into-cache). Smallest surface, reuses the entire existing query/api layer unchanged, and the dynamic poll makes it a strict improvement: real-time when WS is up, never worse than today when it's down. Merge-into-cache was rejected (premature — would force client-side recomputation of the occupancy summary + leave the cache stale on a dropped at-most-once event until the next poll).

## Architecture — three small units

### Unit 1 — `useRealtimeInvalidation` hook (the reusable unit)

`apps/admin/src/hooks/useRealtimeInvalidation.ts`:

```
useRealtimeInvalidation(
  channel: string,
  queryKeys: QueryKey[],            // keys to invalidate on each event
  opts?: { enabled?: boolean },
) → { connected, subscribed, denied, lastEventAt }
```

Implementation: wraps `useRealtimeChannel(channel, { enabled, onEvent })`; the `onEvent` callback calls `queryClient.invalidateQueries({ queryKey })` for each key (react-query then refetches through the existing query functions). Returns the connection state (`connected`/`subscribed`/`denied` from the underlying hook) plus `lastEventAt` (timestamp of the last event, for a freshness indicator). Generic — no beds-specific logic; every future dashboard reuses it. **Interface contract:** what it does = "subscribe to `channel`, invalidate `queryKeys` on each event"; how you use it = the call above; depends on = `useRealtimeChannel` + react-query's `useQueryClient`. No `onEvent` escape hatch in this slice (YAGNI; can add later for merge-mode).

### Unit 2 — Beds dashboard conversion

`apps/admin/src/app/(with-auth)/dashboard/beds/page.tsx` (minimal, additive):
- Subscribe: `const { connected, subscribed, lastEventAt } = useRealtimeInvalidation("admin:beds", [["beds"]]);`. Invalidating `["beds"]` covers BOTH `["beds","occupancy"]` and `["beds","list"]` (react-query prefix match). `["wards"]` is intentionally NOT invalidated — a bed event never changes the ward list.
- Dynamic fallback: replace the three hardcoded `refetchInterval: 60_000` with `refetchInterval: subscribed ? 300_000 : 60_000`. While the subscription is live, a 5-min safety poll backstops the at-most-once bus; if WS drops/denies, it reverts to today's 60s behavior automatically. (Hoist the interval into a `const bedsRefetchMs = subscribed ? 300_000 : 60_000;` used by all three queries.)
- Operator affordance: a small "● Live" (green, when `subscribed`) / "○ Polling" (grey) indicator near the dashboard header, with a relative "updated Ns ago" from `lastEventAt`/query `dataUpdatedAt`. Uses existing UI primitives; no new design system.
- No change to the query functions, the api layer, mutations, or `invalidateBedMaster()`.

### Unit 3 — Tests

- **Hook unit test** (`apps/admin/src/__tests__/hooks/useRealtimeInvalidation.test.tsx`, jest + React Testing Library, matching the admin's existing jest setup): mock `useRealtimeChannel` (so no real WS) to capture the `onEvent` callback + drive `connected`/`subscribed`; render the hook inside a `QueryClientProvider` with a spied `invalidateQueries`; assert (a) firing an event invalidates exactly the passed `queryKeys`, (b) it returns the connection state, (c) `enabled:false` doesn't subscribe.
- **Beds page interaction** (extend an existing beds test if present, else a focused render test): mock `useRealtimeInvalidation` → assert the dashboard renders the Live/Polling indicator per `subscribed`, and that the dynamic `refetchInterval` is 300_000 when subscribed / 60_000 when not (assert via the value passed to `useQuery`, or a small extracted pure helper `bedsRefetchMs(subscribed)` unit-tested directly — preferred, avoids brittle query-internals assertions).
- **Manual verification (documented, honest — deploy is HELD):** the live WS path can't be unit-tested. The plan documents a manual recipe: backend `npm run dev` + admin `npm run dev`, open the Beds dashboard, trigger a bed admit/discharge (via the dashboard's own mutation or a second client), and observe the grid update within ~1s (not waiting for a poll) + the "● Live" indicator. This is stated as manual, not claimed as automated.

## Data flow

```
bedController emits bed event
  → broadcast("admin:beds", {...}) + ("staff:beds", …)
  → Redis fan-out (tenant-filtered) → admin client's /ws socket
  → useRealtimeChannel onEvent → useRealtimeInvalidation
  → queryClient.invalidateQueries(["beds"])
  → react-query refetches occupancy + list (existing queryFns)
  → Beds grid re-renders (near-instant)
Fallback: 5-min safety poll while subscribed; 60s poll if WS down.
```

## Error handling / edge cases

- **WS unavailable / denied** (`subscribed:false`): the dashboard automatically uses the 60s poll — identical to today. The indicator shows "○ Polling". No error surfaced to the operator (graceful).
- **At-most-once drop:** a missed event is corrected within 5 min by the safety poll (acceptable for bed census; not a safety-critical alert stream). Documented as the explicit tradeoff.
- **Reconnect:** `useRealtimeChannel` already re-acquires a ticket + re-subscribes on reconnect; `useRealtimeInvalidation` inherits this. On resubscribe, react-query's `refetchOnReconnect`/the next poll resyncs state.
- **Tenant/RBAC:** `admin:beds` is admin-only (channelAuth) and tenant-filtered backend-side; the ticket carries the admin's identity. No extra client work.
- **Page hidden:** pass `enabled` driven by document visibility later if needed (YAGNI now; the ping/pong + backoff already handle idle sockets).

## Testing boundary (honest)

Units 1–2 are unit/component-tested in jest (mocked WS). The end-to-end live push is verified MANUALLY against the local dev stack (documented recipe) — it is NOT an automated test, because there's no WS in jsdom and deploy is HELD (no cluster). The plan/PR state this explicitly; no "real-time verified" claim beyond the unit tests + the manual recipe.

## Out of scope / follow-ups (later slices)

- Other admin dashboards (OR Board, Audit, Anesthesia, Attendance) — most need a NEW backend channel + producer; each is its own follow-on slice reusing `useRealtimeInvalidation`.
- The Flutter clinical boards (Patient Command Board, vitals, doctor queue) — the user's separate next epic family; their `RealtimeClient` is ready but they need new backend channels.
- Merge-into-cache mode (an `onEvent` escape hatch on the hook) — only if a high-frequency stream (e.g. anesthesia vitals) later proves invalidate-and-refetch too heavy.
- An e2e Playwright test once a live stack is available post-go-live.
