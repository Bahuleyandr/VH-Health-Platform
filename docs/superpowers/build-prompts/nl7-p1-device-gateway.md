# BUILD: NL-7 P1 — Device gateway core: MLLP, registry, association, alarm policy
n> **STATUS: LAUNCHED 2026-07-07** (migration block assigned; see playbook §5). Kept for the record and for relaunch-on-failure.

You are implementing **NL-7 Phase 1** for the VH Health Platform. The approved design is on `github/main`: `docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md` — read it in full; your scope is **§3 (Bedside Monitor Ingestion) + §9 P1** exactly. Also read `docs/CANONICAL_CLINICAL_TIMELINE.md` and `apps/backend/CLAUDE.md`.

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-7 Device & IoT Gateway Design" github/main -- docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl7-p1"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl7-p1-device-gateway github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get   # Flutter workspace (staff-app association screen)
```
All work happens inside `$WT`. Push with `git push github feat/nl7-p1-device-gateway`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need the dev Postgres on `:5433` — start it per `apps/backend/CLAUDE.md` if down. Admin type-check is `npm run type-check` inside `apps/admin` (NOT raw `npx tsc`).

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared checkout — contamination incident history). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `openapi:generate` + `openapi:check`, commit `openapi.json`. Staff-app changes ⇒ `melos run analyze && melos run test`; ALL user-facing strings through the 5-language `intl_*.arb` sweep (i18n guard enforces).
- Migrations: after applying, `npx prisma db pull`, commit `schema.prisma` with the `.sql`.
- **Your reserved migration numbers: 371–374** (use in order, leave unused ones untaken). 368 = SAML in flight; 369–370 = NL-5 worker; 375–377 = NL-6 worker.
- Deploy stays HELD: all k8s manifests land under `infra/kubernetes/base/device-gateway/` **unreferenced by the root kustomization** (telemedicine precedent).

## Scope (deliver all — spec §9 P1)
1. **Backend — `device_registry`** (mig **371**) per spec §3.3: tenant-scoped RLS (mig-356 boilerplate), unique `[tenant_id, device_code]`, `kind` enum incl. `central_station|monitor|monitor_gateway|fridge_sensor|dialysis_machine|rtls_feed|other`, `allowed_source_ips inet[]`, `credential_hash`+`credential_prefix` — **hash = prefixed sha256 digest + `crypto.timingSafeEqual`, the `apiClientService.js` pattern (NOT bcrypt)**, one-time-plaintext issue, `biomed_device_id` nullable FK, `location_id` nullable FK, `status`, `last_seen_at`, `metadata`. Registry CRUD at `/api/v1/admin/devices` (integration-admin gate) + admin portal page. Do NOT activate `api_clients` (NL-11's spine).
2. **Backend — `device_patient_associations`** (mig **372**) per spec §3.4: `(device, channel)` key, exactly-one-active partial unique index on `ended_at IS NULL`, auto-close previous with `end_reason='device_reassigned'` in the same tx, `start_method scan|manual|adt`, full audit. ADT hooks: discharge + ward-transfer auto-end (`end_reason='discharge'|'transfer'`). NO auto-create from bed data (deliberate P1 exclusion). Unassociated traffic parks in `lab_interface_messages` (`status='failed'`, error `DEVICE_NOT_ASSOCIATED`), ACK AE, replayable — never guess a patient.
3. **Backend — `DEVICE_GATEWAY` role**: narrow service-principal role granting exactly the two ingest surfaces; **excluded from `ALL_STAFF_ROLES`/`isStaff`** (can never subscribe to staff channels, log into apps, or pass `requireStaffOrAdmin`); added alongside `CLINICAL_STAFF_ROLES` at the `app.js:930` devices mount. Verify endpoint keeps `canVerify` — a gateway can never verify vitals. Role-config + authorization suites updated (RBAC-cleanup protocol).
4. **Backend — ingest policy** (mig **373** for the alert-suppression index + policy config columns) per spec §3.5: `ingestDeviceVitals` gains optional `patient_uid` (gateway callers only; PID-3 path unchanged for direct senders), MSH-10 idempotency (dup control-id from same device within horizon → ACK AA + drop), charting-interval persist policy (default 5 min; persist on breach or NEWS2-relevant delta; suppressed samples counted via `device_samples_suppressed_total{reason}`, no inbox row). `checkVitalAnomalies` gains opt-in `options.suppressRepeats={windowMinutes}` (device path ONLY; skip alert+fan-out when an unacknowledged same `(patient_id, vital_name, severity)` alert exists in-window; ack re-arms; CRITICAL 10 min / WARNING 30 min defaults; supporting index) + N-consecutive artifact filter (default 2-of-3; uncorroborated breach still charts, doesn't page) + **notification-target fix: for `source='device'`, skip the `recorded_by` push (it's the service principal) and rely on the results-inbox DUTY-role task**. Manual/staff path byte-identical.
5. **New service `apps/device-gateway`** (Node 22, own package + container image + CI lane mirroring backend's lint+jest): MLLP framing only (`<VT>…<FS><CR>`, MSH-9/MSH-10 extraction, ~50-line frame reader — the backend keeps ALL parsing/LOINC mapping), listener table via ConfigMap `[{name, port, adapter:'mllp-hl7v2', tenant_slug, source_kind}]`, sender resolution (source IP ∈ `allowed_source_ips` for MLLP; bearer token for HTTP), **ACK AA only after durable spool append** (fsync NDJSON per source), AE on processing reject, AR when spool full (reject-new, never drop-oldest), per-source in-order drain to `POST /devices/vitals/ingest` with bounded backoff, dead-letter on 4xx, `/metrics` with the spec §7.4 gateway metric set. No DB connection in the gateway. Spool holds PHI: never log bodies (control ids + counts only).
6. **Staff app**: associate/disconnect flow on the existing BCMA scan surface (scan wristband → scan/pick device), audited. i18n across all 5 arb files.
7. **Held manifests** (spec §8) + **fixture corpus** `apps/device-gateway/fixtures/` (multi-OBX ORU^R01, BP panel components, escapes, unmapped codes, missing PID, malformed segments).
8. **Backend DB-derived gauges** added to `reliabilityMetrics.js`'s one-batched-query collector: `device_registry_active_devices`, `device_silent_devices`, `device_vitals_unverified_rows`, `device_associations_active`, `device_unassociated_messages_total`, `device_samples_suppressed_total`. PrometheusRule additions under `infra/kubernetes/base/monitoring/` (validated by `validate-monitoring.mjs`; metric names cross-checked exporter↔rules — a typo is a silently dead alert).

## Tests (spec §9 Test Strategy — fixture replay, no real devices in CI)
Gateway lane: framing across split/joined/interleaved TCP chunks; ACK-after-spool ordering; AR-on-full; duplicate control-id; drain ordering + dead-letter; spool crash-recovery (kill mid-drain → restart → no loss/no dup), backend stubbed. Backend: interval persist / breach pass-through / suppression arm+re-arm-on-ack / artifact N-of-M / idempotent control ids; association single-active + auto-close + ADT end + unassociated park/replay; registry auth (unknown IP/token refused, revoked refused, `DEVICE_GATEWAY` can ingest but not verify/subscribe); cross-tenant refusal (extends CAN-045 tests); timeline/NEWS2 regression (device rows still land `unverified`, NEWS2 paced). E2E replay deep test: fixtures → in-process gateway → real backend → assert vitals rows, suppression counters, ONE alert per breach episode, results-inbox task.

## Deliverable
Branch `feat/nl7-p1-device-gateway`, PR titled `NL-7 P1: device gateway core (MLLP, registry, association, alarm policy)`. PR body = build ledger (scope, invariants held, migs used, exact test commands + pass counts, deferred items). ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after the PR** — coordinator verifies and merges.
