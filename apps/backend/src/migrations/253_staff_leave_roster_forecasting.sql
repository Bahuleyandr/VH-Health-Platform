-- Advisory AI/rules-assisted leave and roster forecasting.
--
-- These tables are tenant-scoped and intentionally advisory. Forecasts can
-- warn HR/incharges about likely staffing risk, but they do not approve leave,
-- block leave, publish rosters, or alter staff assignments automatically.

BEGIN;

CREATE TABLE IF NOT EXISTS roster_calendar_events (
  id                  SERIAL PRIMARY KEY,
  tenant_id            UUID NOT NULL REFERENCES tenants(id),
  title                VARCHAR(180) NOT NULL,
  event_type           VARCHAR(60) NOT NULL DEFAULT 'custom',
  start_date           DATE NOT NULL,
  end_date             DATE NOT NULL,
  risk_weight          INTEGER NOT NULL DEFAULT 10,
  applies_departments  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  notes                TEXT,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_by           INTEGER,
  created_by_uid       UUID,
  updated_by           INTEGER,
  updated_by_uid       UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT roster_calendar_events_date_chk CHECK (end_date >= start_date),
  CONSTRAINT roster_calendar_events_weight_chk CHECK (risk_weight BETWEEN 0 AND 40)
);

CREATE INDEX IF NOT EXISTS idx_roster_calendar_events_tenant_dates
  ON roster_calendar_events(tenant_id, start_date, end_date)
  WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS staff_commute_profiles (
  id             SERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  staff_id        INTEGER NOT NULL,
  staff_uid       UUID,
  commute_band    VARCHAR(40) NOT NULL DEFAULT 'unknown',
  travel_mode     VARCHAR(60),
  area_label      VARCHAR(160),
  risk_weight     INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by      INTEGER,
  updated_by_uid  UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_commute_profiles_band_chk
    CHECK (commute_band IN ('unknown', 'onsite', 'near', 'medium', 'long', 'very_long')),
  CONSTRAINT staff_commute_profiles_weight_chk CHECK (risk_weight BETWEEN 0 AND 30),
  CONSTRAINT staff_commute_profiles_unique_staff UNIQUE (tenant_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_commute_profiles_tenant_active
  ON staff_commute_profiles(tenant_id, staff_id)
  WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS staff_commute_profile_audit (
  id               SERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  commute_profile_id INTEGER REFERENCES staff_commute_profiles(id) ON DELETE SET NULL,
  staff_id          INTEGER,
  actor_id          INTEGER,
  actor_uid         UUID,
  action            VARCHAR(40) NOT NULL,
  reason            TEXT,
  before_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_commute_profile_audit_staff
  ON staff_commute_profile_audit(tenant_id, staff_id, created_at DESC);

CREATE TABLE IF NOT EXISTS roster_weather_signals (
  id              SERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  signal_date      DATE NOT NULL,
  area_label       VARCHAR(160),
  signal_type      VARCHAR(80) NOT NULL,
  severity         VARCHAR(20) NOT NULL DEFAULT 'normal',
  provider         VARCHAR(80) NOT NULL DEFAULT 'manual',
  provider_status  VARCHAR(40) NOT NULL DEFAULT 'manual',
  confidence_pct   INTEGER NOT NULL DEFAULT 60,
  risk_weight      INTEGER NOT NULL DEFAULT 0,
  is_manual        BOOLEAN NOT NULL DEFAULT TRUE,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes            TEXT,
  created_by       INTEGER,
  created_by_uid   UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT roster_weather_signals_severity_chk
    CHECK (severity IN ('normal', 'watch', 'moderate', 'high', 'severe')),
  CONSTRAINT roster_weather_signals_confidence_chk CHECK (confidence_pct BETWEEN 0 AND 100),
  CONSTRAINT roster_weather_signals_weight_chk CHECK (risk_weight BETWEEN 0 AND 40)
);

CREATE INDEX IF NOT EXISTS idx_roster_weather_signals_tenant_date
  ON roster_weather_signals(tenant_id, signal_date);

CREATE TABLE IF NOT EXISTS staff_leave_forecast_runs (
  id                   SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  department            VARCHAR(80) NOT NULL,
  start_date            DATE NOT NULL,
  end_date              DATE NOT NULL,
  forecast_window_days  INTEGER NOT NULL DEFAULT 84,
  generation_id         INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  governance_state      VARCHAR(30) NOT NULL DEFAULT 'fallback',
  generation_mode       VARCHAR(40) NOT NULL DEFAULT 'rules_forecast',
  provider_status       VARCHAR(40) NOT NULL DEFAULT 'not_used',
  fallback_reason       TEXT,
  source_count          INTEGER NOT NULL DEFAULT 0,
  review_status         VARCHAR(30) NOT NULL DEFAULT 'pending',
  reviewed_by           INTEGER,
  reviewed_by_uid       UUID,
  reviewed_at           TIMESTAMPTZ,
  reviewer_notes        TEXT,
  requested_by          INTEGER,
  requested_by_uid      UUID,
  summary               JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_breakdown      JSONB NOT NULL DEFAULT '{}'::jsonb,
  safety_flags          JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_leave_forecast_runs_date_chk CHECK (end_date >= start_date),
  CONSTRAINT staff_leave_forecast_runs_state_chk
    CHECK (governance_state IN ('ai', 'fallback', 'blocked', 'schema-unavailable')),
  CONSTRAINT staff_leave_forecast_runs_review_chk
    CHECK (review_status IN ('pending', 'accepted', 'discarded'))
);

CREATE INDEX IF NOT EXISTS idx_staff_leave_forecast_runs_dept_range
  ON staff_leave_forecast_runs(tenant_id, department, start_date, end_date, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_leave_forecast_runs_review
  ON staff_leave_forecast_runs(tenant_id, review_status, created_at DESC);

CREATE TABLE IF NOT EXISTS staff_leave_forecast_scores (
  id              SERIAL PRIMARY KEY,
  run_id           INTEGER NOT NULL REFERENCES staff_leave_forecast_runs(id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  department       VARCHAR(80) NOT NULL,
  staff_id         INTEGER NOT NULL,
  staff_uid        UUID,
  staff_name       VARCHAR(255),
  staff_role       VARCHAR(80),
  score            NUMERIC(5,2) NOT NULL DEFAULT 0,
  risk_band        VARCHAR(20) NOT NULL DEFAULT 'low',
  confidence_pct   INTEGER NOT NULL DEFAULT 0,
  top_factors      JSONB NOT NULL DEFAULT '[]'::jsonb,
  date_risks       JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_leave_forecast_scores_band_chk
    CHECK (risk_band IN ('low', 'medium', 'high')),
  CONSTRAINT staff_leave_forecast_scores_score_chk CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT staff_leave_forecast_scores_confidence_chk CHECK (confidence_pct BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_staff_leave_forecast_scores_run
  ON staff_leave_forecast_scores(run_id, score DESC);

CREATE INDEX IF NOT EXISTS idx_staff_leave_forecast_scores_staff
  ON staff_leave_forecast_scores(tenant_id, staff_id, created_at DESC);

CREATE TABLE IF NOT EXISTS staff_leave_forecast_shift_risks (
  id                       SERIAL PRIMARY KEY,
  run_id                    INTEGER NOT NULL REFERENCES staff_leave_forecast_runs(id) ON DELETE CASCADE,
  tenant_id                 UUID NOT NULL REFERENCES tenants(id),
  department                VARCHAR(80) NOT NULL,
  forecast_date             DATE NOT NULL,
  shift_label               VARCHAR(80) NOT NULL DEFAULT 'all',
  risk_score                NUMERIC(5,2) NOT NULL DEFAULT 0,
  risk_band                 VARCHAR(20) NOT NULL DEFAULT 'low',
  predicted_absences        INTEGER NOT NULL DEFAULT 0,
  recommended_buffer_count  INTEGER NOT NULL DEFAULT 0,
  top_factors               JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_snapshot           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_leave_forecast_shift_risks_band_chk
    CHECK (risk_band IN ('low', 'medium', 'high')),
  CONSTRAINT staff_leave_forecast_shift_risks_score_chk CHECK (risk_score BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_staff_leave_forecast_shift_risks_run_date
  ON staff_leave_forecast_shift_risks(run_id, forecast_date, shift_label);

CREATE TABLE IF NOT EXISTS staff_leave_forecast_audit (
  id               SERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  run_id            INTEGER REFERENCES staff_leave_forecast_runs(id) ON DELETE SET NULL,
  actor_id          INTEGER,
  actor_uid         UUID,
  action            VARCHAR(60) NOT NULL,
  reason            TEXT,
  before_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_leave_forecast_audit_run
  ON staff_leave_forecast_audit(tenant_id, run_id, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES (
  'staff_roster_optimizer',
  'Staff Roster Optimizer',
  'Advisory shift roster and leave-clustering forecast. HR/incharge reviews before use.',
  false,
  '{"surface":"operations","risk":"low","status":"available","requiresClinicianSignoff":false,"reviewRoles":["ADMIN","HR_STAFF","DEPARTMENT_HEAD"],"outputSchema":{"type":"object","required":["assignments","coverage_gaps","preference_conflicts","leave_forecast"]},"retentionDays":365,"decisionSupportOnly":true}'::jsonb
)
ON CONFLICT (module_key)
DO UPDATE SET
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings
    || '{"decisionSupportOnly":true,"forecastWindowDays":84}'::jsonb,
  updated_at = NOW();

COMMIT;
