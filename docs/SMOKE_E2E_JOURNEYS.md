# Smoke E2E Journeys

This document records the executable smoke coverage that protects the P3
product workflows. The scripts are intentionally thin contract checks: they
prove routing, auth, proxy wiring, and representative happy paths without
becoming a full regression suite.

## Prerequisites

- Local backend is running.
- Local Postgres smoke database is reachable. By default the scripts target
  the same disposable database created by
  `apps/backend/scripts/ensure-test-db.mjs`:
  `127.0.0.1:55432/vhhealth_test` as user `postgres`.
- Admin smoke requires the admin portal proxy to be running.
- The scripts use disposable records and the local test API key/JWT secret
  passed as parameters or defaults.

## CI Coverage

The repeatable full-stack smoke gate lives at:

```text
.github/workflows/smoke-e2e.yml
```

It runs on `workflow_dispatch` and on PRs that touch backend, admin, or smoke
scripts. The job boots Postgres, migrates and seeds the backend database, starts
the backend and admin portal, then runs:

- admin authenticated browser route crawl
- patient API routing smoke
- staff API routing smoke
- staff clinical-safety API smoke
- Clinical AI pilot evidence-pack smoke
- Clinical AI local Ollama deep-tier smoke
- Clinical AI tenant rollout preflight

The workflow uploads `output/ci-smoke` as an artifact. Besides backend/admin
logs, that directory contains the redacted Clinical AI pilot evidence pack,
the approved signoff gate snapshot, and the tenant preflight JSON used for
rollout approval records.

This is intentionally a local fixture smoke. It does not need production
credentials and should fail fast when endpoint drift, missing tables, proxy
allowlist drift, missing rollout evidence, or visible admin route errors return.

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
  and was migrated to the `flutter_local_notifications` named-argument API. The
  plugin's current constraint lives in `apps/patient/pubspec.yaml`; this
  document does not track it.
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

## Staff Role Matrix

Command:

```powershell
$env:VH_BASE_URL='https://<host>/api/v1'
$env:VH_API_KEY='<staff smoke API key>'
$env:VH_STAFF_TEST_PASSWORD='<seeded staff password>'
.\scripts\smoke-staff-role-workflows.ps1 -IncludeCreates
```

Covered journeys:

- Real staff login for Nursing, Pharmacy, Lab, Doctor, HR, Admin, Super Admin,
  and General Staff seeded accounts.
- Shared app surfaces: profile, attendance, campus config, notifications, and
  messaging.
- Role-specific daily surfaces: appointment queue/list, patient search, bed
  board, pharmacy queue/catalog/SLA, investigation queue/catalog/SLA, HR
  dashboard/leave/payroll, staff list, and admin DB viewer access checks.
- Representative create-path checks for walk-in appointment, patient lookup,
  investigation booking, and prescription creation when `-IncludeCreates` is
  supplied.

The generated report is `docs/STAFF_ROLE_WORKFLOW_SWEEP.md`. Run with
`-FailOnFailure:$false` during exploratory pilots if you want a complete report
even when one role is broken; keep the default failure behavior for release
gates.

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

## Clinical AI Pilot Evidence

Command:

```powershell
.\scripts\smoke-clinical-ai-pilot-evidence.ps1 `
  -EvidenceOutputPath output/ci-smoke/clinical-ai-pilot-evidence-pack.json `
  -SignoffOutputPath output/ci-smoke/clinical-ai-pilot-signoff-gate.json
```

Covered journey:

- Seeds the first pilot pair: `medication_reconciliation` and
  `patient_aftercare_instructions`.
- Proves tenant isolation by exporting only the seeded tenant evidence window.
- Requires human final reviews with reviewer notes for both modules.
- Requires an accepted eval gate for the risky medication reconciliation module.
- Verifies visible generation labels include both `ai` and `template_fallback`.
- Verifies the pack has no blockers, no schema-unavailable sections, an audit
  trail, and no leaked draft bodies or full reviewer notes.
- Creates a pilot signoff from the same evidence window, verifies rollout is
  blocked while the signoff is pending, approves it, then verifies the
  stage-expansion gate opens for the exact stage + module set.
- Optionally writes the redacted evidence pack and signoff gate snapshot as
  JSON artifacts for rollout tickets.

## Clinical AI Local Ollama Deep Tier

Command:

```powershell
.\scripts\smoke-clinical-ai-local-ollama.ps1
```

Covered journey:

- Starts a mock local Ollama endpoint for deterministic CI-safe inference.
- Seeds a disposable `medication_reconciliation` admission as a deep-tier,
  tenant-scoped module.
- Calls the real EMR admission workflow route.
- Verifies both the API response and `clinical_ai_generations` row are labelled
  `provider=ollama`, `tier=deep`, `generation_mode=ai`, and
  `provider_status=used`.
- Verifies output-defense metadata is visible on the persisted generation:
  `output_defenses_ran=true` and `defenses_passed=true`.

## Clinical AI Tenant Rollout Preflight

Command:

```powershell
.\scripts\check-clinical-ai-tenant-preflight.ps1 `
  -OutputPath output/ci-smoke/clinical-ai-tenant-preflight.json `
  -RequirePilotSignoff `
  -RequireNoWarnings `
  -ReviewerQueueWalkthroughConfirmed `
  -PhiLoggingReviewed `
  -SafetyReviewCadenceConfirmed `
  -NoAutomaticPatientDispatchConfirmed
```

Covered journey:

- Checks the tenant, required Clinical AI governance tables, module catalogue,
  guardrails, reviewer staffing, tenant region/locale, audit trail,
  output-defense visibility, retention/numbering rows, pilot signoff, backend
  health when requested, and PHI logger wiring.
- Reports manual hospital attestations separately so rollout cannot be treated
  as ready unless clinical workflow, PHI logging, safety cadence, and patient
  dispatch policy have been explicitly confirmed.
- `-Json` prints, and `-OutputPath` writes, the archiveable evidence object
  for hospital rollout tickets.
- `-RequireNoWarnings` turns tenant config warnings into a hard rollout gate;
  CI seeds locale, numbering, and retention rows so the pilot fixture proves a
  warning-clean approval packet.

Browser-level local journeys live in `apps/admin/e2e/authenticated.spec.ts` and
cover login/session reuse, dashboard, users, appointments, uploads,
upload-prescription, Clinical AI, payroll, and system logs.

The broader route crawler is:

```bash
cd apps/admin
npm run smoke:routes
```

It discovers every static page under `src/app/(with-auth)/dashboard`, skips
dynamic routes such as `[id]`, and fails on visible error text, uncaught page
errors, console errors, or failed `/api/proxy` responses.

## Staff Desktop

Command:

```powershell
$env:VH_BASE_URL='https://<host>/api/v1'
$env:VH_API_KEY='<staff/patient smoke API key>'
.\scripts\smoke-staff-desktop.ps1
```

Covered journey:

- Launches the Flutter staff Windows app through `flutter test -d windows`.
- Logs in as seeded staff user `1007` / `test1234`.
- Opens the day-to-day dashboard, bottom navigation, and the common dashboard
  actions from the front screen and `More tools`.
- Fails on Flutter exceptions, route-not-found text, HTTP 404/500 text, and
  common client request failure strings.

This remains a Windows/local smoke because GitHub-hosted Windows runners do not
provide the same disposable Postgres service container setup used by the Linux
full-stack smoke workflow.

Current caveat: the backend/API staff role matrix is the reliable release gate.
The Windows Flutter route crawler is now phase-aware (bottom nav, always-
visible quick actions, OP/IP service tabs, More tools) and re-selects the
correct OP/IP service tab before every tile tap, so the previously-hanging
Lab Bookings (IP) probe finds its label cleanly. Each tile probe is wrapped
in a 45-second deadline so a hung screen reports the offending label clearly
instead of consuming the 8-minute suite budget. See
`docs/STAFF_ROLE_WORKFLOW_SWEEP.md` for the root-cause writeup. The desktop
smoke remains a diagnostic until the harness is re-run end-to-end against a
fresh Dalekdefender deploy.
