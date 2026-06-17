# Clinical Notes Autosave — Design

**Status: APPROVED (design) 2026-06-17.** Next: writing-plans → implementation.

**Goal:** Autosave in-progress OP/IP clinical notes in the Flutter staff app so a
clinician never loses work and never has to press *Save* just to avoid losing a
draft — **without** polluting the canonical clinical timeline or the audit log.

---

## 1. Context (grounded in code)

- Clinical notes are typed in the **staff Flutter app** (`apps/staff`):
  - **OP Doctor Workspace** — `lib/features/opd/screens/op_doctor_workspace_screen.dart`
    (`_chiefCtrl`, `_historyCtrl`, `_examCtrl`, `_diagnosisCtrl`, `_planCtrl`;
    `_saveClinicalNote()` ~L474–539).
  - **Nursing notes** — `lib/features/nursing/screens/nursing_notes_screen.dart`
    (`_noteCtrl` + note_type; `_submit()` ~L202–250; already has an offline queue
    via `ConnectivitySyncService`).
  - The admin (Next.js) portal has **no** clinical-notes entry — out of scope.
- Current save = a manual button → `POST /emr/notes` (create) / `PUT /emr/notes/:id`
  (update) / `POST /emr/notes/:id/sign`, handled by
  `apps/backend/src/services/emr/clinicalNotesService.js`.
- **Every** note write runs an atomic `setTenantTx` that ALSO calls
  `recordCanonicalNoteEvent(...)` → writes a `clinical_timeline_events` row + a
  `clinical_audit_events` row in the same transaction (the canonical-timeline
  invariant from `docs/CANONICAL_CLINICAL_TIMELINE.md`). Unsigned saves use
  `eventStatus:'draft'`, signed use `'signed'` — but **both emit canonical rows**.
- No existing debounce/autosave. The downtime policy in
  `canonicalClinicalPlatformService.js` already names `op_note_draft` /
  `nursing_note_draft` as *local-draft* writes — i.e. the platform already intends
  note drafts to stay out of the canonical timeline until finalized.

**Driving constraint:** naive autosave-to-`/emr/notes` would write a canonical
timeline + audit row on every autosave tick — unacceptable on a clinical/legal
record. Drafts must live somewhere that emits **no** canonical events.

---

## 2. Approach (chosen): server-side draft store

A new `note_drafts` table holds in-progress note text. Autosave **upserts** the
draft; it emits **no** canonical timeline/audit events. **Finalize** (the existing
*Save note* / *Sign* buttons) runs the unchanged `/emr/notes` flow — which *does*
emit the canonical rows, exactly as today — and then the matching draft is
deleted. The patient's legal record therefore only ever shows intentional saves;
the draft is a durable, recoverable, cross-device scratchpad.

---

## 3. Data model — `note_drafts`

New migration `apps/backend/src/migrations/NNN_note_drafts.sql` (next free number).

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` PK | |
| `tenant_id` | `UUID NOT NULL` | RLS `tenant_isolation` policy; column default = the standard literal tenant default (match other PHI tables / migration 310 pattern) |
| `author_uid` | `UUID NOT NULL` | the composing clinician — the ONLY actor who reads/writes this draft |
| `patient_uid` | `UUID NOT NULL` | |
| `appointment_id` | `INTEGER NULL` | the OP encounter; `NULL` for IP/nursing |
| `note_type` | `VARCHAR(60) NOT NULL` | e.g. `op_consultation`, `nursing_note`, `progress` |
| `content` | `JSONB NOT NULL DEFAULT '{}'::jsonb` | field-map (OP: `{chief,history,exam,diagnosis,plan}`; nursing: `{body}`) |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | last autosave; basis for last-write-wins |
| `expires_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days'` | janitor TTL |

Indexes / constraints:
- `UNIQUE` expression index on `(tenant_id, author_uid, patient_uid, COALESCE(appointment_id, 0), note_type)`
  — exactly one live draft per (clinician, patient, encounter, note type); the
  upsert target.
- `idx_note_drafts_author` on `(tenant_id, author_uid, updated_at DESC)`.
- `idx_note_drafts_expiry` on `(expires_at)` for the janitor.
- RLS: enable + `tenant_isolation` policy mirroring the existing PHI-table pattern.
- **Not** registered as a canonical clinical table — no timeline/audit coupling
  anywhere in its write path. Regenerate `prisma/schema.prisma` (`prisma db pull`)
  after the migration; drift check must pass.

---

## 4. Backend

New `apps/backend/src/services/emr/clinicalNoteDraftService.js` + routes added to
`clinicalNotesRoutes.js`, behind the existing `validateApiKey → jwtAuth → tenant`
chain. Every DB op uses `setTenantTx` (RLS). **No `recordCanonicalNoteEvent` may
appear anywhere in this service** (enforced by a test, §7).

- `PUT /emr/notes/draft`
  - body `{ patient_uid, appointment_id?, note_type, content }`; `author_uid = req.user.uid`.
  - Upsert on the unique key → bumps `updated_at`, resets `expires_at`.
  - RBAC: reuse the note-write authorization (the author must be permitted to
    write notes for this patient — `guardClinicalNoteWrite` or its relationship
    check). Returns `{ id, updated_at }`.
- `GET /emr/notes/draft?patient_uid&appointment_id&note_type`
  - Returns the **author's own** draft for the context (`WHERE author_uid = req.user.uid`),
    or `204`/`{data:null}` if none.
- `DELETE /emr/notes/draft`
  - By context (or `id`), author-scoped.
- **Promotion (no new event type):** `clinicalNotesService.createNote` (and
  `updateNote` on first commit) deletes the matching draft **post-commit,
  best-effort** (by context). The client also issues `DELETE` on finalize as a
  backstop. A failed delete is harmless (the janitor / stale-draft rule cover it).
- **Expiry janitor:** a cron wrapped in `withJobLock()` deletes
  `note_drafts WHERE expires_at < NOW()` (reuse the scheduler pattern).

Design decisions:
- **Author-only scope** on read/write/delete (a private scratchpad; never shown
  to other clinicians, never in the timeline).
- **PHI logging:** the draft endpoints do **not** call `phiAccessLogger` — opening
  the chart/encounter already logged PHI access to this patient, and the draft is
  the author's own composition. The finalize path keeps its full PHI logging,
  unchanged. *(Flag for compliance review at implementation.)*
- No version bump and no signing on drafts.

---

## 5. Frontend (Flutter — OP Doctor Workspace + nursing notes)

- New draft client in `lib/core/services/medical_api_service.dart`:
  `putNoteDraft`, `getNoteDraft`, `deleteNoteDraft`.
- **Debounced autosave**: a `Timer` fires ~**3 s** after the last keystroke; also
  on field-blur, on `didChangeAppLifecycleState` → paused/inactive, and on a ~**15 s**
  heartbeat while actively editing → `PUT /emr/notes/draft` with the current
  `content` map.
- **Restore on open**: `GET /emr/notes/draft` for the context → if present, populate
  the controllers and show a dismissible banner *"Restored unsaved draft from
  <time>"*.
- **Status indicator**: a small line near the form — *"Saving…"* while a PUT is in
  flight, *"Saved <time>"* on success, *"Offline — will sync"* when queued.
- **On Save note / Sign** (existing buttons): commit via the unchanged flow, then
  `DELETE` the draft and cancel the autosave timer.
- **Offline**: reuse `ConnectivitySyncService` to enqueue the draft `PUT` when
  offline; the in-memory form is the immediate fallback.

---

## 6. Error handling

- Autosave failures never block typing: show *"Couldn't save draft — retrying"* and
  retry on the next debounce/heartbeat.
- **Conflict**: last-write-wins by `updated_at` (a single author editing the same
  draft on two devices at once is rare; the latest `PUT` wins).
- **Stale draft after finalize**: on open, if a committed note **and** a draft both
  exist for the context, the client prefers the committed note and discards the
  draft (v1). The post-finalize delete + the janitor make this rare.
- The finalize path is authoritative and unchanged; a failed post-commit
  draft-delete is logged best-effort, never fatal.

---

## 7. Testing

- **Backend deep test** (`note-drafts.deep.test.js`, real PG):
  - upsert creates exactly one row; a second upsert for the same context **updates**
    (no duplicate);
  - `GET` returns only the author's draft — a different `author_uid` (and a
    different `tenant_id`, under RLS) cannot read it;
  - `DELETE` removes it;
  - **the draft path writes ZERO `clinical_timeline_events` and ZERO
    `clinical_audit_events` rows** (count before/after) — the load-bearing assertion;
  - `createNote` deletes the matching draft.
- **Flutter widget test** (`apps/staff/test/...`): typing triggers a debounced
  `PUT` against a mocked api; restore-on-open populates the controllers;
  Save/Sign clears the draft.
- **Gates**: `npm run lint` + `lint:raw-params` (if raw SQL); schema drift
  (`prisma db pull` + `check:schema-drift`); `melos run analyze` + `melos run test`
  for the Flutter side.

---

## 8. Scope (v1) & defaults

- **v1** = the *compose* phase of a **new** note in **OP Doctor Workspace +
  nursing notes**.
- **Not v1**: autosaving edits to an already-committed note; the read-only
  `clinical_notes_screen`; the admin portal (no notes entry).
- **Defaults**: debounce **3 s**, heartbeat **15 s**, draft expiry **14 days**,
  last-write-wins.
