-- 282_audit_hash_chain_esign.sql
--
-- Roadmap Pillar C / item C4 (docs/EPIC_LEVEL_ROADMAP.md) — document
-- integrity: a tamper-evident hash chain on clinical_audit_events and
-- first-class e-signature records for clinical documents.
--
-- Hash chain design:
--   * Every clinical_audit_events INSERT gets chain_seq (global sequence),
--     prev_hash (last chain_hash for the SAME tenant) and chain_hash =
--     sha256(canonical string of the row + prev_hash). Computed by a
--     BEFORE INSERT trigger so every write path (canonical service, raw
--     SQL, future code) is covered — application code cannot forget it.
--   * Per-tenant chains; a transaction-scoped advisory lock serialises
--     concurrent inserts within a tenant so the chain never forks.
--   * The hash expression lives in ONE SQL function
--     (audit_chain_hash(...)), used by both the trigger and the
--     verification pass — no JS/SQL drift.
--   * Existing rows are backfilled in (occurred_at, created_at, id) order
--     per tenant so history is covered from day one.
--
-- E-signatures:
--   * clinical_document_signatures stores who signed what (document table +
--     id + content sha256) with method 'electronic_attestation' today and
--     'aadhaar_esign' / 'dsc' ready for the India eSign stack (gateway
--     creds are owner-side). Verification recomputes the document hash —
--     any post-signature edit is detectable.

BEGIN;

-- ── Hash chain columns ─────────────────────────────────────────────────────

ALTER TABLE clinical_audit_events
  ADD COLUMN IF NOT EXISTS chain_seq BIGINT,
  ADD COLUMN IF NOT EXISTS prev_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS chain_hash CHAR(64);

CREATE SEQUENCE IF NOT EXISTS clinical_audit_chain_seq;

CREATE INDEX IF NOT EXISTS idx_clinical_audit_events_chain
  ON clinical_audit_events (tenant_id, chain_seq);

-- Single source of truth for the chain hash. sha256() is core Postgres
-- (>= 11). jsonb::text is key-normalised, so the canonical string is
-- deterministic.
CREATE OR REPLACE FUNCTION audit_chain_hash(
  p_prev_hash   TEXT,
  p_id          UUID,
  p_tenant_id   UUID,
  p_action      TEXT,
  p_resource_table TEXT,
  p_resource_id TEXT,
  p_actor_uid   UUID,
  p_occurred_at TIMESTAMPTZ,
  p_before      JSONB,
  p_after       JSONB
) RETURNS CHAR(64)
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    COALESCE(p_prev_hash, 'genesis')
      || '|' || p_id::text
      || '|' || p_tenant_id::text
      || '|' || COALESCE(p_action, '')
      || '|' || COALESCE(p_resource_table, '')
      || '|' || COALESCE(p_resource_id, '')
      || '|' || COALESCE(p_actor_uid::text, '')
      || '|' || COALESCE(to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '')
      || '|' || COALESCE(p_before::text, '')
      || '|' || COALESCE(p_after::text, ''),
    'UTF8')), 'hex');
$$;

CREATE OR REPLACE FUNCTION clinical_audit_events_chain_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_prev CHAR(64);
BEGIN
  -- Serialise per tenant for the duration of the transaction so two
  -- concurrent inserts cannot both read the same head.
  PERFORM pg_advisory_xact_lock(hashtext('audit_chain:' || NEW.tenant_id::text));
  SELECT chain_hash INTO v_prev
    FROM clinical_audit_events
   WHERE tenant_id = NEW.tenant_id AND chain_seq IS NOT NULL
   ORDER BY chain_seq DESC
   LIMIT 1;
  NEW.chain_seq := nextval('clinical_audit_chain_seq');
  NEW.prev_hash := v_prev;
  NEW.chain_hash := audit_chain_hash(
    v_prev, NEW.id, NEW.tenant_id, NEW.action, NEW.resource_table,
    NEW.resource_id, NEW.actor_uid, NEW.occurred_at, NEW.before_state, NEW.after_state
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clinical_audit_events_chain ON clinical_audit_events;
CREATE TRIGGER trg_clinical_audit_events_chain
  BEFORE INSERT ON clinical_audit_events
  FOR EACH ROW EXECUTE FUNCTION clinical_audit_events_chain_trigger();

-- ── Backfill existing rows per tenant in deterministic order ──────────────
DO $$
DECLARE
  r RECORD;
  v_prev CHAR(64);
  v_tenant UUID := NULL;
  v_count BIGINT := 0;
BEGIN
  FOR r IN
    SELECT id, tenant_id, action, resource_table, resource_id, actor_uid,
           occurred_at, before_state, after_state
      FROM clinical_audit_events
     WHERE chain_seq IS NULL
     ORDER BY tenant_id, occurred_at, created_at, id
  LOOP
    IF v_tenant IS DISTINCT FROM r.tenant_id THEN
      v_tenant := r.tenant_id;
      -- Continue an existing chain if some rows were already chained.
      SELECT chain_hash INTO v_prev
        FROM clinical_audit_events
       WHERE tenant_id = v_tenant AND chain_seq IS NOT NULL
       ORDER BY chain_seq DESC LIMIT 1;
    END IF;
    UPDATE clinical_audit_events SET
      chain_seq = nextval('clinical_audit_chain_seq'),
      prev_hash = v_prev,
      chain_hash = audit_chain_hash(
        v_prev, r.id, r.tenant_id, r.action, r.resource_table, r.resource_id,
        r.actor_uid, r.occurred_at, r.before_state, r.after_state
      )
    WHERE id = r.id
    RETURNING chain_hash INTO v_prev;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'migration 282: chained % existing clinical_audit_events row(s)', v_count;
END
$$;

-- ── E-signature records ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clinical_document_signatures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  patient_uid     UUID,
  document_type   VARCHAR(60) NOT NULL,
  document_table  VARCHAR(100) NOT NULL,
  document_id     VARCHAR(120) NOT NULL,
  content_hash    CHAR(64) NOT NULL,
  signer_uid      UUID NOT NULL,
  signer_role     VARCHAR(80),
  signer_name     VARCHAR(200),
  signature_method VARCHAR(30) NOT NULL DEFAULT 'electronic_attestation',
  signature_statement TEXT,
  esign_txn_ref   VARCHAR(160),
  certificate_ref VARCHAR(200),
  audit_event_id  UUID,
  signed_at       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_clinical_document_signatures_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_clinical_document_signatures_method
    CHECK (signature_method IN ('electronic_attestation', 'aadhaar_esign', 'dsc'))
);

CREATE INDEX IF NOT EXISTS idx_clinical_document_signatures_document
  ON clinical_document_signatures (document_table, document_id, signed_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_document_signatures_patient
  ON clinical_document_signatures (tenant_id, patient_uid, signed_at DESC);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE clinical_document_signatures ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE clinical_document_signatures FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON clinical_document_signatures';
  EXECUTE $f$
    CREATE POLICY tenant_isolation ON clinical_document_signatures
      USING (
        current_setting('app.current_tenant_id', true) IS NULL
        OR current_setting('app.current_tenant_id', true) = ''
        OR current_setting('app.current_tenant_id', true) = 'bypass'
        OR tenant_id = app_current_tenant_id_uuid()
      )
      WITH CHECK (
        current_setting('app.current_tenant_id', true) IS NULL
        OR current_setting('app.current_tenant_id', true) = ''
        OR current_setting('app.current_tenant_id', true) = 'bypass'
        OR tenant_id = app_current_tenant_id_uuid()
      )
  $f$;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'AUDIT_HASH_CHAIN_ESIGN_APPLIED',
  'clinical_audit_events',
  'clinical_audit_events',
  jsonb_build_object(
    'migration', '282_audit_hash_chain_esign.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#C4',
    'reason', 'Tamper-evident per-tenant hash chain (trigger-computed) on clinical_audit_events + clinical_document_signatures with content hashing; Aadhaar eSign/DSC methods schema-ready (gateway owner-side).'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'AUDIT_HASH_CHAIN_ESIGN_APPLIED'
    AND resource = 'clinical_audit_events'
);

COMMIT;
