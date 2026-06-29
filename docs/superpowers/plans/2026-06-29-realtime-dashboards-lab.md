# Lab Critical-Value Board (Slice 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the admin Lab page (pathologist worklist + critical alerts tabs) to event-driven real-time via a new `staff:lab` channel with producers at the lab service write sites; the page subscribes and invalidates both tab keys. The worklist gains real-time it never had.

**Architecture:** Reuse the event-driven recipe (beds/ED/OR/ICU). Producers are in the **service layer** (`labResultsService.js`): `detectCriticalsForResults` is the universal post-insert chokepoint all 3 ingestion paths call, so emitting `result-pending`+`alert-fired` there covers everything; `signOffResults`/`acknowledgeAlert` emit too. Emits are best-effort (`emitLabEvent` never throws).

**Tech Stack:** Node/Express 5 + PostgreSQL 17 (raw SQL), Next.js 16 + TanStack Query v5, Jest.

**Spec:** `docs/superpowers/specs/2026-06-29-realtime-dashboards-lab-design.md`
**Branch:** `feat/realtime-lab-board` (already created off `main`).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `apps/backend/src/utils/websocket/channelAuth.js` | Channel catalog | Modify: +1 entry |
| `apps/backend/src/utils/websocket/realtimeEmitter.js` | WS emitters | Modify: +`emitLabEvent` |
| `apps/backend/src/services/lab/labResultsService.js` | Lab producers | Modify: import + 3 emit sites |
| `apps/backend/src/tests/unit/labRealtimeChannel.test.js` | Channel RBAC test | Create |
| `apps/backend/src/tests/unit/labRealtimeEmitter.test.js` | Emitter test | Create |
| `apps/admin/src/app/(with-auth)/dashboard/lab/realtime.ts` | Channel const + cadence | Create |
| `apps/admin/src/app/(with-auth)/dashboard/lab/page.tsx` | Lab tab page | Modify: hook + indicator + `subscribed` |
| `apps/admin/src/__tests__/dashboard/lab/realtime.test.ts` | Cadence test | Create |
| `apps/admin/src/__tests__/dashboard/lab/page.test.tsx` | Page-wiring test | Create |

**Run-command reference**
- Backend (from `apps/backend`): `npm run lint` · `node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit`
- Admin (from `apps/admin`): `npm test -- <pattern>` · `npm run type-check` · `npm run lint` · `npm run build`

---

## Task 1: Backend — channel + emitter (TDD)

**Files:** Modify `channelAuth.js`, `realtimeEmitter.js`; Create `labRealtimeChannel.test.js`, `labRealtimeEmitter.test.js`.

- [ ] **Step 1: Write the channel test**

Create `apps/backend/src/tests/unit/labRealtimeChannel.test.js`:

```js
import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:lab channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:lab']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:lab'].roles).toBe('staff');
  });

  test('is allowed for lab staff + admins and denied for patients', () => {
    expect(authorizeChannel('staff:lab', { role: 'NURSING_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:lab', { role: 'PATHOLOGIST', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:lab', { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:lab', { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, confirm it FAILS**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js labRealtimeChannel --forceExit`
Expected: FAIL — `CHANNEL_CATALOG['staff:lab']` is undefined.

- [ ] **Step 3: Add the catalog entry**

In `apps/backend/src/utils/websocket/channelAuth.js`, in `CHANNEL_CATALOG`, immediately after the `'staff:icu-board'` entry, add:

```js
  'staff:lab': { description: 'Lab — critical-value alerts + pathologist sign-off worklist', roles: 'staff' },
```

- [ ] **Step 4: Run it, confirm it PASSES**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js labRealtimeChannel --forceExit`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the emitter test**

Create `apps/backend/src/tests/unit/labRealtimeEmitter.test.js`:

```js
import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitLabEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitLabEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:lab with kind + tenantId', () => {
    emitLabEvent('alert-fired', { tenantId: 't-1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:lab',
      expect.objectContaining({ kind: 'alert-fired' }),
      { tenantId: 't-1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitLabEvent('result-pending', { tenantId: 't-2' })).not.toThrow();
  });
});
```

- [ ] **Step 6: Run it, confirm it FAILS**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js labRealtimeEmitter --forceExit`
Expected: FAIL — `emitLabEvent` is not exported.

- [ ] **Step 7: Add the emitter**

In `apps/backend/src/utils/websocket/realtimeEmitter.js`, immediately after the `emitIcuBoardEvent` function, add:

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

(`broadcast` + `logger` are already imported in that file.)

- [ ] **Step 8: Run both, confirm PASS**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js labRealtimeChannel labRealtimeEmitter --forceExit`
Expected: PASS (4 tests).

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/utils/websocket/channelAuth.js apps/backend/src/utils/websocket/realtimeEmitter.js apps/backend/src/tests/unit/labRealtimeChannel.test.js apps/backend/src/tests/unit/labRealtimeEmitter.test.js
git commit -m "feat(realtime): add staff:lab channel + emitLabEvent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Backend — 3 producers in `labResultsService.js`

**Files:** Modify `apps/backend/src/services/lab/labResultsService.js`.

> Service-layer emits (precedent: `vitalSignMonitor` emits). All best-effort, post-write, with `tenantId` already in scope. Read each function before editing to anchor precisely.

- [ ] **Step 1: Add the import**

In `apps/backend/src/services/lab/labResultsService.js`, after the import `import { enqueueCriticalResultTask } from '../results/resultsInboxService.js';`, add:

```js
import { emitLabEvent } from '../../utils/websocket/realtimeEmitter.js';
```

- [ ] **Step 2: Emit in `detectCriticalsForResults`**

In `detectCriticalsForResults`, the function ends with the `for` loop closing then `  return alerts;`. Immediately BEFORE the final `return alerts;`, insert:

```js
  if (results.length) emitLabEvent('result-pending', { tenantId });
  if (alerts.length) emitLabEvent('alert-fired', { tenantId });
```

(`return alerts;` is unique to this function — `recordResultManual` returns `{ result, alerts }`, `ingestOruMessage` returns `{ results, alerts, … }`.)

- [ ] **Step 3: Emit in `signOffResults`**

In `signOffResults`, immediately AFTER the `UPDATE lab_results … SET signed_off_at = NOW()` statement — i.e. after the line:
```js
    String(signed_off_by), decision, ids, tenantId,
  );
```
(the one that closes the `prisma.$executeRawUnsafe` stamping `signed_off_at`) — insert:

```js
  emitLabEvent('result-signed', { tenantId });
```

- [ ] **Step 4: Emit in `acknowledgeAlert`**

In `acknowledgeAlert`, after the existing `await emitCriticalLabAlertAcknowledged({ … });` call (the block that ends `  });`) and immediately BEFORE `  return rows[0];`, insert:

```js
  emitLabEvent('alert-acked', { tenantId });
```

- [ ] **Step 5: Verify — lint + new tests + lab-unit regression gate**

Run (from `apps/backend`): `npm run lint` → PASS.
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js labRealtimeChannel labRealtimeEmitter labResultsService labResultsServiceResultsInbox labClosedLoopSecurity cdsEngineCoverage --forceExit`
Expected: PASS (the 2 new + the existing lab unit tests). The emit is best-effort (`broadcast` no-ops without WS clients; `emitLabEvent` swallows), so the existing tests should pass UNMODIFIED.
**If any existing test FAILS because of the new emit** (e.g. a `broadcast`/`wsServer` import side-effect), add this near the top of the breaking test file (before its dynamic `import` of `labResultsService.js`), then re-run:
```js
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitLabEvent: jest.fn(),
  emitVitalAnomaly: jest.fn(),
  emitCodeBlue: jest.fn(),
}));
```
(Match the file's existing mock style; include whichever emitters that file's code path touches.)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/services/lab/labResultsService.js
git commit -m "feat(realtime): emit staff:lab on result-pending/alert-fired/result-signed/alert-acked

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
(If you had to add a realtimeEmitter mock to an existing test, `git add` that file too and mention it in the commit body.)

---

## Task 3: Frontend — cadence helper (TDD)

**Files:** Create `apps/admin/src/app/(with-auth)/dashboard/lab/realtime.ts` + `apps/admin/src/__tests__/dashboard/lab/realtime.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/__tests__/dashboard/lab/realtime.test.ts`:

```ts
import { labRefetchMs, LAB_LIVE_POLL_MS } from "@/app/(with-auth)/dashboard/lab/realtime";

describe("labRefetchMs", () => {
  it("relaxes the alerts poll to the 2-min live cadence while subscribed", () => {
    expect(labRefetchMs(true, 60_000)).toBe(120_000);
    expect(labRefetchMs(true, 60_000)).toBe(LAB_LIVE_POLL_MS);
  });
  it("keeps the original 60s cadence when not subscribed", () => {
    expect(labRefetchMs(false, 60_000)).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run it, confirm it FAILS**

Run (from `apps/admin`): `npm test -- lab/realtime`
Expected: FAIL — cannot resolve `.../lab/realtime`.

- [ ] **Step 3: Create the helper**

Create `apps/admin/src/app/(with-auth)/dashboard/lab/realtime.ts`:

```ts
export const LAB_CHANNEL = "staff:lab";

// The pathologist worklist had NO poll (push-only now); the critical-alerts tab polled 60s. While
// subscribed we relax the alerts poll to a 2-min safety net (push makes it instant), reverting to 60s
// when WS is down so behaviour is never worse than before.
export const LAB_LIVE_POLL_MS = 120_000;

export function labRefetchMs(subscribed: boolean, baseMs: number): number {
  return subscribed ? LAB_LIVE_POLL_MS : baseMs;
}
```

- [ ] **Step 4: Run it, confirm it PASSES**

Run (from `apps/admin`): `npm test -- lab/realtime`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/lab/realtime.ts" "apps/admin/src/__tests__/dashboard/lab/realtime.test.ts"
git commit -m "feat(realtime): lab board channel const + relaxed live-poll cadence helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Frontend — page wiring + indicator + page test

**Files:** Modify `apps/admin/src/app/(with-auth)/dashboard/lab/page.tsx`; Create `apps/admin/src/__tests__/dashboard/lab/page.test.tsx`.

- [ ] **Step 1: Wire `CriticalAlerts` to the cadence helper**

In `lab/page.tsx`, add to the imports (top of file, after the existing imports):
```ts
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
import { LAB_CHANNEL, labRefetchMs } from "./realtime";
```

Change the `CriticalAlerts` component signature and its query's `refetchInterval`:
- Signature: `function CriticalAlerts() {` → `function CriticalAlerts({ subscribed }: { subscribed: boolean }) {`
- In its `useQuery`, change `refetchInterval: 60_000,` → `refetchInterval: labRefetchMs(subscribed, 60_000),`

(Leave `PathologistWorklist` unchanged — it has no `refetchInterval`; it gains real-time via the page-level invalidation.)

- [ ] **Step 2: Wire `LabPage` (the orchestrator)**

Replace the `LabPage` component:
```tsx
export default function LabPage() {
  const [tab, setTab] = useState<Tab>("worklist");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-foreground mb-6">Laboratory</h1>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6 w-fit">
```
with:
```tsx
export default function LabPage() {
  const [tab, setTab] = useState<Tab>("worklist");
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(LAB_CHANNEL, [
    ["lab", "pathologist"],
    ["lab", "alerts"],
  ]);

  const liveLabel = subscribed ? "● Live" : "○ Polling";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:lab — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:lab"
    : connected
      ? "Connecting…"
      : "Polling (real-time unavailable)";

  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-6">
        <h1 className="text-3xl font-bold text-foreground">Laboratory</h1>
        <span
          data-testid="lab-realtime-indicator"
          role="status"
          aria-label={
            subscribed
              ? "Live — real-time lab updates active"
              : "Polling — real-time updates unavailable"
          }
          title={liveTitle}
          className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
        >
          {liveLabel}
        </span>
      </div>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6 w-fit">
```

Then change the alerts-tab render at the bottom of `LabPage`:
```tsx
      {tab === "alerts" && <CriticalAlerts />}
```
to:
```tsx
      {tab === "alerts" && <CriticalAlerts subscribed={subscribed} />}
```
(Leave `{tab === "worklist" && <PathologistWorklist />}` unchanged.)

- [ ] **Step 3: Create the page test**

Create `apps/admin/src/__tests__/dashboard/lab/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import LabPage from "@/app/(with-auth)/dashboard/lab/page";
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

describe("<LabPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
    mockedFetchAdminAPI.mockResolvedValue([] as never); // /lab/pathologist/pending -> []
  });

  it("subscribes to staff:lab on both tab keys and shows ○ Polling when not live", async () => {
    renderWithQuery(<LabPage />);
    const ind = await screen.findByTestId("lab-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("staff:lab", [["lab", "pathologist"], ["lab", "alerts"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<LabPage />);
    const ind = await screen.findByTestId("lab-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
```

- [ ] **Step 4: Run the lab tests + type-check + lint**

Run (from `apps/admin`): `npm test -- lab/` → PASS (realtime + page).
Run (from `apps/admin`): `npm run type-check` → 0 errors (confirms the `subscribed` prop on `CriticalAlerts`).
Run (from `apps/admin`): `npm run lint` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/lab/page.tsx" "apps/admin/src/__tests__/dashboard/lab/page.test.tsx"
git commit -m "feat(realtime): subscribe Lab board to staff:lab + Live indicator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Full verification gates

**Files:** none (verification only).

- [ ] **Step 1: Backend gates**

Run (from `apps/backend`): `npm run lint` → PASS.
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js labRealtimeChannel labRealtimeEmitter labResultsService labResultsServiceResultsInbox labClosedLoopSecurity cdsEngineCoverage --forceExit` → PASS.

- [ ] **Step 2: Admin gates**

Run (from `apps/admin`): `npm run type-check` → 0 errors.
Run (from `apps/admin`): `npm run lint` → 0 errors.
Run (from `apps/admin`): `npm test` → full suite PASS (incl. the new `lab/realtime` + `lab/page` tests).
Run (from `apps/admin`): `npm run build` → PASS.

- [ ] **Step 3: Manual live-WS verification (optional, deploy HELD → local)**

Per spec §9: open the lab board (`● Live`); from a second client `POST /lab/results` with a critical value → the worklist + alerts repaint within ~1s without the poll; acknowledge → it moves to Acknowledged live; sign off → it leaves the worklist live.

---

## After the plan: finish the branch

Follow the standing workflow: request review, then `merge --no-ff` into `main`, push **both** remotes (GitHub + Forgejo), delete the branch. **Deploy stays HELD** — do not tag.

## Spec-coverage check (self-review)

- Channel (spec §4.1) → Task 1 Steps 1-4. Emitter (§4.2) → Task 1 Steps 5-8. 3 producer sites (§4.3) → Task 2. Cadence helper (§5.1) → Task 3. Page wiring + indicator + `subscribed` prop (§5.2) → Task 4. Tests + regression gate (§7) → Tasks 1/2/3/4 + the lab-unit gate in Task 2.5/5.1. Gates + manual (§9) → Task 5. Tenant/PHI (§6) → Task 2 (explicit `tenantId`). Out-of-scope (no routePolicy/migration/labClosedLoop/data-model) — no task, as intended.
- Type consistency: `emitLabEvent(kind, { tenantId })` defined (Task 1.7) + used in the emitter test (1.5) + all 3 producers (Task 2). `labRefetchMs(subscribed, baseMs)` defined (Task 3.3) + consumed by `CriticalAlerts` (Task 4.1). `subscribed` prop required by `CriticalAlerts` (Task 4.1) + supplied by `LabPage` (Task 4.2) — type-check (Task 4.4) enforces. Channel string `"staff:lab"` (catalog/emitter/tests Task 1) ↔ `LAB_CHANNEL` (Task 3) ↔ page subscription + page test (Task 4). Query keys `[["lab","pathologist"],["lab","alerts"]]` consistent between the page hook and the page test.
