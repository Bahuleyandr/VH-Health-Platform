# ED Tracking Board Real-time (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the admin ED Tracking Board from a 30s poll to event-driven real-time via a new `admin:ed-board` WebSocket channel, reusing the slice-1 beds pattern.

**Architecture:** Backend adds an `admin:ed-board` channel + an `emitEdBoardEvent` emitter called (best-effort, post-mutation, inside the request) at the 3 ED board-mutating route handlers. Frontend subscribes with the existing `useRealtimeInvalidation` hook, invalidating `[["ed"]]` so react-query refetches; a dynamic poll fallback (120s live / 30s down) and a `●Live/○Polling` indicator make it a strict improvement.

**Tech Stack:** Node/Express 5 + raw WS fabric (`utils/websocket/`), Next.js 16 + React 19 + TanStack Query v5, Jest (backend ESM via `--experimental-vm-modules`; admin via RTL).

**Spec:** `docs/superpowers/specs/2026-06-27-realtime-dashboards-ed-tracker-design.md`

**Branch:** `feat/realtime-ed-tracker` (already created off `main`).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `apps/backend/src/utils/websocket/channelAuth.js` | Channel catalog (discovery) | Modify: +1 entry |
| `apps/backend/src/utils/websocket/realtimeEmitter.js` | Domain WS emitters | Modify: +`emitEdBoardEvent` |
| `apps/backend/src/routes/admin/edRoutes.js` | ED admin route handlers | Modify: import + 3 emit calls |
| `apps/backend/src/tests/unit/edBoardChannel.test.js` | Channel catalog + RBAC contract | Create |
| `apps/backend/src/tests/unit/edRealtimeEmitter.test.js` | Emitter unit test | Create |
| `apps/admin/src/app/(with-auth)/dashboard/ed-tracker/realtime.ts` | ED poll cadence helper | Create |
| `apps/admin/src/app/(with-auth)/dashboard/ed-tracker/page.tsx` | ED board page | Modify: hook + cadence + indicator |
| `apps/admin/src/__tests__/dashboard/ed-tracker/realtime.test.ts` | Cadence helper test | Create |
| `apps/admin/src/__tests__/dashboard/ed-tracker/page.test.tsx` | Page hook/indicator test | Create |

**Run-command reference**
- Backend single test (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit`
- Admin single test (from `apps/admin`): `npm test -- <pattern>`
- Admin gates (from `apps/admin`): `npm run type-check` · `npm run lint` · `npm test` · `npm run build`
- Backend gates (from `apps/backend`): `npm run lint` · `node --experimental-vm-modules node_modules/jest/bin/jest.js --forceExit`

---

## Task 1: Backend — `admin:ed-board` channel (catalog + RBAC contract)

**Files:**
- Create: `apps/backend/src/tests/unit/edBoardChannel.test.js`
- Modify: `apps/backend/src/utils/websocket/channelAuth.js` (CHANNEL_CATALOG)

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/tests/unit/edBoardChannel.test.js`:

```js
import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('admin:ed-board channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['admin:ed-board']).toBeDefined();
    expect(CHANNEL_CATALOG['admin:ed-board'].roles).toBe('admin');
  });

  test('is allowed for admins and denied for non-admins', () => {
    expect(authorizeChannel('admin:ed-board', { role: 'ADMIN', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('admin:ed-board', { role: 'PATIENT', userId: '2' }).allowed).toBe(false);
    expect(authorizeChannel('admin:ed-board', { role: 'NURSING_STAFF', userId: '3' }).allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js edBoardChannel --forceExit`
Expected: FAIL — the catalog test fails (`CHANNEL_CATALOG['admin:ed-board']` is `undefined`). (The RBAC test already passes because `authorizeChannel` prefix-matches `admin:`.)

- [ ] **Step 3: Add the catalog entry**

In `apps/backend/src/utils/websocket/channelAuth.js`, inside `CHANNEL_CATALOG`, add after the `'admin:kpi'` line:

```js
  'admin:ed-board':           { description: 'ED tracking board — visit arrivals, transitions, triage priority', roles: 'admin' },
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js edBoardChannel --forceExit`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/utils/websocket/channelAuth.js apps/backend/src/tests/unit/edBoardChannel.test.js
git commit -m "feat(realtime): register admin:ed-board channel"
```

---

## Task 2: Backend — `emitEdBoardEvent` emitter

**Files:**
- Create: `apps/backend/src/tests/unit/edRealtimeEmitter.test.js`
- Modify: `apps/backend/src/utils/websocket/realtimeEmitter.js` (add `emitEdBoardEvent`)

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/tests/unit/edRealtimeEmitter.test.js` (ESM module mock — backend runs Jest under `--experimental-vm-modules`):

```js
import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitEdBoardEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitEdBoardEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on admin:ed-board with kind, visit fields, and tenantId', () => {
    emitEdBoardEvent(
      'transition',
      { id: 7, visit_number: 'ED-007', status: 'in_treatment', triage_priority: 'esi_2', disposition: null },
      { tenantId: 't-1' },
    );

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'admin:ed-board',
      expect.objectContaining({
        kind: 'transition',
        id: 7,
        visitNumber: 'ED-007',
        status: 'in_treatment',
        triagePriority: 'esi_2',
        disposition: null,
      }),
      { tenantId: 't-1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitEdBoardEvent('arrival', { id: 1 }, {})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js edRealtimeEmitter --forceExit`
Expected: FAIL — `emitEdBoardEvent` is not exported (import is `undefined`, call throws).

- [ ] **Step 3: Add the emitter**

In `apps/backend/src/utils/websocket/realtimeEmitter.js`, add after `emitBedEvent` (mirrors it; internal try/catch so it never throws into the caller):

```js
/** ED tracking-board change (arrival / transition / triage-priority). */
export function emitEdBoardEvent(kind, visit, { tenantId } = {}) {
  try {
    broadcast('admin:ed-board', {
      kind,
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

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js edRealtimeEmitter --forceExit`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/utils/websocket/realtimeEmitter.js apps/backend/src/tests/unit/edRealtimeEmitter.test.js
git commit -m "feat(realtime): add emitEdBoardEvent emitter"
```

---

## Task 3: Backend — wire producers into the 3 ED route handlers

**Files:**
- Modify: `apps/backend/src/routes/admin/edRoutes.js`

> **Test note (honest, matches slice 1):** the emit *logic* is unit-tested in Task 2. The handler→emit *wiring* is not unit-tested here — mounting an ESM router with mocked service+emitter is heavyweight, and slice-1 beds verified emit-from-handler manually only. Wiring correctness is enforced by `lint`/`build` + the manual WS check in Task 6.

- [ ] **Step 1: Add the import**

In `apps/backend/src/routes/admin/edRoutes.js`, after the `import { success } ...` line (line 8), add:

```js
import { emitEdBoardEvent } from '../../utils/websocket/realtimeEmitter.js';
```

- [ ] **Step 2: Emit on visit creation**

In the `POST /visits` handler, after `const row = await createEmergencyVisit({ ... });` and before `return success(res, row, 'Emergency visit created', 201);`, add:

```js
    emitEdBoardEvent('arrival', row, { tenantId: req.tenantId });
```

- [ ] **Step 3: Emit on transition**

In the `PATCH /visits/:id/transition` handler, after `const row = await transitionEmergencyVisit({ ... });` and before `return success(res, row, 'Emergency visit transitioned');`, add:

```js
    emitEdBoardEvent('transition', row, { tenantId: req.tenantId });
```

- [ ] **Step 4: Emit on triage-priority change**

In the `PATCH /visits/:id/triage-priority` handler, after `const row = await setVisitTriagePriority({ ... });` and before `return success(res, row, 'Triage priority set');`, add:

```js
    emitEdBoardEvent('priority', row, { tenantId: req.tenantId });
```

- [ ] **Step 5: Verify lint + the existing backend suite still pass**

Run (from `apps/backend`): `npm run lint`
Expected: PASS (no errors).
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js edBoardChannel edRealtimeEmitter --forceExit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/admin/edRoutes.js
git commit -m "feat(realtime): emit admin:ed-board on ED visit writes"
```

---

## Task 4: Frontend — `edRefetchMs` cadence helper

**Files:**
- Create: `apps/admin/src/app/(with-auth)/dashboard/ed-tracker/realtime.ts`
- Create: `apps/admin/src/__tests__/dashboard/ed-tracker/realtime.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/__tests__/dashboard/ed-tracker/realtime.test.ts`:

```ts
import { edRefetchMs } from "@/app/(with-auth)/dashboard/ed-tracker/realtime";

describe("edRefetchMs", () => {
  it("uses a 2-min safety poll while subscribed", () => {
    expect(edRefetchMs(true)).toBe(120_000);
  });
  it("falls back to the 30s poll when not subscribed", () => {
    expect(edRefetchMs(false)).toBe(30_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/admin`): `npm test -- ed-tracker/realtime`
Expected: FAIL — cannot resolve module `.../ed-tracker/realtime`.

- [ ] **Step 3: Write the helper**

Create `apps/admin/src/app/(with-auth)/dashboard/ed-tracker/realtime.ts`:

```ts
// Poll cadence for the ED board. When the admin:ed-board subscription is live, a
// 2-min safety poll backstops the at-most-once WS bus; if WS drops/denies, we
// revert to the original 30s poll so behaviour is never worse than before.
export const ED_LIVE_POLL_MS = 120_000;
export const ED_FALLBACK_POLL_MS = 30_000;

export function edRefetchMs(subscribed: boolean): number {
  return subscribed ? ED_LIVE_POLL_MS : ED_FALLBACK_POLL_MS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/admin`): `npm test -- ed-tracker/realtime`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/ed-tracker/realtime.ts" "apps/admin/src/__tests__/dashboard/ed-tracker/realtime.test.ts"
git commit -m "feat(realtime): add ED board poll-cadence helper"
```

---

## Task 5: Frontend — wire hook + cadence + `●Live` indicator into the page

**Files:**
- Create: `apps/admin/src/__tests__/dashboard/ed-tracker/page.test.tsx`
- Modify: `apps/admin/src/app/(with-auth)/dashboard/ed-tracker/page.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/__tests__/dashboard/ed-tracker/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import EdTrackerPage from "@/app/(with-auth)/dashboard/ed-tracker/page";
import { fetchAdminAPI } from "@/lib/api";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn(),
}));

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
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<EdTrackerPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
    mockedFetchAdminAPI.mockImplementation(async () => {
      return [
        {
          id: 1, visit_number: "ED-001", patient_uid: null,
          arrival_at: "2026-06-27T10:00:00.000Z", arrival_mode: "walk_in",
          chief_complaint: "Chest pain", attending_doctor_uid: null,
          triage_priority: "esi_2", status: "in_triage",
          bed_assigned_id: null, disposition: null,
          triage_started_at: null, treatment_started_at: null,
          disposition_at: null, is_mlc: false,
        },
      ] as never;
    });
  });

  it("subscribes to admin:ed-board and shows ○ Polling when not live", async () => {
    renderWithQuery(<EdTrackerPage />);
    const ind = await screen.findByTestId("ed-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("admin:ed-board", [["ed"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<EdTrackerPage />);
    const ind = await screen.findByTestId("ed-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/admin`): `npm test -- ed-tracker/page`
Expected: FAIL — no element with `data-testid="ed-realtime-indicator"`, and the hook is not yet called with `admin:ed-board`.

- [ ] **Step 3: Add the two imports**

In `apps/admin/src/app/(with-auth)/dashboard/ed-tracker/page.tsx`, after `import { EmptyState } from "@/components/EmptyState";` (line 14), add:

```tsx
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
import { edRefetchMs } from "./realtime";
```

- [ ] **Step 4: Call the hook**

In `EdTrackerPage`, immediately after `const [showRegister, setShowRegister] = useState(false);`, add:

```tsx
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation("admin:ed-board", [["ed"]]);
```

- [ ] **Step 5: Make the poll cadence dynamic**

In the `useQuery<EdVisit[]>` for `["ed", "visits", "active"]`, replace:

```tsx
    refetchInterval: 30_000,
```

with:

```tsx
    refetchInterval: edRefetchMs(subscribed),
```

- [ ] **Step 6: Compute the indicator labels**

Immediately before the `return (` of `EdTrackerPage` (after the `byStatus` and `errMsg` consts), add:

```tsx
  const liveLabel = subscribed ? "● Live" : "○ Polling";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via admin:ed-board — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via admin:ed-board"
    : connected
      ? "Connecting…"
      : "Polling every 30s (real-time unavailable)";
```

- [ ] **Step 7: Render the indicator in the header**

Replace this header block (currently lines ~208-215):

```tsx
        <div>
          <h1 className="text-3xl font-bold text-foreground">
            ED Tracking Board
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live emergency department flow. Auto-refreshes every 30s.
          </p>
        </div>
```

with:

```tsx
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold text-foreground">
              ED Tracking Board
            </h1>
            <span
              data-testid="ed-realtime-indicator"
              role="status"
              aria-label={
                subscribed
                  ? "Live — real-time ED updates active"
                  : "Polling — real-time updates unavailable"
              }
              title={liveTitle}
              className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
            >
              {liveLabel}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Live emergency department flow. Real-time via WebSocket; falls back to
            polling if unavailable.
          </p>
        </div>
```

- [ ] **Step 8: Run test to verify it passes**

Run (from `apps/admin`): `npm test -- ed-tracker/page`
Expected: PASS (both tests).

- [ ] **Step 9: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/ed-tracker/page.tsx" "apps/admin/src/__tests__/dashboard/ed-tracker/page.test.tsx"
git commit -m "feat(realtime): subscribe ED board to admin:ed-board with live indicator"
```

---

## Task 6: Full verification gates

**Files:** none (verification only).

- [ ] **Step 1: Backend gates**

Run (from `apps/backend`): `npm run lint`
Expected: PASS.
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js --forceExit`
Expected: PASS (full suite, incl. the 2 new ED tests).

- [ ] **Step 2: Admin gates**

Run (from `apps/admin`): `npm run type-check`
Expected: PASS (0 errors).
Run (from `apps/admin`): `npm run lint`
Expected: PASS (0 errors). *Note: admin eslint flags underscore-prefixed unused params; the `_args` in the test mock already carries an `eslint-disable-next-line` comment — keep it.*
Run (from `apps/admin`): `npm test`
Expected: PASS (full suite, incl. the 2 new ED test files).
Run (from `apps/admin`): `npm run build`
Expected: PASS (next build succeeds).

- [ ] **Step 3: Manual live-WS verification (optional, deploy HELD → local)**

Per the spec §10: run backend (`npm run dev`) + admin (`npm run dev`), open the ED board (`●Live`), trigger `PATCH /admin/ed/visits/:id/transition` from a second client, confirm the board repaints within ~1s without waiting for the poll; kill the WS and confirm `○Polling` + 30s poll resumes. Record the result in the PR/commit notes (not an automated gate).

---

## After the plan: finish the branch

Once all tasks are green, follow `superpowers:finishing-a-development-branch` and the standing workflow: request code review (`superpowers:requesting-code-review`), then `merge --no-ff` into `main`, push to **both** remotes (GitHub + Forgejo), and delete the branch. **Deploy stays HELD** — do not tag.

## Spec-coverage check (self-review)

- Channel (spec §4.1) → Task 1. Emitter (§4.2) → Task 2. Tenant scoping (§4.3) → Task 2 (`{ tenantId }` arg) + Task 3 (passes `req.tenantId`). Producers (§4.4) → Task 3. Cadence helper (§5.1) → Task 4. Page wiring + indicator (§5.2) → Task 5. Tests (§7) → Tasks 1,2,4,5 (+ honest no-wiring-test note in Task 3, matching §7's limitation). Resilience (§8) → Task 2 (try/catch test). Gates + manual (§10) → Task 6. `recordTriageAssessment` excluded (§2/§4.4) — not a producer task. Staff variant excluded (§2) — no task. `openOnly` mismatch (§9) — explicitly out of scope, no task.
