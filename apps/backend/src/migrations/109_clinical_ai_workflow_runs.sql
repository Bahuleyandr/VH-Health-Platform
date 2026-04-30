-- Clinical AI workflow graph runs.
--
-- Persistent state for the framework-free DAG runner in
-- src/services/ai/workflowGraphRunner.js. One row per workflow execution;
-- the runner upserts on every node transition so a crashed/paused run can
-- be resumed without re-running completed nodes.
--
-- Use cases this enables (incrementally — not all live yet at insert
-- time):
--   * Crash recovery: a request that died mid-workflow can be resumed
--     from the last completed checkpoint (no double-side-effects from
--     already-run nodes).
--   * Long human-in-the-loop flows: a node can return {__pause: 'reason'}
--     and the run parks until an external event (governance approval,
--     payer prior-auth response, doctor sign-off) calls resumeWorkflow().
--   * Per-node observability: dashboards can see which step is slow,
--     which step fails, and which workflow keys are running hot.
--
-- The TauricResearch/TradingAgents analog is LangGraph's per-ticker
-- SQLite checkpoint database (~/.tradingagents/cache/checkpoints/) —
-- we reuse Postgres + RLS instead of introducing a sidecar.

CREATE TABLE IF NOT EXISTS clinical_ai_workflow_runs (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),

  -- The graph that's running. Matches WorkflowGraph.key in the runner;
  -- e.g. 'admission_ai_draft', 'discharge_summary_compose'.
  workflow_key VARCHAR(80) NOT NULL,

  -- Optional context used for filtering / dashboards. Not all workflows
  -- are admission-scoped (e.g. ward briefs are tenant-wide).
  module_key VARCHAR(80),
  patient_uid UUID,
  admission_id INTEGER,

  -- 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  status VARCHAR(40) NOT NULL DEFAULT 'running',

  -- Last node that finished successfully. NULL until the first node
  -- completes. The runner reads this on resume to pick up after the
  -- last completed node.
  current_node VARCHAR(80),

  -- Reason field used when status='paused'. The external event handler
  -- inspects this to decide whether to resume the run (e.g. an approval
  -- listener filters for runs paused with reason='await_governance').
  pause_reason VARCHAR(120),

  -- The shared state object passed between nodes. Updated after every
  -- successful node transition. May contain large packets — use the GIN
  -- index sparingly; most queries should target the b-tree indexes below.
  state JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- The final result returned to the caller (after the terminal node
  -- completes). NULL while running or paused.
  result JSONB,

  -- Set when status='failed'. Carries the node name + truncated message;
  -- full stack lives in the application logs.
  error_node VARCHAR(80),
  error_message TEXT,

  -- Per-node breadcrumb trail. Array of objects:
  --   { node, started_at, completed_at, duration_ms, status, error? }
  -- One entry per node transition, including failures. Used for
  -- dashboards and post-mortems.
  checkpoints JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Caller metadata (request_id, generated_by, etc.). Not interpreted by
  -- the runner; useful for audit + correlation.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  started_by UUID,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_workflow_runs_tenant_status
  ON clinical_ai_workflow_runs (tenant_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_workflow_runs_tenant_workflow
  ON clinical_ai_workflow_runs (tenant_id, workflow_key, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_workflow_runs_paused
  ON clinical_ai_workflow_runs (tenant_id, pause_reason, paused_at DESC)
  WHERE status = 'paused';

CREATE INDEX IF NOT EXISTS idx_clinical_ai_workflow_runs_admission
  ON clinical_ai_workflow_runs (tenant_id, admission_id, started_at DESC)
  WHERE admission_id IS NOT NULL;

-- Tenant RLS — same permissive-when-unset / strict-when-set pattern as
-- the rest of clinical_ai_*. Lets non-tenant code paths (CI seeds, test
-- fixtures) keep working while production requests get strict scope via
-- setTenant().
ALTER TABLE clinical_ai_workflow_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clinical_ai_workflow_runs_tenant_isolation ON clinical_ai_workflow_runs;
CREATE POLICY clinical_ai_workflow_runs_tenant_isolation
  ON clinical_ai_workflow_runs
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );

COMMENT ON TABLE clinical_ai_workflow_runs IS
  'Persistent state for the workflow graph runner (workflowGraphRunner.js). One row per execution; updated on every node transition for crash-resume and pause-for-approval.';
