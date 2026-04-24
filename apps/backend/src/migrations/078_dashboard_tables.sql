-- 078_dashboard_tables.sql
-- Creates four tables the dashboard services query but that were never
-- ported into src/migrations/ when that became the canonical tree:
--
--   - diet_orders       (src/services/dietary/dietaryService.js)
--   - quality_incidents (src/services/quality/qualityService.js)
--   - infection_cases   (src/services/quality/qualityService.js, infection-surveillance surface)
--   - referrals         (src/services/referral/referralService.js)
--
-- Symptoms before this migration: /dashboard/dietary, /dashboard/quality,
-- /dashboard/referral all surfaced `relation "foo" does not exist` toasts
-- in the admin UI (see batch 17 walkthrough notes).
--
-- Note: migration 009 has a conditional ALTER on `referrals` that only
-- fires if the table exists. With this migration landing before it on a
-- fresh DB, the sequencing is: 009 runs first, sees no table, skips the
-- ALTER; 078 creates the table. On an already-migrated DB, both are safe
-- because every column/index is `IF NOT EXISTS`.
--
-- Column types derived from the service-layer queries:
--   - *_uid / *_by / *_doctor / *_id: UUID (services cast $N::uuid)
--   - numbers, dates, text, arrays: per-query usage
--
-- Status defaults mirror the lowercase string literals the services
-- compare against (e.g. referralService.acceptReferral checks for
-- status === 'pending'). Do NOT change these to uppercase without also
-- updating the services.

-- ─── diet_orders ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS diet_orders (
  id                   SERIAL PRIMARY KEY,
  patient_uid          UUID          NOT NULL,
  encounter_id         UUID,
  diet_type            VARCHAR(50)   NOT NULL,
  restrictions         TEXT[]        NOT NULL DEFAULT '{}',
  allergies            TEXT[]        NOT NULL DEFAULT '{}',
  meal_preferences     TEXT,
  calories_target      NUMERIC(8,2),
  special_instructions TEXT,
  status               VARCHAR(50)   NOT NULL DEFAULT 'active',
  ordered_by           UUID          NOT NULL,
  reviewed_by          UUID,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_diet_orders_patient_uid ON diet_orders(patient_uid);
CREATE INDEX IF NOT EXISTS idx_diet_orders_status      ON diet_orders(status);
CREATE INDEX IF NOT EXISTS idx_diet_orders_created_at  ON diet_orders(created_at DESC);

-- ─── quality_incidents ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quality_incidents (
  id                 SERIAL PRIMARY KEY,
  incident_number    VARCHAR(50)   NOT NULL UNIQUE,
  reported_by        UUID          NOT NULL,
  patient_uid        UUID,
  incident_type      VARCHAR(50)   NOT NULL,
  severity           VARCHAR(20)   NOT NULL,
  description        TEXT          NOT NULL,
  location           TEXT,
  date_occurred      TIMESTAMPTZ   NOT NULL,
  status             VARCHAR(50)   NOT NULL DEFAULT 'reported',
  root_cause         TEXT,
  corrective_action  TEXT,
  preventive_action  TEXT,
  investigated_by    UUID,
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quality_incidents_status      ON quality_incidents(status);
CREATE INDEX IF NOT EXISTS idx_quality_incidents_severity    ON quality_incidents(severity);
CREATE INDEX IF NOT EXISTS idx_quality_incidents_type        ON quality_incidents(incident_type);
CREATE INDEX IF NOT EXISTS idx_quality_incidents_patient_uid ON quality_incidents(patient_uid);
CREATE INDEX IF NOT EXISTS idx_quality_incidents_created_at  ON quality_incidents(created_at DESC);

-- ─── infection_cases ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infection_cases (
  id                     SERIAL PRIMARY KEY,
  patient_uid            UUID          NOT NULL,
  encounter_id           UUID,
  organism               VARCHAR(255)  NOT NULL,
  infection_site         VARCHAR(50)   NOT NULL,
  detection_date         TIMESTAMPTZ   NOT NULL,
  culture_date           TIMESTAMPTZ,
  antibiotic_sensitivity JSONB,
  isolation_required     BOOLEAN       NOT NULL DEFAULT FALSE,
  isolation_type         VARCHAR(50),
  status                 VARCHAR(50)   NOT NULL DEFAULT 'active',
  treatment_notes        TEXT,
  reported_by            UUID          NOT NULL,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_infection_cases_patient_uid    ON infection_cases(patient_uid);
CREATE INDEX IF NOT EXISTS idx_infection_cases_status         ON infection_cases(status);
CREATE INDEX IF NOT EXISTS idx_infection_cases_organism       ON infection_cases(organism);
CREATE INDEX IF NOT EXISTS idx_infection_cases_detection_date ON infection_cases(detection_date DESC);

-- ─── referrals ───────────────────────────────────────────────────────
-- Matches migration 009's ALTER-when-exists contract so column types agree.
-- Service-layer queries (src/services/referral/referralService.js) drive
-- the column list here; we add everything they need.

CREATE TABLE IF NOT EXISTS referrals (
  id                     SERIAL PRIMARY KEY,
  referral_number        VARCHAR(50)  NOT NULL UNIQUE,
  patient_uid            UUID         NOT NULL,
  encounter_id           UUID,
  referring_doctor       UUID         NOT NULL,
  referred_to_doctor     UUID,
  referred_to_department TEXT         NOT NULL,
  referral_type          VARCHAR(20)  NOT NULL DEFAULT 'internal',
  reason                 TEXT         NOT NULL,
  urgency                VARCHAR(20)  NOT NULL DEFAULT 'routine',
  clinical_summary       TEXT,
  status                 VARCHAR(20)  NOT NULL DEFAULT 'pending',
  accepted_by            UUID,
  accepted_at            TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  response_notes         TEXT,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referrals_patient_uid        ON referrals(patient_uid);
CREATE INDEX IF NOT EXISTS idx_referrals_referring_doctor   ON referrals(referring_doctor);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_to_doctor ON referrals(referred_to_doctor);
CREATE INDEX IF NOT EXISTS idx_referrals_status             ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_referrals_urgency            ON referrals(urgency);
CREATE INDEX IF NOT EXISTS idx_referrals_created_at         ON referrals(created_at DESC);
