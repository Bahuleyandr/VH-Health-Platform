-- 281_lab_closed_loop.sql
--
-- Roadmap Pillar B / item B3 (docs/EPIC_LEVEL_ROADMAP.md) — closed-loop lab
-- foundations. Specimens (260) + ORU ingestion + the autoverification
-- rule helpers already exist; what was missing for the closed loop:
--
--   * Specimen BARCODE as a first-class scannable identity (label printed
--     at collection, scanned on receipt in the lab). accession_number was
--     never surfaced as a label.
--   * An analyzer interface INBOX (lab_interface_messages): every raw
--     ASTM E1394 / HL7v2 payload an analyzer sends is persisted with its
--     parse/ingest outcome, so interface failures are visible and
--     replayable instead of vanishing into logs. This is the substrate the
--     per-analyzer drivers (owner-side: depends on which analyzers the
--     pilot hospital owns) write into.
--
-- Physical analyzer hookup (serial/TCP listeners on the LAN) is an
-- owner-side deployment task; the HTTP bridge endpoint accepts the same
-- payloads for middleware-based analyzers and for tests.

BEGIN;

ALTER TABLE lab_specimens
  ADD COLUMN IF NOT EXISTS barcode VARCHAR(64),
  ADD COLUMN IF NOT EXISTS label_printed_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS label_printed_by UUID;

UPDATE lab_specimens SET barcode = accession_number WHERE barcode IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_specimens_barcode
  ON lab_specimens (tenant_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS lab_interface_messages (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  analyzer_id   INTEGER REFERENCES lab_analyzers(id) ON DELETE SET NULL,
  analyzer_code VARCHAR(120),
  direction     VARCHAR(10) NOT NULL DEFAULT 'inbound',
  protocol      VARCHAR(20) NOT NULL,
  message_type  VARCHAR(40),
  raw_message   TEXT NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'received',
  error         TEXT,
  result_count  INTEGER,
  specimen_id   INTEGER REFERENCES lab_specimens(id) ON DELETE SET NULL,
  verdicts      JSONB,
  processed_at  TIMESTAMPTZ(6),
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_lab_interface_messages_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_lab_interface_messages_direction CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT chk_lab_interface_messages_protocol
    CHECK (protocol IN ('hl7v2', 'astm_e1394', 'poct1a', 'other')),
  CONSTRAINT chk_lab_interface_messages_status
    CHECK (status IN ('received', 'parsed', 'ingested', 'failed', 'sent'))
);

CREATE INDEX IF NOT EXISTS idx_lab_interface_messages_status
  ON lab_interface_messages (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lab_interface_messages_analyzer
  ON lab_interface_messages (analyzer_id, created_at DESC) WHERE analyzer_id IS NOT NULL;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE lab_interface_messages ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE lab_interface_messages FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON lab_interface_messages';
  EXECUTE $f$
    CREATE POLICY tenant_isolation ON lab_interface_messages
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
  'LAB_CLOSED_LOOP_APPLIED',
  'lab_interface_messages',
  'lab_interface_messages',
  jsonb_build_object(
    'migration', '281_lab_closed_loop.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#B3',
    'reason', 'Specimen barcode labels + scan-on-receipt + analyzer interface inbox (ASTM E1394 / HL7v2) with replayable parse/ingest outcomes and delta-check verdicts.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'LAB_CLOSED_LOOP_APPLIED'
    AND resource = 'lab_interface_messages'
);

COMMIT;
