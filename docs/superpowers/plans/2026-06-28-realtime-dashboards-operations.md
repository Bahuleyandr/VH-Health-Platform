# Operations Snapshot Real-time (Slice 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push the admin Daily Operations Snapshot in real time via a new `admin:daily-ops` channel fed by a per-tenant cron that broadcasts the computed snapshot; clients render the pushed data via a new reusable `useRealtimeData` hook.

**Architecture:** A 60s per-tenant cron (`tickDailyOps` via `runForEachTenant`) computes `getDailyOpsSnapshot` once per tenant and broadcasts it on `admin:daily-ops` (best-effort, tenant-scoped). The frontend's new `useRealtimeData(channel, queryKey)` hook `setQueryData`s each pushed snapshot onto the existing `useQuery`, which still handles initial load + a slow fallback poll. Broadcast and REST share one source function, so payloads can't drift.

**Tech Stack:** Node/Express 5 + WS fabric (`utils/websocket/`) + node-cron scheduler, Next.js 16 + React 19 + TanStack Query v5, Jest (backend ESM via `--experimental-vm-modules`; admin via RTL).

**Spec:** `docs/superpowers/specs/2026-06-28-realtime-dashboards-operations-design.md`
**Branch:** `feat/realtime-operations` (already created off `main`).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `apps/backend/src/utils/websocket/channelAuth.js` | Channel catalog | Modify: +1 entry |
| `apps/backend/src/utils/websocket/realtimeEmitter.js` | Domain emitters | Modify: +`emitDailyOps` |
| `apps/backend/src/utils/dailyOpsBroadcaster.js` | Per-tenant cron producer | Create |
| `apps/backend/src/utils/scheduler.js` | Cron registration | Modify: import + cron + initial tick |
| `apps/backend/src/tests/unit/dailyOpsChannel.test.js` | Channel RBAC | Create |
| `apps/backend/src/tests/unit/dailyOpsEmitter.test.js` | `emitDailyOps` (mocks wsServer) | Create |
| `apps/backend/src/tests/unit/dailyOpsBroadcaster.test.js` | `tickDailyOps` (mocks fanout/snapshot/emitter) | Create |
| `apps/admin/src/hooks/useRealtimeData.ts` | Snapshot→react-query hook | Create |
| `apps/admin/src/app/(with-auth)/dashboard/operations/realtime.ts` | Poll cadence | Create |
| `apps/admin/src/app/(with-auth)/dashboard/operations/page.tsx` | Operations page | Modify: hook + cadence + indicator |
| `apps/admin/src/__tests__/hooks/useRealtimeData.test.tsx` | Hook test | Create |
| `apps/admin/src/__tests__/dashboard/operations/realtime.test.ts` | Cadence test | Create |
| `apps/admin/src/__tests__/dashboard/operations/page.test.tsx` | Page test | Create |

**Run-command reference**
- Backend single test (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit`
- Admin single test (from `apps/admin`): `npm test -- <pattern>`
- Admin gates (from `apps/admin`): `npm run type-check` · `npm run lint` · `npm test` · `npm run build`
- Backend lint (from `apps/backend`): `npm run lint`

---

## Task 1: Backend — `admin:daily-ops` channel (catalog + RBAC)

**Files:** Create `apps/backend/src/tests/unit/dailyOpsChannel.test.js`; Modify `apps/backend/src/utils/websocket/channelAuth.js`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/tests/unit/dailyOpsChannel.test.js`:

```js
import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('admin:daily-ops channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['admin:daily-ops']).toBeDefined();
    expect(CHANNEL_CATALOG['admin:daily-ops'].roles).toBe('admin');
  });

  test('is allowed for admins and denied for non-admins', () => {
    expect(authorizeChannel('admin:daily-ops', { role: 'ADMIN', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('admin:daily-ops', { role: 'PATIENT', userId: '2' }).allowed).toBe(false);
    expect(authorizeChannel('admin:daily-ops', { role: 'NURSING_STAFF', userId: '3' }).allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js dailyOpsChannel --forceExit`
Expected: FAIL — catalog test fails (`CHANNEL_CATALOG['admin:daily-ops']` is `undefined`); the RBAC test already passes via the `admin:` prefix rule.

- [ ] **Step 3: Add the catalog entry**

In `apps/backend/src/utils/websocket/channelAuth.js`, inside `CHANNEL_CATALOG`, add right after the `'admin:kpi'` line:

```js
  'admin:daily-ops':          { description: 'Daily operations snapshot — OPD/IP/OR/collections/claims headline numbers', roles: 'admin' },
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js dailyOpsChannel --forceExit`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/utils/websocket/channelAuth.js apps/backend/src/tests/unit/dailyOpsChannel.test.js
git commit -m "feat(realtime): register admin:daily-ops channel"
```

---

## Task 2: Backend — `emitDailyOps` emitter

**Files:** Create `apps/backend/src/tests/unit/dailyOpsEmitter.test.js`; Modify `apps/backend/src/utils/websocket/realtimeEmitter.js`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/tests/unit/dailyOpsEmitter.test.js`:

```js
import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitDailyOps } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitDailyOps', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts the snapshot on admin:daily-ops with tenantId', () => {
    const snap = { d: '2026-06-28', opd_today: 12, ip_in_house: 7, collections_today: '34500' };
    emitDailyOps(snap, { tenantId: 't-1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('admin:daily-ops', snap, { tenantId: 't-1' });
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitDailyOps({ d: 'x' }, {})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js dailyOpsEmitter --forceExit`
Expected: FAIL — `emitDailyOps` is not exported.

- [ ] **Step 3: Add the emitter**

In `apps/backend/src/utils/websocket/realtimeEmitter.js`, add after the `emitAdminKpi` function:

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

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js dailyOpsEmitter --forceExit`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/utils/websocket/realtimeEmitter.js apps/backend/src/tests/unit/dailyOpsEmitter.test.js
git commit -m "feat(realtime): add emitDailyOps emitter"
```

---

## Task 3: Backend — `tickDailyOps` per-tenant producer

**Files:** Create `apps/backend/src/utils/dailyOpsBroadcaster.js`; Create `apps/backend/src/tests/unit/dailyOpsBroadcaster.test.js`.

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/tests/unit/dailyOpsBroadcaster.test.js` (a SEPARATE file from the emitter test — keeping the `realtimeEmitter` mock out of the same module as the emitter test that imports it for real). The mock specifiers resolve to the same absolute files the broadcaster imports:

```js
import { jest } from '@jest/globals';

const runForEachTenant = jest.fn(async (_label, fn) => { await fn('t-1'); await fn('t-2'); });
const getDailyOpsSnapshot = jest.fn(async ({ tenantId }) => ({ d: '2026-06-28', tenantId, opd_today: 1 }));
const emitDailyOpsMock = jest.fn();
jest.unstable_mockModule('../../utils/tenantFanout.js', () => ({ runForEachTenant }));
jest.unstable_mockModule('../../services/dashboards/snapshotService.js', () => ({ getDailyOpsSnapshot }));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({ emitDailyOps: emitDailyOpsMock }));

const { tickDailyOps } = await import('../../utils/dailyOpsBroadcaster.js');

describe('tickDailyOps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDailyOpsSnapshot.mockImplementation(async ({ tenantId }) => ({ d: '2026-06-28', tenantId, opd_today: 1 }));
  });

  test('computes and emits a snapshot per tenant', async () => {
    await tickDailyOps();
    expect(getDailyOpsSnapshot).toHaveBeenCalledWith({ tenantId: 't-1' });
    expect(getDailyOpsSnapshot).toHaveBeenCalledWith({ tenantId: 't-2' });
    expect(emitDailyOpsMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-1' }), { tenantId: 't-1' });
    expect(emitDailyOpsMock).toHaveBeenCalledTimes(2);
  });

  test('skips emit when a tenant snapshot is null', async () => {
    getDailyOpsSnapshot.mockResolvedValueOnce(null); // t-1 → null
    await tickDailyOps();
    expect(emitDailyOpsMock).toHaveBeenCalledTimes(1); // only t-2
  });

  test('isolates a per-tenant failure so other tenants still emit', async () => {
    getDailyOpsSnapshot.mockRejectedValueOnce(new Error('boom')); // t-1 throws
    await expect(tickDailyOps()).resolves.not.toThrow();
    expect(emitDailyOpsMock).toHaveBeenCalledTimes(1); // t-2 still emits
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js dailyOpsBroadcaster --forceExit`
Expected: FAIL — cannot import `tickDailyOps` from `../../utils/dailyOpsBroadcaster.js` (module doesn't exist yet).

- [ ] **Step 3: Create the producer**

Create `apps/backend/src/utils/dailyOpsBroadcaster.js`:

```js
// src/utils/dailyOpsBroadcaster.js
//
// Per-tenant cron producer for the Daily Operations Snapshot. Mirrors
// kpiAggregator.js, but fans out per active tenant (the snapshot is
// strictly tenant-scoped) and broadcasts the computed snapshot on the
// admin:daily-ops channel so subscribers render without refetching.

import logger from '../logging/logger.js';
import { getDailyOpsSnapshot } from '../services/dashboards/snapshotService.js';
import { emitDailyOps } from './websocket/realtimeEmitter.js';
import { runForEachTenant } from './tenantFanout.js';

/** Compute the daily-ops snapshot for each active tenant and broadcast it. */
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

- [ ] **Step 4: Run to verify all pass**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js dailyOpsBroadcaster --forceExit`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/utils/dailyOpsBroadcaster.js apps/backend/src/tests/unit/dailyOpsBroadcaster.test.js
git commit -m "feat(realtime): add per-tenant tickDailyOps producer"
```

---

## Task 4: Backend — register the cron in the scheduler

**Files:** Modify `apps/backend/src/utils/scheduler.js`.

> **Test note:** the producer logic is unit-tested in Task 3. This task is scheduler wiring (registration), verified by `lint` + the Task 3 unit tests — no new automated test (matches the slice-1/2 precedent for cron/route wiring).

- [ ] **Step 1: Add the import**

In `apps/backend/src/utils/scheduler.js`, immediately after the line `import { tickAdminKpi } from './kpiAggregator.js';`, add:

```js
import { tickDailyOps } from './dailyOpsBroadcaster.js';
```

- [ ] **Step 2: Register the cron**

Find the line `registerCron('*/30 * * * * *', withJobLock('admin-kpi-tick', tickAdminKpi));` and add immediately after it:

```js
  // Every 60s — daily-ops snapshot push (per-tenant). withJobLock = one runner across processes.
  registerCron('0 * * * * *', withJobLock('daily-ops-tick', tickDailyOps));
```

- [ ] **Step 3: Add the initial tick**

Find the line `try { await tickAdminKpi(); } catch (e) { logger.warn('Initial admin:kpi tick failed:', e.message); }` and add immediately after it:

```js
    try { await tickDailyOps(); } catch (e) { logger.warn('Initial daily-ops tick failed:', e.message); }
```

- [ ] **Step 4: Verify lint + the producer tests**

Run (from `apps/backend`): `npm run lint`
Expected: PASS.
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js dailyOps --forceExit`
Expected: PASS (7 tests: 2 channel + 2 emitter + 3 tick).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/utils/scheduler.js
git commit -m "feat(realtime): schedule the per-tenant daily-ops tick"
```

---

## Task 5: Frontend — `useRealtimeData` hook

**Files:** Create `apps/admin/src/hooks/useRealtimeData.ts`; Create `apps/admin/src/__tests__/hooks/useRealtimeData.test.tsx`.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/__tests__/hooks/useRealtimeData.test.tsx`:

```tsx
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useRealtimeData } from "@/hooks/useRealtimeData";
import { useRealtimeChannel } from "@/hooks/useRealtimeChannel";

jest.mock("@/hooks/useRealtimeChannel", () => ({ useRealtimeChannel: jest.fn() }));
const mockedChannel = useRealtimeChannel as jest.MockedFunction<typeof useRealtimeChannel>;

describe("useRealtimeData", () => {
  it("writes the latest message payload into the query cache", () => {
    const qc = new QueryClient();
    const setSpy = jest.spyOn(qc, "setQueryData");
    mockedChannel.mockReturnValue({
      lastMessage: { channel: "admin:daily-ops", data: { opd_today: 9 }, receivedAt: 123 },
      connected: true,
      subscribed: true,
      denied: null,
      latencyMs: null,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    renderHook(() => useRealtimeData("admin:daily-ops", ["dashboards", "daily-ops"]), { wrapper });
    expect(setSpy).toHaveBeenCalledWith(["dashboards", "daily-ops"], { opd_today: 9 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/admin`): `npm test -- useRealtimeData`
Expected: FAIL — cannot resolve module `@/hooks/useRealtimeData`.

- [ ] **Step 3: Write the hook**

Create `apps/admin/src/hooks/useRealtimeData.ts`:

```ts
"use client";

// Snapshot sibling of useRealtimeInvalidation: for channels that broadcast a full
// snapshot (e.g. a cron-fed dashboard payload), push each incoming message straight
// into react-query via setQueryData. Reads `lastMessage` (latest-wins, which is
// exactly the semantics a snapshot wants). The consuming useQuery still owns the
// initial load and the fallback poll.

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useRealtimeChannel } from "./useRealtimeChannel";

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

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/admin`): `npm test -- useRealtimeData`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/hooks/useRealtimeData.ts apps/admin/src/__tests__/hooks/useRealtimeData.test.tsx
git commit -m "feat(realtime): add useRealtimeData snapshot hook"
```

---

## Task 6: Frontend — `opsRefetchMs` cadence helper

**Files:** Create `apps/admin/src/app/(with-auth)/dashboard/operations/realtime.ts`; Create `apps/admin/src/__tests__/dashboard/operations/realtime.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/__tests__/dashboard/operations/realtime.test.ts`:

```ts
import { opsRefetchMs } from "@/app/(with-auth)/dashboard/operations/realtime";

describe("opsRefetchMs", () => {
  it("uses a 5-min safety poll while subscribed", () => {
    expect(opsRefetchMs(true)).toBe(300_000);
  });
  it("falls back to the 60s poll when not subscribed", () => {
    expect(opsRefetchMs(false)).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/admin`): `npm test -- operations/realtime`
Expected: FAIL — cannot resolve module `.../operations/realtime`.

- [ ] **Step 3: Write the helper**

Create `apps/admin/src/app/(with-auth)/dashboard/operations/realtime.ts`:

```ts
// Poll cadence for the Operations snapshot. The WS push keeps it fresh, so while subscribed we drop to a
// 5-min safety poll; if the socket drops, revert to the original 60s so behaviour is never worse than before.
export const OPS_LIVE_POLL_MS = 300_000;
export const OPS_FALLBACK_POLL_MS = 60_000;

export function opsRefetchMs(subscribed: boolean): number {
  return subscribed ? OPS_LIVE_POLL_MS : OPS_FALLBACK_POLL_MS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/admin`): `npm test -- operations/realtime`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/operations/realtime.ts" "apps/admin/src/__tests__/dashboard/operations/realtime.test.ts"
git commit -m "feat(realtime): add Operations poll-cadence helper"
```

---

## Task 7: Frontend — wire hook + cadence + indicator into the page

**Files:** Create `apps/admin/src/__tests__/dashboard/operations/page.test.tsx`; Modify `apps/admin/src/app/(with-auth)/dashboard/operations/page.tsx`.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/__tests__/dashboard/operations/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import OperationsPage from "@/app/(with-auth)/dashboard/operations/page";
import { fetchAdminAPI } from "@/lib/api";

jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn() }));

const mockRealtime = jest.fn(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (..._args: unknown[]) => ({
    connected: false,
    subscribed: false,
    denied: null as string | null,
    lastEventAt: null as number | null,
  }),
);
jest.mock("@/hooks/useRealtimeData", () => ({
  useRealtimeData: (...args: unknown[]) => mockRealtime(...args),
}));

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<OperationsPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
    mockedFetchAdminAPI.mockImplementation(async () => ({
      d: "2026-06-28", opd_today: 12, opd_completed_today: 8, ip_in_house: 7,
      or_cases_today: 3, open_critical_alerts: 0, collections_today: "34500",
      preauth_pending: 2, claims_outstanding: 4,
    } as never));
  });

  it("subscribes to admin:daily-ops and shows ○ Polling when not live", async () => {
    renderWithQuery(<OperationsPage />);
    const ind = await screen.findByTestId("ops-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("admin:daily-ops", ["dashboards", "daily-ops"]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<OperationsPage />);
    const ind = await screen.findByTestId("ops-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/admin`): `npm test -- operations/page`
Expected: FAIL — no `data-testid="ops-realtime-indicator"`, hook not called with `admin:daily-ops`.

- [ ] **Step 3: Add imports**

In `apps/admin/src/app/(with-auth)/dashboard/operations/page.tsx`, after `import { LoadingSpinner } from "@/components/LoadingSpinner";`, add:

```tsx
import { useRealtimeData } from "@/hooks/useRealtimeData";
import { opsRefetchMs, OPS_FALLBACK_POLL_MS } from "./realtime";
```

- [ ] **Step 4: Call the hook**

In `OperationsPage`, as the first line inside the function body (before the `const { data: snapshot, … } = useQuery(...)`), add:

```tsx
  const { connected, subscribed, lastEventAt } = useRealtimeData<DailyOpsSnapshot>(
    "admin:daily-ops",
    ["dashboards", "daily-ops"],
  );
```

- [ ] **Step 5: Make the poll cadence dynamic**

In the `useQuery` options, replace `refetchInterval: 60_000,` with:

```tsx
    refetchInterval: opsRefetchMs(subscribed),
```

- [ ] **Step 6: Compute the indicator labels**

Immediately before the `return (` of `OperationsPage`, add:

```tsx
  const liveLabel = subscribed ? "● Live" : "○ Polling";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via admin:daily-ops — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via admin:daily-ops"
    : connected
      ? "Connecting…"
      : `Polling every ${OPS_FALLBACK_POLL_MS / 1000}s (real-time unavailable)`;
```

- [ ] **Step 7: Render the indicator in the header**

Replace this block (the left `<div>` inside the header flex row):

```tsx
        <div>
          <h1 className="text-3xl font-bold text-foreground">Daily Operations Snapshot</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Morning-huddle headline numbers. Auto-refreshes every 60s.
          </p>
        </div>
```

with:

```tsx
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold text-foreground">Daily Operations Snapshot</h1>
            <span
              data-testid="ops-realtime-indicator"
              role="status"
              aria-label={
                subscribed
                  ? "Live — real-time operations updates active"
                  : "Polling — real-time updates unavailable"
              }
              title={liveTitle}
              className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
            >
              {liveLabel}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Morning-huddle headline numbers. Live via WebSocket; falls back to polling if unavailable.
          </p>
        </div>
```

- [ ] **Step 8: Run test + type-check + lint**

Run (from `apps/admin`): `npm test -- operations/page`
Expected: PASS (both tests).
Run (from `apps/admin`): `npm run type-check` → 0 errors. `npm run lint` → 0 errors.

- [ ] **Step 9: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/operations/page.tsx" "apps/admin/src/__tests__/dashboard/operations/page.test.tsx"
git commit -m "feat(realtime): push Operations snapshot via admin:daily-ops with live indicator"
```

---

## Task 8: Full verification gates

**Files:** none (verification only).

- [ ] **Step 1: Backend gates**

Run (from `apps/backend`): `npm run lint` → PASS.
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js dailyOps --forceExit` → PASS (7 tests).

- [ ] **Step 2: Admin gates**

Run (from `apps/admin`): `npm run type-check` → 0 errors.
Run (from `apps/admin`): `npm run lint` → 0 errors. *(The page test's `_args` carries an `eslint-disable-next-line` — keep it; admin eslint doesn't honor `^_` for unused params.)*
Run (from `apps/admin`): `npm test` → full suite PASS (includes the 3 new test files).
Run (from `apps/admin`): `npm run build` → PASS.

- [ ] **Step 3: Manual live-WS verification (optional, deploy HELD → local)**

Per spec §10: run backend (`npm run dev`) + admin (`npm run dev`), open the Operations page, confirm `●Live` and that the numbers + "Updated" timestamp refresh on the ~60s server tick without the page polling; kill the WS → `○Polling` and the 60s poll resumes. Record in the PR notes (not an automated gate).

---

## After the plan: finish the branch

Follow `superpowers:finishing-a-development-branch` + the standing workflow: request review (`superpowers:requesting-code-review`), then `merge --no-ff` into `main`, push **both** remotes (GitHub + Forgejo), delete the branch. **Deploy stays HELD** — do not tag.

## Spec-coverage check (self-review)

- Channel (spec §4.1) → Task 1. Emitter (§4.2) → Task 2. Producer/`tickDailyOps` (§4.3) → Task 3. Scheduler cron + initial tick (§4.4) → Task 4. `useRealtimeData` hook (§5.1) → Task 5. Cadence helper (§5.2) → Task 6. Page wiring + indicator (§5.3) → Task 7. Tenant scoping (§6) → Task 3 (`runForEachTenant` + explicit `{tenantId}`). Tests (§8) → Tasks 1,2,3,5,6,7. Gates + manual (§10) → Task 8. Out-of-scope items (other `/snapshot/*`, `admin:kpi` rework) — no task, as intended.
