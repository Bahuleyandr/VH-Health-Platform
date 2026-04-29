# Smoke E2E Journeys

This document records the executable smoke coverage that protects the P3
product workflows. The scripts are intentionally thin contract checks: they
prove routing, auth, proxy wiring, and representative happy paths without
becoming a full regression suite.

## Prerequisites

- Local backend is running.
- Local Postgres smoke database is reachable.
- Admin smoke requires the admin portal proxy to be running.
- The scripts use disposable records and the local test API key/JWT secret
  passed as parameters or defaults.

## Patient

Command:

```powershell
.\scripts\smoke-patient-routing.ps1
```

Covered journeys:

- Authenticated patient dashboard summary.
- Appointment discovery and booking.
- Appointment documents and records list.
- Notifications and device registration.
- SOS create, my-alerts, nearby-services with both `latitude/longitude` and
  `lat/lng`, and cancellation.
- Pharmacy order surface.
- Investigation catalog, booking create, and my bookings.
- Prescription list.

Backlog checks triaged in P3:

- Profile setup gate remains in splash routing for new users and missing names.
- Dashboard already supports pull-to-refresh.
- Medication reminder scheduling is available through the notification scheduler
  and was migrated to `flutter_local_notifications` 21.
- Patient empty-state polish remains a product design pass rather than a release
  blocker.

## Staff

Command:

```powershell
.\scripts\smoke-staff-routing.ps1
```

Covered journeys:

- Campus config route.
- Staff stats summary.
- Investigation booking queue and SLA dashboard.
- Dietary worklist, order create, and discontinue.
- Staff messaging send, notification outbox queue check, thread, inbox,
  unread count, and mark-read.

## Admin

Command:

```powershell
.\scripts\smoke-admin-crud.ps1
```

Covered journeys:

- Admin proxy authenticated with a smoke `SUPER_ADMIN` cookie.
- User status deactivate/reactivate.
- Staff reactivation.
- Department create/update/delete.
- Doctor create/update/availability/delete.
- System settings read/update.
- Clinical AI status, modules, review queue, and audit endpoints.

Browser-level local journeys live in `apps/admin/e2e/authenticated.spec.ts` and
cover login/session reuse, dashboard, users, appointments, uploads,
upload-prescription, Clinical AI, payroll, and system logs.
