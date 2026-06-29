# Real-time dashboards — Slice 13: Doctor-queue / appointments board (`staff:appointments` emit backfill) + RQ migration

- **Date:** 2026-06-29
- **Epic:** #4 Real-time-first dashboards
- **Status:** Design approved → spec
- **Builds on:** the event-driven `useRealtimeInvalidation` recipe. **First BACKFILL slice** — the `staff:appointments` channel already exists and has ONE consumer (the Flutter staff app) + ONE producer; the queue's lifecycle handlers emit nothing. This slice extracts a reusable emitter, backfills the missing producers, and migrates the admin tabs to react-query so they go live.

## 1. Context & goal

The `staff:appointments` channel already exists (`CHANNEL_CATALOG`, `roles:'staff'`) and the **Flutter staff appointments screen already subscribes** to it (`apps/staff/.../appointments_screen.dart:226` — `rt.events('staff:appointments').listen((_) {…}` — it discards the payload and uses the event as a debounced refetch trigger). But only ONE producer emits today: `appointmentStatusController.updateAppointmentStatus` (a generic status PATCH) does an inline `broadcast('staff:appointments', {kind:'status-changed', …})`. The **queue lifecycle handlers** (`confirm`/`no-show`/`complete`/`cancel`/`reschedule`/`walk-in`, in `appointmentWorkflowController.js`) emit **nothing** — so a confirm/walk-in/complete does NOT push live to the staff app or the admin board.

On the admin side, the **Appointment Management** page (`apps/admin/.../dashboard/appointments/page.tsx`, 6-tab orchestrator) shows the queue in two tabs: **All Appointments** (`AllAppointmentsTab` — the list + row actions) and **Doctor Queue** (`DoctorQueueTab` — load a doctor's day queue). Both use raw `useState`/`useEffect`/`fetch` (no react-query) and manual refresh (`router.refresh()` / a `refreshKey` prop), so they can't be driven by `useRealtimeInvalidation`.

**Goal:** (1) backfill the missing producers so every appointment lifecycle change pushes live (benefiting the Flutter staff app immediately); (2) migrate the two admin tabs to react-query and subscribe them, so the admin queue + list go live too.

## 2. Scope

**In scope (one branch, two commits)**
- **Commit A — backend backfill** (`apps/backend`): new reusable `emitAppointmentEvent(kind, { tenantId })` emitter; backfill it into the **6 lifecycle handlers** in `appointmentWorkflowController.js`; refactor the existing inline `updateAppointmentStatus` broadcast to use it (`status-changed`) — unifying the channel on a minimal PHI-free `{kind, at}` payload + explicit tenant scoping.
- **Commit B — admin RQ migration + subscribe** (`apps/admin`): migrate `AllAppointmentsTab` (read → `useQuery`; `doAction` mutations → invalidate `["appointments"]` instead of `router.refresh()`) and `DoctorQueueTab` (load → `useQuery`, click-to-load preserved via a submitted trigger) to react-query; add one page-level `useRealtimeInvalidation("staff:appointments", [["appointments"],["queue"]])` + a `●Live/○Connecting/○Offline` indicator.
- Tests: channel RBAC (incl. RECEPTIONIST), emitter, page wiring; `appointment-deep.test.js` as a regression guard.

**Out of scope (YAGNI)**
- No new poll / cadence helper — neither tab polls today; realtime is purely additive (WS-down behavior == today's manual refresh).
- No change to the `patient:<uid>:*` channels (un-wired; separate phase). No change to `emitQueuePosition` (patient-facing, orthogonal — leave it).
- No migration of the other 4 tabs (overview/SLA, documents, prescriptions, audit) — separate surfaces.
- No RBAC cleanup — `staff:appointments` scope is already correct (§4.1). No new order-form/UX changes.
- The walk-in/book dialogs keep their `refreshKey` mechanism (kept in the `AllAppointmentsTab` query key, so the bump still refetches; realtime invalidation is additive).

## 3. Architecture & data flow

```
appointment lifecycle write (staff/reception client):
  POST /appointments/:id/confirm     (confirmAppointment)        ─┐
  POST /appointments/:id/no-show     (markNoShow)                 │
  POST /appointments/:id/complete    (completeAppointment)        │  (after setTenantTx
  POST /appointments/:id/cancel      (cancelAppointment)          ├─  commits, before
  POST /appointments/:id/reschedule  (rescheduleAppointment)      │   success())
  POST /appointments/walk-in         (registerWalkIn)             │
  PATCH …/status                     (updateAppointmentStatus)   ─┘  (refactored to the emitter)
                                                                  └─> emitAppointmentEvent(kind, { tenantId })
                                                                        └─> broadcast('staff:appointments', {kind,at}, {tenantId})
                                                                              │  (Redis fan-out, per-broadcast tenant filter)
                                          ┌───────────────────────────────────┴──────────────────────────┐
                                          ▼                                                                ▼
   Flutter staff appointments screen (already subscribes → debounced refetch)      AppointmentsPage useRealtimeInvalidation
                                                                                    ('staff:appointments', [["appointments"],["queue"]])
                                                                                       └─> All Appointments + Doctor Queue refetch
```

## 4. Backend (Commit A)

### 4.1 Channel — `apps/backend/src/utils/websocket/channelAuth.js` (NO change — already present)
`'staff:appointments': { description: 'Appointment + queue status changes (staff view)', roles: 'staff' }` already exists. **Scope = `staff:` (isStaff), confirmed correct by computation.** The REST gate is `app.js` `requireRole(...APPOINTMENT_ROUTE_ROLES)` — a broad 44-role set. The PRIMARY queue user **`RECEPTIONIST` (front-desk) is `isStaff=true, isClinical=false`** → `staff:` admits it, `staff:clinical:` would deny it. Every "not isStaff" role in the route set is excluded (PATIENT — uses `patient:*`), bypassed (SUPER_ADMIN — slice-9 `authorizeChannel` bypass), or a capability-graph-only artifact absent from `roles.js` (BLOOD_BANK_STAFF, ICU_*, PHARMACIST, ER_STAFF, SENIOR_DOCTOR) — so **no real assignable role is denied, no RBAC cleanup needed**. Over-grant is minimal (the route is already ~44 roles). (The channel-RBAC test is new — there isn't a dedicated one yet.)

### 4.2 Emitter — `apps/backend/src/utils/websocket/realtimeEmitter.js`
Append after `emitRadiologyEvent` (last function):
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
Minimal PHI-free `{kind, at}` nudge — the only consumer (Flutter staff app) ignores the payload, and the admin board invalidates on any event. Internal try/catch → never throws into the write. **Note:** `emitQueuePosition` (patient-facing `sendToUser`) stays as-is — separate concern.

### 4.3 Producers — backfill `appointmentWorkflowController.js` (import + 6 sites) + refactor the existing emit
Import `emitAppointmentEvent` in both controllers. Each workflow handler runs `const tenantId = requireTenantId(req)` (walk-in uses `actingTenantId`), then `await setTenantTx(tenantId, …)`, then `success(res, …)`. Insert the emit **after `setTenantTx` returns (post-commit) and before `success(...)`**, with the in-scope tenant var.

| # | Handler | file:line of `success()` | tenant var | `kind` |
|---|---|---|---|---|
| 1 | confirmAppointment | `appointmentWorkflowController.js:361` | `tenantId` | `confirm` |
| 2 | markNoShow | `:408` | `tenantId` | `no-show` |
| 3 | rescheduleAppointment | `:603` | `tenantId` | `reschedule` |
| 4 | completeAppointment | `:691` | `tenantId` | `complete` |
| 5 | cancelAppointment | `:756` | `tenantId` | `cancel` |
| 6 | registerWalkIn | `:2291` | `actingTenantId` | `walk-in-created` |

Example (site 1, before line 361):
```js
    emitAppointmentEvent('confirm', { tenantId });
    success(res, result[0], `Appointment confirmed. Token #${tokenNumber}`);
```
**Refactor the existing emit** in `appointmentStatusController.js` (the inline `broadcast('staff:appointments', {kind:'status-changed', appointmentId, doctorId, patientId, status, at})` ~line 125) → `emitAppointmentEvent('status-changed', { tenantId })` (drop the now-unused id/status payload fields; the consumer ignores them — this is a PHI reduction + adds explicit tenant scoping). Use the handler's tenant var (`requireTenantId(req)` / the resolved tenant). Update any test that asserts the old broadcast payload shape to assert the new `{kind, at}` shape.

Do **NOT** emit on read handlers (`getTodayQueue`, `getPending`, history) or `appointmentAdminController` (read-only).

## 5. Frontend (Commit B)

### 5.1 `DoctorQueueTab.tsx` — load → useQuery (click-to-load preserved)
Add a `submittedDoctorId` state; the **Load Queue** button sets `submittedDoctorId = doctorId`. Replace `queue`/`loading`/`load()` with:
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
The button: `onClick={() => { if (!doctorId) { toast.error("Enter a doctor ID"); return; } setSubmittedDoctorId(doctorId); }}`. The empty-state text keys off `submittedDoctorId`. `SlotAvailabilityPanel` is untouched (orthogonal availability, not the queue). Now `useRealtimeInvalidation(["queue"])` refetches the loaded queue live.

### 5.2 `AllAppointmentsTab.tsx` — read → useQuery; mutations → invalidate
Replace the `useEffect`+`fetch`+`data`/`loading` with a `useQuery` keyed on the same inputs (keep `refreshKey` in the key so the parent's bump still refetches):
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
In `doAction`, replace `router.refresh()` with `qc.invalidateQueries({ queryKey: ["appointments"] })` (keep the `acting` per-row disable + toasts). Drop the now-unused `useRouter` read-refresh (keep `router` for `setSort`'s `router.push`). The error path: `useQuery` returns `data=null` on error (matches the old `catch → setData(null)`).

### 5.3 `page.tsx` (orchestrator) — subscribe + indicator
In `AppointmentsPageContent`:
- `import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";` + module const `const APPOINTMENTS_CHANNEL = "staff:appointments";`.
- `const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(APPOINTMENTS_CHANNEL, [["appointments"], ["queue"]]);`
- A `●Live/○Connecting/○Offline` indicator (`data-testid="appointments-realtime-indicator"`, role=status, aria-label + title) next to the `<h2>Appointment Management</h2>` (wrap them in a `flex items-center gap-2`).

No cadence helper (no poll). The `[["appointments"],["queue"]]` roots prefix-cover both tabs' query keys.

## 6. Tenant scoping & PHI
`appointments` + `appointment_queues` + `appointment_status_history` are tenant-scoped (`tenant_id`, RLS from migrations 075/236). The workflow handlers resolve tenant via `requireTenantId(req)` (walk-in: `actingTenantId` from `requireTenantValue(req.user?.tenant_id)`) and run inside `setTenantTx`. The emit passes that same `tenantId` explicitly (a correctness improvement over the old inline emit, which passed none and relied on the ALS fallback). WS payload is `{kind, at}` only — **no PHI** (no patient/doctor id, no name, no status). Both consumers refetch through the RBAC-gated REST endpoints.

## 7. Testing
- **`apps/backend/src/tests/unit/appointmentRealtimeChannel.test.js`** — `CHANNEL_CATALOG['staff:appointments']` defined, `roles:'staff'`; `authorizeChannel('staff:appointments', {role})` allowed for `RECEPTIONIST` (the isStaff-not-clinical front-desk case — the key assertion), `DOCTOR`, `NURSING_STAFF`, `ADMIN`; denied for `PATIENT`; allowed for `SUPER_ADMIN`.
- **`apps/backend/src/tests/unit/appointmentRealtimeEmitter.test.js`** — mocks `wsServer.js`, imports the real `realtimeEmitter`; `emitAppointmentEvent('confirm', { tenantId: 't1' })` calls `broadcast` once with `'staff:appointments'`, `{kind:'confirm',…}`, `{tenantId:'t1'}`; never throws when `broadcast` throws.
- **Backend regression:** run `appointment-deep.test.js` (+ any test asserting the old `updateAppointmentStatus` broadcast payload — update it to the `{kind,at}` shape) (DB-gated on QA PG `:55432`) — the backfill emits are post-commit, side-effect-free on responses, must stay green.
- **`apps/admin/src/__tests__/dashboard/appointments/page.test.tsx`** (new) — wrap in `QueryClientProvider`; mock `@/lib/api` + `@/lib/api/appointments` + `@/hooks/useRealtimeInvalidation` (+ the heavy child tabs as needed, or render only the default Overview tab); assert the hook called with `("staff:appointments", [["appointments"],["queue"]])` and the indicator renders `○ Offline` when down and `● Live` when subscribed.
- **Honest limit:** live WS push not auto-tested (no WS in jsdom); tests cover channel RBAC, emitter, indicator, wiring. Manual recipe in §9.

## 8. Risks
| Risk | Mitigation |
|---|---|
| Channel denies a real queue user | `staff:` admits RECEPTIONIST/front-desk (isStaff); computed + asserted in the channel test. |
| Refactoring the existing emit breaks a payload-asserting test | The new payload is `{kind, at}`; update the asserting test to match (intentional PHI reduction). Flutter consumer ignores the payload. |
| Emit blocks/breaks an appointment write | Emitter try/catches; emit is post-`setTenantTx`-commit, side-effect-free on the response. `appointment-deep.test.js` re-run as a guard. |
| RQ migration changes tab behavior | Behavior-preserving: same endpoints, same normalize/unwrap, same row-action UX; `doAction` invalidates `["appointments"]` (replaces `router.refresh()`); `refreshKey` kept in the query key so dialog-success still refetches. DoctorQueueTab keeps click-to-load via `submittedDoctorId`. |
| Walk-in handler is huge (2441-LOC controller) | Emit is a single line at the one `success()` (line 2291) after the tx; no logic change. |

## 9. Manual verification (deploy HELD)
1. `cd apps/backend && npm run dev` + `cd apps/admin && npm run dev`.
2. Open `/dashboard/appointments`; confirm the All Appointments + Doctor Queue tabs load via react-query and the indicator shows `● Live` once subscribed.
3. In a second tab (or via the Flutter staff app), confirm/complete/cancel an appointment or register a walk-in; confirm the first tab's list/queue updates within ~1s with no manual Refresh.
4. Stop the backend; confirm the indicator falls to `○ Offline` and the tabs still work via manual refresh/reload.
