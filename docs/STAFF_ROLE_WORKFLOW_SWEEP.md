# Staff Role Workflow Sweep

Last generated: 2026-05-14 16:24:10 +05:30

Target: `https://dalekdefender.hippocampus-monitor.ts.net:8444/api/v1`

This is a live contract smoke for the seeded staff accounts. It verifies login, staff profile, attendance state, notifications, messaging, and the role-specific operational endpoints that the Flutter staff app opens. It does not expose tokens or API keys in this report.

## Summary

- Total checks: 169
- Passed: 169
- Required failures: 0
- Optional failures/skips: 0
- Create-flow checks: True

## Role Matrix

| Role | Check | Method | Path | Status | Result | Detail |
|---|---|---:|---|---:|---|---|
| NURSING_STAFF | login | POST | `/auth/staff/login` | 200 | pass | Staff login successful |
| NURSING_STAFF | login_role_matches_seed | ASSERT | `(token payload)` | ASSERT | pass | expected=NURSING_STAFF; actual=NURSING_STAFF |
| NURSING_STAFF | profile | GET | `/auth/staff/profile` | 200 | pass | Staff profile retrieved |
| NURSING_STAFF | attendance_today | GET | `/auth/staff/attendance/today` | 200 | pass | Today's attendance retrieved |
| NURSING_STAFF | attendance_history | GET | `/auth/staff/attendance/history?limit=5` | 200 | pass | Attendance history retrieved |
| NURSING_STAFF | campus_locations | GET | `/config/campus-locations` | 200 | pass | Campus configuration retrieved |
| NURSING_STAFF | notifications_my | GET | `/notifications/my?limit=5` | 200 | pass | Notifications fetched successfully |
| NURSING_STAFF | messages_unread | GET | `/messaging/unread-count` | 200 | pass | Unread count retrieved |
| NURSING_STAFF | messages_inbox | GET | `/messaging/inbox?limit=5` | 200 | pass | Inbox retrieved |
| NURSING_STAFF | appointments_list_today | GET | `/appointments/list?date=today&page=1&limit=10` | 200 | pass | Appointments retrieved successfully |
| NURSING_STAFF | appointments_queue_today | GET | `/appointments/queue/today` | 200 | pass | Today's queue fetched |
| NURSING_STAFF | appointments_pending | GET | `/appointments/pending` | 200 | pass | Pending appointments fetched |
| NURSING_STAFF | patient_search | GET | `/patients/search?q=Smoke&limit=5` | 200 | pass | Patient search results |
| NURSING_STAFF | bed_summary | GET | `/beds/summary` | 200 | pass | Bed summary retrieved |
| NURSING_STAFF | bed_list | GET | `/beds?limit=10` | 200 | pass | Beds retrieved |
| NURSING_STAFF | investigation_queue | GET | `/investigations/bookings/queue?limit=5` | 200 | pass | Booking queue fetched |
| NURSING_STAFF | pharmacy_queue | GET | `/pharmacy-orders/orders/queue?limit=5` | 200 | pass | Order queue |
| PHARMACY_STAFF | login | POST | `/auth/staff/login` | 200 | pass | Staff login successful |
| PHARMACY_STAFF | login_role_matches_seed | ASSERT | `(token payload)` | ASSERT | pass | expected=PHARMACY_STAFF; actual=PHARMACY_STAFF |
| PHARMACY_STAFF | profile | GET | `/auth/staff/profile` | 200 | pass | Staff profile retrieved |
| PHARMACY_STAFF | attendance_today | GET | `/auth/staff/attendance/today` | 200 | pass | Today's attendance retrieved |
| PHARMACY_STAFF | attendance_history | GET | `/auth/staff/attendance/history?limit=5` | 200 | pass | Attendance history retrieved |
| PHARMACY_STAFF | campus_locations | GET | `/config/campus-locations` | 200 | pass | Campus configuration retrieved |
| PHARMACY_STAFF | notifications_my | GET | `/notifications/my?limit=5` | 200 | pass | Notifications fetched successfully |
| PHARMACY_STAFF | messages_unread | GET | `/messaging/unread-count` | 200 | pass | Unread count retrieved |
| PHARMACY_STAFF | messages_inbox | GET | `/messaging/inbox?limit=5` | 200 | pass | Inbox retrieved |
| PHARMACY_STAFF | pharmacy_queue | GET | `/pharmacy-orders/orders/queue?limit=10` | 200 | pass | Order queue |
| PHARMACY_STAFF | pharmacy_sla | GET | `/pharmacy-orders/orders/sla` | 200 | pass | Success |
| PHARMACY_STAFF | pharmacy_catalog | GET | `/pharmacy-orders/catalog?limit=10` | 200 | pass | Catalog |
| PHARMACY_STAFF | prescriptions_all | GET | `/prescriptions/all?limit=5` | 200 | pass | All prescriptions |
| LAB_STAFF | login | POST | `/auth/staff/login` | 200 | pass | Staff login successful |
| LAB_STAFF | login_role_matches_seed | ASSERT | `(token payload)` | ASSERT | pass | expected=LAB_STAFF; actual=LAB_STAFF |
| LAB_STAFF | profile | GET | `/auth/staff/profile` | 200 | pass | Staff profile retrieved |
| LAB_STAFF | attendance_today | GET | `/auth/staff/attendance/today` | 200 | pass | Today's attendance retrieved |
| LAB_STAFF | attendance_history | GET | `/auth/staff/attendance/history?limit=5` | 200 | pass | Attendance history retrieved |
| LAB_STAFF | campus_locations | GET | `/config/campus-locations` | 200 | pass | Campus configuration retrieved |
| LAB_STAFF | notifications_my | GET | `/notifications/my?limit=5` | 200 | pass | Notifications fetched successfully |
| LAB_STAFF | messages_unread | GET | `/messaging/unread-count` | 200 | pass | Unread count retrieved |
| LAB_STAFF | messages_inbox | GET | `/messaging/inbox?limit=5` | 200 | pass | Inbox retrieved |
| LAB_STAFF | investigation_queue | GET | `/investigations/bookings/queue?limit=10` | 200 | pass | Booking queue fetched |
| LAB_STAFF | investigation_sla | GET | `/investigations/bookings/sla` | 200 | pass | Booking SLA dashboard |
| LAB_STAFF | investigation_catalog | GET | `/investigations/catalog?limit=10` | 200 | pass | Test catalog |
| LAB_STAFF | investigation_list | GET | `/investigations/list?page=1&limit=10` | 200 | pass | Investigations retrieved successfully |
| DOCTOR | login | POST | `/auth/staff/login` | 200 | pass | Staff login successful |
| DOCTOR | login_role_matches_seed | ASSERT | `(token payload)` | ASSERT | pass | expected=DOCTOR; actual=DOCTOR |
| DOCTOR | profile | GET | `/auth/staff/profile` | 200 | pass | Staff profile retrieved |
| DOCTOR | attendance_today | GET | `/auth/staff/attendance/today` | 200 | pass | Today's attendance retrieved |
| DOCTOR | attendance_history | GET | `/auth/staff/attendance/history?limit=5` | 200 | pass | Attendance history retrieved |
| DOCTOR | campus_locations | GET | `/config/campus-locations` | 200 | pass | Campus configuration retrieved |
| DOCTOR | notifications_my | GET | `/notifications/my?limit=5` | 200 | pass | Notifications fetched successfully |
| DOCTOR | messages_unread | GET | `/messaging/unread-count` | 200 | pass | Unread count retrieved |
| DOCTOR | messages_inbox | GET | `/messaging/inbox?limit=5` | 200 | pass | Inbox retrieved |
| DOCTOR | appointments_queue_today | GET | `/appointments/queue/today` | 200 | pass | Today's queue fetched |
| DOCTOR | appointments_pending | GET | `/appointments/pending` | 200 | pass | Pending appointments fetched |
| DOCTOR | doctor_options | GET | `/appointments/doctors/options?limit=20` | 200 | pass | Appointment doctor options retrieved successfully |
| DOCTOR | patient_search | GET | `/patients/search?q=Smoke&limit=5` | 200 | pass | Patient search results |
| DOCTOR | prescriptions_all | GET | `/prescriptions/all?limit=5` | 200 | pass | All prescriptions |
| DOCTOR | emr_icd_search | GET | `/emr/icd10/search?q=fever&limit=5` | 200 | pass | ICD-10 codes retrieved |
| DOCTOR | bed_summary | GET | `/beds/summary` | 200 | pass | Bed summary retrieved |
| HR_STAFF | login | POST | `/auth/staff/login` | 200 | pass | Staff login successful |
| HR_STAFF | login_role_matches_seed | ASSERT | `(token payload)` | ASSERT | pass | expected=HR_STAFF; actual=HR_STAFF |
| HR_STAFF | profile | GET | `/auth/staff/profile` | 200 | pass | Staff profile retrieved |
| HR_STAFF | attendance_today | GET | `/auth/staff/attendance/today` | 200 | pass | Today's attendance retrieved |
| HR_STAFF | attendance_history | GET | `/auth/staff/attendance/history?limit=5` | 200 | pass | Attendance history retrieved |
| HR_STAFF | campus_locations | GET | `/config/campus-locations` | 200 | pass | Campus configuration retrieved |
| HR_STAFF | notifications_my | GET | `/notifications/my?limit=5` | 200 | pass | Notifications fetched successfully |
| HR_STAFF | messages_unread | GET | `/messaging/unread-count` | 200 | pass | Unread count retrieved |
| HR_STAFF | messages_inbox | GET | `/messaging/inbox?limit=5` | 200 | pass | Inbox retrieved |
| HR_STAFF | hr_dashboard | GET | `/staff/hr/dashboard` | 200 | pass | HR dashboard data retrieved successfully |
| HR_STAFF | staff_list | GET | `/staff/list?page=1&limit=10` | 200 | pass | Staff directory retrieved successfully |
| HR_STAFF | leave_balance | GET | `/staff/hr/leave/balance` | 200 | pass | Leave balance retrieved successfully |
| HR_STAFF | replacement_pending | GET | `/staff/hr/replacement/pending` | 200 | pass | Pending replacement requests fetched |
| HR_STAFF | payroll_payslips | GET | `/staff/hr/payroll/my-payslips?limit=5` | 200 | pass | Payslips fetched |
| ADMIN | login | POST | `/auth/staff/login` | 200 | pass | Staff login successful |
| ADMIN | login_role_matches_seed | ASSERT | `(token payload)` | ASSERT | pass | expected=ADMIN; actual=ADMIN |
| ADMIN | profile | GET | `/auth/staff/profile` | 200 | pass | Staff profile retrieved |
| ADMIN | attendance_today | GET | `/auth/staff/attendance/today` | 200 | pass | Today's attendance retrieved |
| ADMIN | attendance_history | GET | `/auth/staff/attendance/history?limit=5` | 200 | pass | Attendance history retrieved |
| ADMIN | campus_locations | GET | `/config/campus-locations` | 200 | pass | Campus configuration retrieved |
| ADMIN | notifications_my | GET | `/notifications/my?limit=5` | 200 | pass | Notifications fetched successfully |
| ADMIN | messages_unread | GET | `/messaging/unread-count` | 200 | pass | Unread count retrieved |
| ADMIN | messages_inbox | GET | `/messaging/inbox?limit=5` | 200 | pass | Inbox retrieved |
| ADMIN | staff_list | GET | `/staff/list?page=1&limit=10` | 200 | pass | Staff directory retrieved successfully |
| ADMIN | appointments_list | GET | `/appointments/list?page=1&limit=10` | 200 | pass | Appointments retrieved successfully |
| ADMIN | doctors_options | GET | `/appointments/doctors/options?limit=20` | 200 | pass | Appointment doctor options retrieved successfully |
| ADMIN | investigation_sla | GET | `/investigations/bookings/sla` | 200 | pass | Booking SLA dashboard |
| ADMIN | pharmacy_sla | GET | `/pharmacy-orders/orders/sla` | 200 | pass | Success |
| ADMIN | admin_database_denied | GET | `/admin/database/overview` | 403 | pass | Response status code does not indicate success: 403 (Forbidden). |
| SUPER_ADMIN | login | POST | `/auth/staff/login` | 200 | pass | Staff login successful |
| SUPER_ADMIN | login_role_matches_seed | ASSERT | `(token payload)` | ASSERT | pass | expected=SUPER_ADMIN; actual=SUPER_ADMIN |
| SUPER_ADMIN | profile | GET | `/auth/staff/profile` | 200 | pass | Staff profile retrieved |
| SUPER_ADMIN | attendance_today | GET | `/auth/staff/attendance/today` | 200 | pass | Today's attendance retrieved |
| SUPER_ADMIN | attendance_history | GET | `/auth/staff/attendance/history?limit=5` | 200 | pass | Attendance history retrieved |
| SUPER_ADMIN | campus_locations | GET | `/config/campus-locations` | 200 | pass | Campus configuration retrieved |
| SUPER_ADMIN | notifications_my | GET | `/notifications/my?limit=5` | 200 | pass | Notifications fetched successfully |
| SUPER_ADMIN | messages_unread | GET | `/messaging/unread-count` | 200 | pass | Unread count retrieved |
| SUPER_ADMIN | messages_inbox | GET | `/messaging/inbox?limit=5` | 200 | pass | Inbox retrieved |
| SUPER_ADMIN | staff_list | GET | `/staff/list?page=1&limit=10` | 200 | pass | Staff directory retrieved successfully |
| SUPER_ADMIN | appointments_list | GET | `/appointments/list?page=1&limit=10` | 200 | pass | Appointments retrieved successfully |
| SUPER_ADMIN | doctors_options | GET | `/appointments/doctors/options?limit=20` | 200 | pass | Appointment doctor options retrieved successfully |
| SUPER_ADMIN | admin_database_overview | GET | `/admin/database/overview` | 200 | pass | Database overview |
| SUPER_ADMIN | admin_database_users_preview | GET | `/admin/database/tables/users/rows?limit=2` | 200 | pass | Table rows |
| GENERAL_STAFF | login | POST | `/auth/staff/login` | 200 | pass | Staff login successful |
| GENERAL_STAFF | login_role_matches_seed | ASSERT | `(token payload)` | ASSERT | pass | expected=GENERAL_STAFF; actual=GENERAL_STAFF |
| GENERAL_STAFF | profile | GET | `/auth/staff/profile` | 200 | pass | Staff profile retrieved |
| GENERAL_STAFF | attendance_today | GET | `/auth/staff/attendance/today` | 200 | pass | Today's attendance retrieved |
| GENERAL_STAFF | attendance_history | GET | `/auth/staff/attendance/history?limit=5` | 200 | pass | Attendance history retrieved |
| GENERAL_STAFF | campus_locations | GET | `/config/campus-locations` | 200 | pass | Campus configuration retrieved |
| GENERAL_STAFF | notifications_my | GET | `/notifications/my?limit=5` | 200 | pass | Notifications fetched successfully |
| GENERAL_STAFF | messages_unread | GET | `/messaging/unread-count` | 200 | pass | Unread count retrieved |
| GENERAL_STAFF | messages_inbox | GET | `/messaging/inbox?limit=5` | 200 | pass | Inbox retrieved |
| GENERAL_STAFF | staff_directory | GET | `/staff/list?page=1&limit=10` | 200 | pass | Staff directory retrieved successfully |
| GENERAL_STAFF | hr_shift | GET | `/staff/hr/shift` | 200 | pass | Shift fetched |
| GENERAL_STAFF | leave_balance | GET | `/staff/hr/leave/balance` | 200 | pass | Leave balance retrieved successfully |
| GENERAL_STAFF | payroll_payslips | GET | `/staff/hr/payroll/my-payslips?limit=5` | 200 | pass | Payslips fetched |
| BILLING_STAFF | login | POST | `/auth/staff/login` | 200 | pass | Staff login successful |
| BILLING_STAFF | login_role_matches_seed | ASSERT | `(token payload)` | ASSERT | pass | expected=BILLING_STAFF; actual=BILLING_STAFF |
| BILLING_STAFF | profile | GET | `/auth/staff/profile` | 200 | pass | Staff profile retrieved |
| BILLING_STAFF | attendance_today | GET | `/auth/staff/attendance/today` | 200 | pass | Today's attendance retrieved |
| BILLING_STAFF | attendance_history | GET | `/auth/staff/attendance/history?limit=5` | 200 | pass | Attendance history retrieved |
| BILLING_STAFF | campus_locations | GET | `/config/campus-locations` | 200 | pass | Campus configuration retrieved |
| BILLING_STAFF | notifications_my | GET | `/notifications/my?limit=5` | 200 | pass | Notifications fetched successfully |
| BILLING_STAFF | messages_unread | GET | `/messaging/unread-count` | 200 | pass | Unread count retrieved |
| BILLING_STAFF | messages_inbox | GET | `/messaging/inbox?limit=5` | 200 | pass | Inbox retrieved |
| BILLING_STAFF | billing_revenue_report | GET | `/billing/revenue?date_from=2026-04-14&date_to=2026-05-14` | 200 | pass | Revenue statistics retrieved |
| BILLING_STAFF | billing_insurance_claims | GET | `/billing/insurance/claims` | 200 | pass | Insurance claims retrieved |
| INSURANCE_COORDINATOR | login | POST | `/auth/staff/login` | 200 | pass | Staff login successful |
| INSURANCE_COORDINATOR | login_role_matches_seed | ASSERT | `(token payload)` | ASSERT | pass | expected=INSURANCE_COORDINATOR; actual=INSURANCE_COORDINATOR |
| INSURANCE_COORDINATOR | profile | GET | `/auth/staff/profile` | 200 | pass | Staff profile retrieved |
| INSURANCE_COORDINATOR | attendance_today | GET | `/auth/staff/attendance/today` | 200 | pass | Today's attendance retrieved |
| INSURANCE_COORDINATOR | attendance_history | GET | `/auth/staff/attendance/history?limit=5` | 200 | pass | Attendance history retrieved |
| INSURANCE_COORDINATOR | campus_locations | GET | `/config/campus-locations` | 200 | pass | Campus configuration retrieved |
| INSURANCE_COORDINATOR | notifications_my | GET | `/notifications/my?limit=5` | 200 | pass | Notifications fetched successfully |
| INSURANCE_COORDINATOR | messages_unread | GET | `/messaging/unread-count` | 200 | pass | Unread count retrieved |
| INSURANCE_COORDINATOR | messages_inbox | GET | `/messaging/inbox?limit=5` | 200 | pass | Inbox retrieved |
| INSURANCE_COORDINATOR | insurance_packages | GET | `/insurance/packages` | 200 | pass | Success |
| INSURANCE_COORDINATOR | insurance_preauth_pending | GET | `/insurance/preauth/pending` | 200 | pass | Success |
| INSURANCE_COORDINATOR | insurance_claims_list | GET | `/insurance/claims` | 200 | pass | Success |
| INSURANCE_COORDINATOR | insurance_enhancement_template | GET | `/insurance/enhancement-justification-template` | 200 | pass | Success |
| ADMISSION_OFFICER | login | POST | `/auth/staff/login` | 200 | pass | Staff login successful |
| ADMISSION_OFFICER | login_role_matches_seed | ASSERT | `(token payload)` | ASSERT | pass | expected=ADMISSION_OFFICER; actual=ADMISSION_OFFICER |
| ADMISSION_OFFICER | profile | GET | `/auth/staff/profile` | 200 | pass | Staff profile retrieved |
| ADMISSION_OFFICER | attendance_today | GET | `/auth/staff/attendance/today` | 200 | pass | Today's attendance retrieved |
| ADMISSION_OFFICER | attendance_history | GET | `/auth/staff/attendance/history?limit=5` | 200 | pass | Attendance history retrieved |
| ADMISSION_OFFICER | campus_locations | GET | `/config/campus-locations` | 200 | pass | Campus configuration retrieved |
| ADMISSION_OFFICER | notifications_my | GET | `/notifications/my?limit=5` | 200 | pass | Notifications fetched successfully |
| ADMISSION_OFFICER | messages_unread | GET | `/messaging/unread-count` | 200 | pass | Unread count retrieved |
| ADMISSION_OFFICER | messages_inbox | GET | `/messaging/inbox?limit=5` | 200 | pass | Inbox retrieved |
| ADMISSION_OFFICER | emr_admissions_list | GET | `/emr/admissions?page=1&limit=10` | 200 | pass | Active admissions retrieved |
| ADMISSION_OFFICER | emr_admissions_stats | GET | `/emr/admissions/stats` | 200 | pass | Admission statistics retrieved |
| IPD_COUNSELLOR | login | POST | `/auth/staff/login` | 200 | pass | Staff login successful |
| IPD_COUNSELLOR | login_role_matches_seed | ASSERT | `(token payload)` | ASSERT | pass | expected=IPD_COUNSELLOR; actual=IPD_COUNSELLOR |
| IPD_COUNSELLOR | profile | GET | `/auth/staff/profile` | 200 | pass | Staff profile retrieved |
| IPD_COUNSELLOR | attendance_today | GET | `/auth/staff/attendance/today` | 200 | pass | Today's attendance retrieved |
| IPD_COUNSELLOR | attendance_history | GET | `/auth/staff/attendance/history?limit=5` | 200 | pass | Attendance history retrieved |
| IPD_COUNSELLOR | campus_locations | GET | `/config/campus-locations` | 200 | pass | Campus configuration retrieved |
| IPD_COUNSELLOR | notifications_my | GET | `/notifications/my?limit=5` | 200 | pass | Notifications fetched successfully |
| IPD_COUNSELLOR | messages_unread | GET | `/messaging/unread-count` | 200 | pass | Unread count retrieved |
| IPD_COUNSELLOR | messages_inbox | GET | `/messaging/inbox?limit=5` | 200 | pass | Inbox retrieved |
| IPD_COUNSELLOR | emr_admissions_list | GET | `/emr/admissions?page=1&limit=10` | 200 | pass | Active admissions retrieved |
| IPD_COUNSELLOR | emr_admissions_review_due | GET | `/emr/admissions?review_due=true&page=1&limit=10` | 200 | pass | Active admissions retrieved |
| IPD_COUNSELLOR | emr_admissions_stats | GET | `/emr/admissions/stats` | 200 | pass | Admission statistics retrieved |
| NURSING_STAFF | doctor_options_for_create | GET | `/appointments/doctors/options?limit=1` | 200 | pass | Appointment doctor options retrieved successfully |
| NURSING_STAFF | create_walk_in_appointment | POST | `/appointments/walk-in` | 200 | pass | Walk-in registered. Visit OPD-20260514-003 |
| NURSING_STAFF | search_created_patient | GET | `/patients/search?q=88990514162410&limit=5` | 200 | pass | Patient search results |
| NURSING_STAFF | created_appointment_in_list | GET | `/appointments/list?search=88990514162410&page=1&limit=5` | 200 | pass | Appointments retrieved successfully |
| NURSING_STAFF | create_investigation_booking | POST | `/investigations/bookings/create` | 200 | pass | Investigation booked. INV-20260514-00009 |
| PHARMACY_STAFF | created_investigation_visible_to_lab_not_pharmacy_queue_guard | GET | `/pharmacy-orders/orders/queue?limit=5` | 200 | pass | Order queue |
| DOCTOR | create_prescription | POST | `/prescriptions/create` | 201 | pass | Prescription RX-5d8ee6ab6f44411ea8322185fb980179 created |

## Create Context

- `appointmentId`: 18
- `patientId`: 116
- `patientPhone`: 88990514162410
- `patientName`: Smoke Patient 0514162410
- `doctorId`: 88
- `doctorName`: Dr. Aadarsh Raghavan
- `createdAppointmentId`: 18
- `createdInvestigationId`: 9
- `createdPrescriptionId`: 7

## Run Command

```powershell
$env:VH_BASE_URL = "https://<host>/api/v1"
$env:VH_API_KEY = "<redacted>"
$env:VH_STAFF_TEST_PASSWORD = "<seeded password>"
.\scripts\smoke-staff-role-workflows.ps1 -IncludeCreates
```
