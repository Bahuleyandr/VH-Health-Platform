# Staff Role Workflow Sweep

Last generated: 2026-05-06 23:38:01 +05:30

Target: `https://dalekdefender.hippocampus-monitor.ts.net:8444/api/v1`

This is a live contract smoke for the seeded staff accounts. It verifies login, staff profile, attendance state, notifications, messaging, and the role-specific operational endpoints that the Flutter staff app opens. It does not expose tokens or API keys in this report.

## Summary

- Total checks: 122
- Passed: 122
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
| NURSING_STAFF | doctor_options_for_create | GET | `/appointments/doctors/options?limit=1` | 200 | pass | Appointment doctor options retrieved successfully |
| NURSING_STAFF | create_walk_in_appointment | POST | `/appointments/walk-in` | 200 | pass | Walk-in registered. Token #3 |
| NURSING_STAFF | search_created_patient | GET | `/patients/search?q=88990506233801&limit=5` | 200 | pass | Patient search results |
| NURSING_STAFF | created_appointment_in_list | GET | `/appointments/list?search=88990506233801&page=1&limit=5` | 200 | pass | Appointments retrieved successfully |
| NURSING_STAFF | create_investigation_booking | POST | `/investigations/bookings/create` | 200 | pass | Investigation booked. INV-20260506-00006 |
| PHARMACY_STAFF | created_investigation_visible_to_lab_not_pharmacy_queue_guard | GET | `/pharmacy-orders/orders/queue?limit=5` | 200 | pass | Order queue |
| DOCTOR | create_prescription | POST | `/prescriptions/create` | 200 | pass | Prescription RX-8fb3e18ce9d647378e9ccc9b9b372844 created |

## Create Context

- `appointmentId`: 15
- `patientId`: 102
- `patientPhone`: 88990506233801
- `patientName`: Smoke Patient 0506233801
- `doctorId`: 88
- `doctorName`: Dr. Aadarsh Raghavan
- `createdAppointmentId`: 15
- `createdInvestigationId`: 6
- `createdPrescriptionId`: 4

## Desktop App Smoke Note

The live API role matrix above passed for all eight seeded roles and includes
representative create paths. The Windows Flutter desktop route smoke is still
not reliable enough to use as a release gate: after updating it for the OP/IP
dashboard labels and disabling Crashlytics in test mode, `flutter test -d
windows` still times out around the Lab Bookings route in the integration test
harness. Treat that as a follow-up desktop harness/app-navigation issue, not as
a backend endpoint failure.

## Run Command

```powershell
$env:VH_BASE_URL = "https://<host>/api/v1"
$env:VH_API_KEY = "<redacted>"
$env:VH_STAFF_TEST_PASSWORD = "<seeded password>"
.\scripts\smoke-staff-role-workflows.ps1 -IncludeCreates
```
