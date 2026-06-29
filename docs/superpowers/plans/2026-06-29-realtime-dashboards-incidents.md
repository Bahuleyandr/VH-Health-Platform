# Incidents Board (Slice 9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push the admin Incidents board live via a new `staff:incidents` channel with controller-layer producers; the page subscribes and invalidates `["incidents"]` + `["incident-stats"]`. Also add a `SUPER_ADMIN` bypass to `authorizeChannel` (consistency with the REST `rbacMiddleware`) so super-admin can subscribe to incidents + all prior boards.

**Architecture:** Event-driven recipe (like ICU/lab/micro), but: **controller-layer emits** (`incidentController.js`), **no `tenantId`** (incident_reports is a global table → ALS fallback), **no cadence helper** (the page has no `refetchInterval`), and a **cross-cutting `authorizeChannel` SUPER_ADMIN bypass**.

**Tech Stack:** Node/Express 5 + WS fabric, Next.js 16 + TanStack Query v5, Jest.

**Spec:** `docs/superpowers/specs/2026-06-29-realtime-dashboards-incidents-design.md`
**Branch:** `feat/realtime-incidents-board` (already created off `main`).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `apps/backend/src/utils/websocket/channelAuth.js` | Channel auth + catalog | Modify: SUPER_ADMIN bypass + 1 catalog entry |
| `apps/backend/src/utils/websocket/realtimeEmitter.js` | WS emitters | Modify: +`emitIncidentEvent` |
| `apps/backend/src/controllers/staff/incidentController.js` | Incident write handlers | Modify: import + 2 emit calls |
| `apps/backend/src/tests/unit/incidentsRealtimeChannel.test.js` | Channel RBAC + bypass test | Create |
| `apps/backend/src/tests/unit/incidentsRealtimeEmitter.test.js` | Emitter test | Create |
| `apps/admin/src/app/(with-auth)/dashboard/incidents/page.tsx` | Incidents page | Modify: channel const + hook + indicator |
| `apps/admin/src/__tests__/dashboard/incidents/page.test.tsx` | Page-wiring test | Create |

**Run-command reference**
- Backend (from `apps/backend`): `npm run lint` · `node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit`
- Admin (from `apps/admin`): `npm test -- <pattern>` · `npm run type-check` · `npm run lint` · `npm run build`

---

## Task 1: Backend — channel + SUPER_ADMIN bypass + emitter (TDD)

**Files:** Modify `channelAuth.js`, `realtimeEmitter.js`; Create `incidentsRealtimeChannel.test.js`, `incidentsRealtimeEmitter.test.js`.

- [ ] **Step 1: Write the channel test (catalog + RBAC + SUPER_ADMIN bypass)**

Create `apps/backend/src/tests/unit/incidentsRealtimeChannel.test.js`:

```js
import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:incidents channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:incidents']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:incidents'].roles).toBe('staff');
  });

  test('is allowed for HR + clinical staff + admins, denied for patients', () => {
    expect(authorizeChannel('staff:incidents', { role: 'HR_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:incidents', { role: 'NURSING_STAFF', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:incidents', { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:incidents', { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
  });
});

describe('SUPER_ADMIN channel bypass', () => {
  test('SUPER_ADMIN may subscribe to staff:incidents (isStaff is false for it)', () => {
    expect(authorizeChannel('staff:incidents', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
  });
  test('the bypass is general — SUPER_ADMIN may subscribe to any channel namespace', () => {
    expect(authorizeChannel('staff:beds', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
    expect(authorizeChannel('admin:anything', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
    expect(authorizeChannel('patient:other-uid:vitals', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
  });
  test('a non-super-admin is still gated normally', () => {
    expect(authorizeChannel('admin:anything', { role: 'NURSING_STAFF', userId: '2' }).allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, confirm it FAILS**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js incidentsRealtimeChannel --forceExit`
Expected: FAIL — `CHANNEL_CATALOG['staff:incidents']` undefined + SUPER_ADMIN denied on staff:beds/admin:anything/patient:….

- [ ] **Step 3: Add the SUPER_ADMIN bypass to `authorizeChannel`**

In `apps/backend/src/utils/websocket/channelAuth.js`, add the import after the existing roleHelpers import:
```js
import { SUPER_ADMIN, normalizeRole } from '../roles.js';
```
Then, inside `authorizeChannel`, immediately AFTER the channel-name length validation block (the `if (typeof channel !== 'string' …) { return … }`) and BEFORE the `if (LEGACY_CHANNELS.has(channel))` line, insert:
```js
  // SUPER_ADMIN is the platform master role. The REST RBAC (rbacMiddleware) grants it an un-scoped
  // bypass of every requireRole gate; WS channel auth must match so a super-admin can subscribe to any
  // board they can already read. Without this, isStaff('SUPER_ADMIN') is false → super-admin is denied
  // every staff:* channel.
  if (normalizeRole(user?.role) === SUPER_ADMIN) {
    return { allowed: true };
  }
```

- [ ] **Step 4: Add the CHANNEL_CATALOG entry**

In the same file, in `CHANNEL_CATALOG`, immediately after the `'staff:micro'` entry, add:
```js
  'staff:incidents': { description: 'Incident reports — sentinel/severe safety events + status changes', roles: 'staff' },
```

- [ ] **Step 5: Run it, confirm it PASSES**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js incidentsRealtimeChannel --forceExit` → PASS (5 tests).

- [ ] **Step 6: Write the emitter test**

Create `apps/backend/src/tests/unit/incidentsRealtimeEmitter.test.js`:

```js
import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitIncidentEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitIncidentEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:incidents with the kind', () => {
    emitIncidentEvent('submitted');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:incidents',
      expect.objectContaining({ kind: 'submitted' }),
      expect.anything(),
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitIncidentEvent('updated')).not.toThrow();
  });
});
```

- [ ] **Step 7: Run it, confirm it FAILS**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js incidentsRealtimeEmitter --forceExit` → FAIL (`emitIncidentEvent` not exported).

- [ ] **Step 8: Add the emitter**

In `apps/backend/src/utils/websocket/realtimeEmitter.js`, immediately after the `emitMicroEvent` function, add:
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

(`broadcast` + `logger` are already imported. `tenantId` is undefined when called from the controller — incidents are a global table; `broadcast` falls back to the ALS tenant.)

- [ ] **Step 9: Run both, confirm PASS**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js incidentsRealtimeChannel incidentsRealtimeEmitter --forceExit` → PASS (7 tests).

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/utils/websocket/channelAuth.js apps/backend/src/utils/websocket/realtimeEmitter.js apps/backend/src/tests/unit/incidentsRealtimeChannel.test.js apps/backend/src/tests/unit/incidentsRealtimeEmitter.test.js
git commit -m "feat(realtime): add staff:incidents channel + SUPER_ADMIN channel bypass + emitIncidentEvent

The SUPER_ADMIN bypass in authorizeChannel mirrors the REST rbacMiddleware
super-admin bypass; without it isStaff('SUPER_ADMIN') is false so super-admin
was denied every staff:* channel.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Backend — 2 controller producers

**Files:** Modify `apps/backend/src/controllers/staff/incidentController.js`.

> Controller-layer emits, best-effort, just before the terminal `success(res, …)` call, inside the existing `try`. `emitIncidentEvent` never throws. No new automated test (controller wiring; emit covered by the emitter test; the controller's integration tests are DB-gated) — verified by lint + the Task 1 tests.

- [ ] **Step 1: Add the import**

In `apps/backend/src/controllers/staff/incidentController.js`, after `import { ADMIN, SUPER_ADMIN, normalizeRole } from '../../utils/roles.js';`, add:
```js
import { emitIncidentEvent } from '../../utils/websocket/realtimeEmitter.js';
```

- [ ] **Step 2: Emit in `submitIncident`**

In `submitIncident`, locate the terminal success call:
```js
    success(res, result[0], `Incident report ${reportNumber} submitted successfully`);
```
Insert immediately BEFORE it:
```js
    emitIncidentEvent('submitted');
```

- [ ] **Step 3: Emit in `updateIncident`**

In `updateIncident`, locate the terminal success call:
```js
    success(res, updated[0], 'Incident updated');
```
Insert immediately BEFORE it:
```js
    emitIncidentEvent('updated');
```

Do NOT emit in the read handlers (`getMyIncidents`, `getIncidentDetail`, `getAllIncidents`, `getAdminIncidentDetail`, `getIncidentStats`).

- [ ] **Step 4: Verify**

Run (from `apps/backend`): `npm run lint` → PASS.
Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js incidentsRealtimeChannel incidentsRealtimeEmitter --forceExit` → PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/controllers/staff/incidentController.js
git commit -m "feat(realtime): emit staff:incidents on incident submit + update

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Frontend — page wiring + indicator + page test

**Files:** Modify `apps/admin/src/app/(with-auth)/dashboard/incidents/page.tsx`; Create `apps/admin/src/__tests__/dashboard/incidents/page.test.tsx`.

- [ ] **Step 1: Wire `IncidentsPage`**

In `incidents/page.tsx`:

(a) Add the import near the other imports:
```ts
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
```

(b) Add a module-level const below the imports (before the `Incident` interface):
```ts
const INCIDENTS_CHANNEL = "staff:incidents";
```

(c) In `IncidentsPage`, immediately after the `const [selected, setSelected] = useState<Incident | null>(null);` line, add the hook + indicator derivations:
```tsx
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(INCIDENTS_CHANNEL, [
    ["incidents"],
    ["incident-stats"],
  ]);

  const liveLabel = subscribed ? "● Live" : connected ? "○ Connecting" : "○ Offline";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:incidents — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:incidents"
    : connected
      ? "Connecting…"
      : "Offline — refresh manually (real-time unavailable)";
```

(d) Replace the header block:
```tsx
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Incident Reports</h1>
          <p className="text-sm text-gray-500">
            Patient safety & operational incident management
          </p>
        </div>
```
with:
```tsx
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-gray-900">Incident Reports</h1>
            <span
              data-testid="incidents-realtime-indicator"
              role="status"
              aria-label={
                subscribed
                  ? "Live — real-time incident updates active"
                  : "Offline — real-time updates unavailable"
              }
              title={liveTitle}
              className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
            >
              {liveLabel}
            </span>
          </div>
          <p className="text-sm text-gray-500">
            Patient safety & operational incident management
          </p>
        </div>
```

(Leave the Refresh button, stats cards, filters, table, and side panel unchanged.)

- [ ] **Step 2: Create the page test**

Create `apps/admin/src/__tests__/dashboard/incidents/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import IncidentsPage from "@/app/(with-auth)/dashboard/incidents/page";
import { getIncidents, getIncidentStats } from "@/lib/api/reports";

jest.mock("@/lib/api/reports", () => ({
  getIncidents: jest.fn(),
  getIncidentStats: jest.fn(),
  updateIncident: jest.fn(),
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

const mockedGetIncidents = getIncidents as jest.MockedFunction<typeof getIncidents>;
const mockedGetIncidentStats = getIncidentStats as jest.MockedFunction<typeof getIncidentStats>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<IncidentsPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
    mockedGetIncidents.mockResolvedValue({ incidents: [], total: 0 } as never);
    mockedGetIncidentStats.mockResolvedValue({
      summary: {
        new_count: "0", active_count: "0", sentinel_count: "0", severe_count: "0",
        this_week: "0", this_month: "0", total: "0",
      },
      by_type: [],
    } as never);
  });

  it("subscribes to staff:incidents on both roots and shows ○ Offline when disconnected", async () => {
    renderWithQuery(<IncidentsPage />);
    const ind = await screen.findByTestId("incidents-realtime-indicator");
    expect(ind).toHaveTextContent("Offline");
    expect(mockRealtime).toHaveBeenCalledWith("staff:incidents", [["incidents"], ["incident-stats"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<IncidentsPage />);
    const ind = await screen.findByTestId("incidents-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
```

- [ ] **Step 3: Run the test + type-check + lint**

Run (from `apps/admin`): `npm test -- incidents/page` → PASS (2 tests).
Run: `npm run type-check` → 0 errors.
Run: `npm run lint` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/incidents/page.tsx" "apps/admin/src/__tests__/dashboard/incidents/page.test.tsx"
git commit -m "feat(realtime): subscribe Incidents board to staff:incidents + Live indicator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Full verification gates

**Files:** none (verification only).

- [ ] **Step 1: Backend gates**

Run (from `apps/backend`): `npm run lint` → PASS.
Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js incidentsRealtimeChannel incidentsRealtimeEmitter --forceExit` → PASS (7 tests).

- [ ] **Step 2: Admin gates**

Run (from `apps/admin`): `npm run type-check` → 0 errors.
Run: `npm run lint` → 0 errors.
Run: `npm test` → full suite PASS (incl. the new `incidents/page` test).
Run: `npm run build` → PASS.

- [ ] **Step 3: Manual live-WS verification (optional, deploy HELD → local)**

Per spec §9: open the incidents board (`● Live`); from a second client file a `sentinel` incident → the SENTINEL banner + stat cards + table appear within ~1s; update an incident's status → the row + stats repaint live. As SUPER_ADMIN the indicator reads `● Live` (previously `○`).

---

## After the plan: finish the branch

Follow the standing workflow: request review, then `merge --no-ff` into `main`, push **both** remotes (GitHub + Forgejo), delete the branch. **Deploy stays HELD** — do not tag.

## Spec-coverage check (self-review)

- SUPER_ADMIN bypass (spec §4.1) → Task 1 Steps 1-3 + the bypass assertions in the channel test. Channel (§4.1) → Task 1 Step 4. Emitter (§4.2) → Task 1 Steps 6-8. 2 producers (§4.3) → Task 2. Page wiring + indicator (§5.1) → Task 3 Step 1. Tests (§7) → Tasks 1/3. Gates + manual (§9) → Task 4. Tenant/PHI (§6) — no `tenantId` on the emit (Task 1.8) + the controller calls without it (Task 2). Out-of-scope (no routePolicy/migration/cadence helper) — no task, as intended.
- Type consistency: `emitIncidentEvent(kind, { tenantId })` defined (Task 1.8) + used in the emitter test (1.6) + both producers (Task 2, called with no tenantId). `INCIDENTS_CHANNEL = "staff:incidents"` (Task 3) ↔ channel catalog/tests (Task 1) ↔ page test assertion (Task 3.2). Invalidation keys `[["incidents"],["incident-stats"]]` consistent between the page hook and the page test. The SUPER_ADMIN bypass + `normalizeRole`/`SUPER_ADMIN` import from `'../roles.js'` (Task 1.3) match `roles.js`'s exports (verified).
