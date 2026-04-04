# VHHealth Database Schema Reference
> **Last validated:** 2026-04-04  
> **DB:** PostgreSQL 15 · Docker container `vhhealth-db` · port 5433 (127.0.0.1)  
> **Total tables:** 111 (excluding `_migrations` and `_prisma_migrations`)  
> **Status:** All migrations applied. Zero invalid indexes. Zero broken FK constraints.

---

## How the Schema Is Managed

Two complementary systems define the DB schema:

| System | Scope | Location |
|--------|-------|----------|
| **Prisma schema** | Core 68 tables — models the entities Prisma client queries directly | `prisma/schema.prisma` |
| **SQL migrations** | Extended 43 tables — shift scheduling, payroll, pharmacy extensions, housekeeping, etc. | `migrations/*.sql` |

Both must be applied to a fresh DB. Prisma migrations alone are insufficient.

---

## Table Inventory

### Group 1 — User Management (Prisma)
| Table | Purpose |
|-------|---------|
| `users` | Patient accounts — phone, uid, name, role |
| `user_devices` | FCM tokens, device registration per user |
| `user_sessions` | Auth session tracking |
| `user_status_history` | Audit log for user status changes |
| `user_deactivation_log` | Deactivation events with reason + data snapshot |
| `user_reactivation_log` | Reactivation events |
| `user_role_audit` | Role change history |
| `user_action_logs` | Fine-grained user action events |
| `bulk_operation_logs` | Batch operation results (deactivations, etc.) |

### Group 2 — Authentication (Prisma)
| Table | Purpose |
|-------|---------|
| `admins` | Admin portal users with permissions array |
| `otp_sessions` | Active OTP state (phone, purpose, expiry) |
| `otp_logs` | OTP send/verify audit trail |
| `password_reset_otps` | Admin password reset OTP state |
| `auth_logs` | Auth attempt history (success + failure) |
| `invalidated_tokens` | Revoked JWT tokens (migration: `add_invalidated_tokens.sql`) |

### Group 3 — Hospital Structure (Prisma)
| Table | Purpose |
|-------|---------|
| `departments` | Hospital departments |
| `department_audit_log` | Department CRUD audit |
| `doctors` | Doctor profiles, availability, specialty |
| `patient_feedback` | Doctor ratings from patients |

### Group 4 — Appointments & Scheduling (Prisma + migrations)
| Table | Source | Purpose |
|-------|--------|---------|
| `appointments` | Prisma | Core appointment records |
| `appointment_documents` | Migration 011 | Files attached to appointments |
| `appointment_status_history` | Migration 011 | Status change audit trail |
| `scheduled_notifications` | Migration 012 | Reminder notification queue for appointments |

### Group 5 — Medical Records (Prisma)
| Table | Purpose |
|-------|---------|
| `health_records` | Patient-uploaded health files |
| `medical_records` | Doctor-created clinical records |
| `consultations` | Consultation notes and diagnosis |
| `patient_records` | Extended patient encounter records (migration 011) |

### Group 6 — Investigations / Lab (Prisma + migrations)
| Table | Source | Purpose |
|-------|--------|---------|
| `investigations` | Prisma | Lab test requests — includes `notified`, `notified_at`, `turnaround_target_hours`, `urgent_alert_sent` columns added by migrations |
| `investigation_files` | Prisma | Files attached to investigation results |
| `investigation_templates` | Prisma | Reusable test panel templates |
| `investigation_template_tests` | Prisma | Individual tests within templates |
| `investigation_test_catalog` | Migration 013 | Master catalog of all available tests |
| `investigation_bookings` | Migration 014 | Booked investigation slots |
| `investigation_booking_history` | Migration 014 | Status change log for bookings |

### Group 7 — Pharmacy (Prisma + migrations)
| Table | Source | Purpose |
|-------|--------|---------|
| `pharmacy_orders` | Prisma | Core medication orders — extended with delivery tracking, order numbers, SLA fields |
| `medications` | Prisma | Medication master data |
| `pharmacy_order_history` | Migration 015 | Order status change log |
| `pharmacy_catalog` | Migration 015 | Formulary / approved drug list |
| `delivery_location_updates` | Migration 016 | Real-time delivery location pings |
| `e_prescriptions` | Migration 018 | Electronic prescription records |

### Group 8 — Feedback & Communication (Prisma)
| Table | Purpose |
|-------|---------|
| `feedback` | Patient feedback with rating, category, doctor/dept |

### Group 9 — Emergency (Prisma)
| Table | Purpose |
|-------|---------|
| `sos_alerts` | SOS events with geo, severity, response tracking |

### Group 10 — File Management (Prisma)
| Table | Purpose |
|-------|---------|
| `file_metadata` | All uploaded files — storage key, privacy level, scan status |
| `file_access_logs` | File access audit |
| `file_deletion_log` | HIPAA-compliant deletion audit |
| `batch_upload_logs` | Multi-file upload batch results |

### Group 11 — Staff Core (Prisma)
| Table | Purpose |
|-------|---------|
| `staff` | Staff employment records |
| `staff_attendance` | Check-in/out records |
| `staff_devices` | Staff app device registration |
| `staff_auth_sessions` | Staff auth tokens |
| `staff_performance_reviews` | Annual/periodic reviews |
| `staff_onboarding_tasks` | Onboarding task checklist |

### Group 12 — Staff Scheduling & Attendance (migrations)
| Table | Migration | Purpose |
|-------|-----------|---------|
| `staff_shifts` | 004 | Defined shift templates |
| `staff_shift_assignments` | 004 | Staff-to-shift mapping |
| `overtime_requests` | 004 | OT request and approval |
| `staff_breaks` | 004 | Break tracking per shift |
| `attendance_disputes` | 004 | Disputed attendance records |
| `geofence_breaches` | 004 | Location-based attendance violations |
| `attendance_regularization` | 003 | Manual attendance correction requests |
| `replacement_requests` | 003 | Shift swap / replacement requests |
| `anomalies` | Prisma | Attendance anomaly summaries |

### Group 13 — HR & Payroll (migrations)
| Table | Migration | Purpose |
|-------|-----------|---------|
| `leave_types` | Prisma | Leave category definitions |
| `leave_applications` | Prisma | Leave requests |
| `leave_balance_overrides` | Prisma | Manual balance adjustments |
| `leave_encashments` | 010 | Leave encashment records |
| `staff_salary` | 008 | Current salary records |
| `salary_revisions` | 008 | Salary revision history |
| `payroll_runs` | 008 | Monthly payroll batch runs |
| `payslips` | 008 | Individual payslips |
| `annual_review_reminders` | 008 | Scheduled review reminders |
| `salary_advances` | 009 | Salary advance loans |
| `advance_deductions` | 009 | Advance recovery installments |
| `salary_arrears` | 009 | Arrear payments |
| `annual_tax_summaries` | 009 | Form 16 / tax year summaries |
| `full_final_settlements` | 010 | F&F on exit |
| `investment_declarations` | 010 | IT declaration records |
| `payslip_queries` | 010 | Employee payslip disputes |
| `payslip_query_replies` | 010 | HR replies to disputes |
| `bulk_revision_jobs` | 010 | Batch salary revision jobs |

### Group 14 — Incidents & Grievances (migration)
| Table | Migration | Purpose |
|-------|-----------|---------|
| `incident_reports` | 005 | Staff incident/near-miss reports |
| `staff_grievances` | 005 | Staff grievance submissions |
| `report_updates` | 005 | Status updates on incidents/grievances |

### Group 15 — Housekeeping (migration)
| Table | Migration | Purpose |
|-------|-----------|---------|
| `housekeeping_zones` | 007 | Hospital zones for housekeeping |
| `housekeeping_logs` | 007 | Completed housekeeping tasks |
| `housekeeping_requests` | 007 | Housekeeping requests from staff/patients |
| `housekeeping_request_updates` | 007 | Request status updates |

### Group 16 — Notifications (Prisma + migration)
| Table | Source | Purpose |
|-------|--------|---------|
| `notifications` | Prisma | Patient-facing push notifications |
| `notification_templates` | Prisma | Reusable notification templates |
| `notification_delivery_log` | Prisma | Delivery attempt log |
| `notification_outbox` | Migration 020 | Outbound notification queue |

### Group 17 — Billing (Prisma)
| Table | Purpose |
|-------|---------|
| `invoices` | Patient invoices — line items in JSONB |
| `payment_transactions` | Payment records linked to invoices |
| `insurance_claims` | Insurance claim submissions |

### Group 18 — Step Challenge (Prisma)
| Table | Purpose |
|-------|---------|
| `step_profiles` | User step challenge opt-in + daily goal |
| `step_sessions` | Walk/step tracking sessions |
| `step_rewards` | Earned rewards from step goals |

### Group 19 — Location Services (Prisma)
| Table | Purpose |
|-------|---------|
| `hospitals` | Nearby hospital directory |
| `pharmacies` | Nearby pharmacy directory |
| `blood_banks` | Nearby blood bank directory |

### Group 20 — Security & Audit (Prisma + migrations)
| Table | Source | Purpose |
|-------|--------|---------|
| `audit_logs` | Prisma | General resource-level audit log |
| `audit_log` | Migration 006 | HTTP request-level audit (middleware) |
| `admin_activity_logs` | Prisma | Admin portal action log |
| `medical_activity_logs` | Prisma | Medical staff action log |
| `pharmacy_activity_logs` | Prisma | Pharmacy staff action log |
| `hr_activity_logs` | Prisma | HR action log |
| `attendance_logs` | Prisma | Attendance action log |
| `api_access_logs` | Prisma | API endpoint access log |
| `system_alerts` | Prisma | System-level alerts (file scan, etc.) |
| `canary_checks` | Migration 020 | Health check / canary test results |
| `clinical_alerts` | Migration 020 | Clinical threshold alerts |

### Group 21 — Devices (Prisma)
| Table | Purpose |
|-------|---------|
| `devices` | Patient app device registry (FCM tokens) |

---

## Known Issues / Discrepancies

| Issue | Detail | Action Needed |
|-------|--------|---------------|
| `patient_id` column missing | Migrations 013 and 015 attempted to create indexes on `investigations.patient_id` and `pharmacy_orders.patient_id` — neither column exists in the schema | Indexes skipped; evaluate if `patient_id` FK is needed or if `uid`/`phone` is the correct join |
| `notifications.user_id` missing | Migration 019 attempted index on `notifications(user_id)` — column doesn't exist (schema uses `uid`) | Created `idx_notifications_uid_created` on `uid` instead |
| `notification_outbox` retry index | Migration 019 referenced `retry_count` + `last_attempt_at` columns that don't exist on `notification_outbox` | Columns need to be added if retry logic is implemented |
| `audit_log` duplicated concept | Two audit tables: `audit_log` (HTTP middleware, migration 006) and `audit_logs` (Prisma resource-level). Both are in use. | Long term: consolidate or clearly document which is which |
| Seed migration (017) partially failed | `departments` lacks `contact_number`, `users.updated_at` NOT NULL violation, `doctors` lacks `specialization` column — seed data not applied | Run seed manually after schema corrections, or use a separate seed script |

---

## Migration Application Order

For a fresh DB, apply in this order:

```
1. prisma migrate deploy          # Applies Prisma migrations (step_rewards, billing tables)
2. migrations/002_investigations_notification.sql
3. migrations/003_attendance_features.sql
4. migrations/004_shift_overtime.sql
5. migrations/005_incident_grievance.sql
6. migrations/006_universal_audit_log.sql
7. migrations/007_housekeeping.sql
8. migrations/008_payroll.sql
9. migrations/009_payroll_complete.sql
10. migrations/010_payroll_compliance.sql
11. migrations/011_appointment_records.sql
12. migrations/012_appointment_improvements.sql
13. migrations/013_investigation_enhancements.sql
14. migrations/014_investigation_bookings.sql
15. migrations/015_pharmacy_orders_enhanced.sql
16. migrations/016_delivery_tracking.sql
17. migrations/017_seed_departments_doctors.sql  ← has errors, see Known Issues
18. migrations/018_e_prescription.sql
19. migrations/019_performance_indexes.sql        ← some indexes fail, see Known Issues
20. migrations/020_missing_tables.sql
21. migrations/add_invalidated_tokens.sql
```

> ⚠️ Migration 017 (seed) has schema mismatches and will partially fail. Do not treat seed failures as blocking — table structure is correct, sample data is optional.

---

## Current DB State Summary

```
Host:       127.0.0.1:5433 (Docker, vhhealth-db container, postgres:15)
Database:   vhhealth
User:       vhhealth
DB Size:    ~13 MB (development data only)
Tables:     111 (public schema)
Indexes:    All valid (0 invalid)
FK errors:  None
Dead tuples: None (clean, no vacuuming needed)
```
