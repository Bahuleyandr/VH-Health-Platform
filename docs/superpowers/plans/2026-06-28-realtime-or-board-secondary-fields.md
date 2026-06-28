# OR Board Secondary-Field Producers (Approach B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every OR-Board field push live by emitting `staff:or-board` at the 6 secondary write sites (WHO phases, complication create/resolve, intra/post-op note create, pre-op checklist), then relax the live poll 120s→300s.

**Architecture:** Pure backend producer-wiring + a 1-line frontend cadence change. Reuses the shipped `emitOrBoardEvent`→`staff:or-board` channel and the page's existing `useRealtimeInvalidation("staff:or-board", [["theatre","board"]])` — no new channel/emitter/hook/page. Each emit is best-effort, post-mutation, inside the handler try (the emitter never throws).

**Tech Stack:** Node/Express 5 + WS fabric, Next.js 16 + TanStack Query, Jest.

**Spec:** `docs/superpowers/specs/2026-06-28-realtime-or-board-secondary-fields-design.md`
**Branch:** `feat/realtime-or-board-secondary` (already created off `main`).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `apps/backend/src/routes/admin/surgicalDocumentationRoutes.js` | Surgical-doc routes | Modify: import + 5 emit calls |
| `apps/backend/src/routes/theatre/theatreRoutes.js` | OT routes | Modify: +1 emit call (checklist) |
| `apps/admin/src/app/(with-auth)/dashboard/or-board/realtime.ts` | OR-board poll cadence | Modify: `OR_LIVE_POLL_MS` 120_000→300_000 |
| `apps/admin/src/__tests__/dashboard/or-board/realtime.test.ts` | Cadence test | Modify: update live assertion to 300_000 |

**Run-command reference**
- Backend (from `apps/backend`): `npm run lint` · `node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit`
- Admin (from `apps/admin`): `npm test -- <pattern>` · `npm run type-check` · `npm run lint` · `npm run build`

---

## Task 1: Backend — 5 surgical-doc producers

**Files:** Modify `apps/backend/src/routes/admin/surgicalDocumentationRoutes.js`.

> **Test note:** route-handler wiring (the emit logic is already unit-tested in `orBoardEmitter.test.js`); verified by `lint` + the or-board unit tests, matching the OR-Board slice's producer-wiring precedent. `emitOrBoardEvent` never throws, so it can't disturb these clinical writes.

- [ ] **Step 1: Add the import**

In `apps/backend/src/routes/admin/surgicalDocumentationRoutes.js`, immediately after the import block that ends `} from '../../services/theatre/surgicalDocumentationService.js';`, add:

```js
import { emitOrBoardEvent } from '../../utils/websocket/realtimeEmitter.js';
```

- [ ] **Step 2: Emit on WHO safety phase**

In the `PUT /safety/:scheduleId/:phase` handler, after `const row = await upsertSafetyChecklistPhase({ … });` and before `return success(res, row, …);`, add:

```js
    emitOrBoardEvent('safety-phase', { scheduleId: Number(req.params.scheduleId), tenantId: req.tenantId });
```

- [ ] **Step 3: Emit on complication created**

In the `POST /complications` handler, after `const row = await recordComplicationAlert({ … });` and before `return success(res, row, …);`, add:

```js
    emitOrBoardEvent('complication', { scheduleId: Number(body.ot_schedule_id), tenantId: req.tenantId });
```

- [ ] **Step 4: Emit on complication resolved**

In the `PATCH /complications/:id/resolve` handler, after `const row = await resolveComplicationAlert({ … });` and before `return success(res, row, …);`, add:

```js
    emitOrBoardEvent('complication-resolved', { scheduleId: row?.ot_schedule_id ?? null, tenantId: req.tenantId });
```

- [ ] **Step 5: Emit on intra-op note created**

In the `POST /intraop` handler, after `const row = await createIntraopNote({ … });` and before `return success(res, row, …);`, add:

```js
    emitOrBoardEvent('note', { scheduleId: Number(body.ot_schedule_id), tenantId: req.tenantId });
```

- [ ] **Step 6: Emit on post-op note created**

In the `POST /postop` handler, after `const row = await createPostopNote({ … });` and before `return success(res, row, …);`, add:

```js
    emitOrBoardEvent('note', { scheduleId: Number(body.ot_schedule_id), tenantId: req.tenantId });
```

Do NOT emit on any other handler (preop drafts, anesthesia, implants, `/intraop/:id/finalize`, `/postop/:id/finalize`, `/complications/:id/acknowledge`) — those don't change a board-visible field.

- [ ] **Step 7: Verify**

Run (from `apps/backend`): `npm run lint` → PASS.
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js orBoardChannel orBoardEmitter --forceExit` → PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/routes/admin/surgicalDocumentationRoutes.js
git commit -m "feat(realtime): emit staff:or-board on WHO phases, complications, and OT notes"
```

---

## Task 2: Backend — checklist producer

**Files:** Modify `apps/backend/src/routes/theatre/theatreRoutes.js`.

> `emitOrBoardEvent` is already imported in this file (from the OR-Board slice). `tenantOf(req)` helper exists in this file.

- [ ] **Step 1: Emit on pre-op checklist**

In the `PUT /:id/checklist` handler (calls `theatreService.completeChecklist(parseInt(id, 10), checklist, { tenantId: tenantOf(req), completedBy: … })` → `result`), after `const result = await theatreService.completeChecklist(…);` and before `return success(res, result, 'Pre-op checklist updated successfully');`, add:

```js
    emitOrBoardEvent('checklist', { scheduleId: Number(id), status: result?.status, tenantId: tenantOf(req) });
```

- [ ] **Step 2: Verify**

Run (from `apps/backend`): `npm run lint` → PASS.
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js orBoardChannel orBoardEmitter --forceExit` → PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/routes/theatre/theatreRoutes.js
git commit -m "feat(realtime): emit staff:or-board on the OT pre-op checklist write"
```

---

## Task 3: Frontend — relax the live poll to 300s

**Files:** Modify `apps/admin/src/app/(with-auth)/dashboard/or-board/realtime.ts` and `apps/admin/src/__tests__/dashboard/or-board/realtime.test.ts`.

- [ ] **Step 1: Update the failing test**

In `apps/admin/src/__tests__/dashboard/or-board/realtime.test.ts`, change the subscribed case to expect 300_000:

```ts
  it("uses a 5-min safety poll while subscribed", () => {
    expect(orRefetchMs(true)).toBe(300_000);
  });
```

(Leave the `orRefetchMs(false) === 60_000` case unchanged.)

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/admin`): `npm test -- or-board/realtime`
Expected: FAIL — `orRefetchMs(true)` still returns `120_000`.

- [ ] **Step 3: Bump the constant**

In `apps/admin/src/app/(with-auth)/dashboard/or-board/realtime.ts`, change `OR_LIVE_POLL_MS` and the comment:

```ts
// Poll cadence for the OR Board. Every board field now pushes live (case lifecycle + WHO phases +
// complications + checklist + notes), so while subscribed we drop to a 5-min safety poll; if the socket
// drops, revert to the original 60s so behaviour is never worse than before.
export const OR_LIVE_POLL_MS = 300_000;
export const OR_FALLBACK_POLL_MS = 60_000;

export function orRefetchMs(subscribed: boolean): number {
  return subscribed ? OR_LIVE_POLL_MS : OR_FALLBACK_POLL_MS;
}
```

- [ ] **Step 4: Run to verify it passes**

Run (from `apps/admin`): `npm test -- or-board/realtime` → PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/or-board/realtime.ts" "apps/admin/src/__tests__/dashboard/or-board/realtime.test.ts"
git commit -m "feat(realtime): relax OR Board live poll to 5min (all fields now push)"
```

---

## Task 4: Full verification gates

**Files:** none (verification only).

- [ ] **Step 1: Backend gates**

Run (from `apps/backend`): `npm run lint` → PASS.
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js orBoardChannel orBoardEmitter --forceExit` → PASS (4 tests).

- [ ] **Step 2: Admin gates**

Run (from `apps/admin`): `npm run type-check` → 0 errors.
Run (from `apps/admin`): `npm run lint` → 0 errors.
Run (from `apps/admin`): `npm test` → full suite PASS (the updated or-board/realtime test included).
Run (from `apps/admin`): `npm run build` → PASS.

- [ ] **Step 3: Manual live-WS verification (optional, deploy HELD → local)**

Per spec §9: open the OR Board (`●Live`); from a second client hit a WHO-phase / complication / note / checklist write → the board's dots/counts repaint within ~1s without the poll.

---

## After the plan: finish the branch

Follow the standing workflow: request review, then `merge --no-ff` into `main`, push **both** remotes (GitHub + Forgejo), delete the branch. **Deploy stays HELD** — do not tag.

## Spec-coverage check (self-review)

- 5 surgical-doc producers (spec §4.1) → Task 1. Checklist producer (§4.2) → Task 2. Cadence relax (§5) → Task 3. Gates + manual (§9) → Task 4. Tenant scoping (§6) → Tasks 1-2 (explicit `req.tenantId`/`tenantOf(req)`). Out-of-scope (acknowledge/finalize/anesthesia/implants; no new test infra) — no task, as intended. The emit-payload kinds (`safety-phase`/`complication`/`complication-resolved`/`note`/`checklist`) all flow through the existing `emitOrBoardEvent(kind, …)` signature unchanged.
