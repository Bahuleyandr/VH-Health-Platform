-- Migration 089: batch-48 SELECT-path drift sweep — add columns that
-- live raw-SQL read surfaces reference but the schema never declared.
-- Extension of migration 088 (INSERT/UPDATE drift). Flagged by the
-- new FROM/JOIN-aware pass of `apps/backend/scripts/scan-code-drift.mjs`.
--
-- All additions are nullable / defaulted so the migration is safe to
-- apply to populated production data.

BEGIN;

-- ─── appointments (queue / SLA / admin workflow columns) ──────────────
-- Readers: controllers/appointment/appointmentWorkflowController.js
--          controllers/appointment/appointmentAdminController.js
--          routes/appointment/appointmentAdminRoutes.js
--          services/appointment/waitTimeService.js
--          utils/notifications/appointmentReminderJob.js
-- token_number is the per-doctor-per-day queue token shown in the
-- patient app and reminder SMS. department is the denormalised slot
-- for the common "filter by department" admin query (the doctors
-- table already has department, but joining on every query adds
-- cost). confirmed_at / sla_target_at feed the front-desk SLA dash.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS token_number    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS department      VARCHAR(100),
  ADD COLUMN IF NOT EXISTS confirmed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_target_at   TIMESTAMPTZ;

-- ─── audit_log (failure diagnostics) ──────────────────────────────────
-- Readers: controllers/admin/auditQueryController.js
-- Admin audit search surfaces error_message when present; the writers
-- already pass it through the `metadata` jsonb blob, but the admin
-- filter wants it as a first-class column for indexed lookups.
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- ─── auth_logs (session revocation + device fingerprint) ──────────────
-- Readers: services/sessionManagementService.js
-- jti = JWT ID (for the revocation session-list). device_info is the
-- normalised user-agent / platform string that the same service lists.
ALTER TABLE auth_logs
  ADD COLUMN IF NOT EXISTS jti          VARCHAR(100),
  ADD COLUMN IF NOT EXISTS device_info  TEXT;

-- ─── doctors (scheduling capacity) ────────────────────────────────────
-- Readers: routes/appointment/appointmentAdminRoutes.js (capacity view)
-- Default 20 is the pre-batch heuristic from the admin UI.
ALTER TABLE doctors
  ADD COLUMN IF NOT EXISTS max_appointments_per_day INTEGER NOT NULL DEFAULT 20;

-- ─── staff (payroll export fields) ────────────────────────────────────
-- Readers: services/staff/hr/reportingService.js (bank_details)
--          controllers/staff/staffAdminOperationsController.js (base_salary)
-- bank_details is the split-out copy of the finer columns on
-- staff_salary (bank_account / bank_ifsc) so export queries don't
-- need the join. base_salary mirrors staff_salary.basic_salary for
-- the same reason. Both are nullable so existing rows survive.
ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS bank_details JSONB,
  ADD COLUMN IF NOT EXISTS base_salary  NUMERIC(12,2);

-- ─── user_devices (admin device audit) ────────────────────────────────
-- Readers: routes/deviceRoutes.js (admin device list)
-- device_type complements the existing platform column (coarser
-- classification — "mobile" / "tablet" / "desktop"). ip_address and
-- updated_at are audit trail for the admin list view.
ALTER TABLE user_devices
  ADD COLUMN IF NOT EXISTS device_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS ip_address  VARCHAR(45),
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Indexes to match the new access patterns.
CREATE INDEX IF NOT EXISTS idx_appointments_token_number ON appointments(token_number) WHERE token_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appointments_department_date ON appointments(department, appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_sla_pending ON appointments(sla_target_at) WHERE status = 'SCHEDULED';
CREATE INDEX IF NOT EXISTS idx_auth_logs_jti ON auth_logs(jti) WHERE jti IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auth_logs_user_created ON auth_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_devices_updated ON user_devices(updated_at DESC);

COMMIT;
