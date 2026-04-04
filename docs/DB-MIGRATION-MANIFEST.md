# VHHealth Database — Migration Manifest

> **Last updated:** 2026-04-04  
> Complete log of every migration applied to the DB, what it does, and current status.

---

## Prisma-Managed Migrations

Tracked in `_prisma_migrations` table. Applied via `npx prisma migrate deploy`.

| Migration | Applied | Tables Created / Modified |
|-----------|---------|--------------------------|
| `20260330000002_add_step_rewards` | ✅ 2026-04-02 | `step_rewards`, `step_profiles`, `step_sessions` |
| `20260402000001_add_billing_tables` | ✅ 2026-04-02 | `invoices`, `payment_transactions`, `insurance_claims` |

---

## SQL Migrations

Applied manually in order. Located in `migrations/` directory.

| File | Status | Tables Created | Columns Added | Notes |
|------|--------|---------------|---------------|-------|
| `002_investigations_notification.sql` | ✅ Applied | — | `investigations.notified`, `notified_at` | Fixed notification job crash |
| `003_attendance_features.sql` | ✅ Applied | `attendance_regularization`, `replacement_requests` | — | |
| `004_shift_overtime.sql` | ✅ Applied | `staff_shifts`, `staff_shift_assignments`, `overtime_requests`, `staff_breaks`, `attendance_disputes`, `geofence_breaches` | `staff_attendance.staff_uid`, etc. | |
| `005_incident_grievance.sql` | ✅ Applied | `incident_reports`, `staff_grievances`, `report_updates` | — | Trigger-based incident numbers |
| `006_universal_audit_log.sql` | ✅ Applied | `audit_log` (HTTP middleware log) | — | Distinct from `audit_logs` (Prisma) |
| `007_housekeeping.sql` | ✅ Applied | `housekeeping_zones`, `housekeeping_logs`, `housekeeping_requests`, `housekeeping_request_updates` | — | 14 zones seeded |
| `008_payroll.sql` | ✅ Applied | `staff_salary`, `payroll_runs`, `payslips`, `salary_revisions`, `annual_review_reminders` | — | |
| `009_payroll_complete.sql` | ✅ Applied | `salary_advances`, `advance_deductions`, `salary_arrears`, `annual_tax_summaries` | `payslips` extended | |
| `010_payroll_compliance.sql` | ✅ Applied | `full_final_settlements`, `investment_declarations`, `leave_encashments`, `payslip_queries`, `payslip_query_replies`, `bulk_revision_jobs` | — | |
| `011_appointment_records.sql` | ✅ Applied | `appointment_documents`, `patient_records`, `appointment_status_history` | `appointments` extended | |
| `012_appointment_improvements.sql` | ✅ Applied | `scheduled_notifications` | `appointments` extended | |
| `013_investigation_enhancements.sql` | ✅ Applied | `investigation_test_catalog` | `investigations` extended | Index on `patient_id` skipped (col added in 021) |
| `014_investigation_bookings.sql` | ✅ Applied | `investigation_bookings`, `investigation_booking_history` | — | |
| `015_pharmacy_orders_enhanced.sql` | ✅ Applied | `pharmacy_order_history`, `pharmacy_catalog` | `pharmacy_orders` extended | |
| `016_delivery_tracking.sql` | ✅ Applied | `delivery_location_updates` | `pharmacy_orders` delivery fields | |
| `017_seed_departments_doctors.sql` | ⚠️ **SKIP** | — | — | Schema mismatches — do not apply. Seed manually. |
| `018_e_prescription.sql` | ✅ Applied | `e_prescriptions` | — | 110 drug items seeded |
| `019_performance_indexes.sql` | ✅ Applied (partial) | — | — | Some indexes skipped (col didn't exist at time, fixed in 021–024) |
| `020_missing_tables.sql` | ✅ Applied | `canary_checks`, `notification_outbox`, `clinical_alerts` | — | |
| `021_schema_corrections.sql` | ✅ Applied | — | `investigations.patient_id`, `pharmacy_orders` (7 cols), `notification_outbox` retry cols | Fixed runtime errors |
| `022_missing_emr_tables.sql` | ✅ Applied | `wards`, `beds`, `admissions`, `bed_transfers`, `clinical_notes`, `diagnoses`, `vitals_chart`, `clinical_orders`, `medication_administrations`, `referrals`, `radiology_orders`, `ot_schedules`, `blood_requests`, `diet_orders`, `quality_incidents`, `infection_cases`, `abdm_consents`, `data_breaches`, `staff_messages`, `performance_reviews`, `patient_consents`, `otp_codes`, `medication_reminders`, `user_roles`, `failed_notifications`, `icd10_codes` | `users` (7 cols), `staff` (2 cols) | 26 tables from full source audit |
| `023_missing_support_tables.sql` | ✅ Applied | `hipaa_access_log`, `gdpr_erasure_log`, `legal_holds`, `cds_alerts`, `drug_interactions`, `clinical_protocols`, `order_sets`, `intake_output`, `nurse_handovers`, `prescriptions`, `allergies`, `patient_allergies`, `vital_signs`, `discharge_summaries`, `immunizations`, `abdm_data_requests`, `feature_flags`, `system_settings`, `totp_challenges`, `quarantined_files`, `feedback_responses`, `admin_actions`, `appointment_archive`, `onboarding_tasks`, `leave_requests` | `feedback` (2 cols) | 25 tables from source audit |
| `024_column_corrections.sql` | ✅ Applied | — | `staff.name`, `staff.designation`, `staff_attendance.check_out_time`, `beds.assigned_at`, `appointments.patient_id` | Fixed cross-repo audit findings |
| `025_sos_and_prisma_alignment.sql` | ✅ Applied | `emergency_services`, `sos_services` | — | Fixed runtime error in SOS admin service |
| `026_admins_missing_columns.sql` | ✅ Applied | — | `admins.status`, `failed_login_attempts`, `last_failed_login`, `totp_enabled`, `password_changed_at`, `updated_at` | Fixed admin auth — all admin ops were silently failing |
| `add_invalidated_tokens.sql` | ✅ Applied | `invalidated_tokens` | — | JWT token revocation |

---

## Prisma Schema vs Live DB

| Metric | Count |
|--------|-------|
| Tables in Prisma schema | 67 |
| Tables managed by SQL migrations only (no Prisma model) | 97 |
| **Total tables** | **164** |

Tables with no Prisma model are accessed via raw SQL queries in the backend. They are fully functional — they just have no generated Prisma client type.

---

## Known Deferred Items

| Item | Status | Priority |
|------|--------|----------|
| Migration 017 seed data | ⚠️ Not applied (schema mismatches) | Medium — fix schema then re-run |
| Consolidate `audit_log` vs `audit_logs` | Not done | Low — both in use, different schemas |
| ICD-10 codes population | Not populated (table exists, empty) | Medium — needed for CDS diagnosis lookup |
| Prisma models for 97 raw-SQL tables | Not done | Low — types only, no functional impact |

---

## Audit History

| Date | Who | What |
|------|-----|------|
| 2026-04-04 | Coder | Full DB audit — found 44 migration tables never applied, applied all migrations (002–020 + add_invalidated_tokens) |
| 2026-04-04 | Coder | Fixed 3 runtime issues: investigations.patient_id, pharmacy_orders missing cols, notification_outbox column mismatch (migration 021) |
| 2026-04-04 | Coder | Cross-repo audit of all 5 GitHub repos — found 51 more missing tables/columns, applied migrations 022–026 |
| 2026-04-04 | Coder | Fixed admin UUID PK bug — all admin ops were using parseInt(uuid) = NaN (migration 026 + backend fix) |
