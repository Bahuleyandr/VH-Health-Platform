# Real-time dashboards — Slice 9: Incidents board (`staff:incidents`) + SUPER_ADMIN channel bypass

- **Date:** 2026-06-29
- **Epic:** #4 Real-time-first dashboards
- **Status:** Design approved → spec
- **Builds on:** the event-driven `useRealtimeInvalidation` recipe. **Most divergent slice so far** — controller-layer emits, a global (non-tenant-scoped) table, no existing poll, and a cross-cutting WS-auth consistency fix (SUPER_ADMIN bypass).

## 1. Context & goal

The admin **Incident Reports** page (`apps/admin/src/app/(with-auth)/dashboard/incidents/page.tsx`) is the patient-safety / quality surface: it shows a pulsing **SENTINEL EVENT** banner, stat cards (new / active / sentinel·severe / this-week), a filterable incidents table, and a side panel to update status / add notes. It is gated at `HR_PLUS` (HR_STAFF, ADMIN, SUPER_ADMIN). Today **neither query polls** — `["incident-stats"]` (staleTime 30s) and `["incidents",…]` (staleTime 15s) refetch only on mount/refocus/manual-Refresh or after a local mutation. So a freshly-filed sentinel event is invisible to a watching quality officer until they reload.

**Goal:** push the board live — a new `staff:incidents` channel with producers at the two incident write paths (file + update); the page subscribes and invalidates both query roots, so the sentinel banner, stat cards, and table refresh the moment any incident is filed or changed. Purely additive real-time (no poll to relax).

**Plus a cross-cutting fix:** the incidents audience includes **SUPER_ADMIN**, but `isStaff('SUPER_ADMIN')` is false and `authorizeChannel` has **no super-admin bypass** — unlike the REST `rbacMiddleware`, which already grants SUPER_ADMIN an un-scoped bypass of every `requireRole` gate. So a super-admin currently cannot subscribe to **any** `staff:*` channel (all 8 prior boards included). This slice adds the missing bypass to `authorizeChannel` so WS auth matches REST auth.

## 2. Scope

**In scope**
- **`authorizeChannel` SUPER_ADMIN bypass** (consistency with `rbacMiddleware`) — fixes super-admin subscription for incidents + all prior `staff:*` boards.
- New `staff:incidents` channel + `emitIncidentEvent` emitter + **2 controller-layer producers** in `incidentController.js`.
- Frontend: `useRealtimeInvalidation` on `[["incidents"], ["incident-stats"]]` + a `●Live/○Offline` indicator. (No cadence helper — the page has no `refetchInterval`.)
- Tests: channel RBAC (incl. the SUPER_ADMIN bypass), emitter, page wiring.

**Out of scope (YAGNI)**
- No `routePolicy` change — `dashboard/incidents` exists with `incidents: { minRank: HR_PLUS }`.
- No tenant scoping of incidents — `incident_reports` is a **global table** (no `tenant_id` column); the emit carries no tenantId (broadcast falls back to the request's ALS tenant; correct for single-tenant). Making the global incidents board multi-tenant-aware is a pre-existing, separate question.
- No new persisted rows / migration / channel beyond `staff:incidents`.
- No change to the incident workflow, the controller's queries, or the side panel.
- No cadence helper / poll relaxation (there is no poll).

## 3. Architecture & data flow

```
incident write (any client):
  POST  …/incidents (submitIncident)  → INSERT incident_reports + report_updates ─┐
  PATCH …/incidents/:id (updateIncident) → UPDATE incident_reports + report_updates ┤  (before success(),
                                                                                     │   inside the try)
                                                                                     └─> emitIncidentEvent(kind)
                                                                                          └─> broadcast('staff:incidents', {kind,at})   (no tenantId → ALS fallback)
                                                                                                │  (Redis fan-out, per-broadcast tenant filter)
                                                                                                ▼
IncidentsPage ── useRealtimeInvalidation('staff:incidents', [["incidents"],["incident-stats"]]) ──> invalidate both roots
                                                                                                └─> table + sentinel banner + stat cards refetch
```

The WS push is a **PHI-free invalidation signal** (`{kind, at}` only — no incident detail); the existing query functions refetch the authoritative list + stats through the RBAC-guarded REST routes (which already enforce HR_PLUS + anonymous-reporter masking). Two separate query roots (`["incidents"]` and `["incident-stats"]`) so both must be invalidated.

## 4. Backend design

### 4.1 `authorizeChannel` SUPER_ADMIN bypass + channel (`apps/backend/src/utils/websocket/channelAuth.js`)
Add the import:
```js
import { SUPER_ADMIN, normalizeRole } from '../roles.js';
```
At the top of `authorizeChannel`, immediately after the channel-name length validation and **before** the `LEGACY_CHANNELS` check, add:
```js
// SUPER_ADMIN is the platform master role. The REST RBAC (rbacMiddleware) grants it an un-scoped
// bypass of every requireRole gate; WS channel auth must match so a super-admin can subscribe to any
// board they can already read. (Without this, isStaff('SUPER_ADMIN') is false → super-admin is denied
// every staff:* channel.)
if (normalizeRole(user?.role) === SUPER_ADMIN) {
  return { allowed: true };
}
```
Add to `CHANNEL_CATALOG` (after `staff:micro`):
```js
'staff:incidents': { description: 'Incident reports — sentinel/severe safety events + status changes', roles: 'staff' },
```
The `staff:` prefix → `isStaff` admits HR_STAFF + ADMIN + clinical staff; the new bypass admits SUPER_ADMIN; together they cover the `HR_PLUS` audience. No PHI on the channel.

### 4.2 Emitter (`apps/backend/src/utils/websocket/realtimeEmitter.js`)
```js
/** Incident-board change (new incident filed / status·notes updated). */
export function emitIncidentEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:incidents', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitIncidentEvent failed:', err.message);
  }
}
```
Mirrors the other emitters' shape; called WITHOUT `tenantId` from the controller (incidents are global — `broadcast` falls back to `getCurrentTenantId()` ALS; single-tenant-correct). Internal try/catch → never throws into the incident write.

### 4.3 Producers — `apps/backend/src/controllers/staff/incidentController.js` (import + 2 sites)
The producers are **controller functions** (not route arrows). Emit best-effort just before the terminal `success(res, …)` call, inside the existing `try`.

| Function | Placement | Emit |
|---|---|---|
| `submitIncident` | after the `report_updates` insert, before `success(res, result[0], …)` | `emitIncidentEvent('submitted')` |
| `updateIncident` | after the final `SELECT … updated`, before `success(res, updated[0], 'Incident updated')` | `emitIncidentEvent('updated')` |

Import: `import { emitIncidentEvent } from '../../utils/websocket/realtimeEmitter.js';`. The kind is informational (the frontend invalidates both roots regardless).

## 5. Frontend design

### 5.1 Page wiring — `incidents/page.tsx`
- Add a module-level const `const INCIDENTS_CHANNEL = "staff:incidents";` (no separate `realtime.ts` — there's no cadence helper).
- Import `useRealtimeInvalidation` from `@/hooks/useRealtimeInvalidation`.
- In `IncidentsPage`, after the `useState`s / before the queries:
  `const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(INCIDENTS_CHANNEL, [["incidents"], ["incident-stats"]]);`
  (invalidates BOTH separate roots — `["incidents"]` covers the filtered list key `["incidents",status,severity,type]` by prefix; `["incident-stats"]` is its own root.)
- Add a `●Live / ○Connecting / ○Offline` indicator next to the `<h1>Incident Reports</h1>` (wrap the `<h1>` + indicator in a `flex items-center gap-2`; keep the subtitle `<p>` and the Refresh button). `data-testid="incidents-realtime-indicator"`, `role="status"`, `aria-label`, `title`. **Semantics differ from the polling boards** — there is no poll fallback, so: `● Live` when subscribed, `○ Connecting` when connected-but-not-subscribed, `○ Offline` otherwise (when WS is down the board falls back to manual Refresh, not a poll).
- No `refetchInterval` change — both queries keep their `staleTime` (15s/30s); the slice is purely additive (push on top of the existing manual/refocus refetch).

## 6. Tenant scoping & PHI
`incident_reports` has **no `tenant_id`** — it is a single global table, and the controller does no tenant resolution. The emit therefore carries no `tenantId`; `broadcast` falls back to the request's ALS tenant (single-tenant-correct — all staff in the one tenant get the signal). The WS payload is `{kind, at}` only — **no PHI** (no reporter, no patient, no detail); the board's data (incl. anonymous-reporter masking) stays behind the HR_PLUS-gated REST refetch. Making the global incidents board correct under future multi-tenancy is pre-existing and out of scope.

## 7. Testing
- **Backend** `incidentsRealtimeChannel.test.js` — `CHANNEL_CATALOG['staff:incidents']` present with `roles:'staff'`; `authorizeChannel('staff:incidents', …)` allowed for `HR_STAFF`/`ADMIN`/`NURSING_STAFF`, denied for `PATIENT`; **★ `SUPER_ADMIN` allowed (the new bypass)** on `staff:incidents` AND on an unrelated channel (e.g. `admin:foo`, `patient:x:y`) to prove the bypass is general.
- **Backend** `incidentsRealtimeEmitter.test.js` (ESM-mock `wsServer`) — `emitIncidentEvent('submitted')` broadcasts `'staff:incidents'` with `{kind:'submitted', at}`; never throws when `broadcast` throws.
- **Producer wiring:** no new automated test (controller wiring; emit covered by the emitter test; the controller's integration tests are DB-gated) — verified by `npm run lint` + the channel/emitter unit tests.
- **Frontend** `incidents/page.test.tsx` — `jest.mock("@/hooks/useRealtimeInvalidation")` + `jest.mock("@/lib/api/reports")` (stub `getIncidents`→`{incidents:[],total:0}`, `getIncidentStats`→`{summary:{sentinel_count:'0',…},by_type:[]}`, `updateIncident`); assert the hook is called with `(INCIDENTS_CHANNEL, [["incidents"],["incident-stats"]])`; indicator shows `Offline` when disconnected, `Live` when subscribed.

**Honest limitations:** live WS push not auto-tested (no WS in jsdom; deploy HELD). The super-admin bypass is unit-tested via `authorizeChannel`; its real effect (super-admin can subscribe) is not exercised end-to-end.

## 8. Resilience / error handling
- Emits are best-effort, post-write, non-blocking (`emitIncidentEvent` try/catches internally) — a WS failure can never abort filing or updating an incident.
- The SUPER_ADMIN bypass is a strict widening of channel access for a single master role that already has un-scoped REST access — it cannot deny anyone who was previously allowed.
- WS bus is at-most-once; when WS is down the board falls back to manual Refresh (its current behaviour) — never worse than today.

## 9. Verification
- **Gates:** backend `lint` + `incidentsRealtimeChannel`/`incidentsRealtimeEmitter` unit tests (the channel test also covers the super-admin bypass); admin `type-check`/`lint`/`test`/`build`.
- **Manual (deploy HELD → local):** open the incidents board (`● Live`); from a second client file a `sentinel` incident → the SENTINEL banner + stat cards + table appear within ~1s without refresh; update an incident's status → the row + stats repaint live. Log in as SUPER_ADMIN → the indicator reads `● Live` (previously would have stayed `○`).

## 10. File-change inventory
- `apps/backend/src/utils/websocket/channelAuth.js` — +SUPER_ADMIN bypass (import + guard) + 1 catalog entry.
- `apps/backend/src/utils/websocket/realtimeEmitter.js` — +`emitIncidentEvent`.
- `apps/backend/src/controllers/staff/incidentController.js` — import + 2 emit calls.
- `apps/backend/src/tests/unit/incidentsRealtimeChannel.test.js` — new (incl. the bypass assertions).
- `apps/backend/src/tests/unit/incidentsRealtimeEmitter.test.js` — new.
- `apps/admin/src/app/(with-auth)/dashboard/incidents/page.tsx` — channel const + hook + indicator.
- `apps/admin/src/__tests__/dashboard/incidents/page.test.tsx` — new.

## 11. Risks
| Risk | Mitigation |
|---|---|
| SUPER_ADMIN bypass over-grants channel access | Strict consistency with the REST `rbacMiddleware` super-admin bypass; super-admin already has un-scoped REST access; no test asserted super-admin denial (verified). Channel test pins the new behaviour. |
| Channel denies a real incidents user | `staff:incidents` (isStaff) admits HR_STAFF + ADMIN; the bypass admits SUPER_ADMIN — the full `HR_PLUS` audience. Asserted in the channel test. |
| Emit blocks an incident write | Emitter try/catches; post-write, non-blocking. |
| Global-table emit + multi-tenant | Single-tenant today; emit relies on ALS tenant fallback. Documented as a pre-existing question (incident_reports has no tenant_id). |
| `["incidents"]` filtered key not invalidated | `useRealtimeInvalidation` invalidates by prefix — `["incidents"]` matches `["incidents",status,severity,type]`. Stats are a separate root, also invalidated. |
| Adding the hook breaks the page test | New `incidents/page.test.tsx` mocks the hook + `@/lib/api/reports` from the start. |
