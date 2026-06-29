# Radiology Board Real-time + Contract Reconciliation + RQ Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the broken admin Radiology board work (reconcile its contract to the real backend), migrate it to TanStack Query, and push it live via a new `staff:radiology` channel with 6 route-layer producers.

**Architecture:** Two-commit frontend (Commit A: contract reconciliation + RQ migration; Commit B: subscribe + indicator) + a parallel backend task (channel + emitter + 6 producers). Event-driven, purely additive (no poll — the board never polled), like blood-bank/incidents. Emit post-service, PHI-free, `req.tenantId`. Prerequisite PR0 (RADIOLOGY_STAFF → ALL_STAFF_ROLES) already merged (`main 923772ca`).

**Tech Stack:** Node/Express 5 + WS fabric, Next.js 16 + TanStack Query v5, Jest.

**Branch:** `feat/realtime-radiology` (already created off main). Deploy HELD — never tag.

**Parallelism:** Task 1 (backend, `apps/backend/**`) ∥ Task 2 (frontend, `apps/admin/**`). Task 2 is two sequential commits on one file.

---

## Task 1 — Backend: channel + emitter + 6 producers (TDD)

**Files:** Create `apps/backend/src/tests/unit/radiologyRealtimeChannel.test.js`, `…/radiologyRealtimeEmitter.test.js`; Modify `channelAuth.js`, `realtimeEmitter.js`, `routes/radiology/radiologyRoutes.js`.

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit` · `npm run lint`

- [ ] **Step 1: Failing channel test** — create `apps/backend/src/tests/unit/radiologyRealtimeChannel.test.js`:
```js
import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:radiology channel', () => {
  test('is listed in the channel catalog', () => {
    expect(CHANNEL_CATALOG['staff:radiology']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:radiology'].roles).toBe('staff');
  });
  test('allowed for the radiographer (RADIOLOGY_STAFF, isStaff post-PR0, NOT clinical) + radiologist + doctor + admin, denied for patient', () => {
    expect(authorizeChannel('staff:radiology', { role: 'RADIOLOGY_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:radiology', { role: 'RADIOLOGIST', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:radiology', { role: 'DOCTOR', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:radiology', { role: 'ADMIN', userId: '4' }).allowed).toBe(true);
    expect(authorizeChannel('staff:radiology', { role: 'PATIENT', userId: '5' }).allowed).toBe(false);
  });
  test('SUPER_ADMIN may subscribe (slice-9 bypass)', () => {
    expect(authorizeChannel('staff:radiology', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
  });
});
```
- [ ] **Step 2: Run → FAIL** (`radiologyRealtimeChannel`): catalog undefined. The RADIOLOGY_STAFF allow-case already passes (PR0 made it isStaff) — that is the point; the catalog assertion is the red.
- [ ] **Step 3:** In `channelAuth.js` `CHANNEL_CATALOG`, after the `'staff:blood-bank': { … },` line add:
```js
  'staff:radiology': { description: 'Radiology board — order lifecycle, acquisition, report submission, sign-off, addendum', roles: 'staff' },
```
- [ ] **Step 4: Run → PASS** (3 tests).
- [ ] **Step 5: Failing emitter test** — create `apps/backend/src/tests/unit/radiologyRealtimeEmitter.test.js`:
```js
import { jest } from '@jest/globals';
const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({ broadcast, sendToUser: jest.fn() }));
const { emitRadiologyEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitRadiologyEvent', () => {
  beforeEach(() => jest.clearAllMocks());
  test('broadcasts on staff:radiology with the kind + explicit tenantId', () => {
    emitRadiologyEvent('order-created', { tenantId: 't1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('staff:radiology', expect.objectContaining({ kind: 'order-created' }), { tenantId: 't1' });
  });
  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitRadiologyEvent('order-cancelled', { tenantId: 't1' })).not.toThrow();
  });
});
```
- [ ] **Step 6: Run → FAIL** (`emitRadiologyEvent` undefined).
- [ ] **Step 7:** In `realtimeEmitter.js`, append after `emitBloodBankEvent` (last function):
```js

/** Radiology-board change (order lifecycle, acquisition, report submission, sign-off, addendum). */
export function emitRadiologyEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:radiology', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitRadiologyEvent failed:', err.message);
  }
}
```
(`broadcast`+`logger` already imported — do NOT re-import.)
- [ ] **Step 8: Run → PASS** (2 tests).
- [ ] **Step 9:** In `routes/radiology/radiologyRoutes.js`, after the existing import block (the `buildPagination`/`parseListQuery` or `sharedValidators` import — last import line) add:
```js
import { emitRadiologyEvent } from '../../utils/websocket/realtimeEmitter.js';
```
- [ ] **Step 10: Wire the 6 producers.** Insert the emit after the awaited service call, before `return success(...)`, inside the try. Apply ALL 6:

**Site 1 — `POST /orders` (~line 36):**
```js
    const order = await radiologyService.createOrder(orderData);
    emitRadiologyEvent('order-created', { tenantId: req.tenantId });
    return success(res, order, 'Radiology order created successfully', 201);
```
**Site 2 — `PUT /:id/report` (~line 89):**
```js
    const result = await radiologyService.submitReport(parseInt(id, 10), reportData);
    emitRadiologyEvent('report-submitted', { tenantId: req.tenantId });
    return success(res, result, 'Radiology report submitted successfully');
```
**Site 3 — `POST /:id/acquire` (~line 149):**
```js
    });
    emitRadiologyEvent('order-acquired', { tenantId: req.tenantId });
    return success(res, result, 'Radiology order acquired');
```
(Insert between the close of the `markAcquired({...})` call and `return success(res, result, 'Radiology order acquired')`. The awaited value is `result`.)
**Site 4 — `POST /:id/sign-off` (~line 167):**
```js
    });
    emitRadiologyEvent('report-signed-off', { tenantId: req.tenantId });
    return success(res, result, 'Radiology report signed off');
```
**Site 5 — `POST /:id/addendum` (~line 191):**
```js
    );
    emitRadiologyEvent('report-addendum', { tenantId: req.tenantId });
    return success(res, result, 'Radiology report addendum appended');
```
**Site 6 — `PUT /:id/cancel` (~line 250):**
```js
    const result = await radiologyService.cancelOrder(parseInt(id, 10), req.user?.uid);
    emitRadiologyEvent('order-cancelled', { tenantId: req.tenantId });
    return success(res, result, 'Radiology order cancelled successfully');
```
Do NOT emit on the GET handlers (`/worklist`, `/patient/:uid`, `/:id`).
- [ ] **Step 11: Lint + verify.** `npm run lint` → 0. `node --experimental-vm-modules node_modules/jest/bin/jest.js radiologyRealtimeChannel radiologyRealtimeEmitter --forceExit` → 5 pass. `grep -c "emitRadiologyEvent" apps/backend/src/routes/radiology/radiologyRoutes.js` → 7 (6 calls + import); `grep -oE "emitRadiologyEvent\('[a-z-]+'" …` → 6 unique kinds. Do NOT run `radiology-deep.test.js` (orchestrator runs it vs live PG).
- [ ] **Step 12: Commit:**
```bash
git add apps/backend/src/utils/websocket/channelAuth.js apps/backend/src/utils/websocket/realtimeEmitter.js apps/backend/src/routes/radiology/radiologyRoutes.js apps/backend/src/tests/unit/radiologyRealtimeChannel.test.js apps/backend/src/tests/unit/radiologyRealtimeEmitter.test.js
git commit -m "feat(realtime): add staff:radiology channel + emitRadiologyEvent + 6 producers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2 — Frontend: contract reconciliation + RQ migration (Commit A), then realtime (Commit B)

**File:** Modify `apps/admin/src/app/(with-auth)/dashboard/radiology/page.tsx`; Create `apps/admin/src/__tests__/dashboard/radiology/page.test.tsx` (Commit B).

Run (from `apps/admin`): `npm test -- <pattern>` · `npm run type-check` · `npm run lint`

### Commit A — contract reconciliation + RQ migration

The page is broken end-to-end by contract drift; this commit makes it work AND migrates it to react-query. Read the full file first.

- [ ] **Step A1: Imports.** Replace:
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
- [ ] **Step A2: Fix the `RadiologyOrder` type.** Replace the type body so it matches the backend worklist:
```ts
type RadiologyOrder = {
  id: number;
  patient_uid: string;
  modality: string;
  body_part?: string;
  clinical_indication?: string;
  status: string;
  priority?: string;
  notes?: string;
  created_at: string;
  updated_at?: string;
};
```
(Removed `study_type`, `ordered_at`, `result_summary`, `report_url`.)
- [ ] **Step A3: Migrate `WorklistTab` to useQuery + useMutation, fix display.** Replace its `useState`/`useCallback fetch`/`useEffect`/`submitReport`/`cancelOrder`/`reportForm` block with:
```tsx
function WorklistTab() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<RadiologyOrder | null>(null);
  const [report, setReport] = useState("");

  const { data: orders = [], isLoading: loading, error, refetch } = useQuery({
    queryKey: ["radiology", "worklist"],
    queryFn: async () => {
      const r = await fetchAdminAPI<{ data: RadiologyOrder[] }>("/radiology/worklist");
      const data = (r as Record<string, unknown>).data ?? r;
      return Array.isArray(data) ? (data as RadiologyOrder[]) : [];
    },
  });

  const reportMut = useMutation({
    mutationFn: (orderId: number) => putJSON(`/api/v1/radiology/${orderId}/report`, { report }),
    onSuccess: () => { setSelected(null); setReport(""); qc.invalidateQueries({ queryKey: ["radiology"] }); },
    onError: (e) => alert(e instanceof Error ? e.message : "Failed to submit report"),
  });

  const cancelMut = useMutation({
    mutationFn: (orderId: number) => putJSON(`/api/v1/radiology/${orderId}/cancel`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["radiology"] }),
    onError: (e) => alert(e instanceof Error ? e.message : "Failed to cancel"),
  });
```
Then in the JSX:
- Refresh button `onClick={fetch}` → `onClick={() => refetch()}`; error render `{error}` → `{error instanceof Error ? error.message : "Failed to load worklist"}`.
- Worklist column header `Study Type` → `Modality`; cell `{o.study_type}` → `{o.modality}`; `fmtDate(o.ordered_at)` → `fmtDate(o.created_at)`.
- Report button onClick → `setSelected(o); setReport("");` (drop the old `setReportForm({result_summary, report_url})`).
- Cancel button → `onClick={() => { if (confirm("Cancel this order?")) cancelMut.mutate(o.id); }}`.
- The modal: title `Add Report — #{selected.id}`; replace the two inputs (result_summary textarea + report_url input) with ONE textarea bound to `report`/`setReport`:
```tsx
<textarea rows={4} placeholder="Report findings / impression" value={report}
  onChange={(e) => setReport(e.target.value)}
  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none" />
```
Submit button: `disabled={reportMut.isPending || !report.trim()}`, `onClick={() => selected && reportMut.mutate(selected.id)}`, label `{reportMut.isPending ? "Saving..." : "Submit Report"}`. Cancel-in-modal: `onClick={() => setSelected(null)}`.
- [ ] **Step A4: Fix the `NewOrderTab` create form (currently 400s).** Replace its state/submit and add the two required inputs:
```tsx
function NewOrderTab() {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    patient_uid: "",
    modality: "",
    body_part: "",
    clinical_indication: "",
    priority: "NORMAL",
    notes: "",
  });
  const [success, setSuccess] = useState(false);

  const create = useMutation({
    mutationFn: () => postJSON("/api/v1/radiology/orders", form),
    onSuccess: () => {
      setSuccess(true);
      setForm({ patient_uid: "", modality: "", body_part: "", clinical_indication: "", priority: "NORMAL", notes: "" });
      qc.invalidateQueries({ queryKey: ["radiology"] });
    },
    onError: (e) => alert(e instanceof Error ? e.message : "Failed to create order"),
  });

  const submit = () => {
    if (!form.patient_uid || !form.modality || !form.body_part || !form.clinical_indication) {
      alert("Patient UID, modality, body part, and clinical indication are required");
      return;
    }
    setSuccess(false);
    create.mutate();
  };
```
In the JSX: rename the study-type input to modality (`placeholder="Modality (e.g. X-RAY, CT, MRI) *"`, `value={form.modality}`, `onChange` sets `modality`). After it, add two inputs:
```tsx
<input placeholder="Body part (e.g. Chest, Abdomen) *" value={form.body_part}
  onChange={(e) => setForm({ ...form, body_part: e.target.value })}
  className="w-full border border-border rounded-lg px-3 py-2 text-sm" />
<input placeholder="Clinical indication *" value={form.clinical_indication}
  onChange={(e) => setForm({ ...form, clinical_indication: e.target.value })}
  className="w-full border border-border rounded-lg px-3 py-2 text-sm" />
```
Submit button: `disabled={create.isPending}`, label `{create.isPending ? "Creating..." : "Create Order"}`. Keep the priority select + notes textarea + the success banner.
- [ ] **Step A5: Gates.** `npm run type-check` → 0; `npm run lint` → 0; `npm test 2>&1 | tail -5` → full suite green (no radiology test yet). Fix any unused-import/`any` lint without changing behavior.
- [ ] **Step A6: Commit A:**
```bash
git add "apps/admin/src/app/(with-auth)/dashboard/radiology/page.tsx"
git commit -m "fix(radiology): reconcile admin board to the real backend contract + migrate to TanStack Query

Worklist read (study_type->modality, ordered_at->created_at), create form
(adds required body_part + clinical_indication, study_type->modality), and
report modal (result_summary/report_url -> report) were drifted against an API
the backend never implemented (create + report 400'd, modality column blank).
Reconciled to the real contract + migrated useState/fetch to useQuery/useMutation.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Commit B — realtime subscribe + indicator + page test

- [ ] **Step B1:** In `page.tsx`: add `import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";` (after `@/lib/api`) + a module const `const RADIOLOGY_CHANNEL = "staff:radiology";` (below imports). In `RadiologyContent`, after `const [tab, setTab] = useState<...>("worklist");`, add:
```tsx
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(RADIOLOGY_CHANNEL, [["radiology"]]);
  const liveLabel = subscribed ? "● Live" : connected ? "○ Connecting" : "○ Offline";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:radiology — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:radiology"
    : connected ? "Connecting…" : "Offline — refresh manually (real-time unavailable)";
```
Replace `<h1 className="text-3xl font-bold mb-6">Radiology</h1>` with:
```tsx
      <div className="flex items-center gap-2 mb-6">
        <h1 className="text-3xl font-bold">Radiology</h1>
        <span data-testid="radiology-realtime-indicator" role="status"
          aria-label={subscribed ? "Live — real-time radiology updates active" : "Offline — real-time updates unavailable"}
          title={liveTitle}
          className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}>
          {liveLabel}
        </span>
      </div>
```
- [ ] **Step B2:** Create `apps/admin/src/__tests__/dashboard/radiology/page.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import RadiologyPage from "@/app/(with-auth)/dashboard/radiology/page";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn().mockResolvedValue({ data: [] }),
  postJSON: jest.fn().mockResolvedValue({}),
  putJSON: jest.fn().mockResolvedValue({}),
}));

const mockRealtime = jest.fn(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (..._args: unknown[]) => ({ connected: false, subscribed: false, denied: null as string | null, lastEventAt: null as number | null }),
);
jest.mock("@/hooks/useRealtimeInvalidation", () => ({
  useRealtimeInvalidation: (...args: unknown[]) => mockRealtime(...args),
}));

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<RadiologyPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
  });
  it("subscribes to staff:radiology on the [\"radiology\"] root and shows ○ Offline when down", async () => {
    renderWithQuery(<RadiologyPage />);
    const ind = await screen.findByTestId("radiology-realtime-indicator");
    expect(ind).toHaveTextContent("Offline");
    expect(mockRealtime).toHaveBeenCalledWith("staff:radiology", [["radiology"]]);
  });
  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<RadiologyPage />);
    expect(await screen.findByTestId("radiology-realtime-indicator")).toHaveTextContent("Live");
  });
});
```
- [ ] **Step B3: Gates.** `npm test -- "radiology/page"` → 2 pass; `npm run type-check` → 0; `npm run lint` → 0. `connected`+`lastEventAt` both used in liveTitle — keep them.
- [ ] **Step B4: Commit B:**
```bash
git add "apps/admin/src/app/(with-auth)/dashboard/radiology/page.tsx" "apps/admin/src/__tests__/dashboard/radiology/page.test.tsx"
git commit -m "feat(realtime): subscribe Radiology board to staff:radiology + Live indicator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3 — Whole-branch gates + review + merge (orchestrator-run)

- [ ] **Step 1: Full gates.** Backend: `npm run lint`; `jest "Channel|RealtimeEmitter|radiology" --forceExit` (non-deep); then `DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test … jest radiology-deep --forceExit` → must stay green (emits side-effect-free). Admin: `npm run lint`; `npm run type-check`; `npm test`; `npm run build`.
- [ ] **Step 2: Final adversarial review** (multi-lens: channel-scope/RBAC incl. RADIOLOGY_STAFF-isStaff-post-PR0 + over-grant; the 6 emits; the contract reconciliation correctness — does the page now match the backend (create sends modality+body_part+clinical_indication; report sends report; worklist reads modality+created_at)?; RQ-migration behavior). Verify findings before merge.
- [ ] **Step 3: Finish the branch** — merge `--no-ff` → push `github` + `origin` main → delete branch. Deploy HELD — no tag.
- [ ] **Step 4: Update memory** — slice 12 block (the broken-board contract-reconciliation + the PR0 RBAC prerequisite + RADIOLOGY_STAFF/RADIOLOGIST split) + MEMORY.md index (11→12) + scout backlog → "next: doctor-queue".

---

## Self-Review (against the spec)
**Spec coverage:** §4.1 channel→T1 S3 (+RADIOLOGY_STAFF assertion S1); §4.2 emitter→T1 S7; §4.3 6 producers→T1 S10 (all 6, with insertion context); §5.1 reconciliation+migration→T2 Commit A (S A2–A4 cover worklist read/create/report); §5.2 realtime→T2 Commit B; §6 tenancy→`req.tenantId` at every site + emitter test; §7 tests→T1 S1/S5, T2 S B2 + radiology-deep regression (T3 S1); §8 risks→addressed. No gaps.
**Placeholder scan:** none; all code shown.
**Type consistency:** `emitRadiologyEvent(kind,{tenantId})` identical across emitter/6 sites/test. `RADIOLOGY_CHANNEL="staff:radiology"` consistent across page const/hook/catalog/emitter/tests. `useRealtimeInvalidation(ch, [["radiology"]])` return `{connected,subscribed,denied,lastEventAt}` matches the page destructure. `RadiologyOrder` type fields (`modality`,`created_at`,`body_part`,`clinical_indication`) match the worklist SELECT + the create payload. Form sends `{patient_uid,modality,body_part,clinical_indication,priority,notes}` = backend requireds. Report sends `{report}` = backend `req.body.report`.
