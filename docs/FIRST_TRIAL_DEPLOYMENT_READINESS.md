# First Trial Deployment Readiness

## Scope

- Environment: Dalekdefender first-trial stack.
- Surfaces: Backend, Admin Portal, and Staff Windows app.
- Observability for this round: Sentry, backend health/version checks, existing
  `/metrics`, CI, and manual smoke evidence.
- Deferred: Prometheus, Grafana, Loki, Tempo, and Alloy.
- Data posture: use test or sanitized pilot data unless the hospital explicitly
  approves real-patient dry-run handling.

## Required Evidence

- Forgejo CI green on `main`.
- Backend health checks: `GET https://api.vhhealth.app/api/v1/health/live`
  and `GET https://api.vhhealth.app/api/v1/health/version`.
- Admin portal load check: `GET https://admin.vhhealth.app/login`.
- Staff app rebuilt into `D:\Dev\Tools\VH Health Staff`.
- Staff role workflow sweep:
  `scripts/smoke-staff-role-workflows.ps1` with report saved under
  `output/trial-readiness/staff-role-workflow-sweep.md`.
- Manual pilot checklist:
  `docs/PILOT_STAFF_WORKFLOW_SCENARIOS.md`.

## Known Non-Blocking Issues

- Local DB-backed backend tests require PostgreSQL at `127.0.0.1:55432`; when it
  is unavailable, use Forgejo CI and live Dalekdefender smoke evidence for
  end-to-end proof.
- Full observability stack setup is intentionally deferred until the OP/IP/Admin
  trial workflows are clear of blocking bugs.
- Receptionist can handle routine front-office admission and bed-selection
  workflows, but ICU bed assignment remains escalated to Doctor, ICU nurse, or
  Admin/SuperAdmin.

## Trial Gate

The first internal trial can proceed only when there are no P0/P1 blockers in
the live staff role sweep, Admin login works, Staff login works, and the manual
pilot script can be started with sanitized data.
