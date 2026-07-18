-- Unified Care Pathways S1a: retained shadow projector work ledger.

CREATE TABLE IF NOT EXISTS pathway_projector_inbox (
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
    PRIMARY KEY (consumer_key, generation, event_id),
  CONSTRAINT fk_pathway_projector_inbox_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
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
  ON pathway_projector_inbox (consumer_key, generation, next_attempt_at, event_id)
  WHERE status = 'pending' AND lease_owner IS NULL;

CREATE INDEX IF NOT EXISTS idx_pathway_projector_inbox_stale
  ON pathway_projector_inbox (consumer_key, generation, lease_expires_at, event_id)
  WHERE status = 'pending' AND lease_owner IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pathway_projector_inbox_tenant_ops
  ON pathway_projector_inbox (tenant_id, consumer_key, generation, status, event_id);

ALTER TABLE pathway_projector_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE pathway_projector_inbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON pathway_projector_inbox;
CREATE POLICY tenant_isolation ON pathway_projector_inbox
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
  );
