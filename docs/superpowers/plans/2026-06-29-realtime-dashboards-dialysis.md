# Dialysis Board Real-time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push the admin Dialysis Unit board live over WebSockets via a new `staff:dialysis-board` channel with 12 route-layer producers; the page subscribes once and invalidates the `["dialysis"]` root so all three tabs refresh on any dialysis write.

**Architecture:** Event-driven recipe (like beds/ED/OR/ICU/micro/incidents): new channel + `emitDialysisEvent` emitter + producers at the dialysis route write sites; frontend `useRealtimeInvalidation` in the tab-orchestrator page + `subscribed` threaded into the 3 polling tabs to relax their cadence (ICU slice-5 pattern). Emit carries an **explicit** `tenantId` (every handler has it in hand; tables are tenant-scoped).

**Tech Stack:** Node/Express 5 + WS fabric (Redis fan-out), Next.js 16 + TanStack Query v5, Jest (backend `--experimental-vm-modules`; admin jest+RTL).

**Branch:** `feat/realtime-dialysis-board` (already created off main). Deploy HELD — never tag.

**Parallelism:** Task 1 (backend, `apps/backend/**`) and Task 2 (frontend, `apps/admin/**`) touch disjoint dirs → run as parallel implementers. Task labels below map to those two implementers.

---

## File Structure

**Backend (Task 1):**
- Modify `apps/backend/src/utils/websocket/channelAuth.js` — add `staff:dialysis-board` catalog entry.
- Modify `apps/backend/src/utils/websocket/realtimeEmitter.js` — add `emitDialysisEvent`.
- Modify `apps/backend/src/routes/clinical/dialysisRoutes.js` — import + 12 emit sites.
- Create `apps/backend/src/tests/unit/dialysisRealtimeChannel.test.js`.
- Create `apps/backend/src/tests/unit/dialysisRealtimeEmitter.test.js`.

**Frontend (Task 2):**
- Create `apps/admin/src/app/(with-auth)/dashboard/dialysis/realtime.ts`.
- Modify `apps/admin/src/app/(with-auth)/dashboard/dialysis/page.tsx` — hook + indicator + thread `subscribed`.
- Modify `apps/admin/src/app/(with-auth)/dashboard/dialysis/components/TodayBoardTab.tsx` — `subscribed` prop + cadence.
- Modify `apps/admin/src/app/(with-auth)/dashboard/dialysis/components/SessionTab.tsx` — `subscribed` prop + cadence (2 queries).
- Modify `apps/admin/src/app/(with-auth)/dashboard/dialysis/components/RosterTab.tsx` — `subscribed` prop + cadence.
- Create `apps/admin/src/app/(with-auth)/dashboard/dialysis/realtime.test.ts`.
- Create `apps/admin/src/__tests__/dashboard/dialysis/page.test.tsx`.

---

## Task 1 — Backend: channel + emitter + 12 producers (TDD)

**Files:**
- Create: `apps/backend/src/tests/unit/dialysisRealtimeChannel.test.js`
- Create: `apps/backend/src/tests/unit/dialysisRealtimeEmitter.test.js`
- Modify: `apps/backend/src/utils/websocket/channelAuth.js` (CHANNEL_CATALOG, after the `'staff:incidents'` entry)
- Modify: `apps/backend/src/utils/websocket/realtimeEmitter.js` (append after `emitIncidentEvent`)
- Modify: `apps/backend/src/routes/clinical/dialysisRoutes.js` (import + 12 sites)

Run-command reference (from `apps/backend`):
`node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit` · `npm run lint`

- [ ] **Step 1: Write the failing channel test**

Create `apps/backend/src/tests/unit/dialysisRealtimeChannel.test.js`:
```js
import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:dialysis-board channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:dialysis-board']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:dialysis-board'].roles).toBe('staff');
  });

  test('allowed for clinical + nursing staff + admin, denied for patients', () => {
    expect(authorizeChannel('staff:dialysis-board', { role: 'NURSING_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:dialysis-board', { role: 'DOCTOR', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:dialysis-board', { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:dialysis-board', { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
  });

  test('SUPER_ADMIN may subscribe (slice-9 channel bypass)', () => {
    expect(authorizeChannel('staff:dialysis-board', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js dialysisRealtimeChannel --forceExit`
Expected: FAIL — `CHANNEL_CATALOG['staff:dialysis-board']` is undefined (catalog test fails). The `authorizeChannel` allow/deny cases will already pass (prefix logic is generic) — that is fine; the catalog assertion is the red.

- [ ] **Step 3: Add the catalog entry**

In `apps/backend/src/utils/websocket/channelAuth.js`, in `CHANNEL_CATALOG`, immediately AFTER the `'staff:incidents': { … },` line, add:
```js
  'staff:dialysis-board': { description: 'Dialysis unit — session lifecycle, intra-dialysis observations, complications, vascular access, serology', roles: 'staff' },
```

- [ ] **Step 4: Run it — verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js dialysisRealtimeChannel --forceExit`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing emitter test**

Create `apps/backend/src/tests/unit/dialysisRealtimeEmitter.test.js`:
```js
import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitDialysisEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitDialysisEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:dialysis-board with the kind + explicit tenantId', () => {
    emitDialysisEvent('session-started', { tenantId: 't1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:dialysis-board',
      expect.objectContaining({ kind: 'session-started' }),
      { tenantId: 't1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitDialysisEvent('session-completed', { tenantId: 't1' })).not.toThrow();
  });
});
```

- [ ] **Step 6: Run it — verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js dialysisRealtimeEmitter --forceExit`
Expected: FAIL — `emitDialysisEvent` is not exported (`undefined`).

- [ ] **Step 7: Implement the emitter**

In `apps/backend/src/utils/websocket/realtimeEmitter.js`, append AFTER the `emitIncidentEvent` function (the last function in the file):
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
(`broadcast` + `logger` are already imported at the top of the file — confirm before adding; do NOT re-import.)

- [ ] **Step 8: Run it — verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js dialysisRealtimeEmitter --forceExit`
Expected: PASS (2 tests).

- [ ] **Step 9: Add the import to the routes file**

In `apps/backend/src/routes/clinical/dialysisRoutes.js`, after the line `import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';` (line 10), add:
```js
import { emitDialysisEvent } from '../../utils/websocket/realtimeEmitter.js';
```

- [ ] **Step 10: Wire the 12 producers**

Convert each concise-arrow handler to a block: hoist `tenantId`, capture the service row, emit, return. The emit goes after the service call, before `wrap` returns. Apply ALL 12 edits exactly:

**Site 1 — `POST /patients` (enrolPatient), currently lines 40-41:**
```js
router.post('/patients', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.enrolPatient({ tenantId, ...req.body });
  emitDialysisEvent('patient-enrolled', { tenantId });
  return row;
}));
```

**Site 2 — `PATCH /patients/:id/dry-weight` (updateDryWeight), lines 52-56:**
```js
router.patch('/patients/:id/dry-weight', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.updateDryWeight({
    tenantId, id: req.params.id,
    dry_weight_kg: req.body.dry_weight_kg,
  });
  emitDialysisEvent('dry-weight-updated', { tenantId });
  return row;
}));
```

**Site 3 — `POST /patients/:id/prescription` (prescribe), lines 59-67 (already a block — keep the isDoctor guard, hoist tenantId):**
```js
router.post('/patients/:id/prescription', requireStaffOrAdmin, wrap(async (req) => {
  if (!isDoctor(req.user?.role) && !isAdmin(req.user?.role)) {
    throw AppError.forbidden('Only doctors/admin prescribe dialysis');
  }
  const tenantId = tenantOf(req);
  const row = await svc.prescribe({
    tenantId, dialysis_patient_id: req.params.id,
    prescribed_by: req.user?.uid, ...req.body,
  });
  emitDialysisEvent('prescription-created', { tenantId });
  return row;
}));
```

**Site 4 — `POST /patients/:id/access` (addAccess), lines 73-78:**
```js
router.post('/patients/:id/access', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.addAccess({
    tenantId,
    dialysis_patient_id: req.params.id,
    ...req.body,
  });
  emitDialysisEvent('access-created', { tenantId });
  return row;
}));
```

**Site 5 — `POST /access/:id/abandon` (abandonAccess), lines 80-85:**
```js
router.post('/access/:id/abandon', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.abandonAccess({
    tenantId,
    id: req.params.id,
    reason: req.body.reason,
  });
  emitDialysisEvent('access-abandoned', { tenantId });
  return row;
}));
```

**Site 6 — `POST /sessions` (scheduleSession), lines 88-91:**
```js
router.post('/sessions', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.scheduleSession({
    tenantId, conducted_by: req.user?.uid, ...req.body,
  });
  emitDialysisEvent('session-scheduled', { tenantId });
  return row;
}));
```

**Site 7 — `POST /sessions/:id/start` (startSession), lines 104-107:**
```js
router.post('/sessions/:id/start', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.startSession({
    tenantId, id: req.params.id, ...req.body,
  });
  emitDialysisEvent('session-started', { tenantId });
  return row;
}));
```

**Site 8 — `POST /sessions/:id/complete` (completeSession), lines 109-112:**
```js
router.post('/sessions/:id/complete', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.completeSession({
    tenantId, id: req.params.id, ...req.body,
  });
  emitDialysisEvent('session-completed', { tenantId });
  return row;
}));
```

**Site 9 — `POST /sessions/:id/cancel` (cancelSession), lines 114-118:**
```js
router.post('/sessions/:id/cancel', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.cancelSession({
    tenantId, id: req.params.id,
    reason: req.body.reason, mark_no_show: req.body.mark_no_show,
  });
  emitDialysisEvent('session-cancelled', { tenantId });
  return row;
}));
```

**Site 10 — `POST /sessions/:id/obs` (logObservation), lines 121-124:**
```js
router.post('/sessions/:id/obs', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.logObservation({
    tenantId, session_id: req.params.id, recorded_by: req.user?.uid, ...req.body,
  });
  emitDialysisEvent('observation-logged', { tenantId });
  return row;
}));
```

**Site 11 — `POST /sessions/:id/events` (recordSessionEvent), lines 130-134:**
```js
router.post('/sessions/:id/events', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.recordSessionEvent({
    tenantId, session_id: req.params.id,
    recorded_by: req.user?.uid, actorRole: req.user?.role, ...req.body,
  });
  emitDialysisEvent('session-event-recorded', { tenantId });
  return row;
}));
```

**Site 12 — `POST /patients/:id/serology` (recordSerology), lines 152-155:**
```js
router.post('/patients/:id/serology', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.recordSerology({
    tenantId, dialysis_patient_id: req.params.id, reported_by: req.user?.uid, ...req.body,
  });
  emitDialysisEvent('serology-recorded', { tenantId });
  return row;
}));
```

Do **NOT** touch the GET handlers or `POST /machines/ingest`.

- [ ] **Step 11: Lint + regression**

Run: `npm run lint` → 0 errors.
Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js dialysisRealtimeChannel dialysisRealtimeEmitter --forceExit` → 5 pass.
Run the existing dialysis UNIT test as a regression guard (route emits must not change responses):
`node --experimental-vm-modules node_modules/jest/bin/jest.js "unit/dialysis.test" --forceExit` → unchanged from baseline (all green, or the same pre-existing pass count). If `dialysis-depth.deep.test.js` runs (Postgres :5433 up), it must also stay green; if the DB is down it will skip/fail to connect — note that, don't treat a DB-connection failure as a code regression.

- [ ] **Step 12: Commit**

```bash
git add apps/backend/src/utils/websocket/channelAuth.js \
        apps/backend/src/utils/websocket/realtimeEmitter.js \
        apps/backend/src/routes/clinical/dialysisRoutes.js \
        apps/backend/src/tests/unit/dialysisRealtimeChannel.test.js \
        apps/backend/src/tests/unit/dialysisRealtimeEmitter.test.js
git commit -m "feat(realtime): add staff:dialysis-board channel + emitDialysisEvent + 12 producers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2 — Frontend: realtime.ts + page wiring + 3-tab cadence + tests (TDD)

**Files:**
- Create: `apps/admin/src/app/(with-auth)/dashboard/dialysis/realtime.ts`
- Create: `apps/admin/src/app/(with-auth)/dashboard/dialysis/realtime.test.ts`
- Modify: `apps/admin/src/app/(with-auth)/dashboard/dialysis/page.tsx`
- Modify: `apps/admin/.../dialysis/components/TodayBoardTab.tsx`
- Modify: `apps/admin/.../dialysis/components/SessionTab.tsx`
- Modify: `apps/admin/.../dialysis/components/RosterTab.tsx`
- Create: `apps/admin/src/__tests__/dashboard/dialysis/page.test.tsx`

Run-command reference (from `apps/admin`): `npm test -- <pattern>` · `npm run type-check` · `npm run lint`

- [ ] **Step 1: Write the failing cadence test**

Create `apps/admin/src/app/(with-auth)/dashboard/dialysis/realtime.test.ts`:
```ts
import { dialysisRefetchMs, DIALYSIS_LIVE_POLL_MS, DIALYSIS_CHANNEL } from "./realtime";

describe("dialysisRefetchMs", () => {
  it("relaxes to the live poll when subscribed", () => {
    expect(dialysisRefetchMs(true, 30_000)).toBe(DIALYSIS_LIVE_POLL_MS);
    expect(dialysisRefetchMs(true, 60_000)).toBe(DIALYSIS_LIVE_POLL_MS);
  });
  it("keeps the base cadence when not subscribed", () => {
    expect(dialysisRefetchMs(false, 30_000)).toBe(30_000);
    expect(dialysisRefetchMs(false, 60_000)).toBe(60_000);
  });
  it("exposes the channel name", () => {
    expect(DIALYSIS_CHANNEL).toBe("staff:dialysis-board");
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- realtime.test` (from `apps/admin`)
Expected: FAIL — cannot resolve `./realtime` / exports undefined.

- [ ] **Step 3: Create `realtime.ts`**

Create `apps/admin/src/app/(with-auth)/dashboard/dialysis/realtime.ts`:
```ts
export const DIALYSIS_CHANNEL = "staff:dialysis-board";

// While the WS channel is subscribed, dialysis events push refetches; relax the
// per-tab safety polls to 2 min. When WS is down, revert to the original cadence.
export const DIALYSIS_LIVE_POLL_MS = 120_000;

export function dialysisRefetchMs(subscribed: boolean, baseMs: number): number {
  return subscribed ? DIALYSIS_LIVE_POLL_MS : baseMs;
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -- realtime.test`
Expected: PASS (3 tests).

- [ ] **Step 5: Thread cadence into TodayBoardTab**

In `apps/admin/.../dialysis/components/TodayBoardTab.tsx`:
(a) add the import near the top imports:
```ts
import { dialysisRefetchMs } from "../realtime";
```
(b) change the component signature to accept `subscribed`:
```tsx
export default function TodayBoardTab({
  onOpenSession,
  subscribed,
}: {
  onOpenSession: (id: number) => void;
  subscribed: boolean;
}) {
```
(c) change the today query's `refetchInterval: 30_000,` to:
```tsx
    refetchInterval: dialysisRefetchMs(subscribed, 30_000),
```

- [ ] **Step 6: Thread cadence into SessionTab**

In `apps/admin/.../dialysis/components/SessionTab.tsx`:
(a) add the import:
```ts
import { dialysisRefetchMs } from "../realtime";
```
(b) change the signature:
```tsx
export default function SessionTab({ sessionId, subscribed }: { sessionId: number; subscribed: boolean }) {
```
(c) change BOTH queries' `refetchInterval: 30_000,` (the `["dialysis","session",sessionId]` query and the `["dialysis","obs",sessionId]` query) to:
```tsx
    refetchInterval: dialysisRefetchMs(subscribed, 30_000),
```

- [ ] **Step 7: Thread cadence into RosterTab**

In `apps/admin/.../dialysis/components/RosterTab.tsx`:
(a) add the import:
```ts
import { dialysisRefetchMs } from "../realtime";
```
(b) change the signature:
```tsx
export default function RosterTab({ subscribed }: { subscribed: boolean }) {
```
(c) change the patients query's `refetchInterval: 60_000,` to:
```tsx
    refetchInterval: dialysisRefetchMs(subscribed, 60_000),
```
(Leave the `["dialysis","patient",selected]` detail query untouched — it has no poll.)

- [ ] **Step 8: Wire the page — hook, indicator, pass `subscribed`**

In `apps/admin/.../dialysis/page.tsx`:
(a) add imports after the existing tab imports:
```ts
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
import { DIALYSIS_CHANNEL } from "./realtime";
```
(b) inside `DialysisPage`, after `const [activeSessionId, setActiveSessionId] = useState<number | null>(null);`, add:
```tsx
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(DIALYSIS_CHANNEL, [["dialysis"]]);

  const liveLabel = subscribed ? "● Live" : connected ? "○ Connecting" : "○ Polling";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:dialysis-board — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:dialysis-board"
    : connected
      ? "Connecting…"
      : "Polling every 30–60s (real-time unavailable)";
```
(c) replace the title block:
```tsx
        <h1 className="text-3xl font-bold text-foreground">Dialysis Unit</h1>
```
with:
```tsx
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-bold text-foreground">Dialysis Unit</h1>
          <span
            data-testid="dialysis-realtime-indicator"
            role="status"
            aria-label={subscribed ? "Live — real-time dialysis updates active" : "Polling — real-time updates unavailable"}
            title={liveTitle}
            className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
          >
            {liveLabel}
          </span>
        </div>
```
(d) pass `subscribed` to all three tab renders:
```tsx
      {tab === "today" && (
        <TodayBoardTab subscribed={subscribed} onOpenSession={(id) => {
          setActiveSessionId(id);
          setTab("session");
        }} />
      )}
      {tab === "roster" && <RosterTab subscribed={subscribed} />}
      {tab === "session" && activeSessionId && (
        <SessionTab sessionId={activeSessionId} subscribed={subscribed} />
      )}
```

- [ ] **Step 9: Write the page test**

Create `apps/admin/src/__tests__/dashboard/dialysis/page.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import DialysisPage from "@/app/(with-auth)/dashboard/dialysis/page";

// Stub the three tabs so the page test never mounts real queries/WS.
jest.mock("@/app/(with-auth)/dashboard/dialysis/components/TodayBoardTab", () => ({
  __esModule: true,
  default: () => <div data-testid="today-tab" />,
}));
jest.mock("@/app/(with-auth)/dashboard/dialysis/components/RosterTab", () => ({
  __esModule: true,
  default: () => <div data-testid="roster-tab" />,
}));
jest.mock("@/app/(with-auth)/dashboard/dialysis/components/SessionTab", () => ({
  __esModule: true,
  default: () => <div data-testid="session-tab" />,
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

function renderPage(ui: ReactElement) {
  return render(ui);
}

describe("<DialysisPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
  });

  it("subscribes to staff:dialysis-board on the [\"dialysis\"] root and shows ○ Polling when down", () => {
    renderPage(<DialysisPage />);
    const ind = screen.getByTestId("dialysis-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("staff:dialysis-board", [["dialysis"]]);
  });

  it("shows ● Live when subscribed", () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderPage(<DialysisPage />);
    expect(screen.getByTestId("dialysis-realtime-indicator")).toHaveTextContent("Live");
  });
});
```

- [ ] **Step 10: Run page test + cadence test + gates**

Run: `npm test -- "dialysis/page" "dialysis/realtime"` → 5 pass (2 page + 3 cadence).
Run: `npm run type-check` → 0 errors.
Run: `npm run lint` → 0 errors.
Fix any issue (e.g. an unused `lastEventAt` — it IS used in `liveTitle`; an unused import) without changing behavior.

- [ ] **Step 11: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/dialysis/realtime.ts" \
        "apps/admin/src/app/(with-auth)/dashboard/dialysis/realtime.test.ts" \
        "apps/admin/src/app/(with-auth)/dashboard/dialysis/page.tsx" \
        "apps/admin/src/app/(with-auth)/dashboard/dialysis/components/TodayBoardTab.tsx" \
        "apps/admin/src/app/(with-auth)/dashboard/dialysis/components/SessionTab.tsx" \
        "apps/admin/src/app/(with-auth)/dashboard/dialysis/components/RosterTab.tsx" \
        "apps/admin/src/__tests__/dashboard/dialysis/page.test.tsx"
git commit -m "feat(realtime): subscribe Dialysis board to staff:dialysis-board + Live indicator + cadence relax

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3 — Whole-branch gates + review + merge (orchestrator-run, not an implementer)

- [ ] **Step 1: Full gates**
  - Backend (`apps/backend`): `npm run lint`; `node --experimental-vm-modules node_modules/jest/bin/jest.js "Channel|RealtimeEmitter|dialysis" --forceExit`.
  - Admin (`apps/admin`): `npm run lint`; `npm run type-check`; `npm test` (full); `npm run build`.
- [ ] **Step 2: Final adversarial review** (multi-lens: security/RBAC scope, regression/correctness incl. the 12 emit sites + setTenantTx post-commit + tab cadence, pattern-consistency vs micro/ICU). Verify any real findings before merge.
- [ ] **Step 3: Finish the branch** — `git checkout main`; `git merge --no-ff feat/realtime-dialysis-board`; push `github main` + `origin main`; delete the branch. **Deploy HELD — do NOT tag.**
- [ ] **Step 4: Update memory** — slice 10 block in `project_vh_health_realtime_dashboards.md` + MEMORY.md index line (9→10) + advance scout backlog to "next: blood-bank (needs RQ migration first)".

---

## Self-Review (against the spec)

**1. Spec coverage:** §4.1 channel → T1 S3; §4.2 emitter → T1 S7; §4.3 12 producers → T1 S10 (all 12 enumerated); §5.1 realtime.ts → T2 S3; §5.2 page wiring+indicator → T2 S8; §5.3 tab cadence → T2 S5-7; §6 tenancy → explicit `tenantId` passed at every site (T1 S10) + asserted in emitter test (T1 S5); §7 tests → T1 S1/S5, T2 S1/S9 + regression T1 S11; §8 risks → addressed (channel==route predicate, post-commit emit, optional→required prop with mocked tabs); §9 manual → Task 3 review. No gaps.

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; all 12 sites written out verbatim (not "similar to site N").

**3. Type consistency:** `dialysisRefetchMs(subscribed: boolean, baseMs: number)` used identically in realtime.ts, all 3 tabs, and the cadence test. `DIALYSIS_CHANNEL = "staff:dialysis-board"` consistent across realtime.ts, page hook call, channel catalog, emitter, and both tests. Tab prop `subscribed: boolean` required, page passes it to all 3. Hook return `{ connected, subscribed, denied, lastEventAt }` matches the real `useRealtimeInvalidation` signature and the page destructure. Emit `kind` strings unique per site and PHI-free.
