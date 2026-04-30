-- Migration 118: Phase B2 — generic tasks / workflow / approval / SLA /
-- automation foundation (non-AI).
--
-- Today, "follow up on this patient" / "review this lab" tasks have no
-- home outside notifications and ad-hoc messaging. clinical_ai_workflow_runs
-- exists but is AI-specific. This migration adds the staff-facing
-- workflow stack that the AI engine can also opt into via foreign keys.
--
-- Tables:
--   1. workflow_definitions    — versioned definition rows; YAML-like
--                                  steps in JSONB. Each definition has
--                                  a key + version, stable across runs.
--   2. workflow_runs           — instance of a definition. State
--                                  machine: started → running → blocked
--                                  → completed | cancelled | failed.
--   3. workflow_steps          — per-run step rows. Mirrors definition
--                                  steps; tracks per-step status.
--   4. tasks                   — generic staff task. Non-AI follow-ups,
--                                  reviews, escalations. Linked to a
--                                  workflow_run optionally; stand-alone
--                                  tasks are equally valid.
--   5. task_comments           — append-only comment thread per task.
--   6. approvals               — discrete approval gate. Nested in a
--                                  workflow_run or attached to a task.
--   7. escalation_rules        — when {SLA breached, status pending too
--                                  long, etc.}, fire {notify, escalate,
--                                  reassign, auto-resolve}.
--   8. sla_definitions         — named SLA windows used by tasks +
--                                  workflow steps.
--   9. automation_rules        — domain-event-triggered rule engine
--                                  glue: on event_outbox event matches
--                                  filter, run action.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. workflow_definitions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_key                VARCHAR(120) NOT NULL,
  version                     INTEGER NOT NULL DEFAULT 1,
  display_name                VARCHAR(255),
  description                 TEXT,
  category                    VARCHAR(80),
  steps                       JSONB NOT NULL DEFAULT '[]'::jsonb,
  triggers                    JSONB NOT NULL DEFAULT '[]'::jsonb,
  defaults                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, workflow_key, version)
);

CREATE INDEX IF NOT EXISTS idx_workflow_defs_tenant_active
  ON workflow_definitions (tenant_id, is_active, workflow_key);
CREATE INDEX IF NOT EXISTS idx_workflow_defs_category
  ON workflow_definitions (tenant_id, category)
  WHERE category IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. workflow_runs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_runs (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_definition_id      INTEGER REFERENCES workflow_definitions(id) ON DELETE SET NULL,
  workflow_key                VARCHAR(120) NOT NULL,
  workflow_version            INTEGER NOT NULL DEFAULT 1,
  trigger_kind                VARCHAR(40) NOT NULL DEFAULT 'manual'
    CHECK (trigger_kind IN ('manual', 'event', 'schedule', 'api', 'subgraph')),
  trigger_payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                      VARCHAR(20) NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'running', 'blocked', 'completed', 'cancelled', 'failed')),
  current_step_key            VARCHAR(120),
  context                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at                    TIMESTAMPTZ,
  due_at                      TIMESTAMPTZ,
  initiated_by                UUID,
  failure_reason              TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_tenant_status
  ON workflow_runs (tenant_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_key_version
  ON workflow_runs (tenant_id, workflow_key, workflow_version, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_due
  ON workflow_runs (tenant_id, status, due_at)
  WHERE due_at IS NOT NULL AND status IN ('started', 'running', 'blocked');

-- ---------------------------------------------------------------------------
-- 3. workflow_steps (per run)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_steps (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id             INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key                    VARCHAR(120) NOT NULL,
  display_name                VARCHAR(255),
  step_kind                   VARCHAR(40) NOT NULL
    CHECK (step_kind IN ('task', 'approval', 'automation', 'wait', 'subworkflow', 'ai_call')),
  status                      VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'blocked', 'completed', 'skipped', 'failed')),
  ordering                    INTEGER NOT NULL DEFAULT 0,
  assigned_to                 UUID,
  assigned_role               VARCHAR(80),
  due_at                      TIMESTAMPTZ,
  started_at                  TIMESTAMPTZ,
  completed_at                TIMESTAMPTZ,
  outcome                     VARCHAR(40),
  outcome_payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workflow_run_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_order
  ON workflow_steps (workflow_run_id, ordering, step_key);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_tenant_status
  ON workflow_steps (tenant_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_assigned
  ON workflow_steps (tenant_id, assigned_to, status)
  WHERE assigned_to IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. tasks (generic, non-AI)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tasks (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id             INTEGER REFERENCES workflow_runs(id) ON DELETE SET NULL,
  workflow_step_id            INTEGER REFERENCES workflow_steps(id) ON DELETE SET NULL,
  parent_task_id              INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  task_kind                   VARCHAR(60) NOT NULL DEFAULT 'general'
    CHECK (task_kind IN ('general', 'follow_up', 'review', 'escalation', 'verification', 'admin', 'consent', 'investigation', 'other')),
  title                       VARCHAR(500) NOT NULL,
  description                 TEXT,
  patient_uid                 UUID,
  encounter_id                INTEGER,
  related_resource_type       VARCHAR(60),
  related_resource_id         VARCHAR(120),
  priority                    VARCHAR(20) NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  status                      VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'blocked', 'completed', 'cancelled', 'overdue')),
  assigned_to_uid             UUID,
  assigned_to_role            VARCHAR(80),
  created_by                  UUID,
  due_at                      TIMESTAMPTZ,
  completed_at                TIMESTAMPTZ,
  cancelled_at                TIMESTAMPTZ,
  cancellation_reason         TEXT,
  sla_definition_id           INTEGER,
  sla_breached_at             TIMESTAMPTZ,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status
  ON tasks (tenant_id, status, priority, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned
  ON tasks (tenant_id, assigned_to_uid, status)
  WHERE assigned_to_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_role
  ON tasks (tenant_id, assigned_to_role, status)
  WHERE assigned_to_role IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_patient
  ON tasks (tenant_id, patient_uid, status)
  WHERE patient_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_workflow
  ON tasks (workflow_run_id, status)
  WHERE workflow_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_due
  ON tasks (tenant_id, due_at)
  WHERE due_at IS NOT NULL AND status IN ('open', 'in_progress', 'blocked');

-- ---------------------------------------------------------------------------
-- 5. task_comments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_comments (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id                     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_uid                  UUID,
  body                        TEXT NOT NULL,
  body_kind                   VARCHAR(20) NOT NULL DEFAULT 'comment'
    CHECK (body_kind IN ('comment', 'system_event', 'state_change')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task
  ON task_comments (task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_comments_tenant
  ON task_comments (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 6. approvals (discrete gate)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approvals (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id             INTEGER REFERENCES workflow_runs(id) ON DELETE SET NULL,
  task_id                     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  approval_kind               VARCHAR(80) NOT NULL,
  subject_resource_type       VARCHAR(60),
  subject_resource_id         VARCHAR(120),
  required_approvers          INTEGER NOT NULL DEFAULT 1,
  required_role               VARCHAR(80),
  status                      VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  approved_by                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  rejection_reason            TEXT,
  expires_at                  TIMESTAMPTZ,
  decided_at                  TIMESTAMPTZ,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approvals_tenant_status
  ON approvals (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_workflow
  ON approvals (workflow_run_id) WHERE workflow_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approvals_task
  ON approvals (task_id) WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. escalation_rules
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS escalation_rules (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name                VARCHAR(255) NOT NULL,
  description                 TEXT,
  scope                       VARCHAR(40) NOT NULL DEFAULT 'task'
    CHECK (scope IN ('task', 'workflow_step', 'approval')),
  match_filter                JSONB NOT NULL DEFAULT '{}'::jsonb,
  trigger_condition           VARCHAR(40) NOT NULL
    CHECK (trigger_condition IN (
      'sla_breach', 'no_progress_after', 'pending_too_long', 'on_status_change'
    )),
  trigger_window_minutes      INTEGER,
  action_kind                 VARCHAR(40) NOT NULL
    CHECK (action_kind IN ('notify', 'reassign', 'escalate_priority', 'auto_resolve', 'webhook')),
  action_payload              JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escalation_rules_tenant_active
  ON escalation_rules (tenant_id, is_active, scope);

-- ---------------------------------------------------------------------------
-- 8. sla_definitions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sla_definitions (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sla_key                     VARCHAR(120) NOT NULL,
  display_name                VARCHAR(255),
  description                 TEXT,
  target_minutes              INTEGER NOT NULL,
  warn_at_pct                 INTEGER NOT NULL DEFAULT 75
    CHECK (warn_at_pct >= 0 AND warn_at_pct <= 100),
  business_hours_only         BOOLEAN NOT NULL DEFAULT false,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, sla_key)
);

CREATE INDEX IF NOT EXISTS idx_sla_definitions_tenant
  ON sla_definitions (tenant_id, sla_key);

-- ---------------------------------------------------------------------------
-- 9. automation_rules
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS automation_rules (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name                VARCHAR(255) NOT NULL,
  description                 TEXT,
  event_type                  VARCHAR(120) NOT NULL,
  match_filter                JSONB NOT NULL DEFAULT '{}'::jsonb,
  action_kind                 VARCHAR(40) NOT NULL
    CHECK (action_kind IN ('create_task', 'start_workflow', 'create_approval', 'webhook', 'notify')),
  action_payload              JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  last_fired_at               TIMESTAMPTZ,
  fire_count                  INTEGER NOT NULL DEFAULT 0,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_rules_tenant_event
  ON automation_rules (tenant_id, event_type, is_active);

COMMIT;
