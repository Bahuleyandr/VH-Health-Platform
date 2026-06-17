# Clinical Notes Autosave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Autosave in-progress OP/IP clinical notes (staff Flutter app) to a
server-side `note_drafts` store that emits NO canonical timeline/audit events;
finalize (existing Save/Sign) commits the real note and clears the draft.

**Architecture:** New `note_drafts` PHI table (RLS, author-scoped) + a draft
service/routes with no `recordCanonicalNoteEvent`; `createNote` clears the
matching draft on commit; an expiry janitor. Flutter debounced autosave on OP
Workspace + nursing notes with restore-on-open + a status indicator.

**Tech Stack:** Node 22 / Express 5 / PostgreSQL 17 (raw SQL migration + Prisma);
Flutter (staff app); Jest (backend deep test) + Flutter widget test.

Spec: `docs/superpowers/specs/2026-06-17-clinical-notes-autosave-design.md`.

---

## File structure

**Backend**
- Create `apps/backend/src/migrations/NNN_note_drafts.sql` (next free number).
- Regenerate `apps/backend/prisma/schema.prisma` (`prisma db pull`).
- Create `apps/backend/src/services/emr/clinicalNoteDraftService.js`.
- Modify `apps/backend/src/routes/emr/clinicalNotesRoutes.js` (3 draft routes).
- Modify `apps/backend/src/services/emr/clinicalNotesService.js` (clear draft on `createNote`).
- Modify the scheduler (add an expiry janitor; reuse `withJobLock`).
- Create `apps/backend/src/tests/note-drafts.deep.test.js`.

**Flutter (`apps/staff`)**
- Modify `lib/core/services/medical_api_service.dart` (draft client).
- Create `lib/features/emr/note_draft_autosave.dart` (reusable debounce/heartbeat helper).
- Modify `lib/features/opd/screens/op_doctor_workspace_screen.dart` (wire autosave).
- Modify `lib/features/nursing/screens/nursing_notes_screen.dart` (wire autosave).
- Create `apps/staff/test/features/emr/note_draft_autosave_test.dart`.

---

### Task 1: `note_drafts` migration + schema regen

- [ ] **Step 1:** Find the next free migration number (`ls apps/backend/src/migrations | tail`).
- [ ] **Step 2:** Write `NNN_note_drafts.sql`:

```sql
CREATE TABLE IF NOT EXISTS note_drafts (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  author_uid      UUID NOT NULL,
  patient_uid     UUID NOT NULL,
  appointment_id  INTEGER,
  note_type       VARCHAR(60) NOT NULL,
  content         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_note_drafts_context
  ON note_drafts (tenant_id, author_uid, patient_uid, COALESCE(appointment_id, 0), note_type);
CREATE INDEX IF NOT EXISTS idx_note_drafts_author ON note_drafts (tenant_id, author_uid, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_note_drafts_expiry ON note_drafts (expires_at);
ALTER TABLE note_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON note_drafts
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid
         OR current_setting('app.current_tenant_id', true) IS NULL
         OR current_setting('app.current_tenant_id', true) = 'bypass');
```
(Mirror the exact RLS-policy idiom of the newest PHI migration — read one first
so the `current_setting`/bypass shape matches; adjust if the repo uses a helper.)

- [ ] **Step 3:** `node scripts/qa-reset.mjs` (or ci-setup-db) to apply; `npx prisma db pull`; `node scripts/check-schema-drift.mjs` → clean.
- [ ] **Step 4:** Commit.

### Task 2: `clinicalNoteDraftService.js`

- [ ] **Step 1 (test-first cues):** the service exports `upsertDraft({tenantId, authorUid, patientUid, appointmentId, noteType, content})`, `getDraft({tenantId, authorUid, patientUid, appointmentId, noteType})`, `deleteDraft({tenantId, authorUid, patientUid, appointmentId, noteType})`. ALL use `setTenantTx`. **None call `recordCanonicalNoteEvent`.**
- [ ] **Step 2:** Implement upsert via `INSERT ... ON CONFLICT (tenant_id, author_uid, patient_uid, COALESCE(appointment_id,0), note_type) DO UPDATE SET content=EXCLUDED.content, updated_at=NOW(), expires_at=NOW()+INTERVAL '14 days'`. Use parameterized raw SQL (spread params; `::jsonb` cast on content). `getDraft`/`deleteDraft` filter `author_uid = $authorUid` (author-only).
- [ ] **Step 3:** `npm run lint && npm run lint:raw-params` clean. Commit.

### Task 3: draft routes in `clinicalNotesRoutes.js`

- [ ] **Step 1:** Add (before the `/:id` routes to avoid shadowing):
  - `router.put('/draft', rejectMobileClinicalWrite, guardClinicalNoteWrite, handler)` — body `{patient_uid, appointment_id?, note_type, content}`; `authorUid = req.user.uid`; returns `success(res, {id, updated_at})`.
  - `router.get('/draft', handler)` — query `{patient_uid, appointment_id?, note_type}`; returns the author's draft or `success(res, null)`.
  - `router.delete('/draft', handler)` — same context; returns ok.
  - Reuse `guardClinicalNoteWrite` for PUT (same authz as a note write); GET/DELETE are author-self-scoped so a relationship check + author filter suffice.
- [ ] **Step 2:** Manual curl smoke against the running backend (PUT→GET→DELETE round-trip, with a PATIENT/staff JWT). Commit.

### Task 4: clear draft on finalize (`clinicalNotesService.createNote`)

- [ ] **Step 1:** After the create tx commits, best-effort `deleteDraft({...context})` derived from the created note (tenant, author=note author, patient_uid, appointment_id, note_type). Wrap in try/catch + `logger.warn` on failure. Do NOT add it inside the canonical tx.
- [ ] **Step 2:** Commit.

### Task 5: expiry janitor

- [ ] **Step 1:** Add a scheduled job (reuse the existing scheduler + `withJobLock('note_drafts_expiry', ...)`), daily, running `DELETE FROM note_drafts WHERE expires_at < NOW()` via plain prisma. Log the deleted count.
- [ ] **Step 2:** Commit.

### Task 6: backend deep test `note-drafts.deep.test.js`

- [ ] **Step 1 (write failing test):** real-PG test asserting:
  - upsert creates 1 row; a 2nd upsert (same context) updates content + `updated_at`, still 1 row.
  - `getDraft` returns the author's draft; a DIFFERENT `author_uid` gets null; (RLS) a different tenant cannot read it.
  - `deleteDraft` removes it.
  - **`SELECT COUNT(*) FROM clinical_timeline_events` and `clinical_audit_events` are UNCHANGED across upsert/get/delete** (snapshot before/after) — the load-bearing invariant.
  - `clinicalNotesService.createNote(...)` for the same context deletes the draft.
- [ ] **Step 2:** Run → pass. Commit.

### Task 7: Flutter draft API client (`medical_api_service.dart`)

- [ ] **Step 1:** Add `putNoteDraft({patientUid, appointmentId, noteType, content})` → `PUT /emr/notes/draft`; `getNoteDraft({...})` → `GET`; `deleteNoteDraft({...})` → `DELETE`. Mirror the existing note methods' auth/headers.
- [ ] **Step 2:** `melos run analyze` clean. Commit.

### Task 8: reusable autosave helper `note_draft_autosave.dart`

- [ ] **Step 1:** A small controller: `NoteDraftAutosave` with `onChanged(Map content)` (debounce 3s + 15s heartbeat), `restore()` (GET → returns content/updatedAt), `clear()` (DELETE + cancel timers), and a `ValueNotifier<AutosaveStatus>` (idle/saving/saved(time)/offline). Uses the api client + `ConnectivitySyncService` for offline enqueue.
- [ ] **Step 2:** Unit/widget test in Task 11. `melos run analyze`. Commit.

### Task 9: wire OP Doctor Workspace

- [ ] **Step 1:** Read `op_doctor_workspace_screen.dart`. On init, `restore()` → if a draft exists, populate controllers + show a dismissible "Restored unsaved draft from <time>" banner. Attach `onChanged` to the 5 controllers (build the content map chief/history/exam/diagnosis/plan). Show the status indicator. In `_saveClinicalNote` success path, call `clear()`.
- [ ] **Step 2:** `melos run analyze`. Commit.

### Task 10: wire nursing notes

- [ ] **Step 1:** Same pattern in `nursing_notes_screen.dart` (content `{body}`, note_type from the picker, no appointment_id). Clear on submit success.
- [ ] **Step 2:** `melos run analyze`. Commit.

### Task 11: Flutter widget test

- [ ] **Step 1:** `note_draft_autosave_test.dart`: typing → after debounce, a `putNoteDraft` is issued (mock api, fake timers); `restore()` populates; `clear()` deletes + cancels.
- [ ] **Step 2:** `melos run test` (staff) green. Commit.

### Task 12: full gates + ship

- [ ] **Step 1:** Backend: `npm run lint`, `lint:raw-params`, `check:schema-drift`, the new deep test + the existing clinicalNotes tests. Flutter: `melos run analyze` + `melos run test`.
- [ ] **Step 2:** Merge `feat/clinical-notes-autosave` --no-ff → main; push github + origin; delete branch. Update the spec status to IMPLEMENTED.

---

## Self-review notes
- DRY: one autosave helper shared by OP + nursing.
- YAGNI: v1 = compose-phase of a new note; no edit-existing autosave, no admin.
- TDD: the load-bearing invariant (zero canonical events from the draft path) has
  an explicit before/after-count assertion in Task 6.
- Safety: draft path never touches `recordCanonicalNoteEvent`; finalize unchanged.
