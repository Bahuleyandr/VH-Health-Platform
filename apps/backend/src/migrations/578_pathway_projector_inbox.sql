-- Unified Care Pathways S1a: retained shadow projector work ledger.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

SET LOCAL search_path = pg_catalog, pg_temp;

DO $$
BEGIN
  IF pg_catalog.to_regrole('vhhealth_app') IS NOT NULL THEN
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM vhhealth_app';
    IF pg_catalog.has_schema_privilege('vhhealth_app', 'public', 'CREATE') THEN
      RAISE EXCEPTION 'vhhealth_app retains CREATE on schema public';
    END IF;
  END IF;
  IF pg_catalog.to_regrole('vhhealth_runtime') IS NOT NULL THEN
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM vhhealth_runtime';
    IF pg_catalog.has_schema_privilege('vhhealth_runtime', 'public', 'CREATE') THEN
      RAISE EXCEPTION 'vhhealth_runtime retains CREATE on schema public';
    END IF;
  END IF;
  IF pg_catalog.has_schema_privilege(0::pg_catalog.oid, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'PUBLIC retains CREATE on schema public';
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
     WHERE namespace.nspname OPERATOR(pg_catalog.=) 'public'::pg_catalog.name
       AND relation.relname OPERATOR(pg_catalog.=) ANY (
         ARRAY[
           'event_outbox'::pg_catalog.name,
           'event_consumer_offsets'::pg_catalog.name,
           'pathway_projector_inbox'::pg_catalog.name
         ]
       )
       AND (
         relation.relkind OPERATOR(pg_catalog.<>) 'r'::pg_catalog."char"
         OR relation.relowner OPERATOR(pg_catalog.<>)
              (CURRENT_USER::pg_catalog.regrole)::pg_catalog.oid
       )
  ) THEN
    RAISE EXCEPTION 'pathway projector relation ownership or kind invariant failed';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
     WHERE namespace.nspname OPERATOR(pg_catalog.=) 'public'::pg_catalog.name
       AND relation.relname OPERATOR(pg_catalog.=) ANY (
         ARRAY[
           'uq_event_consumer_offsets_live_consumer'::pg_catalog.name,
           'idx_pathway_projector_inbox_pending'::pg_catalog.name,
           'idx_pathway_projector_inbox_stale'::pg_catalog.name,
           'idx_pathway_projector_inbox_tenant_ops'::pg_catalog.name,
           'idx_pathway_projector_inbox_metrics'::pg_catalog.name
         ]
       )
       AND (
         relation.relkind OPERATOR(pg_catalog.<>) 'i'::pg_catalog."char"
         OR relation.relowner OPERATOR(pg_catalog.<>)
              (CURRENT_USER::pg_catalog.regrole)::pg_catalog.oid
       )
  ) THEN
    RAISE EXCEPTION 'pathway projector index ownership or kind invariant failed';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid OPERATOR(pg_catalog.=) procedure.pronamespace
     WHERE namespace.nspname OPERATOR(pg_catalog.=) 'public'::pg_catalog.name
       AND procedure.proname OPERATOR(pg_catalog.=)
            'pathway_projector_enqueue_new_event'::pg_catalog.name
       AND procedure.pronargs OPERATOR(pg_catalog.=) 0::pg_catalog.int2
       AND (
         procedure.proowner OPERATOR(pg_catalog.<>)
           (CURRENT_USER::pg_catalog.regrole)::pg_catalog.oid
         OR procedure.prokind OPERATOR(pg_catalog.<>) 'f'::pg_catalog."char"
         OR procedure.prorettype OPERATOR(pg_catalog.<>)
              pg_catalog.to_regtype('pg_catalog.trigger')
       )
  ) THEN
    RAISE EXCEPTION 'pathway projector trigger-function ownership or shape invariant failed';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.event_consumer_offsets (
  consumer_key VARCHAR(120) NOT NULL,
  generation INTEGER NOT NULL,
  historical_cutoff_event_id BIGINT NOT NULL,
  backfill_cursor_event_id BIGINT NOT NULL DEFAULT 0,
  backfill_completed_at TIMESTAMPTZ(6),
  intake_retired_at TIMESTAMPTZ(6),
  registered_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT event_consumer_offsets_pkey
    PRIMARY KEY (consumer_key, generation),
  CONSTRAINT event_consumer_offsets_generation_check
    CHECK (generation > 0),
  CONSTRAINT event_consumer_offsets_cutoff_check
    CHECK (historical_cutoff_event_id >= 0),
  CONSTRAINT event_consumer_offsets_cursor_check
    CHECK (
      backfill_cursor_event_id >= 0
      AND backfill_cursor_event_id <= historical_cutoff_event_id
    ),
  CONSTRAINT event_consumer_offsets_completion_check
    CHECK (
      backfill_completed_at IS NULL
      OR backfill_cursor_event_id = historical_cutoff_event_id
    ),
  CONSTRAINT event_consumer_offsets_retirement_check
    CHECK (
      intake_retired_at IS NULL
      OR backfill_completed_at IS NOT NULL
    ),
  CONSTRAINT event_consumer_offsets_retirement_chronology_check
    CHECK (
      intake_retired_at IS NULL
      OR intake_retired_at >= registered_at
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_consumer_offsets_live_consumer
  ON public.event_consumer_offsets (consumer_key)
  WHERE intake_retired_at IS NULL;

CREATE TABLE IF NOT EXISTS public.pathway_projector_inbox (
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  consumer_key VARCHAR(120) NOT NULL,
  generation INTEGER NOT NULL,
  event_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ(6),
  next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  last_error TEXT,
  outcome_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT pathway_projector_inbox_pkey
    PRIMARY KEY (tenant_id, consumer_key, generation, event_id),
  CONSTRAINT fk_pathway_projector_inbox_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT pathway_projector_inbox_generation_check
    CHECK (generation > 0),
  CONSTRAINT pathway_projector_inbox_status_check
    CHECK (status IN ('pending', 'handled', 'ignored', 'dead')),
  CONSTRAINT pathway_projector_inbox_attempts_check
    CHECK (attempts >= 0),
  CONSTRAINT chk_pathway_projector_inbox_lease_pair
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT chk_pathway_projector_inbox_outcome
    CHECK (
      (status = 'pending' AND outcome_at IS NULL)
      OR (status IN ('handled', 'ignored', 'dead') AND outcome_at IS NOT NULL)
    ),
  CONSTRAINT chk_pathway_projector_inbox_terminal_lease
    CHECK (
      status = 'pending'
      OR (lease_owner IS NULL AND lease_expires_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_pathway_projector_inbox_pending
  ON public.pathway_projector_inbox (consumer_key, generation, next_attempt_at, event_id)
  WHERE status = 'pending' AND lease_owner IS NULL;

CREATE INDEX IF NOT EXISTS idx_pathway_projector_inbox_stale
  ON public.pathway_projector_inbox (consumer_key, generation, lease_expires_at, event_id)
  WHERE status = 'pending' AND lease_owner IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pathway_projector_inbox_tenant_ops
  ON public.pathway_projector_inbox (tenant_id, consumer_key, generation, status, event_id);

CREATE INDEX IF NOT EXISTS idx_pathway_projector_inbox_metrics
  ON public.pathway_projector_inbox (consumer_key, generation, status, created_at)
  INCLUDE (lease_owner)
  WHERE status IN ('pending', 'dead');

ALTER TABLE public.pathway_projector_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pathway_projector_inbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.pathway_projector_inbox;
CREATE POLICY tenant_isolation ON public.pathway_projector_inbox
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
  );

CREATE OR REPLACE FUNCTION public.pathway_projector_enqueue_new_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_RELID OPERATOR(pg_catalog.<>)
       ('public.event_outbox'::pg_catalog.regclass)::pg_catalog.oid
     OR TG_OP OPERATOR(pg_catalog.<>) 'INSERT'::pg_catalog.text THEN
    RAISE EXCEPTION 'pathway_projector_enqueue_new_event is bound to event_outbox INSERT';
  END IF;

  INSERT INTO public.pathway_projector_inbox
    (tenant_id, consumer_key, generation, event_id)
  SELECT NEW.tenant_id, offsets.consumer_key, offsets.generation, NEW.id
    FROM public.event_consumer_offsets AS offsets
   WHERE offsets.intake_retired_at IS NULL
  ON CONFLICT (tenant_id, consumer_key, generation, event_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pathway_projector_enqueue_new_event ON public.event_outbox;
CREATE TRIGGER pathway_projector_enqueue_new_event
AFTER INSERT ON public.event_outbox
FOR EACH ROW
EXECUTE FUNCTION public.pathway_projector_enqueue_new_event();

REVOKE ALL PRIVILEGES
  ON FUNCTION public.pathway_projector_enqueue_new_event()
  FROM PUBLIC;

DO $$
BEGIN
  IF pg_catalog.to_regrole('vhhealth_app') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON FUNCTION public.pathway_projector_enqueue_new_event() FROM vhhealth_app';
  END IF;
  IF pg_catalog.to_regrole('vhhealth_runtime') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON FUNCTION public.pathway_projector_enqueue_new_event() FROM vhhealth_runtime';
  END IF;
END;
$$;

SET LOCAL search_path = pg_catalog, public;
