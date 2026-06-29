# Microbiology Board (Slice 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the admin Microbiology page (orders / antibiogram / resistance tabs) to event-driven real-time via a new `staff:micro` channel with route-layer producers; the page subscribes and invalidates the `["micro"]` query family. Orders/Antibiogram/OrderDetail gain real-time they never had.

**Architecture:** Reuse the event-driven recipe (ICU/lab). **Route-layer emits** in `microbiologyRoutes.js` (micro writes arrive only via these routes — no service change). New channel `staff:micro` (isStaff — the route's `requireStaffOrAdmin` gate; NOT `staff:clinical:`, which would deny LAB_STAFF). `emitMicroEvent` never throws.

**Tech Stack:** Node/Express 5 + WS fabric, Next.js 16 + TanStack Query v5, Jest.

**Spec:** `docs/superpowers/specs/2026-06-29-realtime-dashboards-microbiology-design.md`
**Branch:** `feat/realtime-microbiology-board` (already created off `main`).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `apps/backend/src/utils/websocket/channelAuth.js` | Channel catalog | Modify: +1 entry |
| `apps/backend/src/utils/websocket/realtimeEmitter.js` | WS emitters | Modify: +`emitMicroEvent` |
| `apps/backend/src/routes/lab/microbiologyRoutes.js` | Micro routes | Modify: import + 4 emit calls |
| `apps/backend/src/tests/unit/microRealtimeChannel.test.js` | Channel RBAC test | Create |
| `apps/backend/src/tests/unit/microRealtimeEmitter.test.js` | Emitter test | Create |
| `apps/admin/src/app/(with-auth)/dashboard/microbiology/realtime.ts` | Channel const + cadence | Create |
| `apps/admin/src/app/(with-auth)/dashboard/microbiology/page.tsx` | Micro tab page | Modify: hook + indicator + `subscribed` |
| `apps/admin/src/__tests__/dashboard/microbiology/realtime.test.ts` | Cadence test | Create |
| `apps/admin/src/__tests__/dashboard/microbiology/page.test.tsx` | Page-wiring test | Create |

**Run-command reference**
- Backend (from `apps/backend`): `npm run lint` · `node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit`
- Admin (from `apps/admin`): `npm test -- <pattern>` · `npm run type-check` · `npm run lint` · `npm run build`

---

## Task 1: Backend — channel + emitter (TDD)

**Files:** Modify `channelAuth.js`, `realtimeEmitter.js`; Create `microRealtimeChannel.test.js`, `microRealtimeEmitter.test.js`.

- [ ] **Step 1: Write the channel test**

Create `apps/backend/src/tests/unit/microRealtimeChannel.test.js`:

```js
import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:micro channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:micro']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:micro'].roles).toBe('staff');
  });

  test('is allowed for lab/clinical staff + admins and denied for patients', () => {
    expect(authorizeChannel('staff:micro', { role: 'NURSING_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:micro', { role: 'LAB_STAFF', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:micro', { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:micro', { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, confirm it FAILS**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js microRealtimeChannel --forceExit`
Expected: FAIL — `CHANNEL_CATALOG['staff:micro']` is undefined.

- [ ] **Step 3: Add the catalog entry**

In `apps/backend/src/utils/websocket/channelAuth.js`, in `CHANNEL_CATALOG`, immediately after the `'staff:lab'` entry, add:

```js
  'staff:micro': { description: 'Microbiology — culture orders, isolates, sensitivities, MDR resistance', roles: 'staff' },
```

- [ ] **Step 4: Run it, confirm it PASSES**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js microRealtimeChannel --forceExit` → PASS (2 tests).

- [ ] **Step 5: Write the emitter test**

Create `apps/backend/src/tests/unit/microRealtimeEmitter.test.js`:

```js
import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitMicroEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitMicroEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:micro with kind + tenantId', () => {
    emitMicroEvent('isolate-added', { tenantId: 't-1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:micro',
      expect.objectContaining({ kind: 'isolate-added' }),
      { tenantId: 't-1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitMicroEvent('order-created', { tenantId: 't-2' })).not.toThrow();
  });
});
```

- [ ] **Step 6: Run it, confirm it FAILS**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js microRealtimeEmitter --forceExit` → FAIL (`emitMicroEvent` not exported).

- [ ] **Step 7: Add the emitter**

In `apps/backend/src/utils/websocket/realtimeEmitter.js`, immediately after the `emitLabEvent` function, add:

```js
/** Microbiology board change (order created/transitioned, isolate/sensitivity added). */
export function emitMicroEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:micro', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitMicroEvent failed:', err.message);
  }
}
```

(`broadcast` + `logger` are already imported in that file.)

- [ ] **Step 8: Run both, confirm PASS**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js microRealtimeChannel microRealtimeEmitter --forceExit` → PASS (4 tests).

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/utils/websocket/channelAuth.js apps/backend/src/utils/websocket/realtimeEmitter.js apps/backend/src/tests/unit/microRealtimeChannel.test.js apps/backend/src/tests/unit/microRealtimeEmitter.test.js
git commit -m "feat(realtime): add staff:micro channel + emitMicroEvent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Backend — 4 producers in `microbiologyRoutes.js`

**Files:** Modify `apps/backend/src/routes/lab/microbiologyRoutes.js`.

> Route-layer emits (ICU pattern). Each handler uses `wrap(async (req) => micro.X(...))` — convert to a block that captures `tenantId`, awaits, emits best-effort, returns the row. `emitMicroEvent` never throws. No new automated test (route-handler wiring; emit covered by `microRealtimeEmitter.test.js`) — verified by lint + the Task 1 tests.

- [ ] **Step 1: Add the import**

After `import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';`, add:

```js
import { emitMicroEvent } from '../../utils/websocket/realtimeEmitter.js';
```

- [ ] **Step 2: `POST /orders`**

Replace:
```js
router.post('/orders', requireStaffOrAdmin, wrap(async (req) =>
  micro.createOrder({
    tenantId: tenantOf(req), ordered_by: req.user?.uid, ...req.body,
  }),
));
```
with:
```js
router.post('/orders', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await micro.createOrder({ tenantId, ordered_by: req.user?.uid, ...req.body });
  emitMicroEvent('order-created', { tenantId });
  return row;
}));
```

- [ ] **Step 3: `POST /orders/:id/transition`**

Replace:
```js
router.post('/orders/:id/transition', requireStaffOrAdmin, wrap(async (req) =>
  micro.transitionOrder({
    tenantId: tenantOf(req),
    id: req.params.id,
    finalised_by: req.user?.uid,
    ...req.body,
  }),
));
```
with:
```js
router.post('/orders/:id/transition', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await micro.transitionOrder({
    tenantId, id: req.params.id, finalised_by: req.user?.uid, ...req.body,
  });
  emitMicroEvent('order-transition', { tenantId });
  return row;
}));
```

- [ ] **Step 4: `POST /orders/:id/isolates`**

Replace:
```js
router.post('/orders/:id/isolates', requireStaffOrAdmin, wrap(async (req) =>
  micro.addIsolate({ tenantId: tenantOf(req), order_id: req.params.id, ...req.body }),
));
```
with:
```js
router.post('/orders/:id/isolates', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await micro.addIsolate({ tenantId, order_id: req.params.id, ...req.body });
  emitMicroEvent('isolate-added', { tenantId });
  return row;
}));
```

- [ ] **Step 5: `POST /isolates/:id/sensitivities`**

Replace:
```js
router.post('/isolates/:id/sensitivities', requireStaffOrAdmin, wrap(async (req) =>
  micro.addSensitivity({ tenantId: tenantOf(req), isolate_id: req.params.id, ...req.body }),
));
```
with:
```js
router.post('/isolates/:id/sensitivities', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await micro.addSensitivity({ tenantId, isolate_id: req.params.id, ...req.body });
  emitMicroEvent('sensitivity-added', { tenantId });
  return row;
}));
```

Do NOT emit in the GET handlers (`/orders`, `/orders/:id`, `/antibiogram`, `/resistant-isolates`).

- [ ] **Step 6: Verify**

Run (from `apps/backend`): `npm run lint` → PASS.
Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js microRealtimeChannel microRealtimeEmitter --forceExit` → PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/routes/lab/microbiologyRoutes.js
git commit -m "feat(realtime): emit staff:micro on order/isolate/sensitivity writes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Frontend — cadence helper (TDD)

**Files:** Create `apps/admin/src/app/(with-auth)/dashboard/microbiology/realtime.ts` + `apps/admin/src/__tests__/dashboard/microbiology/realtime.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/__tests__/dashboard/microbiology/realtime.test.ts`:

```ts
import { microRefetchMs, MICRO_LIVE_POLL_MS } from "@/app/(with-auth)/dashboard/microbiology/realtime";

describe("microRefetchMs", () => {
  it("relaxes the resistance poll to the 2-min live cadence while subscribed", () => {
    expect(microRefetchMs(true, 60_000)).toBe(120_000);
    expect(microRefetchMs(true, 60_000)).toBe(MICRO_LIVE_POLL_MS);
  });
  it("keeps the original 60s cadence when not subscribed", () => {
    expect(microRefetchMs(false, 60_000)).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run it, confirm it FAILS**

Run (from `apps/admin`): `npm test -- microbiology/realtime`
Expected: FAIL — cannot resolve `.../microbiology/realtime`.

- [ ] **Step 3: Create the helper**

Create `apps/admin/src/app/(with-auth)/dashboard/microbiology/realtime.ts`:

```ts
export const MICRO_CHANNEL = "staff:micro";

// The Resistance tab polled 60s; Orders/Antibiogram/OrderDetail had no poll (push-only now). While
// subscribed we relax the Resistance poll to a 2-min safety net (push makes it instant), reverting to 60s
// when WS is down so behaviour is never worse than before.
export const MICRO_LIVE_POLL_MS = 120_000;

export function microRefetchMs(subscribed: boolean, baseMs: number): number {
  return subscribed ? MICRO_LIVE_POLL_MS : baseMs;
}
```

- [ ] **Step 4: Run it, confirm it PASSES**

Run (from `apps/admin`): `npm test -- microbiology/realtime` → PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/microbiology/realtime.ts" "apps/admin/src/__tests__/dashboard/microbiology/realtime.test.ts"
git commit -m "feat(realtime): micro board channel const + relaxed live-poll cadence helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Frontend — page wiring + indicator + page test

**Files:** Modify `apps/admin/src/app/(with-auth)/dashboard/microbiology/page.tsx`; Create `apps/admin/src/__tests__/dashboard/microbiology/page.test.tsx`.

- [ ] **Step 1: Wire `ResistanceTab` to the cadence helper**

In `microbiology/page.tsx`, add to the imports (top of file):
```ts
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
import { MICRO_CHANNEL, microRefetchMs } from "./realtime";
```

Change the `ResistanceTab` component:
- signature `function ResistanceTab() {` → `function ResistanceTab({ subscribed }: { subscribed: boolean }) {`
- in its `useQuery`, `refetchInterval: 60_000,` → `refetchInterval: microRefetchMs(subscribed, 60_000),`

(Leave `OrdersTab` and `AntibiogramTab` unchanged — no `refetchInterval`; they gain real-time via the page-level invalidation.)

- [ ] **Step 2: Wire `MicrobiologyPage` (the orchestrator)**

Replace:
```tsx
export default function MicrobiologyPage() {
  const [tab, setTab] = useState<Tab>("orders");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-foreground mb-1">Microbiology</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Cultures, antibiograms, and antimicrobial resistance dashboard.
      </p>
```
with:
```tsx
export default function MicrobiologyPage() {
  const [tab, setTab] = useState<Tab>("orders");
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(MICRO_CHANNEL, [["micro"]]);

  const liveLabel = subscribed ? "● Live" : "○ Polling";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:micro — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:micro"
    : connected
      ? "Connecting…"
      : "Polling (real-time unavailable)";

  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-1">
        <h1 className="text-3xl font-bold text-foreground">Microbiology</h1>
        <span
          data-testid="micro-realtime-indicator"
          role="status"
          aria-label={
            subscribed
              ? "Live — real-time microbiology updates active"
              : "Polling — real-time updates unavailable"
          }
          title={liveTitle}
          className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
        >
          {liveLabel}
        </span>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Cultures, antibiograms, and antimicrobial resistance dashboard.
      </p>
```

Then change the resistance-tab render line:
```tsx
      {tab === "resistance" && <ResistanceTab />}
```
to:
```tsx
      {tab === "resistance" && <ResistanceTab subscribed={subscribed} />}
```
(Leave `{tab === "orders" && <OrdersTab />}` and `{tab === "antibiogram" && <AntibiogramTab />}` unchanged.)

- [ ] **Step 3: Create the page test**

Create `apps/admin/src/__tests__/dashboard/microbiology/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import MicrobiologyPage from "@/app/(with-auth)/dashboard/microbiology/page";
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

describe("<MicrobiologyPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
    mockedFetchAdminAPI.mockResolvedValue([] as never); // /microbiology/orders -> []
  });

  it("subscribes to staff:micro and shows ○ Polling when not live", async () => {
    renderWithQuery(<MicrobiologyPage />);
    const ind = await screen.findByTestId("micro-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("staff:micro", [["micro"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<MicrobiologyPage />);
    const ind = await screen.findByTestId("micro-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
```

- [ ] **Step 4: Run the micro tests + type-check + lint**

Run (from `apps/admin`): `npm test -- microbiology/` → PASS (realtime + page).
Run: `npm run type-check` → 0 errors (confirms the `subscribed` prop on `ResistanceTab`).
Run: `npm run lint` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/microbiology/page.tsx" "apps/admin/src/__tests__/dashboard/microbiology/page.test.tsx"
git commit -m "feat(realtime): subscribe Microbiology board to staff:micro + Live indicator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Full verification gates

**Files:** none (verification only).

- [ ] **Step 1: Backend gates**

Run (from `apps/backend`): `npm run lint` → PASS.
Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js microRealtimeChannel microRealtimeEmitter --forceExit` → PASS (4 tests).

- [ ] **Step 2: Admin gates**

Run (from `apps/admin`): `npm run type-check` → 0 errors.
Run: `npm run lint` → 0 errors.
Run: `npm test` → full suite PASS (incl. the new `microbiology/realtime` + `microbiology/page` tests).
Run: `npm run build` → PASS.

- [ ] **Step 3: Manual live-WS verification (optional, deploy HELD → local)**

Per spec §9: open the micro board (`● Live`); from a second client `POST /microbiology/orders` (or add an isolate/sensitivity) → the Orders tab / open OrderDetail modal repaint within ~1s without the poll; a new MDR isolate appears on the Resistance tab live.

---

## After the plan: finish the branch

Follow the standing workflow: request review, then `merge --no-ff` into `main`, push **both** remotes (GitHub + Forgejo), delete the branch. **Deploy stays HELD** — do not tag.

## Spec-coverage check (self-review)

- Channel (spec §4.1) → Task 1 Steps 1-4. Emitter (§4.2) → Task 1 Steps 5-8. 4 producer sites (§4.3) → Task 2. Cadence helper (§5.1) → Task 3. Page wiring + indicator + `subscribed` prop (§5.2) → Task 4. Tests (§7) → Tasks 1/3/4. Gates + manual (§9) → Task 5. Tenant/PHI (§6) → Task 2 (explicit `tenantId`). Out-of-scope (no routePolicy/migration/service-change) — no task, as intended.
- Type consistency: `emitMicroEvent(kind, { tenantId })` defined (Task 1.7) + used in the emitter test (1.5) + all 4 producers (Task 2). `microRefetchMs(subscribed, baseMs)` defined (Task 3.3) + consumed by `ResistanceTab` (Task 4.1). `subscribed` prop required by `ResistanceTab` (Task 4.1) + supplied by `MicrobiologyPage` (Task 4.2) — type-check (Task 4.4) enforces. Channel string `"staff:micro"` (catalog/emitter/tests Task 1) ↔ `MICRO_CHANNEL` (Task 3) ↔ page subscription + page test (Task 4). Query key `[["micro"]]` consistent between the page hook and the page test.
