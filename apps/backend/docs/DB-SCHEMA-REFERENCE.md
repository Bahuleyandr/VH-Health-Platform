# VHHealth Database Schema Reference

> **Historical snapshot:** this document records the schema state validated on
> 2026-04-04. Use
> [`../../../docs/DB_SCHEMA_GUARDRAILS.md`](../../../docs/DB_SCHEMA_GUARDRAILS.md)
> and the backend DB contract scripts for the current release gate.
>
> **Last validated:** 2026-04-04  
> **DB:** PostgreSQL 15 · Docker container `vhhealth-db` · port 5433 (127.0.0.1)  
> **Total tables:** 164 (excluding `_migrations` and `_prisma_migrations`)  
> **Total columns:** 2,084 · **Total indexes:** 553  
> **Status:** All migrations applied. Zero invalid indexes. Zero broken FK constraints.

---

## Quick Stats

```
Tables:   164
Columns:  2,084
Indexes:  553
FK errors: 0
DB size:  ~18 MB (development data)
```

---

## How the Schema Is Managed

Two systems define the DB schema:

| System | Scope | Location |
|--------|-------|----------|
| **Prisma schema** | Core 67 tables — models Prisma client queries directly | `prisma/schema.prisma` |
| **SQL migrations** | Extended 97 tables + column additions | `src/migrations/*.sql` |

Both must be applied to a fresh DB. For current rebuild validation, use
[`../../../docs/DB_SCHEMA_GUARDRAILS.md`](../../../docs/DB_SCHEMA_GUARDRAILS.md)
and the Docker-backed backend guardrail runner.

---

## Table Inventory by Domain

### 👥 User Management (Prisma)
| Table | Columns | Purpose |
|-------|---------|---------|
| `users` | 21 | Patient accounts — phone, uid, name, role, ABHA, status |
| `user_devices` | 10 | FCM tokens, device registration per user |
| `user_sessions` | 6 | Auth session tracking |
| `user_status_history` | 8 | User status change audit |
| `user_deactivation_log` | 8 | Deactivation events with reason + data snapshot |
| `user_reactivation_log` | 6 | Reactivation events |
| `user_role_audit` | 8 | Role change history |
| `user_action_logs` | 7 | Fine-grained user action events |
| `user_roles` | 7 | Role metadata + permissions lookup |
| `bulk_operation_logs` | 9 | Batch operation results |

### 🔐 Authentication (Prisma + migrations)
| Table | Source | Columns | Purpose |
|-------|--------|---------|---------|
| `admins` | Prisma | 22 | Admin portal users — UUID PK (`uid`), permissions, lockout, TOTP, status |
| `otp_sessions` | Prisma | 9 | Active OTP state (phone, purpose, expiry) |
| `otp_logs` | Prisma | 10 | OTP send/verify audit trail |
| `otp_codes` | Migration 022 | 8 | Dev OTP alternative store |
| `password_reset_otps` | Prisma | 6 | Admin password reset OTP state |
| `auth_logs` | Prisma | 10 | Auth attempt history (success + failure) |
| `invalidated_tokens` | Migration | 4 | Revoked JWT tokens |
| `totp_challenges` | Migration 023 | 6 | TOTP 2FA challenges for admins |

### 🏥 Hospital Structure (Prisma)
| Table | Columns | Purpose |
|-------|---------|---------|
| `departments` | 6 | Hospital departments |
| `department_audit_log` | 7 | Department CRUD audit |
| `doctors` | 12 | Doctor profiles, availability, specialty |
| `patient_feedback` | 5 | Doctor ratings from patients |
| `wards` | 7 | Hospital ward definitions |
| `beds` | 17 | Individual bed inventory with occupancy state |

### 📅 Appointments & Scheduling (Prisma + migrations)
| Table | Source | Columns | Purpose |
|-------|--------|---------|---------|
| `appointments` | Prisma | 27 | Core appointments — includes patient_id FK, workflow timestamps, SLA fields |
| `appointment_documents` | Migration 011 | 15 | Files attached to appointments |
| `appointment_status_history` | Migration 011 | 8 | Status change audit trail |
| `appointment_archive` | Migration 023 | 11 | Soft-delete archive for bulk-deleted appointments |
| `scheduled_notifications` | Migration 012 | 8 | Reminder notification queue |
| `admissions` | Migration 022 | 29 | ADT — admission/discharge/transfer with encounter_id |
| `bed_transfers` | Migration 022 | 9 | Bed movement audit log |

### 🏥 Medical Records (Prisma + migrations)
| Table | Source | Columns | Purpose |
|-------|--------|---------|---------|
| `health_records` | Prisma | 12 | Patient-uploaded health files |
| `medical_records` | Prisma | 14 | Doctor-created clinical records |
| `consultations` | Prisma | 13 | Consultation notes and diagnosis |
| `patient_records` | Migration 011 | 17 | Extended patient encounter records |
| `clinical_notes` | Migration 022 | 15 | SOAP / progress / discharge notes (signed/addendum) |
| `diagnoses` | Migration 022 | 15 | Problem list / ICD-10 diagnosis records |
| `vitals_chart` | Migration 022 | 21 | Vitals observations (heart rate, BP, SpO2, etc.) |
| `intake_output` | Migration 023 | 10 | Fluid I/O balance records |
| `vital_signs` | Migration 023 | 9 | FHIR-style observation store |
| `discharge_summaries` | Migration 023 | 12 | Discharge summary documents |
| `immunizations` | Migration 023 | 12 | Vaccination records (FHIR Immunization) |
| `prescriptions` | Migration 023 | 18 | Active prescription records for CDS checks |
| `allergies` | Migration 023 | 10 | Patient allergy records (FHIR AllergyIntolerance) |
| `patient_allergies` | Migration 023 | 8 | Allergy lookup by patient_id (int FK) for safety checks |

### 🔬 Investigations / Lab (Prisma + migrations)
| Table | Source | Columns | Purpose |
|-------|--------|---------|---------|
| `investigations` | Prisma | 20 | Lab test requests — includes notified, patient_id, turnaround |
| `investigation_files` | Prisma | 10 | Files attached to investigation results |
| `investigation_templates` | Prisma | 9 | Reusable test panel templates |
| `investigation_template_tests` | Prisma | 7 | Tests within templates |
| `investigation_test_catalog` | Migration 013 | 14 | Master catalog of all available tests |
| `investigation_bookings` | Migration 014 | 50 | Booked investigation slots |
| `investigation_booking_history` | Migration 014 | 8 | Status change log for bookings |

### 💊 Pharmacy (Prisma + migrations)
| Table | Source | Columns | Purpose |
|-------|--------|---------|---------|
| `pharmacy_orders` | Prisma | 51 | Core orders — delivery tracking, billing, SLA fields |
| `medications` | Prisma | 16 | Medication master data |
| `pharmacy_order_history` | Migration 015 | 8 | Order status change log |
| `pharmacy_catalog` | Migration 015 | 14 | Formulary / approved drug list |
| `delivery_location_updates` | Migration 016 | 11 | Real-time delivery location pings |
| `e_prescriptions` | Migration 018 | 20 | Electronic prescription records |
| `medication_administrations` | Migration 022 | 14 | MAR — medication administration records |
| `medication_reminders` | Migration 022 | 12 | Patient medication reminder schedules |

### 🏥 Clinical Orders (migrations)
| Table | Columns | Purpose |
|-------|---------|---------|
| `clinical_orders` | 15 | CPOE order entry (medication, investigation, nursing, etc.) |
| `order_sets` | 9 | Pre-defined clinical order sets |
| `clinical_protocols` | 10 | Clinical care protocols / guidelines |
| `cds_alerts` | 12 | Clinical Decision Support alerts |
| `drug_interactions` | 10 | Drug-drug interaction reference data |
| `icd10_codes` | 5 | ICD-10 diagnosis code lookup (empty — needs population) |
| `radiology_orders` | 15 | Radiology requests |
| `ot_schedules` | 21 | Operation theatre scheduling |
| `blood_requests` | 19 | Blood bank requests |
| `diet_orders` | 14 | Dietary orders per patient |
| `referrals` | 16 | Internal/external patient referrals |
| `nurse_handovers` | 18 | Shift handover records |

### 💬 Feedback & Communication
| Table | Source | Columns | Purpose |
|-------|--------|---------|---------|
| `feedback` | Prisma | 15 | Patient feedback with rating, category, doctor/dept |
| `feedback_nps_responses` | Migration 452 | 25 | 0-10 NPS responses (the live staff-follow-up surface) |
| `staff_messages` | Migration 022 | 10 | Internal staff messaging |

> **Correction (re-audit I tenancy sweep).** This table previously listed
> `feedback_responses` as "Migration 023 / 5 columns / staff responses to
> patient feedback". No such table exists: migration 023 is
> `023_prior_authorization.sql`, `feedback_responses` appears in no migration
> and not in `000_baseline.sql`, and applying every migration 000..727 to a
> clean database leaves `to_regclass('public.feedback_responses')` NULL. The
> single service write that targeted it (`feedbackService.respondToFeedback`,
> reached by `POST /api/v1/feedback/respond`) always raised 42P01 and was
> removed rather than backfilled — there was no read side anywhere to make the
> feature work end to end.

### 🆘 Emergency
| Table | Columns | Purpose |
|-------|---------|---------|
| `sos_alerts` | 18 | SOS events with geo, severity, response tracking |
| `emergency_services` | 9 | Configured emergency service providers |
| `sos_services` | 9 | SOS service directory (mirrors emergency_services) |

### 📁 File Management (Prisma)
| Table | Columns | Purpose |
|-------|---------|---------|
| `file_metadata` | 13 | All uploaded files — storage key, privacy level, scan status |
| `file_access_logs` | 8 | File access audit |
| `file_deletion_log` | 13 | HIPAA-compliant deletion audit |
| `batch_upload_logs` | 10 | Multi-file upload batch results |
| `quarantined_files` | 11 | Files flagged by AV / content policy |

### 👥 Staff Core (Prisma)
| Table | Columns | Purpose |
|-------|---------|---------|
| `staff` | 25 | Staff employment records — includes name, designation, performance_rating |
| `staff_attendance` | 14 | Check-in/out records (check_in_time + check_out_time) |
| `staff_devices` | 10 | Staff app device registration |
| `staff_auth_sessions` | 8 | Staff auth tokens |
| `staff_performance_reviews` | 12 | Annual/periodic reviews (completed data) |
| `staff_onboarding_tasks` | 6 | Legacy onboarding task checklist |
| `onboarding_tasks` | 8 | Onboarding task workflow (used by HR controller) |

### ⏱ Staff Scheduling & Attendance (migrations)
| Table | Columns | Purpose |
|-------|---------|---------|
| `staff_shifts` | 10 | Defined shift templates |
| `staff_shift_assignments` | 6 | Staff-to-shift mapping |
| `overtime_requests` | 11 | OT request and approval |
| `staff_breaks` | 7 | Break tracking per shift |
| `attendance_disputes` | 13 | Disputed attendance records |
| `geofence_breaches` | 8 | Location-based attendance violations |
| `attendance_regularization` | 10 | Manual attendance correction requests |
| `replacement_requests` | 12 | Shift swap / replacement requests |
| `anomalies` | 10 | Attendance anomaly summaries |
| `performance_reviews` | 11 | Review workflow / pending review queue |
| `leave_requests` | 12 | Leave request workflow (used by audit controller) |

### 🏦 HR & Payroll (migrations)
| Table | Columns | Purpose |
|-------|---------|---------|
| `leave_types` | 6 | Leave category definitions |
| `leave_applications` | 15 | Leave requests |
| `leave_balance_overrides` | 7 | Manual balance adjustments |
| `leave_encashments` | 13 | Leave encashment records |
| `staff_salary` | 28 | Current salary records — PAN, PF, ESI, bank details |
| `salary_revisions` | 31 | Salary revision history |
| `payroll_runs` | 14 | Monthly payroll batch runs |
| `payslips` | 41 | Individual payslips — full breakdown |
| `annual_review_reminders` | 7 | Scheduled review reminders |
| `salary_advances` | 16 | Salary advance loans |
| `advance_deductions` | 9 | Advance recovery installments |
| `salary_arrears` | 13 | Arrear payments |
| `annual_tax_summaries` | 28 | Form 16 / tax year summaries |
| `full_final_settlements` | 32 | F&F on exit |
| `investment_declarations` | 26 | IT declaration records |
| `payslip_queries` | 12 | Employee payslip disputes |
| `payslip_query_replies` | 6 | HR replies to disputes |
| `bulk_revision_jobs` | 18 | Batch salary revision jobs |

### 🏥 Incidents, Quality & Compliance (migrations)
| Table | Columns | Purpose |
|-------|---------|---------|
| `incident_reports` | 25 | Staff incident / near-miss reports |
| `staff_grievances` | 21 | Staff grievance submissions |
| `report_updates` | 8 | Status updates on incidents/grievances |
| `quality_incidents` | 16 | Quality / safety incident reports |
| `infection_cases` | 12 | Hospital infection control tracking |
| `data_breaches` | 13 | Compliance breach reporting (DPDP / HIPAA) |
| `gdpr_erasure_log` | 11 | GDPR / data erasure audit |
| `legal_holds` | 7 | GDPR legal hold — blocks data erasure |
| `hipaa_access_log` | 9 | PHI access audit (HIPAA compliance) |
| `patient_consents` | 12 | Patient treatment/research consent records |

### 🧹 Housekeeping (migrations)
| Table | Columns | Purpose |
|-------|---------|---------|
| `housekeeping_zones` | 7 | Hospital zones for housekeeping |
| `housekeeping_logs` | 18 | Completed housekeeping tasks |
| `housekeeping_requests` | 27 | Housekeeping requests from staff/patients |
| `housekeeping_request_updates` | 7 | Request status updates |

### 🔔 Notifications (Prisma + migrations)
| Table | Source | Columns | Purpose |
|-------|--------|---------|---------|
| `notifications` | Prisma | 14 | Patient-facing push notifications |
| `notification_templates` | Prisma | 11 | Reusable notification templates |
| `notification_delivery_log` | Prisma | 6 | Delivery attempt log |
| `notification_outbox` | Migration 020 | 16 | Outbound notification queue with retry |
| `scheduled_notifications` | Migration 012 | 8 | Appointment reminder queue |
| `failed_notifications` | Migration 022 | 15 | Push/SMS failure retry queue |

### 💰 Billing (Prisma)
| Table | Columns | Purpose |
|-------|---------|---------|
| `invoices` | 21 | Patient invoices — line items in JSONB |
| `payment_transactions` | 8 | Payment records linked to invoices |
| `insurance_claims` | 15 | Insurance claim submissions |

### 🏃 Step Challenge (Prisma)
| Table | Columns | Purpose |
|-------|---------|---------|
| `step_profiles` | 8 | User step challenge opt-in + daily goal |
| `step_sessions` | 9 | Walk/step tracking sessions |
| `step_rewards` | 9 | Earned rewards from step goals |

### 📍 Location Services (Prisma)
| Table | Columns | Purpose |
|-------|---------|---------|
| `hospitals` | 9 | Nearby hospital directory |
| `pharmacies` | 8 | Nearby pharmacy directory |
| `blood_banks` | 8 | Nearby blood bank directory |

### 🔐 Security & Audit (Prisma + migrations)
| Table | Source | Columns | Purpose |
|-------|--------|---------|---------|
| `audit_logs` | Prisma | 10 | General resource-level audit (uid, role, action, resource) |
| `audit_log` | Migration 006 | 17 | HTTP request-level audit (middleware, different schema) |
| `admin_activity_logs` | Prisma | 8 | Admin portal action log |
| `medical_activity_logs` | Prisma | 9 | Medical staff action log |
| `pharmacy_activity_logs` | Prisma | 9 | Pharmacy staff action log |
| `hr_activity_logs` | Prisma | 6 | HR action log |
| `attendance_logs` | Prisma | 7 | Attendance action log |
| `api_access_logs` | Prisma | 8 | API endpoint access log |
| `system_alerts` | Prisma | 7 | System-level alerts |
| `admin_actions` | Migration 023 | 9 | Admin audit log for sensitive operations |
| `canary_checks` | Migration 020 | 4 | Health check / canary test results |
| `clinical_alerts` | Migration 020 | 12 | Clinical threshold alerts |
| `anomalies` | Prisma | 10 | Attendance anomaly summaries |

### 📱 Devices (Prisma)
| Table | Columns | Purpose |
|-------|---------|---------|
| `devices` | 13 | Patient app device registry (FCM tokens) |

### 🌐 ABDM / Interoperability (migrations)
| Table | Columns | Purpose |
|-------|---------|---------|
| `abdm_consents` | 14 | ABDM / ABHA consent management |
| `abdm_data_requests` | 12 | ABDM health data fetch requests |

### ⚙️ System (migrations)
| Table | Columns | Purpose |
|-------|---------|---------|
| `feature_flags` | 9 | Runtime feature toggle management |
| `system_settings` | 4 | Key-value config store |
| `user_roles` | 7 | Role metadata + permissions (7 roles seeded) |

---

## Key Column Notes

### admins (PK = `uid` UUID — NOT an integer)
- `uid` UUID `@id` — primary key
- `status` VARCHAR — 'active' | 'inactive' (mirrors `is_active`)
- `failed_login_attempts` INT — lockout counter
- `totp_enabled` BOOLEAN — 2FA gate
- `password_changed_at` TIMESTAMP
- `updated_at` TIMESTAMP

### staff (denormalized user fields)
- `name` VARCHAR — denormalized from `users.name` on staff creation
- `designation` VARCHAR — job title
- `performance_rating` DECIMAL(3,1)
- `last_review_date` DATE

### investigations (notification tracking)
- `patient_id` INT FK → `users.id`
- `notified` BOOLEAN — notification sent flag
- `turnaround_target_hours` INT — SLA target

### pharmacy_orders (delivery + billing)
- `patient_id` INT FK → `users.id`
- `created_at` — added by migration 021 (backfilled from `ordered_at`)
- Full delivery tracking: `delivery_lat/lng`, `tracking_active`, `sla_*_target`

### notification_outbox (retry queue)
- `retry_count` INT (NOT `attempts`)
- `last_attempt_at` TIMESTAMP (NOT `last_attempted_at`)
- `failure_reason` TEXT (NOT `error_message`)
- Both old and new column names exist — code uses new names

---

## Dual Audit Tables (⚠️ naming collision)

| Table | Schema | Written by |
|-------|--------|-----------|
| `audit_log` (singular) | HTTP middleware log — method, path, status_code, response_time_ms | Request middleware (every API call) |
| `audit_logs` (plural) | Resource audit — uid, role, action, resource, metadata | `logAudit.js` utility, specific controllers |

Both are intentionally in use. Do not confuse them.

---

## Known Gaps / Deferred

| Item | Detail |
|------|--------|
| `icd10_codes` table is empty | Exists but needs ~70k codes loaded via `icd10SeedData.js` |
| Migration 017 seed data not applied | Schema mismatches (contact_number, specialization cols) |
| `staff_salary.pf_uan` | Exists in DB but not in Prisma schema |
| 97 raw-SQL tables have no Prisma model | Fully functional, just no generated types |
