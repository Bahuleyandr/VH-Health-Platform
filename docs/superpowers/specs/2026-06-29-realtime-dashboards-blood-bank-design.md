# Real-time dashboards — Slice 11: Blood Bank board (`staff:blood-bank`) + react-query migration

- **Date:** 2026-06-29
- **Epic:** #4 Real-time-first dashboards
- **Status:** Design approved → spec
- **Builds on:** the event-driven `useRealtimeInvalidation` recipe (route-layer emits like micro/dialysis; purely-additive no-poll like incidents). **The first slice that needs a react-query migration first** — the page uses raw `useState`/`useEffect`/`fetch`. Bundled into one branch (two commits) because the migration is small.

## 1. Context & goal

The admin **Blood Bank** board (`apps/admin/src/app/(with-auth)/dashboard/blood-bank/page.tsx`, 378 LOC, single file) is a three-tab orchestrator: **Inventory** (aggregated units-available per blood group), **Pending Requests** (request list + cross-match/issue/transfused actions), **New Request** (create form). Unlike every prior board it does **not** use TanStack Query — each tab has its own `useState`+`useEffect`+`fetch` with a manual `load()` and a Refresh button; mutations call `load()` to refetch. There is **no polling** today.

Because real-time delivery here is `useRealtimeInvalidation` → `queryClient.invalidateQueries`, the board must first be on react-query. So this slice is **two commits on one branch**: (1) migrate the three tabs to `useQuery`/`useMutation` (behavior-preserving), then (2) add the `staff:blood-bank` channel + producers + the subscribe hook.

**Goal:** push the board live — any blood-bank write (request lifecycle, unit lifecycle, transfusion closed-loop) invalidates the `["blood-bank"]` root so Inventory + Pending refresh the moment anything changes, with no manual Refresh.

## 2. Scope

**In scope**
- **Commit 1 — RQ migration** (`apps/admin`): InventoryTab → `useQuery(["blood-bank","inventory"])`; PendingRequestsTab → `useQuery(["blood-bank","pending"])` + a `useMutation` for the cross-match/issue/transfused actions; NewRequestTab → a `useMutation` for create. Mutations `invalidateQueries(["blood-bank"])`. Refresh buttons call the query's `refetch`. UX preserved (inline error div on query error; `alert()` on mutation error — no new toast).
- **Commit 2 — realtime:** new `staff:blood-bank` channel + `emitBloodBankEvent(kind,{tenantId})` + **10 route-layer producers** in `bloodBankRoutes.js` (the user-approved "all 10"). Frontend: one `useRealtimeInvalidation("staff:blood-bank", [["blood-bank"]])` in `BloodBankContent` + a `●Live/○Connecting/○Offline` indicator.
- Tests: channel RBAC, emitter, page wiring.

**Out of scope (YAGNI)**
- No new poll / cadence helper — the board never polled; realtime is purely additive (WS-down behavior == today's manual-refresh). Indicator has no "Polling" state.
- No god-page split — 378 LOC, under the ~500 threshold; the migration reduces LOC.
- No UX redesign (no toast migration, no new columns) — behavior-preserving migration only.
- No `routePolicy` work (blood-bank's REST gate lives in `app.js`, not the admin `routePolicy.ts`; the admin page is already reachable). No RBAC-cleanup PR (see §4.1 — `BLOOD_BANK_STAFF` is a non-assignable artifact).
- No emit on the two GET endpoints (`/inventory`, `/pending`, `/units`).

## 3. Architecture & data flow

```
blood-bank write (any clinical/blood-bank-staff client):
  POST /blood-bank/request                 (createRequest)         ─┐
  PUT  /blood-bank/:id/cross-match         (crossMatch)             │
  PUT  /blood-bank/:id/issue               (issueBlood)             │
  PUT  /blood-bank/:id/transfused          (recordTransfusion)      │
  POST /blood-bank/units                   (registerUnit)           │  (in each handler's try,
  POST /blood-bank/:id/crossmatch-unit     (crossmatchUnit)         ├─  after the service call
  POST /blood-bank/:id/verify-bedside      (recordBedsideVerification)│  succeeds, before success())
  POST /blood-bank/:id/start-transfusion   (startTransfusion)       │
  POST /blood-bank/:id/complete-transfusion(completeTransfusion)    │
  POST /blood-bank/:id/reaction            (recordReaction)        ─┘
                                                                     └─> emitBloodBankEvent(kind, { tenantId: req.tenantId })
                                                                           └─> broadcast('staff:blood-bank', {kind,at}, {tenantId})
                                                                                 │  (Redis fan-out, per-broadcast tenant filter)
                                                                                 ▼
BloodBankContent ── useRealtimeInvalidation('staff:blood-bank', [["blood-bank"]]) ──> invalidate the ["blood-bank"] root
                                                                                 └─> Inventory + Pending refetch
```

## 4. Backend

### 4.1 Channel — `apps/backend/src/utils/websocket/channelAuth.js`
Add one `CHANNEL_CATALOG` entry after `'staff:dialysis-board'`:
```js
'staff:blood-bank': { description: 'Blood bank — request lifecycle, unit stock, crossmatch, transfusion closed-loop + reactions', roles: 'staff' },
```
**Scope = `staff:` (isStaff), verified by direct computation — NOT `staff:clinical:`.** The REST gate is `app.js:1158` `requireRole(...BLOOD_BANK_ROUTE_ROLES)` (no in-router gate), where `BLOOD_BANK_ROUTE_ROLES = mergeRoles(getRolesForCapabilityGroups(['ip_flow','theatre','cath_lab','specialty_services']), ['DOCTOR'])`. Loading the real modules and testing each role:
- **`BLOOD_BANK_TECHNICIAN`** (the primary board role, defined in `roles.js`) is **`isStaff=true` but `isClinical=false`** → `staff:clinical:blood-bank` would **deny the blood-bank technician their own board** (the micro/DELTA-002 trap). So `staff:` is required.
- `staff:` (full isStaff) is a SUPERSET of the capability-narrowed `BLOOD_BANK_ROUTE_ROLES`, so it **over-grants** to non-blood-bank staff (HR/housekeeping/reception/pharmacy/lab). **Bounded safe** by the PHI-free `{kind,at}` payload (§6) and **systemic** across `staff:lab`/`staff:micro`/`staff:icu-board`/`staff:dialysis-board` (slice-10 lesson). No role-subset channel exists in the taxonomy.
- The 8 capability-graph roles in `BLOOD_BANK_ROUTE_ROLES` that are *not* `isStaff` (e.g. `BLOOD_BANK_STAFF`, `ICU_NURSE`, British-spelling `ANAESTHETIST`, `DIALYSIS_TECHNICIAN`) are **capability-graph-only codes absent from `roles.js`** — not assignable user roles (same class as slice-10's `DIALYSIS_TECHNICIAN`). `BLOOD_BANK_STAFF` specifically appears only in `rolePolicyGraph.js`; the real assignable blood-bank role is `BLOOD_BANK_TECHNICIAN` (already `isStaff`). **No RBAC-cleanup PR needed.**
- SUPER_ADMIN admitted via the slice-9 `authorizeChannel` bypass.

### 4.2 Emitter — `apps/backend/src/utils/websocket/realtimeEmitter.js`
Append after `emitDialysisEvent` (last function):
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
PHI-free `{kind, at}` nudge; internal try/catch → never throws into the blood-bank write. `tenantId` passed EXPLICITLY (`req.tenantId`; the `blood_requests`/`blood_units`/`transfusion_*` tables are tenant-scoped with RLS).

### 4.3 Producers — `apps/backend/src/routes/bloodbank/bloodBankRoutes.js` (import + 10 sites)
Import after the `sharedValidators` import:
```js
import { emitBloodBankEvent } from '../../utils/websocket/realtimeEmitter.js';
```
Every handler is controller-style: `try { const X = await service.Y(...); return success(res, X, ...); } catch ... }`. Insert the emit on its own line **after** the awaited service call and **before** `return success(...)` (post-service; emit on the success path only — a service throw lands in the `catch` before the emit). `req.tenantId` is available in every handler.

| # | Method + path | service call | `kind` |
|---|---|---|---|
| 1 | `POST /request` | createRequest | `request-created` |
| 2 | `PUT /:id/cross-match` | crossMatch | `request-cross-matched` |
| 3 | `PUT /:id/issue` | issueBlood | `request-issued` |
| 4 | `PUT /:id/transfused` | recordTransfusion | `request-transfused` |
| 5 | `POST /units` | registerUnit | `unit-registered` |
| 6 | `POST /:id/crossmatch-unit` | crossmatchUnit | `unit-cross-matched` |
| 7 | `POST /:id/verify-bedside` | recordBedsideVerification | `verification-recorded` |
| 8 | `POST /:id/start-transfusion` | startTransfusion | `transfusion-started` |
| 9 | `POST /:id/complete-transfusion` | completeTransfusion | `transfusion-completed` |
| 10 | `POST /:id/reaction` | recordReaction | `reaction-recorded` |

Example (site 1):
```js
    const result = await bloodBankService.createRequest(requestData, bloodBankContext(req));
    emitBloodBankEvent('request-created', { tenantId: req.tenantId });
    return success(res, result, 'Blood request created successfully', 201);
```
Do **NOT** emit on the GET handlers (`/inventory`, `/pending`, `/units`).

## 5. Frontend

### 5.1 Commit 1 — react-query migration (behavior-preserving)
`apps/admin/src/app/(with-auth)/dashboard/blood-bank/page.tsx`:
- **InventoryTab:** replace `useState`+`useEffect`+`load` with
  ```ts
  const { data: inventory = [], isLoading, error, refetch } = useQuery({
    queryKey: ["blood-bank", "inventory"],
    queryFn: async () => {
      const r = await fetchAdminAPI<{ data: InventoryItem[] }>("/blood-bank/inventory");
      const data = (r as Record<string, unknown>).data ?? r;
      return Array.isArray(data) ? (data as InventoryItem[]) : [];
    },
  });
  ```
  Refresh button → `onClick={() => refetch()}`. Error render → `error instanceof Error ? error.message : "Failed to load inventory"`.
- **PendingRequestsTab:** same `useQuery` shape with key `["blood-bank","pending"]` (note the endpoint returns the array directly via `success(res, result.requests, …)` — keep the same unwrap). Replace the `action(id, endpoint)` fn + `acting` state with one mutation:
  ```ts
  const qc = useQueryClient();
  const action = useMutation({
    mutationFn: ({ id, endpoint }: { id: number; endpoint: string }) =>
      putJSON(`/api/v1/blood-bank/${id}/${endpoint}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["blood-bank"] }),
    onError: (e) => alert(e instanceof Error ? e.message : "Action failed"),
  });
  ```
  Buttons → `onClick={() => action.mutate({ id: r.id, endpoint: "cross-match" })}`; per-row disable → `disabled={action.isPending && action.variables?.id === r.id}`.
- **NewRequestTab:** replace `submit`/`saving`/`success` with a mutation:
  ```ts
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => postJSON("/api/v1/blood-bank/request", form),
    onSuccess: () => { setForm({ patient_uid: "", blood_group: "O+", units: 1, notes: "" }); setSuccess(true); qc.invalidateQueries({ queryKey: ["blood-bank"] }); },
    onError: (e) => alert(e instanceof Error ? e.message : "Failed to create request"),
  });
  ```
  Keep the existing `success`/`setSuccess` state for the banner and the patient_uid required-check before `create.mutate()`; button `disabled={create.isPending}` (drop the old `saving` state).

No new dependency (the app-root `QueryClientProvider` already exists in `providers.tsx`). Imports change to add `useQuery`/`useMutation`/`useQueryClient` from `@tanstack/react-query`; `useEffect`/`useCallback` drop if unused.

### 5.2 Commit 2 — realtime subscribe + indicator
In `BloodBankContent` (the always-mounted orchestrator):
- `import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";` + a module const `const BLOOD_BANK_CHANNEL = "staff:blood-bank";`.
- `const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(BLOOD_BANK_CHANNEL, [["blood-bank"]]);`
- A `●Live / ○Connecting / ○Offline` indicator (`data-testid="blood-bank-realtime-indicator"`, `role="status"`, aria-label + title) next to the `<h1>Blood Bank</h1>` in a `flex items-center gap-2`.

No cadence helper (no poll). One root invalidation (`[["blood-bank"]]`) covers both tab queries by prefix.

## 6. Tenant scoping & PHI
`blood_requests` (tenant_id added in migration 239), `blood_units` / `transfusion_verifications` / `transfusion_reactions` (tenant_id in migration 280) are all tenant-scoped with RLS. Routes resolve tenant via `req.tenantId` (set by middleware; `bloodBankContext(req)` already threads it to services). The emit passes that same `req.tenantId` explicitly, so `broadcast`'s `tenantMatches` delivers only to same-tenant subscribers. WS payload is `{kind, at}` only — **no PHI** (no patient UID, unit number, blood group, or reaction detail); the board's data stays behind the REST-gated refetch.

## 7. Testing
- **`apps/backend/src/tests/unit/bloodBankRealtimeChannel.test.js`** — `CHANNEL_CATALOG['staff:blood-bank']` defined, `roles:'staff'`; `authorizeChannel('staff:blood-bank', {role})` allowed for `BLOOD_BANK_TECHNICIAN` (the isStaff-not-isClinical primary role — the key assertion), `NURSING_STAFF`, `DOCTOR`, `ADMIN`; denied for `PATIENT`; allowed for `SUPER_ADMIN` (slice-9 bypass).
- **`apps/backend/src/tests/unit/bloodBankRealtimeEmitter.test.js`** — mocks `wsServer.js`, imports the real `realtimeEmitter`; `emitBloodBankEvent('request-created', { tenantId: 't1' })` calls `broadcast` once with `'staff:blood-bank'`, `{kind:'request-created',…}`, `{tenantId:'t1'}`; never throws when `broadcast` throws. (Separate file — ESM mock-after-import rule.)
- **Backend regression:** run the existing `apps/backend/src/tests/transfusion-loop.deep.test.js` (DB-gated on QA PG `:55432`) — the route emits are post-service, side-effect-free on the response, must stay green. Run via `node apps/backend/scripts/qa-cluster-up.mjs` then `DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test … jest transfusion-loop`.
- **`apps/admin/src/__tests__/dashboard/blood-bank/page.test.tsx`** (new) — wrap in a `QueryClientProvider`; mock `@/lib/api` (`fetchAdminAPI`→`[]`, `postJSON`/`putJSON`→resolved) + `@/hooks/useRealtimeInvalidation`; assert the hook called with `("staff:blood-bank", [["blood-bank"]])` and the indicator renders `○ Offline` when `subscribed:false`/`connected:false` and `● Live` when `subscribed:true`.
- **Honest limit:** live WS push not auto-tested (no WS in jsdom); tests cover channel RBAC, emitter, indicator, and wiring. Manual recipe in §9.

## 8. Risks
| Risk | Mitigation |
|---|---|
| Channel denies the primary blood-bank user | `staff:` admits `BLOOD_BANK_TECHNICIAN` (isStaff); `staff:clinical:` would NOT (isClinical=false) — verified by computation, asserted in the channel test. |
| Channel over-grants vs REST (non-blood-bank staff subscribe) | Accepted + bounded: PHI-free `{kind,at}` payload; refetch stays REST-gated; systemic across the epic; no role-subset channel. Documented §4.1. |
| Migration changes board behavior | Behavior-preserving: same endpoints, same unwrap, same `alert()`/error UX, mutations invalidate then react-query refetches (replacing manual `load()`). |
| Emit blocks/breaks a blood-bank write | Emitter try/catches; emit is post-service, side-effect-free on the response. `transfusion-loop.deep.test` re-run as a regression guard. |
| Adding the hook breaks a page test | New page test mocks the hook + `@/lib/api`; no existing blood-bank admin test exists. |

## 9. Manual verification (deploy HELD)
1. `cd apps/backend && npm run dev` (dev PG :5433) + `cd apps/admin && npm run dev`.
2. Open `/dashboard/blood-bank`; confirm Inventory + Pending load via react-query and the indicator shows `● Live` once subscribed.
3. In a second tab, create a request / cross-match / register a unit; confirm the first tab's Pending list + Inventory update within ~1s with no manual Refresh.
4. Stop the backend; confirm the indicator falls to `○ Offline` and the board still works via manual Refresh (unchanged from today).
