# First Trial Deployment Readiness

Status: **sanitized non-production engineering trial only.** This profile does
not establish production-pilot or real-PHI readiness, and it does not authorize
a deployment. The production gate remains
[`GO_LIVE_ACTIVATION_CHECKLIST.md`](GO_LIVE_ACTIVATION_CHECKLIST.md); current
holds are recorded in
[`GO_LIVE_READINESS_GAP_MATRIX.md`](GO_LIVE_READINESS_GAP_MATRIX.md).

## Scope

- Environment: Dalekdefender first-trial stack.
- Surfaces: Backend, Admin Portal, and Staff Windows app.
- Observability for this round: Sentry, backend health/version checks, existing
  `/metrics`, CI, and manual smoke evidence.
- Deferred for this isolated Dalekdefender engineering trial only: Prometheus,
  Grafana, Loki, Tempo, and Alloy. This deferral cannot close production G1.
- Data posture: use test or sanitized pilot data unless the hospital explicitly
  approves real-patient dry-run handling.

## Required Evidence

- Successful GitHub `Merge Gate` and `Full Merge Gate` on the exact proposed
  trial commit after its final `[full-ci]` marker. Forgejo delivery and mirroring
  are permanently retired.
- Backend health checks: `GET https://api.vhhealth.app/api/v1/health/live`
  and `GET https://api.vhhealth.app/api/v1/health/version`.
- Admin portal load check: `GET https://admin.vhhealth.app/login`.
- Staff app rebuilt into `D:\Dev\Tools\VH Health Staff`.
- Staff role workflow sweep:
  `scripts/smoke-staff-role-workflows.ps1` with report saved under
  `output/trial-readiness/staff-role-workflow-sweep.md`.
- Hosted `trial-readiness-smoke.yml` and `post-deploy-smoke.yml` run only by
  manual GitHub dispatch with approved target inputs. Record authority for test
  identities, create probes and Sentry submissions before enabling those effects.
- Manual pilot checklist:
  `docs/PILOT_STAFF_WORKFLOW_SCENARIOS.md`.

## Known Non-Blocking Issues

- Isolated GitHub CI database tests and owner-authorized Dalekdefender smoke
  evidence answer different questions. Hosted probes do not replace the full
  GitHub gate, and passing CI does not prove the deployed revision is healthy.
- Full observability stack setup is intentionally deferred until the OP/IP/Admin
  trial workflows are clear of blocking bugs.
- Receptionist can handle routine front-office admission and bed-selection
  workflows, but ICU bed assignment remains escalated to Doctor, ICU nurse, or
  Admin/SuperAdmin.

## Trial Gate

OWNER-INPUT — named engineering-trial owner: ______; approved sanitized-data
boundary: ______; environment and exact SHA: ______.

INF-006 / PR #872 external credential and automation containment remains held;
repository retirement does not close it or authorize deployment. See
[`RELEASE_READINESS.md`](RELEASE_READINESS.md) for the outstanding receipts.

The non-production engineering trial can proceed only when there are no P0/P1
blockers in the live staff role sweep, Admin login works, Staff login works, and
the manual pilot script can be started with sanitized data. A successful trial
must not be reported as production-ready, G1-complete, or approved for real PHI.
