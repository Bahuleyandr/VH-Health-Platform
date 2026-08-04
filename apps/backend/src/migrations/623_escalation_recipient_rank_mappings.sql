BEGIN;

-- Section 6.8 RLS posture and reasoning: this is tenant-owned operational
-- configuration, not patient or facility data. FORCE RLS still applies because
-- a cross-tenant rank changes who receives a safety-adjacent escalation. It
-- ships empty and cannot activate ranking until an audited tenant replacement
-- writes both mappings and its settings marker.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE TABLE public.escalation_recipient_rank_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_kind varchar(20) NOT NULL,
  source_value varchar(100) NOT NULL,
  normalized_source_value varchar(100) NOT NULL,
  priority_rank smallint NOT NULL,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_escalation_recipient_rank_mappings_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT chk_escalation_recipient_rank_mappings_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_escalation_recipient_rank_mappings_source_kind
    CHECK (source_kind IN ('position', 'designation')),
  CONSTRAINT chk_escalation_recipient_rank_mappings_source_value
    CHECK (btrim(source_value) <> ''),
  CONSTRAINT chk_escalation_recipient_rank_mappings_normalized_value
    CHECK (
      normalized_source_value <> ''
      AND normalized_source_value = lower(
        regexp_replace(btrim(source_value), '[[:space:]]+', ' ', 'g')
      )
    ),
  CONSTRAINT chk_escalation_recipient_rank_mappings_priority_rank
    CHECK (priority_rank BETWEEN 1 AND 100),
  CONSTRAINT uq_escalation_recipient_rank_mappings_source
    UNIQUE (tenant_id, source_kind, normalized_source_value)
);

CREATE INDEX idx_escalation_recipient_rank_mappings_tenant_rank
  ON public.escalation_recipient_rank_mappings
  (tenant_id, priority_rank, source_kind, normalized_source_value);

ALTER TABLE public.escalation_recipient_rank_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escalation_recipient_rank_mappings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.escalation_recipient_rank_mappings
  AS PERMISSIVE
  USING (tenant_id = public.app_current_tenant_id_uuid())
  WITH CHECK (tenant_id = public.app_current_tenant_id_uuid());

CREATE POLICY escalation_recipient_rank_mappings_explicit_context
  ON public.escalation_recipient_rank_mappings
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

REVOKE ALL PRIVILEGES ON public.escalation_recipient_rank_mappings FROM PUBLIC;

DO $runtime_privileges$
DECLARE
  runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.escalation_recipient_rank_mappings TO %I',
      runtime_role
    );
    EXECUTE format(
      'REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.escalation_recipient_rank_mappings FROM %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;

COMMIT;
