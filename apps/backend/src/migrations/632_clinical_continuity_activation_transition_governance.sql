-- 632_clinical_continuity_activation_transition_governance.sql
-- C6.3-TG: authenticated, two-key activation advances and one-key halts over
-- the existing signed per-(tenant, facility) policy authority.
--
-- This migration is activation-inert. It seeds no roster identity, evidence
-- gate, policy, or transition. Empty roster/config tables therefore fail
-- closed until a later owner-audited Phase H change names exact identities and
-- exact cohort evidence.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE UNIQUE INDEX IF NOT EXISTS ux_clinical_audit_events_tenant_activation_transition
  ON public.clinical_audit_events (tenant_id, id);

-- Migration 600 requires retirement to close effective_until at the terminal
-- transition time. The current migration-630 shape requires effective_until to stay
-- exactly equal to the signed registry's maximum expiry in every lifecycle
-- state, which makes a v3/v4 retirement structurally impossible. Preserve the
-- latest v3/v4 shape and exact live binding; only a retired row may shorten
-- that window.
ALTER TABLE public.clinical_continuity_policy_versions
  DROP CONSTRAINT cc_policy_action_registry_shape_check;
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
      AND policy_document #>> '{actionRegistry,registryChecksum}'
            = BTRIM(action_registry_checksum)
      AND public.clinical_continuity_parse_timestamp(
            policy_document #>> '{actionRegistry,issuedAt}'
          ) = effective_from
      AND (
        (
          lifecycle_state <> 'retired'
          AND public.clinical_continuity_parse_timestamp(
                policy_document #>> '{actionRegistry,expiresAt}'
              ) = effective_until
        )
        OR (
          lifecycle_state = 'retired'
          AND effective_until <= public.clinical_continuity_parse_timestamp(
                policy_document #>> '{actionRegistry,expiresAt}'
              )
        )
      )
      AND policy_document #>> '{actionRegistry,approvalEvidence,decisionId}' = 'C-D3'
      AND policy_document #>> '{actionRegistry,approvalEvidence,countersignedAt}'
            = '2026-07-30'
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
          AND jsonb_typeof(
                policy_document #> '{incidentPacketProvisioning,contactSheetApproverRoles}'
              ) = 'array'
          AND jsonb_array_length(
                policy_document #> '{incidentPacketProvisioning,contactSheetApproverRoles}'
              ) > 0
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

CREATE TABLE public.clinical_continuity_activation_key_roster (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  subject_uid UUID NOT NULL,
  subject_role VARCHAR(64) NOT NULL,
  authority_kind VARCHAR(48) NOT NULL,
  entry_kind VARCHAR(12) NOT NULL,
  signoff_role_label VARCHAR(120),
  affected_unit_reference VARCHAR(160),
  revokes_entry_id UUID,
  valid_from TIMESTAMPTZ(6) NOT NULL,
  valid_until TIMESTAMPTZ(6),
  owner_evidence_reference VARCHAR(255) NOT NULL,
  owner_evidence_sha256 CHAR(64) NOT NULL,
  recorded_by_uid UUID NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT fk_cc_activation_roster_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_roster_facility
    FOREIGN KEY (tenant_id, facility_id) REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_roster_subject
    FOREIGN KEY (tenant_id, subject_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_roster_recorder
    FOREIGN KEY (tenant_id, recorded_by_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_roster_revocation
    FOREIGN KEY (tenant_id, revokes_entry_id)
    REFERENCES public.clinical_continuity_activation_key_roster(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_activation_roster_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_cc_activation_roster_authority
    CHECK (authority_kind IN (
      'advance_clinical', 'advance_technical',
      'rollback_signoff', 'affected_unit_clinical_lead'
    )),
  CONSTRAINT chk_cc_activation_roster_entry_kind
    CHECK (entry_kind IN ('grant', 'revoke')),
  CONSTRAINT chk_cc_activation_roster_window
    CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT chk_cc_activation_roster_hash
    CHECK (owner_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_cc_activation_roster_shape
    CHECK (
      (entry_kind = 'grant' AND revokes_entry_id IS NULL)
      OR (entry_kind = 'revoke' AND revokes_entry_id IS NOT NULL)
    ),
  CONSTRAINT chk_cc_activation_roster_scope
    CHECK (
      (
        authority_kind = 'affected_unit_clinical_lead'
        AND NULLIF(BTRIM(affected_unit_reference), '') IS NOT NULL
      )
      OR (
        authority_kind <> 'affected_unit_clinical_lead'
        AND affected_unit_reference IS NULL
      )
    ),
  CONSTRAINT chk_cc_activation_roster_signoff_label
    CHECK (
      authority_kind <> 'rollback_signoff'
      OR NULLIF(BTRIM(signoff_role_label), '') IS NOT NULL
    )
);

CREATE UNIQUE INDEX uq_cc_activation_roster_revocation
  ON public.clinical_continuity_activation_key_roster (tenant_id, revokes_entry_id)
  WHERE entry_kind = 'revoke';

CREATE INDEX idx_cc_activation_roster_lookup
  ON public.clinical_continuity_activation_key_roster (
    tenant_id, facility_id, subject_uid, authority_kind, valid_from DESC
  );

CREATE TABLE public.clinical_continuity_activation_evidence_gate_configs (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  shadow_policy_id UUID NOT NULL,
  target_policy_id UUID NOT NULL,
  config_version INTEGER NOT NULL,
  minimum_shadow_days SMALLINT NOT NULL,
  minimum_clean_drill_records SMALLINT NOT NULL,
  clean_drill_records JSONB NOT NULL,
  owner_evidence_reference VARCHAR(255) NOT NULL,
  owner_evidence_sha256 CHAR(64) NOT NULL,
  supersedes_config_id UUID,
  recorded_by_uid UUID NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT fk_cc_activation_gate_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_gate_facility
    FOREIGN KEY (tenant_id, facility_id) REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_gate_shadow_policy
    FOREIGN KEY (tenant_id, facility_id, shadow_policy_id)
    REFERENCES public.clinical_continuity_policy_versions(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_gate_target_policy
    FOREIGN KEY (tenant_id, facility_id, target_policy_id)
    REFERENCES public.clinical_continuity_policy_versions(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_gate_supersedes
    FOREIGN KEY (tenant_id, supersedes_config_id)
    REFERENCES public.clinical_continuity_activation_evidence_gate_configs(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_gate_recorder
    FOREIGN KEY (tenant_id, recorded_by_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_activation_gate_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_cc_activation_gate_version
    CHECK (config_version > 0),
  -- C-D11 floor: time and a clean planned drill are conjunctive. A cohort may
  -- configure stricter values, never lower ones.
  CONSTRAINT chk_cc_activation_gate_cd11_floor
    CHECK (minimum_shadow_days >= 14 AND minimum_clean_drill_records >= 1),
  CONSTRAINT chk_cc_activation_gate_records
    CHECK (
      jsonb_typeof(clean_drill_records) = 'array'
      AND jsonb_array_length(clean_drill_records) >= minimum_clean_drill_records
      AND jsonb_array_length(clean_drill_records) <= 100
    ),
  CONSTRAINT chk_cc_activation_gate_hash
    CHECK (owner_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_cc_activation_gate_distinct_policies
    CHECK (shadow_policy_id <> target_policy_id)
);

CREATE UNIQUE INDEX uq_cc_activation_gate_version
  ON public.clinical_continuity_activation_evidence_gate_configs (
    tenant_id, facility_id, target_policy_id, config_version
  );

CREATE UNIQUE INDEX uq_cc_activation_gate_superseded_once
  ON public.clinical_continuity_activation_evidence_gate_configs (
    tenant_id, supersedes_config_id
  )
  WHERE supersedes_config_id IS NOT NULL;

CREATE TABLE public.clinical_continuity_activation_transition_events (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  action VARCHAR(24) NOT NULL,
  transition_kind VARCHAR(32) NOT NULL,
  outcome VARCHAR(32) NOT NULL,
  intent_event_id UUID,
  prior_policy_id UUID,
  target_policy_id UUID,
  roster_entry_id UUID,
  evidence_gate_config_id UUID,
  actor_uid UUID NOT NULL,
  actor_role VARCHAR(64) NOT NULL,
  actor_authority_kind VARCHAR(48),
  idempotency_key_sha256 CHAR(64),
  effect_identity CHAR(64),
  command_fingerprint CHAR(64),
  expected_state_fingerprint CHAR(64),
  prior_state JSONB,
  next_state JSONB,
  evidence_references JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_code VARCHAR(80),
  reason_detail VARCHAR(500),
  request_id VARCHAR(120),
  clinical_audit_event_id UUID,
  claim_txid BIGINT,
  receipt JSONB NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT fk_cc_activation_event_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_event_facility
    FOREIGN KEY (tenant_id, facility_id) REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_event_intent
    FOREIGN KEY (tenant_id, intent_event_id)
    REFERENCES public.clinical_continuity_activation_transition_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_event_prior_policy
    FOREIGN KEY (tenant_id, facility_id, prior_policy_id)
    REFERENCES public.clinical_continuity_policy_versions(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_event_target_policy
    FOREIGN KEY (tenant_id, facility_id, target_policy_id)
    REFERENCES public.clinical_continuity_policy_versions(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_event_roster
    FOREIGN KEY (tenant_id, roster_entry_id)
    REFERENCES public.clinical_continuity_activation_key_roster(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_event_gate
    FOREIGN KEY (tenant_id, evidence_gate_config_id)
    REFERENCES public.clinical_continuity_activation_evidence_gate_configs(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_event_actor
    FOREIGN KEY (tenant_id, actor_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_activation_event_audit
    FOREIGN KEY (tenant_id, clinical_audit_event_id)
    REFERENCES public.clinical_audit_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_cc_activation_event_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_cc_activation_event_action
    CHECK (action IN ('advance', 'halt')),
  CONSTRAINT chk_cc_activation_event_transition
    CHECK (transition_kind IN (
      'off_to_shadow', 'shadow_to_active', 'active_to_active',
      'shadow_to_off', 'active_to_off', 'unknown'
    )),
  CONSTRAINT chk_cc_activation_event_outcome
    CHECK (outcome IN (
      'awaiting_counterkey', 'applied', 'refused_scope',
      'refused_stale', 'refused_policy', 'refused_evidence'
    )),
  CONSTRAINT chk_cc_activation_event_hashes
    CHECK (
      (idempotency_key_sha256 IS NULL OR idempotency_key_sha256 ~ '^[0-9a-f]{64}$')
      AND (effect_identity IS NULL OR effect_identity ~ '^[0-9a-f]{64}$')
      AND (command_fingerprint IS NULL OR command_fingerprint ~ '^[0-9a-f]{64}$')
      AND (expected_state_fingerprint IS NULL
        OR expected_state_fingerprint ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT chk_cc_activation_event_evidence
    CHECK (jsonb_typeof(evidence_references) IN ('array', 'object')),
  CONSTRAINT chk_cc_activation_event_reason
    CHECK (
      reason_detail IS NULL
      OR (
        CHAR_LENGTH(BTRIM(reason_detail)) BETWEEN 10 AND 500
        AND reason_detail !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT chk_cc_activation_event_applied_audit
    CHECK (
      (outcome = 'applied' AND clinical_audit_event_id IS NOT NULL AND claim_txid IS NOT NULL)
      OR (outcome <> 'applied' AND clinical_audit_event_id IS NULL)
    ),
  CONSTRAINT chk_cc_activation_event_intent_shape
    CHECK (
      (outcome = 'awaiting_counterkey' AND action = 'advance' AND intent_event_id IS NULL)
      OR (outcome = 'applied' AND action = 'advance' AND intent_event_id IS NOT NULL)
      OR (action = 'halt' AND intent_event_id IS NULL)
      OR outcome LIKE 'refused_%'
    )
);

CREATE UNIQUE INDEX uq_cc_activation_event_idempotency
  ON public.clinical_continuity_activation_transition_events (
    tenant_id, idempotency_key_sha256
  )
  WHERE idempotency_key_sha256 IS NOT NULL
    AND outcome IN ('awaiting_counterkey', 'applied');

CREATE UNIQUE INDEX uq_cc_activation_event_applied_effect
  ON public.clinical_continuity_activation_transition_events (tenant_id, effect_identity)
  WHERE outcome = 'applied';

CREATE UNIQUE INDEX uq_cc_activation_event_intent_actor
  ON public.clinical_continuity_activation_transition_events (
    tenant_id, effect_identity, actor_uid
  )
  WHERE outcome = 'awaiting_counterkey';

CREATE INDEX idx_cc_activation_event_facility_time
  ON public.clinical_continuity_activation_transition_events (
    tenant_id, facility_id, recorded_at DESC, id
  );

ALTER TABLE public.clinical_continuity_activation_key_roster
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_activation_key_roster
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_activation_evidence_gate_configs
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_activation_evidence_gate_configs
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_activation_transition_events
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_activation_transition_events
  FORCE ROW LEVEL SECURITY;

DO $cc_activation_rls$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'clinical_continuity_activation_key_roster',
    'clinical_continuity_activation_evidence_gate_configs',
    'clinical_continuity_activation_transition_events'
  ]::TEXT[] LOOP
    EXECUTE FORMAT('DROP POLICY IF EXISTS tenant_isolation ON public.%I', relation_name);
    EXECUTE FORMAT(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL '
      'USING (tenant_id = public.app_current_tenant_id_uuid()) '
      'WITH CHECK (tenant_id = public.app_current_tenant_id_uuid())',
      relation_name
    );
    EXECUTE FORMAT('DROP POLICY IF EXISTS cc_activation_explicit_context ON public.%I', relation_name);
    EXECUTE FORMAT(
      'CREATE POLICY cc_activation_explicit_context ON public.%I AS RESTRICTIVE FOR ALL '
      'USING ('
      ' current_setting(''app.current_tenant_id'', true) IS NOT NULL'
      ' AND current_setting(''app.current_tenant_id'', true) <> '''''
      ' AND current_setting(''app.current_tenant_id'', true) <> ''bypass'''
      ' AND current_setting(''app.current_tenant_id'', true) ~ ''^[0-9a-fA-F-]{36}$'''
      ' AND tenant_id = public.app_current_tenant_id_uuid()'
      ') WITH CHECK ('
      ' current_setting(''app.current_tenant_id'', true) IS NOT NULL'
      ' AND current_setting(''app.current_tenant_id'', true) <> '''''
      ' AND current_setting(''app.current_tenant_id'', true) <> ''bypass'''
      ' AND current_setting(''app.current_tenant_id'', true) ~ ''^[0-9a-fA-F-]{36}$'''
      ' AND tenant_id = public.app_current_tenant_id_uuid()'
      ')',
      relation_name
    );
  END LOOP;
END
$cc_activation_rls$;

CREATE FUNCTION public.clinical_continuity_activation_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'chk_cc_activation_append_only',
    MESSAGE = 'clinical continuity activation governance is append-only';
END;
$$;

CREATE FUNCTION public.clinical_continuity_activation_owner_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  relation_owner NAME;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
    INTO relation_owner
    FROM pg_catalog.pg_class AS class
   WHERE class.oid = TG_RELID;
  IF current_user IS DISTINCT FROM relation_owner THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'clinical continuity activation governance requires its dedicated command';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.clinical_continuity_activation_roster_shape_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  prior public.clinical_continuity_activation_key_roster%ROWTYPE;
BEGIN
  IF NEW.entry_kind = 'revoke' THEN
    SELECT * INTO prior
      FROM public.clinical_continuity_activation_key_roster AS roster
     WHERE roster.tenant_id = NEW.tenant_id
       AND roster.id = NEW.revokes_entry_id
       AND roster.entry_kind = 'grant'
     FOR SHARE;
    IF NOT FOUND
       OR prior.facility_id IS DISTINCT FROM NEW.facility_id
       OR prior.subject_uid IS DISTINCT FROM NEW.subject_uid
       OR prior.subject_role IS DISTINCT FROM NEW.subject_role
       OR prior.authority_kind IS DISTINCT FROM NEW.authority_kind
       OR prior.signoff_role_label IS DISTINCT FROM NEW.signoff_role_label
       OR prior.affected_unit_reference IS DISTINCT FROM NEW.affected_unit_reference THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'roster revocation must exactly bind one grant';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.clinical_continuity_activation_gate_shape_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  evidence JSONB;
  evidence_key TEXT;
  seen_evidence_keys TEXT[] := ARRAY[]::TEXT[];
  prior public.clinical_continuity_activation_evidence_gate_configs%ROWTYPE;
BEGIN
  FOR evidence IN SELECT value FROM jsonb_array_elements(NEW.clean_drill_records) LOOP
    IF jsonb_typeof(evidence) <> 'object'
       OR NULLIF(BTRIM(evidence ->> 'reference'), '') IS NULL
       OR evidence ->> 'sha256' !~ '^[0-9a-f]{64}$'
       OR NULLIF(evidence ->> 'completed_at', '') IS NULL
       OR (evidence ->> 'completed_at')::timestamptz > clock_timestamp()
       OR COALESCE((evidence ->> 'planned')::boolean, FALSE) IS NOT TRUE
       OR COALESCE((evidence ->> 'clean')::boolean, FALSE) IS NOT TRUE
       OR COALESCE((evidence ->> 'continuity_packs_verified')::boolean, FALSE) IS NOT TRUE
       OR COALESCE((evidence ->> 'paper_path_exercised')::boolean, FALSE) IS NOT TRUE
       OR COALESCE((evidence ->> 'captured_work_reconciled')::boolean, FALSE) IS NOT TRUE
       OR COALESCE((evidence ->> 'unresolved_count')::integer, -1) <> 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'clean drill evidence does not satisfy the C-D11 record shape';
    END IF;
    evidence_key := (evidence ->> 'reference') || ':' || (evidence ->> 'sha256');
    IF evidence_key = ANY(seen_evidence_keys) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'clean drill evidence records must be distinct';
    END IF;
    seen_evidence_keys := array_append(seen_evidence_keys, evidence_key);
  END LOOP;
  IF NEW.config_version = 1 THEN
    IF NEW.supersedes_config_id IS NOT NULL OR EXISTS (
      SELECT 1
        FROM public.clinical_continuity_activation_evidence_gate_configs AS existing
       WHERE existing.tenant_id = NEW.tenant_id
         AND existing.facility_id = NEW.facility_id
         AND existing.target_policy_id = NEW.target_policy_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'evidence-gate version one must begin one exact policy chain';
    END IF;
  ELSE
    SELECT * INTO prior
      FROM public.clinical_continuity_activation_evidence_gate_configs AS config
     WHERE config.tenant_id = NEW.tenant_id
       AND config.id = NEW.supersedes_config_id
     FOR SHARE;
    IF NOT FOUND
       OR prior.facility_id IS DISTINCT FROM NEW.facility_id
       OR prior.shadow_policy_id IS DISTINCT FROM NEW.shadow_policy_id
       OR prior.target_policy_id IS DISTINCT FROM NEW.target_policy_id
       OR NEW.config_version IS DISTINCT FROM prior.config_version + 1
       OR NEW.minimum_shadow_days < prior.minimum_shadow_days
       OR NEW.minimum_clean_drill_records < prior.minimum_clean_drill_records
       OR EXISTS (
         SELECT 1
           FROM public.clinical_continuity_activation_evidence_gate_configs AS newer
          WHERE newer.tenant_id = prior.tenant_id
            AND newer.supersedes_config_id = prior.id
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'evidence-gate versions must form one non-weakening exact policy chain';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cc_activation_roster_insert_owner
BEFORE INSERT ON public.clinical_continuity_activation_key_roster
FOR EACH ROW EXECUTE FUNCTION public.clinical_continuity_activation_owner_insert();
CREATE TRIGGER cc_activation_roster_shape
BEFORE INSERT ON public.clinical_continuity_activation_key_roster
FOR EACH ROW EXECUTE FUNCTION public.clinical_continuity_activation_roster_shape_guard();
CREATE TRIGGER cc_activation_roster_append_only
BEFORE UPDATE OR DELETE ON public.clinical_continuity_activation_key_roster
FOR EACH ROW EXECUTE FUNCTION public.clinical_continuity_activation_append_only();

CREATE TRIGGER cc_activation_gate_insert_owner
BEFORE INSERT ON public.clinical_continuity_activation_evidence_gate_configs
FOR EACH ROW EXECUTE FUNCTION public.clinical_continuity_activation_owner_insert();
CREATE TRIGGER cc_activation_gate_shape
BEFORE INSERT ON public.clinical_continuity_activation_evidence_gate_configs
FOR EACH ROW EXECUTE FUNCTION public.clinical_continuity_activation_gate_shape_guard();
CREATE TRIGGER cc_activation_gate_append_only
BEFORE UPDATE OR DELETE ON public.clinical_continuity_activation_evidence_gate_configs
FOR EACH ROW EXECUTE FUNCTION public.clinical_continuity_activation_append_only();

CREATE TRIGGER cc_activation_event_insert_owner
BEFORE INSERT ON public.clinical_continuity_activation_transition_events
FOR EACH ROW EXECUTE FUNCTION public.clinical_continuity_activation_owner_insert();
CREATE TRIGGER cc_activation_event_append_only
BEFORE UPDATE OR DELETE ON public.clinical_continuity_activation_transition_events
FOR EACH ROW EXECUTE FUNCTION public.clinical_continuity_activation_append_only();

CREATE FUNCTION public.clinical_continuity_activation_bound_hash(values_to_bind TEXT[])
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT encode(
    public.digest(
      convert_to(
        string_agg(
          CASE
            WHEN value IS NULL THEN 'N;'
            ELSE 'V' || octet_length(value)::text || ':' || value || ';'
          END,
          '' ORDER BY ordinal
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )::char(64)
    FROM unnest(values_to_bind) WITH ORDINALITY AS bound(value, ordinal)
$$;

CREATE FUNCTION public.clinical_continuity_activation_assert_evidence_references(
  p_evidence JSONB,
  p_minimum INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF jsonb_typeof(p_evidence) <> 'array'
     OR jsonb_array_length(p_evidence) NOT BETWEEN p_minimum AND 20
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_evidence) AS item(evidence)
        WHERE jsonb_typeof(evidence) <> 'object'
           OR NULLIF(BTRIM(evidence ->> 'reference'), '') IS NULL
           OR CHAR_LENGTH(evidence ->> 'reference') > 255
           OR COALESCE(evidence ->> 'sha256' !~ '^[0-9a-f]{64}$', TRUE)
     )
     OR (
       SELECT COUNT(*)
         FROM jsonb_array_elements(p_evidence)
     ) <> (
       SELECT COUNT(DISTINCT (evidence ->> 'reference', evidence ->> 'sha256'))
         FROM jsonb_array_elements(p_evidence) AS item(evidence)
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'activation command evidence references are invalid or duplicated';
  END IF;
END;
$$;

CREATE FUNCTION public.clinical_continuity_activation_assert_context(p_tenant UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant
     OR p_tenant = '00000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'explicit non-default tenant context required';
  END IF;
END;
$$;

CREATE FUNCTION public.clinical_continuity_activation_projected_state(
  p_tenant UUID,
  p_facility INTEGER,
  p_policy UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  policy_record public.clinical_continuity_policy_versions%ROWTYPE;
  mode_value TEXT;
  action_ids JSONB := '[]'::jsonb;
  state_value TEXT;
  fingerprint TEXT;
BEGIN
  PERFORM public.clinical_continuity_activation_assert_context(p_tenant);
  IF p_policy IS NULL THEN
    fingerprint := public.clinical_continuity_activation_bound_hash(ARRAY[
      p_tenant::text, p_facility::text, 'off', NULL, NULL, NULL, NULL, '[]'
    ]);
    RETURN jsonb_build_object(
      'tenant_id', p_tenant,
      'facility_id', p_facility,
      'state', 'off',
      'policy_id', NULL,
      'policy_version', NULL,
      'policy_checksum', NULL,
      'mode', NULL,
      'enforced_action_ids', '[]'::jsonb,
      'state_fingerprint', fingerprint
    );
  END IF;

  SELECT * INTO STRICT policy_record
    FROM public.clinical_continuity_policy_versions AS policy
   WHERE policy.tenant_id = p_tenant
     AND policy.facility_id = p_facility
     AND policy.id = p_policy;
  mode_value := policy_record.policy_document #>> '{actionRegistry,activation,mode}';
  SELECT COALESCE(jsonb_agg(action_id ORDER BY action_id), '[]'::jsonb)
    INTO action_ids
    FROM jsonb_array_elements_text(
      COALESCE(
        policy_record.policy_document #> '{actionRegistry,activation,enforcedActionIds}',
        '[]'::jsonb
      )
    ) AS action(action_id);
  IF mode_value = 'shadow' AND jsonb_array_length(action_ids) = 0 THEN
    state_value := 'shadow';
  ELSIF mode_value = 'enforce' AND jsonb_array_length(action_ids) > 0 THEN
    state_value := 'active';
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'policy activation mode does not map to C6.3 state';
  END IF;
  fingerprint := public.clinical_continuity_activation_bound_hash(ARRAY[
    p_tenant::text,
    p_facility::text,
    state_value,
    policy_record.id::text,
    policy_record.policy_version::text,
    BTRIM(policy_record.policy_checksum),
    mode_value,
    action_ids::text
  ]);
  RETURN jsonb_build_object(
    'tenant_id', p_tenant,
    'facility_id', p_facility,
    'state', state_value,
    'policy_id', policy_record.id,
    'policy_version', policy_record.policy_version,
    'policy_checksum', BTRIM(policy_record.policy_checksum),
    'mode', mode_value,
    'enforced_action_ids', action_ids,
    'state_fingerprint', fingerprint
  );
END;
$$;

CREATE FUNCTION public.clinical_continuity_activation_state_snapshot(
  p_tenant UUID,
  p_facility INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  active_policy UUID;
BEGIN
  PERFORM public.clinical_continuity_activation_assert_context(p_tenant);
  IF NOT EXISTS (
    SELECT 1 FROM public.facilities
     WHERE tenant_id = p_tenant AND id = p_facility AND status = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'activation facility is outside the tenant or inactive';
  END IF;
  SELECT policy.id INTO active_policy
    FROM public.clinical_continuity_policy_versions AS policy
   WHERE policy.tenant_id = p_tenant
     AND policy.facility_id = p_facility
     AND policy.lifecycle_state = 'active'
   ORDER BY policy.policy_version DESC, policy.id
   LIMIT 2;
  RETURN public.clinical_continuity_activation_projected_state(
    p_tenant, p_facility, active_policy
  );
END;
$$;

CREATE FUNCTION public.clinical_continuity_activation_active_roster_entry(
  p_tenant UUID,
  p_facility INTEGER,
  p_roster_entry UUID,
  p_actor UUID,
  p_actor_role TEXT
)
RETURNS public.clinical_continuity_activation_key_roster
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  roster public.clinical_continuity_activation_key_roster%ROWTYPE;
BEGIN
  PERFORM public.clinical_continuity_activation_assert_context(p_tenant);
  SELECT grant_entry.* INTO roster
    FROM public.clinical_continuity_activation_key_roster AS grant_entry
   WHERE grant_entry.tenant_id = p_tenant
     AND grant_entry.facility_id = p_facility
     AND grant_entry.id = p_roster_entry
     AND grant_entry.entry_kind = 'grant'
     AND grant_entry.subject_uid = p_actor
     AND grant_entry.subject_role = UPPER(BTRIM(p_actor_role))
     AND grant_entry.valid_from <= clock_timestamp()
     AND (grant_entry.valid_until IS NULL OR grant_entry.valid_until > clock_timestamp())
     AND NOT EXISTS (
       SELECT 1
         FROM public.clinical_continuity_activation_key_roster AS revocation
        WHERE revocation.tenant_id = grant_entry.tenant_id
          AND revocation.entry_kind = 'revoke'
          AND revocation.revokes_entry_id = grant_entry.id
          AND revocation.valid_from <= clock_timestamp()
     )
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'active activation roster authority required';
  END IF;
  RETURN roster;
END;
$$;

CREATE FUNCTION public.clinical_continuity_activation_evidence_snapshot(
  p_tenant UUID,
  p_facility INTEGER,
  p_transition TEXT,
  p_shadow_policy UUID,
  p_target_policy UUID,
  p_config UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  gate public.clinical_continuity_activation_evidence_gate_configs%ROWTYPE;
  shadow_started_at TIMESTAMPTZ(6);
  evidence JSONB;
BEGIN
  PERFORM public.clinical_continuity_activation_assert_context(p_tenant);
  IF p_transition = 'off_to_shadow' THEN
    IF p_config IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'entering shadow does not accept an enforcement evidence gate';
    END IF;
    RETURN jsonb_build_object('gate', 'not_applicable');
  END IF;
  SELECT * INTO gate
    FROM public.clinical_continuity_activation_evidence_gate_configs AS config
   WHERE config.tenant_id = p_tenant
     AND config.facility_id = p_facility
     AND config.id = p_config
     AND config.shadow_policy_id = p_shadow_policy
     AND config.target_policy_id = p_target_policy
     AND NOT EXISTS (
       SELECT 1
         FROM public.clinical_continuity_activation_evidence_gate_configs AS newer
        WHERE newer.tenant_id = config.tenant_id
          AND newer.supersedes_config_id = config.id
     )
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'current exact evidence-gate config required';
  END IF;
  SELECT event.recorded_at INTO shadow_started_at
    FROM public.clinical_continuity_activation_transition_events AS event
   WHERE event.tenant_id = p_tenant
     AND event.facility_id = p_facility
     AND event.action = 'advance'
     AND event.outcome = 'applied'
     AND event.transition_kind = 'off_to_shadow'
     AND event.target_policy_id = p_shadow_policy
   ORDER BY event.recorded_at
   LIMIT 1;
  IF shadow_started_at IS NULL
     OR shadow_started_at + make_interval(days => gate.minimum_shadow_days) > clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'minimum shadow duration is not satisfied';
  END IF;
  FOR evidence IN SELECT value FROM jsonb_array_elements(gate.clean_drill_records) LOOP
    IF (evidence ->> 'completed_at')::timestamptz < shadow_started_at THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'clean drill evidence predates shadow operation';
    END IF;
  END LOOP;
  IF jsonb_array_length(gate.clean_drill_records) < gate.minimum_clean_drill_records THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'minimum clean drill count is not satisfied';
  END IF;
  RETURN jsonb_build_object(
    'gate', 'satisfied',
    'config_id', gate.id,
    'config_version', gate.config_version,
    'shadow_policy_id', gate.shadow_policy_id,
    'target_policy_id', gate.target_policy_id,
    'minimum_shadow_days', gate.minimum_shadow_days,
    'minimum_clean_drill_records', gate.minimum_clean_drill_records,
    'shadow_started_at', shadow_started_at,
    'clean_drill_records', gate.clean_drill_records,
    'owner_evidence_reference', gate.owner_evidence_reference,
    'owner_evidence_sha256', BTRIM(gate.owner_evidence_sha256)
  );
END;
$$;

CREATE FUNCTION public.clinical_continuity_activation_advance_intent(p_command JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant UUID := (p_command ->> 'tenant_id')::uuid;
  facility INTEGER := (p_command ->> 'facility_id')::integer;
  actor UUID := (p_command ->> 'actor_uid')::uuid;
  actor_role_value TEXT;
  event_id UUID := (p_command ->> 'event_id')::uuid;
  target_policy UUID := (p_command ->> 'target_policy_id')::uuid;
  roster public.clinical_continuity_activation_key_roster%ROWTYPE;
  target public.clinical_continuity_policy_versions%ROWTYPE;
  prior_state JSONB;
  next_state JSONB;
  transition_value TEXT;
  current_policy UUID;
  shadow_policy UUID;
  gate_config UUID := NULLIF(p_command ->> 'evidence_gate_config_id', '')::uuid;
  gate_evidence JSONB;
  evidence_refs JSONB;
  effect_hash TEXT;
  command_hash TEXT;
  stored_receipt JSONB;
  existing public.clinical_continuity_activation_transition_events%ROWTYPE;
BEGIN
  PERFORM public.clinical_continuity_activation_assert_context(tenant);
  PERFORM public.clinical_continuity_activation_assert_evidence_references(
    COALESCE(p_command -> 'evidence_references', 'null'::jsonb), 1
  );
  IF COALESCE(p_command ->> 'idempotency_key_sha256' !~ '^[0-9a-f]{64}$', TRUE)
     OR COALESCE(p_command ->> 'expected_state_fingerprint' !~ '^[0-9a-f]{64}$', TRUE)
     OR NULLIF(BTRIM(p_command ->> 'reason_detail'), '') IS NULL
     OR CHAR_LENGTH(BTRIM(p_command ->> 'reason_detail')) NOT BETWEEN 10 AND 500
     OR p_command ->> 'reason_detail' ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'activation advance command evidence is invalid';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(tenant::text || ':' || facility::text, 632)
  );
  SELECT UPPER(BTRIM(role)) INTO actor_role_value
    FROM public.users
   WHERE tenant_id = tenant AND uid = actor
     AND is_active AND NOT is_deleted AND status = 'active'
     AND UPPER(BTRIM(role)) <> 'PATIENT'
   FOR SHARE;
  IF actor_role_value IS NULL
     OR actor_role_value IS DISTINCT FROM UPPER(BTRIM(p_command ->> 'actor_role')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'current authenticated staff actor required';
  END IF;
  SELECT * INTO existing
    FROM public.clinical_continuity_activation_transition_events AS event
   WHERE event.tenant_id = tenant
     AND event.idempotency_key_sha256 = p_command ->> 'idempotency_key_sha256'
     AND event.outcome IN ('awaiting_counterkey', 'applied')
   FOR SHARE;
  IF FOUND THEN
    IF existing.id = event_id
       AND existing.action = 'advance'
       AND existing.actor_uid = actor
       AND existing.target_policy_id = target_policy
       AND existing.roster_entry_id = (p_command ->> 'roster_entry_id')::uuid
       AND existing.evidence_gate_config_id IS NOT DISTINCT FROM gate_config
       AND existing.expected_state_fingerprint = p_command ->> 'expected_state_fingerprint'
       AND existing.reason_code = p_command ->> 'reason_code'
       AND existing.reason_detail IS NOT DISTINCT FROM NULLIF(p_command ->> 'reason_detail', '')
       AND existing.evidence_references -> 'command'
             IS NOT DISTINCT FROM p_command -> 'evidence_references' THEN
      RETURN jsonb_set(existing.receipt, '{disposition}', '"exact_duplicate"'::jsonb);
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'activation intent idempotency identity drift';
  END IF;
  roster := public.clinical_continuity_activation_active_roster_entry(
    tenant, facility, (p_command ->> 'roster_entry_id')::uuid, actor, actor_role_value
  );
  IF roster.authority_kind NOT IN ('advance_clinical', 'advance_technical') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'advance requires a clinical or technical roster key';
  END IF;
  SELECT * INTO target
    FROM public.clinical_continuity_policy_versions AS policy
   WHERE policy.tenant_id = tenant
     AND policy.facility_id = facility
     AND policy.id = target_policy
   FOR UPDATE;
  IF NOT FOUND
     OR target.lifecycle_state <> 'approved'
     OR target.policy_schema_version NOT IN (3, 4) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'exact approved action-registry policy target required';
  END IF;
  prior_state := public.clinical_continuity_activation_state_snapshot(tenant, facility);
  IF prior_state ->> 'state_fingerprint' IS DISTINCT FROM p_command ->> 'expected_state_fingerprint' THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'activation state fingerprint changed';
  END IF;
  current_policy := NULLIF(prior_state ->> 'policy_id', '')::uuid;
  next_state := public.clinical_continuity_activation_projected_state(tenant, facility, target_policy);
  IF prior_state ->> 'state' = 'off' AND next_state ->> 'state' = 'shadow' THEN
    transition_value := 'off_to_shadow';
    shadow_policy := target_policy;
  ELSIF prior_state ->> 'state' = 'shadow' AND next_state ->> 'state' = 'active' THEN
    transition_value := 'shadow_to_active';
    shadow_policy := current_policy;
  ELSIF prior_state ->> 'state' = 'active' AND next_state ->> 'state' = 'active'
        AND (next_state -> 'enforced_action_ids') @> (prior_state -> 'enforced_action_ids')
        AND next_state -> 'enforced_action_ids' <> prior_state -> 'enforced_action_ids' THEN
    transition_value := 'active_to_active';
    SELECT event.target_policy_id INTO shadow_policy
      FROM public.clinical_continuity_activation_transition_events AS event
     WHERE event.tenant_id = tenant
       AND event.facility_id = facility
       AND event.transition_kind = 'off_to_shadow'
       AND event.outcome = 'applied'
     ORDER BY event.recorded_at DESC
     LIMIT 1;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'requested policy is not a forward C6.3 transition';
  END IF;
  IF current_policy IS NOT NULL
     AND target.supersedes_policy_id IS DISTINCT FROM current_policy THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'advance target must directly supersede the current policy';
  END IF;
  IF p_command ->> 'reason_code' IS DISTINCT FROM (CASE transition_value
       WHEN 'off_to_shadow' THEN 'enter_shadow'
       WHEN 'shadow_to_active' THEN 'enforcement_evidence_satisfied'
       ELSE 'staged_enforcement_widening'
     END) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'advance reason does not match the requested transition';
  END IF;
  gate_evidence := public.clinical_continuity_activation_evidence_snapshot(
    tenant, facility, transition_value, shadow_policy, target_policy, gate_config
  );
  evidence_refs := jsonb_build_object(
    'gate', gate_evidence,
    'command', COALESCE(p_command -> 'evidence_references', '[]'::jsonb)
  );
  effect_hash := public.clinical_continuity_activation_bound_hash(ARRAY[
    'advance', tenant::text, facility::text, transition_value, current_policy::text,
    target_policy::text, p_command ->> 'expected_state_fingerprint', gate_config::text,
    evidence_refs::text
  ]);
  command_hash := public.clinical_continuity_activation_bound_hash(ARRAY[
    effect_hash, actor::text, actor_role_value, roster.id::text,
    p_command ->> 'reason_code', NULLIF(p_command ->> 'reason_detail', '')
  ]);
  stored_receipt := jsonb_build_object(
    'disposition', 'awaiting_counterkey',
    'intent_event_id', event_id,
    'tenant_id', tenant,
    'facility_id', facility,
    'transition_kind', transition_value,
    'expected_state_fingerprint', p_command ->> 'expected_state_fingerprint',
    'target_policy_id', target_policy,
    'first_key_authority', roster.authority_kind,
    'required_counterkey_authority', CASE roster.authority_kind
      WHEN 'advance_clinical' THEN 'advance_technical'
      ELSE 'advance_clinical'
    END,
    'effect_identity', effect_hash
  );
  INSERT INTO public.clinical_continuity_activation_transition_events (
    id, tenant_id, facility_id, action, transition_kind, outcome,
    prior_policy_id, target_policy_id, roster_entry_id, evidence_gate_config_id,
    actor_uid, actor_role, actor_authority_kind, idempotency_key_sha256,
    effect_identity, command_fingerprint, expected_state_fingerprint,
    prior_state, next_state, evidence_references, reason_code, reason_detail,
    request_id, receipt
  ) VALUES (
    event_id, tenant, facility, 'advance', transition_value, 'awaiting_counterkey',
    current_policy, target_policy, roster.id, gate_config, actor, actor_role_value,
    roster.authority_kind, p_command ->> 'idempotency_key_sha256', effect_hash,
    command_hash, p_command ->> 'expected_state_fingerprint', prior_state, next_state,
    evidence_refs, p_command ->> 'reason_code', NULLIF(p_command ->> 'reason_detail', ''),
    NULLIF(p_command ->> 'request_id', ''), stored_receipt
  );
  RETURN stored_receipt;
END;
$$;

CREATE FUNCTION public.clinical_continuity_activation_advance_countersign(p_command JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant UUID := (p_command ->> 'tenant_id')::uuid;
  facility INTEGER := (p_command ->> 'facility_id')::integer;
  actor UUID := (p_command ->> 'actor_uid')::uuid;
  actor_role_value TEXT;
  event_id UUID := (p_command ->> 'event_id')::uuid;
  intent public.clinical_continuity_activation_transition_events%ROWTYPE;
  roster public.clinical_continuity_activation_key_roster%ROWTYPE;
  first_roster public.clinical_continuity_activation_key_roster%ROWTYPE;
  target public.clinical_continuity_policy_versions%ROWTYPE;
  current_state JSONB;
  audit_record public.clinical_audit_events%ROWTYPE;
  command_hash TEXT;
  stored_receipt JSONB;
  existing public.clinical_continuity_activation_transition_events%ROWTYPE;
BEGIN
  PERFORM public.clinical_continuity_activation_assert_context(tenant);
  IF COALESCE(p_command ->> 'idempotency_key_sha256' !~ '^[0-9a-f]{64}$', TRUE)
     OR COALESCE(p_command ->> 'expected_state_fingerprint' !~ '^[0-9a-f]{64}$', TRUE)
     OR p_command ->> 'reason_code' NOT IN (
       'enter_shadow', 'enforcement_evidence_satisfied', 'staged_enforcement_widening'
     )
     OR NULLIF(BTRIM(p_command ->> 'reason_detail'), '') IS NULL
     OR CHAR_LENGTH(BTRIM(p_command ->> 'reason_detail')) NOT BETWEEN 10 AND 500
     OR p_command ->> 'reason_detail' ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'activation countersign command evidence is invalid';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(tenant::text || ':' || facility::text, 632)
  );
  SELECT UPPER(BTRIM(role)) INTO actor_role_value
    FROM public.users
   WHERE tenant_id = tenant AND uid = actor
     AND is_active AND NOT is_deleted AND status = 'active'
     AND UPPER(BTRIM(role)) <> 'PATIENT'
   FOR SHARE;
  IF actor_role_value IS NULL
     OR actor_role_value IS DISTINCT FROM UPPER(BTRIM(p_command ->> 'actor_role')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'current authenticated staff actor required';
  END IF;
  SELECT * INTO existing
    FROM public.clinical_continuity_activation_transition_events AS event
   WHERE event.tenant_id = tenant
     AND event.idempotency_key_sha256 = p_command ->> 'idempotency_key_sha256'
     AND event.outcome = 'applied'
   FOR SHARE;
  IF FOUND THEN
    IF existing.id = event_id
       AND existing.action = 'advance'
       AND existing.actor_uid = actor
       AND existing.intent_event_id = (p_command ->> 'intent_event_id')::uuid
       AND existing.roster_entry_id = (p_command ->> 'roster_entry_id')::uuid
       AND existing.expected_state_fingerprint = p_command ->> 'expected_state_fingerprint'
       AND existing.reason_code = p_command ->> 'reason_code'
       AND existing.reason_detail IS NOT DISTINCT FROM NULLIF(p_command ->> 'reason_detail', '') THEN
      RETURN jsonb_set(existing.receipt, '{disposition}', '"exact_duplicate"'::jsonb);
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'activation countersign idempotency identity drift';
  END IF;
  SELECT * INTO intent
    FROM public.clinical_continuity_activation_transition_events AS event
   WHERE event.tenant_id = tenant
     AND event.facility_id = facility
     AND event.id = (p_command ->> 'intent_event_id')::uuid
     AND event.action = 'advance'
     AND event.outcome = 'awaiting_counterkey'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'advance intent not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.clinical_continuity_activation_transition_events AS applied
     WHERE applied.tenant_id = tenant
       AND applied.intent_event_id = intent.id
       AND applied.outcome = 'applied'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'advance intent already countersigned';
  END IF;
  IF actor = intent.actor_uid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'advance requires two distinct authenticated identities';
  END IF;
  first_roster := public.clinical_continuity_activation_active_roster_entry(
    tenant, facility, intent.roster_entry_id, intent.actor_uid, intent.actor_role
  );
  roster := public.clinical_continuity_activation_active_roster_entry(
    tenant, facility, (p_command ->> 'roster_entry_id')::uuid, actor, actor_role_value
  );
  IF roster.authority_kind IS DISTINCT FROM (CASE first_roster.authority_kind
      WHEN 'advance_clinical' THEN 'advance_technical'
      WHEN 'advance_technical' THEN 'advance_clinical'
      ELSE 'invalid'
    END) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'advance counterkey must be the complementary roster authority';
  END IF;
  IF p_command ->> 'reason_code' IS DISTINCT FROM intent.reason_code
     OR NULLIF(BTRIM(p_command ->> 'reason_detail'), '')
          IS DISTINCT FROM intent.reason_detail THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'advance counterkey must countersign the exact intent reason';
  END IF;
  current_state := public.clinical_continuity_activation_state_snapshot(tenant, facility);
  IF current_state IS DISTINCT FROM intent.prior_state
     OR current_state ->> 'state_fingerprint' IS DISTINCT FROM p_command ->> 'expected_state_fingerprint'
     OR p_command ->> 'expected_state_fingerprint' IS DISTINCT FROM intent.expected_state_fingerprint THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'activation state fingerprint changed';
  END IF;
  SELECT * INTO target
    FROM public.clinical_continuity_policy_versions AS policy
   WHERE policy.tenant_id = tenant
     AND policy.facility_id = facility
     AND policy.id = intent.target_policy_id
     AND policy.lifecycle_state = 'approved'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'advance target is no longer approved';
  END IF;
  IF public.clinical_continuity_activation_evidence_snapshot(
       tenant,
       facility,
       intent.transition_kind,
       CASE
         WHEN intent.transition_kind = 'off_to_shadow' THEN intent.target_policy_id
         WHEN intent.transition_kind = 'shadow_to_active' THEN intent.prior_policy_id
         ELSE (intent.evidence_references #>> '{gate,shadow_policy_id}')::uuid
       END,
       intent.target_policy_id,
       intent.evidence_gate_config_id
     ) IS DISTINCT FROM intent.evidence_references -> 'gate' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'activation evidence gate changed';
  END IF;
  SELECT * INTO audit_record
    FROM public.clinical_audit_events AS audit
   WHERE audit.tenant_id = tenant
     AND audit.id = (p_command ->> 'audit_event_id')::uuid
     AND audit.action = 'clinical_continuity.activation.advance_applied'
     AND audit.action_status = 'success'
     AND audit.actor_uid = actor
     AND UPPER(BTRIM(audit.actor_role)) = actor_role_value
     AND audit.resource_type = 'clinical_continuity_activation_transition_event'
     AND audit.resource_table = 'clinical_continuity_activation_transition_events'
     AND audit.resource_id = event_id::text
     AND audit.after_state ->> 'event_id' = event_id::text
     AND audit.after_state ->> 'intent_event_id' = intent.id::text
     AND audit.after_state ->> 'expected_state_fingerprint' = intent.expected_state_fingerprint
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'advance clinical audit evidence is invalid';
  END IF;
  command_hash := public.clinical_continuity_activation_bound_hash(ARRAY[
    intent.effect_identity, actor::text, actor_role_value, roster.id::text,
    p_command ->> 'reason_code', NULLIF(p_command ->> 'reason_detail', '')
  ]);
  stored_receipt := jsonb_build_object(
    'disposition', 'applied',
    'event_id', event_id,
    'intent_event_id', intent.id,
    'tenant_id', tenant,
    'facility_id', facility,
    'transition_kind', intent.transition_kind,
    'prior_state', intent.prior_state,
    'next_state', intent.next_state,
    'clinical_key_uid', CASE
      WHEN first_roster.authority_kind = 'advance_clinical' THEN intent.actor_uid ELSE actor END,
    'technical_key_uid', CASE
      WHEN first_roster.authority_kind = 'advance_technical' THEN intent.actor_uid ELSE actor END,
    'effect_identity', intent.effect_identity
  );
  INSERT INTO public.clinical_continuity_activation_transition_events (
    id, tenant_id, facility_id, action, transition_kind, outcome, intent_event_id,
    prior_policy_id, target_policy_id, roster_entry_id, evidence_gate_config_id,
    actor_uid, actor_role, actor_authority_kind, idempotency_key_sha256,
    effect_identity, command_fingerprint, expected_state_fingerprint,
    prior_state, next_state, evidence_references, reason_code, reason_detail,
    request_id, clinical_audit_event_id, claim_txid, receipt
  ) VALUES (
    event_id, tenant, facility, 'advance', intent.transition_kind, 'applied', intent.id,
    intent.prior_policy_id, intent.target_policy_id, roster.id, intent.evidence_gate_config_id,
    actor, actor_role_value, roster.authority_kind, p_command ->> 'idempotency_key_sha256',
    intent.effect_identity, command_hash, intent.expected_state_fingerprint,
    intent.prior_state, intent.next_state, intent.evidence_references,
    p_command ->> 'reason_code', NULLIF(p_command ->> 'reason_detail', ''),
    NULLIF(p_command ->> 'request_id', ''), audit_record.id, txid_current(), stored_receipt
  );
  PERFORM set_config('app.clinical_continuity_activation_transition_id', event_id::text, TRUE);
  -- Migration 600's policy triggers predate hardened SECURITY DEFINER paths
  -- and resolve their helper/table names through public. CREATE on public is
  -- revoked above, so expose that trusted schema only for the guarded updates.
  PERFORM set_config('search_path', 'pg_catalog, public, pg_temp', TRUE);
  IF intent.prior_policy_id IS NOT NULL THEN
    UPDATE public.clinical_continuity_policy_versions
       SET lifecycle_state = 'retired',
           retired_by = actor,
           retired_at = clock_timestamp(),
           retirement_reason = COALESCE(
             NULLIF(BTRIM(p_command ->> 'reason_detail'), ''),
             'C-D11 governed activation advance'
           ),
           effective_until = clock_timestamp()
     WHERE tenant_id = tenant
       AND facility_id = facility
       AND id = intent.prior_policy_id
       AND lifecycle_state = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'prior active policy changed';
    END IF;
  END IF;
  UPDATE public.clinical_continuity_policy_versions
     SET lifecycle_state = 'active'
   WHERE tenant_id = tenant
     AND facility_id = facility
     AND id = intent.target_policy_id
     AND lifecycle_state = 'approved';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'target approved policy changed';
  END IF;
  PERFORM set_config('search_path', 'pg_catalog, pg_temp', TRUE);
  IF public.clinical_continuity_activation_state_snapshot(tenant, facility)
       IS DISTINCT FROM intent.next_state THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'applied advance did not produce the bound next state';
  END IF;
  RETURN stored_receipt;
END;
$$;

CREATE FUNCTION public.clinical_continuity_activation_halt(p_command JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant UUID := (p_command ->> 'tenant_id')::uuid;
  facility INTEGER := (p_command ->> 'facility_id')::integer;
  actor UUID := (p_command ->> 'actor_uid')::uuid;
  actor_role_value TEXT;
  event_id UUID := (p_command ->> 'event_id')::uuid;
  roster public.clinical_continuity_activation_key_roster%ROWTYPE;
  prior_state JSONB;
  next_state JSONB;
  current_policy UUID;
  transition_value TEXT;
  effect_hash TEXT;
  command_hash TEXT;
  retirement_reason_value TEXT;
  audit_record public.clinical_audit_events%ROWTYPE;
  stored_receipt JSONB;
  existing public.clinical_continuity_activation_transition_events%ROWTYPE;
BEGIN
  PERFORM public.clinical_continuity_activation_assert_context(tenant);
  PERFORM public.clinical_continuity_activation_assert_evidence_references(
    COALESCE(p_command -> 'evidence_references', '[]'::jsonb), 0
  );
  IF COALESCE(p_command ->> 'idempotency_key_sha256' !~ '^[0-9a-f]{64}$', TRUE)
     OR COALESCE(p_command ->> 'expected_state_fingerprint' !~ '^[0-9a-f]{64}$', TRUE)
     OR p_command ->> 'reason_code' NOT IN (
       'clinical_lead_veto', 'patient_safety_incident', 'silent_failure',
       'unreconciled_window_breach', 'listed_signoff_role_halt'
     )
     OR (
       NULLIF(BTRIM(p_command ->> 'reason_detail'), '') IS NOT NULL
       AND (
         CHAR_LENGTH(BTRIM(p_command ->> 'reason_detail')) NOT BETWEEN 10 AND 500
         OR p_command ->> 'reason_detail' ~ '[[:cntrl:]]'
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'activation halt command evidence is invalid';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(tenant::text || ':' || facility::text, 632)
  );
  SELECT UPPER(BTRIM(role)) INTO actor_role_value
    FROM public.users
   WHERE tenant_id = tenant AND uid = actor
     AND is_active AND NOT is_deleted AND status = 'active'
     AND UPPER(BTRIM(role)) <> 'PATIENT'
   FOR SHARE;
  IF actor_role_value IS NULL
     OR actor_role_value IS DISTINCT FROM UPPER(BTRIM(p_command ->> 'actor_role')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'current authenticated staff actor required';
  END IF;
  SELECT * INTO existing
    FROM public.clinical_continuity_activation_transition_events AS event
   WHERE event.tenant_id = tenant
     AND event.idempotency_key_sha256 = p_command ->> 'idempotency_key_sha256'
     AND event.outcome = 'applied'
   FOR SHARE;
  IF FOUND THEN
    IF existing.id = event_id
       AND existing.action = 'halt'
       AND existing.actor_uid = actor
       AND existing.roster_entry_id = (p_command ->> 'roster_entry_id')::uuid
       AND existing.expected_state_fingerprint = p_command ->> 'expected_state_fingerprint'
       AND existing.reason_code = p_command ->> 'reason_code'
       AND existing.reason_detail IS NOT DISTINCT FROM NULLIF(p_command ->> 'reason_detail', '')
       AND existing.evidence_references
             IS NOT DISTINCT FROM COALESCE(p_command -> 'evidence_references', '[]'::jsonb) THEN
      RETURN jsonb_set(existing.receipt, '{disposition}', '"exact_duplicate"'::jsonb);
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'activation halt idempotency identity drift';
  END IF;
  roster := public.clinical_continuity_activation_active_roster_entry(
    tenant, facility, (p_command ->> 'roster_entry_id')::uuid, actor, actor_role_value
  );
  IF roster.authority_kind NOT IN ('rollback_signoff', 'affected_unit_clinical_lead') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'halt requires one listed rollback roster identity';
  END IF;
  prior_state := public.clinical_continuity_activation_state_snapshot(tenant, facility);
  IF prior_state ->> 'state' = 'off' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'activation is already off';
  END IF;
  IF prior_state ->> 'state_fingerprint' IS DISTINCT FROM p_command ->> 'expected_state_fingerprint' THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'activation state fingerprint changed';
  END IF;
  current_policy := (prior_state ->> 'policy_id')::uuid;
  next_state := public.clinical_continuity_activation_projected_state(tenant, facility, NULL);
  transition_value := CASE prior_state ->> 'state'
    WHEN 'shadow' THEN 'shadow_to_off'
    ELSE 'active_to_off'
  END;
  effect_hash := public.clinical_continuity_activation_bound_hash(ARRAY[
    'halt', tenant::text, facility::text, transition_value, current_policy::text,
    p_command ->> 'expected_state_fingerprint',
    COALESCE(p_command -> 'evidence_references', '[]'::jsonb)::text
  ]);
  command_hash := public.clinical_continuity_activation_bound_hash(ARRAY[
    effect_hash, actor::text, actor_role_value, roster.id::text,
    p_command ->> 'reason_code', NULLIF(p_command ->> 'reason_detail', '')
  ]);
  SELECT * INTO audit_record
    FROM public.clinical_audit_events AS audit
   WHERE audit.tenant_id = tenant
     AND audit.id = (p_command ->> 'audit_event_id')::uuid
     AND audit.action = 'clinical_continuity.activation.halt_applied'
     AND audit.action_status = 'success'
     AND audit.actor_uid = actor
     AND UPPER(BTRIM(audit.actor_role)) = actor_role_value
     AND audit.resource_type = 'clinical_continuity_activation_transition_event'
     AND audit.resource_table = 'clinical_continuity_activation_transition_events'
     AND audit.resource_id = event_id::text
     AND audit.after_state ->> 'event_id' = event_id::text
     AND audit.after_state ->> 'expected_state_fingerprint' = p_command ->> 'expected_state_fingerprint'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'halt clinical audit evidence is invalid';
  END IF;
  retirement_reason_value := COALESCE(
    NULLIF(BTRIM(p_command ->> 'reason_detail'), ''),
    'C-D11 unilateral halt: ' || (p_command ->> 'reason_code')
  );
  stored_receipt := jsonb_build_object(
    'disposition', 'applied',
    'event_id', event_id,
    'tenant_id', tenant,
    'facility_id', facility,
    'transition_kind', transition_value,
    'prior_state', prior_state,
    'next_state', next_state,
    'halt_authority_kind', roster.authority_kind,
    'affected_unit_reference', roster.affected_unit_reference,
    'effect_identity', effect_hash
  );
  INSERT INTO public.clinical_continuity_activation_transition_events (
    id, tenant_id, facility_id, action, transition_kind, outcome,
    prior_policy_id, roster_entry_id, actor_uid, actor_role, actor_authority_kind,
    idempotency_key_sha256, effect_identity, command_fingerprint,
    expected_state_fingerprint, prior_state, next_state, evidence_references,
    reason_code, reason_detail, request_id, clinical_audit_event_id, claim_txid, receipt
  ) VALUES (
    event_id, tenant, facility, 'halt', transition_value, 'applied', current_policy,
    roster.id, actor, actor_role_value, roster.authority_kind,
    p_command ->> 'idempotency_key_sha256', effect_hash, command_hash,
    p_command ->> 'expected_state_fingerprint', prior_state, next_state,
    COALESCE(p_command -> 'evidence_references', '[]'::jsonb),
    p_command ->> 'reason_code', NULLIF(p_command ->> 'reason_detail', ''),
    NULLIF(p_command ->> 'request_id', ''), audit_record.id, txid_current(), stored_receipt
  );
  PERFORM set_config('app.clinical_continuity_activation_transition_id', event_id::text, TRUE);
  -- See the advance path: migration 600's retirement trigger has one legacy
  -- unqualified public.users lookup, within this otherwise hardened command.
  PERFORM set_config('search_path', 'pg_catalog, public, pg_temp', TRUE);
  UPDATE public.clinical_continuity_policy_versions
     SET lifecycle_state = 'retired',
         retired_by = actor,
         retired_at = clock_timestamp(),
         retirement_reason = retirement_reason_value,
         effective_until = clock_timestamp()
   WHERE tenant_id = tenant
     AND facility_id = facility
     AND id = current_policy
     AND lifecycle_state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'active policy changed before halt';
  END IF;
  PERFORM set_config('search_path', 'pg_catalog, pg_temp', TRUE);
  IF public.clinical_continuity_activation_state_snapshot(tenant, facility)
       IS DISTINCT FROM next_state THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'applied halt did not produce off state';
  END IF;
  RETURN stored_receipt;
END;
$$;

CREATE FUNCTION public.clinical_continuity_activation_policy_transition_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  transition_id UUID := NULLIF(
    current_setting('app.clinical_continuity_activation_transition_id', true), ''
  )::uuid;
  transition public.clinical_continuity_activation_transition_events%ROWTYPE;
  relation_owner NAME;
BEGIN
  IF current_setting('app.clinical_continuity_activation_bypass', true) = 'migration_or_test' THEN
    SELECT pg_catalog.pg_get_userbyid(class.relowner) INTO relation_owner
      FROM pg_catalog.pg_class AS class
     WHERE class.oid = TG_RELID;
    IF current_user = relation_owner THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NOT (
    (OLD.lifecycle_state = 'approved' AND NEW.lifecycle_state = 'active')
    OR (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state = 'retired')
  ) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO transition
    FROM public.clinical_continuity_activation_transition_events AS event
   WHERE event.tenant_id = NEW.tenant_id
     AND event.id = transition_id
     AND event.facility_id = NEW.facility_id
     AND event.outcome = 'applied'
     AND event.claim_txid = txid_current()
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'policy activation transition requires an applied C6.3-TG command';
  END IF;
  IF OLD.lifecycle_state = 'approved'
     AND (transition.action <> 'advance' OR transition.target_policy_id IS DISTINCT FROM NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'policy activation is not bound to the applied advance';
  END IF;
  IF OLD.lifecycle_state = 'active'
     AND (
       transition.action NOT IN ('advance', 'halt')
       OR transition.prior_policy_id IS DISTINCT FROM OLD.id
       OR NEW.retired_by IS DISTINCT FROM transition.actor_uid
       OR NEW.retirement_reason IS DISTINCT FROM COALESCE(
         transition.reason_detail,
         CASE transition.action
           WHEN 'halt' THEN 'C-D11 unilateral halt: ' || transition.reason_code
           ELSE 'C-D11 governed activation advance'
         END
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'policy retirement is not bound to the applied transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cc_activation_policy_transition_guard
BEFORE UPDATE ON public.clinical_continuity_policy_versions
FOR EACH ROW EXECUTE FUNCTION public.clinical_continuity_activation_policy_transition_guard();

REVOKE ALL PRIVILEGES ON TABLE
  public.clinical_continuity_activation_key_roster,
  public.clinical_continuity_activation_evidence_gate_configs,
  public.clinical_continuity_activation_transition_events
FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_append_only() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_owner_insert() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_roster_shape_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_gate_shape_guard() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_bound_hash(TEXT[]) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_assert_evidence_references(JSONB, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_assert_context(UUID) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_projected_state(UUID, INTEGER, UUID) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_state_snapshot(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_active_roster_entry(UUID, INTEGER, UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_evidence_snapshot(UUID, INTEGER, TEXT, UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_advance_intent(JSONB) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_advance_countersign(JSONB) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_halt(JSONB) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.clinical_continuity_activation_policy_transition_guard() FROM PUBLIC;

DO $cc_activation_runtime_privileges$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE FORMAT('REVOKE CREATE ON SCHEMA public FROM %I', role_name);
    EXECUTE FORMAT('GRANT USAGE ON SCHEMA public TO %I', role_name);
    EXECUTE FORMAT(
      'GRANT SELECT ON TABLE '
      'public.clinical_continuity_activation_key_roster, '
      'public.clinical_continuity_activation_evidence_gate_configs, '
      'public.clinical_continuity_activation_transition_events TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE '
      'public.clinical_continuity_activation_key_roster, '
      'public.clinical_continuity_activation_evidence_gate_configs, '
      'public.clinical_continuity_activation_transition_events, '
      'public.clinical_continuity_policy_versions FROM %I',
      role_name
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION '
      'public.clinical_continuity_activation_state_snapshot(UUID, INTEGER), '
      'public.clinical_continuity_activation_advance_intent(JSONB), '
      'public.clinical_continuity_activation_advance_countersign(JSONB), '
      'public.clinical_continuity_activation_halt(JSONB) TO %I',
      role_name
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION '
      'public.clinical_continuity_activation_append_only(), '
      'public.clinical_continuity_activation_owner_insert(), '
      'public.clinical_continuity_activation_roster_shape_guard(), '
      'public.clinical_continuity_activation_gate_shape_guard(), '
      'public.clinical_continuity_activation_bound_hash(TEXT[]), '
      'public.clinical_continuity_activation_assert_evidence_references(JSONB, INTEGER), '
      'public.clinical_continuity_activation_assert_context(UUID), '
      'public.clinical_continuity_activation_projected_state(UUID, INTEGER, UUID), '
      'public.clinical_continuity_activation_active_roster_entry(UUID, INTEGER, UUID, UUID, TEXT), '
      'public.clinical_continuity_activation_evidence_snapshot(UUID, INTEGER, TEXT, UUID, UUID, UUID), '
      'public.clinical_continuity_activation_policy_transition_guard() FROM %I',
      role_name
    );
  END LOOP;
END
$cc_activation_runtime_privileges$;

COMMENT ON TABLE public.clinical_continuity_activation_key_roster IS
  'Append-only, owner-provisioned C-D11 advance and unilateral-halt identity roster; intentionally empty at migration 632.';
COMMENT ON TABLE public.clinical_continuity_activation_evidence_gate_configs IS
  'Versioned per-facility enforcement evidence gates with the immutable C-D11 floor of 14 shadow days AND one clean planned drill.';
COMMENT ON TABLE public.clinical_continuity_activation_transition_events IS
  'Append-only authenticated C6.3 transition intent, countersign, halt, CAS, evidence, and clinical-audit ledger.';

COMMIT;
