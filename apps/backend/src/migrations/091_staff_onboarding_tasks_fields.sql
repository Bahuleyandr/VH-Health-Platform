-- Migration 091: batch-51 — add staff_onboarding_tasks fields that
-- onboardingService has been falling back to hardcoded defaults for.
--
-- The SELECT at onboardingService.js:28-34 reads description,
-- assigned_to, due_date, priority — none of which exist in the
-- schema. The raw query threw at runtime and a try/catch served a
-- fixed 6-item default list instead. Adding the columns lets the
-- ORM-rewritten service return real per-staff onboarding checklists.

BEGIN;

ALTER TABLE staff_onboarding_tasks
  ADD COLUMN IF NOT EXISTS description  TEXT,
  ADD COLUMN IF NOT EXISTS assigned_to  UUID,
  ADD COLUMN IF NOT EXISTS due_date     DATE,
  ADD COLUMN IF NOT EXISTS priority     VARCHAR(20) DEFAULT 'medium';

CREATE INDEX IF NOT EXISTS idx_staff_onboarding_tasks_due ON staff_onboarding_tasks(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_onboarding_tasks_priority ON staff_onboarding_tasks(priority);

COMMIT;
