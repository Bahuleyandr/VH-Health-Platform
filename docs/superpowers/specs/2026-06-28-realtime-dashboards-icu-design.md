# Real-time dashboards — Slice 5: ICU Command Centre (`staff:icu-board`)

- **Date:** 2026-06-28
- **Epic:** #4 Real-time-first dashboards
- **Status:** Design approved → spec
- **Builds on:** Slices 1 (beds) + 2 (ED) + 4 (OR Board) — same **event-driven** `useRealtimeInvalidation` recipe. (Slice 3 Operations used the broadcast-snapshot variant; ICU is event-driven because its tab queries are parameterized by admission/status/hours/filter — each client refetches its own view.)

## 1. Context & goal

The admin **ICU Command Centre** (`apps/admin/src/app/(with-auth)/dashboard/icu/page.tsx`) is a thin tab
orchestrator over four tabs — **Admissions** (`["icu","admissions",statusFilter]`, polls 30s), **Flowsheet**
(`["icu","flowsheet",admissionId,hours]` polls 30s + `["icu","io",admissionId]` no poll), **Assessments**
(`["icu","assessments",admissionId,filter]`, polls 60s), **ABCDEF Bundle** (`["icu","bundle",admissionId,day]`,
no poll). It is the highest-acuity board on the platform (flowsheet vitals, vasopressor drips, RASS/CAM-ICU/
SOFA/CPOT, code status DNR/Comfort, the SCCM ABCDEF bundle), and concurrent bedside charting is the norm —
so cross-user freshness matters more than almost anywhere. Today every tab is poll-or-manual; a code-status
flip or a new flowsheet entry can lag 30–60s for another viewer.

**Goal:** convert it to **event-driven real-time** by reusing the slice-1/2/4 recipe — a new WS channel
`staff:icu-board` with producers at the board-visible ICU write sites; the page subscribes once and invalidates
the `["icu"]` query family on each event. New admissions, code-status changes, discharges, flowsheet/assessment/
bundle writes push instantly; strict improvement with a relaxed safety poll; identical original cadence when WS
is down.

## 2. Scope

**In scope**
- New `staff:icu-board` channel.
- A backend emitter `emitIcuBoardEvent` + producer calls at **7** board-visible `icuRoutes.js` handlers.
- Frontend: subscribe via `useRealtimeInvalidation` on `[["icu"]]`, a relaxed live poll (cadence helper),
  a `●Live/○Polling` indicator.
- Tests: channel RBAC, emitter, cadence helper, page wiring.

**Out of scope (YAGNI)**
- `PATCH /admissions/:id/monitoring-interval` and `PATCH /admissions/:id` (fasting/NPO) are **not** producers
  — neither field is rendered on any tab today, so they aren't board-visible. (Easy to add later if surfaced.)
- The `["icu","io"]` and `["icu","bundle"]` queries have no poll today; they get real-time push (strict
  improvement) but no new fallback poll is introduced (no regression when WS is down).
- No change to the ICU data model, the tab UIs (beyond the cadence thread-through), or the routes' behaviour.
- The **staff Flutter app** is a natural future `staff:icu-board` consumer — not wired here.
- No new persisted rows (ephemeral WS only; canonical-timeline invariant untouched).

## 3. Architecture & data flow

```
ICU write (any client) ──> icuRoutes handler ──> icuService (mutation)
                                   │
                                   └─(after the await, inside wrap's try)─> emitIcuBoardEvent(kind, { admissionId, status, tenantId })
                                                                              └─> broadcast('staff:icu-board', {kind,…}, { tenantId })
                                                                                    │ (Redis fan-out, per-broadcast tenant filter)
                                                                                    ▼
admin browser ──ws──> useRealtimeInvalidation('staff:icu-board', [["icu"]]) ──> invalidate ["icu"]
                                                                                  └─> react-query refetches the mounted tab's ["icu",…] query ──> board repaints
```

The WS push is a **PHI-free signal to invalidate** (kind + admissionId + status, no clinical values); the
existing query functions refetch the authoritative data through the RBAC-guarded routes, so there's one source
of truth.

## 4. Backend design

### 4.1 Channel (`apps/backend/src/utils/websocket/channelAuth.js`)
Add to `CHANNEL_CATALOG` (near the other `staff:` entries, e.g. after `staff:or-board`):
```js
'staff:icu-board': { description: 'ICU command centre — admissions, code status, flowsheet, assessments, ABCDEF bundle', roles: 'staff' },
```
No `authorizeChannel` change: every `icuRoutes.js` route gates on `requireStaffOrAdmin` (isStaff‖isAdmin), so
`staff:*` → `isStaff` is the **correct, exact** audience match (admits clinical + ops staff + admins). Using
`staff:clinical:` would WRONGLY deny non-clinical staff who legitimately hit these routes (DELTA-002). Same
gate + scope precedent as the shipped `staff:ed-board`. The emit carries no PHI.

### 4.2 Emitter (`apps/backend/src/utils/websocket/realtimeEmitter.js`)
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
Mirrors `emitOrBoardEvent`/`emitEdBoardEvent`; internal try/catch → never throws into the handler.

### 4.3 Producers — `apps/backend/src/routes/clinical/icuRoutes.js`
These handlers use the `wrap(async (req) => icu.X(...))` form (the handler **returns** data; `wrap` calls
`success`). To emit, convert the concise arrow to a block that captures `tenantId` once, awaits the service,
emits best-effort, and returns the row. The emit is inside `wrap`'s try (a thrown `tenantOf`/service error is
still caught) and `emitIcuBoardEvent` never throws.

| Handler | kind | admissionId | status |
|---|---|---|---|
| `POST /admissions` → `createAdmission` | `'admitted'` | `row?.id` | `row?.status` |
| `POST /admissions/from-er/:emergencyVisitId` → `createAdmissionFromEr` | `'admitted'` | `row?.id` | `row?.status` |
| `PATCH /admissions/:id/code-status` → `updateAdmissionCodeStatus` | `'code-status'` | `Number(req.params.id)` | `req.body.code_status` |
| `POST /admissions/:id/discharge` → `dischargeAdmission` | `'discharged'` | `Number(req.params.id)` | `row?.status` |
| `POST /admissions/:id/flowsheet` → `logFlowsheet` | `'flowsheet'` | `Number(req.params.id)` | — |
| `POST /admissions/:id/assessments` → `recordAssessment` | `'assessment'` | `Number(req.params.id)` | — |
| `POST /admissions/:id/bundle` → `upsertBundle` | `'bundle'` | `Number(req.params.id)` | — |

Reference conversion (createAdmission):
```js
router.post('/admissions', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await icu.createAdmission({ tenantId, ...req.body });
  emitIcuBoardEvent('admitted', { admissionId: row?.id, status: row?.status, tenantId });
  return row;
}));
```
Tenant via `tenantOf(req)` (= `resolveTenantOrThrow(req)`), same as the OR-board slice. **Not** wired:
`PATCH /admissions/:id/monitoring-interval`, `PATCH /admissions/:id` (fasting) — fields not on any tab.

## 5. Frontend design

### 5.1 Cadence helper — new `apps/admin/src/app/(with-auth)/dashboard/icu/realtime.ts`
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

### 5.2 Page wiring — `icu/page.tsx`
- Import `useRealtimeInvalidation`, `ICU_BOARD_CHANNEL`.
- In `ICUPage`, after the `useState`s:
  `const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(ICU_BOARD_CHANNEL, [["icu"]]);`
  (one root-prefix key invalidates every `["icu",…]` tab query; the mounted tab refetches, others go stale and
  refetch on remount — harmless.)
- Pass `subscribed` down to the three polling tabs: `<AdmissionsTab … subscribed={subscribed} />`,
  `<FlowsheetTab admissionId={…} subscribed={subscribed} />`, `<AssessmentsTab admissionId={…} subscribed={subscribed} />`.
  (`BundleTab` has no poll → unchanged.)
- Add a `●Live/○Polling` indicator next to the `<h1>` (same markup as `or-board/page.tsx`):
  `data-testid="icu-realtime-indicator"`, `role="status"`, `aria-label`, `title` (shows "Real-time via
  staff:icu-board — last update …" / "Connecting…" / "Polling (real-time unavailable)"). Keep the existing
  subtitle.

### 5.3 Tab cadence thread-through (3 components)
Each polling tab adds `subscribed: boolean` to its props and swaps its literal `refetchInterval`:
- `AdmissionsTab.tsx`: props `{ activeAdmissionId, onSelect, onJumpToFlowsheet, subscribed }`; the admissions
  query `refetchInterval: 30_000` → `refetchInterval: icuRefetchMs(subscribed, 30_000)`.
- `FlowsheetTab.tsx`: props `{ admissionId, subscribed }`; the flowsheet query `refetchInterval: 30_000` →
  `refetchInterval: icuRefetchMs(subscribed, 30_000)`. (Leave the `["icu","io"]` query — no interval.)
- `AssessmentsTab.tsx`: props `{ admissionId, subscribed }`; the assessments query `refetchInterval: 60_000`
  → `refetchInterval: icuRefetchMs(subscribed, 60_000)`.
Each imports `icuRefetchMs` from `../realtime`.

## 6. Tenant scoping
Each emit passes `{ tenantId: tenantOf(req) }` explicitly (and the request ALS context backs it up), so the
per-broadcast tenant filter delivers each signal only to that tenant's ICU staff. No cross-tenant
invalidation-signal leak. (Matches OR/ED + DELTA-002.)

## 7. Testing
- **Backend** `icuBoardChannel.test.js` — `CHANNEL_CATALOG['staff:icu-board']` present with `roles:'staff'`;
  `authorizeChannel('staff:icu-board', …)` allowed for `NURSING_STAFF`/`DOCTOR`/`ADMIN`, denied for `PATIENT`.
- **Backend** `icuBoardEmitter.test.js` (ESM-mock `wsServer`) — `emitIcuBoardEvent('code-status', {admissionId,
  status, tenantId})` broadcasts `'staff:icu-board'` with the payload + `{tenantId}`; never throws when
  `broadcast` throws.
- **Frontend** `icu/realtime.test.ts` — `icuRefetchMs(true, 30_000)===120_000`, `icuRefetchMs(false, 30_000)===30_000`,
  `icuRefetchMs(false, 60_000)===60_000`.
- **Frontend** `icu/page.test.tsx` — `jest.mock("@/hooks/useRealtimeInvalidation")` + mock the 4 tab child
  components to stubs; assert the hook is called with `(ICU_BOARD_CHANNEL, [["icu"]])`; indicator shows
  Polling when not subscribed, Live when subscribed.
- **Producer wiring:** no new automated test (route-handler wiring; the emit logic is covered by
  `icuBoardEmitter.test.js`, and mounting `icuRoutes` needs auth/DB scaffolding) — verified by `npm run lint`
  + the channel/emitter unit tests. Same precedent as ED/OR slices.

**Honest limitations:** live WS push not auto-tested (no WS in jsdom; deploy HELD) — same as slices 1/2/4.

## 8. Resilience / error handling
- Emit is best-effort, post-mutation, non-blocking (`emitIcuBoardEvent` try/catches internally — matches the
  `emitBedEvent`/`emitEdBoardEvent`/`emitOrBoardEvent` precedent and the CLAUDE.md Phase-1.5 rule). A WS
  failure can never abort an ICU clinical write.
- WS bus is at-most-once; the relaxed 120s live safety poll backstops a dropped event (and the no-poll
  io/bundle queries still refetch on the next `["icu"]` event/remount).
- No new auth surface (`staff:*` → `isStaff`). PHI stays in the RBAC-guarded REST refetch, not the channel.

## 9. Verification
- **Gates:** admin `type-check`/`lint`/`test`/`build`; backend `lint` + the new `icuBoardChannel`/
  `icuBoardEmitter` unit tests (no DB needed; full backend integration suite is DB-gated, out of scope here).
- **Manual live-WS check (deploy HELD → local):** open the ICU board (`●Live`); from a second client
  `PATCH /icu/admissions/:id/code-status` (or log a flowsheet entry); the board repaints within ~1s without
  waiting for the poll; kill the WS → `○Polling` + the original 30/60s poll resumes.

## 10. File-change inventory
- `apps/backend/src/utils/websocket/channelAuth.js` — +1 catalog entry.
- `apps/backend/src/utils/websocket/realtimeEmitter.js` — +`emitIcuBoardEvent`.
- `apps/backend/src/routes/clinical/icuRoutes.js` — import + 7 emit calls (concise-arrow → block conversions).
- `apps/backend/src/tests/unit/icuBoardChannel.test.js` — new.
- `apps/backend/src/tests/unit/icuBoardEmitter.test.js` — new.
- `apps/admin/src/app/(with-auth)/dashboard/icu/realtime.ts` — new.
- `apps/admin/src/app/(with-auth)/dashboard/icu/page.tsx` — hook + indicator + pass `subscribed`.
- `apps/admin/src/app/(with-auth)/dashboard/icu/components/AdmissionsTab.tsx` — `subscribed` prop + `icuRefetchMs`.
- `apps/admin/src/app/(with-auth)/dashboard/icu/components/FlowsheetTab.tsx` — `subscribed` prop + `icuRefetchMs`.
- `apps/admin/src/app/(with-auth)/dashboard/icu/components/AssessmentsTab.tsx` — `subscribed` prop + `icuRefetchMs`.
- `apps/admin/src/__tests__/dashboard/icu/realtime.test.ts` — new.
- `apps/admin/src/__tests__/dashboard/icu/page.test.tsx` — new.

## 11. Risks
| Risk | Mitigation |
|---|---|
| Channel scope mismatch (DELTA-002) | `staff:icu-board` (isStaff) matches the route's `requireStaffOrAdmin` gate — NOT `staff:clinical:`. Asserted in the channel test. |
| Cross-tenant signal leak | Explicit `{ tenantId: tenantOf(req) }` on each broadcast + per-broadcast tenant filter. |
| Emit blocks an ICU write | Emitter try/catches; post-mutation, non-blocking. |
| Relaxed poll → staler fallback if a WS event drops | 120s live poll backstops a dropped event (vs 30/60s today); push normally makes it instant; reverts to original cadence when WS down. |
| Adding the hook breaks the page test | New `icu/page.test.tsx` mocks the hook + tab children from the start. |
| Threading `subscribed` touches 3 tab components | Minimal (one prop + one `refetchInterval` swap each); `subscribed` defaults to the same poll when not subscribed, so behaviour is unchanged when WS is down. |
