-- 768_reprocessable_devices_platform.sql
--
-- Plan 4 schema foundation for the shared dialysis/OT reprocessable-device
-- platform. Protocols are immutable revisions with explicit manufacturer/model
-- applicability. Availability is obligation-based, the device register is
-- marker-free, and patient linkage lives only on usage/evidence relations.
-- This migration does not alter dialysis_patients, patient_bloodborne_markers,
-- or cath_reprocessable_devices. Existing baseline relations are ALTER-only.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

CREATE UNIQUE INDEX IF NOT EXISTS ux_dialysis_sessions_tenant_id
  ON public.dialysis_sessions (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ot_schedules_tenant_id
  ON public.ot_schedules (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ot_schedules_tenant_id_patient
  ON public.ot_schedules (tenant_id, id, patient_uid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_instrument_sets_tenant_id
  ON public.instrument_sets (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sterilization_loads_tenant_id
  ON public.sterilization_loads (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_set_issue_log_tenant_id
  ON public.set_issue_log (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_set_issue_log_tenant_id_set
  ON public.set_issue_log (tenant_id, id, instrument_set_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_set_issue_log_tenant_id_schedule
  ON public.set_issue_log (tenant_id, id, ot_schedule_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_clinical_ai_biomed_devices_tenant_id
  ON public.clinical_ai_biomed_devices (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_dialyzer_reuse_register_tenant_id
  ON public.dialyzer_reuse_register (tenant_id, id);

CREATE TABLE public.reprocessing_protocols (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  protocol_key UUID NOT NULL,
  revision INTEGER NOT NULL,
  supersedes_protocol_id INTEGER,
  domain VARCHAR(16) NOT NULL,
  category VARCHAR(40),
  name VARCHAR(160) NOT NULL,
  basis VARCHAR(24) NOT NULL,
  reference TEXT NOT NULL,
  approved_by UUID NOT NULL,
  approved_role VARCHAR(50) NOT NULL,
  approved_at TIMESTAMPTZ(6) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  retired_at TIMESTAMPTZ(6),
  retired_by UUID,
  tcv_min_pct INTEGER,
  baseline_tcv_required BOOLEAN NOT NULL DEFAULT TRUE,
  mid_life_enrolment_rule VARCHAR(40) NOT NULL DEFAULT 'refuse',
  residual_test_required BOOLEAN NOT NULL DEFAULT TRUE,
  integrity_test_required BOOLEAN NOT NULL DEFAULT TRUE,
  agents JSONB NOT NULL DEFAULT '[]'::jsonb,
  reuse_matrix JSONB,
  surveillance_intervals_days JSONB NOT NULL DEFAULT '{"hbsag":90,"hcv":90,"hiv":365}'::jsonb,
  surveillance_overdue_blocks_reuse BOOLEAN NOT NULL DEFAULT TRUE,
  prion_rule VARCHAR(16) NOT NULL DEFAULT 'discard',
  notes TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_by UUID,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_reprocessing_protocols_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_reprocessing_protocols_key_revision UNIQUE (tenant_id, protocol_key, revision),
  CONSTRAINT fk_reprocessing_protocols_supersedes FOREIGN KEY (tenant_id, supersedes_protocol_id)
    REFERENCES public.reprocessing_protocols (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reprocessing_protocols_revision_check CHECK (revision >= 1),
  CONSTRAINT reprocessing_protocols_domain_check CHECK (domain IN ('dialysis', 'ot')),
  CONSTRAINT reprocessing_protocols_category_check CHECK (
    category IS NULL OR (domain = 'dialysis' AND category = 'dialyser')
    OR (domain = 'ot' AND category IN ('instrument_set', 'tray', 'implant_set', 'procedure_pack', 'other'))
  ),
  CONSTRAINT reprocessing_protocols_basis_check
    CHECK (basis IN ('manufacturer_ifu', 'national_guideline', 'institutional')),
  CONSTRAINT reprocessing_protocols_approved_role_check
    CHECK (approved_role IN ('INFECTION_CONTROL_OFFICER', 'CONSULTANT', 'ADMIN', 'SUPER_ADMIN')),
  CONSTRAINT reprocessing_protocols_status_check CHECK (status IN ('active', 'retired')),
  CONSTRAINT reprocessing_protocols_retired_check CHECK (
    (status = 'active' AND retired_at IS NULL AND retired_by IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL AND retired_by IS NOT NULL)
  ),
  CONSTRAINT reprocessing_protocols_tcv_check
    CHECK (tcv_min_pct IS NULL OR (domain = 'dialysis' AND tcv_min_pct BETWEEN 80 AND 100)),
  CONSTRAINT reprocessing_protocols_mid_life_check
    CHECK (mid_life_enrolment_rule IN ('refuse', 'validated_model_baseline')),
  CONSTRAINT reprocessing_protocols_agents_check CHECK (jsonb_typeof(agents) = 'array'),
  CONSTRAINT reprocessing_protocols_reuse_matrix_domain_check CHECK (
    (
      domain = 'dialysis'
      AND reuse_matrix IS NOT NULL
      AND jsonb_typeof(reuse_matrix) = 'object'
      AND reuse_matrix - ARRAY['hbsag', 'hcv', 'hiv', 'isolation_mixed'] = '{}'::jsonb
      AND reuse_matrix ?& ARRAY['hbsag', 'hcv', 'hiv', 'isolation_mixed']
      AND jsonb_array_length(jsonb_path_query_array(reuse_matrix, '$.keyvalue()')) = 4
      AND reuse_matrix->'hbsag' <> 'null'::jsonb
      AND reuse_matrix->'hcv' <> 'null'::jsonb
      AND reuse_matrix->'hiv' <> 'null'::jsonb
      AND reuse_matrix->'isolation_mixed' <> 'null'::jsonb
      AND (
        reuse_matrix->>'hbsag' = 'no_reuse'
        AND reuse_matrix->>'hiv' = 'no_reuse'
        AND reuse_matrix->>'isolation_mixed' = 'no_reuse'
        AND reuse_matrix->>'hcv' IN ('no_reuse', 'dedicated_reuse')
      ) IS TRUE
    ) OR (domain = 'ot' AND reuse_matrix IS NULL)
  ),
  CONSTRAINT reprocessing_protocols_surveillance_check
    CHECK (jsonb_typeof(surveillance_intervals_days) = 'object'),
  CONSTRAINT reprocessing_protocols_prion_rule_check CHECK (prion_rule IN ('discard', 'ic_pathway'))
);

CREATE TABLE public.reprocessing_protocol_device_scopes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  protocol_id INTEGER NOT NULL,
  category VARCHAR(40) NOT NULL,
  manufacturer VARCHAR(120) NOT NULL,
  model_name VARCHAR(120) NOT NULL,
  ifu_reference TEXT NOT NULL,
  nominal_tcv_ml NUMERIC(6,1),
  single_use BOOLEAN NOT NULL DEFAULT FALSE,
  approved_at TIMESTAMPTZ(6) NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_reprocessing_protocol_device_scopes_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_reprocessing_protocol_device_scopes_protocol FOREIGN KEY (tenant_id, protocol_id)
    REFERENCES public.reprocessing_protocols (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reprocessing_protocol_device_scopes_category_check CHECK (
    category IN ('dialyser', 'instrument_set', 'tray', 'implant_set', 'procedure_pack', 'other')
  ),
  CONSTRAINT reprocessing_protocol_device_scopes_identity_check
    CHECK (btrim(manufacturer) <> '' AND btrim(model_name) <> '' AND btrim(ifu_reference) <> ''),
  CONSTRAINT reprocessing_protocol_device_scopes_single_use_check CHECK (single_use = FALSE),
  CONSTRAINT reprocessing_protocol_device_scopes_nominal_tcv_check
    CHECK (nominal_tcv_ml IS NULL OR nominal_tcv_ml > 0)
);

CREATE TABLE public.reprocessing_isolation_setting_revisions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  supersedes_revision_id BIGINT,
  approved_isolation_groups TEXT[] NOT NULL,
  isolation_groups JSONB NOT NULL,
  vocabulary_approved_by UUID NOT NULL,
  vocabulary_approved_role VARCHAR(50) NOT NULL,
  vocabulary_approved_at TIMESTAMPTZ(6) NOT NULL,
  mapping_approved_by UUID NOT NULL,
  mapping_approved_role VARCHAR(50) NOT NULL,
  mapping_approved_at TIMESTAMPTZ(6) NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_reprocessing_isolation_revisions_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_reprocessing_isolation_revisions_revision UNIQUE (tenant_id, revision),
  CONSTRAINT fk_reprocessing_isolation_revisions_supersedes FOREIGN KEY (tenant_id, supersedes_revision_id)
    REFERENCES public.reprocessing_isolation_setting_revisions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reprocessing_isolation_revisions_revision_check CHECK (revision >= 1),
  CONSTRAINT reprocessing_isolation_revisions_groups_check
    CHECK (cardinality(approved_isolation_groups) >= 1),
  CONSTRAINT reprocessing_isolation_revisions_mapping_check CHECK (
    jsonb_typeof(isolation_groups) = 'object'
    AND isolation_groups - ARRAY['hbsag', 'hcv', 'hiv', 'isolation_mixed'] = '{}'::jsonb
    AND isolation_groups ?& ARRAY['hbsag', 'hcv', 'hiv', 'isolation_mixed']
    AND jsonb_array_length(jsonb_path_query_array(isolation_groups, '$.keyvalue()')) = 4
  ),
  CONSTRAINT reprocessing_isolation_revisions_vocabulary_role_check
    CHECK (vocabulary_approved_role = 'INFECTION_CONTROL_OFFICER'),
  CONSTRAINT reprocessing_isolation_revisions_mapping_role_check
    CHECK (mapping_approved_role = 'INFECTION_CONTROL_OFFICER')
);

CREATE TABLE public.reprocessing_domain_settings (
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL,
  reactive_patient_rule VARCHAR(24) NOT NULL,
  unknown_serology_rule VARCHAR(24) NOT NULL DEFAULT 'warn',
  serology_validity_days INTEGER NOT NULL DEFAULT 90,
  isolation_enforcement VARCHAR(8) NOT NULL DEFAULT 'warn',
  isolation_revision_id BIGINT,
  isolation_applied_by UUID,
  isolation_applied_role VARCHAR(50),
  isolation_applied_at TIMESTAMPTZ(6),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ(6),
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT reprocessing_domain_settings_pkey PRIMARY KEY (tenant_id, domain),
  CONSTRAINT fk_reprocessing_domain_settings_isolation_revision FOREIGN KEY (tenant_id, isolation_revision_id)
    REFERENCES public.reprocessing_isolation_setting_revisions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reprocessing_domain_settings_domain_check CHECK (domain IN ('dialysis', 'ot')),
  CONSTRAINT reprocessing_domain_settings_reactive_rule_check
    CHECK (reactive_patient_rule IN ('discard', 'quarantine', 'override_allowed')),
  CONSTRAINT reprocessing_domain_settings_unknown_rule_check
    CHECK (unknown_serology_rule IN ('warn', 'block_return')),
  CONSTRAINT reprocessing_domain_settings_validity_check CHECK (serology_validity_days BETWEEN 1 AND 365),
  CONSTRAINT reprocessing_domain_settings_isolation_enforcement_check
    CHECK (isolation_enforcement IN ('warn', 'block')),
  CONSTRAINT reprocessing_domain_settings_isolation_domain_check
    CHECK (domain = 'dialysis' OR isolation_enforcement = 'warn'),
  CONSTRAINT reprocessing_domain_settings_isolation_revision_domain_check
    CHECK (domain = 'dialysis' OR isolation_revision_id IS NULL),
  CONSTRAINT reprocessing_domain_settings_isolation_applied_check CHECK (
    num_nonnulls(isolation_applied_by, isolation_applied_role, isolation_applied_at) IN (0, 3)
  ),
  CONSTRAINT reprocessing_domain_settings_isolation_applied_role_check CHECK (
    isolation_applied_role IS NULL OR isolation_applied_role IN ('INFECTION_CONTROL_OFFICER', 'ADMIN', 'SUPER_ADMIN')
  )
);

CREATE TABLE public.reprocessing_domain_policies (
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL,
  category VARCHAR(40) NOT NULL,
  reprocessable BOOLEAN NOT NULL DEFAULT FALSE,
  max_cycles INTEGER,
  allowed_cycle_types TEXT[] NOT NULL DEFAULT '{}'::text[],
  function_check_required BOOLEAN NOT NULL DEFAULT FALSE,
  tcv_min_pct INTEGER,
  protocol_id INTEGER,
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT reprocessing_domain_policies_pkey PRIMARY KEY (tenant_id, domain, category),
  CONSTRAINT fk_reprocessing_domain_policies_protocol FOREIGN KEY (tenant_id, protocol_id)
    REFERENCES public.reprocessing_protocols (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reprocessing_domain_policies_domain_check CHECK (domain IN ('dialysis', 'ot')),
  CONSTRAINT reprocessing_domain_policies_category_check CHECK (
    (domain = 'dialysis' AND category = 'dialyser')
    OR (domain = 'ot' AND category IN ('instrument_set', 'tray', 'implant_set', 'procedure_pack', 'other'))
  ),
  CONSTRAINT reprocessing_domain_policies_procedure_pack_check
    CHECK (NOT (category = 'procedure_pack' AND reprocessable)),
  CONSTRAINT reprocessing_domain_policies_max_cycles_check CHECK (max_cycles IS NULL OR max_cycles BETWEEN 1 AND 100),
  CONSTRAINT reprocessing_domain_policies_cycle_types_check CHECK (
    allowed_cycle_types <@ ARRAY['steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other']::text[]
  ),
  CONSTRAINT reprocessing_domain_policies_dialysis_cycle_type_check CHECK (
    domain <> 'dialysis' OR allowed_cycle_types <@ ARRAY['chemical', 'other']::text[]
  ),
  CONSTRAINT reprocessing_domain_policies_ot_function_check_check
    CHECK (domain <> 'ot' OR function_check_required = FALSE),
  CONSTRAINT reprocessing_domain_policies_tcv_check
    CHECK (tcv_min_pct IS NULL OR (domain = 'dialysis' AND tcv_min_pct BETWEEN 80 AND 100)),
  CONSTRAINT reprocessing_domain_policies_protocol_check CHECK (reprocessable = FALSE OR protocol_id IS NOT NULL),
  CONSTRAINT reprocessing_domain_policies_complete_check
    CHECK (reprocessable = FALSE OR cardinality(allowed_cycle_types) >= 1)
);

CREATE TABLE public.reprocessable_devices (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL,
  category VARCHAR(40) NOT NULL,
  facility_id INTEGER,
  device_tag VARCHAR(24) GENERATED ALWAYS AS ('RD' || lpad(id::text, GREATEST(8, length(id::text)), '0')) STORED,
  manufacturer_serial VARCHAR(120),
  hospital_asset_id VARCHAR(120),
  manufacturer VARCHAR(120) NOT NULL,
  model_name VARCHAR(120) NOT NULL,
  protocol_device_scope_id BIGINT NOT NULL,
  instrument_set_id BIGINT,
  enrolled_via VARCHAR(24) NOT NULL,
  cycle_count INTEGER NOT NULL DEFAULT 0,
  max_cycles_snapshot INTEGER,
  status VARCHAR(32) NOT NULL DEFAULT 'available',
  current_usage_id BIGINT,
  exposure_flag BOOLEAN NOT NULL DEFAULT FALSE,
  last_reprocessed_at TIMESTAMPTZ(6),
  last_reprocessed_by UUID,
  last_cycle_type VARCHAR(20),
  last_function_check VARCHAR(16),
  last_sterilization_load_id BIGINT,
  last_processing_event_id BIGINT,
  residual_test_pending BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 0,
  quarantine_reason VARCHAR(40),
  quarantined_at TIMESTAMPTZ(6),
  discard_reason VARCHAR(40),
  discard_note TEXT,
  discarded_at TIMESTAMPTZ(6),
  discarded_by UUID,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ux_reprocessable_devices_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_reprocessable_devices_tenant_id_domain UNIQUE (tenant_id, id, domain),
  CONSTRAINT ux_reprocessable_devices_tenant_id_set UNIQUE (tenant_id, id, instrument_set_id),
  CONSTRAINT fk_reprocessable_devices_facility FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_devices_protocol_scope FOREIGN KEY (tenant_id, protocol_device_scope_id)
    REFERENCES public.reprocessing_protocol_device_scopes (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_devices_instrument_set FOREIGN KEY (tenant_id, instrument_set_id)
    REFERENCES public.instrument_sets (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_devices_last_load FOREIGN KEY (tenant_id, last_sterilization_load_id)
    REFERENCES public.sterilization_loads (tenant_id, id) ON DELETE SET NULL (last_sterilization_load_id),
  CONSTRAINT reprocessable_devices_domain_check CHECK (domain IN ('dialysis', 'ot')),
  CONSTRAINT reprocessable_devices_category_check CHECK (
    (domain = 'dialysis' AND category = 'dialyser')
    OR (domain = 'ot' AND category IN ('instrument_set', 'tray', 'implant_set', 'procedure_pack', 'other'))
  ),
  CONSTRAINT reprocessable_devices_identity_check CHECK (
    ((domain = 'ot') = (instrument_set_id IS NOT NULL))
    AND (domain <> 'dialysis' OR manufacturer_serial IS NOT NULL)
  ),
  CONSTRAINT reprocessable_devices_enrolled_via_check
    CHECK (enrolled_via IN ('session_capture', 'set_issue', 'console')),
  CONSTRAINT reprocessable_devices_cycle_check CHECK (cycle_count >= 0),
  CONSTRAINT reprocessable_devices_max_cycles_check CHECK (max_cycles_snapshot IS NULL OR max_cycles_snapshot >= 1),
  CONSTRAINT reprocessable_devices_cycle_bound_check CHECK (max_cycles_snapshot IS NULL OR cycle_count <= max_cycles_snapshot),
  CONSTRAINT reprocessable_devices_status_check CHECK (
    status IN ('awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined', 'discarded')
  ),
  CONSTRAINT reprocessable_devices_in_case_check CHECK ((status = 'in_case') = (current_usage_id IS NOT NULL)),
  CONSTRAINT reprocessable_devices_cycle_type_check CHECK (
    last_cycle_type IS NULL OR last_cycle_type IN ('steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other')
  ),
  CONSTRAINT reprocessable_devices_function_check_check
    CHECK (last_function_check IS NULL OR last_function_check IN ('not_required', 'pass', 'fail')),
  CONSTRAINT reprocessable_devices_load_domain_check CHECK (domain = 'ot' OR last_sterilization_load_id IS NULL),
  CONSTRAINT reprocessable_devices_quarantine_reason_check CHECK (
    quarantine_reason IS NULL OR quarantine_reason IN (
      'exposure_hold', 'prion_hold', 'sterilization_failed', 'load_invalidated', 'serology_required',
      'post_issue_restriction', 'cycle_type_not_allowed', 'inspection_failed', 'release_pending_processing', 'manual'
    )
  ),
  CONSTRAINT reprocessable_devices_discard_reason_check CHECK (
    discard_reason IS NULL OR discard_reason IN (
      'max_cycles_reached', 'bloodborne_exposure', 'late_reactive_marker', 'function_check_failed',
      'sterilization_failed', 'damaged', 'wasted', 'policy_change', 'other',
      'tcv_below_threshold', 'integrity_test_failed', 'set_retired'
    )
  ),
  CONSTRAINT reprocessable_devices_discarded_check
    CHECK (status <> 'discarded' OR (discard_reason IS NOT NULL AND discarded_at IS NOT NULL))
);

CREATE UNIQUE INDEX ux_reprocessable_devices_tag ON public.reprocessable_devices (tenant_id, device_tag);
CREATE UNIQUE INDEX ux_reprocessable_devices_serial ON public.reprocessable_devices (tenant_id, domain, manufacturer_serial)
  WHERE manufacturer_serial IS NOT NULL;
CREATE UNIQUE INDEX ux_reprocessable_devices_asset ON public.reprocessable_devices (tenant_id, domain, hospital_asset_id)
  WHERE hospital_asset_id IS NOT NULL;
CREATE UNIQUE INDEX ux_reprocessable_devices_instrument_set ON public.reprocessable_devices (tenant_id, instrument_set_id)
  WHERE instrument_set_id IS NOT NULL;
CREATE INDEX idx_reprocessable_devices_domain_status ON public.reprocessable_devices (tenant_id, domain, status);
CREATE INDEX idx_reprocessable_devices_facility_status ON public.reprocessable_devices (tenant_id, facility_id, status)
  WHERE facility_id IS NOT NULL;

CREATE TABLE public.reprocessable_device_usages (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL,
  device_id BIGINT NOT NULL,
  patient_uid UUID NOT NULL,
  dialysis_session_id INTEGER,
  ot_schedule_id INTEGER,
  instrument_set_id BIGINT,
  set_issue_log_id BIGINT,
  ready_processing_event_id BIGINT,
  post_use_processing_event_id BIGINT,
  reuse_cycle INTEGER NOT NULL,
  captured_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  captured_by UUID NOT NULL,
  capture_source VARCHAR(24) NOT NULL,
  capture_provenance VARCHAR(16) NOT NULL DEFAULT 'live',
  actual_use_started_at TIMESTAMPTZ(6),
  pre_use_residual_test VARCHAR(16),
  unopened_confirmation VARCHAR(24),
  reuse_screen JSONB,
  post_use_screen JSONB,
  post_use_disposition VARCHAR(40),
  returned_at TIMESTAMPTZ(6),
  returned_by UUID,
  acknowledgement_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_reprocessable_device_usages_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_reprocessable_device_usages_tenant_device UNIQUE (tenant_id, id, device_id),
  CONSTRAINT ux_reprocessable_device_usages_tenant_session UNIQUE (tenant_id, id, dialysis_session_id),
  CONSTRAINT fk_reprocessable_device_usages_device FOREIGN KEY (tenant_id, device_id, domain)
    REFERENCES public.reprocessable_devices (tenant_id, id, domain) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_device_usages_patient FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES public.users (tenant_id, uid) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_reprocessable_device_usages_dialysis_session FOREIGN KEY (tenant_id, dialysis_session_id)
    REFERENCES public.dialysis_sessions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_device_usages_ot_schedule FOREIGN KEY (tenant_id, ot_schedule_id, patient_uid)
    REFERENCES public.ot_schedules (tenant_id, id, patient_uid) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_reprocessable_device_usages_device_set FOREIGN KEY (tenant_id, device_id, instrument_set_id)
    REFERENCES public.reprocessable_devices (tenant_id, id, instrument_set_id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_device_usages_issue_set FOREIGN KEY (tenant_id, set_issue_log_id, instrument_set_id)
    REFERENCES public.set_issue_log (tenant_id, id, instrument_set_id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_device_usages_issue FOREIGN KEY (tenant_id, set_issue_log_id)
    REFERENCES public.set_issue_log (tenant_id, id) ON DELETE SET NULL (set_issue_log_id),
  CONSTRAINT fk_reprocessable_device_usages_issue_schedule FOREIGN KEY (tenant_id, set_issue_log_id, ot_schedule_id)
    REFERENCES public.set_issue_log (tenant_id, id, ot_schedule_id) ON DELETE RESTRICT,
  CONSTRAINT reprocessable_device_usages_domain_check CHECK (domain IN ('dialysis', 'ot')),
  CONSTRAINT reprocessable_device_usages_reuse_cycle_check CHECK (reuse_cycle >= 0),
  CONSTRAINT reprocessable_device_usages_capture_source_check
    CHECK (capture_source IN ('staff_app', 'admin_console', 'cssd_issue', 'system')),
  CONSTRAINT reprocessable_device_usages_capture_provenance_check
    CHECK (capture_provenance IN ('live', 'retrospective')),
  CONSTRAINT reprocessable_device_usages_residual_check
    CHECK (pre_use_residual_test IS NULL OR pre_use_residual_test IN ('negative', 'not_required')),
  CONSTRAINT reprocessable_device_usages_unopened_check
    CHECK (unopened_confirmation IS NULL OR unopened_confirmation IN ('sealed_unopened', 'not_connected')),
  CONSTRAINT reprocessable_device_usages_post_use_check CHECK (
    post_use_disposition IS NULL OR post_use_disposition IN (
      'sent_for_reprocessing', 'released_not_established', 'quarantined_bloodborne_exposure',
      'quarantined_serology_required', 'quarantined_post_issue_restriction',
      'quarantined_inspection_failed', 'quarantined_other', 'discarded_bloodborne_exposure',
      'discarded_max_cycles', 'discarded_integrity_failed', 'discarded_tcv_below_threshold',
      'discarded_other', 'cancelled_before_use'
    )
  ),
  CONSTRAINT reprocessable_device_usages_returned_check
    CHECK ((post_use_disposition IS NULL) = (returned_at IS NULL)),
  CONSTRAINT reprocessable_device_usages_owner_check CHECK (num_nonnulls(dialysis_session_id, ot_schedule_id) = 1),
  CONSTRAINT reprocessable_device_usages_owner_domain_check CHECK (
    ((domain = 'dialysis') = (dialysis_session_id IS NOT NULL))
    AND ((domain = 'ot') = (ot_schedule_id IS NOT NULL))
  ),
  CONSTRAINT reprocessable_device_usages_ot_links_check CHECK (
    domain = 'ot' OR (set_issue_log_id IS NULL AND instrument_set_id IS NULL)
  ),
  CONSTRAINT reprocessable_device_usages_ot_set_check CHECK (domain <> 'ot' OR instrument_set_id IS NOT NULL)
);

CREATE UNIQUE INDEX ux_reprocessable_device_usages_cycle
  ON public.reprocessable_device_usages (tenant_id, device_id, reuse_cycle)
  WHERE post_use_disposition IS DISTINCT FROM 'cancelled_before_use';
CREATE UNIQUE INDEX ux_reprocessable_device_usages_open
  ON public.reprocessable_device_usages (tenant_id, device_id) WHERE returned_at IS NULL;
CREATE UNIQUE INDEX ux_reprocessable_device_usages_dialysis_session
  ON public.reprocessable_device_usages (tenant_id, dialysis_session_id) WHERE dialysis_session_id IS NOT NULL;
CREATE UNIQUE INDEX ux_reprocessable_device_usages_issue
  ON public.reprocessable_device_usages (tenant_id, set_issue_log_id) WHERE set_issue_log_id IS NOT NULL;
CREATE INDEX idx_reprocessable_device_usages_patient
  ON public.reprocessable_device_usages (tenant_id, patient_uid, captured_at DESC);
CREATE INDEX idx_reprocessable_device_usages_schedule
  ON public.reprocessable_device_usages (tenant_id, ot_schedule_id) WHERE ot_schedule_id IS NOT NULL;
CREATE INDEX idx_reprocessable_device_usages_ready_event
  ON public.reprocessable_device_usages (tenant_id, ready_processing_event_id) WHERE ready_processing_event_id IS NOT NULL;

CREATE TABLE public.device_processing_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL,
  device_id BIGINT NOT NULL,
  kind VARCHAR(24) NOT NULL,
  sterilization_load_id BIGINT,
  dialyzer_reuse_register_id BIGINT,
  attempt_id BIGINT,
  protocol_id INTEGER,
  cycle_type VARCHAR(20) NOT NULL,
  initial_outcome VARCHAR(16) NOT NULL,
  counts_cycle BOOLEAN NOT NULL DEFAULT TRUE,
  sterility_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  function_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  device_last_returned_at TIMESTAMPTZ(6),
  cycle_before INTEGER NOT NULL,
  cycle_after INTEGER NOT NULL,
  device_version_before INTEGER NOT NULL,
  device_version_after INTEGER NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  recorded_by UUID,
  recorded_via VARCHAR(24) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ux_device_processing_events_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_device_processing_events_tenant_device UNIQUE (tenant_id, id, device_id),
  CONSTRAINT fk_device_processing_events_device FOREIGN KEY (tenant_id, device_id, domain)
    REFERENCES public.reprocessable_devices (tenant_id, id, domain) ON DELETE RESTRICT,
  CONSTRAINT fk_device_processing_events_load FOREIGN KEY (tenant_id, sterilization_load_id)
    REFERENCES public.sterilization_loads (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_device_processing_events_reuse_register FOREIGN KEY (tenant_id, dialyzer_reuse_register_id)
    REFERENCES public.dialyzer_reuse_register (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_device_processing_events_protocol FOREIGN KEY (tenant_id, protocol_id)
    REFERENCES public.reprocessing_protocols (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT device_processing_events_domain_check CHECK (domain IN ('dialysis', 'ot')),
  CONSTRAINT device_processing_events_kind_check CHECK (
    kind IN ('sterilization_load', 'legacy_readiness_import', 'chemical_reprocessing', 'manual_reprocessed')
  ),
  CONSTRAINT device_processing_events_load_kind_check
    CHECK ((kind = 'sterilization_load') = (sterilization_load_id IS NOT NULL)),
  CONSTRAINT device_processing_events_cycle_type_check CHECK (
    cycle_type IN ('steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other')
  ),
  CONSTRAINT device_processing_events_outcome_check
    CHECK (initial_outcome IN ('passed', 'failed', 'held', 'not_applicable')),
  CONSTRAINT device_processing_events_cycle_check CHECK (
    cycle_before >= 0 AND cycle_after >= cycle_before AND device_version_after >= device_version_before
  ),
  CONSTRAINT device_processing_events_recorded_via_check CHECK (
    recorded_via IN ('load_created', 'load_transitioned', 'dialysis_record', 'dialysis_attempt', 'manual_reprocessed')
  )
);

CREATE UNIQUE INDEX ux_device_processing_events_device_load
  ON public.device_processing_events (tenant_id, device_id, sterilization_load_id)
  WHERE sterilization_load_id IS NOT NULL;

CREATE TABLE public.device_processing_event_revisions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  processing_event_id BIGINT NOT NULL,
  device_id BIGINT NOT NULL,
  load_revision INTEGER NOT NULL,
  outcome VARCHAR(16) NOT NULL,
  reason VARCHAR(40) NOT NULL,
  observed_at TIMESTAMPTZ(6) NOT NULL,
  source_load_updated_at TIMESTAMPTZ(6) NOT NULL,
  recorded_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_device_processing_event_revisions_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_device_processing_event_revisions_event_revision UNIQUE (tenant_id, processing_event_id, load_revision),
  CONSTRAINT fk_device_processing_event_revisions_event FOREIGN KEY (tenant_id, processing_event_id, device_id)
    REFERENCES public.device_processing_events (tenant_id, id, device_id) ON DELETE RESTRICT,
  CONSTRAINT device_processing_event_revisions_revision_check CHECK (load_revision >= 1),
  CONSTRAINT device_processing_event_revisions_outcome_check CHECK (outcome IN ('failed', 'invalidated')),
  CONSTRAINT device_processing_event_revisions_reason_check CHECK (btrim(reason) <> '')
);

CREATE TABLE public.reprocessable_device_holds (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL,
  device_id BIGINT NOT NULL,
  hold_type VARCHAR(32) NOT NULL,
  reason_code VARCHAR(40) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  pending_return BOOLEAN NOT NULL DEFAULT FALSE,
  source_marker_row_id BIGINT,
  source_load_id BIGINT,
  source_usage_id BIGINT,
  note TEXT,
  placed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  placed_by UUID,
  placed_via VARCHAR(24) NOT NULL,
  released_at TIMESTAMPTZ(6),
  released_by UUID,
  released_role VARCHAR(50),
  release_adjudication TEXT,
  release_protocol_id INTEGER,
  release_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  release_requires_processing BOOLEAN NOT NULL DEFAULT TRUE,
  satisfied_at TIMESTAMPTZ(6),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_reprocessable_device_holds_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_reprocessable_device_holds_tenant_device UNIQUE (tenant_id, id, device_id),
  CONSTRAINT fk_reprocessable_device_holds_device FOREIGN KEY (tenant_id, device_id, domain)
    REFERENCES public.reprocessable_devices (tenant_id, id, domain) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_device_holds_marker FOREIGN KEY (tenant_id, source_marker_row_id)
    REFERENCES public.patient_bloodborne_markers (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_device_holds_load FOREIGN KEY (tenant_id, source_load_id)
    REFERENCES public.sterilization_loads (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_device_holds_usage FOREIGN KEY (tenant_id, source_usage_id, device_id)
    REFERENCES public.reprocessable_device_usages (tenant_id, id, device_id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_device_holds_release_protocol FOREIGN KEY (tenant_id, release_protocol_id)
    REFERENCES public.reprocessing_protocols (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reprocessable_device_holds_domain_check CHECK (domain IN ('dialysis', 'ot')),
  CONSTRAINT reprocessable_device_holds_type_check CHECK (
    hold_type IN ('bloodborne_exposure', 'prion_exposure', 'sterilization_failed', 'load_invalidated',
                  'serology_required', 'post_issue_restriction', 'cycle_type_not_allowed',
                  'inspection_failed', 'manual')
  ),
  CONSTRAINT reprocessable_device_holds_reason_check CHECK (
    reason_code IN ('exposure_late_result', 'exposure_undated_declaration', 'exposure_at_return',
                    'load_failed', 'load_invalidated_after_release', 'serology_unknown_block_return',
                    'restricted_after_issue', 'cycle_type_forbidden', 'return_condition_damaged',
                    'manual_ic', 'manual_cssd')
  ),
  CONSTRAINT reprocessable_device_holds_status_check CHECK (status IN ('active', 'released', 'satisfied', 'superseded')),
  CONSTRAINT reprocessable_device_holds_placed_via_check CHECK (
    placed_via IN ('exposure_handler', 'reconciler', 'load_outcome', 'return', 'issue', 'manual')
  ),
  CONSTRAINT reprocessable_device_holds_released_check CHECK (
    status NOT IN ('released', 'satisfied')
    OR (released_at IS NOT NULL AND released_by IS NOT NULL AND release_adjudication IS NOT NULL)
  ),
  CONSTRAINT reprocessable_device_holds_prion_check
    CHECK (hold_type <> 'prion_exposure' OR status = 'active' OR release_protocol_id IS NOT NULL)
);

CREATE UNIQUE INDEX ux_reprocessable_device_holds_active
  ON public.reprocessable_device_holds (tenant_id, device_id, hold_type) WHERE status = 'active';

CREATE TABLE public.dialyser_reprocessing_attempts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL DEFAULT 'dialysis',
  device_id BIGINT NOT NULL,
  device_usage_id BIGINT NOT NULL,
  dialyzer_reuse_register_id BIGINT NOT NULL,
  attempt_no INTEGER NOT NULL,
  authorising_hold_id BIGINT,
  protocol_id INTEGER NOT NULL,
  integrity_test_result VARCHAR(16),
  measured_tcv_ml NUMERIC(6,1),
  baseline_tcv_ml NUMERIC(6,1),
  tcv_pct_of_baseline NUMERIC(5,1),
  reprocessing_agent VARCHAR(24),
  disinfectant_concentration_pct NUMERIC(5,2),
  disinfectant_contact_minutes INTEGER,
  process_parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  verdict VARCHAR(24) NOT NULL,
  missing_evidence TEXT[] NOT NULL DEFAULT '{}'::text[],
  verdict_reason VARCHAR(40),
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  recorded_by UUID NOT NULL,
  notes TEXT,
  CONSTRAINT ux_dialyser_reprocessing_attempts_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_dialyser_reprocessing_attempts_number UNIQUE (tenant_id, dialyzer_reuse_register_id, attempt_no),
  CONSTRAINT fk_dialyser_reprocessing_attempts_device FOREIGN KEY (tenant_id, device_id, domain)
    REFERENCES public.reprocessable_devices (tenant_id, id, domain) ON DELETE RESTRICT,
  CONSTRAINT fk_dialyser_reprocessing_attempts_usage FOREIGN KEY (tenant_id, device_usage_id, device_id)
    REFERENCES public.reprocessable_device_usages (tenant_id, id, device_id) ON DELETE RESTRICT,
  CONSTRAINT fk_dialyser_reprocessing_attempts_register FOREIGN KEY (tenant_id, dialyzer_reuse_register_id)
    REFERENCES public.dialyzer_reuse_register (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_dialyser_reprocessing_attempts_hold FOREIGN KEY (tenant_id, authorising_hold_id, device_id)
    REFERENCES public.reprocessable_device_holds (tenant_id, id, device_id) ON DELETE RESTRICT,
  CONSTRAINT fk_dialyser_reprocessing_attempts_protocol FOREIGN KEY (tenant_id, protocol_id)
    REFERENCES public.reprocessing_protocols (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT dialyser_reprocessing_attempts_domain_check CHECK (domain = 'dialysis'),
  CONSTRAINT dialyser_reprocessing_attempts_number_check CHECK (attempt_no >= 1),
  CONSTRAINT dialyser_reprocessing_attempts_integrity_check
    CHECK (integrity_test_result IS NULL OR integrity_test_result IN ('pass', 'fail')),
  CONSTRAINT dialyser_reprocessing_attempts_tcv_check CHECK (
    (measured_tcv_ml IS NULL OR measured_tcv_ml > 0)
    AND (baseline_tcv_ml IS NULL OR baseline_tcv_ml > 0)
    AND (tcv_pct_of_baseline IS NULL OR tcv_pct_of_baseline BETWEEN 0 AND 200)
  ),
  CONSTRAINT dialyser_reprocessing_attempts_agent_check CHECK (
    reprocessing_agent IS NULL OR reprocessing_agent IN ('peracetic_acid', 'formaldehyde', 'glutaraldehyde', 'renalin', 'other')
  ),
  CONSTRAINT dialyser_reprocessing_attempts_contact_check
    CHECK (disinfectant_contact_minutes IS NULL OR disinfectant_contact_minutes BETWEEN 0 AND 1440),
  CONSTRAINT dialyser_reprocessing_attempts_verdict_check
    CHECK (verdict IN ('released', 'not_established', 'discarded'))
);

CREATE TABLE public.reprocessable_hold_satisfactions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  hold_id BIGINT NOT NULL,
  device_id BIGINT NOT NULL,
  required_protocol_id INTEGER NOT NULL,
  processing_event_id BIGINT NOT NULL,
  satisfied_at TIMESTAMPTZ(6) NOT NULL,
  recorded_by UUID,
  CONSTRAINT ux_reprocessable_hold_satisfactions_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_reprocessable_hold_satisfactions_hold_event UNIQUE (tenant_id, hold_id, processing_event_id),
  CONSTRAINT fk_reprocessable_hold_satisfactions_hold FOREIGN KEY (tenant_id, hold_id, device_id)
    REFERENCES public.reprocessable_device_holds (tenant_id, id, device_id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_hold_satisfactions_protocol FOREIGN KEY (tenant_id, required_protocol_id)
    REFERENCES public.reprocessing_protocols (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_hold_satisfactions_event FOREIGN KEY (tenant_id, processing_event_id, device_id)
    REFERENCES public.device_processing_events (tenant_id, id, device_id) ON DELETE RESTRICT
);

CREATE TABLE public.reprocessable_device_dialysis_links (
  device_id BIGINT PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL DEFAULT 'dialysis',
  dedicated_patient_uid UUID NOT NULL,
  dedicated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  dedicated_by UUID NOT NULL,
  baseline_tcv_ml NUMERIC(6,1),
  baseline_tcv_measured_at TIMESTAMPTZ(6),
  baseline_tcv_source VARCHAR(40),
  baseline_approved_by UUID,
  baseline_approved_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_reprocessable_device_dialysis_links_tenant_id UNIQUE (tenant_id, device_id),
  CONSTRAINT fk_reprocessable_device_dialysis_links_device FOREIGN KEY (tenant_id, device_id, domain)
    REFERENCES public.reprocessable_devices (tenant_id, id, domain) ON DELETE CASCADE,
  CONSTRAINT fk_reprocessable_device_dialysis_links_patient FOREIGN KEY (tenant_id, dedicated_patient_uid)
    REFERENCES public.users (tenant_id, uid) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT reprocessable_device_dialysis_links_domain_check CHECK (domain = 'dialysis'),
  CONSTRAINT reprocessable_device_dialysis_links_baseline_tcv_check CHECK (baseline_tcv_ml IS NULL OR baseline_tcv_ml > 0),
  CONSTRAINT reprocessable_device_dialysis_links_baseline_source_check CHECK (
    baseline_tcv_source IS NULL OR baseline_tcv_source IN ('measured_new', 'manufacturer_nominal', 'validated_model_baseline')
  ),
  CONSTRAINT reprocessable_device_dialysis_links_validated_baseline_check CHECK (
    baseline_tcv_source <> 'validated_model_baseline'
    OR (baseline_approved_by IS NOT NULL AND baseline_approved_at IS NOT NULL)
  )
);

CREATE INDEX idx_reprocessable_device_dialysis_links_patient
  ON public.reprocessable_device_dialysis_links (tenant_id, dedicated_patient_uid);

CREATE TABLE public.dialysis_machines (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  facility_id INTEGER,
  machine_no VARCHAR(40) NOT NULL,
  display_name VARCHAR(120),
  biomed_device_id INTEGER,
  isolation_group VARCHAR(40),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  notes TEXT,
  created_by UUID NOT NULL,
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_dialysis_machines_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_dialysis_machines_number UNIQUE (tenant_id, machine_no),
  CONSTRAINT fk_dialysis_machines_facility FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_dialysis_machines_biomed FOREIGN KEY (tenant_id, biomed_device_id)
    REFERENCES public.clinical_ai_biomed_devices (tenant_id, id) ON DELETE SET NULL (biomed_device_id),
  CONSTRAINT dialysis_machines_isolation_group_check
    CHECK (isolation_group IS NULL OR btrim(isolation_group) <> ''),
  CONSTRAINT dialysis_machines_status_check CHECK (status IN ('active', 'out_of_service', 'retired'))
);

CREATE INDEX idx_dialysis_machines_isolation
  ON public.dialysis_machines (tenant_id, isolation_group, status);

CREATE TABLE public.bloodborne_exposure_outbox (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  marker_row_id BIGINT NOT NULL,
  patient_uid UUID NOT NULL,
  marker VARCHAR(20) NOT NULL,
  tested_on DATE,
  event JSONB NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  lease_owner VARCHAR(120),
  lease_expires_at TIMESTAMPTZ(6),
  last_error TEXT,
  delivered_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_bloodborne_exposure_outbox_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_bloodborne_exposure_outbox_marker UNIQUE (tenant_id, marker_row_id),
  CONSTRAINT fk_bloodborne_exposure_outbox_marker FOREIGN KEY (tenant_id, marker_row_id)
    REFERENCES public.patient_bloodborne_markers (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_bloodborne_exposure_outbox_patient FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES public.users (tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT bloodborne_exposure_outbox_marker_check CHECK (marker IN ('hbsag', 'hcv', 'hiv')),
  CONSTRAINT bloodborne_exposure_outbox_event_check CHECK (jsonb_typeof(event) = 'object'),
  CONSTRAINT bloodborne_exposure_outbox_status_check CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  CONSTRAINT bloodborne_exposure_outbox_attempts_check CHECK (attempts >= 0)
);

CREATE INDEX idx_bloodborne_exposure_outbox_drain
  ON public.bloodborne_exposure_outbox (status, available_at, id);

CREATE TABLE public.bloodborne_exposure_deliveries (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  outbox_id BIGINT NOT NULL,
  handler_id VARCHAR(120) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  remaining_device_count INTEGER NOT NULL DEFAULT 0,
  remaining_alert_count INTEGER NOT NULL DEFAULT 0,
  remaining_notification_count INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  lease_owner VARCHAR(120),
  lease_expires_at TIMESTAMPTZ(6),
  last_error TEXT,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_bloodborne_exposure_deliveries_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_bloodborne_exposure_deliveries_handler UNIQUE (tenant_id, outbox_id, handler_id),
  CONSTRAINT fk_bloodborne_exposure_deliveries_outbox FOREIGN KEY (tenant_id, outbox_id)
    REFERENCES public.bloodborne_exposure_outbox (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bloodborne_exposure_deliveries_status_check CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  CONSTRAINT bloodborne_exposure_deliveries_counts_check CHECK (
    remaining_device_count >= 0 AND remaining_alert_count >= 0 AND remaining_notification_count >= 0 AND attempts >= 0
  )
);

CREATE TABLE public.bloodborne_exposure_applications (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  outbox_id BIGINT NOT NULL,
  handler_id VARCHAR(120) NOT NULL,
  device_id BIGINT NOT NULL,
  hold_id BIGINT,
  source_usage_id BIGINT,
  result VARCHAR(32) NOT NULL,
  applied_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ux_bloodborne_exposure_applications_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_bloodborne_exposure_applications_source UNIQUE (tenant_id, outbox_id, handler_id, device_id),
  CONSTRAINT fk_bloodborne_exposure_applications_outbox FOREIGN KEY (tenant_id, outbox_id)
    REFERENCES public.bloodborne_exposure_outbox (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_bloodborne_exposure_applications_device FOREIGN KEY (tenant_id, device_id)
    REFERENCES public.reprocessable_devices (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_bloodborne_exposure_applications_hold FOREIGN KEY (tenant_id, hold_id, device_id)
    REFERENCES public.reprocessable_device_holds (tenant_id, id, device_id) ON DELETE RESTRICT,
  CONSTRAINT fk_bloodborne_exposure_applications_usage FOREIGN KEY (tenant_id, source_usage_id, device_id)
    REFERENCES public.reprocessable_device_usages (tenant_id, id, device_id) ON DELETE RESTRICT,
  CONSTRAINT bloodborne_exposure_applications_result_check
    CHECK (result IN ('hold_created', 'hold_associated', 'already_applied', 'not_applicable'))
);

CREATE TABLE public.reprocessable_device_operations (
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES public.tenants(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL,
  device_id BIGINT NOT NULL,
  action VARCHAR(40) NOT NULL,
  idempotency_key_hash VARCHAR(64) NOT NULL,
  version_before INTEGER NOT NULL,
  version_after INTEGER NOT NULL,
  audit_id BIGINT,
  occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT reprocessable_device_operations_pkey PRIMARY KEY (tenant_id, operation_id),
  CONSTRAINT fk_reprocessable_device_operations_device FOREIGN KEY (tenant_id, device_id)
    REFERENCES public.reprocessable_devices (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT reprocessable_device_operations_action_check CHECK (btrim(action) <> ''),
  CONSTRAINT reprocessable_device_operations_idempotency_check
    CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT reprocessable_device_operations_version_check
    CHECK (version_before >= 0 AND version_after >= version_before),
  CONSTRAINT reprocessable_device_operations_result_check CHECK (jsonb_typeof(result_summary) = 'object')
);

ALTER TABLE public.reprocessable_devices
  ADD CONSTRAINT fk_reprocessable_devices_current_usage
    FOREIGN KEY (tenant_id, current_usage_id, id)
    REFERENCES public.reprocessable_device_usages (tenant_id, id, device_id)
    ON DELETE SET NULL (current_usage_id),
  ADD CONSTRAINT fk_reprocessable_devices_last_processing_event
    FOREIGN KEY (tenant_id, last_processing_event_id, id)
    REFERENCES public.device_processing_events (tenant_id, id, device_id)
    ON DELETE SET NULL (last_processing_event_id);

ALTER TABLE public.reprocessable_device_usages
  ADD CONSTRAINT fk_reprocessable_device_usages_ready_event
    FOREIGN KEY (tenant_id, ready_processing_event_id, device_id)
    REFERENCES public.device_processing_events (tenant_id, id, device_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_reprocessable_device_usages_post_event
    FOREIGN KEY (tenant_id, post_use_processing_event_id, device_id)
    REFERENCES public.device_processing_events (tenant_id, id, device_id) ON DELETE RESTRICT;

ALTER TABLE public.device_processing_events
  ADD CONSTRAINT fk_device_processing_events_attempt FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES public.dialyser_reprocessing_attempts (tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE public.dialysis_sessions
  ADD COLUMN isolation_warning_codes TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN isolation_required_group VARCHAR(40),
  ADD COLUMN isolation_warn_only BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN isolation_enforcement_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN isolation_override_reason TEXT,
  ADD COLUMN isolation_override_by UUID,
  ADD COLUMN isolation_override_at TIMESTAMPTZ(6),
  ADD COLUMN isolation_override_kind VARCHAR(16),
  ADD COLUMN isolation_evaluated_at TIMESTAMPTZ(6),
  ADD CONSTRAINT dialysis_sessions_isolation_override_kind_check
    CHECK (isolation_override_kind IS NULL OR isolation_override_kind IN ('reason', 'emergency')),
  ADD CONSTRAINT dialysis_sessions_isolation_override_check
    CHECK (num_nonnulls(isolation_override_reason, isolation_override_by, isolation_override_at) IN (0, 3));

ALTER TABLE public.dialyzer_reuse_register
  ADD COLUMN device_id BIGINT,
  ADD COLUMN device_usage_id BIGINT,
  ADD COLUMN measured_tcv_ml NUMERIC(6,1),
  ADD COLUMN baseline_tcv_ml NUMERIC(6,1),
  ADD COLUMN tcv_pct_of_baseline NUMERIC(5,1),
  ADD COLUMN reprocessing_agent VARCHAR(24),
  ADD COLUMN disinfectant_contact_minutes INTEGER,
  ADD COLUMN disinfectant_concentration_pct NUMERIC(5,2),
  ADD COLUMN release_status VARCHAR(24) NOT NULL DEFAULT 'legacy',
  ADD COLUMN missing_evidence TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN capture_provenance VARCHAR(16),
  ADD COLUMN protocol_id INTEGER,
  ADD COLUMN processing_event_id BIGINT,
  ADD CONSTRAINT fk_dialyzer_reuse_register_device FOREIGN KEY (tenant_id, device_id)
    REFERENCES public.reprocessable_devices (tenant_id, id) ON DELETE SET NULL (device_id),
  ADD CONSTRAINT fk_dialyzer_reuse_register_device_usage FOREIGN KEY (tenant_id, device_usage_id, device_id)
    REFERENCES public.reprocessable_device_usages (tenant_id, id, device_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_dialyzer_reuse_register_usage_session FOREIGN KEY (tenant_id, device_usage_id, session_id)
    REFERENCES public.reprocessable_device_usages (tenant_id, id, dialysis_session_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_dialyzer_reuse_register_protocol FOREIGN KEY (tenant_id, protocol_id)
    REFERENCES public.reprocessing_protocols (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_dialyzer_reuse_register_processing_event FOREIGN KEY (tenant_id, processing_event_id, device_id)
    REFERENCES public.device_processing_events (tenant_id, id, device_id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_dialyzer_reuse_device_pair CHECK ((device_id IS NULL) = (device_usage_id IS NULL)),
  ADD CONSTRAINT chk_dialyzer_reuse_agent CHECK (
    reprocessing_agent IS NULL OR reprocessing_agent IN ('peracetic_acid', 'formaldehyde', 'glutaraldehyde', 'renalin', 'other')
  ),
  ADD CONSTRAINT chk_dialyzer_reuse_contact_minutes
    CHECK (disinfectant_contact_minutes IS NULL OR disinfectant_contact_minutes BETWEEN 0 AND 1440),
  ADD CONSTRAINT chk_dialyzer_reuse_measured_tcv CHECK (measured_tcv_ml IS NULL OR measured_tcv_ml > 0),
  ADD CONSTRAINT chk_dialyzer_reuse_tcv_pct CHECK (tcv_pct_of_baseline IS NULL OR tcv_pct_of_baseline BETWEEN 0 AND 200),
  ADD CONSTRAINT chk_dialyzer_reuse_release_status
    CHECK (release_status IN ('legacy', 'released', 'not_established', 'quarantined', 'discarded')),
  ADD CONSTRAINT chk_dialyzer_reuse_capture_provenance
    CHECK (capture_provenance IS NULL OR capture_provenance IN ('live', 'retrospective')),
  ADD CONSTRAINT chk_dialyzer_reuse_release_event
    CHECK (release_status <> 'released' OR processing_event_id IS NOT NULL);

ALTER TABLE public.surgical_implants
  ADD COLUMN sterilization_load_id BIGINT,
  ADD CONSTRAINT fk_surgical_implants_sterilization_load
    FOREIGN KEY (tenant_id, sterilization_load_id)
    REFERENCES public.sterilization_loads (tenant_id, id) ON DELETE SET NULL (sterilization_load_id);

CREATE OR REPLACE FUNCTION public.reprocessable_append_only_guard_768()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION public.reprocessable_append_only_guard_768() FROM PUBLIC;

DO $plan4_append_only_triggers$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'reprocessing_isolation_setting_revisions',
    'reprocessing_protocols',
    'reprocessing_protocol_device_scopes',
    'device_processing_events',
    'device_processing_event_revisions',
    'dialyser_reprocessing_attempts',
    'reprocessable_hold_satisfactions',
    'bloodborne_exposure_applications',
    'reprocessable_device_operations'
  ]::text[] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reprocessable_append_only_guard_768()',
      relation_name || '_append_only_768', relation_name
    );
  END LOOP;
END
$plan4_append_only_triggers$;

DO $plan4_rls$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'reprocessing_domain_settings',
    'reprocessing_isolation_setting_revisions',
    'reprocessing_domain_policies',
    'reprocessing_protocols',
    'reprocessable_devices',
    'reprocessable_device_usages',
    'reprocessable_device_dialysis_links',
    'dialysis_machines',
    'reprocessable_device_holds',
    'device_processing_events',
    'dialyser_reprocessing_attempts',
    'bloodborne_exposure_outbox',
    'reprocessing_protocol_device_scopes',
    'device_processing_event_revisions',
    'reprocessable_hold_satisfactions',
    'bloodborne_exposure_deliveries',
    'bloodborne_exposure_applications',
    'reprocessable_device_operations'
  ]::text[] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', relation_name);
    EXECUTE format(
      $policy$CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE
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
        )$policy$,
      relation_name
    );
    EXECUTE format(
      'CREATE POLICY tenant_context_required ON public.%I AS RESTRICTIVE FOR ALL USING (app_current_tenant_id_uuid() IS NOT NULL)',
      relation_name
    );
  END LOOP;
END
$plan4_rls$;

DO $plan4_runtime_grants$
DECLARE
  role_name text;
  relation_name text;
  sequence_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::text[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NULL THEN CONTINUE; END IF;

    FOREACH relation_name IN ARRAY ARRAY[
      'reprocessing_isolation_setting_revisions',
      'reprocessing_protocols',
      'reprocessing_protocol_device_scopes',
      'device_processing_events',
      'device_processing_event_revisions',
      'dialyser_reprocessing_attempts',
      'reprocessable_hold_satisfactions',
      'bloodborne_exposure_applications',
      'reprocessable_device_operations'
    ]::text[] LOOP
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', relation_name, role_name);
      EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO %I', relation_name, role_name);
    END LOOP;

    FOREACH relation_name IN ARRAY ARRAY[
      'reprocessing_domain_settings',
      'reprocessing_domain_policies',
      'reprocessable_devices',
      'reprocessable_device_usages',
      'reprocessable_device_dialysis_links',
      'dialysis_machines',
      'reprocessable_device_holds',
      'bloodborne_exposure_outbox',
      'bloodborne_exposure_deliveries'
    ]::text[] LOOP
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', relation_name, role_name);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO %I', relation_name, role_name);
    END LOOP;

    FOREACH sequence_name IN ARRAY ARRAY[
      'reprocessing_protocols_id_seq',
      'reprocessing_protocol_device_scopes_id_seq',
      'reprocessing_isolation_setting_revisions_id_seq',
      'reprocessable_devices_id_seq',
      'reprocessable_device_usages_id_seq',
      'device_processing_events_id_seq',
      'device_processing_event_revisions_id_seq',
      'reprocessable_device_holds_id_seq',
      'dialyser_reprocessing_attempts_id_seq',
      'reprocessable_hold_satisfactions_id_seq',
      'dialysis_machines_id_seq',
      'bloodborne_exposure_outbox_id_seq',
      'bloodborne_exposure_deliveries_id_seq',
      'bloodborne_exposure_applications_id_seq'
    ]::text[] LOOP
      EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM %I', sequence_name, role_name);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I', sequence_name, role_name);
    END LOOP;
  END LOOP;
END
$plan4_runtime_grants$;

COMMIT;
