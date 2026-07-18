-- Unified Care Pathways S1b-a: tenant-safe dormant workflow runtime.
--
-- This migration adds no workflow definition or active pathway. It rejects
-- legacy cross-tenant links before replacing the workflow scaffold's
-- single-column foreign keys with tenant-qualified equivalents.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM workflow_runs AS child
      JOIN workflow_definitions AS parent
        ON parent.id = child.workflow_definition_id
     WHERE child.workflow_definition_id IS NOT NULL
       AND child.tenant_id IS DISTINCT FROM parent.tenant_id
  ) THEN
    RAISE EXCEPTION
      'migration 579 blocked: workflow_runs.workflow_definition_id crosses tenants';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM workflow_steps AS child
      JOIN workflow_runs AS parent
        ON parent.id = child.workflow_run_id
     WHERE child.tenant_id IS DISTINCT FROM parent.tenant_id
  ) THEN
    RAISE EXCEPTION
      'migration 579 blocked: workflow_steps.workflow_run_id crosses tenants';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM tasks AS child
      JOIN workflow_runs AS parent
        ON parent.id = child.workflow_run_id
     WHERE child.workflow_run_id IS NOT NULL
       AND child.tenant_id IS DISTINCT FROM parent.tenant_id
  ) THEN
    RAISE EXCEPTION
      'migration 579 blocked: tasks.workflow_run_id crosses tenants';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM tasks AS child
      JOIN workflow_steps AS parent
        ON parent.id = child.workflow_step_id
     WHERE child.workflow_step_id IS NOT NULL
       AND child.tenant_id IS DISTINCT FROM parent.tenant_id
  ) THEN
    RAISE EXCEPTION
      'migration 579 blocked: tasks.workflow_step_id crosses tenants';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM tasks AS child
      JOIN tasks AS parent
        ON parent.id = child.parent_task_id
     WHERE child.parent_task_id IS NOT NULL
       AND child.tenant_id IS DISTINCT FROM parent.tenant_id
  ) THEN
    RAISE EXCEPTION
      'migration 579 blocked: tasks.parent_task_id crosses tenants';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM task_comments AS child
      JOIN tasks AS parent
        ON parent.id = child.task_id
     WHERE child.tenant_id IS DISTINCT FROM parent.tenant_id
  ) THEN
    RAISE EXCEPTION
      'migration 579 blocked: task_comments.task_id crosses tenants';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM approvals AS child
      JOIN workflow_runs AS parent
        ON parent.id = child.workflow_run_id
     WHERE child.workflow_run_id IS NOT NULL
       AND child.tenant_id IS DISTINCT FROM parent.tenant_id
  ) THEN
    RAISE EXCEPTION
      'migration 579 blocked: approvals.workflow_run_id crosses tenants';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM approvals AS child
      JOIN tasks AS parent
        ON parent.id = child.task_id
     WHERE child.task_id IS NOT NULL
       AND child.tenant_id IS DISTINCT FROM parent.tenant_id
  ) THEN
    RAISE EXCEPTION
      'migration 579 blocked: approvals.task_id crosses tenants';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_definitions_tenant_id
  ON workflow_definitions (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_runs_tenant_id
  ON workflow_runs (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_steps_tenant_id
  ON workflow_steps (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_tenant_id
  ON tasks (tenant_id, id);

ALTER TABLE workflow_runs
  DROP CONSTRAINT IF EXISTS workflow_runs_workflow_definition_id_fkey;
ALTER TABLE workflow_steps
  DROP CONSTRAINT IF EXISTS workflow_steps_workflow_run_id_fkey;
ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_workflow_run_id_fkey,
  DROP CONSTRAINT IF EXISTS tasks_workflow_step_id_fkey,
  DROP CONSTRAINT IF EXISTS tasks_parent_task_id_fkey;
ALTER TABLE task_comments
  DROP CONSTRAINT IF EXISTS task_comments_task_id_fkey;
ALTER TABLE approvals
  DROP CONSTRAINT IF EXISTS approvals_workflow_run_id_fkey,
  DROP CONSTRAINT IF EXISTS approvals_task_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_workflow_runs_definition_tenant'
       AND conrelid = 'workflow_runs'::regclass
  ) THEN
    ALTER TABLE workflow_runs
      ADD CONSTRAINT fk_workflow_runs_definition_tenant
      FOREIGN KEY (tenant_id, workflow_definition_id)
      REFERENCES workflow_definitions (tenant_id, id)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (workflow_definition_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_workflow_steps_run_tenant'
       AND conrelid = 'workflow_steps'::regclass
  ) THEN
    ALTER TABLE workflow_steps
      ADD CONSTRAINT fk_workflow_steps_run_tenant
      FOREIGN KEY (tenant_id, workflow_run_id)
      REFERENCES workflow_runs (tenant_id, id)
      ON UPDATE NO ACTION
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_tasks_workflow_run_tenant'
       AND conrelid = 'tasks'::regclass
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_workflow_run_tenant
      FOREIGN KEY (tenant_id, workflow_run_id)
      REFERENCES workflow_runs (tenant_id, id)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (workflow_run_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_tasks_workflow_step_tenant'
       AND conrelid = 'tasks'::regclass
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_workflow_step_tenant
      FOREIGN KEY (tenant_id, workflow_step_id)
      REFERENCES workflow_steps (tenant_id, id)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (workflow_step_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_tasks_parent_tenant'
       AND conrelid = 'tasks'::regclass
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_parent_tenant
      FOREIGN KEY (tenant_id, parent_task_id)
      REFERENCES tasks (tenant_id, id)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (parent_task_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_task_comments_task_tenant'
       AND conrelid = 'task_comments'::regclass
  ) THEN
    ALTER TABLE task_comments
      ADD CONSTRAINT fk_task_comments_task_tenant
      FOREIGN KEY (tenant_id, task_id)
      REFERENCES tasks (tenant_id, id)
      ON UPDATE NO ACTION
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_approvals_workflow_run_tenant'
       AND conrelid = 'approvals'::regclass
  ) THEN
    ALTER TABLE approvals
      ADD CONSTRAINT fk_approvals_workflow_run_tenant
      FOREIGN KEY (tenant_id, workflow_run_id)
      REFERENCES workflow_runs (tenant_id, id)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (workflow_run_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_approvals_task_tenant'
       AND conrelid = 'approvals'::regclass
  ) THEN
    ALTER TABLE approvals
      ADD CONSTRAINT fk_approvals_task_tenant
      FOREIGN KEY (tenant_id, task_id)
      REFERENCES tasks (tenant_id, id)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (task_id);
  END IF;
END
$$;

ALTER TABLE workflow_definitions
  ALTER COLUMN is_active SET DEFAULT false;

COMMIT;
