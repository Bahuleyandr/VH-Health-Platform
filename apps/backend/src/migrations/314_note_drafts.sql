-- Migration 314: note_drafts — server-side autosave store for in-progress
-- clinical notes (OP/IP). A draft is the composing clinician's private,
-- recoverable scratchpad. It deliberately carries NO coupling to the canonical
-- clinical timeline or audit log: autosave upserts here and emits zero
-- clinical_timeline_events / clinical_audit_events rows. The real note (and its
-- canonical events) is only written on the existing finalize path
-- (POST/PUT /emr/notes + sign), which also clears the matching draft.
--
-- Design: docs/superpowers/specs/2026-06-17-clinical-notes-autosave-design.md

CREATE TABLE IF NOT EXISTS note_drafts (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  author_uid      UUID NOT NULL,
  patient_uid     UUID NOT NULL,
  appointment_id  INTEGER,
  note_type       VARCHAR(60) NOT NULL,
  content         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      TIMESTAMPTZ(6) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '14 days')
);

-- Exactly one live draft per (clinician, patient, encounter, note type) — the
-- upsert target. COALESCE(appointment_id, 0) folds the NULL (IP/nursing) case.
CREATE UNIQUE INDEX IF NOT EXISTS uq_note_drafts_context
  ON note_drafts (tenant_id, author_uid, patient_uid, COALESCE(appointment_id, 0), note_type);
CREATE INDEX IF NOT EXISTS idx_note_drafts_author
  ON note_drafts (tenant_id, author_uid, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_note_drafts_expiry
  ON note_drafts (expires_at);

-- RLS: note_drafts holds in-progress PHI (note content), so it joins the
-- tenant-isolation set (mirrors migration 075/304/311 pattern + the GUC-reading
-- default from migration 310).
ALTER TABLE note_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_drafts FORCE ROW LEVEL SECURITY;

ALTER TABLE note_drafts
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

DROP POLICY IF EXISTS tenant_isolation ON note_drafts;
CREATE POLICY tenant_isolation ON note_drafts
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
  );
