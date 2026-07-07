-- 399_outbreak_episodes.sql
--
-- N6-6 infection-control depth: outbreak episode registry, line-list case
-- linking, and clustered episode analysis source tables.

BEGIN;

CREATE TABLE IF NOT EXISTS outbreak_episodes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  episode_code VARCHAR(60) NOT NULL,
  organism VARCHAR(255) NOT NULL,
  ward VARCHAR(255),
  status VARCHAR(30) NOT NULL DEFAULT 'suspected',
  suspected_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ(6),
  closed_at TIMESTAMPTZ(6),
  opened_by UUID NOT NULL,
  closed_by UUID,
  line_list_notes TEXT,
  cluster_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT outbreak_episode_status_check
    CHECK (status IN ('suspected', 'confirmed', 'closed')),
  CONSTRAINT uq_outbreak_episode_code
    UNIQUE (tenant_id, episode_code),
  CONSTRAINT fk_outbreak_episodes_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS outbreak_episode_cases (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  episode_id BIGINT NOT NULL,
  infection_case_id INTEGER NOT NULL,
  admission_id INTEGER,
  patient_uid UUID NOT NULL,
  case_status VARCHAR(30) NOT NULL DEFAULT 'suspected',
  linked_by UUID NOT NULL,
  linked_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT outbreak_episode_case_status_check
    CHECK (case_status IN ('suspected', 'confirmed', 'ruled_out')),
  CONSTRAINT uq_outbreak_episode_case
    UNIQUE (tenant_id, episode_id, infection_case_id),
  CONSTRAINT fk_outbreak_episode_cases_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_outbreak_episode_cases_episode
    FOREIGN KEY (episode_id) REFERENCES outbreak_episodes(id) ON DELETE CASCADE,
  CONSTRAINT fk_outbreak_episode_cases_case
    FOREIGN KEY (infection_case_id) REFERENCES infection_cases(id) ON DELETE CASCADE,
  CONSTRAINT fk_outbreak_episode_cases_admission
    FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE SET NULL,
  CONSTRAINT fk_outbreak_episode_cases_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_outbreak_episodes_status
  ON outbreak_episodes (tenant_id, status, suspected_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbreak_episodes_organism_ward
  ON outbreak_episodes (tenant_id, organism, ward, suspected_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbreak_episode_cases_patient
  ON outbreak_episode_cases (tenant_id, patient_uid, linked_at DESC);

ALTER TABLE outbreak_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbreak_episodes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON outbreak_episodes;
CREATE POLICY tenant_isolation ON outbreak_episodes
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

ALTER TABLE outbreak_episode_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbreak_episode_cases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON outbreak_episode_cases;
CREATE POLICY tenant_isolation ON outbreak_episode_cases
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

COMMIT;
