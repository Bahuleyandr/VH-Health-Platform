-- Durable canonical-effect receipts for the live HL7 ADT/ORM and FHIR
-- AllergyIntolerance ingress paths.

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE TABLE public.hl7_inbound_clinical_receipts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  sender_identity VARCHAR(255) NOT NULL,
  message_control_id VARCHAR(199) NOT NULL,
  message_type VARCHAR(20) NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  patient_uid UUID NOT NULL,
  detail_table VARCHAR(40) NOT NULL,
  detail_id INTEGER NOT NULL,
  timeline_event_id UUID NOT NULL,
  audit_event_id UUID NOT NULL,
  acknowledgement_code CHAR(2) NOT NULL DEFAULT 'AA',
  acknowledgement_text VARCHAR(255) NOT NULL DEFAULT 'Message accepted',
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT ux_hl7_inbound_clinical_receipt_identity
    UNIQUE (tenant_id, sender_identity, message_control_id),
  CONSTRAINT ux_hl7_inbound_clinical_receipt_timeline
    UNIQUE (tenant_id, timeline_event_id),
  CONSTRAINT ux_hl7_inbound_clinical_receipt_audit
    UNIQUE (tenant_id, audit_event_id),
  CONSTRAINT fk_hl7_inbound_clinical_receipt_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_hl7_inbound_clinical_receipt_patient
    FOREIGN KEY (tenant_id, patient_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_hl7_inbound_clinical_receipt_timeline
    FOREIGN KEY (tenant_id, timeline_event_id)
    REFERENCES public.clinical_timeline_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_hl7_inbound_clinical_receipt_audit
    FOREIGN KEY (tenant_id, audit_event_id)
    REFERENCES public.clinical_audit_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_hl7_inbound_clinical_receipt_identity
    CHECK (
      NULLIF(BTRIM(sender_identity), '') IS NOT NULL
      AND sender_identity = BTRIM(sender_identity)
      AND NULLIF(BTRIM(message_control_id), '') IS NOT NULL
      AND message_control_id = BTRIM(message_control_id)
      AND payload_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT chk_hl7_inbound_clinical_receipt_shape
    CHECK (
      (message_type IN ('ADT^A01', 'ADT^A02', 'ADT^A03') AND detail_table = 'admissions')
      OR (message_type = 'ORM^O01' AND detail_table = 'investigations')
    ),
  CONSTRAINT chk_hl7_inbound_clinical_receipt_ack
    CHECK (acknowledgement_code = 'AA')
);

CREATE INDEX idx_hl7_inbound_clinical_receipts_patient
  ON public.hl7_inbound_clinical_receipts
    (tenant_id, patient_uid, recorded_at DESC);

CREATE UNIQUE INDEX ux_patient_allergies_tenant_id_for_fhir_receipt
  ON public.patient_allergies (tenant_id, id);

CREATE TABLE public.fhir_allergy_intolerance_receipts (
  tenant_id UUID NOT NULL,
  resource_fingerprint CHAR(64) NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  patient_uid UUID NOT NULL,
  allergy_id INTEGER NOT NULL,
  timeline_event_id UUID NOT NULL,
  audit_event_id UUID NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT fhir_allergy_intolerance_receipts_pkey
    PRIMARY KEY (tenant_id, resource_fingerprint),
  CONSTRAINT ux_fhir_allergy_intolerance_receipt_allergy
    UNIQUE (tenant_id, allergy_id),
  CONSTRAINT ux_fhir_allergy_intolerance_receipt_timeline
    UNIQUE (tenant_id, timeline_event_id),
  CONSTRAINT ux_fhir_allergy_intolerance_receipt_audit
    UNIQUE (tenant_id, audit_event_id),
  CONSTRAINT fk_fhir_allergy_intolerance_receipt_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_fhir_allergy_intolerance_receipt_patient
    FOREIGN KEY (tenant_id, patient_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_fhir_allergy_intolerance_receipt_allergy
    FOREIGN KEY (tenant_id, allergy_id)
    REFERENCES public.patient_allergies(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_fhir_allergy_intolerance_receipt_timeline
    FOREIGN KEY (tenant_id, timeline_event_id)
    REFERENCES public.clinical_timeline_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_fhir_allergy_intolerance_receipt_audit
    FOREIGN KEY (tenant_id, audit_event_id)
    REFERENCES public.clinical_audit_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_fhir_allergy_intolerance_receipt_fingerprint
    CHECK (
      resource_fingerprint ~ '^[0-9a-f]{64}$'
      AND payload_sha256 ~ '^[0-9a-f]{64}$'
    )
);

CREATE INDEX idx_fhir_allergy_intolerance_receipts_patient
  ON public.fhir_allergy_intolerance_receipts
    (tenant_id, patient_uid, recorded_at DESC);

CREATE TRIGGER hl7_inbound_clinical_receipt_append_only
BEFORE UPDATE OR DELETE ON public.hl7_inbound_clinical_receipts
FOR EACH ROW EXECUTE FUNCTION public.audit_append_only_guard();

CREATE TRIGGER fhir_allergy_intolerance_receipt_append_only
BEFORE UPDATE OR DELETE ON public.fhir_allergy_intolerance_receipts
FOR EACH ROW EXECUTE FUNCTION public.audit_append_only_guard();

DO $rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'hl7_inbound_clinical_receipts',
    'fhir_allergy_intolerance_receipts'
  ]
  LOOP
    EXECUTE FORMAT('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE FORMAT('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE FORMAT('DROP POLICY IF EXISTS tenant_isolation ON public.%I', table_name);
    EXECUTE FORMAT($policy$
      CREATE POLICY tenant_isolation
        ON public.%I
        AS PERMISSIVE
        USING (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = public.app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = public.app_current_tenant_id_uuid()
        )
    $policy$, table_name);
    EXECUTE FORMAT(
      'DROP POLICY IF EXISTS canonical_interop_explicit_context ON public.%I',
      table_name
    );
    EXECUTE FORMAT($policy$
      CREATE POLICY canonical_interop_explicit_context
        ON public.%I
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
        )
    $policy$, table_name);
  END LOOP;
END
$rls$;

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
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.hl7_inbound_clinical_receipts FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT ON public.hl7_inbound_clinical_receipts TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT USAGE, SELECT ON SEQUENCE public.hl7_inbound_clinical_receipts_id_seq TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.fhir_allergy_intolerance_receipts FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT ON public.fhir_allergy_intolerance_receipts TO %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;

COMMENT ON TABLE public.hl7_inbound_clinical_receipts IS
  'Append-only outcome receipts binding one authenticated live HL7 sender/MSH-10 identity to one detail mutation and canonical timeline/audit pair.';

COMMENT ON TABLE public.fhir_allergy_intolerance_receipts IS
  'Append-only semantic idempotency receipts binding one FHIR AllergyIntolerance create to the canonical patient_allergies row and timeline/audit pair.';
