# BUILD: NL-7 P3 — CMMS on the biomed registry (work orders, schedules, calibration)

**Spec:** `docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md` §5 + §9 P3. Read it fully, plus `_worker-common.md`. Substrate: `clinical_ai_biomed_devices` + maintenance predictions (mig 053) exist; the operational loop does not. Lifecycle deliberately mirrors `housekeeping_requests` (open→assigned→in_progress→completed→verified, SLA, roster recipients, escalation).

## Start gate (P1 merged — device-fault WO source needs the registry)
```
git fetch github
git grep -q "device_registry" github/main -- apps/backend/src/migrations && git grep -q "CMMS on the Biomed Registry" github/main -- docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md
```

## Workspace
Worktree `VH-Health-Platform-nl7-p3`, branch `feat/nl7-p3-cmms`. Backend + admin + staff app (`dart pub get`; i18n all 5 arb files).

## Scope (spec §5)
1. **Tables** (2–3 migrations, tenant RLS): `biomed_work_orders` (`BWO-YYYYMMDD-xxxxxx`, device FK, kind preventive|corrective|calibration|inspection|condemnation, priority, status lifecycle + cancelled, assignment fields, `sla_due_at`/`sla_breached`, completion notes, parts_used jsonb, cost, downtime start/end → feeds usage_hours/MTBF, verified_by/at, `source` schedule|manual|device_fault|ai_prediction + source_ref) + `biomed_work_order_updates` trail · `biomed_maintenance_schedules` (interval_days OR interval_usage_hours seeded from `DEFAULT_SERVICE_INTERVALS_HOURS`, next_due_at, assigned role/vendor, active) · `biomed_calibration_certificates` (cert number, calibrated_at/due_at, performed_by, `document_id` via the validated upload/R2 path — never raw base64, result pass|fail|adjusted). AMC/vendor-contract fields: small columns on the registry or a contracts table — size at build.
2. **Materializer cron** (`withJobLock`): due schedules → work orders (idempotent per schedule+due-window); refreshes `next_scheduled_maintenance_at` on the device row so AI prediction inputs stay live.
3. **Integration**: gateway-observed faults (silent registered monitor, repeated malformed output) → **auto-create** corrective WO with open-WO dedupe (adopted default; source='device_fault') · accepted AI prediction rows offer one-click WO creation (source='ai_prediction' — reviewer stays in loop) · SLA breach on urgent WOs rides existing escalation + notificationOutbox.
4. **Surfaces**: admin biomed board (device list, WO queue, calibration currency, downtime KPIs) + staff-app "my work orders" list for biomed technicians. `BIOMED_TECHNICIAN` role addition (if absent at build time) follows the RBAC-cleanup protocol: own commit, role-config + authorization suites green.

## Tests
Materializer idempotency (no duplicate WOs per due-window); WO lifecycle walk with verification step; device-fault dedupe (second fault while WO open → no new WO); calibration cert upload via validated path; downtime math; SLA escalation wiring; tenant isolation.

## Deliverable
PR `NL-7 P3: CMMS (work orders, schedules, calibration certificates)` with build ledger. Migrations: **2–3**. Stop after the PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl7-p3-cmms.md` and `_worker-common.md` beside it; execute EXACTLY. Your migration block: <ASSIGN>. STOP after opening the PR; report PR number + build ledger.
