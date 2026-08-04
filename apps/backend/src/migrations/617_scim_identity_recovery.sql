-- C6.1-F / I13 SCIM identity recovery.
--
-- Provider push replay remains blocked because the provider supplies no
-- monotonic change sequence. Owner-directed list/diff commands become exact,
-- append-only evidence. C-D15 is the only automatic late-effect exception:
-- deactivation and delete shut access off immediately and still require
-- after-the-fact review. Every other late command is pending-only.
--
-- Section 6.8 RLS posture: command bodies and identity targets are tenant PHI
-- and security evidence. FORCE RLS plus an explicit, non-bypass tenant context
-- is therefore required for every read and insert; no platform-wide seam is
-- permitted for this append-only receipt table.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

ALTER TABLE public.tenant_identity_providers
  ADD CONSTRAINT ux_tenant_identity_providers_tenant_id
  UNIQUE (tenant_id, id);

CREATE TABLE public.scim_provisioning_commands (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  provider_id BIGINT NOT NULL,
  provider_key VARCHAR(80) NOT NULL,
  direction VARCHAR(16) NOT NULL,
  realm VARCHAR(20) NOT NULL,
  command_source VARCHAR(40) NOT NULL,
  command_kind VARCHAR(32) NOT NULL,
  http_method VARCHAR(8) NOT NULL,
  target_uid UUID NOT NULL,
  external_id VARCHAR(255),
  authenticated_at TIMESTAMPTZ(6) NOT NULL,
  auth_binding_sha256 CHAR(64) NOT NULL,
  body_ciphertext TEXT NOT NULL,
  body_sha256 CHAR(64) NOT NULL,
  body_bytes INTEGER NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  payload_bytes INTEGER NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  source_partition VARCHAR(160),
  source_position BIGINT,
  source_token VARCHAR(255),
  predecessor_token VARCHAR(255),
  duplicate_key VARCHAR(255),
  recovery_inbox_id UUID,
  recovery_interface_family VARCHAR(8),
  owner_actor_uid UUID,
  owner_reason VARCHAR(500),
  effect_disposition VARCHAR(40) NOT NULL,
  execution_disposition VARCHAR(48) NOT NULL,
  access_shutdown_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_scim_provisioning_commands_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT fk_scim_provisioning_commands_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants (id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_scim_provisioning_commands_provider
    FOREIGN KEY (tenant_id, provider_id)
    REFERENCES public.tenant_identity_providers (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_scim_provisioning_commands_owner
    FOREIGN KEY (tenant_id, owner_actor_uid)
    REFERENCES public.users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_scim_provisioning_commands_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox (tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_scim_provisioning_commands_direction
    CHECK (direction = 'inbound'),
  CONSTRAINT chk_scim_provisioning_commands_realm
    CHECK (realm IN ('staff', 'admin')),
  CONSTRAINT chk_scim_provisioning_commands_source
    CHECK (command_source IN ('live_provider_push', 'owner_reconciled_list_diff')),
  CONSTRAINT chk_scim_provisioning_commands_kind
    CHECK (command_kind IN (
      'create', 'deactivate', 'delete', 'enable', 'reactivate',
      'role_change', 'profile_update'
    )),
  CONSTRAINT chk_scim_provisioning_commands_method
    CHECK (
      http_method IN ('POST', 'PUT', 'PATCH', 'DELETE')
      AND (command_kind = 'delete') = (http_method = 'DELETE')
    ),
  CONSTRAINT chk_scim_provisioning_commands_hashes
    CHECK (
      auth_binding_sha256 ~ '^[0-9a-f]{64}$'
      AND body_sha256 ~ '^[0-9a-f]{64}$'
      AND payload_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT chk_scim_provisioning_commands_lengths
    CHECK (
      body_bytes >= 0
      AND payload_bytes > 0
      AND length(btrim(provider_key)) > 0
    ),
  CONSTRAINT chk_scim_provisioning_commands_recovery_pair
    CHECK ((recovery_inbox_id IS NULL) = (recovery_interface_family IS NULL)),
  CONSTRAINT chk_scim_provisioning_commands_recovery_shape
    CHECK (
      (
        command_source = 'live_provider_push'
        AND recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND source_partition IS NULL
        AND source_position IS NULL
        AND source_token IS NULL
        AND predecessor_token IS NULL
        AND duplicate_key IS NULL
        AND owner_actor_uid IS NULL
        AND owner_reason IS NULL
        AND (
          (effect_disposition = 'live_applied' AND execution_disposition = 'applied')
          OR (
            effect_disposition = 'live_excluded'
            AND execution_disposition = 'break_glass_excluded'
          )
        )
      )
      OR (
        command_source = 'owner_reconciled_list_diff'
        AND recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I13'
        AND source_partition IS NOT NULL
        AND source_position IS NOT NULL
        AND source_position >= 0
        AND source_token IS NOT NULL
        AND length(btrim(source_token)) > 0
        AND predecessor_token IS NOT NULL
        AND length(btrim(predecessor_token)) > 0
        AND duplicate_key IS NOT NULL
        AND length(btrim(duplicate_key)) > 0
        AND owner_actor_uid IS NOT NULL
        AND owner_reason IS NOT NULL
        AND length(btrim(owner_reason)) > 0
        AND effect_disposition = 'late_pending_only'
        AND execution_disposition IN (
          'revocation_executed_pending_review',
          'break_glass_excluded_pending_review',
          'pending_review_no_mutation'
        )
      )
    ),
  CONSTRAINT chk_scim_provisioning_commands_late_effect
    CHECK (
      (
        command_kind IN ('deactivate', 'delete')
        AND execution_disposition IN (
          'applied',
          'break_glass_excluded',
          'revocation_executed_pending_review',
          'break_glass_excluded_pending_review'
        )
      )
      OR (
        command_kind NOT IN ('deactivate', 'delete')
        AND execution_disposition IN ('applied', 'pending_review_no_mutation')
      )
    )
);

CREATE UNIQUE INDEX ux_scim_provisioning_commands_recovery_inbox
  ON public.scim_provisioning_commands
    (tenant_id, recovery_inbox_id, recovery_interface_family)
  WHERE recovery_inbox_id IS NOT NULL;

CREATE UNIQUE INDEX ux_scim_provisioning_commands_recovery_identity
  ON public.scim_provisioning_commands
    (tenant_id, provider_id, direction, source_partition, duplicate_key)
  WHERE recovery_inbox_id IS NOT NULL;

CREATE INDEX idx_scim_provisioning_commands_review
  ON public.scim_provisioning_commands
    (tenant_id, provider_id, execution_disposition, occurred_at, id);

CREATE OR REPLACE FUNCTION public.validate_scim_provisioning_command()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  inbox RECORD;
  identity RECORD;
  session_count INTEGER;
  staff_session_count INTEGER;
  unsafe_device_count INTEGER;
  expected_partition TEXT;
  expected_duplicate TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.tenant_identity_providers AS provider
     WHERE provider.tenant_id = NEW.tenant_id
       AND provider.id = NEW.provider_id
       AND provider.provider_key = NEW.provider_key
       AND provider.realm = NEW.realm
       AND provider.status = 'active'
       AND provider.scim_enabled = true
       AND provider.scim_bearer_token_hash = NEW.auth_binding_sha256
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_scim_provisioning_command_provider_binding',
      MESSAGE = 'I13 SCIM command lacks current tenant/provider authentication binding';
  END IF;

  IF NEW.realm = 'staff' THEN
    SELECT users.uid, users.is_active, users.status,
           users.is_break_glass_account, staff.id AS staff_id,
           staff.is_active AS staff_is_active, staff.archived
      INTO identity
      FROM public.users
      JOIN public.staff
        ON staff.tenant_id = users.tenant_id
       AND staff.user_id = users.uid
     WHERE users.tenant_id = NEW.tenant_id
       AND users.uid = NEW.target_uid
       AND users.scim_provider_id = NEW.provider_id
       AND staff.scim_provider_id = NEW.provider_id;
  ELSE
    SELECT admins.uid, admins.is_active, admins.status,
           admins.is_break_glass_account, NULL::integer AS staff_id,
           NULL::boolean AS staff_is_active, NULL::boolean AS archived
      INTO identity
      FROM public.admins
     WHERE admins.tenant_id = NEW.tenant_id
       AND admins.uid = NEW.target_uid
       AND admins.scim_provider_id = NEW.provider_id;
  END IF;

  IF identity IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_scim_provisioning_command_identity_binding',
      MESSAGE = 'I13 SCIM command target is not bound to the tenant/provider';
  END IF;

  IF NEW.recovery_inbox_id IS NOT NULL THEN
    SELECT item.interface_family, item.direction, item.source_partition,
           item.source_position, item.source_token, item.predecessor_token,
           item.duplicate_key, item.arrival_class, item.effect_disposition,
           item.status
      INTO inbox
      FROM public.pathway_projector_inbox AS item
     WHERE item.tenant_id = NEW.tenant_id
       AND item.inbox_id = NEW.recovery_inbox_id;

    expected_partition := 'scim-provider:' || NEW.provider_id::text || ':inbound';
    expected_duplicate := 'i13:' || NEW.provider_id::text || ':'
      || NEW.http_method || ':' || NEW.target_uid::text || ':' || NEW.payload_sha256;

    IF inbox IS NULL
       OR inbox.interface_family <> 'I13'
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
        CONSTRAINT = 'chk_scim_provisioning_command_recovery_provenance',
        MESSAGE = 'I13 SCIM command lacks exact pending-inbox provenance';
    END IF;
  END IF;

  IF NEW.execution_disposition IN (
       'break_glass_excluded',
       'break_glass_excluded_pending_review'
     )
     AND identity.is_break_glass_account IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_scim_provisioning_command_break_glass',
      MESSAGE = 'I13 break-glass exclusion requires a named break-glass target';
  END IF;

  IF NEW.execution_disposition = 'revocation_executed_pending_review' THEN
    SELECT COUNT(*)::integer
      INTO session_count
      FROM public.user_active_sessions
     WHERE user_uid = NEW.target_uid;

    IF NEW.realm = 'staff' THEN
      SELECT COUNT(*)::integer
        INTO staff_session_count
        FROM public.staff_auth_sessions
       WHERE staff_id = identity.staff_id;
      SELECT COUNT(*)::integer
        INTO unsafe_device_count
        FROM public.staff_devices
       WHERE staff_id = identity.staff_id
         AND (is_active = true OR pin_hash IS NOT NULL OR biometric_enabled = true);
    ELSE
      staff_session_count := 0;
      unsafe_device_count := 0;
    END IF;

    IF identity.is_break_glass_account = true
       OR identity.is_active = true
       OR identity.status <> 'inactive'
       OR (NEW.realm = 'staff' AND (
         identity.staff_is_active = true OR identity.archived = false
       ))
       OR session_count <> 0
       OR staff_session_count <> 0
       OR unsafe_device_count <> 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_scim_provisioning_command_revocation_effect',
        MESSAGE = 'C-D15 SCIM revocation receipt requires the complete access shut-off';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER validate_scim_provisioning_command
BEFORE INSERT ON public.scim_provisioning_commands
FOR EACH ROW EXECUTE FUNCTION public.validate_scim_provisioning_command();

CREATE OR REPLACE FUNCTION public.scim_provisioning_command_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'chk_scim_provisioning_command_append_only',
    MESSAGE = 'SCIM provisioning command receipts are append-only';
END
$$;

CREATE TRIGGER scim_provisioning_command_append_only
BEFORE UPDATE OR DELETE ON public.scim_provisioning_commands
FOR EACH ROW EXECUTE FUNCTION public.scim_provisioning_command_append_only();

ALTER TABLE public.scim_provisioning_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scim_provisioning_commands FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.scim_provisioning_commands
  AS PERMISSIVE
  USING (tenant_id = public.app_current_tenant_id_uuid())
  WITH CHECK (tenant_id = public.app_current_tenant_id_uuid());

CREATE POLICY scim_provisioning_commands_explicit_context
  ON public.scim_provisioning_commands
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

REVOKE ALL PRIVILEGES ON FUNCTION public.validate_scim_provisioning_command() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.scim_provisioning_command_append_only() FROM PUBLIC;

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
      'GRANT SELECT, INSERT ON public.scim_provisioning_commands TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.scim_provisioning_commands FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT USAGE, SELECT ON SEQUENCE public.scim_provisioning_commands_id_seq TO %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;

COMMIT;
