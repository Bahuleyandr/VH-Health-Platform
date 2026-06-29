# Doctor-queue / Appointments Board Real-time (emit backfill + RQ migration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Backfill the missing `staff:appointments` producers so every appointment lifecycle change pushes live, then migrate the admin All-Appointments + Doctor-Queue tabs to react-query and subscribe them.

**Architecture:** Backend task = a reusable `emitAppointmentEvent(kind,{tenantId})` + 6 backfill emits in `appointmentWorkflowController.js` + refactor the existing `appointmentStatusController` emit. Frontend task = migrate 2 tabs to react-query (behavior-preserving) + a page-level `useRealtimeInvalidation`. Channel `staff:appointments` already exists (scope confirmed: RECEPTIONIST is isStaff). Additive (no poll). Emit post-`setTenantTx`-commit, PHI-free `{kind,at}`, explicit tenant.

**Tech Stack:** Node/Express 5 + WS fabric, Next.js 16 + TanStack Query v5, Jest.

**Branch:** `feat/realtime-doctor-queue` (already created off main). Deploy HELD — never tag.

**Parallelism:** Task 1 (backend, `apps/backend/**`) ∥ Task 2 (frontend, `apps/admin/**`). Task 2 is two commits.

---

## Task 1 — Backend: emitter + 6 backfill producers + refactor existing emit (TDD)

**Files:** Create `apps/backend/src/tests/unit/appointmentRealtimeChannel.test.js`, `…/appointmentRealtimeEmitter.test.js`; Modify `realtimeEmitter.js`, `controllers/appointment/appointmentWorkflowController.js`, `controllers/appointment/appointmentStatusController.js`.

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit` · `npm run lint`

- [ ] **Step 1: Failing channel test** — create `apps/backend/src/tests/unit/appointmentRealtimeChannel.test.js`:
```js
import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:appointments channel', () => {
  test('is listed in the channel catalog', () => {
    expect(CHANNEL_CATALOG['staff:appointments']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:appointments'].roles).toBe('staff');
  });
  test('allowed for the front-desk receptionist (isStaff, NOT clinical) + doctor + nurse + admin, denied for patient', () => {
    expect(authorizeChannel('staff:appointments', { role: 'RECEPTIONIST', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:appointments', { role: 'DOCTOR', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:appointments', { role: 'NURSING_STAFF', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:appointments', { role: 'ADMIN', userId: '4' }).allowed).toBe(true);
    expect(authorizeChannel('staff:appointments', { role: 'PATIENT', userId: '5' }).allowed).toBe(false);
  });
  test('SUPER_ADMIN may subscribe (slice-9 bypass)', () => {
    expect(authorizeChannel('staff:appointments', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
  });
});
```
- [ ] **Step 2: Run → likely ALL PASS** (`appointmentRealtimeChannel`): the catalog entry + the prefix logic already exist, so this test should pass immediately — it pins the existing behavior (esp. RECEPTIONIST allowed). That's fine; it is a guard, not red-then-green. Confirm it passes.
- [ ] **Step 3: Failing emitter test** — create `apps/backend/src/tests/unit/appointmentRealtimeEmitter.test.js`:
```js
import { jest } from '@jest/globals';
const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({ broadcast, sendToUser: jest.fn() }));
const { emitAppointmentEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitAppointmentEvent', () => {
  beforeEach(() => jest.clearAllMocks());
  test('broadcasts on staff:appointments with the kind + explicit tenantId', () => {
    emitAppointmentEvent('confirm', { tenantId: 't1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('staff:appointments', expect.objectContaining({ kind: 'confirm' }), { tenantId: 't1' });
  });
  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitAppointmentEvent('walk-in-created', { tenantId: 't1' })).not.toThrow();
  });
});
```
- [ ] **Step 4: Run → FAIL** (`emitAppointmentEvent` undefined).
- [ ] **Step 5:** In `realtimeEmitter.js`, append after `emitRadiologyEvent` (last function):
```js

/** Appointment/queue board change (book / confirm / no-show / complete / cancel / reschedule / walk-in / status). */
export function emitAppointmentEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:appointments', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitAppointmentEvent failed:', err.message);
  }
}
```
(`broadcast`+`logger` already imported — do NOT re-import. Leave `emitQueuePosition` untouched.)
- [ ] **Step 6: Run → PASS** (2 tests).
- [ ] **Step 7: Backfill the 6 workflow producers.** In `appointmentWorkflowController.js`, add `import { emitAppointmentEvent } from '../../utils/websocket/realtimeEmitter.js';` after the existing imports. Then insert the emit on its own line immediately BEFORE each handler's terminal `success(res, ...)` (which is AFTER `await setTenantTx(...)` returns), using the in-scope tenant var:

| Handler | emit line goes before the `success(res,…)` at line | code to insert |
|---|---|---|
| confirmAppointment | 361 | `emitAppointmentEvent('confirm', { tenantId });` |
| markNoShow | 408 | `emitAppointmentEvent('no-show', { tenantId });` |
| rescheduleAppointment | 603 | `emitAppointmentEvent('reschedule', { tenantId });` |
| completeAppointment | 691 | `emitAppointmentEvent('complete', { tenantId });` |
| cancelAppointment | 756 | `emitAppointmentEvent('cancel', { tenantId });` |
| registerWalkIn | 2291 | `emitAppointmentEvent('walk-in-created', { tenantId: actingTenantId });` |

For each: `tenantId` is the local `const tenantId = requireTenantId(req)` already in that handler (confirm@220, no-show@375, reschedule@425, complete@620, cancel@705). registerWalkIn uses `actingTenantId` (the resolved tenant in that handler — confirm the exact var name when you open it; it is the value passed to its `setTenantTx`/the `requireTenantValue` result). Do NOT emit on read handlers (getTodayQueue@960, getPending@1002, history@2435) or `appointmentAdminController`.

- [ ] **Step 8: Refactor the existing emit** in `appointmentStatusController.js`. Add the import `import { emitAppointmentEvent } from '../../utils/websocket/realtimeEmitter.js';`. Replace the inline `broadcast('staff:appointments', { kind: 'status-changed', appointmentId: id, doctorId: …, patientId: …, status: …, at: … });` (~line 125-132) with:
```js
    emitAppointmentEvent('status-changed', { tenantId });
```
Use the handler's tenant var (it computes the tenant via `requireTenantId(req)` or similar — use that local; if the handler doesn't already have a tenant local, add `const tenantId = req.tenantId;` just before). Remove the now-unused `broadcast` import from this file IF it is no longer used elsewhere in the file (grep first; keep it if other call sites remain).

- [ ] **Step 9: Lint + verify.** `npm run lint` → 0. `node --experimental-vm-modules node_modules/jest/bin/jest.js appointmentRealtimeChannel appointmentRealtimeEmitter --forceExit` → 5 pass. `grep -c "emitAppointmentEvent" apps/backend/src/controllers/appointment/appointmentWorkflowController.js` → 7 (6 calls + 1 import); `grep -oE "emitAppointmentEvent\('[a-z-]+'" apps/backend/src/controllers/appointment/appointmentWorkflowController.js` → 6 unique kinds. Then run the appointment UNIT/audit tests that may assert the old broadcast payload: `node --experimental-vm-modules node_modules/jest/bin/jest.js "appointmentStatusAudit|appointmentWorkflow|confirm-appointment-visit-no" --forceExit` — if any asserts the old `broadcast('staff:appointments', {appointmentId,…})` payload, update it to assert the new `emitAppointmentEvent`/`{kind,at}` shape (mock `realtimeEmitter` or `wsServer.broadcast` as that test already does). Do NOT run the `.deep.test.js` (orchestrator runs it vs live PG).
- [ ] **Step 10: Commit:**
```bash
git add apps/backend/src/utils/websocket/realtimeEmitter.js apps/backend/src/controllers/appointment/appointmentWorkflowController.js apps/backend/src/controllers/appointment/appointmentStatusController.js apps/backend/src/tests/unit/appointmentRealtimeChannel.test.js apps/backend/src/tests/unit/appointmentRealtimeEmitter.test.js
git commit -m "feat(realtime): emitAppointmentEvent + backfill 6 staff:appointments producers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2 — Frontend: RQ migration of 2 tabs (Commit A) then subscribe+indicator (Commit B)

**Files:** Modify `appointments/page.tsx`, `components/AllAppointmentsTab.tsx`, `components/DoctorQueueTab.tsx`; Create `apps/admin/src/__tests__/dashboard/appointments/page.test.tsx` (Commit B).

Run (from `apps/admin`): `npm test -- <pattern>` · `npm run type-check` · `npm run lint`

### Commit A — react-query migration (behavior-preserving)

- [ ] **Step A1: Migrate `DoctorQueueTab.tsx`.** Add `import { useQuery } from "@tanstack/react-query";`. Add `const [submittedDoctorId, setSubmittedDoctorId] = useState("");`. Remove `queue`/`loading`/`load`; replace with:
```ts
  const { data: queue = [], isFetching: loading } = useQuery({
    queryKey: ["queue", submittedDoctorId, date],
    queryFn: async () => {
      const res = await getTodayQueueAdmin<unknown>({ doctor_id: submittedDoctorId, ...(date ? { date } : {}) });
      const rows = Array.isArray(res) ? res
        : Array.isArray((res as Record<string, unknown>)?.data) ? (res as Record<string, unknown>).data : [];
      return rows as AppointmentWorkflow[];
    },
    enabled: !!submittedDoctorId,
  });
```
The **Load Queue** button: `onClick={() => { if (!doctorId) { toast.error("Enter a doctor ID"); return; } setSubmittedDoctorId(doctorId); }}`. The empty-state line: change `{doctorId ? "No appointments…" : "Enter a doctor ID…"}` to key off `submittedDoctorId`. Leave `SlotAvailabilityPanel` + the table unchanged. (`getTodayQueueAdmin` takes a params object — keep the existing call shape; confirm its signature in `@/lib/api/appointments`.)

- [ ] **Step A2: Migrate `AllAppointmentsTab.tsx`.** Add `import { useQuery, useQueryClient } from "@tanstack/react-query";`. Replace the `useState`(data/loading) + the `useEffect` block with:
```ts
  const qc = useQueryClient();
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "10");
  const status = searchParams.get("status");
  const search = searchParams.get("search");
  const { data = null, isLoading: loading } = useQuery({
    queryKey: ["appointments", refreshKey, page, limit, status, search, sortBy, sortOrder],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("page", String(page)); params.set("limit", String(limit));
      params.set("sortBy", sortBy); params.set("sortOrder", sortOrder.toUpperCase());
      if (status) params.set("status", status);
      if (search) params.set("search", search);
      const res = await fetchAdminAPI<unknown>(`/appointments/list?${params}`);
      return normalizeAppointmentsResponse(res, page, limit);
    },
  });
```
In `doAction`, replace `router.refresh();` with `qc.invalidateQueries({ queryKey: ["appointments"] });`. Keep `useRouter`/`router` (still used by `setSort`'s `router.push`). Keep `acting` state + the toasts. Everything else (filters/sort/table/pagination) unchanged.

- [ ] **Step A3: Gates.** `npm run type-check` → 0; `npm run lint` → 0; `npm test 2>&1 | tail -5` → full suite green (the existing `WalkInDialog.test.tsx`/`helpers.test.tsx` still pass). Fix any unused-import (`useEffect`/`useMemo` may still be used — check) without changing behavior.
- [ ] **Step A4: Commit A:**
```bash
git add "apps/admin/src/app/(with-auth)/dashboard/appointments/components/DoctorQueueTab.tsx" "apps/admin/src/app/(with-auth)/dashboard/appointments/components/AllAppointmentsTab.tsx"
git commit -m "refactor(appointments): migrate Doctor-Queue + All-Appointments tabs to TanStack Query

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Commit B — subscribe + indicator + page test

- [ ] **Step B1:** In `appointments/page.tsx`: add `import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";` (after the existing imports) + a module const `const APPOINTMENTS_CHANNEL = "staff:appointments";` (below imports). In `AppointmentsPageContent`, after the `useState` declarations, add:
```tsx
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(APPOINTMENTS_CHANNEL, [["appointments"], ["queue"]]);
  const liveLabel = subscribed ? "● Live" : connected ? "○ Connecting" : "○ Offline";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:appointments — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:appointments"
    : connected ? "Connecting…" : "Offline — refresh manually (real-time unavailable)";
```
Replace `<h2 className="text-2xl font-bold">Appointment Management</h2>` with:
```tsx
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-bold">Appointment Management</h2>
          <span data-testid="appointments-realtime-indicator" role="status"
            aria-label={subscribed ? "Live — real-time appointment updates active" : "Offline — real-time updates unavailable"}
            title={liveTitle}
            className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}>
            {liveLabel}
          </span>
        </div>
```
- [ ] **Step B2:** Create `apps/admin/src/__tests__/dashboard/appointments/page.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import AppointmentsPage from "@/app/(with-auth)/dashboard/appointments/page";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));
jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn().mockResolvedValue({ data: [] }) }));
jest.mock("@/lib/api/appointments", () => ({
  getTodayQueueAdmin: jest.fn().mockResolvedValue([]),
  getAvailableSlots: jest.fn().mockResolvedValue({ available: true, slots: [] }),
  confirmAppointmentAdmin: jest.fn(), completeAppointmentAdmin: jest.fn(),
  markNoShowAdmin: jest.fn(), cancelAppointmentAdmin: jest.fn(),
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

describe("<AppointmentsPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
  });
  it("subscribes to staff:appointments on [appointments]+[queue] roots and shows ○ Offline when down", async () => {
    renderWithQuery(<AppointmentsPage />);
    const ind = await screen.findByTestId("appointments-realtime-indicator");
    expect(ind).toHaveTextContent("Offline");
    expect(mockRealtime).toHaveBeenCalledWith("staff:appointments", [["appointments"], ["queue"]]);
  });
  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<AppointmentsPage />);
    expect(await screen.findByTestId("appointments-realtime-indicator")).toHaveTextContent("Live");
  });
});
```
(If the default Overview/SLA tab renders heavy children that need more mocks, mock `./components/SlaOverviewTab` to a stub — the test only needs the indicator + the hook call.)
- [ ] **Step B3: Gates.** `npm test -- "appointments/page"` → 2 pass; `npm run type-check` → 0; `npm run lint` → 0. `connected`+`lastEventAt` both used in liveTitle.
- [ ] **Step B4: Commit B:**
```bash
git add "apps/admin/src/app/(with-auth)/dashboard/appointments/page.tsx" "apps/admin/src/__tests__/dashboard/appointments/page.test.tsx"
git commit -m "feat(realtime): subscribe Appointments board to staff:appointments + Live indicator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3 — Whole-branch gates + review + merge (orchestrator-run)

- [ ] **Step 1:** Backend: `npm run lint`; `jest "Channel|RealtimeEmitter|appointmentRealtime" --forceExit`; then `DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test … jest "appointment-deep|appointment-admin-correctness|appointment-double-booking|appointment-list-tenant" --forceExit` → must stay green (emits side-effect-free). Admin: `npm run lint`; `npm run type-check`; `npm test`; `npm run build`.
- [ ] **Step 2: Final adversarial review** (multi-lens: channel scope incl. RECEPTIONIST-isStaff + the existing-emit refactor; the 6 backfill emits post-commit; the 2-tab RQ migration behavior-preservation incl. the doAction→invalidate + DoctorQueue submitted-trigger; pattern consistency). Verify findings before merge.
- [ ] **Step 3: Finish the branch** — merge `--no-ff` → push `github` + `origin` main → delete branch. Deploy HELD — no tag.
- [ ] **Step 4: Update memory** — slice 13 block (first BACKFILL slice; existing channel + Flutter consumer ignores payload → minimal `{kind,at}`; RECEPTIONIST isStaff confirmed; 2-tab migration) + MEMORY.md index (12→13) + scout backlog (epic's main scout list now exhausted — note remaining lower-ranked candidates or "epic substantially complete").

---

## Self-Review (against the spec)
**Spec coverage:** §4.2 emitter→T1 S5; §4.3 6 backfill→T1 S7 + existing-emit refactor→T1 S8; §4.1 channel (no change, test)→T1 S1; §5.1 DoctorQueue migration→T2 A1; §5.2 AllAppointments migration→T2 A2; §5.3 page subscribe→T2 B1; §6 tenancy→explicit tenantId at every site + emitter test; §7 tests→T1 S1/S3, T2 B2 + appointment-deep regression (T3 S1). No gaps.
**Placeholder scan:** none; all code shown; the 6 backfill sites enumerated with exact lines.
**Type consistency:** `emitAppointmentEvent(kind,{tenantId})` identical across emitter/6 sites/refactor/test. `APPOINTMENTS_CHANNEL="staff:appointments"` consistent. `useRealtimeInvalidation(ch,[["appointments"],["queue"]])` return `{connected,subscribed,denied,lastEventAt}` matches the page destructure. Query keys `["appointments",…]` + `["queue",…]` both prefix-covered by the two invalidation roots. `doAction` invalidates `["appointments"]`; DoctorQueue uses `["queue",submittedDoctorId,date]`.
