-- Migration 088: batch-47 drift sweep — add columns the live raw-SQL
-- surfaces write to but the schema never declared. Each group here
-- corresponds to a drift cluster flagged by
-- `apps/backend/scripts/scan-code-drift.mjs`.
--
-- All additions are nullable / defaulted so the migration is safe to
-- apply to populated production data; no existing row needs a rewrite.

BEGIN;

-- ─── appointments (admin override + reminder tracking) ────────────────
-- Writers: routes/appointment/appointmentAdminRoutes.js:511/563/697
--          schedulers/appointmentReminderScheduler.js:57
--          utils/notifications/appointmentReminderJob.js:73/101
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS admin_override     BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason    TEXT,
  ADD COLUMN IF NOT EXISTS created_by         UUID,
  ADD COLUMN IF NOT EXISTS updated_by         UUID,
  ADD COLUMN IF NOT EXISTS reminder_sent      BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_1h_sent   BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_24h_sent  BOOLEAN       NOT NULL DEFAULT false;

-- ─── clinical_orders (cancellation + completion tracking) ─────────────
-- Writers: services/emr/orderEntryService.js:264/307/350
ALTER TABLE clinical_orders
  ADD COLUMN IF NOT EXISTS cancel_reason  TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_by   UUID,
  ADD COLUMN IF NOT EXISTS completed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_by   UUID;

-- ─── departments (admin management surface) ───────────────────────────
-- Writers: services/department/adminDepartmentService.js (create, update,
-- bulk update_budget, bulk reassign_head, deactivate with reason)
-- The RETURNING clauses of that service also reference code/head_uid/
-- floor/building so those are added here too, though the scanner only
-- flags INSERT/UPDATE targets.
ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS head_doctor_id       INTEGER,
  ADD COLUMN IF NOT EXISTS head_uid             UUID,
  ADD COLUMN IF NOT EXISTS contact_number       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS location             TEXT,
  ADD COLUMN IF NOT EXISTS budget               NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS code                 VARCHAR(32),
  ADD COLUMN IF NOT EXISTS floor                VARCHAR(32),
  ADD COLUMN IF NOT EXISTS building             VARCHAR(64),
  ADD COLUMN IF NOT EXISTS deactivation_reason  TEXT,
  ADD COLUMN IF NOT EXISTS updated_by           UUID;

-- ─── doctors (profile fields beyond the core identity row) ────────────
-- Writers: services/doctor/doctorService.js:413/441/490,
--          services/doctor/adminDoctorService.js:269/293
-- `specialization` and `bio` are renames (specialty/intro already exist)
-- and handled in the code-fix commit that follows this migration.
ALTER TABLE doctors
  ADD COLUMN IF NOT EXISTS available_days    TEXT[],
  ADD COLUMN IF NOT EXISTS available_hours   JSONB,
  ADD COLUMN IF NOT EXISTS consultation_fee  NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS experience_years  INTEGER,
  ADD COLUMN IF NOT EXISTS education         TEXT,
  ADD COLUMN IF NOT EXISTS qualifications    TEXT;

-- ─── e_prescriptions (pharmacy auto-order linking) ────────────────────
-- Writers: controllers/prescription/ePrescriptionController.js:660
ALTER TABLE e_prescriptions
  ADD COLUMN IF NOT EXISTS pharmacy_order_id  INTEGER,
  ADD COLUMN IF NOT EXISTS pharmacy_opted     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pharmacy_opt_type  VARCHAR(50);

-- ─── feedback (admin response workflow) ───────────────────────────────
-- Writers: services/feedback/feedbackService.js:435
ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS responded_at     TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS response_status  VARCHAR(50);

-- ─── investigation_templates (audit column) ───────────────────────────
-- Writers: services/investigation/templateService.js:150/186
ALTER TABLE investigation_templates
  ADD COLUMN IF NOT EXISTS updated_by  UUID;

-- ─── investigations (template-order flow + bulk assign/schedule/cancel) ─
-- Writers: services/investigation/templateService.js:91
--          services/investigation/bulkService.js:13/29/48/67
-- `type` is separate from existing `test_type` / `investigation_type`
-- (templateService writes the template type label here).
ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS doctor_id              INTEGER,
  ADD COLUMN IF NOT EXISTS test_code              VARCHAR(50),
  ADD COLUMN IF NOT EXISTS type                   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS normal_range           TEXT,
  ADD COLUMN IF NOT EXISTS unit                   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS cost                   NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS created_by             UUID,
  ADD COLUMN IF NOT EXISTS updated_by             UUID,
  ADD COLUMN IF NOT EXISTS assigned_technician_id UUID,
  ADD COLUMN IF NOT EXISTS scheduled_date         DATE,
  ADD COLUMN IF NOT EXISTS time_slot              VARCHAR(50),
  ADD COLUMN IF NOT EXISTS cancelled_at           TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS cancelled_by           UUID,
  ADD COLUMN IF NOT EXISTS cancellation_reason    TEXT;

-- ─── medications (audit column) ───────────────────────────────────────
-- Writers: services/pharmacy/medicationService.js:234/241/248
ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ─── notifications (user-targeted + role-targeted + link-back) ────────
-- Writers: services/feedback/feedbackService.js:378
--          services/staff/hr/leaveService.js:165
--          services/staff/hr/performanceService.js:176
--          services/staff/pharmacyService.js:45
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS user_id         INTEGER,
  ADD COLUMN IF NOT EXISTS recipient_role  VARCHAR(50),
  ADD COLUMN IF NOT EXISTS related_id      INTEGER;

-- ─── pharmacy_orders (dispensing workflow) ────────────────────────────
-- Writers: services/staff/pharmacyService.js:12
-- (total_cost → total_amount already renamed in 47a.)
ALTER TABLE pharmacy_orders
  ADD COLUMN IF NOT EXISTS dispensed_medications  JSONB,
  ADD COLUMN IF NOT EXISTS pharmacist_notes       TEXT,
  ADD COLUMN IF NOT EXISTS updated_by             UUID;

-- ─── staff (archive + status-change reason tracking) ──────────────────
-- Writers: controllers/staff/staffAdminOperationsController.js:252/282
-- `archived` boolean already exists; these are the provenance columns.
ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS archived_at    TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS archived_by    UUID,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT,
  ADD COLUMN IF NOT EXISTS status_reason  TEXT;

-- ─── staff_attendance (classification + admin override) ───────────────
-- Writers: services/staff/attendanceService.js:79/100/145
--          controllers/staff/staffAdminAttendanceController.js:188/223
-- `attendance_type` is the action label ('check_in'/'check_out') and is
-- distinct from the existing `type` (device-type) column; both coexist.
-- The classification UPDATE was previously swallowed by a try/catch on
-- line 149 that logged "columns may not exist yet" — those now exist.
ALTER TABLE staff_attendance
  ADD COLUMN IF NOT EXISTS attendance_type         VARCHAR(20),
  ADD COLUMN IF NOT EXISTS attendance_status       VARCHAR(30),
  ADD COLUMN IF NOT EXISTS break_duration_minutes  INTEGER,
  ADD COLUMN IF NOT EXISTS marked_by               UUID,
  ADD COLUMN IF NOT EXISTS minutes_late            INTEGER,
  ADD COLUMN IF NOT EXISTS overtime_hours          NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS notes                   TEXT,
  ADD COLUMN IF NOT EXISTS overridden_by           UUID,
  ADD COLUMN IF NOT EXISTS override_reason         TEXT,
  ADD COLUMN IF NOT EXISTS created_by              UUID,
  ADD COLUMN IF NOT EXISTS updated_by              UUID,
  ADD COLUMN IF NOT EXISTS updated_at              TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ─── staff_onboarding_tasks (completion workflow) ─────────────────────
-- Writers: services/staff/hr/onboardingService.js:106
-- DB already has `status` + `completed_at`; these are the additional
-- provenance columns the service writes.
ALTER TABLE staff_onboarding_tasks
  ADD COLUMN IF NOT EXISTS completed      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS completed_by   UUID,
  ADD COLUMN IF NOT EXISTS completed_date TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ─── users (ABDM linking + admin status tracking + RBAC + push token) ─
-- Writers: services/abdm/abdmService.js:65               (abha_*)
--          services/infrastructure/rbacService.js:307/549 (role_updated_at, status_updated_*)
--          services/user/adminUserService.js:171,
--          services/user/userService.js:323              (status string)
--          services/userService.js:*                     → dead, was deleted in 47a
--          utils/notifications/sendPushNotification.js:124 (device_token)
-- `is_active` remains the canonical boolean; `status` is an additional
-- text state slot (active / suspended / pending / etc.) that callers set
-- alongside it.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS abha_address       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS abha_number        VARCHAR(20),
  ADD COLUMN IF NOT EXISTS device_token       TEXT,
  ADD COLUMN IF NOT EXISTS role_updated_at    TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS status             VARCHAR(50) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS status_reason      TEXT,
  ADD COLUMN IF NOT EXISTS status_updated_at  TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS status_updated_by  UUID,
  -- PHI columns the GDPR erasure service anonymizes (and SOS service
  -- updates); the existing schema never declared them, so the erasure
  -- swallowed errors in a try/catch ("table may not exist"). They're
  -- first-class PHI for the India-first DPDP deployment.
  ADD COLUMN IF NOT EXISTS emergency_contact  JSONB,
  ADD COLUMN IF NOT EXISTS blood_group        VARCHAR(10),
  ADD COLUMN IF NOT EXISTS allergies          TEXT,
  ADD COLUMN IF NOT EXISTS medical_history    TEXT;

-- Indexes to match the new access patterns that scanned code implies.
CREATE INDEX IF NOT EXISTS idx_appointments_reminder_sent ON appointments(reminder_sent) WHERE reminder_sent = false;
CREATE INDEX IF NOT EXISTS idx_appointments_admin_override ON appointments(admin_override) WHERE admin_override = true;
CREATE INDEX IF NOT EXISTS idx_clinical_orders_cancelled ON clinical_orders(cancelled_by) WHERE cancelled_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_departments_head_doctor ON departments(head_doctor_id);
CREATE INDEX IF NOT EXISTS idx_e_prescriptions_pharmacy_order ON e_prescriptions(pharmacy_order_id);
CREATE INDEX IF NOT EXISTS idx_feedback_response_status ON feedback(response_status);
CREATE INDEX IF NOT EXISTS idx_investigations_scheduled_date ON investigations(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_investigations_doctor ON investigations(doctor_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_role ON notifications(recipient_role);
CREATE INDEX IF NOT EXISTS idx_staff_archived ON staff(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_attendance_status ON staff_attendance(attendance_status);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_abha_number ON users(abha_number) WHERE abha_number IS NOT NULL;

COMMIT;
