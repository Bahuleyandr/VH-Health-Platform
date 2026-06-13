# VH Health Platform - Session Handoff

Last updated: 2026-06-13.

This file is the durable bootstrap note for continuing the current VH Health
Platform work from another PC or a fresh Codex run. Treat the current worktree
and Forgejo state as authoritative; this note is only a map.

## Active Goal

**S-Tier Roadmap (WS1–WS8) — target 2026-06-30.**

See `docs/S_TIER_ROADMAP.md` for the full plan, batch sequencing, and per-batch
status. The platform scored B− in the 2026-06-13 full-stack audit
(`docs/PLATFORM_AUDIT_2026-06-13.md`). The S-tier roadmap drives it to A+/S
(internal) by 2026-06-30.

WS0 criticals are complete. WS1 (security/multi-tenancy) and WS2 (reliability)
are partially complete. Next: finish WS2, execute WS3 (deterministic in-CI
journey tests — the new quality gate replacing the agent swarm), then WS4–WS8
in parallel tracks per the roadmap schedule.

**Note on the agent swarm:** The headless Claude-agent swarm (previously running
on Dalekdefender as `tmux attach -t vh-swarm`) is **retired**. It has been
replaced by deterministic in-CI journey tests (WS3). Do not re-arm the swarm.
The swarm codebase at `D:\Dev\Projects\vh-health-swarm` is preserved for
reference only. The 2026-06-16 swarm-framing goal (`docs/GOAL_2026-06-16.md`)
is superseded by the S-tier roadmap.

**Note on the Staff app multi-device goal:** The prior active goal (Staff app
multi-device strategy, last updated 2026-06-01) is absorbed into the S-tier
roadmap under WS6 (apps hardening). The specific Staff app items below remain
valid sub-tasks but are no longer the top-level goal.

## Canonical Repo And Branch

- Canonical remote: `git@forgejo.hippocampus-monitor.ts.net:bahuleyan/VH-Health-Platform.git`
- Current working branch: `main`
- GitHub may exist only as an optional mirror. Do not push to GitHub unless the
  user explicitly asks.
- Current latest known Forgejo commit at this handoff:
  `d30bb852 Harden staff shared workstation cleanup`

Recommended cold start on a new PC:

```powershell
New-Item -ItemType Directory -Force -Path 'D:\Dev\Projects\VH Health' | Out-Null
git clone git@forgejo.hippocampus-monitor.ts.net:bahuleyan/VH-Health-Platform.git 'D:\Dev\Projects\VH Health\VH-Health-Platform'
Set-Location 'D:\Dev\Projects\VH Health\VH-Health-Platform'
git fetch origin
git checkout main
git pull --ff-only origin main
git status --short --branch
```

If a repo already exists on the new PC, assume it may be stale. Run:

```powershell
Set-Location 'D:\Dev\Projects\VH Health\VH-Health-Platform'
git remote -v
git fetch origin
git checkout main
git pull --ff-only origin main
git log -5 --oneline --decorate
git status --short --branch
```

The expected remote should be Forgejo. If `origin` is GitHub, stop and correct
the remote before pushing anything.

## Deployment And Secrets

Stable backend used by the Staff app:

```text
https://dalekdefender.hippocampus-monitor.ts.net:8444/api/v1
```

Backend runs on DalekDefender k3s. Do not print, paste, or commit API keys.
Fetch the backend API key only from the k8s secret when needed:

```bash
sudo kubectl -n vhhealth get secret vhhealth-backend -o jsonpath='{.data.API_KEY}' | base64 -d
```

When testing live app behavior, first consider backend freshness. A stale
DalekDefender backend image has previously caused false app bugs.

Backend rebuild/restart recipe, no DB reset:

```bash
cd ~/VH-Health-Platform
git pull --ff-only origin main
cd apps/backend
sudo docker build -t vhhealth-backend:dev .
sudo docker save vhhealth-backend:dev | sudo k3s ctr images import -
sudo kubectl -n vhhealth rollout restart deploy/vhhealth-backend
sudo kubectl -n vhhealth rollout status deploy/vhhealth-backend --timeout=180s
```

## Local Windows Tooling Policy

Use `D:\Dev\Tools` for local tools and local Staff app installs. Do not install
project tools into `System32` or `Program Files` unless the user explicitly asks.

Current local Staff app install path:

```text
D:\Dev\Tools\VH Health Staff\vhhealth_staff.exe
```

The Staff app update script now defaults to that path. Shortcuts are opt-in with
`-CreateShortcuts` because they write into the Windows user profile.

Relevant files:

- `scripts/update-local-staff-windows-app.ps1`
- `scripts/build-staff-windows-update.ps1`
- `apps/staff/docs/WINDOWS_UPDATE_PACKAGES.md`

To rebuild and install the local Windows Staff app against DalekDefender:

```powershell
Set-Location 'D:\Dev\Projects\VH Health\VH-Health-Platform'
$env:VH_BASE_URL = 'https://dalekdefender.hippocampus-monitor.ts.net:8444/api/v1'
$env:VH_API_KEY = (ssh bahuleyan@dalekdefender.hippocampus-monitor.ts.net "sudo kubectl -n vhhealth get secret vhhealth-backend -o jsonpath='{.data.API_KEY}' | base64 -d")
.\scripts\update-local-staff-windows-app.ps1
```

Use `-SkipBuild` only when the build output is already current:

```powershell
.\scripts\update-local-staff-windows-app.ps1 -SkipBuild
```

The old local install path was removed during this run:

```text
C:\Users\subas\AppData\Local\Programs\VH Health Staff
```

## Recent Completed Work

Recent commits on `main` that are part of this goal:

```text
d30bb852 Harden staff shared workstation cleanup
96ae10be Enrich front office patient PHI context
c04ce604 Install local staff app under Dev tools
fe94455b Scope housekeeping dashboard inpatient counts
eb245d42 Harden OP AI module toggle enforcement
cb598bc8 Enrich front office appointment PHI audit context
```

What those commits established:

- OP clinical AI module toggle enforcement is hardened server-side before PHI
  context loads.
- Front-office appointment and patient create/update flows carry richer PHI and
  audit context.
- Role-aware inpatient count routing was improved for housekeeping and other
  workbench roles.
- Local Staff Windows install/update path is clean and under `D:\Dev\Tools`.
- Shared tablets/workstations now clear recent-patient local PHI before
  clearing staff credentials on logout or idle timeout.

Recent verification:

- Focused Staff app tests passed:
  `flutter test test\core\session_timeout_provider_test.dart test\core\services\recent_patients_service_test.dart`
- Staff updater rebuild completed with `flutter analyze` clean.
- Local Staff app was installed and launched from:
  `D:\Dev\Tools\VH Health Staff\vhhealth_staff.exe`
- Local repo was clean after `d30bb852`, with `HEAD`, `origin/main`, and
  `origin/HEAD` aligned.

## Multi-Device Strategy Requirements Still In Scope

The target strategy is one Flutter Staff app across phone, tablet, and Windows
desktop:

- Phone: personal staff app for attendance, shift view, shift requests, leave,
  profile, and notifications.
- Tablet/desktop: hospital workbench for OP/reception, front office, patient
  management, billing/admission flow, and role-permitted clinical entry.
- Web: reserved for Admin/HR governance workflows.

Guardrails to preserve:

- Attendance check-in/check-out is mobile-only.
- Tablet/desktop can view attendance, shifts, and rosters but cannot mark
  attendance.
- Tenant isolation remains server-side through tenant middleware/RLS.
- PHI read/write paths used by tablet/desktop must have PHI access logging.
- Create/update front-office and clinical actions must be auditable with actor,
  role, device type, patient/admission/appointment context, and request ID.
- Shared tablets/workstations use stricter idle timeout and clear local
  recent-patient caches on logout.
- Admin/HR remains the governance surface for onboarding, staff roster,
  permissions, audit review, tenant controls, and clinical AI toggles.

## Next Best Work

Suggested next slice when resuming:

1. Inspect the current OP/reception workbench implementation:
   `apps/staff/lib/features/reception/`
2. Verify front-office flows against the V1 target:
   patient search/create/update, OP booking, today's queue, visit reason/intake,
   billing/receipt handoff, IP admission handoff, and active admissions.
3. Check whether each tablet/desktop PHI read/write path has both:
   PHI access logging and audit context.
4. Add focused tests before widening the workflow.
5. Rebuild local Staff app under `D:\Dev\Tools` if Flutter code changes.
6. Deploy DalekDefender backend if backend code changes.

Useful Staff tests to run while working in this area:

```powershell
Set-Location 'D:\Dev\Projects\VH Health\VH-Health-Platform\apps\staff'
D:\Dev\Tools\flutter\bin\flutter.bat test test\features\reception\front_office_workbench_test.dart
D:\Dev\Tools\flutter\bin\flutter.bat test test\features\dashboard\dashboard_inpatient_count_test.dart test\features\emr\patient_command_board_test.dart
```

Useful backend tests from recent AI/audit work:

```powershell
Set-Location 'D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend'
node --experimental-vm-modules --max-old-space-size=2048 node_modules\jest\bin\jest.js --runInBand src\tests\unit\patientSearchController.test.js src\tests\unit\phiAccessMiddlewareTenant.test.js
node --experimental-vm-modules --max-old-space-size=2048 node_modules\jest\bin\jest.js --runInBand src\tests\unit\opdClinicalAssistService.test.js src\tests\unit\polypharmacyAiService.test.js
```

## Known Test Login Context

Previously used test logins:

- HR employee ID: `EMP-1005`
- Staff verification user created during prior live API check:
  - Employee ID: `EMP-1020`
  - Name: `Codex Test Nurse 152711`
  - Role: `NURSING_STAFF`

Do not store test passwords in the repo. Treat these IDs as test-only context
and verify live seeded data before relying on it.

## Pause Note

The work was paused after the Staff app shared-workstation cleanup hardening was
committed and pushed. The next Codex run should continue the active goal rather
than starting a new strategy discussion, unless the user asks to revise the
plan.
