# OR Board Real-time (Slice 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the admin OR Board from a 60s poll to event-driven real-time via a new `staff:or-board` WebSocket channel, emitting at the 3 case-lifecycle write sites; the board subscribes and invalidates its react-query key.

**Architecture:** Backend adds a `staff:or-board` channel + an `emitOrBoardEvent` emitter called (best-effort, post-mutation) at the schedule/status/cancel handlers in `theatreRoutes.js`. Frontend subscribes with the existing `useRealtimeInvalidation` hook (invalidating `[["theatre","board"]]`), plus a dynamic poll fallback (120s live / 60s down) and a `●Live/○Polling` indicator. Mirrors the ED slice; staff-scoped per the `THEATRE_ROUTE_ROLES` route audience.

**Tech Stack:** Node/Express 5 + raw WS fabric (`utils/websocket/`), Next.js 16 + React 19 + TanStack Query v5, Jest (backend ESM via `--experimental-vm-modules`; admin via RTL).

**Spec:** `docs/superpowers/specs/2026-06-28-realtime-dashboards-or-board-design.md`
**Branch:** `feat/realtime-or-board` (already created off `main`).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `apps/backend/src/utils/websocket/channelAuth.js` | Channel catalog | Modify: +1 entry |
| `apps/backend/src/utils/websocket/realtimeEmitter.js` | Domain emitters | Modify: +`emitOrBoardEvent` |
| `apps/backend/src/routes/theatre/theatreRoutes.js` | OT route handlers | Modify: import + 3 emit calls |
| `apps/backend/src/tests/unit/orBoardChannel.test.js` | Channel RBAC | Create |
| `apps/backend/src/tests/unit/orBoardEmitter.test.js` | Emitter (mocks wsServer) | Create |
| `apps/admin/src/app/(with-auth)/dashboard/or-board/realtime.ts` | Poll cadence | Create |
| `apps/admin/src/app/(with-auth)/dashboard/or-board/page.tsx` | OR Board page | Modify: hook + cadence + indicator |
| `apps/admin/src/__tests__/dashboard/or-board/realtime.test.ts` | Cadence test | Create |
| `apps/admin/src/__tests__/dashboard/or-board/page.test.tsx` | Page test | Create |

**Run-command reference**
- Backend single test (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit`
- Admin single test (from `apps/admin`): `npm test -- <pattern>`
- Admin gates (from `apps/admin`): `npm run type-check` · `npm run lint` · `npm test` · `npm run build`
- Backend lint (from `apps/backend`): `npm run lint`

---

## Task 1: Backend — `staff:or-board` channel (catalog + RBAC)

**Files:** Create `apps/backend/src/tests/unit/orBoardChannel.test.js`; Modify `apps/backend/src/utils/websocket/channelAuth.js`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/tests/unit/orBoardChannel.test.js`:

```js
import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:or-board channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:or-board']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:or-board'].roles).toBe('staff');
  });

  test('is allowed for theatre staff + admins and denied for patients', () => {
    expect(authorizeChannel('staff:or-board', { role: 'NURSING_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:or-board', { role: 'DOCTOR', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:or-board', { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:or-board', { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js orBoardChannel --forceExit`
Expected: FAIL — catalog test fails (`CHANNEL_CATALOG['staff:or-board']` undefined); the RBAC test already passes via the `staff:` prefix rule.

- [ ] **Step 3: Add the catalog entry**

In `apps/backend/src/utils/websocket/channelAuth.js`, inside `CHANNEL_CATALOG`, add right after the `'staff:appointments'` line:

```js
  'staff:or-board':           { description: 'OR board — surgical case schedule/status/cancellation changes', roles: 'staff' },
```

- [ ] **Step 4: Run to verify it passes**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js orBoardChannel --forceExit`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/utils/websocket/channelAuth.js apps/backend/src/tests/unit/orBoardChannel.test.js
git commit -m "feat(realtime): register staff:or-board channel"
```

---

## Task 2: Backend — `emitOrBoardEvent` emitter

**Files:** Create `apps/backend/src/tests/unit/orBoardEmitter.test.js`; Modify `apps/backend/src/utils/websocket/realtimeEmitter.js`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/tests/unit/orBoardEmitter.test.js`:

```js
import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitOrBoardEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitOrBoardEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:or-board with kind, scheduleId, status, and tenantId', () => {
    emitOrBoardEvent('status-changed', { scheduleId: 42, status: 'in_progress', tenantId: 't-1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:or-board',
      expect.objectContaining({ kind: 'status-changed', scheduleId: 42, status: 'in_progress' }),
      { tenantId: 't-1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitOrBoardEvent('cancelled', { scheduleId: 1, status: 'cancelled' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js orBoardEmitter --forceExit`
Expected: FAIL — `emitOrBoardEvent` not exported.

- [ ] **Step 3: Add the emitter**

In `apps/backend/src/utils/websocket/realtimeEmitter.js`, add after the `emitDailyOps` function:

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

- [ ] **Step 4: Run to verify it passes**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js orBoardEmitter --forceExit`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/utils/websocket/realtimeEmitter.js apps/backend/src/tests/unit/orBoardEmitter.test.js
git commit -m "feat(realtime): add emitOrBoardEvent emitter"
```

---

## Task 3: Backend — wire producers into the 3 lifecycle handlers

**Files:** Modify `apps/backend/src/routes/theatre/theatreRoutes.js`.

> **Test note:** the emit logic is unit-tested in Task 2. The handler→emit wiring is verified by `lint` + the or-board unit tests (matches the slice-1/2 precedent for route wiring; mounting the theatre router needs auth/DB scaffolding).

- [ ] **Step 1: Add the import**

In `apps/backend/src/routes/theatre/theatreRoutes.js`, after the line `import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';`, add:

```js
import { emitOrBoardEvent } from '../../utils/websocket/realtimeEmitter.js';
```

- [ ] **Step 2: Emit on schedule**

In the `POST /schedule` handler, after `const schedule = await theatreService.scheduleSurgery(scheduleData);` and before `return success(res, schedule, 'Surgery scheduled successfully', 201);`, add:

```js
    emitOrBoardEvent('scheduled', { scheduleId: schedule?.id, status: schedule?.status, tenantId: tenantOf(req) });
```

- [ ] **Step 3: Emit on status change**

In the `PUT /:id/status` handler, after `const result = await theatreService.updateStatus(...);` (the multi-line call ending `});`) and before `return success(res, result, 'Surgery status updated successfully');`, add:

```js
    emitOrBoardEvent('status-changed', { scheduleId: result?.id, status: result?.status, tenantId: tenantOf(req) });
```

- [ ] **Step 4: Emit on cancel**

In the `DELETE /:id` handler, after `const result = await theatreService.cancelSurgery(parseInt(id, 10), req.user?.uid, { tenantId: tenantOf(req) });` and before `return success(res, result, 'Surgery cancelled successfully');`, add:

```js
    emitOrBoardEvent('cancelled', { scheduleId: Number(id), status: 'cancelled', tenantId: tenantOf(req) });
```

Do NOT add an emit to any other handler (today/availability/checklist) — only those 3.

- [ ] **Step 5: Verify**

Run (from `apps/backend`): `npm run lint` → expect PASS.
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js orBoardChannel orBoardEmitter --forceExit` → expect PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/theatre/theatreRoutes.js
git commit -m "feat(realtime): emit staff:or-board on OT schedule/status/cancel"
```

---

## Task 4: Frontend — `orRefetchMs` cadence helper

**Files:** Create `apps/admin/src/app/(with-auth)/dashboard/or-board/realtime.ts`; Create `apps/admin/src/__tests__/dashboard/or-board/realtime.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/__tests__/dashboard/or-board/realtime.test.ts`:

```ts
import { orRefetchMs } from "@/app/(with-auth)/dashboard/or-board/realtime";

describe("orRefetchMs", () => {
  it("uses a 2-min safety poll while subscribed", () => {
    expect(orRefetchMs(true)).toBe(120_000);
  });
  it("falls back to the 60s poll when not subscribed", () => {
    expect(orRefetchMs(false)).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/admin`): `npm test -- or-board/realtime`
Expected: FAIL — cannot resolve module `.../or-board/realtime`.

- [ ] **Step 3: Write the helper**

Create `apps/admin/src/app/(with-auth)/dashboard/or-board/realtime.ts`:

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

- [ ] **Step 4: Run to verify it passes**

Run (from `apps/admin`): `npm test -- or-board/realtime`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/or-board/realtime.ts" "apps/admin/src/__tests__/dashboard/or-board/realtime.test.ts"
git commit -m "feat(realtime): add OR Board poll-cadence helper"
```

---

## Task 5: Frontend — wire hook + cadence + indicator into the page

**Files:** Create `apps/admin/src/__tests__/dashboard/or-board/page.test.tsx`; Modify `apps/admin/src/app/(with-auth)/dashboard/or-board/page.tsx`.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/__tests__/dashboard/or-board/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import OrBoardPage from "@/app/(with-auth)/dashboard/or-board/page";
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
jest.mock("@/hooks/useRealtimeInvalidation", () => ({
  useRealtimeInvalidation: (...args: unknown[]) => mockRealtime(...args),
}));

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<OrBoardPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
    mockedFetchAdminAPI.mockImplementation(async (endpoint) => {
      if (String(endpoint).startsWith("/theatre/board")) {
        return { date: "2026-06-28", ot_room: null, cases: [] } as never;
      }
      return [] as never; // /theatre/rooms
    });
  });

  it("subscribes to staff:or-board and shows ○ Polling when not live", async () => {
    renderWithQuery(<OrBoardPage />);
    const ind = await screen.findByTestId("or-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("staff:or-board", [["theatre", "board"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<OrBoardPage />);
    const ind = await screen.findByTestId("or-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/admin`): `npm test -- or-board/page`
Expected: FAIL — no `or-realtime-indicator`, hook not called with `staff:or-board`.

- [ ] **Step 3: Add imports**

In `apps/admin/src/app/(with-auth)/dashboard/or-board/page.tsx`, after `import { EmptyState } from "@/components/EmptyState";`, add:

```tsx
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
import { orRefetchMs, OR_FALLBACK_POLL_MS } from "./realtime";
```

- [ ] **Step 4: Call the hook**

In `OrBoardPage`, immediately after `const [room, setRoom] = useState<string>("");`, add:

```tsx
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation("staff:or-board", [["theatre", "board"]]);
```

- [ ] **Step 5: Make the board poll cadence dynamic**

In the board `useQuery` (the one with `queryKey: ["theatre", "board", { date, room }]`), replace `refetchInterval: 60_000,` with:

```tsx
    refetchInterval: orRefetchMs(subscribed),
```

(Leave the `["theatre","rooms"]` query untouched.)

- [ ] **Step 6: Compute the indicator labels**

Immediately before the `return (` of `OrBoardPage` (after the `totals` `useMemo`), add:

```tsx
  const liveLabel = subscribed ? "● Live" : "○ Polling";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:or-board — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:or-board"
    : connected
      ? "Connecting…"
      : `Polling every ${OR_FALLBACK_POLL_MS / 1000}s (real-time unavailable)`;
```

- [ ] **Step 7: Render the indicator in the header**

Replace this block (the left `<div>` inside the header flex row):

```tsx
        <div>
          <h1 className="text-3xl font-bold text-foreground">OR Board</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Today&apos;s surgical cases with checklist + WHO safety phase
            status. Auto-refreshes every 60s.
          </p>
        </div>
```

with:

```tsx
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold text-foreground">OR Board</h1>
            <span
              data-testid="or-realtime-indicator"
              role="status"
              aria-label={
                subscribed
                  ? "Live — real-time OR board updates active"
                  : "Polling — real-time updates unavailable"
              }
              title={liveTitle}
              className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
            >
              {liveLabel}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Today&apos;s surgical cases with checklist + WHO safety phase status. Live via WebSocket; falls
            back to polling if unavailable.
          </p>
        </div>
```

- [ ] **Step 8: Run test + type-check + lint**

Run (from `apps/admin`): `npm test -- or-board/page` → expect PASS (both tests).
Run (from `apps/admin`): `npm run type-check` → 0 errors. `npm run lint` → 0 errors.

- [ ] **Step 9: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/or-board/page.tsx" "apps/admin/src/__tests__/dashboard/or-board/page.test.tsx"
git commit -m "feat(realtime): subscribe OR Board to staff:or-board with live indicator"
```

---

## Task 6: Full verification gates

**Files:** none (verification only).

- [ ] **Step 1: Backend gates**

Run (from `apps/backend`): `npm run lint` → PASS.
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js orBoardChannel orBoardEmitter --forceExit` → PASS (4 tests).

- [ ] **Step 2: Admin gates**

Run (from `apps/admin`): `npm run type-check` → 0 errors.
Run (from `apps/admin`): `npm run lint` → 0 errors. *(The page test's `_args` carries an `eslint-disable-next-line` — keep it.)*
Run (from `apps/admin`): `npm test` → full suite PASS (includes the 2 new or-board test files).
Run (from `apps/admin`): `npm run build` → PASS.

- [ ] **Step 3: Manual live-WS verification (optional, deploy HELD → local)**

Per spec §10: run backend + admin dev, open the OR Board (`●Live`), trigger `PUT /theatre/:id/status` from a second client, confirm the board repaints within ~1s without waiting for the poll; kill the WS → `○Polling` + the 60s poll resumes. Record in the PR notes (not an automated gate).

---

## After the plan: finish the branch

Follow `superpowers:finishing-a-development-branch` + the standing workflow: request review, then `merge --no-ff` into `main`, push **both** remotes (GitHub + Forgejo), delete the branch. **Deploy stays HELD** — do not tag.

## Spec-coverage check (self-review)

- Channel (spec §4.1) → Task 1. Emitter (§4.2) → Task 2. Producers, 3 lifecycle sites (§4.3) → Task 3. Cadence helper (§5.1) → Task 4. Page wiring + indicator (§5.2) → Task 5. Tenant scoping (§6) → Task 3 (explicit `{ tenantId: tenantOf(req) }`). Tests (§8) → Tasks 1,2,4,5. Gates + manual (§10) → Task 6. Out-of-scope (checklist/WHO-phase/complications producers, staff Flutter screen) — no task, as intended.
