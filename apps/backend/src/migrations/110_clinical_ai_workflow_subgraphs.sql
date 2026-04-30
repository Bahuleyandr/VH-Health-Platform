-- Subgraph composition for the workflow graph runner.
--
-- A parent node calls ctx.runSubgraph(...) which spawns a child run
-- linked back to the parent via parent_run_id and parent_node. This
-- migration adds those columns + an index for the "find children of
-- this run" query that observability dashboards and the resume-cascade
-- use.
--
-- The child run is a regular row in clinical_ai_workflow_runs — same
-- table, same RLS, same checkpoint layout. The only difference is the
-- two parent_* columns. Top-level runs leave them NULL.
--
-- One subgraph per parent node by convention (enforced in the runner,
-- not the schema): the runner stashes parent_state.__subgraphs[parent_node]
-- = child_run_id so a parent resume re-enters the same node and finds
-- the same child. Multiple parallel children per parent node is a
-- future extension and would relax the convention.

ALTER TABLE clinical_ai_workflow_runs
  ADD COLUMN IF NOT EXISTS parent_run_id INTEGER
    REFERENCES clinical_ai_workflow_runs(id) ON DELETE SET NULL;

ALTER TABLE clinical_ai_workflow_runs
  ADD COLUMN IF NOT EXISTS parent_node VARCHAR(80);

-- "List children of a parent run" — used by observability dashboards
-- (show the tree of nested runs for a given top-level workflow) and
-- the resume cascade (advance the parent once a child completes). Full
-- (non-partial) so Prisma's introspection can represent it cleanly in
-- schema.prisma; the b-tree on a nullable column simply doesn't index
-- NULLs by default in Postgres anyway.
CREATE INDEX IF NOT EXISTS idx_clinical_ai_workflow_runs_parent
  ON clinical_ai_workflow_runs (parent_run_id, started_at DESC);

COMMENT ON COLUMN clinical_ai_workflow_runs.parent_run_id IS
  'When non-NULL, this run is a subgraph spawned from the parent run. NULL for top-level workflows.';
COMMENT ON COLUMN clinical_ai_workflow_runs.parent_node IS
  'Name of the parent node that spawned this subgraph (matches the key in parent_run.state.__subgraphs).';
