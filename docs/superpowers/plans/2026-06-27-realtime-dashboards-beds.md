# Real-Time-First Dashboards — Slice 1 (Beds) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin Beds dashboard real-time by subscribing to the already-broadcast `admin:beds` channel (instead of polling 60s), via a new reusable `useRealtimeInvalidation` hook + a dynamic poll fallback.

**Architecture:** A generic hook wraps the existing `useRealtimeChannel` and invalidates react-query keys on each channel event (react-query then refetches through the existing query functions). The Beds page subscribes to `admin:beds`, invalidates `["beds"]`, swaps its fixed 60s `refetchInterval` for `subscribed ? 300_000 : 60_000`, and shows a Live/Polling indicator. Zero backend change.

**Tech Stack:** Next.js 16 / React 19 / TypeScript, TanStack Query v5, the existing `useRealtimeChannel` WS client, Jest 30 + @testing-library/react 16 (jsdom).

**Spec:** `docs/superpowers/specs/2026-06-27-realtime-dashboards-beds-design.md`
**Branch:** `feat/realtime-dashboards-beds` (created; spec committed `2f00cd37`).
**Run from** `apps/admin`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/admin/src/hooks/useRealtimeInvalidation.ts` | **Create.** Generic hook: subscribe to a channel, invalidate react-query keys on each event, return connection state. The reusable unit every future dashboard uses. |
| `apps/admin/src/app/(with-auth)/dashboard/beds/page.tsx` | **Modify.** Subscribe to `admin:beds`; invalidate `["beds"]`; dynamic `bedsRefetchMs`; Live/Polling indicator. |
| `apps/admin/src/app/(with-auth)/dashboard/beds/realtime.ts` | **Create.** The pure `bedsRefetchMs(subscribed)` helper (so the interval logic is unit-tested without touching query internals). |
| `apps/admin/src/__tests__/hooks/useRealtimeInvalidation.test.tsx` | **Create.** Hook unit test (mock `useRealtimeChannel`). |
| `apps/admin/src/__tests__/dashboard/beds/realtime.test.ts` | **Create.** `bedsRefetchMs` unit test. |
| `apps/admin/src/__tests__/dashboard/beds/page.test.tsx` | **Modify.** Mock the new hook (so the existing test doesn't open a real WS) + add Live/Polling indicator assertions. |
| `docs/superpowers/plans/2026-06-27-realtime-dashboards-beds.md` | This plan. |

**Grounded facts (verified — do not re-derive):**
- `useRealtimeChannel<T>(channel, { enabled, onEvent })` → `{ lastMessage, connected, subscribed, denied, latencyMs }` (`apps/admin/src/hooks/useRealtimeChannel.ts`). `onEvent` is called on every channel event; the hook handles ticket auth + WS + reconnect.
- Beds page (`page.tsx`) has 3 queries: `["beds","occupancy"]`, `["beds","list"]`, `["wards","list"]`, each `refetchInterval: 60_000` (lines ~112–145), and a `qc = useQueryClient()` already in scope (used by `invalidateBedMaster()`).
- `admin:beds` is broadcast by `bedController.js` on every bed event — no backend work needed.
- Admin jest: `testEnvironment: jsdom`, RTL 16 (`renderHook` available), tests under `src/__tests__/`. Existing beds test mocks `@/lib/api`'s `fetchAdminAPI` and renders the page inside a `QueryClientProvider`.

---

## Task 1: The reusable `useRealtimeInvalidation` hook

**Files:**
- Create: `apps/admin/src/hooks/useRealtimeInvalidation.ts`
- Test: `apps/admin/src/__tests__/hooks/useRealtimeInvalidation.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/__tests__/hooks/useRealtimeInvalidation.test.tsx
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
import { useRealtimeChannel } from "@/hooks/useRealtimeChannel";

// Mock the underlying WS hook so no real socket/ticket fetch happens in jsdom.
// We capture the onEvent callback + control connected/subscribed.
jest.mock("@/hooks/useRealtimeChannel", () => ({
  useRealtimeChannel: jest.fn(),
}));
const mockedChannel = useRealtimeChannel as jest.MockedFunction<typeof useRealtimeChannel>;

let capturedOnEvent: ((msg: { channel: string; data: unknown; receivedAt: number }) => void) | undefined;

function setChannelState(state: { connected: boolean; subscribed: boolean; denied?: string | null }) {
  mockedChannel.mockImplementation((_channel, opts) => {
    capturedOnEvent = opts?.onEvent as typeof capturedOnEvent;
    return {
      lastMessage: null,
      connected: state.connected,
      subscribed: state.subscribed,
      denied: state.denied ?? null,
      latencyMs: null,
    };
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useRealtimeInvalidation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnEvent = undefined;
  });

  it("subscribes to the given channel and returns connection state", () => {
    setChannelState({ connected: true, subscribed: true });
    const { result } = renderHook(() => useRealtimeInvalidation("admin:beds", [["beds"]]), { wrapper });
    expect(mockedChannel).toHaveBeenCalledWith("admin:beds", expect.objectContaining({ enabled: true }));
    expect(result.current.connected).toBe(true);
    expect(result.current.subscribed).toBe(true);
  });

  it("invalidates exactly the passed query keys on each event", () => {
    setChannelState({ connected: true, subscribed: true });
    const invalidateSpy = jest.spyOn(QueryClient.prototype, "invalidateQueries");
    renderHook(() => useRealtimeInvalidation("admin:beds", [["beds"], ["foo", 1]]), { wrapper });

    capturedOnEvent?.({ channel: "admin:beds", data: { event: "patient-admitted" }, receivedAt: Date.now() });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["beds"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["foo", 1] });
    invalidateSpy.mockRestore();
  });

  it("does not subscribe when enabled is false", () => {
    setChannelState({ connected: false, subscribed: false });
    renderHook(() => useRealtimeInvalidation("admin:beds", [["beds"]], { enabled: false }), { wrapper });
    expect(mockedChannel).toHaveBeenCalledWith("admin:beds", expect.objectContaining({ enabled: false }));
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- useRealtimeInvalidation`
Expected: FAIL — `Cannot find module '@/hooks/useRealtimeInvalidation'`.

- [ ] **Step 3: Implement the hook**

```ts
// src/hooks/useRealtimeInvalidation.ts
"use client";

// Turns a polled react-query dashboard into a real-time-first one: subscribe to
// a VHHealth real-time channel and invalidate the given query keys on every
// event (react-query then refetches through the existing query functions).
// Pairs with a dynamic poll fallback in the consumer (real-time when WS is up;
// the consumer keeps a slow safety poll for the at-most-once bus). Generic — no
// per-dashboard logic. The reusable unit for the real-time-dashboards epic.
import { useCallback, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useRealtimeChannel, type RealtimeMessage } from "./useRealtimeChannel";

export function useRealtimeInvalidation(
  channel: string,
  queryKeys: QueryKey[],
  { enabled = true }: { enabled?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const lastEventAtRef = useRef<number | null>(null);

  // Stable onEvent — invalidate every passed key. queryKeys may be a new array
  // each render; read it from a ref so the callback identity stays stable and
  // we don't churn the WS effect (which keys on `channel`/`enabled` only).
  const keysRef = useRef(queryKeys);
  keysRef.current = queryKeys;

  const onEvent = useCallback(
    (_msg: RealtimeMessage) => {
      lastEventAtRef.current = Date.now();
      for (const key of keysRef.current) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    [queryClient],
  );

  const { connected, subscribed, denied } = useRealtimeChannel(channel, { enabled, onEvent });

  return { connected, subscribed, denied, lastEventAt: lastEventAtRef.current };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- useRealtimeInvalidation`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/hooks/useRealtimeInvalidation.ts apps/admin/src/__tests__/hooks/useRealtimeInvalidation.test.tsx
git commit -m "feat(admin): useRealtimeInvalidation hook — subscribe channel, invalidate react-query keys on event"
```

---

## Task 2: The `bedsRefetchMs` fallback helper

**Files:**
- Create: `apps/admin/src/app/(with-auth)/dashboard/beds/realtime.ts`
- Test: `apps/admin/src/__tests__/dashboard/beds/realtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/dashboard/beds/realtime.test.ts
import { bedsRefetchMs } from "@/app/(with-auth)/dashboard/beds/realtime";

describe("bedsRefetchMs", () => {
  it("uses a slow 5-min safety poll while subscribed", () => {
    expect(bedsRefetchMs(true)).toBe(300_000);
  });
  it("falls back to the 60s poll when not subscribed", () => {
    expect(bedsRefetchMs(false)).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npm test -- beds/realtime`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```ts
// src/app/(with-auth)/dashboard/beds/realtime.ts
// Poll cadence for the Beds dashboard. When the admin:beds subscription is live,
// a 5-min safety poll backstops the at-most-once WS bus; if WS drops/denies, we
// revert to the original 60s poll so behaviour is never worse than before.
export const BEDS_LIVE_POLL_MS = 300_000;
export const BEDS_FALLBACK_POLL_MS = 60_000;

export function bedsRefetchMs(subscribed: boolean): number {
  return subscribed ? BEDS_LIVE_POLL_MS : BEDS_FALLBACK_POLL_MS;
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `npm test -- beds/realtime`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/beds/realtime.ts" apps/admin/src/__tests__/dashboard/beds/realtime.test.ts
git commit -m "feat(admin): bedsRefetchMs — dynamic poll cadence for the beds real-time fallback"
```

---

## Task 3: Convert the Beds dashboard to real-time

**Files:**
- Modify: `apps/admin/src/app/(with-auth)/dashboard/beds/page.tsx`

- [ ] **Step 1: Add imports**

Near the top of `page.tsx`, add:
```ts
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
import { bedsRefetchMs } from "./realtime";
```

- [ ] **Step 2: Subscribe + compute the dynamic interval**

Inside the component, ABOVE the three `useQuery` calls (after `const qc = useQueryClient();` and any early hooks), add:
```ts
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation("admin:beds", [["beds"]]);
  const bedsPollMs = bedsRefetchMs(subscribed);
```
Invalidating `["beds"]` covers `["beds","occupancy"]` + `["beds","list"]` by react-query prefix match. `["wards"]` is intentionally excluded — a bed event never changes the ward list.

- [ ] **Step 3: Replace the three fixed intervals**

In each of the three `useQuery` blocks, change `refetchInterval: 60_000,` to `refetchInterval: bedsPollMs,`:
- `["beds","occupancy"]` (≈ line 118)
- `["beds","list"]` (≈ line 131)
- `["wards","list"]` (≈ line 144)

(All three follow the subscription so the page makes one coherent poll cadence; the wards query is cheap and aligning it is simpler than special-casing it.)

- [ ] **Step 4: Add the Live/Polling indicator**

Read the page's header/title JSX (the top heading of the Beds page) and insert this indicator next to it. Define the small inline element where the header renders:
```tsx
  const liveLabel = subscribed ? "● Live" : "○ Polling";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via admin:beds — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via admin:beds"
    : connected
      ? "Connecting…"
      : "Polling every 60s (real-time unavailable)";
```
and in the header JSX, next to the title:
```tsx
        <span
          data-testid="beds-realtime-indicator"
          title={liveTitle}
          className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
        >
          {liveLabel}
        </span>
```
(Use the page's existing class conventions if they differ; the `data-testid` + the `● Live`/`○ Polling` text are what the test asserts.)

- [ ] **Step 5: Type-check + lint the page**

Run: `npm run type-check && npm run lint`
Expected: exit 0 (no unused vars — `connected`/`lastEventAt` are both used by the indicator).

- [ ] **Step 6: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/beds/page.tsx"
git commit -m "feat(admin): beds dashboard real-time via admin:beds + dynamic poll fallback + live indicator"
```

---

## Task 4: Update the Beds page test (mock the hook) + assert the indicator

**Files:**
- Modify: `apps/admin/src/__tests__/dashboard/beds/page.test.tsx`

The page now calls `useRealtimeInvalidation`, which (unmocked) would try to fetch a ticket + open a WebSocket in jsdom and pollute the existing test. Mock it.

- [ ] **Step 1: Mock the hook (default: polling mode) at the top of the test file**

Add alongside the existing `jest.mock("@/lib/api", …)`:
```ts
const mockRealtime = jest.fn(() => ({
  connected: false,
  subscribed: false,
  denied: null,
  lastEventAt: null,
}));
jest.mock("@/hooks/useRealtimeInvalidation", () => ({
  useRealtimeInvalidation: (...args: unknown[]) => mockRealtime(...args),
}));
```
And in `beforeEach`, after `jest.clearAllMocks()`, reset the default:
```ts
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
```

- [ ] **Step 2: Add an indicator test**

Append a test (uses the existing `renderWithQuery` + the existing `fetchAdminAPI` mock from `beforeEach`):
```tsx
  it("shows ○ Polling when the realtime subscription is not live", async () => {
    renderWithQuery(<BedsPage />);
    const ind = await screen.findByTestId("beds-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("admin:beds", [["beds"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<BedsPage />);
    const ind = await screen.findByTestId("beds-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
```

- [ ] **Step 3: Run the beds page test**

Run: `npm test -- dashboard/beds/page`
Expected: PASS (existing tests + the 2 new ones). If an existing test now fails because the page changed, read the failure and fix the test expectation (NOT the page) — the only page change is the indicator + the poll cadence, neither of which alters the existing rendered data.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/__tests__/dashboard/beds/page.test.tsx
git commit -m "test(admin): mock useRealtimeInvalidation in beds page test + assert live/polling indicator"
```

---

## Task 5: Full gate + manual-verification doc

**Files:**
- Modify: `docs/superpowers/specs/2026-06-27-realtime-dashboards-beds-design.md` (append the manual recipe) OR add it to the PR body — keep it in the spec's "Testing boundary" area.

- [ ] **Step 1: Run the full admin gate**

Run (from `apps/admin`):
```bash
npm run type-check && npm run lint && npm test && npm run build
```
Expected: type-check 0, lint 0, jest all green (the prior 247 + the new hook/helper/indicator tests), next build succeeds (the beds route in the manifest). If `npm test` is slow, the targeted suites are `useRealtimeInvalidation`, `beds/realtime`, `dashboard/beds/page`.

- [ ] **Step 2: Document the manual live-verification recipe**

In the spec's Testing-boundary section (or the PR body), record the exact manual steps (honest — there is NO automated live-WS test; jsdom has no WS and deploy is HELD):
```
Manual live verification (local dev stack):
1. Backend: cd apps/backend && npm run dev   (Postgres on :5433 up; Redis optional — degrades to local delivery)
2. Admin:   cd apps/admin && npm run dev      (:3001)
3. Log in, open /dashboard/beds → indicator shows "● Live" once subscribed.
4. Trigger a bed change (admit/discharge via the dashboard, or a second client / a direct
   PUT /api/v1/beds/:id) → the grid + occupancy update within ~1s WITHOUT waiting for a poll.
5. Kill Redis (or the backend WS) → indicator falls to "○ Polling"; the 60s poll keeps it fresh.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-27-realtime-dashboards-beds-design.md
git commit -m "docs: manual live-verification recipe for the beds real-time slice"
```

---

## Closeout

After all tasks: use **superpowers:finishing-a-development-branch**. Verify the full admin gate (type-check + lint + jest + build) is green, merge `feat/realtime-dashboards-beds` to `main` `--no-ff`, push BOTH remotes (`github` + `origin`), delete the branch, tick ROADMAP §0 Epic #4 + the (to-be-created) real-time-dashboards memory. **Deploy stays HELD.** The PR/commit must state the live push is verified MANUALLY (per the recipe), not by an automated test.

---

## Self-Review

**Spec coverage:** Unit 1 (hook) → Task 1. Dynamic fallback helper → Task 2. Beds conversion (subscribe + invalidate `["beds"]` + dynamic interval + indicator) → Task 3. Tests (hook test → Task 1; `bedsRefetchMs` test → Task 2; beds page indicator + the must-mock-the-hook detail → Task 4) → covered. Honest manual-verification boundary → Task 5. At-most-once safety poll = `BEDS_LIVE_POLL_MS` (5 min) in Task 2, used in Task 3.

**Placeholder scan:** No TBD/TODO. The one "read the header JSX to place the indicator" in Task 3 Step 4 is a locate-instruction (the page's exact heading markup isn't reproduced here), but the indicator element + its `data-testid`/text/title are fully specified — the engineer inserts a complete, given element. The `realtime.ts` helper + the hook + all tests are complete code.

**Type/name consistency:** `useRealtimeInvalidation(channel, queryKeys, { enabled })` → `{ connected, subscribed, denied, lastEventAt }` is identical across the hook (Task 1), the page (Task 3), and the page-test mock (Task 4). `bedsRefetchMs(subscribed)` + `BEDS_LIVE_POLL_MS`/`BEDS_FALLBACK_POLL_MS` consistent across Task 2 and Task 3. The `data-testid="beds-realtime-indicator"` + the `● Live`/`○ Polling` text match between Task 3 (page) and Task 4 (test).
