-- 709_sos_alert_drill_authorization.sql
--
-- Migration 692 is already filename-tracked in deployed databases and must
-- remain immutable. Add the server-derived drill provenance contract here so
-- both upgraded and fresh databases converge on the same schema.
--
-- Rows written by the old 692 contract can carry is_test_alert=TRUE without
-- authenticated actor provenance. Fail safe by turning those unproven drills
-- back into real alerts before the constraint is installed; this ensures the
-- age-escalation path cannot keep suppressing them.

ALTER TABLE public.sos_alerts
  ADD COLUMN IF NOT EXISTS test_alert_authorized_by UUID,
  ADD COLUMN IF NOT EXISTS test_alert_authorized_role VARCHAR(50);

UPDATE public.sos_alerts
   SET is_test_alert = FALSE,
       test_alert_authorized_by = NULL,
       test_alert_authorized_role = NULL
 WHERE (
         is_test_alert IS TRUE
         AND (
           test_alert_authorized_by IS NULL
           OR test_alert_authorized_role IS NULL
           OR test_alert_authorized_role NOT IN ('ADMIN', 'SUPER_ADMIN')
         )
       )
    OR (
         is_test_alert IS NOT TRUE
         AND (
           is_test_alert IS NULL
           OR test_alert_authorized_by IS NOT NULL
           OR test_alert_authorized_role IS NOT NULL
         )
       );

ALTER TABLE public.sos_alerts
  DROP CONSTRAINT IF EXISTS chk_sos_alert_test_authority,
  ADD CONSTRAINT chk_sos_alert_test_authority CHECK (
    (is_test_alert = FALSE
      AND test_alert_authorized_by IS NULL
      AND test_alert_authorized_role IS NULL)
    OR
    (is_test_alert = TRUE
      AND test_alert_authorized_by IS NOT NULL
      AND test_alert_authorized_role IN ('ADMIN', 'SUPER_ADMIN'))
  ) NOT VALID;

ALTER TABLE public.sos_alerts
  VALIDATE CONSTRAINT chk_sos_alert_test_authority;

COMMENT ON COLUMN public.sos_alerts.is_test_alert IS
  'TRUE only for an ADMIN/SUPER_ADMIN-authorized drill: creation fan-out and age escalation skip external alerting.';
COMMENT ON COLUMN public.sos_alerts.test_alert_authorized_by IS
  'Authenticated actor UID that authorized a drill; NULL for real alerts.';
COMMENT ON COLUMN public.sos_alerts.test_alert_authorized_role IS
  'Server-derived ADMIN or SUPER_ADMIN role that authorized a drill; NULL for real alerts.';
