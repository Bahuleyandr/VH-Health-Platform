-- Migration 122: Phase C3 — CarePlan / FollowUpPlan first-class entities.
--
-- HEALTHCARE_AI_SPEC_AUDIT.md §6 + §17 + top-10 punch list: today
-- "care plans" live as inline strings inside clinical_notes /
-- aftercare instructions. Patient app advertises care plans but the
-- backend can't return them as structured rows.
--
-- Tables:
--   1. care_plans            — top-level plan record (chronic disease,
--                                post-surgical, palliative, pediatric,
--                                pregnancy, custom). 8-state machine.
--   2. care_plan_goals       — measurable goals: HbA1c < 7, BP target,
--                                weight loss, smoking cessation. Each
--                                tracks start / target / actual values
--                                + status.
--   3. care_plan_activities  — actionable items: take metformin, fasting
--                                glucose every 3 months, daily 30-min
--                                walk, follow-up in 6 weeks. Owned by
--                                role/uid + scheduled.
--   4. follow_up_plans       — visit-specific follow-up after a
--                                consultation / discharge / OT case.
--                                Detached from CarePlan because most
--                                follow-ups are one-off.
--   5. care_plan_review_log  — append-only review history.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. care_plans
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS care_plans (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid                 UUID NOT NULL,
  plan_kind                   VARCHAR(40) NOT NULL DEFAULT 'general'
    CHECK (plan_kind IN (
      'general', 'chronic_disease', 'post_surgical', 'palliative',
      'pediatric', 'pregnancy', 'mental_health', 'rehab', 'preventive',
      'oncology', 'transplant', 'other'
    )),
  primary_condition           VARCHAR(255),
  primary_condition_icd10     VARCHAR(20),
  display_name                VARCHAR(255) NOT NULL,
  description                 TEXT,
  status                      VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled', 'archived', 'on_hold', 'superseded')),
  start_date                  DATE,
  target_end_date             DATE,
  actual_end_date             DATE,
  primary_doctor_uid          UUID,
  care_team_role              VARCHAR(80),
  encounter_id                INTEGER,
  facility_id                 INTEGER,
  is_patient_visible          BOOLEAN NOT NULL DEFAULT false,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  superseded_by_id            INTEGER REFERENCES care_plans(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_care_plan_window CHECK (
    target_end_date IS NULL OR start_date IS NULL OR target_end_date >= start_date
  )
);

CREATE INDEX IF NOT EXISTS idx_care_plans_tenant_status
  ON care_plans (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_care_plans_patient_status
  ON care_plans (tenant_id, patient_uid, status);
CREATE INDEX IF NOT EXISTS idx_care_plans_doctor
  ON care_plans (tenant_id, primary_doctor_uid, status)
  WHERE primary_doctor_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_care_plans_kind
  ON care_plans (tenant_id, plan_kind, status);
CREATE INDEX IF NOT EXISTS idx_care_plans_facility
  ON care_plans (tenant_id, facility_id)
  WHERE facility_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. care_plan_goals
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS care_plan_goals (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  care_plan_id                INTEGER NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  patient_uid                 UUID,
  goal_kind                   VARCHAR(40) NOT NULL DEFAULT 'clinical_target'
    CHECK (goal_kind IN (
      'clinical_target', 'lifestyle', 'medication_adherence', 'symptom_control',
      'self_management', 'education', 'screening', 'milestone', 'other'
    )),
  description                 TEXT NOT NULL,
  measurement_label           VARCHAR(120),
  measurement_unit            VARCHAR(40),
  baseline_value              VARCHAR(120),
  target_value                VARCHAR(120),
  current_value               VARCHAR(120),
  target_due_date             DATE,
  achieved_at                 TIMESTAMPTZ,
  priority                    VARCHAR(20) NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  status                      VARCHAR(20) NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'in_progress', 'achieved', 'not_achieved', 'cancelled', 'on_hold')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_care_plan_goals_plan
  ON care_plan_goals (care_plan_id, status);
CREATE INDEX IF NOT EXISTS idx_care_plan_goals_tenant_status
  ON care_plan_goals (tenant_id, status, target_due_date);
CREATE INDEX IF NOT EXISTS idx_care_plan_goals_patient
  ON care_plan_goals (tenant_id, patient_uid, status)
  WHERE patient_uid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. care_plan_activities
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS care_plan_activities (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  care_plan_id                INTEGER NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  related_goal_id             INTEGER REFERENCES care_plan_goals(id) ON DELETE SET NULL,
  patient_uid                 UUID,
  activity_kind               VARCHAR(40) NOT NULL DEFAULT 'task'
    CHECK (activity_kind IN (
      'task', 'medication', 'investigation', 'procedure', 'observation',
      'education', 'lifestyle', 'follow_up', 'self_check', 'other'
    )),
  title                       VARCHAR(255) NOT NULL,
  description                 TEXT,
  schedule_kind               VARCHAR(20) NOT NULL DEFAULT 'one_time'
    CHECK (schedule_kind IN ('one_time', 'daily', 'weekly', 'monthly', 'on_event', 'as_needed')),
  schedule_payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_start             TIMESTAMPTZ,
  scheduled_end               TIMESTAMPTZ,
  next_due_at                 TIMESTAMPTZ,
  assigned_to_uid             UUID,
  assigned_to_role            VARCHAR(80),
  status                      VARCHAR(20) NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled', 'overdue', 'skipped')),
  completion_count            INTEGER NOT NULL DEFAULT 0,
  expected_count              INTEGER,
  is_patient_facing           BOOLEAN NOT NULL DEFAULT true,
  task_id                     INTEGER,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_care_plan_activities_plan
  ON care_plan_activities (care_plan_id, status);
CREATE INDEX IF NOT EXISTS idx_care_plan_activities_tenant_due
  ON care_plan_activities (tenant_id, status, next_due_at)
  WHERE next_due_at IS NOT NULL AND status IN ('planned', 'in_progress', 'overdue');
CREATE INDEX IF NOT EXISTS idx_care_plan_activities_patient
  ON care_plan_activities (tenant_id, patient_uid, status)
  WHERE patient_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_care_plan_activities_assigned
  ON care_plan_activities (tenant_id, assigned_to_uid, status)
  WHERE assigned_to_uid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. follow_up_plans
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS follow_up_plans (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid                 UUID NOT NULL,
  origin_kind                 VARCHAR(40) NOT NULL
    CHECK (origin_kind IN (
      'consultation', 'discharge', 'ot_case', 'er_visit', 'admission',
      'investigation', 'teleconsult', 'manual', 'other'
    )),
  origin_resource_type        VARCHAR(60),
  origin_resource_id          VARCHAR(120),
  encounter_id                INTEGER,
  doctor_uid                  UUID,
  facility_id                 INTEGER,
  care_plan_id                INTEGER REFERENCES care_plans(id) ON DELETE SET NULL,
  due_at                      TIMESTAMPTZ,
  appointment_id              INTEGER,
  appointment_status          VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (appointment_status IN ('pending', 'scheduled', 'completed', 'cancelled', 'no_show')),
  reason                      TEXT,
  reminder_offsets_minutes    INTEGER[],
  reminder_last_sent_at       TIMESTAMPTZ,
  status                      VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'scheduled', 'completed', 'cancelled', 'overdue', 'lost_to_followup')),
  closed_at                   TIMESTAMPTZ,
  closure_outcome             VARCHAR(60),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_follow_up_tenant_status
  ON follow_up_plans (tenant_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_follow_up_patient
  ON follow_up_plans (tenant_id, patient_uid, status);
CREATE INDEX IF NOT EXISTS idx_follow_up_origin
  ON follow_up_plans (tenant_id, origin_kind, origin_resource_id)
  WHERE origin_resource_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_follow_up_overdue
  ON follow_up_plans (tenant_id, due_at)
  WHERE status = 'open' AND due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_follow_up_care_plan
  ON follow_up_plans (care_plan_id) WHERE care_plan_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. care_plan_review_log (append-only review history)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS care_plan_review_log (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  care_plan_id                INTEGER NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  reviewer_uid                UUID,
  reviewer_role               VARCHAR(80),
  event_kind                  VARCHAR(40) NOT NULL
    CHECK (event_kind IN (
      'created', 'reviewed', 'updated', 'goal_added', 'goal_completed',
      'activity_added', 'paused', 'resumed', 'completed', 'cancelled',
      'superseded', 'comment'
    )),
  notes                       TEXT,
  payload                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_care_plan_review_log_plan
  ON care_plan_review_log (care_plan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_care_plan_review_log_tenant
  ON care_plan_review_log (tenant_id, created_at DESC);

COMMIT;
