-- NL-13 P1e: admit cath procedure completions into the NL9-P3 follow-up loop
-- rails. Config lives in tenants.settings.cathQuickWins (owner-decision inert
-- slot; no mapping table needed), so this migration only widens the two CHECK
-- constraints on engagement_follow_up_loops:
--   source_type += 'cath_procedure'   (completion facts from cath_procedure_logs)
--   loop_type   += 'cath_procedure_follow_up' (owner-template staff-review loops)
-- No rows are written here; loops stay inert until a tenant owner publishes a
-- procedure-type -> loop-template mapping in settings.

BEGIN;

DO $$
DECLARE
  con RECORD;
BEGIN
  FOR con IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'engagement_follow_up_loops'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%source_type%'
  LOOP
    EXECUTE format('ALTER TABLE engagement_follow_up_loops DROP CONSTRAINT %I', con.conname);
  END LOOP;

  FOR con IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'engagement_follow_up_loops'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%loop_type%'
  LOOP
    EXECUTE format('ALTER TABLE engagement_follow_up_loops DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE engagement_follow_up_loops
  ADD CONSTRAINT engagement_follow_up_loops_source_type_check
  CHECK (source_type IN (
    'teleconsultation',
    'appointment',
    'rpm_enrollment',
    'feedback_task',
    'cath_procedure'
  ));

ALTER TABLE engagement_follow_up_loops
  ADD CONSTRAINT engagement_follow_up_loops_loop_type_check
  CHECK (loop_type IN (
    'clinician_follow_up_due_date',
    'investigation_ordered',
    'prescription_created',
    'secure_message_fallback',
    'teleconsult_completed',
    'cath_procedure_follow_up'
  ));

COMMIT;
