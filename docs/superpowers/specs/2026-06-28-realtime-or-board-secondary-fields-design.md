# Real-time OR Board — Approach B: secondary-field producers

- **Date:** 2026-06-28
- **Epic:** #4 Real-time-first dashboards (OR Board slice 4 — completion)
- **Status:** Design approved → spec
- **Builds on:** the shipped OR Board slice (`staff:or-board` channel, `emitOrBoardEvent`, the page subscribed via `useRealtimeInvalidation("staff:or-board", [["theatre","board"]])`). Spec `docs/superpowers/specs/2026-06-28-realtime-dashboards-or-board-design.md`.

## 1. Context & goal

The OR Board slice wired real-time only for the 3 case-lifecycle events (schedule/status/cancel). The
board's **secondary fields** — WHO safety phases (sign_in/time_out/sign_out dots), open complications,
pre-op checklist (consent/blood), and intra/post-op note counts — still update only on the 120s safety
poll. **Goal:** emit `staff:or-board` on those write sites too so **every board field pushes live**, then
relax the live poll to a 5-min safety net.

**This is purely backend producer-wiring + a 1-line frontend cadence change.** No new channel, emitter,
hook, page, or test infrastructure — the board already invalidates the whole `["theatre","board"]` query
on **any** `staff:or-board` event, and the existing `emitOrBoardEvent` is reused as-is.

## 2. Scope (B-full)

**In scope — 6 producer sites:**
- WHO safety phases — `PUT /safety/:scheduleId/:phase` (`surgicalDocumentationRoutes.js` → `upsertSafetyChecklistPhase`).
- Complication created — `POST /complications` (→ `recordComplicationAlert`).
- Complication resolved — `PATCH /complications/:id/resolve` (→ `resolveComplicationAlert`).
- Intra-op note created — `POST /intraop` (→ `createIntraopNote`).
- Post-op note created — `POST /postop` (→ `createPostopNote`).
- Pre-op checklist — `PUT /theatre/:id/checklist` (`theatreRoutes.js` → `completeChecklist`).
- Frontend: relax `OR_LIVE_POLL_MS` 120_000 → 300_000 (fallback stays 60_000).

**Out of scope (YAGNI):**
- `PATCH /complications/:id/acknowledge` — does NOT change `open_complications` (the board counts alerts
  `status NOT IN ('resolved','false_positive')`; "acknowledged" is still open), so no emit.
- `finalizeIntraopNote`/`finalizePostopNote` — finalize doesn't change the note **count** (the row already
  exists; the board `COUNT(*)`s all notes), so no emit.
- Anesthesia/implants/preop-checklist-draft endpoints — not board-visible fields.
- No change to the channel, emitter, hook, page subscription, board UI, or data model.

## 3. Architecture & data flow

Identical to the OR Board slice — each producer calls the existing `emitOrBoardEvent(kind, { scheduleId, status, tenantId })` → `broadcast('staff:or-board', …, { tenantId })`; the board's `useRealtimeInvalidation` invalidates `[["theatre","board"]]` → react-query refetches the whole board (all fields fresh). The emit is a **bare signal** (kind + ids, no PHI); `scheduleId` is informational since the refetch pulls the authoritative board.

## 4. Backend — producers

All emits are **post-mutation, before `success(res, …)`, inside the existing handler try**; `emitOrBoardEvent`
never throws (internal try/catch). The surgical-doc handlers resolve tenant via `req.tenantId`; the checklist
handler (theatreRoutes.js) via `tenantOf(req)` — each matches its file's existing pattern.

### 4.1 `apps/backend/src/routes/admin/surgicalDocumentationRoutes.js` (import + 5 emits)
Import: `import { emitOrBoardEvent } from '../../utils/websocket/realtimeEmitter.js';`

| Handler | After the service call, emit |
|---|---|
| `PUT /safety/:scheduleId/:phase` | `emitOrBoardEvent('safety-phase', { scheduleId: Number(req.params.scheduleId), tenantId: req.tenantId })` |
| `POST /complications` | `emitOrBoardEvent('complication', { scheduleId: Number(body.ot_schedule_id), tenantId: req.tenantId })` |
| `PATCH /complications/:id/resolve` | `emitOrBoardEvent('complication-resolved', { scheduleId: row?.ot_schedule_id ?? null, tenantId: req.tenantId })` |
| `POST /intraop` | `emitOrBoardEvent('note', { scheduleId: Number(body.ot_schedule_id), tenantId: req.tenantId })` |
| `POST /postop` | `emitOrBoardEvent('note', { scheduleId: Number(body.ot_schedule_id), tenantId: req.tenantId })` |

(`body` = `req.body || {}` as already destructured in each handler. For resolve, the request carries the
alert `:id`, not the schedule id, so use the resolved `row?.ot_schedule_id`; a null scheduleId still triggers
the board refetch — the signal is what matters.)

### 4.2 `apps/backend/src/routes/theatre/theatreRoutes.js` (1 emit)
In `PUT /:id/checklist` (handler calls `theatreService.completeChecklist(parseInt(id,10), checklist, { tenantId: tenantOf(req), completedBy: … })` → `result`), after the call, before `success`:
`emitOrBoardEvent('checklist', { scheduleId: Number(id), status: result?.status, tenantId: tenantOf(req) })`
(`emitOrBoardEvent` is already imported in this file from the OR Board slice.)

## 5. Frontend — cadence relax
`apps/admin/src/app/(with-auth)/dashboard/or-board/realtime.ts`: change `OR_LIVE_POLL_MS = 120_000` → `300_000`
(every board field now emits, so the live poll is a 5-min safety net). `OR_FALLBACK_POLL_MS` stays `60_000`.
Update the comment accordingly. No page change (it already reads `orRefetchMs(subscribed)`).

## 6. Tenant scoping
Each emit passes the request tenant explicitly (`req.tenantId` for surgical-doc, `tenantOf(req)` for
checklist) → `broadcast`'s per-broadcast tenant filter delivers only to that tenant's theatre staff. No
cross-tenant signal leak. (Matches the OR Board slice + DELTA-002 lesson.)

## 7. Testing
- **Backend:** no new automated test — these are route-handler wiring (the emit logic is already covered by
  `orBoardEmitter.test.js`; mounting the surgical/theatre routers needs auth/DB scaffolding). Verified by
  `npm run lint` + the existing `orBoardChannel`/`orBoardEmitter` unit tests. (Same precedent as the OR
  Board slice's producer-wiring task.)
- **Frontend:** **update** `apps/admin/src/__tests__/dashboard/or-board/realtime.test.ts` — the subscribed
  assertion changes `120_000` → `300_000`.
- **Honest limitation:** live WS push not auto-tested (no WS in jsdom; deploy HELD). Manual recipe §10.

## 8. Resilience
- Emit is best-effort, post-mutation, non-blocking (`emitOrBoardEvent` try/catches internally → never throws
  into the surgical/theatre handlers; can't break a clinical write).
- No new persisted rows (canonical-timeline untouched); no new auth surface.

## 9. Verification
- **Gates:** backend `lint` + `orBoardChannel`/`orBoardEmitter` tests; admin `type-check`/`lint`/`test`/`build`.
- **Manual (deploy HELD → local):** open the OR Board (`●Live`); from a second client hit
  `PUT /surgical/safety/:id/sign_in` (or a complication/note/checklist write) → the board's phase
  dots/complication count/etc. repaint within ~1s without the poll.

## 10. File-change inventory
- `apps/backend/src/routes/admin/surgicalDocumentationRoutes.js` — import + 5 emit calls.
- `apps/backend/src/routes/theatre/theatreRoutes.js` — +1 emit call (checklist).
- `apps/admin/src/app/(with-auth)/dashboard/or-board/realtime.ts` — `OR_LIVE_POLL_MS` 120_000 → 300_000 + comment.
- `apps/admin/src/__tests__/dashboard/or-board/realtime.test.ts` — update the live assertion to 300_000.

## 11. Risks
| Risk | Mitigation |
|---|---|
| Emit blocks a clinical surgical write | Emitter try/catches; post-mutation, non-blocking. |
| Cross-tenant signal leak | Explicit request tenant on each broadcast + per-broadcast tenant filter. |
| Note counts lag at 300s on a quiet case | Acceptable (informational); adjacent WHO/status/complication events on the same case refetch the whole board (incl. counts). |
| Resolve emit gets null scheduleId | Harmless — the board-wide invalidation still fires; scheduleId is informational only. |
