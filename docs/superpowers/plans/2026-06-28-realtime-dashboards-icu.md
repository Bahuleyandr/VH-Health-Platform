# ICU Command Centre Real-time (Slice 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the admin ICU Command Centre to event-driven real-time via a new `staff:icu-board` WS channel with producers at the 7 board-visible ICU write sites; the page subscribes once (`useRealtimeInvalidation([["icu"]])`) with a relaxed 120s live poll + a `●Live` indicator.

**Architecture:** Reuse the proven event-driven recipe (beds/ED/OR-board): CHANNEL_CATALOG entry + `emitIcuBoardEvent` emitter + best-effort post-mutation emits in `icuRoutes.js` + `useRealtimeInvalidation` on the page. Emits are PHI-free signals; react-query refetches the authoritative data through the existing RBAC-guarded routes. The emitter never throws into the clinical write.

**Tech Stack:** Node/Express 5 + WS fabric (Redis fan-out), Next.js 16 + TanStack Query v5, Jest.

**Spec:** `docs/superpowers/specs/2026-06-28-realtime-dashboards-icu-design.md`
**Branch:** `feat/realtime-icu-board` (already created off `main`).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `apps/backend/src/utils/websocket/channelAuth.js` | Channel catalog | Modify: +1 entry |
| `apps/backend/src/utils/websocket/realtimeEmitter.js` | WS emitters | Modify: +`emitIcuBoardEvent` |
| `apps/backend/src/routes/clinical/icuRoutes.js` | ICU routes | Modify: import + 7 emit calls |
| `apps/backend/src/tests/unit/icuBoardChannel.test.js` | Channel RBAC test | Create |
| `apps/backend/src/tests/unit/icuBoardEmitter.test.js` | Emitter test | Create |
| `apps/admin/src/app/(with-auth)/dashboard/icu/realtime.ts` | Channel const + cadence helper | Create |
| `apps/admin/src/app/(with-auth)/dashboard/icu/page.tsx` | Tab orchestrator | Modify: hook + indicator + pass `subscribed` |
| `apps/admin/src/app/(with-auth)/dashboard/icu/components/AdmissionsTab.tsx` | Admissions tab | Modify: `subscribed` prop + `icuRefetchMs` |
| `apps/admin/src/app/(with-auth)/dashboard/icu/components/FlowsheetTab.tsx` | Flowsheet tab | Modify: `subscribed` prop + `icuRefetchMs` |
| `apps/admin/src/app/(with-auth)/dashboard/icu/components/AssessmentsTab.tsx` | Assessments tab | Modify: `subscribed` prop + `icuRefetchMs` |
| `apps/admin/src/__tests__/dashboard/icu/realtime.test.ts` | Cadence test | Create |
| `apps/admin/src/__tests__/dashboard/icu/page.test.tsx` | Page wiring test | Create |

**Run-command reference**
- Backend (from `apps/backend`): `npm run lint` · `node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit`
- Admin (from `apps/admin`): `npm test -- <pattern>` · `npm run type-check` · `npm run lint` · `npm run build`

---

## Task 1: Backend — channel + emitter (TDD)

**Files:** Modify `channelAuth.js`, `realtimeEmitter.js`; Create `icuBoardChannel.test.js`, `icuBoardEmitter.test.js`.

- [ ] **Step 1: Write the channel test**

Create `apps/backend/src/tests/unit/icuBoardChannel.test.js`:

```js
import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:icu-board channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:icu-board']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:icu-board'].roles).toBe('staff');
  });

  test('is allowed for ICU staff + admins and denied for patients', () => {
    expect(authorizeChannel('staff:icu-board', { role: 'NURSING_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:icu-board', { role: 'DOCTOR', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:icu-board', { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:icu-board', { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, confirm it FAILS**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js icuBoardChannel --forceExit`
Expected: FAIL — `CHANNEL_CATALOG['staff:icu-board']` is undefined.

- [ ] **Step 3: Add the catalog entry**

In `apps/backend/src/utils/websocket/channelAuth.js`, in `CHANNEL_CATALOG`, immediately after the `'staff:or-board'` entry, add:

```js
  'staff:icu-board': { description: 'ICU command centre — admissions, code status, flowsheet, assessments, ABCDEF bundle', roles: 'staff' },
```

- [ ] **Step 4: Run it, confirm it PASSES**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js icuBoardChannel --forceExit`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the emitter test**

Create `apps/backend/src/tests/unit/icuBoardEmitter.test.js`:

```js
import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitIcuBoardEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitIcuBoardEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:icu-board with kind, admissionId, status, and tenantId', () => {
    emitIcuBoardEvent('code-status', { admissionId: 42, status: 'dnr', tenantId: 't-1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:icu-board',
      expect.objectContaining({ kind: 'code-status', admissionId: 42, status: 'dnr' }),
      { tenantId: 't-1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitIcuBoardEvent('flowsheet', { admissionId: 1 })).not.toThrow();
  });
});
```

- [ ] **Step 6: Run it, confirm it FAILS**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js icuBoardEmitter --forceExit`
Expected: FAIL — `emitIcuBoardEvent` is not exported.

- [ ] **Step 7: Add the emitter**

In `apps/backend/src/utils/websocket/realtimeEmitter.js`, immediately after the `emitOrBoardEvent` function, add:

```js
/** ICU command-centre change (admission / code-status / discharge / flowsheet / assessment / bundle). */
export function emitIcuBoardEvent(kind, { admissionId, status, tenantId } = {}) {
  try {
    broadcast('staff:icu-board', {
      kind,
      admissionId: admissionId ?? null,
      status: status ?? null,
      at: new Date().toISOString(),
    }, { tenantId });
  } catch (err) {
    logger.warn('emitIcuBoardEvent failed:', err.message);
  }
}
```

- [ ] **Step 8: Run it, confirm it PASSES**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js icuBoardChannel icuBoardEmitter --forceExit`
Expected: PASS (4 tests total).

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/utils/websocket/channelAuth.js apps/backend/src/utils/websocket/realtimeEmitter.js apps/backend/src/tests/unit/icuBoardChannel.test.js apps/backend/src/tests/unit/icuBoardEmitter.test.js
git commit -m "feat(realtime): add staff:icu-board channel + emitIcuBoardEvent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Backend — 7 ICU producers

**Files:** Modify `apps/backend/src/routes/clinical/icuRoutes.js`.

> These handlers use the `wrap(async (req) => icu.X(...))` form (handler returns data; `wrap` calls `success`). Convert each concise arrow to a block that captures `tenantId` once, awaits the service, emits best-effort, returns the row. The emit is inside `wrap`'s try and `emitIcuBoardEvent` never throws. No new automated test (route-handler wiring; emit logic covered by `icuBoardEmitter.test.js`) — verified by lint + the Task 1 tests.

- [ ] **Step 1: Add the import**

In `apps/backend/src/routes/clinical/icuRoutes.js`, after the import `import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';`, add:

```js
import { emitIcuBoardEvent } from '../../utils/websocket/realtimeEmitter.js';
```

- [ ] **Step 2: `POST /admissions`**

Replace:
```js
router.post('/admissions', requireStaffOrAdmin, wrap(async (req) =>
  icu.createAdmission({ tenantId: tenantOf(req), ...req.body })));
```
with:
```js
router.post('/admissions', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await icu.createAdmission({ tenantId, ...req.body });
  emitIcuBoardEvent('admitted', { admissionId: row?.id, status: row?.status, tenantId });
  return row;
}));
```

- [ ] **Step 3: `POST /admissions/from-er/:emergencyVisitId`**

Replace:
```js
router.post('/admissions/from-er/:emergencyVisitId', requireStaffOrAdmin, wrap(async (req) =>
  icu.createAdmissionFromEr({
    ...req.body,
    tenantId: tenantOf(req),
    emergencyVisitId: req.params.emergencyVisitId,
  })));
```
with:
```js
router.post('/admissions/from-er/:emergencyVisitId', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await icu.createAdmissionFromEr({
    ...req.body,
    tenantId,
    emergencyVisitId: req.params.emergencyVisitId,
  });
  emitIcuBoardEvent('admitted', { admissionId: row?.id, status: row?.status, tenantId });
  return row;
}));
```

- [ ] **Step 4: `PATCH /admissions/:id/code-status`**

Replace:
```js
router.patch('/admissions/:id/code-status', requireStaffOrAdmin, wrap(async (req) =>
  icu.updateAdmissionCodeStatus({
    tenantId: tenantOf(req), id: req.params.id,
    code_status: req.body.code_status, set_by: req.user?.uid,
  })));
```
with:
```js
router.patch('/admissions/:id/code-status', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await icu.updateAdmissionCodeStatus({
    tenantId, id: req.params.id,
    code_status: req.body.code_status, set_by: req.user?.uid,
  });
  emitIcuBoardEvent('code-status', { admissionId: Number(req.params.id), status: req.body.code_status, tenantId });
  return row;
}));
```

- [ ] **Step 5: `POST /admissions/:id/discharge`**

Replace:
```js
router.post('/admissions/:id/discharge', requireStaffOrAdmin, wrap(async (req) =>
  icu.dischargeAdmission({
    tenantId: tenantOf(req), id: req.params.id,
    disposition: req.body.disposition, outcome_notes: req.body.outcome_notes,
  })));
```
with:
```js
router.post('/admissions/:id/discharge', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await icu.dischargeAdmission({
    tenantId, id: req.params.id,
    disposition: req.body.disposition, outcome_notes: req.body.outcome_notes,
  });
  emitIcuBoardEvent('discharged', { admissionId: Number(req.params.id), status: row?.status, tenantId });
  return row;
}));
```

- [ ] **Step 6: `POST /admissions/:id/flowsheet`**

Replace:
```js
router.post('/admissions/:id/flowsheet', requireStaffOrAdmin, wrap(async (req) =>
  icu.logFlowsheet({
    tenantId: tenantOf(req),
    icu_admission_id: req.params.id,
    recorded_by: req.user?.uid,
    ...req.body,
  })));
```
with:
```js
router.post('/admissions/:id/flowsheet', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await icu.logFlowsheet({
    tenantId,
    icu_admission_id: req.params.id,
    recorded_by: req.user?.uid,
    ...req.body,
  });
  emitIcuBoardEvent('flowsheet', { admissionId: Number(req.params.id), tenantId });
  return row;
}));
```

- [ ] **Step 7: `POST /admissions/:id/assessments`**

Replace:
```js
router.post('/admissions/:id/assessments', requireStaffOrAdmin, wrap(async (req) =>
  icu.recordAssessment({
    tenantId: tenantOf(req),
    icu_admission_id: req.params.id,
    recorded_by: req.user?.uid,
    ...req.body,
  })));
```
with:
```js
router.post('/admissions/:id/assessments', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await icu.recordAssessment({
    tenantId,
    icu_admission_id: req.params.id,
    recorded_by: req.user?.uid,
    ...req.body,
  });
  emitIcuBoardEvent('assessment', { admissionId: Number(req.params.id), tenantId });
  return row;
}));
```

- [ ] **Step 8: `POST /admissions/:id/bundle`**

Replace:
```js
router.post('/admissions/:id/bundle', requireStaffOrAdmin, wrap(async (req) =>
  icu.upsertBundle({
    tenantId: tenantOf(req),
    icu_admission_id: req.params.id,
    recorded_by: req.user?.uid,
    ...req.body,
  })));
```
with:
```js
router.post('/admissions/:id/bundle', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await icu.upsertBundle({
    tenantId,
    icu_admission_id: req.params.id,
    recorded_by: req.user?.uid,
    ...req.body,
  });
  emitIcuBoardEvent('bundle', { admissionId: Number(req.params.id), tenantId });
  return row;
}));
```

Do NOT emit in `PATCH /admissions/:id/monitoring-interval`, `PATCH /admissions/:id` (fasting), or any GET handler.

- [ ] **Step 9: Verify**

Run (from `apps/backend`): `npm run lint` → PASS.
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js icuBoardChannel icuBoardEmitter --forceExit` → PASS (4 tests).

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/routes/clinical/icuRoutes.js
git commit -m "feat(realtime): emit staff:icu-board at the 7 board-visible ICU write sites

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Frontend — cadence helper (TDD)

**Files:** Create `apps/admin/src/app/(with-auth)/dashboard/icu/realtime.ts` and `apps/admin/src/__tests__/dashboard/icu/realtime.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/__tests__/dashboard/icu/realtime.test.ts`:

```ts
import { icuRefetchMs, ICU_LIVE_POLL_MS } from "@/app/(with-auth)/dashboard/icu/realtime";

describe("icuRefetchMs", () => {
  it("relaxes every polling tab to the 2-min live poll while subscribed", () => {
    expect(icuRefetchMs(true, 30_000)).toBe(120_000);
    expect(icuRefetchMs(true, 60_000)).toBe(120_000);
    expect(icuRefetchMs(true, 30_000)).toBe(ICU_LIVE_POLL_MS);
  });
  it("keeps each tab's original cadence when not subscribed", () => {
    expect(icuRefetchMs(false, 30_000)).toBe(30_000);
    expect(icuRefetchMs(false, 60_000)).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run it, confirm it FAILS**

Run (from `apps/admin`): `npm test -- icu/realtime`
Expected: FAIL — cannot resolve `.../icu/realtime`.

- [ ] **Step 3: Create the helper**

Create `apps/admin/src/app/(with-auth)/dashboard/icu/realtime.ts`:

```ts
export const ICU_BOARD_CHANNEL = "staff:icu-board";

// Poll cadence for the ICU board. Admissions / code-status / discharge / flowsheet / assessment / bundle
// changes push live; while subscribed we relax each polling tab to a 2-min safety net (vs its original
// 30/60s), reverting to the original cadence when WS is down so behaviour is never worse than before.
export const ICU_LIVE_POLL_MS = 120_000;

export function icuRefetchMs(subscribed: boolean, baseMs: number): number {
  return subscribed ? ICU_LIVE_POLL_MS : baseMs;
}
```

- [ ] **Step 4: Run it, confirm it PASSES**

Run (from `apps/admin`): `npm test -- icu/realtime`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/icu/realtime.ts" "apps/admin/src/__tests__/dashboard/icu/realtime.test.ts"
git commit -m "feat(realtime): ICU board channel const + relaxed live-poll cadence helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Frontend — thread `subscribed` into the 3 polling tabs

**Files:** Modify `AdmissionsTab.tsx`, `FlowsheetTab.tsx`, `AssessmentsTab.tsx`.

> Each polling tab accepts a `subscribed` prop and swaps its literal `refetchInterval` for `icuRefetchMs(subscribed, base)`. `BundleTab` has no poll → unchanged. (Type-check after Task 5 wires the page; these props are required so the page must pass them.)

- [ ] **Step 1: `AdmissionsTab.tsx`**

Add the import after the existing imports:
```ts
import { icuRefetchMs } from "../realtime";
```
Add `subscribed: boolean;` to the `Props` type (after `onJumpToFlowsheet`):
```ts
type Props = {
  activeAdmissionId: number | null;
  onSelect: (id: number) => void;
  onJumpToFlowsheet: (id: number) => void;
  subscribed: boolean;
};
```
Destructure it in the component signature:
```ts
export default function AdmissionsTab({
  activeAdmissionId,
  onSelect,
  onJumpToFlowsheet,
  subscribed,
}: Props) {
```
Change the admissions query's `refetchInterval: 30_000,` to:
```ts
    refetchInterval: icuRefetchMs(subscribed, 30_000),
```

- [ ] **Step 2: `FlowsheetTab.tsx`**

Add the import after the existing imports:
```ts
import { icuRefetchMs } from "../realtime";
```
Change the component signature:
```ts
export default function FlowsheetTab({ admissionId, subscribed }: { admissionId: number; subscribed: boolean }) {
```
Change the flowsheet query's `refetchInterval: 30_000,` to:
```ts
    refetchInterval: icuRefetchMs(subscribed, 30_000),
```
(Leave the `["icu","io",admissionId]` query unchanged — it has no interval.)

- [ ] **Step 3: `AssessmentsTab.tsx`**

Add the import after the existing imports:
```ts
import { icuRefetchMs } from "../realtime";
```
Change the component signature:
```ts
export default function AssessmentsTab({ admissionId, subscribed }: { admissionId: number; subscribed: boolean }) {
```
Change the assessments query's `refetchInterval: 60_000,` to:
```ts
    refetchInterval: icuRefetchMs(subscribed, 60_000),
```

- [ ] **Step 4: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/icu/components/AdmissionsTab.tsx" "apps/admin/src/app/(with-auth)/dashboard/icu/components/FlowsheetTab.tsx" "apps/admin/src/app/(with-auth)/dashboard/icu/components/AssessmentsTab.tsx"
git commit -m "feat(realtime): ICU tabs accept subscribed -> relaxed poll cadence

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Frontend — page wiring + indicator + page test

**Files:** Modify `apps/admin/src/app/(with-auth)/dashboard/icu/page.tsx`; Create `apps/admin/src/__tests__/dashboard/icu/page.test.tsx`.

- [ ] **Step 1: Wire the hook + indicator + pass `subscribed` in `page.tsx`**

Add to the imports (after `import BundleTab from "./components/BundleTab";`):
```ts
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
import { ICU_BOARD_CHANNEL } from "./realtime";
```

In `ICUPage`, immediately after the two `useState` lines, add the hook + the indicator label/title:
```ts
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(ICU_BOARD_CHANNEL, [["icu"]]);

  const liveLabel = subscribed ? "● Live" : "○ Polling";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:icu-board — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:icu-board"
    : connected
      ? "Connecting…"
      : "Polling (real-time unavailable)";
```

Replace the header block:
```tsx
      <div>
        <h1 className="text-3xl font-bold text-foreground">ICU Command Centre</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Hourly flowsheet, RASS / CAM-ICU / SOFA / CPOT, and the SCCM ABCDEF
          daily bundle. Active patient context flows across tabs.
        </p>
      </div>
```
with:
```tsx
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-bold text-foreground">ICU Command Centre</h1>
          <span
            data-testid="icu-realtime-indicator"
            role="status"
            aria-label={
              subscribed
                ? "Live — real-time ICU board updates active"
                : "Polling — real-time updates unavailable"
            }
            title={liveTitle}
            className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
          >
            {liveLabel}
          </span>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Hourly flowsheet, RASS / CAM-ICU / SOFA / CPOT, and the SCCM ABCDEF
          daily bundle. Active patient context flows across tabs.
        </p>
      </div>
```

Pass `subscribed` to the three polling tabs (leave `BundleTab` unchanged):
```tsx
      {tab === "admissions" && (
        <AdmissionsTab
          activeAdmissionId={activeAdmissionId}
          onSelect={setActiveAdmissionId}
          onJumpToFlowsheet={(id) => {
            setActiveAdmissionId(id);
            setTab("flowsheet");
          }}
          subscribed={subscribed}
        />
      )}
      {tab === "flowsheet" && activeAdmissionId && (
        <FlowsheetTab admissionId={activeAdmissionId} subscribed={subscribed} />
      )}
      {tab === "assessments" && activeAdmissionId && (
        <AssessmentsTab admissionId={activeAdmissionId} subscribed={subscribed} />
      )}
```

- [ ] **Step 2: Write the page test**

Create `apps/admin/src/__tests__/dashboard/icu/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import ICUPage from "@/app/(with-auth)/dashboard/icu/page";
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

describe("<ICUPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
    mockedFetchAdminAPI.mockResolvedValue([] as never); // /icu/admissions -> []
  });

  it("subscribes to staff:icu-board and shows ○ Polling when not live", async () => {
    renderWithQuery(<ICUPage />);
    const ind = await screen.findByTestId("icu-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("staff:icu-board", [["icu"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<ICUPage />);
    const ind = await screen.findByTestId("icu-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
```

- [ ] **Step 3: Run the page test + cadence test**

Run (from `apps/admin`): `npm test -- icu/`
Expected: PASS (page: 2, realtime: 2).

- [ ] **Step 4: Type-check + lint**

Run (from `apps/admin`): `npm run type-check` → 0 errors (confirms the 3 tabs + page agree on the `subscribed` prop).
Run (from `apps/admin`): `npm run lint` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/icu/page.tsx" "apps/admin/src/__tests__/dashboard/icu/page.test.tsx"
git commit -m "feat(realtime): subscribe ICU board to staff:icu-board + Live indicator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Full verification gates

**Files:** none (verification only).

- [ ] **Step 1: Backend gates**

Run (from `apps/backend`): `npm run lint` → PASS.
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js icuBoardChannel icuBoardEmitter --forceExit` → PASS (4 tests).

- [ ] **Step 2: Admin gates**

Run (from `apps/admin`): `npm run type-check` → 0 errors.
Run (from `apps/admin`): `npm run lint` → 0 errors.
Run (from `apps/admin`): `npm test` → full suite PASS (incl. the new `icu/realtime` + `icu/page` tests).
Run (from `apps/admin`): `npm run build` → PASS.

- [ ] **Step 3: Manual live-WS verification (optional, deploy HELD → local)**

Per spec §9: open the ICU board (`●Live`); from a second client `PATCH /icu/admissions/:id/code-status` (or log a flowsheet entry) → the board repaints within ~1s without the poll; kill the WS → `○Polling` + the original 30/60s poll resumes.

---

## After the plan: finish the branch

Follow the standing workflow: request review, then `merge --no-ff` into `main`, push **both** remotes (GitHub + Forgejo), delete the branch. **Deploy stays HELD** — do not tag.

## Spec-coverage check (self-review)

- Channel (spec §4.1) → Task 1 Steps 1-4. Emitter (§4.2) → Task 1 Steps 5-8. 7 producers (§4.3) → Task 2. Cadence helper (§5.1) → Task 3. Tab thread-through (§5.3) → Task 4. Page wiring + indicator (§5.2) → Task 5 Step 1. Tests (§7) → Task 1 (channel/emitter), Task 3 (cadence), Task 5 (page). Gates + manual (§9) → Task 6. Tenant scoping (§6) → Task 2 (explicit `tenantId`). Out-of-scope (monitoring/fasting, io/bundle no new poll) → no task, as intended.
- Type consistency: `emitIcuBoardEvent(kind, { admissionId, status, tenantId })` used identically in the emitter (Task 1.7), the emitter test (Task 1.5), and all 7 producers (Task 2). `icuRefetchMs(subscribed, baseMs)` defined in Task 3.3 and consumed in Tasks 4.1-4.3. `subscribed` prop required by the 3 tabs (Task 4) and supplied by the page (Task 5.1) — type-check in Task 5.4 enforces agreement. Channel string `"staff:icu-board"` (catalog/emitter/tests) and `ICU_BOARD_CHANNEL` (frontend) match.
