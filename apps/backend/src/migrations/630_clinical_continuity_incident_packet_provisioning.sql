-- Migration 630: C5.2 incident-packet provisioning trust root.
--
-- This migration is additive and inert. It creates the first guarded runtime
-- INSERT path for incident packets, but the enclosing C-D14 route gate remains
-- compile-time false and no policy, contact sheet, key, or role is seeded.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE public.clinical_continuity_policy_versions
  DROP CONSTRAINT IF EXISTS cc_policy_action_registry_shape_check;

ALTER TABLE public.clinical_continuity_policy_versions
  ADD CONSTRAINT cc_policy_action_registry_shape_check
  CHECK (
    (
      policy_schema_version < 3
      AND action_registry_schema_version IS NULL
      AND action_registry_version IS NULL
      AND action_registry_checksum IS NULL
      AND NOT (policy_document ? 'actionRegistry')
    )
    OR
    (
      policy_schema_version IN (3, 4)
      AND action_registry_schema_version = 1
      AND action_registry_version > 0
      AND action_registry_checksum ~ '^[0-9a-f]{64}$'
      AND effective_until IS NOT NULL
      AND jsonb_typeof(policy_document -> 'actionRegistry') = 'object'
      AND jsonb_typeof(policy_document #> '{actionRegistry,actions}') = 'array'
      AND jsonb_array_length(policy_document #> '{actionRegistry,actions}') = 17
      AND jsonb_typeof(policy_document #> '{actionRegistry,compatibilityRules}') = 'array'
      AND policy_document #>> '{actionRegistry,registrySchemaVersion}'
            = action_registry_schema_version::text
      AND policy_document #>> '{actionRegistry,registryVersion}'
            = action_registry_version::text
      AND policy_document #>> '{actionRegistry,registryChecksum}' = BTRIM(action_registry_checksum)
      AND public.clinical_continuity_parse_timestamp(
            policy_document #>> '{actionRegistry,issuedAt}'
          ) = effective_from
      AND public.clinical_continuity_parse_timestamp(
            policy_document #>> '{actionRegistry,expiresAt}'
          ) = effective_until
      AND policy_document #>> '{actionRegistry,approvalEvidence,decisionId}' = 'C-D3'
      AND policy_document #>> '{actionRegistry,approvalEvidence,countersignedAt}' = '2026-07-30'
      AND policy_document #>> '{actionRegistry,approvalEvidence,source}'
            = 'docs/continuity/c0-4-owner-decision-dossier.md#c-d3--offline-action-matrix'
      AND (
        policy_schema_version = 3
        OR (
          jsonb_typeof(policy_document -> 'incidentPacketProvisioning') = 'object'
          AND policy_document #>> '{incidentPacketProvisioning,schemaVersion}' = '1'
          AND policy_document #>> '{incidentPacketProvisioning,purpose}'
                = 'vhhealth/continuity/incident-packet/v1'
          AND policy_document #>> '{incidentPacketProvisioning,issuerCapability}'
                = 'continuity_incident_packet_issue'
          AND policy_document #>> '{incidentPacketProvisioning,custodianCapability}'
                = 'continuity_incident_packet_custody'
          AND jsonb_typeof(policy_document #> '{incidentPacketProvisioning,issuerRoles}') = 'array'
          AND jsonb_array_length(policy_document #> '{incidentPacketProvisioning,issuerRoles}') > 0
          AND jsonb_typeof(policy_document #> '{incidentPacketProvisioning,custodianRoles}') = 'array'
          AND jsonb_array_length(policy_document #> '{incidentPacketProvisioning,custodianRoles}') > 0
          AND jsonb_typeof(policy_document #> '{incidentPacketProvisioning,contactSheetApproverRoles}') = 'array'
          AND jsonb_array_length(policy_document #> '{incidentPacketProvisioning,contactSheetApproverRoles}') > 0
          AND (policy_document #>> '{incidentPacketProvisioning,validityMinutes}')::integer > 0
          AND (policy_document #>> '{incidentPacketProvisioning,refreshLeadMinutes}')::integer > 0
          AND (policy_document #>> '{incidentPacketProvisioning,refreshLeadMinutes}')::integer
                < (policy_document #>> '{incidentPacketProvisioning,validityMinutes}')::integer
          AND (policy_document #>> '{incidentPacketProvisioning,clockUncertaintySeconds}')::integer >= 0
          AND (policy_document #>> '{incidentPacketProvisioning,paperRangeSize}')::integer > 0
          AND (policy_document #>> '{incidentPacketProvisioning,allowedCopyCount}')::integer > 0
          AND policy_document #>> '{incidentPacketProvisioning,signingPublicKeySha256}'
                ~ '^[0-9a-f]{64}$'
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION public.clinical_continuity_action_registry_guard_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_registry public.clinical_continuity_policy_versions%ROWTYPE;
BEGIN
  IF NEW.policy_schema_version < 3 THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.tenant_id::text || ':' || NEW.facility_id::text, 0)
  );
  SELECT policy.* INTO previous_registry
    FROM public.clinical_continuity_policy_versions AS policy
   WHERE policy.tenant_id = NEW.tenant_id
     AND policy.facility_id = NEW.facility_id
     AND policy.action_registry_version IS NOT NULL
   ORDER BY policy.action_registry_version DESC, policy.policy_version DESC,
            policy.created_at DESC, policy.id DESC
   LIMIT 1;
  IF FOUND THEN
    IF NEW.action_registry_version < previous_registry.action_registry_version THEN
      RAISE EXCEPTION 'clinical continuity action-registry version cannot roll back'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.action_registry_version = previous_registry.action_registry_version
       AND NEW.action_registry_checksum IS DISTINCT FROM previous_registry.action_registry_checksum THEN
      RAISE EXCEPTION 'clinical continuity action-registry checksum changed without a new version'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.action_registry_version > previous_registry.action_registry_version
       AND NEW.action_registry_checksum IS NOT DISTINCT FROM previous_registry.action_registry_checksum THEN
      RAISE EXCEPTION 'clinical continuity action-registry version changed without new content'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_continuity_action_registry_approval_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  approval_record public.approvals%ROWTYPE;
BEGIN
  IF NEW.policy_schema_version < 3 OR NEW.lifecycle_state = 'draft' THEN
    RETURN NEW;
  END IF;
  SELECT approval.* INTO approval_record
    FROM public.approvals AS approval
   WHERE approval.tenant_id = NEW.tenant_id AND approval.id = NEW.approval_id;
  IF NOT FOUND
     OR approval_record.metadata #>> ARRAY['clinical_continuity_policy_governance', 'action_registry_schema_version']
          IS DISTINCT FROM NEW.action_registry_schema_version::text
     OR approval_record.metadata #>> ARRAY['clinical_continuity_policy_governance', 'action_registry_version']
          IS DISTINCT FROM NEW.action_registry_version::text
     OR approval_record.metadata #>> ARRAY['clinical_continuity_policy_governance', 'action_registry_checksum']
          IS DISTINCT FROM BTRIM(NEW.action_registry_checksum)
     OR approval_record.metadata #>> ARRAY['clinical_continuity_policy_governance', 'action_registry_decision_id']
          IS DISTINCT FROM 'C-D3' THEN
    RAISE EXCEPTION 'clinical continuity action registry lacks exact approval evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE public.clinical_continuity_incident_contact_sheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  version BIGINT NOT NULL,
  content JSONB NOT NULL,
  content_hash CHAR(64) NOT NULL,
  effective_from TIMESTAMPTZ(6) NOT NULL,
  effective_until TIMESTAMPTZ(6) NOT NULL,
  policy_id UUID NOT NULL,
  policy_version BIGINT NOT NULL,
  created_by UUID NOT NULL,
  created_by_role VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_packet_contact_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id),
  CONSTRAINT fk_cc_packet_contact_facility FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id),
  CONSTRAINT fk_cc_packet_contact_creator FOREIGN KEY (tenant_id, created_by)
    REFERENCES public.users(tenant_id, uid),
  CONSTRAINT fk_cc_packet_contact_policy FOREIGN KEY (tenant_id, facility_id, policy_id)
    REFERENCES public.clinical_continuity_policy_versions(tenant_id, facility_id, id),
  CONSTRAINT uq_cc_packet_contact_scope UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT uq_cc_packet_contact_version UNIQUE (tenant_id, facility_id, version),
  CONSTRAINT chk_cc_packet_contact_version CHECK (version > 0),
  CONSTRAINT chk_cc_packet_contact_hash CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_cc_packet_contact_content CHECK (
    jsonb_typeof(content) = 'object'
    AND content #>> '{schemaVersion}' = '1'
    AND jsonb_typeof(content -> 'contacts') = 'array'
    AND jsonb_array_length(content -> 'contacts') > 0
    AND NULLIF(BTRIM(content ->> 'source'), '') IS NOT NULL
    AND NULLIF(BTRIM(content ->> 'custodyLocation'), '') IS NOT NULL
  ),
  CONSTRAINT chk_cc_packet_contact_window CHECK (
    effective_from < effective_until AND policy_version > 0
  )
);

CREATE TABLE public.clinical_continuity_incident_contact_sheet_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  contact_sheet_id UUID NOT NULL,
  contact_sheet_version BIGINT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  approved_by UUID NOT NULL,
  approved_by_role VARCHAR(80) NOT NULL,
  policy_id UUID NOT NULL,
  policy_version BIGINT NOT NULL,
  approved_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_packet_contact_approval_sheet
    FOREIGN KEY (tenant_id, facility_id, contact_sheet_id)
    REFERENCES public.clinical_continuity_incident_contact_sheets(tenant_id, facility_id, id),
  CONSTRAINT fk_cc_packet_contact_approval_actor FOREIGN KEY (tenant_id, approved_by)
    REFERENCES public.users(tenant_id, uid),
  CONSTRAINT fk_cc_packet_contact_approval_policy FOREIGN KEY (tenant_id, facility_id, policy_id)
    REFERENCES public.clinical_continuity_policy_versions(tenant_id, facility_id, id),
  CONSTRAINT uq_cc_packet_contact_approval UNIQUE (tenant_id, facility_id, contact_sheet_id),
  CONSTRAINT chk_cc_packet_contact_approval_hash CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_cc_packet_contact_approval_version CHECK (contact_sheet_version > 0 AND policy_version > 0)
);

CREATE TABLE public.clinical_continuity_incident_packet_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  request_id UUID NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  reserved_incident_id UUID NOT NULL,
  range_prefix VARCHAR(32) NOT NULL,
  range_first BIGINT NOT NULL,
  range_last BIGINT NOT NULL,
  policy_id UUID NOT NULL,
  policy_version BIGINT NOT NULL,
  contact_sheet_id UUID NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'allocated',
  issued_packet_id UUID,
  voided_at TIMESTAMPTZ(6),
  void_reason VARCHAR(160),
  created_by UUID NOT NULL,
  created_by_role VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_packet_allocation_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id),
  CONSTRAINT fk_cc_packet_allocation_facility FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id),
  CONSTRAINT fk_cc_packet_allocation_policy FOREIGN KEY (tenant_id, facility_id, policy_id)
    REFERENCES public.clinical_continuity_policy_versions(tenant_id, facility_id, id),
  CONSTRAINT fk_cc_packet_allocation_contact FOREIGN KEY (tenant_id, facility_id, contact_sheet_id)
    REFERENCES public.clinical_continuity_incident_contact_sheets(tenant_id, facility_id, id),
  CONSTRAINT fk_cc_packet_allocation_actor FOREIGN KEY (tenant_id, created_by)
    REFERENCES public.users(tenant_id, uid),
  CONSTRAINT uq_cc_packet_allocation_scope UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT uq_cc_packet_allocation_request UNIQUE (tenant_id, facility_id, request_id),
  CONSTRAINT uq_cc_packet_allocation_incident UNIQUE (tenant_id, facility_id, reserved_incident_id),
  CONSTRAINT uq_cc_packet_allocation_issued UNIQUE (tenant_id, facility_id, issued_packet_id),
  CONSTRAINT chk_cc_packet_allocation_hash CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_cc_packet_allocation_range CHECK (range_first > 0 AND range_last >= range_first),
  CONSTRAINT chk_cc_packet_allocation_state CHECK (state IN ('allocated', 'issued', 'void')),
  CONSTRAINT chk_cc_packet_allocation_terminal CHECK (
    (state = 'allocated' AND issued_packet_id IS NULL AND voided_at IS NULL AND void_reason IS NULL)
    OR (state = 'issued' AND issued_packet_id IS NOT NULL AND voided_at IS NULL AND void_reason IS NULL)
    OR (state = 'void' AND issued_packet_id IS NULL AND voided_at IS NOT NULL AND void_reason IS NOT NULL)
  ),
  CONSTRAINT ex_cc_packet_allocation_range EXCLUDE USING gist (
    tenant_id WITH =,
    facility_id WITH =,
    range_prefix WITH =,
    int8range(range_first, range_last, '[]') WITH &&
  )
);

ALTER TABLE public.clinical_continuity_incident_packets
  ADD COLUMN allocation_id UUID,
  ADD COLUMN packet_schema_version INTEGER,
  ADD COLUMN canonical_payload JSONB,
  ADD COLUMN canonical_payload_jcs TEXT,
  ADD COLUMN signing_public_key_spki_pem TEXT,
  ADD COLUMN signing_public_key_sha256 CHAR(64),
  ADD COLUMN policy_id UUID,
  ADD COLUMN policy_version BIGINT,
  ADD COLUMN policy_checksum CHAR(64),
  ADD COLUMN contact_sheet_id UUID,
  ADD COLUMN contact_sheet_checksum CHAR(64),
  ADD COLUMN issued_by UUID,
  ADD COLUMN issued_by_role VARCHAR(80),
  ADD COLUMN issued_at TIMESTAMPTZ(6),
  ADD COLUMN artifact_sha256 CHAR(64),
  ADD COLUMN allowed_copy_count INTEGER,
  ADD COLUMN clock_uncertainty_seconds INTEGER,
  ADD COLUMN request_id UUID,
  ADD COLUMN request_fingerprint CHAR(64),
  ADD COLUMN authorization_audit_id UUID,
  ADD COLUMN supersedes_packet_id UUID;

ALTER TABLE public.clinical_continuity_incident_packets
  ADD CONSTRAINT fk_cc_incident_packet_allocation FOREIGN KEY (tenant_id, facility_id, allocation_id)
    REFERENCES public.clinical_continuity_incident_packet_allocations(tenant_id, facility_id, id),
  ADD CONSTRAINT fk_cc_incident_packet_policy FOREIGN KEY (tenant_id, facility_id, policy_id)
    REFERENCES public.clinical_continuity_policy_versions(tenant_id, facility_id, id),
  ADD CONSTRAINT fk_cc_incident_packet_contact FOREIGN KEY (tenant_id, facility_id, contact_sheet_id)
    REFERENCES public.clinical_continuity_incident_contact_sheets(tenant_id, facility_id, id),
  ADD CONSTRAINT fk_cc_incident_packet_issuer FOREIGN KEY (tenant_id, issued_by)
    REFERENCES public.users(tenant_id, uid),
  ADD CONSTRAINT fk_cc_incident_packet_authorization_audit
    FOREIGN KEY (tenant_id, authorization_audit_id)
    REFERENCES public.clinical_audit_events(tenant_id, id),
  ADD CONSTRAINT fk_cc_incident_packet_supersedes FOREIGN KEY (tenant_id, facility_id, supersedes_packet_id)
    REFERENCES public.clinical_continuity_incident_packets(tenant_id, facility_id, id),
  ADD CONSTRAINT uq_cc_incident_packet_allocation UNIQUE (tenant_id, facility_id, allocation_id),
  ADD CONSTRAINT uq_cc_incident_packet_request UNIQUE (tenant_id, facility_id, request_id),
  ADD CONSTRAINT chk_cc_incident_packet_provisioned_shape CHECK (
    packet_schema_version IS NULL
    OR (
      packet_schema_version = 1
      AND allocation_id IS NOT NULL AND canonical_payload IS NOT NULL
      AND canonical_payload_jcs IS NOT NULL AND signing_public_key_spki_pem IS NOT NULL
      AND signing_public_key_sha256 ~ '^[0-9a-f]{64}$'
      AND policy_id IS NOT NULL AND policy_version > 0 AND policy_checksum ~ '^[0-9a-f]{64}$'
      AND contact_sheet_id IS NOT NULL AND contact_sheet_checksum ~ '^[0-9a-f]{64}$'
      AND issued_by IS NOT NULL AND issued_by_role IS NOT NULL AND issued_at IS NOT NULL
      AND artifact_sha256 ~ '^[0-9a-f]{64}$' AND allowed_copy_count > 0
      AND clock_uncertainty_seconds >= 0 AND request_id IS NOT NULL
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
      AND authorization_audit_id IS NOT NULL
    )
  );

ALTER TABLE public.clinical_continuity_incident_packet_allocations
  ADD CONSTRAINT fk_cc_packet_allocation_issued
  FOREIGN KEY (tenant_id, facility_id, issued_packet_id)
  REFERENCES public.clinical_continuity_incident_packets(tenant_id, facility_id, id);

CREATE TABLE public.clinical_continuity_incident_packet_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  packet_id UUID NOT NULL,
  media_type VARCHAR(80) NOT NULL,
  artifact_bytes BYTEA NOT NULL,
  artifact_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_packet_artifact_packet FOREIGN KEY (tenant_id, facility_id, packet_id)
    REFERENCES public.clinical_continuity_incident_packets(tenant_id, facility_id, id),
  CONSTRAINT uq_cc_packet_artifact UNIQUE (tenant_id, facility_id, packet_id),
  CONSTRAINT chk_cc_packet_artifact_hash CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_cc_packet_artifact_bytes CHECK (octet_length(artifact_bytes) > 0)
);

CREATE TABLE public.clinical_continuity_incident_packet_custody_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  packet_id UUID NOT NULL,
  event_type VARCHAR(24) NOT NULL,
  copy_number INTEGER NOT NULL,
  custodian_uid UUID NOT NULL,
  custodian_role VARCHAR(80) NOT NULL,
  evidence_hash CHAR(64) NOT NULL,
  notes VARCHAR(500),
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_packet_custody_packet FOREIGN KEY (tenant_id, facility_id, packet_id)
    REFERENCES public.clinical_continuity_incident_packets(tenant_id, facility_id, id),
  CONSTRAINT fk_cc_packet_custody_actor FOREIGN KEY (tenant_id, custodian_uid)
    REFERENCES public.users(tenant_id, uid),
  CONSTRAINT uq_cc_packet_custody_scope UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT chk_cc_packet_custody_type CHECK (
    event_type IN ('generated', 'downloaded', 'printed', 'handed_over', 'received', 'destroyed')
  ),
  CONSTRAINT chk_cc_packet_custody_copy CHECK (copy_number > 0),
  CONSTRAINT chk_cc_packet_custody_hash CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_cc_packet_custody_time CHECK (occurred_at <= recorded_at)
);

CREATE UNIQUE INDEX uq_cc_packet_custody_received
  ON public.clinical_continuity_incident_packet_custody_events
  (tenant_id, facility_id, packet_id, copy_number)
  WHERE event_type = 'received';

CREATE OR REPLACE FUNCTION public.assert_cc_packet_evidence_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_evidence_append_only',
    MESSAGE = 'incident-packet evidence is append-only';
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_cc_packet_allocation_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state <> 'allocated' OR NEW.state NOT IN ('issued', 'void')
     OR (to_jsonb(NEW) - ARRAY['state','issued_packet_id','voided_at','void_reason'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','issued_packet_id','voided_at','void_reason']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_allocation_immutable',
      MESSAGE = 'packet allocation permits one terminal transition only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cc_packet_contact_append_only BEFORE UPDATE OR DELETE
  ON public.clinical_continuity_incident_contact_sheets
  FOR EACH ROW EXECUTE FUNCTION public.assert_cc_packet_evidence_append_only();
CREATE TRIGGER cc_packet_contact_approval_append_only BEFORE UPDATE OR DELETE
  ON public.clinical_continuity_incident_contact_sheet_approvals
  FOR EACH ROW EXECUTE FUNCTION public.assert_cc_packet_evidence_append_only();
CREATE TRIGGER cc_packet_artifact_append_only BEFORE UPDATE OR DELETE
  ON public.clinical_continuity_incident_packet_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.assert_cc_packet_evidence_append_only();
CREATE TRIGGER cc_packet_custody_append_only BEFORE UPDATE OR DELETE
  ON public.clinical_continuity_incident_packet_custody_events
  FOR EACH ROW EXECUTE FUNCTION public.assert_cc_packet_evidence_append_only();
CREATE TRIGGER cc_packet_allocation_guard BEFORE UPDATE OR DELETE
  ON public.clinical_continuity_incident_packet_allocations
  FOR EACH ROW EXECUTE FUNCTION public.assert_cc_packet_allocation_mutation();

CREATE OR REPLACE FUNCTION public.cc_packet_assert_context(p_tenant_id UUID, p_facility_id INTEGER)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id
     OR current_setting('app.current_facility_id', true) !~ '^[1-9][0-9]*$'
     OR current_setting('app.current_facility_id', true)::integer IS DISTINCT FROM p_facility_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'explicit tenant and facility context required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.cc_packet_active_policy(
  p_tenant_id UUID, p_facility_id INTEGER
)
RETURNS public.clinical_continuity_policy_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE selected public.clinical_continuity_policy_versions%ROWTYPE;
BEGIN
  PERFORM public.cc_packet_assert_context(p_tenant_id, p_facility_id);
  SELECT policy.* INTO STRICT selected
    FROM public.clinical_continuity_policy_versions AS policy
   WHERE policy.tenant_id = p_tenant_id AND policy.facility_id = p_facility_id
     AND policy.lifecycle_state = 'active' AND policy.policy_schema_version = 4
     AND policy.effective_from <= clock_timestamp()
     AND policy.effective_until > clock_timestamp()
   FOR SHARE;
  RETURN selected;
EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_active_policy',
    MESSAGE = 'exactly one active policy-schema v4 packet authority is required';
END;
$$;

CREATE OR REPLACE FUNCTION public.cc_packet_assert_actor(
  p_tenant_id UUID, p_actor_uid UUID, p_actor_role TEXT
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users actor
     WHERE actor.tenant_id = p_tenant_id AND actor.uid = p_actor_uid
       AND actor.role = p_actor_role AND actor.is_active = TRUE
       AND actor.is_deleted = FALSE AND actor.status = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_authenticated_actor',
      MESSAGE = 'packet actor identity and role did not verify';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.cc_packet_assert_contact_content(p_content JSONB)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE contact JSONB;
DECLARE channel JSONB;
DECLARE contact_count INTEGER;
DECLARE distinct_order_count INTEGER;
DECLARE distinct_channel_count INTEGER;
BEGIN
  IF jsonb_typeof(p_content) <> 'object'
     OR NOT p_content ?& ARRAY['schemaVersion','source','custodyLocation','contacts','instructions']
     OR p_content - ARRAY['schemaVersion','source','custodyLocation','contacts','instructions'] <> '{}'::jsonb
     OR p_content #>> '{schemaVersion}' <> '1'
     OR jsonb_typeof(p_content -> 'contacts') <> 'array'
     OR jsonb_array_length(p_content -> 'contacts') NOT BETWEEN 1 AND 50
     OR length(btrim(p_content ->> 'source')) NOT BETWEEN 1 AND 240
     OR length(btrim(p_content ->> 'custodyLocation')) NOT BETWEEN 1 AND 240
     OR length(btrim(p_content ->> 'instructions')) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_contact_content',
      MESSAGE = 'contact-sheet content is not the closed phone-tree schema';
  END IF;
  SELECT count(*)::integer, count(DISTINCT entry ->> 'escalationOrder')::integer
    INTO contact_count, distinct_order_count
    FROM jsonb_array_elements(p_content -> 'contacts') AS item(entry);
  IF contact_count <> distinct_order_count THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_contact_content',
      MESSAGE = 'contact-sheet escalation order must be unique';
  END IF;
  FOR contact IN SELECT entry FROM jsonb_array_elements(p_content -> 'contacts') AS item(entry) LOOP
    IF jsonb_typeof(contact) <> 'object'
       OR NOT contact ?& ARRAY['role','label','escalationOrder','channels']
       OR contact - ARRAY['role','label','escalationOrder','channels'] <> '{}'::jsonb
       OR contact ->> 'role' !~ '^[A-Z][A-Z0-9_]{1,79}$'
       OR length(btrim(contact ->> 'label')) NOT BETWEEN 1 AND 120
       OR contact ->> 'escalationOrder' !~ '^[1-9][0-9]*$'
       OR jsonb_typeof(contact -> 'channels') <> 'array'
       OR jsonb_array_length(contact -> 'channels') NOT BETWEEN 2 AND 10 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_contact_content',
        MESSAGE = 'contact-sheet role entry is invalid';
    END IF;
    SELECT count(DISTINCT entry ->> 'kind')::integer INTO distinct_channel_count
      FROM jsonb_array_elements(contact -> 'channels') AS item(entry);
    IF distinct_channel_count < 2 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_contact_content',
        MESSAGE = 'contact-sheet role requires independent channels';
    END IF;
    FOR channel IN SELECT entry FROM jsonb_array_elements(contact -> 'channels') AS item(entry) LOOP
      IF jsonb_typeof(channel) <> 'object'
         OR NOT channel ?& ARRAY['kind','value']
         OR channel - ARRAY['kind','value'] <> '{}'::jsonb
         OR channel ->> 'kind' NOT IN ('phone','sms','messaging','radio')
         OR length(btrim(channel ->> 'value')) NOT BETWEEN 1 AND 160 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_contact_content',
          MESSAGE = 'contact-sheet channel is invalid';
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_continuity_create_incident_contact_sheet(
  p_tenant_id UUID, p_facility_id INTEGER, p_actor_uid UUID, p_actor_role TEXT,
  p_content JSONB
)
RETURNS public.clinical_continuity_incident_contact_sheets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE policy public.clinical_continuity_policy_versions%ROWTYPE;
DECLARE created public.clinical_continuity_incident_contact_sheets%ROWTYPE;
DECLARE next_version BIGINT;
BEGIN
  policy := public.cc_packet_active_policy(p_tenant_id, p_facility_id);
  PERFORM public.cc_packet_assert_actor(p_tenant_id, p_actor_uid, p_actor_role);
  PERFORM public.cc_packet_assert_contact_content(p_content);
  IF NOT (policy.policy_document #> '{incidentPacketProvisioning,issuerRoles}') ? p_actor_role THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_contact_authority',
      MESSAGE = 'contact-sheet authority or checksum is invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_facility_id::text || ':contacts', 0));
  SELECT COALESCE(MAX(version), 0) + 1 INTO next_version
    FROM public.clinical_continuity_incident_contact_sheets
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id;
  INSERT INTO public.clinical_continuity_incident_contact_sheets
    (tenant_id, facility_id, version, content, content_hash,
     effective_from, effective_until, policy_id, policy_version,
     created_by, created_by_role)
  VALUES (p_tenant_id, p_facility_id, next_version, p_content,
          encode(public.digest(convert_to(p_content::text, 'UTF8'), 'sha256'), 'hex'),
          GREATEST(clock_timestamp(), policy.effective_from), policy.effective_until,
          policy.id, policy.policy_version,
          p_actor_uid, p_actor_role)
  RETURNING * INTO created;
  RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_continuity_approve_incident_contact_sheet(
  p_tenant_id UUID, p_facility_id INTEGER, p_actor_uid UUID, p_actor_role TEXT, p_contact_sheet_id UUID
)
RETURNS public.clinical_continuity_incident_contact_sheet_approvals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE policy public.clinical_continuity_policy_versions%ROWTYPE;
DECLARE sheet public.clinical_continuity_incident_contact_sheets%ROWTYPE;
DECLARE approved public.clinical_continuity_incident_contact_sheet_approvals%ROWTYPE;
BEGIN
  policy := public.cc_packet_active_policy(p_tenant_id, p_facility_id);
  PERFORM public.cc_packet_assert_actor(p_tenant_id, p_actor_uid, p_actor_role);
  SELECT * INTO STRICT sheet FROM public.clinical_continuity_incident_contact_sheets
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id AND id = p_contact_sheet_id;
  IF sheet.created_by = p_actor_uid
     OR NOT (policy.policy_document #> '{incidentPacketProvisioning,contactSheetApproverRoles}') ? p_actor_role THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_contact_approval_separation',
      MESSAGE = 'contact-sheet approval requires an authorized distinct actor';
  END IF;
  INSERT INTO public.clinical_continuity_incident_contact_sheet_approvals
    (tenant_id, facility_id, contact_sheet_id, contact_sheet_version, content_hash,
     approved_by, approved_by_role, policy_id, policy_version)
  VALUES (p_tenant_id, p_facility_id, sheet.id, sheet.version, sheet.content_hash,
          p_actor_uid, p_actor_role, policy.id, policy.policy_version)
  RETURNING * INTO approved;
  RETURN approved;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_continuity_allocate_incident_packet(
  p_tenant_id UUID, p_facility_id INTEGER, p_actor_uid UUID, p_actor_role TEXT,
  p_request_id UUID, p_request_fingerprint TEXT, p_reserved_incident_id UUID,
  p_contact_sheet_id UUID
)
RETURNS public.clinical_continuity_incident_packet_allocations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE policy public.clinical_continuity_policy_versions%ROWTYPE;
DECLARE prior public.clinical_continuity_incident_packet_allocations%ROWTYPE;
DECLARE allocated public.clinical_continuity_incident_packet_allocations%ROWTYPE;
DECLARE allocated_prefix TEXT;
DECLARE range_size BIGINT;
DECLARE range_first BIGINT;
BEGIN
  policy := public.cc_packet_active_policy(p_tenant_id, p_facility_id);
  PERFORM public.cc_packet_assert_actor(p_tenant_id, p_actor_uid, p_actor_role);
  IF policy.policy_document #>> '{incidentPacketProvisioning,issuerCapability}'
       <> 'continuity_incident_packet_issue'
     OR NOT (policy.policy_document #> '{incidentPacketProvisioning,issuerRoles}') ? p_actor_role
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR NOT EXISTS (
       SELECT 1 FROM public.clinical_continuity_incident_contact_sheet_approvals approval
        WHERE approval.tenant_id = p_tenant_id AND approval.facility_id = p_facility_id
          AND approval.contact_sheet_id = p_contact_sheet_id
          AND approval.policy_id = policy.id AND approval.policy_version = policy.policy_version
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_allocation_authority',
      MESSAGE = 'packet allocation authority or evidence is invalid';
  END IF;
  SELECT * INTO prior FROM public.clinical_continuity_incident_packet_allocations
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id AND request_id = p_request_id;
  IF FOUND THEN
    IF prior.request_fingerprint <> p_request_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_request_conflict',
        MESSAGE = 'packet request identity was reused with different input';
    END IF;
    RETURN prior;
  END IF;
  allocated_prefix := policy.policy_document #>> '{incidentPacketProvisioning,paperRangePrefix}';
  range_size := (policy.policy_document #>> '{incidentPacketProvisioning,paperRangeSize}')::bigint;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_facility_id::text || ':' || allocated_prefix, 0));
  SELECT COALESCE(MAX(range_last), 0) + 1 INTO range_first
    FROM public.clinical_continuity_incident_packet_allocations
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id
     AND range_prefix = allocated_prefix;
  INSERT INTO public.clinical_continuity_incident_packet_allocations
    (tenant_id, facility_id, request_id, request_fingerprint, reserved_incident_id,
     range_prefix, range_first, range_last, policy_id, policy_version, contact_sheet_id,
     created_by, created_by_role)
  VALUES (p_tenant_id, p_facility_id, p_request_id, p_request_fingerprint, p_reserved_incident_id,
          allocated_prefix, range_first, range_first + range_size - 1, policy.id, policy.policy_version,
          p_contact_sheet_id, p_actor_uid, p_actor_role)
  RETURNING * INTO allocated;
  RETURN allocated;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_continuity_void_incident_packet_allocation(
  p_tenant_id UUID, p_facility_id INTEGER, p_allocation_id UUID,
  p_actor_uid UUID, p_actor_role TEXT, p_reason TEXT
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM public.cc_packet_assert_context(p_tenant_id, p_facility_id);
  PERFORM public.cc_packet_assert_actor(p_tenant_id, p_actor_uid, p_actor_role);
  UPDATE public.clinical_continuity_incident_packet_allocations
     SET state = 'void', voided_at = clock_timestamp(), void_reason = left(p_reason, 160)
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id
     AND id = p_allocation_id AND state = 'allocated'
     AND created_by = p_actor_uid AND created_by_role = p_actor_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_continuity_issue_incident_packet(
  p_tenant_id UUID, p_facility_id INTEGER, p_actor_uid UUID, p_actor_role TEXT,
  p_packet JSONB
)
RETURNS public.clinical_continuity_incident_packets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE policy public.clinical_continuity_policy_versions%ROWTYPE;
DECLARE allocation_record public.clinical_continuity_incident_packet_allocations%ROWTYPE;
DECLARE sheet public.clinical_continuity_incident_contact_sheets%ROWTYPE;
DECLARE key_record public.encryption_keys%ROWTYPE;
DECLARE authorization_record public.clinical_audit_events%ROWTYPE;
DECLARE issued public.clinical_continuity_incident_packets%ROWTYPE;
DECLARE artifact BYTEA;
DECLARE public_key TEXT;
DECLARE public_key_hash TEXT;
DECLARE facility_timezone TEXT;
DECLARE trusted_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  policy := public.cc_packet_active_policy(p_tenant_id, p_facility_id);
  PERFORM public.cc_packet_assert_actor(p_tenant_id, p_actor_uid, p_actor_role);
  IF policy.policy_document #>> '{incidentPacketProvisioning,issuerCapability}'
       <> 'continuity_incident_packet_issue'
     OR NOT (policy.policy_document #> '{incidentPacketProvisioning,issuerRoles}') ? p_actor_role THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_issue_authority',
      MESSAGE = 'packet issuance authority is invalid';
  END IF;
  IF COALESCE(p_packet ->> 'allocation_id', '')
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR COALESCE(p_packet ->> 'packet_id', '')
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR (
       NULLIF(p_packet ->> 'supersedes_packet_id', '') IS NOT NULL
       AND p_packet ->> 'supersedes_packet_id'
         !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_issue_evidence',
      MESSAGE = 'packet issuance evidence failed closed';
  END IF;
  SELECT * INTO allocation_record FROM public.clinical_continuity_incident_packet_allocations
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id
     AND id = (p_packet ->> 'allocation_id')::uuid FOR UPDATE;
  SELECT * INTO sheet FROM public.clinical_continuity_incident_contact_sheets
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id
     AND id = allocation_record.contact_sheet_id;
  SELECT * INTO key_record FROM public.encryption_keys
   WHERE tenant_id = p_tenant_id
     AND key_id = policy.policy_document #>> '{incidentPacketProvisioning,signingKeyId}';
  SELECT timezone INTO facility_timezone FROM public.facilities
   WHERE tenant_id = p_tenant_id AND id = p_facility_id;
  public_key := key_record.metadata ->> 'public_key_spki_pem';
  public_key_hash := encode(public.digest(convert_to(public_key, 'UTF8'), 'sha256'), 'hex');
  artifact := decode(p_packet ->> 'artifact_base64', 'base64');
  IF COALESCE(p_packet ->> 'authorization_audit_id', '')
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_issue_evidence',
      MESSAGE = 'packet issuance evidence failed closed';
  END IF;
  SELECT audit.* INTO authorization_record
    FROM public.clinical_audit_events AS audit
   WHERE audit.tenant_id = p_tenant_id
     AND audit.id = (p_packet ->> 'authorization_audit_id')::uuid;
  IF allocation_record.id IS NULL OR sheet.id IS NULL OR key_record.id IS NULL
     OR allocation_record.state <> 'allocated' OR allocation_record.policy_id <> policy.id
     OR allocation_record.policy_version <> policy.policy_version
     OR key_record.algorithm <> 'Ed25519' OR key_record.status <> 'active'
     OR key_record.metadata ->> 'purpose' <> 'clinical_continuity_incident_packet_signing'
     OR public_key_hash <> policy.policy_document #>> '{incidentPacketProvisioning,signingPublicKeySha256}'
     OR p_packet ->> 'request_fingerprint' <> allocation_record.request_fingerprint
     OR (p_packet ->> 'packet_id')::uuid IS NULL
     OR p_packet ->> 'canonical_payload_hash' !~ '^[0-9a-f]{64}$'
     OR encode(public.digest(convert_to(p_packet ->> 'canonical_payload_jcs', 'UTF8'), 'sha256'), 'hex')
          <> p_packet ->> 'canonical_payload_hash'
     OR (p_packet ->> 'canonical_payload_jcs')::jsonb <> p_packet -> 'canonical_payload'
     OR p_packet ->> 'signature' !~ '^[A-Za-z0-9+/]{86}==$'
     OR encode(public.digest(artifact, 'sha256'), 'hex') <> p_packet ->> 'artifact_sha256'
     OR authorization_record.id IS NULL
     OR authorization_record.action <> 'clinical_continuity.incident_packet.issue_authorized'
     OR authorization_record.action_status <> 'success'
     OR authorization_record.actor_uid <> p_actor_uid
     OR authorization_record.actor_role <> p_actor_role
     OR authorization_record.resource_table <> 'clinical_continuity_incident_packet_allocations'
     OR authorization_record.resource_id <> allocation_record.id::text
     OR authorization_record.request_id <> allocation_record.request_id::text
     OR authorization_record.after_state #>> '{packet_id}' <> p_packet ->> 'packet_id'
     OR authorization_record.after_state #>> '{canonical_payload_hash}'
          <> p_packet ->> 'canonical_payload_hash'
     OR authorization_record.after_state #>> '{signature_sha256}'
          <> encode(public.digest(convert_to(p_packet ->> 'signature', 'UTF8'), 'sha256'), 'hex')
     OR authorization_record.after_state #>> '{artifact_sha256}' <> p_packet ->> 'artifact_sha256'
     OR sheet.effective_from > trusted_now OR sheet.effective_until <= trusted_now
     OR NOT EXISTS (
       SELECT 1 FROM public.clinical_continuity_incident_contact_sheet_approvals approval
        WHERE approval.tenant_id = p_tenant_id AND approval.facility_id = p_facility_id
          AND approval.contact_sheet_id = sheet.id
          AND approval.contact_sheet_version = sheet.version
          AND approval.content_hash = sheet.content_hash
          AND approval.policy_id = policy.id AND approval.policy_version = policy.policy_version
     )
     OR (p_packet ->> 'valid_from')::timestamptz > trusted_now
     OR (p_packet ->> 'valid_until')::timestamptz <= trusted_now
     OR (p_packet ->> 'valid_until')::timestamptz
          <> (p_packet ->> 'valid_from')::timestamptz
             + make_interval(mins => (policy.policy_document #>> '{incidentPacketProvisioning,validityMinutes}')::integer)
     OR p_packet #>> '{canonical_payload,purpose}' <> 'vhhealth/continuity/incident-packet/v1'
     OR p_packet #>> '{canonical_payload,packetId}' <> p_packet ->> 'packet_id'
     OR p_packet #>> '{canonical_payload,tenantId}' <> p_tenant_id::text
     OR (p_packet #>> '{canonical_payload,facilityId}')::integer <> p_facility_id
     OR p_packet #>> '{canonical_payload,facilityTimezone}' <> facility_timezone
     OR p_packet #>> '{canonical_payload,reservedIncidentId}'
          <> allocation_record.reserved_incident_id::text
     OR p_packet #>> '{canonical_payload,range,prefix}' <> allocation_record.range_prefix
     OR (p_packet #>> '{canonical_payload,range,first}')::bigint <> allocation_record.range_first
     OR (p_packet #>> '{canonical_payload,range,last}')::bigint <> allocation_record.range_last
     OR p_packet #>> '{canonical_payload,policy,id}' <> policy.id::text
     OR (p_packet #>> '{canonical_payload,policy,version}')::bigint <> policy.policy_version
     OR p_packet #>> '{canonical_payload,policy,checksum}' <> BTRIM(policy.policy_checksum)
     OR p_packet #>> '{canonical_payload,key,id}' <> key_record.key_id
     OR p_packet #>> '{canonical_payload,key,version}' <> key_record.id::text
     OR p_packet #>> '{canonical_payload,key,publicKeySha256}' <> public_key_hash
     OR p_packet #>> '{canonical_payload,contactSheet,id}' <> sheet.id::text
     OR (p_packet #>> '{canonical_payload,contactSheet,version}')::bigint <> sheet.version
     OR p_packet #>> '{canonical_payload,contactSheet,checksum}' <> BTRIM(sheet.content_hash)
     OR (p_packet #>> '{canonical_payload,contactSheet,effectiveFrom}')::timestamptz
          <> sheet.effective_from
     OR (p_packet #>> '{canonical_payload,contactSheet,effectiveUntil}')::timestamptz
          <> sheet.effective_until
     OR (p_packet #>> '{canonical_payload,notValidBefore}')::timestamptz
          <> (p_packet ->> 'valid_from')::timestamptz
     OR p_packet #>> '{canonical_payload,notValidAfter}' <> p_packet ->> 'valid_until'
     OR (
       NULLIF(p_packet ->> 'supersedes_packet_id', '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.clinical_continuity_incident_packets prior
          WHERE prior.tenant_id = p_tenant_id AND prior.facility_id = p_facility_id
            AND prior.id = (p_packet ->> 'supersedes_packet_id')::uuid
            AND prior.status = 'unused' AND prior.revoked_at IS NULL
            AND trusted_now >= prior.valid_until
                - make_interval(mins => (policy.policy_document #>> '{incidentPacketProvisioning,refreshLeadMinutes}')::integer)
            AND trusted_now + make_interval(secs => prior.clock_uncertainty_seconds) < prior.valid_until
       )
     )
     OR (p_packet #>> '{canonical_payload,allowedCopyCount}')::integer
          <> (policy.policy_document #>> '{incidentPacketProvisioning,allowedCopyCount}')::integer THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_issue_evidence',
      MESSAGE = 'packet issuance evidence failed closed';
  END IF;
  INSERT INTO public.clinical_continuity_incident_packets (
    id, tenant_id, facility_id, reserved_incident_id, range_prefix, range_first, range_last,
    packet_key_id, packet_key_version, canonical_payload_hash, signature, status,
    valid_from, valid_until, contact_sheet_version, allocation_id, packet_schema_version,
    canonical_payload, canonical_payload_jcs, signing_public_key_spki_pem,
    signing_public_key_sha256, policy_id, policy_version, policy_checksum,
    contact_sheet_id, contact_sheet_checksum, issued_by, issued_by_role, issued_at,
    artifact_sha256, allowed_copy_count, clock_uncertainty_seconds, request_id,
    request_fingerprint, authorization_audit_id, supersedes_packet_id
  ) VALUES (
    (p_packet ->> 'packet_id')::uuid, p_tenant_id, p_facility_id,
    allocation_record.reserved_incident_id,
    allocation_record.range_prefix, allocation_record.range_first, allocation_record.range_last,
    key_record.key_id,
    key_record.id::text, p_packet ->> 'canonical_payload_hash', p_packet ->> 'signature', 'unused',
    (p_packet ->> 'valid_from')::timestamptz, (p_packet ->> 'valid_until')::timestamptz,
    sheet.version::text, allocation_record.id, 1, p_packet -> 'canonical_payload',
    p_packet ->> 'canonical_payload_jcs', public_key, public_key_hash, policy.id,
    policy.policy_version, BTRIM(policy.policy_checksum), sheet.id, BTRIM(sheet.content_hash),
    p_actor_uid, p_actor_role, trusted_now, p_packet ->> 'artifact_sha256',
    (policy.policy_document #>> '{incidentPacketProvisioning,allowedCopyCount}')::integer,
    (policy.policy_document #>> '{incidentPacketProvisioning,clockUncertaintySeconds}')::integer,
    allocation_record.request_id, allocation_record.request_fingerprint,
    authorization_record.id,
    NULLIF(p_packet ->> 'supersedes_packet_id', '')::uuid
  ) RETURNING * INTO issued;
  INSERT INTO public.clinical_continuity_incident_packet_artifacts
    (tenant_id, facility_id, packet_id, media_type, artifact_bytes, artifact_sha256)
  VALUES (p_tenant_id, p_facility_id, issued.id, 'text/plain; charset=utf-8', artifact, issued.artifact_sha256);
  INSERT INTO public.clinical_continuity_incident_packet_custody_events
    (tenant_id, facility_id, packet_id, event_type, copy_number, custodian_uid,
     custodian_role, evidence_hash, occurred_at)
  VALUES (p_tenant_id, p_facility_id, issued.id, 'generated', 1, p_actor_uid,
          p_actor_role, issued.artifact_sha256, trusted_now);
  UPDATE public.clinical_continuity_incident_packet_allocations
     SET state = 'issued', issued_packet_id = issued.id
   WHERE id = allocation_record.id;
  RETURN issued;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_continuity_record_incident_packet_custody(
  p_tenant_id UUID, p_facility_id INTEGER, p_packet_id UUID, p_actor_uid UUID,
  p_actor_role TEXT, p_event_type TEXT, p_copy_number INTEGER, p_evidence_hash TEXT,
  p_notes TEXT, p_occurred_at TIMESTAMPTZ
)
RETURNS public.clinical_continuity_incident_packet_custody_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE policy public.clinical_continuity_policy_versions%ROWTYPE;
DECLARE packet public.clinical_continuity_incident_packets%ROWTYPE;
DECLARE event public.clinical_continuity_incident_packet_custody_events%ROWTYPE;
BEGIN
  policy := public.cc_packet_active_policy(p_tenant_id, p_facility_id);
  PERFORM public.cc_packet_assert_actor(p_tenant_id, p_actor_uid, p_actor_role);
  SELECT * INTO STRICT packet FROM public.clinical_continuity_incident_packets
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id AND id = p_packet_id FOR UPDATE;
  IF policy.policy_document #>> '{incidentPacketProvisioning,custodianCapability}'
       <> 'continuity_incident_packet_custody'
     OR NOT (policy.policy_document #> '{incidentPacketProvisioning,custodianRoles}') ? p_actor_role
     OR p_event_type NOT IN ('downloaded', 'printed', 'handed_over', 'received', 'destroyed')
     OR p_copy_number < 1 OR p_copy_number > packet.allowed_copy_count
     OR p_evidence_hash !~ '^[0-9a-f]{64}$'
     OR p_occurred_at > clock_timestamp()
     OR (p_event_type = 'received' AND (
       packet.status <> 'unused' OR packet.revoked_at IS NOT NULL
       OR clock_timestamp() + make_interval(secs => packet.clock_uncertainty_seconds) < packet.valid_from
       OR clock_timestamp() + make_interval(secs => packet.clock_uncertainty_seconds) >= packet.valid_until
     )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_custody_authority',
      MESSAGE = 'packet custody evidence failed closed';
  END IF;
  INSERT INTO public.clinical_continuity_incident_packet_custody_events
    (tenant_id, facility_id, packet_id, event_type, copy_number, custodian_uid,
     custodian_role, evidence_hash, notes, occurred_at)
  VALUES (p_tenant_id, p_facility_id, p_packet_id, p_event_type, p_copy_number, p_actor_uid,
          p_actor_role, p_evidence_hash, left(p_notes, 500), p_occurred_at)
  RETURNING * INTO event;
  IF p_event_type = 'received' AND packet.supersedes_packet_id IS NOT NULL THEN
    UPDATE public.clinical_continuity_incident_packets
       SET status = 'revoked', revoked_at = clock_timestamp(),
           revocation_reason = 'replacement custody received'
     WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id
       AND id = packet.supersedes_packet_id AND status = 'unused';
  END IF;
  RETURN event;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_continuity_revoke_incident_packet(
  p_tenant_id UUID, p_facility_id INTEGER, p_packet_id UUID,
  p_actor_uid UUID, p_actor_role TEXT, p_reason TEXT
)
RETURNS public.clinical_continuity_incident_packets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE policy public.clinical_continuity_policy_versions%ROWTYPE;
DECLARE packet public.clinical_continuity_incident_packets%ROWTYPE;
BEGIN
  policy := public.cc_packet_active_policy(p_tenant_id, p_facility_id);
  PERFORM public.cc_packet_assert_actor(p_tenant_id, p_actor_uid, p_actor_role);
  IF NOT (policy.policy_document #> '{incidentPacketProvisioning,issuerRoles}') ? p_actor_role
     OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_revoke_authority',
      MESSAGE = 'packet revocation authority is invalid';
  END IF;
  UPDATE public.clinical_continuity_incident_packets
     SET status = 'revoked', revoked_at = clock_timestamp(), revocation_reason = left(btrim(p_reason), 160)
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id
     AND id = p_packet_id AND status = 'unused'
  RETURNING * INTO STRICT packet;
  RETURN packet;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_continuity_consume_incident_packet(
  p_tenant_id UUID, p_facility_id INTEGER, p_packet_id UUID, p_actor_uid UUID
)
RETURNS public.clinical_continuity_incident_packets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE packet public.clinical_continuity_incident_packets%ROWTYPE;
BEGIN
  PERFORM public.cc_packet_assert_context(p_tenant_id, p_facility_id);
  UPDATE public.clinical_continuity_incident_packets
     SET status = 'used', used_at = clock_timestamp(), used_by = p_actor_uid
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id AND id = p_packet_id
     AND status = 'unused' AND revoked_at IS NULL
     AND clock_timestamp() + make_interval(secs => COALESCE(clock_uncertainty_seconds, 0)) >= valid_from
     AND clock_timestamp() + make_interval(secs => COALESCE(clock_uncertainty_seconds, 0)) < valid_until
     AND (
       packet_schema_version IS NULL
       OR EXISTS (
         SELECT 1 FROM public.clinical_continuity_incident_packet_custody_events custody
          WHERE custody.tenant_id = p_tenant_id AND custody.facility_id = p_facility_id
            AND custody.packet_id = p_packet_id AND custody.event_type = 'received'
       )
     )
  RETURNING * INTO STRICT packet;
  RETURN packet;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_cc_packet_consume_available',
    MESSAGE = 'packet is not cryptographically and custodially available';
END;
$$;

ALTER TABLE public.clinical_continuity_incident_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_incident_packets FORCE ROW LEVEL SECURITY;

DO $rls$
DECLARE relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'clinical_continuity_incident_contact_sheets',
    'clinical_continuity_incident_contact_sheet_approvals',
    'clinical_continuity_incident_packet_allocations',
    'clinical_continuity_incident_packet_artifacts',
    'clinical_continuity_incident_packet_custody_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', relation_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I USING (tenant_id = public.app_current_tenant_id_uuid()) '
      'WITH CHECK (tenant_id = public.app_current_tenant_id_uuid())', relation_name
    );
    EXECUTE format(
      'CREATE POLICY cc_explicit_tenant_facility ON public.%I AS RESTRICTIVE USING ('
      'current_setting(''app.current_tenant_id'', true) IS NOT NULL AND '
      'current_setting(''app.current_tenant_id'', true) NOT IN ('''',''bypass'') AND '
      'tenant_id = public.app_current_tenant_id_uuid() AND '
      'current_setting(''app.current_facility_id'', true) ~ ''^[1-9][0-9]*$'' AND '
      'facility_id = current_setting(''app.current_facility_id'', true)::integer) WITH CHECK ('
      'current_setting(''app.current_tenant_id'', true) IS NOT NULL AND '
      'current_setting(''app.current_tenant_id'', true) NOT IN ('''',''bypass'') AND '
      'tenant_id = public.app_current_tenant_id_uuid() AND '
      'current_setting(''app.current_facility_id'', true) ~ ''^[1-9][0-9]*$'' AND '
      'facility_id = current_setting(''app.current_facility_id'', true)::integer)', relation_name
    );
  END LOOP;
END
$rls$;

REVOKE ALL ON FUNCTION public.cc_packet_assert_context(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cc_packet_active_policy(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cc_packet_assert_actor(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cc_packet_assert_contact_content(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_cc_packet_evidence_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_cc_packet_allocation_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clinical_continuity_create_incident_contact_sheet(UUID, INTEGER, UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clinical_continuity_approve_incident_contact_sheet(UUID, INTEGER, UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clinical_continuity_allocate_incident_packet(UUID, INTEGER, UUID, TEXT, UUID, TEXT, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clinical_continuity_void_incident_packet_allocation(UUID, INTEGER, UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clinical_continuity_issue_incident_packet(UUID, INTEGER, UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clinical_continuity_record_incident_packet_custody(UUID, INTEGER, UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clinical_continuity_revoke_incident_packet(UUID, INTEGER, UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clinical_continuity_consume_incident_packet(UUID, INTEGER, UUID, UUID) FROM PUBLIC;

DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime'] LOOP
    IF pg_catalog.to_regrole(role_name) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.clinical_continuity_incident_packets FROM %I', role_name);
    EXECUTE format('GRANT SELECT ON public.clinical_continuity_incident_packets TO %I', role_name);
    EXECUTE format('GRANT SELECT ON public.clinical_continuity_incident_contact_sheets, public.clinical_continuity_incident_contact_sheet_approvals, public.clinical_continuity_incident_packet_allocations, public.clinical_continuity_incident_packet_artifacts, public.clinical_continuity_incident_packet_custody_events TO %I', role_name);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.clinical_continuity_incident_contact_sheets, public.clinical_continuity_incident_contact_sheet_approvals, public.clinical_continuity_incident_packet_allocations, public.clinical_continuity_incident_packet_artifacts, public.clinical_continuity_incident_packet_custody_events FROM %I', role_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.clinical_continuity_create_incident_contact_sheet(UUID, INTEGER, UUID, TEXT, JSONB), public.clinical_continuity_approve_incident_contact_sheet(UUID, INTEGER, UUID, TEXT, UUID), public.clinical_continuity_allocate_incident_packet(UUID, INTEGER, UUID, TEXT, UUID, TEXT, UUID, UUID), public.clinical_continuity_void_incident_packet_allocation(UUID, INTEGER, UUID, UUID, TEXT, TEXT), public.clinical_continuity_issue_incident_packet(UUID, INTEGER, UUID, TEXT, JSONB), public.clinical_continuity_record_incident_packet_custody(UUID, INTEGER, UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ), public.clinical_continuity_revoke_incident_packet(UUID, INTEGER, UUID, UUID, TEXT, TEXT), public.clinical_continuity_consume_incident_packet(UUID, INTEGER, UUID, UUID) TO %I', role_name);
  END LOOP;
END
$grants$;

COMMENT ON TABLE public.clinical_continuity_incident_packet_allocations IS
  'Append-only reserved incident UUID and disjoint paper-number authority; void ranges are never reused.';
COMMENT ON TABLE public.clinical_continuity_incident_packet_custody_events IS
  'C-D10 packet delivery and receipt evidence; append-only and required before a provisioned packet can be consumed.';
COMMENT ON COLUMN public.clinical_continuity_incident_packets.valid_until IS
  'Exclusive NOT-VALID-AFTER boundary. There is no expiry grace period.';

COMMIT;
