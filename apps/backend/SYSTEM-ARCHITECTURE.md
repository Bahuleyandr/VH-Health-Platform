# VHHealth — System Architecture

> **Last Updated:** 2026-04-23 (K8s migration rewrite)
> **Audited By:** Coder (AI Engineering Agent)
> **Source of Truth:** Full codebase audit + `infra/kubernetes/` manifests + `infra/ansible/` bootstrap.

---

## Architecture Overview

| Component | Technology | Cluster Location | Service Port |
|-----------|-----------|------------------|--------------|
| Backend API | Node.js 22 + Express | `Deployment/vhhealth-backend` in ns `vhhealth` | 5000 (ClusterIP) |
| Admin Portal | Next.js (React) | `Deployment/vhhealth-admin` in ns `vhhealth` | 3001 (ClusterIP) |
| Patient App | Flutter 3.41 | Client-side (Play Store / TestFlight) | — |
| Staff App | Flutter 3.41 | Client-side (internal distribution) | — |
| Shared Core | Flutter package | pub workspace member | — |
| Database | PostgreSQL 17 (CNPG) | `Cluster/vhhealth-pg` in ns `vhhealth-platform`, 3 replicas | 5432 (ClusterIP) |
| Cache / queues | Redis Sentinel | `StatefulSet/redis` in ns `vhhealth-platform`, 3 replicas | 6379 |
| Object storage (in-cluster) | MinIO | `StatefulSet/minio` in ns `vhhealth-platform`, 4×N-volume per node | 9000 / 9001 |
| Backup offsite | Cloudflare R2 | external, encrypted via pgBackRest | — |
| Registry | Harbor | `Deployment/harbor` in ns `harbor` (pull-through cache of ghcr) | 443 |
| Ingress | ingress-nginx + Cloudflare Tunnel | DaemonSet ingress-nginx + `Deployment/cloudflared` | 443 (external, tunnel) |
| GitOps | ArgoCD | `Deployment/argocd` in ns `argocd`, reconciles `overlays/prod` | — |
| File Storage (PHI) | Cloudflare R2 | S3-compatible API | — |
| Push Notifications | Firebase Cloud Messaging | external | — |
| Error Tracking | Sentry | external (self-host deferred — batch 17) | — |

---

## 1. Infrastructure

### Cluster
- **Topology:** 3 control-plane-capable nodes running RKE2 (Kubernetes 1.30+),
  etcd clustered across all 3 (quorum = 2), each node runs workloads too.
- **Cluster CIDR:** `10.42.0.0/16` pods, `10.43.0.0/16` services (RKE2 defaults).
- **CNI:** Canal (default); NetworkPolicy enforced between namespaces.
- **Runtime:** containerd (no Docker).
- **Provisioning:** Ansible (see `infra/ansible/`) — `site.yml` bootstraps Ubuntu
  24.04 nodes, installs RKE2, joins them into a cluster, and installs the CNPG
  operator + sealed-secrets controller.

### Node spec (per node — see `docs/HARDWARE_REQUIREMENTS.md`)
- **OS:** Ubuntu 24.04 LTS Server (minimal)
- **Hostname pattern:** `vhh-k8s-01`, `vhh-k8s-02`, `vhh-k8s-03`
- **Min CPU:** 16 vCPU (Xeon Silver 4310 / EPYC 7313P or newer)
- **Min RAM:** 64 GB ECC
- **Storage:** 2× 1 TB NVMe in RAID1 (cluster) + dedicated etcd volume
- **Network:** dual 10 GbE (bonded); IPMI on separate VLAN

### Runtime Versions
| Tool | Version |
|------|---------|
| Node.js | v22.22.1 (inside container image) |
| Flutter | 3.41.6 (stable, client-side) |
| containerd | 1.7.x (RKE2-managed) |
| PostgreSQL | 17 via CNPG operator (in-cluster) |
| Kubernetes | 1.30+ (RKE2) |

### Workloads (namespace: `vhhealth`)
| Workload | Kind | Replicas | Notes |
|----------|------|----------|-------|
| `vhhealth-backend` | Deployment | 2 (rolling) | HPA on CPU/QPS |
| `vhhealth-admin` | Deployment | 2 (rolling) | HPA on CPU |
| Migrations | Job | on each deploy | runs `ci-setup-db.mjs` against CNPG primary before traffic shifts |

### Platform services (namespace: `vhhealth-platform`)
| Workload | Kind | Replicas | Notes |
|----------|------|----------|-------|
| `vhhealth-pg` | CNPG `Cluster` | 3 (sync) | PG17, pgBackRest to MinIO + R2 |
| `redis` | StatefulSet | 3 (Sentinel) | token blacklist + rate-limit cache |
| `minio` | StatefulSet | 4 servers × N drives | in-cluster S3 for WAL + backups |
| `cloudflared` | Deployment | 3 (one per node via anti-affinity) | Cloudflare Tunnel connectors |

### Network
- **External ingress:** Cloudflare Tunnel → ingress-nginx → Service. Hospital
  firewall opens NO inbound ports; Cloudflare connectors dial out on 443 only.
- **Internal svc DNS:**
  - Backend: `vhhealth-backend.vhhealth.svc.cluster.local:5000`
  - Admin: `vhhealth-admin.vhhealth.svc.cluster.local:3001`
  - Primary Postgres: `vhhealth-pg-rw.vhhealth-platform.svc.cluster.local:5432`
  - Read-replicas: `vhhealth-pg-ro.vhhealth-platform.svc.cluster.local:5432`
  - Redis: `redis.vhhealth-platform.svc.cluster.local:6379`
  - MinIO: `minio.vhhealth-platform.svc.cluster.local:9000`
- **NetworkPolicy:** ingress-nginx → backend/admin; backend → CNPG + Redis +
  MinIO; admin → backend only. All other cross-namespace traffic denied.
- **API Docs:** `/api-docs` (Swagger UI) via backend Service.

### Environment Variables (Backend)
```
ADMIN_APP_ORIGINS, ADMIN_PASSWORD_COLUMN, ADMIN_TABLE
ALLOWED_ORIGINS, API_BASE_URL, API_KEY
CF_ACCOUNT_ID, CF_R2_BUCKET, CF_R2_URL, CF_R2_ACCESS_KEY_ID, CF_R2_SECRET_ACCESS_KEY
CLAMAV_API_KEY, CLAMAV_API_URL
DATABASE_URL, DEBUG_CORS
FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_PROJECT_ID
GENERIC_RATE_LIMIT_MAX_REQUESTS, GENERIC_RATE_LIMIT_WINDOW_MINUTES
JWT_EXPIRES_IN, JWT_SECRET
NODE_ENV, NODE_VERSION, PORT
PATIENT_APP_ORIGINS, PATIENT_RATE_LIMIT_MAX_REQUESTS, PATIENT_RATE_LIMIT_WINDOW_MINUTES
SENTRY_AUTH_TOKEN, SENTRY_DSN, SENTRY_ORG, SENTRY_PROJECT
```

---

## 2. User Roles

### Role Definitions (`src/utils/roles.js`)

| Role | Code | Portal Access | App Access |
|------|------|--------------|------------|
| Super Admin | `SUPER_ADMIN` | Admin Portal (full) | — |
| Admin | `ADMIN` | Admin Portal (full) | — |
| Doctor | `DOCTOR` | Admin Portal (limited) | Staff App |
| Nursing Staff | `NURSING_STAFF` | Admin Portal (limited) | Staff App |
| Pharmacy Staff | `PHARMACY_STAFF` | Admin Portal (limited) | Staff App |
| Lab Staff | `LAB_STAFF` | Admin Portal (limited) | Staff App |
| HR Staff | `HR_STAFF` | Admin Portal (limited) | Staff App |
| General Staff | `GENERAL_STAFF` | Admin Portal (self-service) | Staff App |
| Patient | `PATIENT` | — | Patient App |

### Admin Portal Role Enum (Additional Granularity)
`SUPER_ADMIN`, `ADMIN`, `HR`, `STAFF`, `DOCTOR`, `NURSE`, `PHARMACIST`, `TECHNICIAN`, `LAB_TECHNICIAN`, `RECEPTIONIST`, `PATIENT`

### Auth Flows
| User Type | Auth Method | Route Prefix |
|-----------|------------|--------------|
| Patient | Firebase Auth (phone + OTP) | `/api/v1/auth/firebase/*` |
| Admin | Username + Password + OTP | `/api/v1/auth/admin/*` |
| Staff | Employee ID + PIN + Device Trust | `/api/v1/auth/staff/*` |

---

## 3. Database

### Summary
- **Total Tables:** 99
- **Total Indexes:** 199
- **Total Triggers:** 8

### All Tables (99) — By Category

#### Authentication & Users (17)
| Table | Description |
|-------|-------------|
| `users` | All user profiles (patients, staff, admins) |
| `admins` | Admin accounts |
| `staff` | Staff profiles |
| `auth_logs` | Authentication event logs |
| `otp_codes` | OTP codes for verification |
| `otp_logs` | OTP request audit trail |
| `otp_sessions` | Active OTP sessions |
| `password_reset_otps` | Password reset tokens |
| `devices` | Patient device registrations |
| `user_devices` | User-device associations |
| `staff_devices` | Staff device registrations |
| `staff_auth_sessions` | Staff auth sessions |
| `user_action_logs` | User action audit trail |
| `user_deactivation_log` | Account deactivation log |
| `user_reactivation_log` | Account reactivation log |
| `user_role_audit` | Role change audit trail |
| `user_status_history` | User status change history |

#### Appointments (5)
| Table | Description |
|-------|-------------|
| `appointments` | All appointment records |
| `appointment_archive` | Archived old appointments |
| `appointment_documents` | Uploaded appointment documents |
| `appointment_status_history` | Status transition audit trail |
| `consultations` | Consultation records |

#### Departments & Doctors (3)
| Table | Description |
|-------|-------------|
| `departments` | Hospital departments |
| `doctors` | Doctor profiles and availability |
| `department_audit_log` | Department change audit trail |

#### Investigations / Lab (8)
| Table | Description |
|-------|-------------|
| `investigations` | Investigation orders |
| `investigation_bookings` | Home collection bookings |
| `investigation_booking_history` | Booking status history |
| `investigation_files` | Lab result file uploads |
| `investigation_templates` | Report templates |
| `investigation_template_tests` | Template-test mappings |
| `investigation_test_catalog` | Available lab tests |
| `investigation_files` | File attachments |

#### Pharmacy (5)
| Table | Description |
|-------|-------------|
| `pharmacy_catalog` | Medicine catalog |
| `pharmacy_orders` | Pharmacy orders |
| `pharmacy_order_history` | Order status history |
| `pharmacy_activity_logs` | Pharmacy activity audit |
| `medications` | Medication master data |

#### E-Prescriptions (1)
| Table | Description |
|-------|-------------|
| `e_prescriptions` | Electronic prescriptions |

#### Medical Records (3)
| Table | Description |
|-------|-------------|
| `medical_records` | Doctor-created medical records |
| `health_records` | Patient health records |
| `patient_records` | Legacy patient records |

#### Staff / HR (13)
| Table | Description |
|-------|-------------|
| `staff_attendance` | Daily attendance records |
| `attendance_logs` | Check-in/out raw logs |
| `attendance_disputes` | Disputed attendance entries |
| `attendance_regularization` | Regularization requests |
| `staff_breaks` | Break tracking |
| `staff_shifts` | Shift definitions |
| `staff_shift_assignments` | Staff-shift mappings |
| `leave_applications` | Leave requests |
| `leave_balance_overrides` | Manual leave balance overrides |
| `leave_encashments` | Leave encashment records |
| `replacement_requests` | Shift replacement requests |
| `staff_performance_reviews` | Performance review records |
| `staff_grievances` | Grievance submissions |

#### Housekeeping (4)
| Table | Description |
|-------|-------------|
| `housekeeping_zones` | Cleaning zones |
| `housekeeping_logs` | Cleaning log entries |
| `housekeeping_requests` | Cleaning requests |
| `housekeeping_request_updates` | Request status updates |

#### Payroll (12)
| Table | Description |
|-------|-------------|
| `staff_salary` | Salary configuration per staff |
| `payroll_runs` | Monthly payroll runs |
| `payslips` | Individual payslips |
| `payslip_queries` | Payslip dispute queries |
| `payslip_query_replies` | Admin replies to queries |
| `salary_revisions` | Salary revision proposals |
| `salary_arrears` | Arrears calculations |
| `salary_advances` | Salary advance records |
| `advance_deductions` | Advance deduction tracking |
| `investment_declarations` | Tax investment declarations |
| `annual_tax_summaries` | Annual tax summaries |
| `annual_review_reminders` | Review reminder tracking |
| `full_final_settlements` | Full & final settlement records |
| `bulk_revision_jobs` | Bulk salary revision jobs |
| `overtime_requests` | Overtime requests |

#### Incidents & Reports (2)
| Table | Description |
|-------|-------------|
| `incident_reports` | Incident reports |
| `report_updates` | Report status updates |

#### Beds & Wards (2)
| Table | Description |
|-------|-------------|
| `beds` | Bed inventory and status |
| `wards` | Ward definitions |

#### Notifications (4)
| Table | Description |
|-------|-------------|
| `notifications` | In-app notification store |
| `notification_templates` | Notification templates |
| `scheduled_notifications` | Scheduled future notifications |
| `failed_notifications` | Failed notification retry queue |

#### Delivery (1)
| Table | Description |
|-------|-------------|
| `delivery_location_updates` | Real-time delivery GPS tracking |

#### Feedback & SOS (3)
| Table | Description |
|-------|-------------|
| `feedback` | Patient feedback submissions |
| `feedback_responses` | Admin responses to feedback |
| `sos_alerts` | Emergency SOS alerts |

#### Audit & Logs (7)
| Table | Description |
|-------|-------------|
| `audit_log` | Universal audit log |
| `audit_logs` | Legacy audit log |
| `admin_activity_logs` | Admin action audit |
| `hr_activity_logs` | HR action audit |
| `medical_activity_logs` | Medical activity audit |
| `file_access_logs` | File access audit (HIPAA) |
| `file_deletion_log` | File deletion audit |

#### File Management (2)
| Table | Description |
|-------|-------------|
| `file_metadata` | Uploaded file metadata |
| `batch_upload_logs` | Batch upload tracking |

#### System (5)
| Table | Description |
|-------|-------------|
| `system_settings` | System configuration store |
| `system_alerts` | System alert records |
| `bulk_operation_logs` | Bulk operation tracking |
| `geofence_breaches` | Geofence breach records |
| `_migrations` | Migration tracking |

### Triggers (8)
| Trigger | Description |
|---------|-------------|
| `grievance_number_trigger` | Auto-generate grievance numbers |
| `hk_log_number_trigger` | Auto-generate housekeeping log numbers |
| `hk_req_number_trigger` | Auto-generate housekeeping request numbers |
| `incident_number_trigger` | Auto-generate incident numbers |
| `revision_number_trigger` | Auto-generate salary revision numbers |
| `trg_inv_booking_number` | Auto-generate investigation booking numbers |
| `trg_pharmacy_order_number` | Auto-generate pharmacy order numbers |
| `trg_rx_number` | Auto-generate prescription numbers |

### Seeded Data
| Entity | Count |
|--------|-------|
| Active Departments | 20 |
| Active Doctors | 20 |
| Active Medicines (Pharmacy Catalog) | 125 |
| Active Lab Tests (Investigation Catalog) | 24 |
| Housekeeping Zones | 14 |

---

## 4. Backend API — Complete Endpoint Map

Base URL: `http://localhost:5000/api/v1`

### Middleware Stack (in order)
1. `helmet` — Security headers
2. `express.json()` — Body parsing
3. `corsMiddleware` — CORS handling
4. `loggingMiddleware` — Request logging
5. `morganMiddleware` — HTTP logging
6. `attachUserContext` — User context injection
7. `auditLogMiddleware` — Audit logging
8. `validateApiKey` — API key validation (after public routes)
9. `authMiddleware` — JWT authentication (after API-key-only routes)
10. `normalizeIdentityFields` — Identity normalization
11. `rateLimitMiddleware` — Rate limiting (patient/admin/generic tiers)
12. `rbacMiddleware` — Role-based access control

### Public Routes (No Auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check, API version |
| GET | `/api-docs` | Swagger UI documentation |
| GET | `/api/v1/health/` | Basic health check |
| GET | `/api/v1/health/health-check` | Comprehensive health |
| GET | `/api/v1/health/app-version` | App version info |
| GET | `/api/v1/health/system/status` | System status |

### Authentication (`/api/v1/auth`)

#### Patient — Firebase Auth (`/auth/firebase`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/firebase/test` | Test route |
| GET | `/firebase/verify-token` | Verify Firebase token |
| GET | `/firebase/health` | Health status |
| POST | `/firebase/firebase-login` | Firebase phone login |
| POST | `/firebase/register` | Register new patient |
| POST | `/firebase/complete-profile` | Complete profile setup |
| POST | `/firebase/link-account` | Link existing account |
| POST | `/firebase/update-fcm-token` | Update FCM token |
| POST | `/firebase/revoke-session` | Revoke session |

#### Admin Auth (`/auth/admin`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/login` | Admin login (username + password) |
| POST | `/admin/forgot-password` | Initiate password reset |
| POST | `/admin/reset-password` | Reset password |
| GET | `/admin/health` | Health status |
| POST | `/admin/change-password` | Change password (auth required) |
| GET | `/admin/profile` | Get admin profile |
| POST | `/admin/create-admin` | Create new admin account |
| POST | `/admin/deactivate` | Deactivate admin |
| POST | `/admin/reactivate` | Reactivate admin |
| GET | `/admin/list` | List all admins |
| GET | `/admin/activity-logs/:adminId` | Admin activity logs |
| POST | `/admin/update-permissions` | Update admin permissions |

#### Admin OTP Management (`/auth/admin/otp`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/otp/analytics` | OTP analytics |
| GET | `/admin/otp/security-alerts` | Security alerts |
| GET | `/admin/otp/active-sessions` | Active OTP sessions |
| GET | `/admin/otp/logs` | OTP logs |
| GET | `/admin/otp/status/:phone` | OTP status by phone |
| POST | `/admin/otp/revoke-otp` | Revoke OTP |
| POST | `/admin/otp/cleanup-logs` | Cleanup old logs |
| POST | `/admin/otp/update-config` | Update OTP config |
| POST | `/admin/otp/force-send-otp` | Force send OTP |
| POST | `/admin/otp/bulk-delete-sessions` | Bulk delete sessions |

#### Staff Auth (`/auth/staff`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/staff/login` | Staff login (employee ID + password) |
| POST | `/staff/login-pin` | PIN-based login |
| POST | `/staff/register-device` | Register trusted device |
| POST | `/staff/quick-login` | Quick login (trusted device) |
| POST | `/staff/verify-device` | Verify device |
| GET | `/staff/health` | Health status |
| POST | `/staff/setup-pin` | Setup login PIN |
| POST | `/staff/toggle-biometric` | Toggle biometric auth |
| POST | `/staff/check-in` | Attendance check-in |
| POST | `/staff/check-out` | Attendance check-out |
| POST | `/staff/logout` | Logout |
| GET | `/staff/profile` | Get staff profile |
| GET | `/staff/devices` | Get registered devices |
| GET | `/staff/attendance/today` | Today's attendance |
| GET | `/staff/attendance/history` | Attendance history |
| DELETE | `/staff/device/:deviceId` | Remove trusted device |

#### Legacy Auth (`/auth`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/request-otp` | Request OTP |
| POST | `/verify-otp` | Verify OTP |
| POST | `/refresh-token` | Refresh JWT token |
| POST | `/logout` | Logout |
| POST | `/login` | Legacy login |
| POST | `/register` | Legacy register |
| GET | `/token` | Token refresh |
| GET | `/health` | Health status |
| GET | `/stats` | Public stats |

#### OTP Routes (`/auth/otp`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/otp/request-otp` | Request OTP |
| POST | `/otp/verify-otp` | Verify OTP |
| GET | `/otp/health` | Health status |

### Dashboard (`/api/v1/dashboard`)
*API key only — no JWT required*

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard/` | Patient dashboard data |

### Users (`/api/v1/users`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/profile` | Create or update user profile |
| POST | `/bulk-import` | Bulk import users |
| GET | `/` | List users |
| GET | `/:identifier` | Get user by ID/UID/phone |
| GET | `/role/:role` | Get users by role |
| GET | `/department/:department` | Get users by department |
| GET | `/search` | Search users |
| PUT | `/:identifier` | Update user |
| PUT | `/:identifier/status` | Change user status |
| DELETE | `/:identifier` | Deactivate user |

#### User Admin (`/api/v1/admin/users`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard` | User management dashboard |
| GET | `/analytics` | User analytics |
| GET | `/activity-audit` | Activity audit log |
| GET | `/inactive-users` | Inactive users report |
| POST | `/reactivate/:userId` | Reactivate user |
| POST | `/generate-report` | Generate user report |
| GET | `/system-info` | System info |

#### User Lookup (`/api/v1/users/lookup`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Lookup user |
| GET | `/advanced` | Advanced lookup |
| GET | `/verify` | Verify user exists |
| GET | `/stats` | User stats |
| GET | `/activity` | Recent activity |
| POST | `/bulk-search` | Bulk search |

### Appointments (`/api/v1/appointments`)

#### CRUD
| Method | Path | Description |
|--------|------|-------------|
| POST | `/book` | Book appointment |
| PUT | `/:id` | Update appointment |
| PUT | `/:id/status` | Update appointment status |
| DELETE | `/:id` | Delete appointment |

#### Listing
| Method | Path | Description |
|--------|------|-------------|
| GET | `/test` | Test route |
| GET | `/list` | List appointments (paginated) |
| GET | `/:id` | Get appointment by ID |
| GET | `/doctor/:doctor_id` | Get doctor's appointments |
| GET | `/patient/:patient_id` | Get patient's appointments |
| GET | `/today/list` | Today's appointments |

#### Workflow
| Method | Path | Description |
|--------|------|-------------|
| GET | `/queue/today` | Today's queue |
| GET | `/pending` | Pending appointments |
| GET | `/slots` | Available slots |
| POST | `/walk-in` | Register walk-in |
| GET | `/patient/records/all` | Patient's all records |
| POST | `/patient/records/upload` | Upload patient record |
| DELETE | `/patient/records/:id` | Delete patient record |
| POST | `/documents/upload` | Upload appointment document |
| GET | `/admin/sla-dashboard` | SLA dashboard |
| GET | `/admin/audit-trail` | Status audit trail |
| GET | `/admin/documents` | All documents (admin) |
| POST | `/:id/confirm` | Confirm appointment |
| POST | `/:id/no-show` | Mark no-show |
| POST | `/:id/complete` | Complete appointment |
| POST | `/:id/cancel` | Cancel appointment |
| GET | `/:id/history` | Appointment status history |
| GET | `/:appointment_id/documents` | Get appointment documents |

### Investigations (`/api/v1/investigations`)

#### Query
| Method | Path | Description |
|--------|------|-------------|
| GET | `/test` | Test route |
| GET | `/catalog` | Test catalog |
| GET | `/sla-dashboard` | Investigation SLA dashboard |
| GET | `/list` | List investigations |
| GET | `/status/pending` | Pending investigations |
| GET | `/bookings/my` | My bookings |
| GET | `/bookings/queue` | Booking queue |
| GET | `/bookings/sla` | Booking SLA dashboard |
| GET | `/bookings/:id` | Booking detail |
| GET | `/patient/:patient_id` | Patient investigations |
| GET | `/doctor/:doctor_id` | Doctor's investigations |
| GET | `/type/:type` | Investigations by type |
| GET | `/uid/:uid` | Investigations by UID |
| GET | `/:id/files` | Investigation files |
| GET | `/:id/files/:fileId` | File info |
| GET | `/:id/files/:fileId/download` | Download file |
| GET | `/:id` | Investigation by ID |
| GET | `/:phone` | Investigations by phone |

#### Mutations
| Method | Path | Description |
|--------|------|-------------|
| POST | `/bookings/create` | Create booking (with slip photo) |
| POST | `/bookings/:id/confirm` | Confirm booking |
| POST | `/bookings/:id/dispatch` | Dispatch collector |
| POST | `/bookings/:id/collected` | Mark samples collected |
| POST | `/bookings/:id/processing` | Start processing |
| POST | `/bookings/:id/result` | Upload result file |
| POST | `/catalog` | Upsert test catalog |
| POST | `/order` | Order investigation |
| POST | `/:id/upload` | Upload result |
| POST | `/` | Legacy investigation request |
| DELETE | `/:id/files/:fileId` | Remove file |
| PUT | `/:id/status` | Update investigation status |
| PUT | `/:id/results` | Add investigation results |

#### Investigation Admin Stats (`/api/v1/investigations/stats`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/summary` | Investigation statistics |

### Pharmacy (`/api/v1/pharmacy-orders`)

#### Catalog
| Method | Path | Description |
|--------|------|-------------|
| GET | `/catalog` | Get pharmacy catalog |
| POST | `/catalog` | Upsert catalog item |

#### Orders (`/pharmacy-orders/orders`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/place` | Place order (with prescription upload) |
| GET | `/my` | My orders |
| GET | `/queue` | Order queue |
| GET | `/sla` | Pharmacy SLA dashboard |
| GET | `/:id/detail` | Order detail |
| POST | `/:id/confirm` | Confirm order |
| POST | `/:id/preparing` | Mark preparing |
| POST | `/:id/dispatch` | Dispatch order |
| POST | `/:id/delivered` | Mark delivered |
| POST | `/:id/cancel` | Cancel order |
| POST | `/` | Legacy place order |
| GET | `/uid/:uid` | Orders by UID |
| GET | `/:phone` | Orders by phone |
| PUT | `/:orderId/status` | Update order status |

#### Medications (`/pharmacy-orders/medications`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | All medications |
| GET | `/:id` | Medication by ID |
| GET | `/category/:category` | By category |
| GET | `/search` | Search medications |
| PUT | `/:id/stock` | Update stock |
| POST | `/` | Create medication |
| PUT | `/:id` | Update medication |
| DELETE | `/:id` | Delete medication |

#### Inventory (`/pharmacy-orders/inventory`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/low-stock` | Low stock items |
| GET | `/expired` | Expired items |
| GET | `/expiring-soon` | Expiring soon |
| GET | `/summary` | Inventory summary |
| GET | `/categories/list` | Category list |

#### Pharmacy Admin (`/pharmacy-orders/admin`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/orders` | All orders |
| GET | `/analytics` | Pharmacy analytics |

### Prescriptions (`/api/v1/prescriptions`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/create` | Create e-prescription (with handwritten photo upload) |
| GET | `/patient/my` | My prescriptions |
| GET | `/all` | All prescriptions |
| GET | `/appointment/:appointmentId` | Prescription by appointment |
| GET | `/pdf/:id` | Download prescription PDF |
| GET | `/:id` | Get prescription |
| POST | `/:id/order-pharmacy` | Order pharmacy from prescription |

### Delivery (`/api/v1/delivery`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/location-update` | Update delivery location (GPS) |
| POST | `/stop-tracking` | Stop delivery tracking |
| GET | `/track/:order_type/:order_id` | Get delivery tracking |

### Departments (`/api/v1/departments`)

#### Public
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | All departments |
| GET | `/departments-with-doctors` | Departments with doctors |
| GET | `/list` | Department list |
| GET | `/available/now` | Currently available departments |
| GET | `/:identifier` | Department details |
| POST | `/` | Add department |
| POST | `/create` | Create department |
| PUT | `/:id` | Update department |
| PUT | `/:id/deactivate` | Deactivate department |
| DELETE | `/:departmentId` | Delete department |

#### Admin Departments (`/api/v1/admin/departments`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/overview` | Department overview |
| GET | `/manage` | Management data |
| GET | `/:id/financial` | Financial overview |
| GET | `/:id/staff-allocation` | Staff allocation |
| POST | `/create` | Create department |
| POST | `/bulk-operations` | Bulk operations |
| PUT | `/:id` | Update department |
| PUT | `/:id/deactivate` | Deactivate with reassignment |
| GET | `/export/csv` | Export CSV |
| GET | `/:id/export/report` | Export department report |
| GET | `/:id/history` | Department history |
| GET | `/activities/recent` | Recent activities |

#### Department Stats (`/api/v1/departments/stats`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/comparison` | Department comparison |
| GET | `/:id` | Department stats |
| GET | `/:id/performance` | Department performance |
| GET | `/:id/trends` | Department trends |
| GET | `/:id/analytics` | Department analytics |

### Doctors (`/api/v1/doctors`)

#### Public
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | All doctors |
| GET | `/list` | Doctor list |
| GET | `/:doctorId` | Doctor by ID |
| GET | `/profile/:id` | Doctor profile |
| GET | `/department/:department` | Doctors by department |
| GET | `/available/now` | Available doctors |
| POST | `/` | Add doctor |
| POST | `/profile` | Create doctor profile |
| PUT | `/:id/profile` | Update doctor profile |
| PUT | `/:id/availability` | Update availability |
| DELETE | `/:doctorId` | Delete doctor |
| DELETE | `/:id/deactivate` | Deactivate doctor |

#### Admin Doctors (`/api/v1/admin/doctors`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/overview` | Doctor overview |
| GET | `/manage` | Management list |
| GET | `/:id/analytics` | Doctor analytics |
| GET | `/workload-analysis` | Workload analysis |
| POST | `/create` | Create doctor account |
| POST | `/bulk-operations` | Bulk operations |
| PUT | `/:id/profile` | Update doctor profile |
| PUT | `/:id/availability` | Update availability |
| DELETE | `/:id/account` | Delete doctor account |

#### Doctor Stats (`/api/v1/doctors/stats`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/:id` | Doctor stats |

### Staff (`/api/v1/staff`)
*JWT required*

#### Staff Management
| Method | Path | Description |
|--------|------|-------------|
| GET | `/list` | Staff list |
| GET | `/:identifier` | Staff profile |
| GET | `/department/:department` | Staff by department |
| GET | `/shift/:shift` | Staff by shift |
| GET | `/stats/summary` | Staff statistics |
| POST | `/create` | Create staff profile |
| PUT | `/:id` | Update staff profile |

#### Attendance (`/staff/attendance`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Mark attendance |
| POST | `/:id/regularize` | Request regularization |
| POST | `/:id/break/start` | Start break |
| POST | `/:id/break/end` | End break |
| POST | `/:id/dispute` | Submit dispute |
| GET | `/:id` | Get attendance |
| GET | `/:id/calendar` | Attendance calendar |
| GET | `/:id/break/today` | Today's breaks |
| GET | `/:id/disputes` | My disputes |

#### HR (`/staff/hr`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard` | HR dashboard |
| GET | `/performance-report` | Performance report |
| GET | `/onboarding/:staff_id` | Onboarding checklist |
| GET | `/leave-balance/:staff_id` | Leave balance |
| GET | `/department/:department/summary` | Department staff summary |
| GET | `/attendance-analytics` | Attendance analytics |
| GET | `/export-report` | Export staff report |
| GET | `/replacement/pending` | Pending replacements |
| GET | `/replacement/history` | Replacement history |
| GET | `/shifts` | All shifts |
| GET | `/shift/my-shift` | My shift |
| GET | `/overtime` | My overtime requests |
| GET | `/incidents` | My incidents |
| GET | `/incidents/:id` | Incident detail |
| GET | `/grievances` | My grievances |
| GET | `/grievances/:id` | Grievance detail |
| GET | `/housekeeping/zones` | Housekeeping zones |
| GET | `/housekeeping/logs/my` | My cleaning logs |
| GET | `/housekeeping/requests/my` | My requests |
| GET | `/housekeeping/requests/:id` | Request detail |
| GET | `/payslips` | My payslips |
| GET | `/payslips/:id` | Payslip detail |
| GET | `/payroll/tax-summary` | My tax summary |
| GET | `/payroll/advances` | My salary advances |
| GET | `/payroll/declarations` | My investment declarations |
| GET | `/payroll/queries` | My payslip queries |
| POST | `/performance-review` | Create performance review |
| POST | `/leave/apply` | Apply for leave |
| POST | `/replacement/request` | Request replacement |
| POST | `/replacement/:id/respond` | Respond to replacement |
| POST | `/replacement/:id/hr-approve` | HR approve replacement |
| POST | `/overtime/request` | Request overtime |
| POST | `/overtime/:id/approve` | Approve overtime |
| POST | `/incidents/submit` | Submit incident |
| POST | `/grievances/submit` | Submit grievance |
| POST | `/housekeeping/log` | Submit cleaning log |
| POST | `/housekeeping/request` | Raise cleaning request |
| POST | `/housekeeping/requests/:id/complete` | Complete request |
| POST | `/payroll/declarations/submit` | Submit investment declaration |
| POST | `/payroll/queries/raise` | Raise payslip query |

#### Medical (`/staff/medical`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/consultations` | Upload consultation |
| POST | `/investigations` | Upload investigation |

#### Pharmacy (`/staff/pharmacy`)
| Method | Path | Description |
|--------|------|-------------|
| PUT | `/orders` | Update pharmacy order |

#### Staff Admin (`/staff/admin`)

##### Dashboard & Analytics (GET)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard` | Staff admin dashboard |
| GET | `/analytics/attendance` | Attendance analytics |
| GET | `/analytics/performance` | Performance analytics |
| GET | `/analytics/department-wise` | Department analytics |
| GET | `/analytics/leave-patterns` | Leave pattern analytics |
| GET | `/attendance/anomalies` | Attendance anomalies |
| GET | `/attendance/late-arrivals` | Late arrivals report |
| GET | `/attendance/early-departures` | Early departures |
| GET | `/attendance/absent-report` | Absent report |
| GET | `/attendance/disputes/pending` | Pending disputes |
| GET | `/attendance/geofence-breaches` | Geofence breaches |
| GET | `/attendance/bulk-template` | Bulk attendance template |
| GET | `/hr/pending-reviews` | Pending reviews |
| GET | `/hr/leave-requests` | All leave requests |
| GET | `/hr/onboarding-status` | Onboarding status |
| GET | `/leave/pending` | Pending leaves |
| GET | `/replacement/pending-hr` | Pending replacements |
| GET | `/shifts` | All shifts |
| GET | `/shifts/presets` | Shift presets |
| GET | `/overtime/pending` | Pending overtime |
| GET | `/reports/efficiency` | Efficiency report |
| GET | `/reports/overtime` | Overtime report |
| GET | `/reports/turnover` | Turnover report |
| GET | `/search` | Advanced staff search |
| GET | `/export/:type` | Export staff data |
| GET | `/incidents` | All incidents |
| GET | `/incidents/stats` | Incident statistics |
| GET | `/incidents/:id` | Incident detail |
| GET | `/grievances` | All grievances |
| GET | `/grievances/stats` | Grievance statistics |
| GET | `/grievances/:id` | Grievance detail |
| GET | `/housekeeping/logs` | All cleaning logs |
| GET | `/housekeeping/requests` | All requests |
| GET | `/housekeeping/stats` | Housekeeping stats |
| GET | `/housekeeping/zones` | Zones |
| GET | `/payroll/runs` | Payroll runs |
| GET | `/payroll/runs/:runId` | Payroll run detail |
| GET | `/payroll/staff` | Staff for payroll |
| GET | `/payroll/salary/:staffUid` | Staff salary config |
| GET | `/payroll/revisions` | Salary revisions |
| GET | `/payroll/revisions/:id` | Revision detail |

##### Audit (GET)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/audit/dashboard` | Audit dashboard |
| GET | `/audit/activity` | Admin activity report |
| GET | `/audit/sla` | SLA report |
| GET | `/audit/trail/:type/:id` | Audit trail |
| GET | `/audit/attendance/dashboard` | Attendance audit dashboard |
| GET | `/audit/attendance/hr-activity` | HR activity |
| GET | `/audit/attendance/sla` | Attendance SLA |
| GET | `/audit/attendance/geofence` | Geofence breach log |
| GET | `/audit/attendance/leave/:id` | Leave audit trail |

##### Mutations (POST/PUT/DELETE)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/override/leave-balance` | Override leave balance |
| POST | `/generate-payroll-data` | Generate payroll data |
| POST | `/sync-biometric` | Sync biometric data |
| POST | `/incidents/:id/update` | Update incident |
| POST | `/grievances/:id/update` | Update grievance |
| POST | `/housekeeping/requests/:id/assign` | Assign request |
| POST | `/housekeeping/logs/:id/verify` | Verify cleaning log |
| POST | `/housekeeping/requests/:id/verify` | Verify request |
| POST | `/housekeeping/zones` | Create zone |
| POST | `/housekeeping/requests/create` | Admin create request |
| POST | `/payroll/run` | Run payroll |
| POST | `/payroll/issue` | Issue payslips |
| POST | `/payroll/salary/:staffUid` | Upsert salary config |
| POST | `/payroll/tax-summary/all` | Generate all tax summaries |
| POST | `/payroll/advances/create` | Create advance |
| POST | `/payroll/revisions/:revisionId/arrears` | Calculate revision arrears |
| POST | `/payroll/payslips/:id/edit` | Manual edit payslip |
| POST | `/payroll/runs/:runId/hr-sign` | HR sign payroll run |
| POST | `/payroll/runs/:runId/admin-sign` | Admin sign payroll run |
| POST | `/payroll/revisions/propose` | Propose salary revision |
| POST | `/payroll/revisions/:id/hr-sign` | HR sign revision |
| POST | `/payroll/revisions/:id/admin-sign` | Admin sign revision |
| POST | `/payroll/revisions/:id/apply` | Apply revision |
| POST | `/payroll/revisions/:id/reject` | Reject revision |
| POST | `/payroll/fnf/create` | Create full & final settlement |
| POST | `/payroll/fnf/:id/approve` | Approve FnF |
| POST | `/payroll/fnf/:id/mark-paid` | Mark FnF paid |
| POST | `/payroll/declarations/:id/approve` | Approve declaration |
| POST | `/payroll/leave-encashment/create` | Calculate leave encashment |
| POST | `/payroll/queries/:id/reply` | Reply to payslip query |
| POST | `/payroll/bulk-revisions/create` | Create bulk revision |
| POST | `/payroll/bulk-revisions/:id/approve` | Approve bulk revision |
| PUT | `/status/:staffId` | Update staff status |
| PUT | `/approve/performance-review/:reviewId` | Approve review |
| PUT | `/approve/leave/:leaveId` | Approve leave |
| PUT | `/shifts/custom/:id` | Update custom shift |
| PUT | `/housekeeping/zones/:id` | Update zone |
| DELETE | `/archive/:staffId` | Archive staff member |
| DELETE | `/purge/old-records` | Purge old records |
| DELETE | `/shifts/custom/:id` | Deactivate shift |

### Notifications (`/api/v1/notifications`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/test` | Test route |
| GET | `/:phone` | Notifications by phone |
| GET | `/user/:user_id` | Notifications by user ID |
| GET | `/detail/:id` | Notification detail |
| GET | `/list` | List notifications |
| PATCH | `/:id/read` | Mark as read |
| PATCH | `/:phone/mark-all-read` | Mark all read (by phone) |
| PATCH | `/user/:user_id/read-all` | Mark all read (by user ID) |
| POST | `/create` | Create notification |
| POST | `/bulk` | Send bulk notifications |
| GET | `/stats/summary` | Notification stats |
| GET | `/scheduled/pending` | Pending scheduled |
| GET | `/emergency/active` | Active emergencies |
| DELETE | `/:id` | Delete notification |

#### Admin Notifications (`/api/v1/admin/notifications`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/overview` | Notification overview |
| GET | `/manage` | Management list |
| GET | `/templates` | Notification templates |
| GET | `/delivery-stats` | Delivery statistics |
| POST | `/` | Send legacy notification |
| POST | `/announcement` | Send announcement |
| POST | `/targeted` | Send targeted notification |
| POST | `/bulk-operations` | Bulk operations |
| POST | `/templates` | Create template |
| POST | `/send-from-template` | Send from template |
| DELETE | `/cleanup` | Cleanup old notifications |

### Medical Records (`/api/v1/records`)

#### Patient
| Method | Path | Description |
|--------|------|-------------|
| GET | `/uid/:uid` | Records by UID |
| GET | `/health-records/:phone` | Health records by phone |
| POST | `/health-records` | Create health record |
| GET | `/consultations/:phoneNumber` | Consultations by phone |

#### Doctor
| Method | Path | Description |
|--------|------|-------------|
| POST | `/create` | Create medical record |
| PUT | `/:id` | Update medical record |

#### Medical Staff
| Method | Path | Description |
|--------|------|-------------|
| GET | `/records` | All records |
| GET | `/records/:id` | Record by ID |
| GET | `/patient/:patient_id` | Patient records |
| GET | `/doctor/:doctor_id` | Doctor's records |
| GET | `/patient/:patient_id/summary` | Patient summary |
| GET | `/search` | Search records |

#### Admin Records
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/analytics` | Record analytics |
| GET | `/admin/hipaa-audit` | HIPAA audit log |
| GET | `/export/pdf` | Export as PDF |
| GET | `/export/excel` | Export as Excel |
| DELETE | `/:id` | Delete record |

### Health Records (`/api/v1/health`)
*Protected routes (after auth)*

| Method | Path | Description |
|--------|------|-------------|
| GET | `/records` | Health records |
| GET | `/records/:id` | Record by ID |
| POST | `/records` | Create record |
| PUT | `/records/:id` | Update record |
| GET | `/patient/:patient_id/summary` | Patient summary |
| GET | `/patient/:patient_id/trends` | Health trends |
| GET | `/patient/:patient_id/allergies` | Allergies |
| GET | `/patient/:patient_id/conditions` | Conditions |
| GET | `/stats/overview` | Health stats overview |

### Feedback (`/api/v1/feedback`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/uid/:uid` | Feedback by UID |
| GET | `/my-feedback` | My feedback |
| GET | `/my-stats` | My stats |
| GET | `/dashboard` | Feedback dashboard |
| GET | `/recent` | Recent feedback |
| GET | `/analytics` | Feedback analytics |
| GET | `/report` | Feedback report |
| POST | `/` | Submit feedback |
| POST | `/quick-rating` | Quick rating |

### SOS / Emergency (`/api/v1/sos`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Create emergency alert |
| POST | `/emergency-contact` | Update emergency contact |
| POST | `/cancel/:alertId` | Cancel alert |
| GET | `/my-alerts` | My alerts |
| GET | `/nearby-services` | Nearby services |
| GET | `/medical-info` | Medical info |
| GET | `/responder/dashboard` | Responder dashboard |
| GET | `/responder/analytics` | Responder analytics |
| POST | `/responder/respond/:alertId` | Respond to alert |
| POST | `/responder/resolve/:alertId` | Resolve alert |

### Devices (`/api/v1/devices`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/my-devices` | My devices |
| GET | `/stats` | Device stats |
| GET | `/device/:deviceId` | Device detail |
| POST | `/register` | Register device |
| POST | `/legacy-register` | Legacy register |
| POST | `/heartbeat` | Device heartbeat |
| POST | `/update-token` | Update FCM token |
| POST | `/unregister` | Unregister device |
| POST | `/cleanup-inactive` | Cleanup inactive |

### Search (`/api/v1/search`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Global search |

### Upload (`/api/v1/upload`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Upload file |
| POST | `/batch` | Batch upload |
| GET | `/` | List files |
| GET | `/:fileId/metadata` | File metadata |
| GET | `/:fileId/download-url` | Download URL |
| GET | `/stats` | Upload stats |
| DELETE | `/:fileId` | Delete file |
| GET | `/admin/quarantined` | Quarantined files |
| GET | `/admin/hipaa-audit` | HIPAA audit |
| POST | `/admin/rescan/:fileId` | Rescan file |

### GDPR Data Export (`/api/v1/data-export`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/my-data` | Export my data |
| DELETE | `/my-data` | Request data deletion |

### Analytics (`/api/v1/admin/analytics`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard` | Analytics dashboard |
| GET | `/trends` | Trends |
| GET | `/departments` | Department analytics |
| GET | `/pharmacy` | Pharmacy analytics |
| GET | `/satisfaction` | Satisfaction analytics |
| GET | `/usage` | Usage analytics |
| GET | `/registrations` | User registrations |
| GET | `/counts` | Entity counts |
| GET | `/active-users` | Active users |
| GET | `/active-departments` | Active departments |

### Beds & Wards

#### Beds (`/api/v1/beds`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List beds |
| GET | `/summary` | Bed summary |
| GET | `/ward/:wardId` | Beds by ward |
| POST | `/` | Create bed |
| PUT | `/:id` | Update bed |
| DELETE | `/:id` | Delete bed |
| POST | `/:id/admit` | Admit patient |
| POST | `/:id/discharge` | Discharge patient |

#### Wards (`/api/v1/wards`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List wards |
| POST | `/` | Create ward |

### Admin Dashboard (`/api/v1/admin`)
*ADMIN/SUPER_ADMIN only*

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard` | Admin dashboard |
| GET | `/stats/quick` | Quick stats |
| GET | `/stats/users` | User stats |
| GET | `/stats/appointments` | Appointment stats |
| GET | `/stats/staff` | Staff stats |
| GET | `/stats/departments` | Department stats |
| GET | `/activity/recent` | Recent activity |
| GET | `/alerts` | System alerts |

#### Admin Audit (`/api/v1/admin/audit`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/logs` | Audit logs |
| GET | `/summary` | Audit summary |
| GET | `/modules` | Audit modules |
| GET | `/user/:userId` | User audit history |

### System (`/api/v1/system`)
*ADMIN/SUPER_ADMIN only*

| Method | Path | Description |
|--------|------|-------------|
| GET | `/settings` | Get system settings |
| PUT | `/settings` | Update system settings |
| GET | `/status` | System status |
| GET | `/health` | System health |

### Logs (`/api/v1/admin/logs`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/audit` | Audit logs |
| GET | `/system` | System logs |
| GET | `/audit/export` | Export audit logs |
| GET | `/system/export` | Export system logs |

### Infrastructure (`/api/v1`)

#### Debug
| Method | Path | Description |
|--------|------|-------------|
| GET | `/ping` | Ping |
| GET | `/debug` | Debug info |
| GET | `/info` | System info |
| GET | `/system` | System debug info |
| GET | `/db-test` | Database test |

#### RBAC
| Method | Path | Description |
|--------|------|-------------|
| GET | `/public/roles` | Public roles list |
| GET | `/roles` | All roles |
| GET | `/users` | Users by role |
| GET | `/permissions` | Permissions |
| GET | `/analytics` | RBAC analytics |

#### Version
| Method | Path | Description |
|--------|------|-------------|
| GET | `/version` | API version |
| GET | `/version/capabilities` | Capabilities |
| GET | `/version/health` | Version health |
| GET | `/version/system` | System info |
| GET | `/version/api-catalog` | API catalog |

### Lookup (`/api/v1/users/lookup`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Lookup |
| GET | `/advanced` | Advanced lookup |
| GET | `/stats` | Stats (admin only) |
| GET | `/verify` | Verify |
| GET | `/activity` | Activity (admin only) |
| POST | `/bulk-search` | Bulk search (admin only) |

---

## 5. Cron Jobs

| Schedule | Job | Description |
|----------|-----|-------------|
| `0 0 * * *` | Purge Old Logs | Delete old application logs daily at midnight |
| `0 0 * * *` | Swagger Validation | Validate Swagger documentation daily at midnight |
| `0 2 * * *` | Database Backup | Full PostgreSQL backup with verification at 2 AM |
| `0 3 * * *` | R2 Cleanup | Clean R2 files older than 730 days (2 years) |
| `0 3 * * 0` | Purge Archives | Purge .gz archived logs weekly on Sundays at 3 AM |
| `30 3 * * *` | Audit Log Cleanup | Delete audit_log entries older than 90 days |
| `45 3 * * *` | Housekeeping Photo Purge | Purge expired housekeeping photos from R2 |
| `0 4 * * 0` | Cleanup Backups | Clean old database backups weekly on Sundays at 4 AM |
| `0 6 1 * *` | Monthly Payroll | Auto-generate payroll for previous month on 1st at 6 AM |
| `0 8 * * *` | Appointment Reminders | Send daily appointment reminders at 8 AM |
| `0 * * * *` | Timed Reminders | Send 24h and 1h SMS+push appointment reminders hourly |
| `*/5 * * * *` | Scheduled Notifications | Process pending scheduled notifications (feedback requests) |
| `*/5 * * * *` | Notification Retry | Retry failed push/SMS with exponential backoff |
| `*/30 * * * *` | Stuck Order Escalation | Detect and escalate stuck orders (appts >48h, pharmacy past SLA, investigations >4h) |
| `0 9 * * *` | Investigation Notifications | Send investigation report notifications at 9 AM |
| `0 8 1 12 *` | Annual Review Reminder | Annual salary review reminder on Dec 1 at 8 AM |
| Monthly 1st | Archive Migration | Migrate old appointments to archive table |

---

## 6. Patient App (Flutter)

### Features (17 modules)
| Feature | Screens | Description |
|---------|---------|-------------|
| **about** | `about_us_screen` | About the hospital |
| **appointments** | `appointments_screen` | View/book appointments |
| **auth** | `login_screen`, `terms_disclaimer_screen` | Phone auth + terms |
| **bootstrap** | — | App initialization |
| **calendar** | `calendar_screen` | Calendar view of appointments |
| **dashboard** | `dashboard_screen` | Home screen with feature dial |
| **departments** | `departments_screen` | Browse departments & doctors |
| **feedback** | `ask_a_doubt_screen`, `feedback_history_screen` | Submit feedback, view history |
| **investigations** | `investigations_screen`, `book_investigation_screen`, `my_bookings_screen` | View results, book home collection |
| **notifications** | `notifications_screen` | Push notification inbox |
| **pharmacy** | `pharmacy_screen` | Order medicines, track orders |
| **profile** | `profile_edit_screen`, `profile_setup_screen` | Edit profile, initial setup |
| **records** | `records_screen` | View medical records |
| **settings** | `settings_screen` | App settings, theme, language |
| **splash** | `splash_screen` | Splash/loading screen |
| **trivia** | `trivia_screen` | Health trivia/tips |
| **your_health** | `your_health_screen` | Health vitals dashboard |

### Services (7)
- `backend_api_service.dart` — Main API client
- `device_service.dart` — Device registration
- `feedback_api_service.dart` — Feedback API
- `firebase_session_service.dart` — Firebase auth session
- `shared_prefs_service.dart` — Local storage
- `sos_api_service.dart` — SOS API client
- `sos_service.dart` — SOS logic

### Widgets (15)
`appointment_widget`, `circular_feature_dial`, `contact_banner`, `delivery_tracking_card`, `error_boundary`, `feature_screen_scaffold`, `feedback_prompt`, `heartbeat_logo`, `language_dropdown`, `logo_background`, `logout_button`, `main_scaffold_go_router`, `phone_input_field`, `terms_agreement_notice`, `theme_card`

### Languages (5)
| Code | Language |
|------|----------|
| `en` | English |
| `hi` | Hindi |
| `ml` | Malayalam |
| `ta` | Tamil |
| `te` | Telugu |

### Key Dependencies
- **Navigation:** `go_router`
- **State Management:** `provider`
- **Networking:** `http`, `dio`
- **Auth:** Firebase (via `vhhealth_core`)
- **Storage:** `shared_preferences`, `flutter_secure_storage`
- **Location:** `geolocator`
- **Biometrics:** `local_auth`
- **Calendar:** `table_calendar`, `add_2_calendar`
- **Media:** `image_picker`, `file_picker`, `cached_network_image`
- **UI:** `lucide_icons`, `badges`, `markdown_widget`, `pin_code_fields`

---

## 7. Staff App (Flutter)

### Features (20 modules)
| Feature | Screens | Description |
|---------|---------|-------------|
| **about** | `about_screen` | About info |
| **appointments** | `appointments_screen`, `appointment_queue_screen` | View/manage appointment queue |
| **attendance** | `attendance_screen`, `dispute_screen`, `overtime_screen` | Mark attendance, disputes, overtime |
| **auth** | `login_screen` | Staff login (employee ID + PIN) |
| **dashboard** | `dashboard_screen` | Staff home dashboard |
| **directory** | `staff_directory_screen` | Staff directory |
| **doctor** | `patient_records_screen`, `prescriptions_screen`, `queue_screen` | Doctor workspace: records, prescriptions, queue |
| **housekeeping** | `housekeeping_hub_screen`, `log_cleaning_screen`, `my_housekeeping_screen`, `raise_request_screen`, `tasks_screen` | Full housekeeping workflow |
| **hr** | `hr_dashboard_screen`, `performance_screen`, `staff_management_screen` | HR management |
| **investigations** | `investigations_screen`, `lab_bookings_screen` | Lab investigation management |
| **leave** | `leave_screen` | Leave application |
| **notifications** | `notifications_screen` | Notification inbox |
| **nursing** | `handover_screen`, `nursing_notes_screen`, `vitals_screen` | Nursing: vitals, notes, handover |
| **payroll** | `payslip_screen`, `payslip_detail_screen`, `payslip_query_screen`, `tax_summary_screen`, `investment_declaration_screen` | Payroll self-service |
| **pharmacy** | `pharmacy_screen` | Pharmacy order management |
| **profile** | `profile_screen` | Staff profile |
| **reports** | `reports_hub_screen`, `my_reports_screen`, `incident_report_screen`, `grievance_screen` | Incident/grievance reporting |
| **schedule** | `schedule_screen` | Shift schedule |
| **settings** | `settings_screen` | App settings |
| **splash** | `splash_screen` | Splash screen |

### API Methods (80+)
The `StaffApiService` provides methods for:

**Profile:** `getProfile`, `updateProfile`

**Attendance:** `markAttendance`, `markAttendanceWithLocation`, `getAttendanceCalendar`, `requestRegularization`, `getAttendance`, `getAttendanceStatus`, `getTodayAttendance`, `getAttendanceHistory`

**Leave & HR:** `getHRDashboard`, `getLeaveBalance`, `applyLeave`, `applyForLeaveWithReplacement`, `getMyLeaves`, `getReplacementRequests`, `respondToReplacement`, `getStaffList`, `getPerformanceReport`, `getOnboardingChecklist`, `getDepartmentSummary`, `getAttendanceAnalytics`, `exportStaffReport`, `createPerformanceReview`

**Medical:** `uploadConsultation`, `uploadInvestigation`, `recordVitals`, `getPatientVitalTrends`, `getDoctorRecords`, `getMedicalRecords`, `getPatientRecords`, `getHealthRecordsByPhone`

**Pharmacy:** `updatePharmacyOrder`, `getPharmacyOrderQueue`, `confirmPharmacyOrder`, `markPharmacyPreparing`, `dispatchPharmacyOrder`, `markPharmacyDelivered`, `cancelPharmacyOrder`

**Appointments:** `getAppointments`, `updateAppointmentStatus`, `getTodayAppointmentQueue`, `getPendingAppointments`, `confirmAppointment`, `markNoShow`, `completeAppointmentStaff`, `cancelAppointmentStaff`, `uploadAppointmentDocument`, `registerWalkIn`

**Auth:** `setupPin`, `toggleBiometric`, `quickLogin`, `registerTrustedDevice`, `verifyDevice`, `getAuthProfile`, `getRegisteredDevices`, `removeRegisteredDevice`

**Notifications:** `getNotifications`, `markAllNotificationsRead`

**E-Prescriptions:** `createEPrescription`, `getEPrescription`, `getEPrescriptionsList`, `createPrescription`

**Overtime & Incidents:** `requestOvertime`, `getMyOvertimeRequests`, `submitIncidentReport`, `getMyIncidents`, `getIncidentDetail`

**Grievances:** `submitGrievance`, `getMyGrievances`, `getGrievanceDetail`

**Housekeeping:** `getHousekeepingZones`, `submitCleaningLog`, `getMyCleaningLogs`, `raiseHousekeepingRequest`, `getMyHousekeepingRequests`, `completeHousekeepingRequest`

**Payroll:** `getMyPayslips`, `getPayslipDetail`, `getMyTaxSummary`, `getMyAdvances`, `submitInvestmentDeclaration`, `getMyDeclarations`, `raisePayslipQuery`, `getMyPayslipQueries`

**Investigations:** `getPendingInvestigations`, `getInvestigationBookingQueue`, `getInvestigationBookingDetail`, `getInvestigationBookingSLA`, `confirmInvestigationBooking`, `dispatchCollector`, `markSamplesCollected`, `startBookingProcessing`, `uploadBookingResult`

**Delivery:** `updateDeliveryLocation`, `stopDeliveryTracking`

---

## 8. Admin Portal (Next.js)

### Pages (44)

| Path | Description | Roles |
|------|-------------|-------|
| `/` | Root redirect | Public |
| `/login` | Admin login | Public |
| `/dashboard` | Main dashboard | All authenticated |
| `/dashboard/my-appointments` | Personal appointments | All staff |
| `/dashboard/my-attendance` | Personal attendance | All staff |
| `/dashboard/my-leave` | Personal leave | All staff |
| `/dashboard/my-payslips` | Personal payslips | All staff |
| `/dashboard/my-replacements` | Personal replacements | All staff |
| `/dashboard/upload-prescription` | Upload prescription | DOCTOR |
| `/dashboard/appointments` | Appointment management | Operations |
| `/dashboard/housekeeping` | Housekeeping management | Operations |
| `/dashboard/sos` | Emergency/SOS management | Operations |
| `/dashboard/leave-approvals` | Leave approval workflow | HR |
| `/dashboard/grievances` | Grievance management | HR |
| `/dashboard/incidents` | Incident management | HR |
| `/dashboard/attendance-audit` | Attendance audit | HR |
| `/dashboard/reporting` | Report audit | HR |
| `/dashboard/investigations` | Investigation management | HR/Admin |
| `/dashboard/staff-roster` | Staff roster | HR |
| `/dashboard/users` | User management | Admin |
| `/dashboard/doctors` | Doctor management | Admin |
| `/dashboard/doctors/create` | Create doctor | Admin |
| `/dashboard/doctors/edit/[id]` | Edit doctor | Admin |
| `/dashboard/departments` | Department management | Admin |
| `/dashboard/payroll` | Payroll management | Admin |
| `/dashboard/payroll/comparison` | Payroll comparison | Admin |
| `/dashboard/analytics` | Analytics dashboard | Admin |
| `/dashboard/pharmacy` | Pharmacy management | Admin |
| `/dashboard/notifications` | Notification management | Admin |
| `/dashboard/attendance` | Attendance management | Admin |
| `/dashboard/attendance/bulk-correct` | Bulk attendance correction | Admin |
| `/dashboard/attendance/disputes` | Attendance disputes | Admin |
| `/dashboard/attendance/overtime` | Overtime management | Admin |
| `/dashboard/uploads` | File uploads management | Admin |
| `/dashboard/settings` | System settings | Admin |
| `/dashboard/system-audit` | System audit | Admin |
| `/dashboard/audit` | Audit logs | Admin |
| `/dashboard/system-logs` | System logs | Admin |
| `/dashboard/logs` | Log viewer | Admin |
| `/dashboard/beds` | Bed management | Admin |
| `/dashboard/admin-management` | Admin account management | SUPER_ADMIN |
| `/dashboard/admin-management/edit-permissions/[id]` | Edit admin permissions | SUPER_ADMIN |
| `/dashboard/legacy` | Legacy admin panel | Admin |

### Navigation Structure
1. **Overview** — Dashboard
2. **My Work** — My Appointments, My Attendance, My Leave, My Payslips, My Replacements, Upload Prescription
3. **Operations** — Appointments, Housekeeping, Emergency/SOS
4. **HR Management** — Leave Approvals, Grievances, Incidents, Attendance Audit, Report Audit, Investigations, Staff
5. **Administration** — Users, Doctors, Departments, Payroll, Analytics, Medical Records, Pharmacy, Notifications, Attendance, Uploads, Feedback, System Settings, System Audit, Audit Logs

### API Client Files (21)
`admin.ts`, `analytics.ts`, `appointments.ts`, `attendance.ts`, `auth.ts`, `core.ts`, `dashboard.ts`, `departments.ts`, `doctors.ts`, `housekeeping.ts`, `index.ts`, `infrastructure.ts`, `investigations.ts`, `notifications.ts`, `payroll.ts`, `reports.ts`, `settings.ts`, `sos.ts`, `staff.ts`, `uploads.ts`, `users.ts`

### Hooks (19)
`api-hooks`, `hooks`, `useAdminStats`, `useAdminWebSocket`, `useApi`, `useAttendance`, `useAuth`, `use-dashboard`, `useDebounce`, `usePerformanceMonitor`, `usePermissions`, `useSelection`, `useSessionTimeout`, `useSOS`, `useSystemMonitoring`, `useTheme`, `useUploads`, `useWebSocket`

### Contexts
- `AuthContext` — Authentication state
- `UserContext` — User data state

### Components (27)
UI components including `DataTable`, `MetricCard`, `ChartCard`, `CommandPalette`, `KeyboardShortcutsModal`, `SystemAlerts`, `ThemeToggle`, `BulkActions`, `PaginationControls`, `Breadcrumbs`, `ActivityFeed`, auth components (`ProtectedRoute`, `RequirePermissions`, `AuthDebugger`), and shadcn-style UI primitives.

---

## 9. Notification Matrix

### Push + In-App Notifications
| Event | Channels | Timing |
|-------|----------|--------|
| Appointment booked | Push + In-app | Immediate |
| Appointment confirmed | Push + In-app | Immediate |
| Appointment reminder (daily) | Push | Daily 8 AM |
| Appointment reminder (24h) | Push + SMS | 24 hours before |
| Appointment reminder (1h) | Push + SMS | 1 hour before |
| Appointment cancelled | Push + In-app | Immediate |
| Appointment no-show | Push + In-app | Immediate |
| Investigation report ready | Push + In-app | Daily 9 AM |
| Pharmacy order status change | Push + In-app | Immediate |
| Feedback request (post-appointment) | Push + In-app | Scheduled (5-min check) |
| Stuck order escalation | Push (admins) | Every 30 min check |
| Failed notification retry | Push/SMS | Every 5 min (exponential backoff) |
| Annual salary review reminder | In-app | Dec 1 annually |

### Notification Channels
- **Push:** Firebase Cloud Messaging (FCM)
- **SMS:** Dry-run logging only (no external provider configured)
- **Email:** Configured email service
- **In-app:** Database-stored notifications

---

## 10. SLA Targets

### Appointment SLA
- Confirmation within 48 hours (auto-escalated if missed)
- SLA dashboard at `/appointments/admin/sla-dashboard`

### Pharmacy Order SLA
- Confirmation target tracked per order (`sla_confirm_target`)
- Stuck orders escalated if PLACED past SLA target
- SLA dashboard at `/pharmacy-orders/orders/sla`

### Investigation Booking SLA
- Dispatched samples should be collected within 4 hours
- Stuck at DISPATCHED >4h triggers escalation
- SLA dashboard at `/investigations/bookings/sla`

### Staff Attendance SLA
- SLA report at `/staff/admin/audit/sla`
- Attendance audit dashboard at `/staff/admin/audit/attendance/dashboard`

### General Audit SLA
- SLA report at `/staff/admin/audit/sla`

---

## 11. File Storage (Cloudflare R2)

### Configuration
- **Provider:** Cloudflare R2 (S3-compatible)
- **Bucket:** Configured via `CF_R2_BUCKET`
- **Endpoint:** `https://{CF_ACCOUNT_ID}.r2.cloudflarestorage.com`
- **Public URL:** Configured via `CF_R2_URL`

### Retention Policies
| Category | Retention |
|----------|-----------|
| General files | 730 days (2 years) — then auto-deleted |
| Verified housekeeping log photos | 90 days |
| Unverified housekeeping log photos | 180 days (grace for disputes) |
| Completed housekeeping request photos | 90 days |
| Stale open request photos | 30 days |
| Audit logs (DB) | 90 days |

### Virus Scanning
- **ClamAV integration** via `clamavScanHelper.js`
- External ClamAV API (`CLAMAV_API_URL` + `CLAMAV_API_KEY`)
- Quarantined files viewable at `/upload/admin/quarantined`
- Rescan capability at `/upload/admin/rescan/:fileId`

### File Types Handled
- Appointment documents
- Investigation result files (lab reports)
- Prescription photos (handwritten)
- Pharmacy order prescriptions
- Housekeeping log/request photos
- Medical consultation uploads
- Operational photos
- Batch uploads

---

## 12. Security

### Authentication
- **Patient:** Firebase Authentication (phone + OTP)
- **Admin:** Username/password + OTP (bcrypt hashing)
- **Staff:** Employee ID + PIN + trusted device verification + optional biometric
- **JWT:** Issued on login, configurable expiry via `JWT_EXPIRES_IN`
- **API Key:** Required for all non-public routes (`X-API-Key` header)

### Rate Limiting
- **Patient routes:** Configurable via `PATIENT_RATE_LIMIT_*` env vars
- **Admin routes:** Separate admin rate limiter
- **Generic routes:** Configurable via `GENERIC_RATE_LIMIT_*` env vars

### RBAC (Role-Based Access Control)
- Centralized role definitions in `src/utils/roles.js`
- `SUPER_ADMIN` has global bypass
- Route-level RBAC via `rbacMiddleware` and `wrapAutoRBAC`
- Admin portal permission system with `RequirePermissions` component
- Fine-grained permissions configurable per admin

### Audit & Compliance
- Universal audit log (`audit_log` table, purged at 90 days)
- User action logs (`user_action_logs`)
- File access logs (`file_access_logs`) — HIPAA compliance
- File deletion logs (`file_deletion_log`)
- Department audit log (`department_audit_log`)
- Admin activity logs (`admin_activity_logs`)
- HR activity logs (`hr_activity_logs`)
- Medical activity logs (`medical_activity_logs`)
- Auth logs (`auth_logs`)
- OTP logs (`otp_logs`)
- Role change audit (`user_role_audit`)
- User status history (`user_status_history`)

### Input Validation
- Express-validator based validators on all routes
- Schema validation in admin portal (Zod)
- File type/size validation on uploads
- Phone number normalization utilities

### Error Tracking
- Sentry integration (`SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`)
- Centralized error handler middleware

### WebSocket
- WebSocket server for real-time updates (`src/utils/websocket/wsServer.js`)
- Admin portal WebSocket hooks for live data

### Geofencing
- GPS-based attendance with geofence breach detection
- `geofence_breaches` table for breach logging
- Geo utilities in `src/utils/geoUtils.js`

---

## 13. Migrations

| # | File | Description |
|---|------|-------------|
| 002 | `investigations_notification.sql` | Investigation notification system |
| 003 | `attendance_features.sql` | Staff attendance features |
| 004 | `shift_overtime.sql` | Shift and overtime management |
| 005 | `incident_grievance.sql` | Incident and grievance system |
| 006 | `universal_audit_log.sql` | Universal audit logging |
| 007 | `housekeeping.sql` | Housekeeping zones, logs, requests |
| 008 | `payroll.sql` | Initial payroll system |
| 009 | `payroll_complete.sql` | Complete payroll (salary, payslips, advances) |
| 010 | `payroll_compliance.sql` | Payroll compliance (tax, declarations, FnF) |
| 011 | `appointment_records.sql` | Appointment record improvements |
| 012 | `appointment_improvements.sql` | Appointment workflow enhancements |
| 013 | `investigation_enhancements.sql` | Investigation feature enhancements |
| 014 | `investigation_bookings.sql` | Home collection booking system |
| 015 | `pharmacy_orders_enhanced.sql` | Enhanced pharmacy order system |
| 016 | `delivery_tracking.sql` | Real-time delivery GPS tracking |
| 017 | `seed_departments_doctors.sql` | Seed departments and doctors data |
| 018 | `e_prescription.sql` | E-prescription system |

*Note: Migration 001 is the initial schema (not in numbered migration files).*

---

## 14. Middleware Stack

| File | Purpose |
|------|---------|
| `attachUserContext.js` | Attach user context to request |
| `auditLogger.js` | Audit logging middleware |
| `auditLog.js` | Audit log middleware |
| `auth.js` | Authentication |
| `authMiddleware.js` | JWT authentication |
| `corsMiddleware.js` | CORS handling |
| `errorHandlerMiddleware.js` | Global error handler |
| `identityValidator.js` | Identity validation |
| `jwtMiddleware.js` | JWT parsing |
| `loggingMiddleware.js` | Request logging |
| `normalizeIdentityFields.js` | Normalize UID/phone fields |
| `rateLimitMiddleware.js` | Rate limiting |
| `rbacMiddleware.js` | Role-based access control |
| `roleMiddleware.js` | Role checking |
| `staff/staffPermissons.js` | Staff permission checking |
| `uploadMiddleware.js` | File upload (multer) |
| `validateApiKey.js` | API key validation |
| `validators.js` | Input validators |

---

## 15. Architecture Diagram

```
┌─────────────────┐  ┌──────────────────┐  ┌─────────────────┐
│   Patient App   │  │    Staff App     │  │  Admin Portal   │
│  (Flutter/Dart) │  │  (Flutter/Dart)  │  │   (Next.js)     │
└───────┬─────────┘  └───────┬──────────┘  └───────┬─────────┘
        │                    │                     │
        │    Firebase Auth   │  PIN + Device Auth  │  Username + Password
        │                    │                     │
        └────────────────────┼─────────────────────┘
                             │
                     ┌───────▼────────┐
                     │  Express API   │
                     │  (Port 5000)   │
                     │                │
                     │ ┌────────────┐ │
                     │ │ Middleware  │ │
                     │ │ Stack      │ │
                     │ └────────────┘ │
                     │ ┌────────────┐ │
                     │ │ Routes     │ │  ┌───────────────┐
                     │ │ (Modular)  │◄├──┤ Cloudflare R2 │
                     │ └────────────┘ │  │ (File Storage)│
                     │ ┌────────────┐ │  └───────────────┘
                     │ │ Cron       │ │
                     │ │ Scheduler  │ │  ┌───────────────┐
                     │ └────────────┘ │  │ Firebase FCM  │
                     │ ┌────────────┐ │  │ (Push Notif)  │
                     │ │ WebSocket  │◄├──┤               │
                     │ └────────────┘ │  └───────────────┘
                     └───────┬────────┘
                             │
                     ┌───────▼────────┐
                     │  PostgreSQL    │
                     │  15.13         │
                     │  (Docker)      │
                     │  99 tables     │ ┌───────────────┐
                     │  199 indexes   │ │ Sentry        │
                     │  8 triggers    │ │ (Errors)      │
                     └────────────────┘ └───────────────┘
```

---

*Generated by full codebase audit on 2026-03-26. Every route, table, screen, and cron job documented from actual code — not from plans or specs.*
