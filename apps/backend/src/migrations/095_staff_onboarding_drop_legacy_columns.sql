-- Migration 095: batch-57 — drop legacy staff_onboarding_tasks.status +
-- completed_at columns now that the table is exclusively read/written via
-- the new completion-workflow columns added in 088.
--
-- staff_onboarding_tasks had two parallel completion-state surfaces:
--   * (status text, completed_at timestamp)        — original schema
--   * (completed bool, completed_by uuid,
--      completed_date timestamp, updated_at)        — added in 088
--
-- onboardingService.js only writes/reads the new set; the admin and
-- Flutter trees never referenced the legacy pair (greps clean across
-- apps/admin + packages + apps/backend). Table is empty in dev/prod, so
-- the drop is data-safe.

BEGIN;

ALTER TABLE staff_onboarding_tasks
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS completed_at;

COMMIT;
