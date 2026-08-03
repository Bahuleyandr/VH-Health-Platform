-- C6.1-E / I06 study-link recovery.
-- Late PACS/DICOM study-link facts become append-only pending review only.
-- Worklist and metadata reads remain synchronous and cursor-free.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE TABLE public.imaging_study_link_recovery_receipts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  radiology_order_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  study_instance_uid VARCHAR(200) NOT NULL,
  accession_number VARCHAR(120) NOT NULL,
  source_system VARCHAR(120) NOT NULL,
  observed_at TIMESTAMPTZ(6) NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  payload_bytes INTEGER NOT NULL,
  source_partition VARCHAR(160) NOT NULL,
  source_position BIGINT NOT NULL,
  source_token VARCHAR(255) NOT NULL,
  predecessor_token VARCHAR(255) NOT NULL,
  duplicate_key VARCHAR(255) NOT NULL,
  recovery_inbox_id UUID NOT NULL,
  recovery_interface_family VARCHAR(8) NOT NULL DEFAULT 'I06',
  owner_actor_uid UUID NOT NULL,
  owner_reason VARCHAR(500) NOT NULL,
  receipt_status VARCHAR(40) NOT NULL DEFAULT 'pending_imaging_review',
  arrival_class VARCHAR(40) NOT NULL DEFAULT 'recovery_backlog',
  effect_disposition VARCHAR(40) NOT NULL DEFAULT 'late_pending_only',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_imaging_study_link_receipts_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_imaging_study_link_receipts_inbox
    UNIQUE (tenant_id, recovery_inbox_id, recovery_interface_family),
  CONSTRAINT ux_imaging_study_link_receipts_identity
    UNIQUE (tenant_id, radiology_order_id, study_instance_uid, payload_sha256),
  CONSTRAINT fk_imaging_study_link_receipts_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants (id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_imaging_study_link_receipts_owner
    FOREIGN KEY (tenant_id, owner_actor_uid)
    REFERENCES public.users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_imaging_study_link_receipts_order
    FOREIGN KEY (tenant_id, radiology_order_id, patient_uid)
    REFERENCES public.radiology_orders (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_imaging_study_link_receipts_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox (tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_imaging_study_link_receipts_uid
    CHECK (study_instance_uid ~ '^[0-9]+(\.[0-9]+)+$'),
  CONSTRAINT chk_imaging_study_link_receipts_payload_sha
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_imaging_study_link_receipts_payload_bytes
    CHECK (payload_bytes > 0),
  CONSTRAINT chk_imaging_study_link_receipts_source_position
    CHECK (source_position >= 0),
  CONSTRAINT chk_imaging_study_link_receipts_shape
    CHECK (
      recovery_interface_family = 'I06'
      AND receipt_status = 'pending_imaging_review'
      AND arrival_class = 'recovery_backlog'
      AND effect_disposition = 'late_pending_only'
      AND length(btrim(accession_number)) > 0
      AND length(btrim(source_system)) > 0
      AND length(btrim(source_partition)) > 0
      AND length(btrim(source_token)) > 0
      AND length(btrim(predecessor_token)) > 0
      AND length(btrim(duplicate_key)) > 0
      AND length(btrim(owner_reason)) > 0
    )
);

CREATE INDEX idx_imaging_study_link_receipts_pending
  ON public.imaging_study_link_recovery_receipts
    (tenant_id, receipt_status, observed_at, id);

CREATE OR REPLACE FUNCTION public.validate_imaging_study_link_recovery_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  inbox RECORD;
  expected_partition TEXT;
  expected_duplicate TEXT;
BEGIN
  SELECT item.interface_family, item.direction, item.source_partition,
         item.source_position, item.source_token, item.predecessor_token,
         item.duplicate_key, item.arrival_class, item.effect_disposition,
         item.status
    INTO inbox
    FROM public.pathway_projector_inbox AS item
   WHERE item.tenant_id = NEW.tenant_id
     AND item.inbox_id = NEW.recovery_inbox_id;

  expected_partition := 'radiology-order:' || NEW.radiology_order_id::TEXT || ':study-link';
  expected_duplicate := 'i06:study-link:' || NEW.radiology_order_id::TEXT || ':'
    || NEW.study_instance_uid || ':' || NEW.payload_sha256;

  IF inbox IS NULL
     OR inbox.interface_family <> 'I06'
     OR inbox.direction <> 'inbound'
     OR inbox.arrival_class <> 'recovery_backlog'
     OR inbox.effect_disposition <> 'late_pending_only'
     OR inbox.status <> 'pending'
     OR NEW.source_partition <> expected_partition
     OR inbox.source_partition <> NEW.source_partition
     OR inbox.source_position IS DISTINCT FROM NEW.source_position
     OR inbox.source_token IS DISTINCT FROM NEW.source_token
     OR inbox.predecessor_token IS DISTINCT FROM NEW.predecessor_token
     OR NEW.duplicate_key <> expected_duplicate
     OR inbox.duplicate_key <> NEW.duplicate_key THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_imaging_study_link_receipt_recovery_provenance',
      MESSAGE = 'I06 study-link receipt lacks exact pending inbox provenance';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER validate_imaging_study_link_recovery_receipt
BEFORE INSERT ON public.imaging_study_link_recovery_receipts
FOR EACH ROW EXECUTE FUNCTION public.validate_imaging_study_link_recovery_receipt();

CREATE OR REPLACE FUNCTION public.imaging_study_link_receipt_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'chk_imaging_study_link_receipt_append_only',
    MESSAGE = 'I06 study-link recovery receipts are append-only';
END
$$;

CREATE TRIGGER imaging_study_link_receipt_append_only
BEFORE UPDATE OR DELETE ON public.imaging_study_link_recovery_receipts
FOR EACH ROW EXECUTE FUNCTION public.imaging_study_link_receipt_append_only();

ALTER TABLE public.imaging_study_link_recovery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imaging_study_link_recovery_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.imaging_study_link_recovery_receipts
  AS PERMISSIVE
  USING (tenant_id = public.app_current_tenant_id_uuid())
  WITH CHECK (tenant_id = public.app_current_tenant_id_uuid());

CREATE POLICY imaging_study_link_receipts_explicit_context
  ON public.imaging_study_link_recovery_receipts
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  );

REVOKE ALL PRIVILEGES ON FUNCTION public.validate_imaging_study_link_recovery_receipt() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.imaging_study_link_receipt_append_only() FROM PUBLIC;

DO $runtime_privileges$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT ON public.imaging_study_link_recovery_receipts TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.imaging_study_link_recovery_receipts FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT USAGE, SELECT ON SEQUENCE public.imaging_study_link_recovery_receipts_id_seq TO %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;

COMMIT;
