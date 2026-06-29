# Blood Bank Board Real-time + RQ Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push the admin Blood Bank board live over WebSockets via a new `staff:blood-bank` channel with 10 route-layer producers; first migrate the board's three tabs from raw `useState`/`useEffect`/`fetch` to TanStack Query so `useRealtimeInvalidation` can drive refetches.

**Architecture:** Two-commit frontend (Commit A: behavior-preserving react-query migration; Commit B: subscribe + indicator) + a parallel backend task (channel + emitter + 10 producers). Event-driven recipe like micro/dialysis; purely additive (no poll — the board never polled), like incidents. Emit is post-service, PHI-free, explicit-tenant (`req.tenantId`).

**Tech Stack:** Node/Express 5 + WS fabric (Redis fan-out), Next.js 16 + TanStack Query v5, Jest (backend `--experimental-vm-modules`; admin jest+RTL).

**Branch:** `feat/realtime-blood-bank` (already created off main). Deploy HELD — never tag.

**Parallelism:** Task 1 (backend, `apps/backend/**`) and Task 2 (frontend, `apps/admin/**`) touch disjoint dirs → run as parallel implementers. Task 2 is itself two sequential commits on one file.

---

## File Structure

**Backend (Task 1):**
- Modify `apps/backend/src/utils/websocket/channelAuth.js` — add `staff:blood-bank` catalog entry.
- Modify `apps/backend/src/utils/websocket/realtimeEmitter.js` — add `emitBloodBankEvent`.
- Modify `apps/backend/src/routes/bloodbank/bloodBankRoutes.js` — import + 10 emit sites.
- Create `apps/backend/src/tests/unit/bloodBankRealtimeChannel.test.js`.
- Create `apps/backend/src/tests/unit/bloodBankRealtimeEmitter.test.js`.

**Frontend (Task 2):**
- Modify `apps/admin/src/app/(with-auth)/dashboard/blood-bank/page.tsx` — Commit A (RQ migration of 3 tabs) then Commit B (subscribe hook + indicator).
- Create `apps/admin/src/__tests__/dashboard/blood-bank/page.test.tsx` (in Commit B).

---

## Task 1 — Backend: channel + emitter + 10 producers (TDD)

**Files:**
- Create: `apps/backend/src/tests/unit/bloodBankRealtimeChannel.test.js`
- Create: `apps/backend/src/tests/unit/bloodBankRealtimeEmitter.test.js`
- Modify: `apps/backend/src/utils/websocket/channelAuth.js` (CHANNEL_CATALOG, after `'staff:dialysis-board'`)
- Modify: `apps/backend/src/utils/websocket/realtimeEmitter.js` (append after `emitDialysisEvent`)
- Modify: `apps/backend/src/routes/bloodbank/bloodBankRoutes.js` (import + 10 sites)

Run-command reference (from `apps/backend`):
`node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit` · `npm run lint`

- [ ] **Step 1: Write the failing channel test**

Create `apps/backend/src/tests/unit/bloodBankRealtimeChannel.test.js`:
```js
import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:blood-bank channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:blood-bank']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:blood-bank'].roles).toBe('staff');
  });

  test('allowed for the blood-bank technician (isStaff, NOT isClinical) + nurses + doctors + admin, denied for patients', () => {
    // BLOOD_BANK_TECHNICIAN is the key case: isStaff true but isClinical false,
    // so staff:clinical:* would wrongly deny it — staff: must admit it.
    expect(authorizeChannel('staff:blood-bank', { role: 'BLOOD_BANK_TECHNICIAN', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:blood-bank', { role: 'NURSING_STAFF', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:blood-bank', { role: 'DOCTOR', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:blood-bank', { role: 'ADMIN', userId: '4' }).allowed).toBe(true);
    expect(authorizeChannel('staff:blood-bank', { role: 'PATIENT', userId: '5' }).allowed).toBe(false);
  });

  test('SUPER_ADMIN may subscribe (slice-9 channel bypass)', () => {
    expect(authorizeChannel('staff:blood-bank', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js bloodBankRealtimeChannel --forceExit`
Expected: FAIL — `CHANNEL_CATALOG['staff:blood-bank']` undefined (catalog assertion). The allow/deny cases already pass via the generic `staff:` prefix logic — that is fine; the catalog assertion is the red. (If `BLOOD_BANK_TECHNICIAN` somehow failed the allow case, that would indicate it is not isStaff — but it is, verified.)

- [ ] **Step 3: Add the catalog entry**

In `apps/backend/src/utils/websocket/channelAuth.js`, in `CHANNEL_CATALOG`, immediately AFTER the `'staff:dialysis-board': { … },` line, add:
```js
  'staff:blood-bank': { description: 'Blood bank — request lifecycle, unit stock, crossmatch, transfusion closed-loop + reactions', roles: 'staff' },
```

- [ ] **Step 4: Run it — verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js bloodBankRealtimeChannel --forceExit`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing emitter test**

Create `apps/backend/src/tests/unit/bloodBankRealtimeEmitter.test.js`:
```js
import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitBloodBankEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitBloodBankEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:blood-bank with the kind + explicit tenantId', () => {
    emitBloodBankEvent('request-created', { tenantId: 't1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:blood-bank',
      expect.objectContaining({ kind: 'request-created' }),
      { tenantId: 't1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitBloodBankEvent('reaction-recorded', { tenantId: 't1' })).not.toThrow();
  });
});
```

- [ ] **Step 6: Run it — verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js bloodBankRealtimeEmitter --forceExit`
Expected: FAIL — `emitBloodBankEvent` is not exported (`undefined`).

- [ ] **Step 7: Implement the emitter**

In `apps/backend/src/utils/websocket/realtimeEmitter.js`, append AFTER the `emitDialysisEvent` function (the last function in the file):
```js

/** Blood-bank board change (request lifecycle, unit stock, crossmatch, transfusion closed-loop, reactions). */
export function emitBloodBankEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:blood-bank', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitBloodBankEvent failed:', err.message);
  }
}
```
(`broadcast` + `logger` are already imported at the top — confirm; do NOT re-import.)

- [ ] **Step 8: Run it — verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js bloodBankRealtimeEmitter --forceExit`
Expected: PASS (2 tests).

- [ ] **Step 9: Add the import to the routes file**

In `apps/backend/src/routes/bloodbank/bloodBankRoutes.js`, after the line `import { requiredUUID, requiredNumber, requiredEnum, paramId } from '../../validators/sharedValidators.js';` (line 19), add:
```js
import { emitBloodBankEvent } from '../../utils/websocket/realtimeEmitter.js';
```

- [ ] **Step 10: Wire the 10 producers**

In each handler, insert the emit on its own line AFTER the awaited service call and BEFORE `return success(...)`. Use `req.tenantId`. Apply ALL 10 edits:

**Site 1 — `POST /request` (~line 63):**
```js
    const result = await bloodBankService.createRequest(requestData, bloodBankContext(req));
    emitBloodBankEvent('request-created', { tenantId: req.tenantId });
    return success(res, result, 'Blood request created successfully', 201);
```

**Site 2 — `PUT /:id/cross-match` (~line 86):**
```js
    const result = await bloodBankService.crossMatch(parseInt(id, 10), matchData, bloodBankContext(req));
    emitBloodBankEvent('request-cross-matched', { tenantId: req.tenantId });
    return success(res, result, 'Cross-match result recorded successfully');
```

**Site 3 — `PUT /:id/issue` (~line 108):**
```js
    const result = await bloodBankService.issueBlood(parseInt(id, 10), issueData, bloodBankContext(req));
    emitBloodBankEvent('request-issued', { tenantId: req.tenantId });
    return success(res, result, 'Blood issued successfully');
```

**Site 4 — `PUT /:id/transfused` (~line 131):**
```js
    const result = await bloodBankService.recordTransfusion(parseInt(id, 10), transfusionData, bloodBankContext(req));
    emitBloodBankEvent('request-transfused', { tenantId: req.tenantId });
    return success(res, result, 'Transfusion recorded successfully');
```

**Site 5 — `POST /units` (~line 157):**
```js
    }, bloodBankContext(req));
    emitBloodBankEvent('unit-registered', { tenantId: req.tenantId });
    return success(res, unit, 'Blood unit registered', 201);
```
(Insert between the `registerUnit({...}, bloodBankContext(req));` close and the `return success(res, unit, …)`. The awaited value is `unit`.)

**Site 6 — `POST /:id/crossmatch-unit` (~line 185):**
```js
    }, bloodBankContext(req));
    emitBloodBankEvent('unit-cross-matched', { tenantId: req.tenantId });
    return success(res, result, 'Unit crossmatch recorded');
```

**Site 7 — `POST /:id/verify-bedside` (~line 200):**
```js
    }, bloodBankContext(req));
    emitBloodBankEvent('verification-recorded', { tenantId: req.tenantId });
    return success(res, verification, 'Bedside verification recorded');
```

**Site 8 — `POST /:id/start-transfusion` (~line 209):**
```js
    const result = await startTransfusion(parseInt(req.params.id, 10), bloodBankContext(req));
    emitBloodBankEvent('transfusion-started', { tenantId: req.tenantId });
    return success(res, result, 'Transfusion started');
```

**Site 9 — `POST /:id/complete-transfusion` (~line 222):**
```js
    }, bloodBankContext(req));
    emitBloodBankEvent('transfusion-completed', { tenantId: req.tenantId });
    return success(res, result, 'Transfusion completed');
```

**Site 10 — `POST /:id/reaction` (~line 241):**
```js
    }, bloodBankContext(req));
    emitBloodBankEvent('reaction-recorded', { tenantId: req.tenantId });
    return success(res, reaction, 'Transfusion reaction recorded', 201);
```

Do **NOT** add an emit to the GET handlers (`/units` list, `/inventory`, `/pending`). Each emit sits inside the existing `try`, so a `broadcast` throw is still caught (and `emitBloodBankEvent` already swallows it internally).

- [ ] **Step 11: Lint + regression**

Run: `npm run lint` → 0 errors.
Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js bloodBankRealtimeChannel bloodBankRealtimeEmitter --forceExit` → 5 pass.
Verify all 10 emits landed: `grep -c "emitBloodBankEvent" apps/backend/src/routes/bloodbank/bloodBankRoutes.js` → 11 (10 calls + 1 import). `grep -oE "emitBloodBankEvent\('[a-z-]+'" …` → 10 unique kinds.
The existing `src/tests/transfusion-loop.deep.test.js` is DB-gated on QA PG `:55432`; the emits are post-service + side-effect-free, so it must stay green if run (Task 3 runs it against the live cluster). A DB-connection failure (cluster down) is NOT a code regression.

- [ ] **Step 12: Commit**

```bash
git add apps/backend/src/utils/websocket/channelAuth.js \
        apps/backend/src/utils/websocket/realtimeEmitter.js \
        apps/backend/src/routes/bloodbank/bloodBankRoutes.js \
        apps/backend/src/tests/unit/bloodBankRealtimeChannel.test.js \
        apps/backend/src/tests/unit/bloodBankRealtimeEmitter.test.js
git commit -m "feat(realtime): add staff:blood-bank channel + emitBloodBankEvent + 10 producers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2 — Frontend: RQ migration (Commit A) then realtime (Commit B)

**Files:**
- Modify: `apps/admin/src/app/(with-auth)/dashboard/blood-bank/page.tsx`
- Create: `apps/admin/src/__tests__/dashboard/blood-bank/page.test.tsx` (Commit B)

Run-command reference (from `apps/admin`): `npm test -- <pattern>` · `npm run type-check` · `npm run lint`

### Commit A — react-query migration (behavior-preserving)

- [ ] **Step A1: Swap imports**

In `page.tsx`, change the React + api imports. Replace:
```ts
import { useEffect, useState, useCallback, Suspense } from "react";
import { fetchAdminAPI, postJSON, putJSON } from "@/lib/api";
```
with:
```ts
import { useState, Suspense } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI, postJSON, putJSON } from "@/lib/api";
```
(`useEffect`/`useCallback` are no longer used after the migration.)

- [ ] **Step A2: Migrate `InventoryTab`**

Replace the body of `InventoryTab` (the `useState`+`useCallback load`+`useEffect`) down to (but not including) the `return (`:
```tsx
function InventoryTab() {
  const {
    data: inventory = [],
    isLoading: loading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["blood-bank", "inventory"],
    queryFn: async () => {
      const r = await fetchAdminAPI<{ data: InventoryItem[] }>(
        "/blood-bank/inventory",
      );
      const data = (r as Record<string, unknown>).data ?? r;
      return Array.isArray(data) ? (data as InventoryItem[]) : [];
    },
  });
```
Then in the JSX: change the Refresh button `onClick={load}` → `onClick={() => refetch()}`, and the error render `{error}` → `{error instanceof Error ? error.message : "Failed to load inventory"}`. Everything else in the tab is unchanged.

- [ ] **Step A3: Migrate `PendingRequestsTab`**

Replace its `useState`/`load`/`useEffect`/`action` block with:
```tsx
function PendingRequestsTab() {
  const qc = useQueryClient();
  const {
    data: requests = [],
    isLoading: loading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["blood-bank", "pending"],
    queryFn: async () => {
      const r = await fetchAdminAPI<{ data: BloodRequest[] }>(
        "/blood-bank/pending",
      );
      const data = (r as Record<string, unknown>).data ?? r;
      return Array.isArray(data) ? (data as BloodRequest[]) : [];
    },
  });

  const action = useMutation({
    mutationFn: ({ id, endpoint }: { id: number; endpoint: string }) =>
      putJSON(`/api/v1/blood-bank/${id}/${endpoint}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["blood-bank"] }),
    onError: (e) => alert(e instanceof Error ? e.message : "Action failed"),
  });
```
In the JSX:
- Refresh button `onClick={load}` → `onClick={() => refetch()}`; error render → `{error instanceof Error ? error.message : "Failed to load requests"}`.
- Each action button: `onClick={() => action(r.id, "cross-match")}` → `onClick={() => action.mutate({ id: r.id, endpoint: "cross-match" })}` (likewise `"issue"`, `"transfused"`).
- Each button `disabled={acting === r.id}` → `disabled={action.isPending && action.variables?.id === r.id}`.

- [ ] **Step A4: Migrate `NewRequestTab`**

Replace its `saving`/`submit` with a mutation (keep `form`/`setForm` and `success`/`setSuccess`):
```tsx
function NewRequestTab() {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    patient_uid: "",
    blood_group: "O+",
    units: 1,
    notes: "",
  });
  const [success, setSuccess] = useState(false);

  const create = useMutation({
    mutationFn: () => postJSON("/api/v1/blood-bank/request", form),
    onSuccess: () => {
      setSuccess(true);
      setForm({ patient_uid: "", blood_group: "O+", units: 1, notes: "" });
      qc.invalidateQueries({ queryKey: ["blood-bank"] });
    },
    onError: (e) =>
      alert(e instanceof Error ? e.message : "Failed to create request"),
  });

  const submit = () => {
    if (!form.patient_uid) {
      alert("Patient UID is required");
      return;
    }
    setSuccess(false);
    create.mutate();
  };
```
In the JSX: the submit button `disabled={saving}` → `disabled={create.isPending}`, label `{saving ? "Creating..." : "Create Request"}` → `{create.isPending ? "Creating..." : "Create Request"}`. `onClick={submit}` stays.

- [ ] **Step A5: Gates for the migration**

Run (from `apps/admin`): `npm run type-check` → 0 errors; `npm run lint` → 0 errors. Fix any unused-import / `any` lint issue without changing behavior. (No new test yet — the page test arrives in Commit B; the migration is behavior-preserving and covered by type-check + lint + the existing suite.)
Run: `npm test 2>&1 | tail -5` → the full admin suite still passes (no blood-bank test exists yet; this confirms nothing else broke).

- [ ] **Step A6: Commit A**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/blood-bank/page.tsx"
git commit -m "refactor(blood-bank): migrate admin board to TanStack Query (no behavior change)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Commit B — realtime subscribe + indicator + page test

- [ ] **Step B1: Add the hook + indicator to `BloodBankContent`**

In `page.tsx`:
(a) add the import after the `@/lib/api` import:
```ts
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
```
(b) add a module const below the imports (e.g. after `BLOOD_GROUPS`):
```ts
const BLOOD_BANK_CHANNEL = "staff:blood-bank";
```
(c) in `BloodBankContent`, after `const [tab, setTab] = useState<...>("inventory");`, add:
```tsx
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(BLOOD_BANK_CHANNEL, [
    ["blood-bank"],
  ]);

  const liveLabel = subscribed ? "● Live" : connected ? "○ Connecting" : "○ Offline";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:blood-bank — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:blood-bank"
    : connected
      ? "Connecting…"
      : "Offline — refresh manually (real-time unavailable)";
```
(d) replace the heading:
```tsx
      <h1 className="text-3xl font-bold mb-6">Blood Bank</h1>
```
with:
```tsx
      <div className="flex items-center gap-2 mb-6">
        <h1 className="text-3xl font-bold">Blood Bank</h1>
        <span
          data-testid="blood-bank-realtime-indicator"
          role="status"
          aria-label={subscribed ? "Live — real-time blood-bank updates active" : "Offline — real-time updates unavailable"}
          title={liveTitle}
          className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
        >
          {liveLabel}
        </span>
      </div>
```

- [ ] **Step B2: Write the page test**

Create `apps/admin/src/__tests__/dashboard/blood-bank/page.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import BloodBankPage from "@/app/(with-auth)/dashboard/blood-bank/page";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn().mockResolvedValue({ data: [] }),
  postJSON: jest.fn().mockResolvedValue({}),
  putJSON: jest.fn().mockResolvedValue({}),
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

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<BloodBankPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
  });

  it("subscribes to staff:blood-bank on the [\"blood-bank\"] root and shows ○ Offline when down", async () => {
    renderWithQuery(<BloodBankPage />);
    const ind = await screen.findByTestId("blood-bank-realtime-indicator");
    expect(ind).toHaveTextContent("Offline");
    expect(mockRealtime).toHaveBeenCalledWith("staff:blood-bank", [["blood-bank"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<BloodBankPage />);
    const ind = await screen.findByTestId("blood-bank-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
```

- [ ] **Step B3: Gates**

Run (from `apps/admin`): `npm test -- "blood-bank/page"` → 2 pass; `npm run type-check` → 0 errors; `npm run lint` → 0 errors. `connected` + `lastEventAt` are both consumed in `liveTitle` — don't drop them. Fix any issue without changing behavior.

- [ ] **Step B4: Commit B**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/blood-bank/page.tsx" \
        "apps/admin/src/__tests__/dashboard/blood-bank/page.test.tsx"
git commit -m "feat(realtime): subscribe Blood Bank board to staff:blood-bank + Live indicator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3 — Whole-branch gates + review + merge (orchestrator-run, not an implementer)

- [ ] **Step 1: Full gates**
  - Backend (`apps/backend`): `npm run lint`; `node --experimental-vm-modules node_modules/jest/bin/jest.js "Channel|RealtimeEmitter|bloodBank" --forceExit`; then bring up QA PG (`node apps/backend/scripts/qa-cluster-up.mjs`) and run `DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test node --experimental-vm-modules node_modules/jest/bin/jest.js transfusion-loop --forceExit` → must stay green (emits are side-effect-free).
  - Admin (`apps/admin`): `npm run lint`; `npm run type-check`; `npm test` (full); `npm run build`.
- [ ] **Step 2: Final adversarial review** (multi-lens: security/RBAC channel-scope incl. the over-grant + the BLOOD_BANK_TECHNICIAN-isStaff-not-isClinical fact, regression/correctness of the 10 emits + the RQ migration behavior-preservation, pattern-consistency vs micro/dialysis/incidents). Verify any real findings before merge.
- [ ] **Step 3: Finish the branch** — `git checkout main`; `git merge --no-ff feat/realtime-blood-bank`; push `github main` + `origin main`; delete the branch. **Deploy HELD — do NOT tag.**
- [ ] **Step 4: Update memory** — slice 11 block in `project_vh_health_realtime_dashboards.md` (RQ-migration-first pattern + the BLOOD_BANK_TECHNICIAN/BLOOD_BANK_STAFF role-vocabulary finding) + MEMORY.md index line (10→11) + advance scout backlog to "next: radiology (RQ migration first)".

---

## Self-Review (against the spec)

**1. Spec coverage:** §4.1 channel → T1 S3 (+ the BLOOD_BANK_TECHNICIAN assertion in the channel test S1); §4.2 emitter → T1 S7; §4.3 10 producers → T1 S10 (all 10 enumerated with exact insertion context); §5.1 RQ migration → T2 Commit A (S A1–A6, all 3 tabs); §5.2 realtime subscribe+indicator → T2 Commit B (S B1); §6 tenancy → explicit `req.tenantId` at every site (T1 S10) + asserted in emitter test (T1 S5); §7 tests → T1 S1/S5, T2 S B2 + the transfusion-loop regression (T1 S11 / T3 S1); §8 risks → addressed (BLOOD_BANK_TECHNICIAN admitted, over-grant documented, behavior-preserving migration, post-service emit). No gaps.

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; all 10 sites written with their surrounding context (not "similar to site N"); the migration shows each tab's exact new block.

**3. Type consistency:** `emitBloodBankEvent(kind, { tenantId })` used identically in realtime.ts emitter, all 10 route sites, and the emitter test. `BLOOD_BANK_CHANNEL = "staff:blood-bank"` consistent across page const, hook call, channel catalog, emitter, and tests. `useRealtimeInvalidation(channel, [["blood-bank"]])` return `{ connected, subscribed, denied, lastEventAt }` matches the real hook and the page destructure. Query keys `["blood-bank","inventory"]` / `["blood-bank","pending"]` both under the `["blood-bank"]` invalidation root. Mutation `action.variables?.id` matches the `{ id, endpoint }` mutationFn arg shape.
