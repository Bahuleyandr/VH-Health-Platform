# VHHealth — Complete System Routes & Pathways

Last updated: 2026-03-26

---

## Architecture

| Layer | Tech | Repo | Path | URL |
|-------|------|------|------|-----|
| Backend | Node.js/Express, Prisma, PostgreSQL | `vh-health-backend` | `/home/bahuleyan/vhhealth-backend` | `https://api.vhhealth.app` (port 5000) |
| Admin Portal | Next.js 15, React Query, Firebase auth | `VH-Health-Adminportal` | `/home/bahuleyan/vhhealth-admin` | `https://admin.vhhealth.app` (port 3001) |
| Patient App | Flutter (iOS/Android), Firebase OTP | `VH-health` | `/home/bahuleyan/vhhealth-patient` | — |
| Staff App | Flutter (iOS/Android) | `vhhealth-staff` | `/home/bahuleyan/vhhealth-staff` | — |

**Database:** PostgreSQL in Docker (`vhhealth-db`), port 5433, user `vhhealth`, db `vhhealth`
**Storage:** Cloudflare R2 (`vh-health-records`)
**Auth:** Firebase + Supabase (AWS us-west-1)
**SMS:** MSG91 (API key in `.env`)
**Infrastructure:** Raspberry Pi 5, Nginx + Cloudflare tunnel

---

## User Roles

| Role | Portal Access | Staff App | Patient App |
|------|--------------|-----------|-------------|
| PATIENT | ✗ | ✗ | ✓ |
| STAFF / GENERAL_STAFF | My Work section | ✓ (all staff features) | ✗ |
| DOCTOR | My Work + Doctor queue | ✓ (appointments + investigations) | ✗ |
| HR | My Work + HR Management | ✓ | ✗ |
| LAB_TECHNICIAN | My Work + Investigations | ✓ (lab bookings) | ✗ |
| NURSE / TECHNICIAN | My Work | ✓ | ✗ |
| RECEPTIONIST | My Work + Appointments | ✓ (appointment queue) | ✗ |
| ADMIN | Full access | ✓ | ✗ |
| SUPER_ADMIN | Full access + system settings | ✓ | ✗ |

---

## 1. APPOINTMENT SYSTEM

### Patient Flow
```
Patient opens app → Appointments → Select Department → Select Doctor → Pick Date →
  Slot picker (30-min slots from doctor's available_hours) → Enter reason → Book
    ↓
  Status: SCHEDULED (token not yet assigned)
    ↓
  Staff sees in pending queue → Calls patient → Confirms →
    Status: CONFIRMED (token #N assigned, SMS + push sent)
    ↓
  Appointment day → Patient visits → Staff marks complete →
    Status: COMPLETED
    ↓
  Staff uploads prescription/scan → Patient sees in Records →
    Push: "Document Available"
    ↓
  2 hours later → Feedback push notification
```

### Walk-in Flow
```
Staff registers walk-in (phone, doctor, department) →
  Status: CONFIRMED immediately (token assigned) → normal flow from there
```

### Backend Routes (`/api/v1/appointments`)

**Existing CRUD:**
| Method | Path | Controller | Description |
|--------|------|-----------|-------------|
| POST | `/book` | `appointmentCrudController.createAppointment` | Book appointment |
| PUT | `/:id` | `appointmentCrudController.updateAppointment` | Update appointment |
| PUT | `/:id/status` | `appointmentStatusController.updateAppointmentStatus` | Update status |
| DELETE | `/:id` | `appointmentCrudController.deleteAppointment` | Cancel/delete |
| GET | `/list` | `appointmentListController.listAppointments` | List with filters |
| GET | `/:id` | `appointmentListController.getAppointmentById` | Get by ID |
| GET | `/doctor/:doctor_id` | `appointmentListController.getDoctorAppointments` | Doctor's appointments |
| GET | `/patient/:patient_id` | `appointmentListController.getPatientAppointments` | Patient's appointments |
| GET | `/today/list` | `appointmentListController.getTodayAppointments` | Today's appointments |

**Workflow (new):**
| Method | Path | Controller | Description |
|--------|------|-----------|-------------|
| GET | `/slots?doctor_id&date` | `workflowController.getAvailableSlots` | 30-min slot grid |
| GET | `/queue/today` | `workflowController.getTodayQueue` | Today's queue (staff) |
| GET | `/pending` | `workflowController.getPendingAppointments` | Unconfirmed bookings |
| POST | `/walk-in` | `workflowController.registerWalkIn` | Walk-in registration |
| POST | `/:id/confirm` | `workflowController.confirmAppointment` | Confirm + assign token |
| POST | `/:id/no-show` | `workflowController.markNoShow` | Mark no-show |
| POST | `/:id/complete` | `workflowController.completeAppointment` | Mark completed |
| POST | `/:id/cancel` | `workflowController.cancelAppointment` | Cancel (with reason) |
| GET | `/:id/history` | `workflowController.getAppointmentHistory` | Status audit trail |

**Documents:**
| Method | Path | Controller | Description |
|--------|------|-----------|-------------|
| POST | `/documents/upload` | `docController.uploadAppointmentDocument` | Upload prescription (multipart) |
| GET | `/:appointment_id/documents` | `docController.getAppointmentDocuments` | Get docs for appointment |
| GET | `/patient/records/all` | `docController.getPatientAllRecords` | All patient records (hospital + own) |
| POST | `/patient/records/upload` | `docController.uploadPatientRecord` | Patient uploads own record (multipart) |
| DELETE | `/patient/records/:id` | `docController.deletePatientRecord` | Delete own record |

**Admin:**
| Method | Path | Controller | Description |
|--------|------|-----------|-------------|
| GET | `/admin/sla-dashboard` | `adminController.getAppointmentSLADashboard` | SLA metrics |
| GET | `/admin/audit-trail` | `adminController.getStatusAuditTrail` | Audit trail |
| GET | `/admin/documents` | `docController.getAllDocumentsAdmin` | All documents |

### DB Tables
- `appointments` — core table (+ token_number, confirmed_at, sla_target_at, first_contact_at, completed_at, department, reminder_24h_sent, reminder_1h_sent)
- `appointment_documents` — prescriptions/scans uploaded post-visit
- `patient_records` — patient-uploaded prior records
- `appointment_status_history` — full audit trail
- `scheduled_notifications` — deferred push (feedback requests)

### Crons
- Hourly: 24h + 1h appointment reminders (SMS + push)
- Daily 08:00: appointment reminder push
- Every 5 min: process scheduled_notifications (feedback requests)

---

## 2. INVESTIGATION SYSTEM

### Doctor-Ordered Investigations (existing)
```
Doctor orders investigation → Status: PENDING →
  Lab processes → Uploads result → Status: COMPLETED →
    Patient notified (push + SMS) → Views in app
```

### Patient Self-Booking (new)
```
Patient → Book Investigation → Select tests from catalog / type names / upload slip photo →
  Choose: Home Collection or Walk-in → Enter address (if home) → Book
    ↓
  Status: BOOKED (booking# INV-2026-XXXX, lab staff alerted)
    ↓
  Lab staff calls patient → Confirms tests + cost → Status: CONFIRMED (SMS + push)
    ↓
  Lab dispatches collector → Status: DISPATCHED (push: "Collector on the way")
    ↓
  Samples collected → Status: COLLECTED
    ↓
  Lab starts processing → Status: PROCESSING
    ↓
  Result PDF uploaded → Status: RESULT_READY (SMS + push)
    ↓
  Patient downloads from app → Status: DELIVERED
```

### Backend Routes (`/api/v1/investigations`)

**Existing:**
| Method | Path | Controller | Description |
|--------|------|-----------|-------------|
| GET | `/list` | `investigationController.listInvestigations` | List with filters |
| GET | `/:id` | `investigationController.getInvestigationById` | Get by ID |
| GET | `/patient/:patient_id` | `investigationController.getPatientInvestigations` | Patient's investigations |
| GET | `/doctor/:doctor_id` | `investigationController.getDoctorInvestigations` | Doctor's orders |
| GET | `/status/pending` | `investigationController.getPendingInvestigations` | Pending investigations |
| POST | `/order` | `orderController.orderInvestigation` | Doctor orders investigation |
| POST | `/:id/upload` | `uploadController.uploadResult` | Upload result file |
| PUT | `/:id/status` | `investigationController.updateInvestigationStatus` | Update status |
| PUT | `/:id/results` | `investigationController.addInvestigationResults` | Add text results |

**New (catalog + SLA):**
| Method | Path | Controller | Description |
|--------|------|-----------|-------------|
| GET | `/catalog` | `investigationController.getTestCatalog` | Test catalog (by category) |
| POST | `/catalog` | `investigationController.upsertTestCatalog` | Add/edit test (admin) |
| GET | `/sla-dashboard` | `investigationController.getInvestigationSLADashboard` | SLA metrics |

**Patient Bookings (new):**
| Method | Path | Controller | Description |
|--------|------|-----------|-------------|
| POST | `/bookings/create` | `bookingController.createBooking` | Patient books (multipart for slip) |
| GET | `/bookings/my` | `bookingController.getMyBookings` | Patient's own bookings |
| GET | `/bookings/queue` | `bookingController.getBookingQueue` | Lab staff queue |
| GET | `/bookings/sla` | `bookingController.getBookingSLADashboard` | SLA overview |
| GET | `/bookings/:id` | `bookingController.getBookingDetail` | Booking detail + history |
| POST | `/bookings/:id/confirm` | `bookingController.confirmBooking` | Confirm booking |
| POST | `/bookings/:id/dispatch` | `bookingController.dispatchCollector` | Dispatch collector |
| POST | `/bookings/:id/collected` | `bookingController.markCollected` | Mark collected |
| POST | `/bookings/:id/processing` | `bookingController.startProcessing` | Start processing |
| POST | `/bookings/:id/result` | `bookingController.uploadResult` | Upload result PDF (multipart) |

### DB Tables
- `investigations` — doctor-ordered investigations (+ turnaround_target_hours, result_uploaded_at, urgent_alert_sent, patient_notified_at)
- `investigation_files` — multiple files per investigation (+ uploaded_by, is_result)
- `investigation_test_catalog` — 24+ common tests with category, cost, TAT, fasting flag (+ home_collection_surcharge)
- `investigation_bookings` — patient self-booked investigations (7-stage lifecycle)
- `investigation_booking_history` — full audit trail

### SLA Targets
- Booking → Confirm: 30 minutes
- Confirm → Dispatch: 1 hour
- Dispatch → Collect: 2 hours
- Collect → Result: based on test turnaround_hours (from catalog)

---

## 3. STAFF MANAGEMENT (HR)

### Attendance
```
Staff opens app → Check In (GPS geofenced: 13.02936°N, 80.24409°E, 200m) →
  WiFi bypass: 'VHHealth-Staff', 'VHHealth-Internal' →
  Breaks tracked → Check Out → Calendar view
```

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/staff/hr/attendance/check-in` | GPS check-in |
| POST | `/api/v1/staff/hr/attendance/check-out` | Check-out |
| GET | `/api/v1/staff/hr/attendance/my-attendance` | My attendance |
| POST | `/api/v1/staff/hr/attendance/regularization` | Request regularization |

### Shifts
- 3 presets: Morning (8-5), Evening (4-11), Night (10-6)
- Custom shifts CRUD
- Staff assignments by admin

### Leave
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/staff/hr/leave/apply` | Apply for leave |
| GET | `/api/v1/staff/hr/leave/my-leaves` | My leave history |
| POST | `/api/v1/staff/admin/leave/:id/approve` | HR approves |
| POST | `/api/v1/staff/admin/leave/:id/reject` | HR rejects |

### Overtime
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/staff/hr/overtime/request` | Request overtime |
| POST | `/api/v1/staff/admin/overtime/:id/approve` | Approve overtime |

### Disputes
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/staff/hr/disputes/raise` | Raise dispute |
| POST | `/api/v1/staff/admin/disputes/:id/resolve` | Resolve dispute |

### Replacements
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/staff/hr/replacement/request` | Request replacement |
| POST | `/api/v1/staff/admin/replacement/:id/approve` | HR approves |

---

## 4. PAYROLL SYSTEM

### Monthly Payroll Flow
```
Cron (1st of month, 06:00) auto-generates payslips →
  HR reviews → Manual edits (optional, clears PDF) →
    HR signs → Admin countersigns → Issue to Staff →
      Staff notified (push) → Views in app → Downloads PDF (DOB-protected)
```

### Backend Routes

**Staff-facing (`/api/v1/staff/hr/payroll`):**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/my-payslips` | My payslips (last 12 months) |
| GET | `/payslip/:id/download` | Download payslip PDF |
| GET | `/tax-summary` | Annual tax summary |
| GET | `/declarations` | My investment declarations |
| POST | `/declarations/submit` | Submit 80C/80D declaration |
| GET | `/queries` | My payslip queries |
| POST | `/queries/raise` | Raise payslip query |
| GET | `/advances` | My salary advances |

**Admin (`/api/v1/staff/admin/payroll`):**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/runs` | All payroll runs |
| GET | `/runs/:runId` | Run detail with payslips |
| POST | `/run` | Generate payroll for month |
| POST | `/payslips/:id/edit` | Manual edit payslip |
| POST | `/runs/:runId/hr-sign` | HR sign run |
| POST | `/runs/:runId/admin-sign` | Admin countersign |
| POST | `/issue` | Issue payslips to staff |
| GET | `/comparison` | Multi-month comparison view |
| GET | `/export/summary` | CSV export |
| GET | `/export/pf` | PF ECR format |
| GET | `/export/esi` | ESI register |
| GET | `/compliance-calendar` | Statutory deadlines |
| GET | `/fnf` | F&F settlements list |
| POST | `/fnf/create` | Create F&F |
| POST | `/fnf/:id/approve` | Approve F&F |
| GET | `/gratuity` | Gratuity tracker |
| GET | `/declarations` | All declarations |
| POST | `/declarations/:id/approve` | Approve declaration |
| GET | `/leave-encashment` | Leave encashments |
| POST | `/leave-encashment/create` | Create leave encashment |
| GET | `/queries` | All payslip queries |
| POST | `/queries/:id/reply` | Reply to query |
| GET | `/bulk-revisions` | Bulk revision jobs |
| POST | `/bulk-revisions/create` | Create bulk revision |
| POST | `/bulk-revisions/:id/approve` | Approve and process |
| POST | `/tax-summary/all` | Generate all tax summaries |
| GET | `/advances` | All salary advances |
| POST | `/advances/create` | Create advance/loan |
| POST | `/revisions/:id/arrears` | Calculate arrears |

### Salary Components
- **Earnings:** Basic (prorated), HRA (40%), DA (10%), Special Allowance, Transport, Medical, Overtime (2x rate), Bonus, Arrears
- **Deductions:** PF (12%), ESI (0.75% if gross <₹21k), Professional Tax (TN slabs), TDS (new regime), Advance deduction, LOP
- **PDF:** A4, Venkataeswara Hospitals header, password-protected (DOB DDMMYYYY), 7-year retention

### Payroll DB Tables
- `staff_salary` — salary config per staff
- `payroll_runs` — monthly runs with dual-sign (hr_approved_by, admin_approved_by, approval_hash)
- `payslips` — individual payslips with all components (+ lop_days, arrears_amount, advance_deduction, revision_note)
- `salary_revisions` — individual and bulk revisions with dual-sign
- `salary_advances` — loan/advance tracking with auto-deduction
- `salary_arrears` — backdated revision arrears
- `annual_tax_summaries` — FY tax rollup
- `annual_review_reminders` — yearly review prompts
- `investment_declarations` — 80C/80D staff declarations
- `leave_encashments` — leave encashment records
- `payslip_queries` / `payslip_query_replies` — dispute thread
- `bulk_revision_jobs` — batch increment/bonus processing
- `full_final_settlements` — F&F on exit

---

## 5. INCIDENT REPORTING & GRIEVANCE

### Incidents
```
Staff reports → Auto-numbered INC-2026-XXXX → 10 types →
  Severity: low/moderate/severe/sentinel →
  Sentinel auto-escalates to urgent →
  HR assigns → Investigates → Resolves → Audit trail
```

### Grievances
```
Staff reports (optional anonymous) → GRV-2026-XXXX → 9 types →
  HR-only visibility (internal notes never exposed) →
  Assign → Resolve → Audit trail
```

---

## 6. HOUSEKEEPING SYSTEM

### Cleaning Logs
```
Staff → Select zone → Photo + notes → Submit (SHA-256 signature) →
  Admin verifies or flags → Photo compressed (72% quality, 1280px) → R2 storage →
  Purge: verified 90d, unverified 180d
```

### Requests
```
Staff/Admin raises request → HKR-2026-XXXX →
  SLA: urgent 30min, high 2h, normal 4h, low 24h →
  Assign → In Progress → Completed → Verified
```

### Routes (`/api/v1/staff/hr/housekeeping` and `/api/v1/staff/admin/housekeeping`)
| Type | Path | Description |
|------|------|-------------|
| Staff | `/zones` | List zones |
| Staff | `/log` | Submit cleaning log |
| Staff | `/logs/my` | My cleaning logs |
| Staff | `/request` | Raise request |
| Staff | `/requests/my` | My requests |
| Staff | `/requests/:id/complete` | Mark complete |
| Admin | `/logs` | All logs |
| Admin | `/logs/:id/verify` | Verify/flag log |
| Admin | `/requests` | All requests |
| Admin | `/requests/:id/assign` | Assign request |
| Admin | `/requests/:id/verify` | Verify request |
| Admin | `/requests/create` | Admin create request |
| Admin | `/zones` (POST) | Create zone |
| Admin | `/zones/:id` (PUT) | Update zone |
| Admin | `/stats` | Housekeeping stats |

---

## 7. AUDIT INFRASTRUCTURE

### Universal Audit Middleware
- Wired AFTER auth middleware via `setImmediate` (fire-and-forget)
- Captures: user, role, method, path, module, action, sanitized body, status, response time
- Redacts: passwords, tokens, OTPs, PAN, Aadhar, bank accounts
- 90-day retention, daily cleanup at 03:30

### Admin Portal Audit Pages
- `/dashboard/system-audit` — Live Feed, Log Search, User History
- `/dashboard/audit` — Report audit (incidents + grievances)
- `/dashboard/attendance-audit` — Attendance SLA, HR activity, geofence log

---

## 8. ADMIN PORTAL PAGES

| Path | Description | Min Role |
|------|-------------|----------|
| `/dashboard` | Role-aware home | All |
| `/dashboard/my-appointments` | Staff's appointment queue | STAFF |
| `/dashboard/my-attendance` | Staff's attendance calendar | STAFF |
| `/dashboard/my-leave` | Staff leave requests | STAFF |
| `/dashboard/my-payslips` | Staff payslip list + PDF | STAFF |
| `/dashboard/my-replacements` | Staff replacement requests | STAFF |
| `/dashboard/upload-prescription` | Upload consultation docs | STAFF |
| `/dashboard/appointments` | Full appointment management | ADMIN |
| `/dashboard/investigations` | Investigation management + lab bookings | HR |
| `/dashboard/housekeeping` | Housekeeping (5 tabs) | ADMIN |
| `/dashboard/payroll` | Payroll (5 tabs) + comparison | ADMIN |
| `/dashboard/attendance` | Attendance management | ADMIN |
| `/dashboard/leave-approvals` | Leave approval workflow | HR |
| `/dashboard/shifts` | Shift management | ADMIN |
| `/dashboard/incidents` | Incident management | HR |
| `/dashboard/grievances` | Grievance portal | HR |
| `/dashboard/audit` | Report audit | ADMIN |
| `/dashboard/attendance-audit` | Attendance audit | ADMIN |
| `/dashboard/system-audit` | Universal API audit | ADMIN |
| `/dashboard/users` | User management | ADMIN |
| `/dashboard/doctors` | Doctor management | ADMIN |
| `/dashboard/departments` | Department management | ADMIN |
| `/dashboard/staff` | Staff directory | HR |
| `/dashboard/records` | Medical records | All |
| `/dashboard/pharmacy` | Pharmacy management | ADMIN |
| `/dashboard/notifications` | Notification management | ADMIN |
| `/dashboard/analytics` | Analytics | ADMIN |
| `/dashboard/settings` | System settings | ADMIN |
| `/dashboard/payroll/comparison` | Multi-month payroll comparison | ADMIN |

---

## 9. DB MIGRATIONS

| # | File | Tables/Changes |
|---|------|---------------|
| 001 | base schema | users, appointments, doctors, departments, etc. |
| 002 | investigations_notify | notified, notified_at on investigations |
| 003 | attendance_features | attendance_records, leave_requests, regularization, replacements |
| 004 | shift_overtime | shifts, staff_shift_assignments, overtime_requests, disputes, geofence_breaches |
| 005 | incident_grievance | incident_reports, report_updates, staff_grievances |
| 006 | audit_log | audit_log table + indexes |
| 007 | housekeeping | housekeeping_zones, housekeeping_logs, housekeeping_requests, housekeeping_request_updates |
| 008 | payroll | staff_salary, payroll_runs, payslips, salary_revisions, annual_review_reminders |
| 009 | payroll_complete | salary_advances, advance_deductions, salary_arrears, annual_tax_summaries + LOP/arrears columns on payslips |
| 010 | payroll_compliance | full_final_settlements, investment_declarations, leave_encashments, payslip_queries, payslip_query_replies, bulk_revision_jobs |
| 011 | appointment_records | appointment workflow columns, appointment_documents, patient_records, appointment_status_history |
| 012 | appointment_reminders | reminder_24h_sent, reminder_1h_sent on appointments; scheduled_notifications |
| 013 | investigation_enhancements | turnaround_target_hours, result_uploaded_at, urgent_alert_sent on investigations; investigation_test_catalog (24 tests) |
| 014 | investigation_bookings | investigation_bookings, investigation_booking_history (patient self-booking lifecycle) |

---

## 10. CRON JOBS (scheduler.js)

| Schedule | Job | Description |
|----------|-----|-------------|
| Daily 00:00 | `cleanupOldNotifications` | Purge old notifications |
| Daily 00:00 | `cleanupDeletedUsers` | Purge deleted user data |
| Daily 02:00 | `archiveMigration` | Archive old data |
| Daily 03:00 (weekly Sun) | `analyticsCron` | Weekly analytics |
| Daily 03:30 | `auditLogCleanup` | Purge audit logs >90 days |
| Daily 03:45 | `housekeepingPurgeJob` | Purge old housekeeping photos from R2 |
| Daily 04:00 (weekly Sun) | `weeklyCleanup` | Weekly cleanup |
| Daily 08:00 | `sendAppointmentReminders` | Daily push reminders |
| Hourly | `sendTimedReminders` | 24h + 1h SMS/push reminders |
| Every 5 min | `processPendingScheduledNotifications` | Deferred notifications (feedback) |
| 1st of month 06:00 | `generateMonthlyPayslips` | Auto-generate payslips |
| Dec 1 08:00 | `generateAnnualReviewReminders` | Annual review reminders |
| R2 cleanup | `r2CleanupJob` | Orphaned file cleanup |

---

## 11. NOTIFICATIONS

| Event | Push | SMS | In-App |
|-------|------|-----|--------|
| Appointment confirmed | ✓ | ✓ | — |
| Appointment cancelled | ✓ | — | — |
| Appointment reminder 24h | ✓ | ✓ | — |
| Appointment reminder 1h | ✓ | ✓ | — |
| Prescription uploaded | ✓ | — | — |
| Post-visit feedback (2h later) | ✓ | — | — |
| Investigation result ready | ✓ | ✓ | ✓ |
| URGENT investigation ordered | ✓ (to lab staff) | — | — |
| Investigation booking confirmed | ✓ | ✓ | — |
| Collector dispatched | ✓ | — | — |
| Booking result ready | ✓ | ✓ | — |
| Payslip issued | ✓ | — | — |

---

## 12. KEY INFRASTRUCTURE

| Component | Detail |
|-----------|--------|
| GPS Geofence | 13.02936°N, 80.24409°E (Venkataeswara Hospitals, Nandanam, Chennai), 200m radius |
| WiFi Bypass | SSIDs: 'VHHealth-Staff', 'VHHealth-Internal' |
| R2 Storage | Bucket: vh-health-records; medical images 95%/4096px, operational 72%/1280px |
| Photo Purge | Verified: 90d, Unverified: 180d, Completed requests: 90d, Stale: 30d |
| Payslip Retention | 7 years |
| Audit Log Retention | 90 days |
| PDF Password | Staff DOB in DDMMYYYY format |
| SLA - Appointments | Booking → confirm: 30 min |
| SLA - Housekeeping | Urgent: 30min, High: 2h, Normal: 4h, Low: 24h |
| SLA - Investigation Booking | Confirm: 30min, Dispatch: 1h, Collect: 2h, Result: per test TAT |
