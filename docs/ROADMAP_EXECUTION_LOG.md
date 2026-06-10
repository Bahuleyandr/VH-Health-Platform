# Roadmap Execution Log

Tracks pillar-by-pillar execution of `EPIC_LEVEL_ROADMAP.md`. One branch per
pillar (`roadmap/pillar-<x>`); each item lands as its own commit with tests.
Append per session; newest first.

## Session 2026-06-11 (night) — Pillar G merge + D5 resume (branch `roadmap/pillar-d-d5`)

Pre-work: per-item review of the 5 pillar-g commits — one finding fixed
forward (`08852099`: admin `ScoreboardTotals.reviews` type claimed
`avg_review_latency_minutes`, which the backend totals deliberately never
emit; latency is per-module only) — then merged `roadmap/pillar-g`
`--no-ff` → main `8d8d0ecc` and pushed. Gates had run in-session on the
identical tree and the merge was fast-forwardable, so branch-tested ==
merge-tested; only the admin type-check + scoreboard jest were re-run for
the fix. `roadmap/pillar-d-d5` then recreated from that main;
**stash@{0} (D5 WIP, parked 2026-06-10) applied cleanly** (app.js
auto-merged); both D5 stash entries dropped after the commit landed.
Dalekdefender overlay edits untouched throughout.

| Item | State | Commit | Notes |
|---|---|---|---|
| D5 infection control | ✅ | (see git log) | Resumed the parked WIP (workbench service + routes + deep test + mount) and finished it. **Workbench** at `/api/v1/infection-control` (NABH-style IC/quality role gate + PHI logger): isolation board (active `infection_cases` joined to the live admission/bed), ADT ward-overlap **contact tracing** (index patient's stays define ward+time intervals; any intersecting admission is a contact, overlap hours computed in SQL), **antibiogram** (organism × antibiotic %S/I/R from `micro_sensitivities`→`micro_isolates`→`micro_orders` + MRSA/ESBL/CRE/VRE/XDR phenotype counts). Read-only — no canonical-timeline obligation; case ENTRY stays the existing qualityService reporting surface. **Finished from WIP:** explicit tenant scoping on every query (the WIP had none — `infection_cases`/`admissions` direct, micro tables via `micro_orders.tenant_id`); admission live-set aligned to the house `NOT IN ('discharged','cancelled')` convention. **Migration 296:** `infection_cases` carried tenant_id but was in NO tenant_isolation set (075/262/272 all missed it) — canonical RLS policy + FORCE added (294 pattern), plus partial index `idx_admissions_ward_admitted` for the contact-trace scan; schema.prisma regenerated (the index annotation is the only model change). **Bed-board flag (the roadmap's first D5 deliverable):** patient command board rows now carry `isolation` `{required, types, active_case_count, items}` from active infection cases — `required`/`types` stay visible even on minimized housekeeping-class payloads (bed turnover is exactly who needs the precaution flag); organism/site detail is full-payload only. 7-test deep round trip: board+bed join, cross-tenant leak negative, command-board flag, overlap-hours math + self-exclusion, antibiogram percentages + flags, 400 missing-input, 403 PATIENT. |

### Environment notes

- **ci-setup-db against a scratch DB must run as a BYPASSRLS-capable role**
  (use `postgres`). `000_baseline.sql` is pg_dump output and carries
  `SET row_security = off`; under plain `qa_writer` every migration after
  the FORCE-RLS sweeps (240, 255–296) dies 42501→25P02 as "non-fatal",
  silently leaving the chain at 254 while still printing "CI DB setup
  complete". Working recipe: `createdb` as postgres → vector+pg_trgm →
  `DATABASE_URL=postgresql://postgres@127.0.0.1:55432/vhhealth_drift_fresh
  node scripts/ci-setup-db.mjs --skip-seeds` (301 applied / 0 errors) →
  `prisma db pull` → drift check → drop.
- Command-board tests need a full-board role (`ADMIN`): DOCTOR tokens get
  own-patients scoping, so seeded admissions without an attending doctor
  silently vanish from the board.

### Gates

- Backend: full lint chain green; D5 deep test 7/7; board unit suite 11/11
  (mock gained `infection_cases`); schema regen from a fresh
  migrations-built scratch DB (chain at 296) + drift check green.
- **Full `test:ci`: deferred to merge review.** Run 1 failed only on the
  board unit mock (fixed); the rerun then aborted on
  `fhir-server.deep.test.js` needing `clinical_code_bindings` — a table
  belonging to a CONCURRENT ICD-11/WHO terminology work-stream that was
  writing into this working tree mid-run (migration 297, whoIcdClient,
  diagnosis/problem-list/FHIR service + test edits, from 19:14 onward).
  Not D5 fallout. Owner chose: commit D5 scoped to its own files; the
  combined tree re-runs the full suite when that stream lands.
- No Flutter/admin changes in D5 — melos and admin suites unaffected.

### Environment notes (concurrency)

- **Two writers, one working tree**: a parallel session/agent began
  landing an ICD-11 integration (untracked migration
  `297_clinical_code_bindings.sql` + service/test edits) while this
  session's full suite was running — suite aborts mid-chunk look like
  regressions but aren't. Before merging `roadmap/pillar-d-d5`,
  coordinate with that stream; migration number 297 is now TAKEN by it.
- This commit's `prisma/schema.prisma` change was staged as a single-hunk
  patch (`git apply --cached`) — the working copy also carries the other
  stream's regenerated `clinical_code_bindings` model, which is theirs to
  commit with 297.

### Owner-side actions queued (D5)

1. Coordinate the in-flight ICD-11/WHO terminology stream (migration 297)
   with this branch; re-run full `test:ci` on the combined tree, then
   merge `roadmap/pillar-d-d5` → main after review.
2. Staff-app surfacing of the new command-board `isolation` field (ward
   bed-sheet / command-board chip) — UI follow-up; queue with the next
   staff-app batch.
3. Confirm the infection-reporting workflow with the IC officer so
   `infection_cases` rows are entered consistently (the workbench reads
   what the quality module's reporting surface captures; isolation_type
   vocabulary = contact/droplet/airborne as charted today).

## Session 2026-06-11 (later) — Pillar G start: G3 + allergies rider (branch `roadmap/pillar-g`)

Pre-work: `roadmap/pillar-g` branched from main `2d3123ea` (post Pillar-F
merge). Dalekdefender overlay edits left untouched throughout (incl. via
`rebase --autostash`); D5 stays parked in `stash@{0}`.

| Item | State | Commit | Notes |
|---|---|---|---|
| G3 outcome instrumentation | ✅ | `54084db6` | Per-module AI evidence scoreboard computed ONLY from existing generation/review/safety tables (no new AI modules, no schema change): **acceptance + used rates** from `clinical_ai_reviews` decision buckets (accepted/signed/approved vs edited/revision_requested vs rejected/needs_revision; matches `REVIEW_STATUS_BY_DECISION`); **edit distance** = normalized word-level Levenshtein between `draft` and `edited_draft` (two-row DP, capped 800 tokens, latest 400 edited reviews/window; deterministic sorted-key JSON flatten); **safety-flag precision + override rate** = `clinical_ai_safety_reviews` (needs_review/blocked) joined to the latest human decision per generation — confirmed (rejected/edited) vs overridden (accepted despite flag) — plus passed-but-rejected as the false-negative proxy; **time-to-sign vs baseline** = `clinical_notes` signed with `ai_generation_id` vs same-`note_type` notes without, median+avg minutes per module; **deterministic med-safety override rates** from `medication_safety_reviews` by review_type. Rates are **null, never 0, when there is no data to rate** — "no evidence yet" must not read as 0% acceptance. Surface: `GET /outcome-scoreboard` on the clinical-AI control plane (both mounts; admin/IT roles + IP allowlist; `prismaReadOnly`; schema-tolerant) + admin read view `/dashboard/clinical-ai/scoreboard` (react-query, module/period filters, print-for-board, methodology definitions block for assessors; nav under AI Governance). Enabled-but-idle modules stay on the board (governance signal); disabled idle ones don't. Tests: 16 unit (metric math incl. null-rate honesty) + 3 deep (seeded exact-count round trip, 90-day window exclusion, 403 for clinical roles, legacy alias) + 3 admin jest. |
| Rider: unified allergies over HTTP | ✅ | `ab87d846` | A10/E5 follow-up: `GET /api/v1/allergies/patient/:uid/unified` exposes `getUnifiedActiveAllergies` (union of `patient_allergies` + legacy `allergies` + `users.allergies` + admission intake) behind `CLINICAL_STAFF_ROLES` + `phiAccessLogger('ALLERGY')` — works for ANY patient, admitted or not. Staff `PatientSummarySheet` allergies section now reads this endpoint instead of the admission-scoped command-board payload (the cause of un-admitted patients showing "No allergies recorded"); the command-board read stays as best-effort admission context only. `summarizeAllergies` accepts the `{allergen, severity, sources}` shape alongside the board shapes. 3-test deep round trip (un-admitted union, case-insensitive cross-store merge keeping highest severity + both sources, inactive exclusion, 400 non-UUID, 403 PATIENT) + staff unit case. |
| housekeeping | ✅ | `a5613dce` | `locale_provider_test.dart` dart-format drift (current SDK formatter rewraps what the older one accepted) — committed separately to keep item commits clean. |
| G4 Tier-H pairing | ⏭ blocked | — | Per session brief: only after the owner reports F1 live with real data. Modules stay `enabled=false`. |

### Gates

- Backend: full lint chain green (eslint --max-warnings=0 + raw-params +
  phi-tenant-id + external-region guards + secret scan); new unit 16/16 +
  deep 3/3 + 3/3; full sharded suite `npm run test:ci` 57 chunks green.
  **No schema changes** — migrations stay at 295, no drift run needed.
- Admin: lint + type-check green; jest 24 suites / 277 tests green.
- Flutter: `melos run analyze` ×3 packages clean, `melos run test` all green
  (staff 333), `melos run format` 0 changed.

### Environment notes

- `eslint --max-warnings=0` rejects documentation-only unused consts; fold
  post-commit lint fixes into the item commit via `git commit --fixup` +
  `git rebase -i --autosquash --autostash` (`--autostash` required here —
  the parked dalekdefender overlay edits otherwise block the rebase).
- Deep tests asserting GROUP BY metrics must seed **synthetic keys**
  (module_key / note_type / review_type) — tenant-wide aggregates pollute
  exact-count assertions if seeded under real module keys while the suite
  runs around them.
- Current local `dart format` rewraps some code the previous formatter
  accepted — run `melos run format` before committing Flutter changes and
  expect occasional pre-existing-file drift (commit it separately).

### Owner-side actions queued (Pillar G so far)

1. G3 scoreboard is the standing governance artifact (roadmap §G3/§G7):
   review `/dashboard/clinical-ai/scoreboard` once G2 stage-1 pilot traffic
   exists; until then most rates read "—" by design.
2. Report when F1 warehouse is live with real data → unblocks G4 Tier-H
   pairing (next Pillar-G item).
3. Merge `roadmap/pillar-g` → main after review (or hold for more G items).

## Session 2026-06-11 — Pillar E review+merge, Pillar F start (branch `roadmap/pillar-f`)

Pre-work: per-item review of all 5 pillar-e commits, all gates re-run, then
merged `roadmap/pillar-e` `--no-ff` → main `31106697` and pushed. Deleted the
abandoned `roadmap/pillar-d-d5` branch (local only; D5 WIP stays in
stash@{0}, untouched). `roadmap/pillar-f` branched from the new main.
Dalekdefender overlay edits left untouched throughout.

| Item | State | Commit | Notes |
|---|---|---|---|
| Pillar E review | ✅ | `72c4454e`, `d15e87c6` | E6/E1/E2/E3 pass as-reviewed (E6 proxy create/revoke pass `actorRole: null` from the portal router, so patients can only self-grant — the staff path is unreachable from the patient surface; E1 role set + bulk payload mirror orderRoutes exactly; order-set apply fix places real orders). Two findings fixed forward on the branch: **(1)** E5's `kActiveOrderStatuses` omitted `in_progress` while every backend live-order set uses the ordered/verified/in_progress triple — mid-administration infusions and in-lab specimens silently dropped off the summary sheet (`72c4454e`); **(2)** first full-suite run failed `document-integrity`: two pre-D-sweep test files (`problem-list.deep`, `visit-ownership-guard-deep`) still DELETEd `clinical_audit_events` rows — re-chunking (57 chunks, 451 files) landed the holes before the integrity check this time. Deletes removed (neither asserts on audit contents), QA chain re-built via the migration-282 backfill replay (`d15e87c6`). |
| Pillar E gates | ✅ | — | Backend: lint (all 5 checks), schema drift vs fresh scratch DB, full `test:ci` 57 chunks green after the chain repair. Flutter: `melos run analyze` + `melos run test` green ×3 packages; `i18n-verify` hi/ta/te 100% (1723), ml 32% declared-partial — matches the E2 log entry. |
| F1 analytics warehouse | ✅ | `c703e736` | **Publication (migration 295)**: curated 22-table `vh_analytics_pub` — deliberately not FOR ALL TABLES; `users` published with a PG15 **column list** (id/uid/role/gender/birthday/is_minor/is_active/registered_at/tenant_id) so credentials, contact PHI, `*_encrypted` columns, ABHA/PAN and device tokens can never reach the warehouse; replica-identity (PK) guard fails the migration loudly; conditional grants to `vh_warehouse_repl`. Contract locked by `analytics-warehouse.deep.test.js` (membership, users allow+forbidden lists, PK assertion, no audit/AI/payroll tables). **Infra** `infra/kubernetes/optional/analytics-warehouse/` (B4 PACS opt-in pattern; CNPG operator is 1.24 → pre Publication/Subscription CRDs, so idempotent SQL Jobs): single-instance PG17 subscriber Cluster (`statement_timeout=0` — the point of F1; managed roles `vh_dbt` BYPASSRLS / `vh_metabase` marts-only), publisher-setup Job (wal_level check + repl role + grants from `pg_publication_tables`), warehouse-migrate Job (same migration chain, new `--skip-seeds` ci-setup-db flag so the subscriber holds replicated truth only), subscribe Job (TRUNCATE-before-copy; `REFRESH_PUBLICATION=1` mode for post-release refreshes), nightly dbt CronJob fed by configMapGenerator straight from `analytics/dbt/` (no egress, no dbt packages). **dbt**: staging views + `dim_date/department/doctor/patient` (age-banded, pseudonymous-by-construction) `/payer` + `fct_encounters` (OPD+IPD+ER with payer_class) / `fct_orders` (3 stores unified) / `fct_revenue` (invoice-line grain); `grant_marts_read` post-hook keeps Metabase marts-only. `ci-warehouse.yml` builds dbt against a migrations-built service PG + `kustomize build` check. `docs/ANALYTICS_WAREHOUSE.md` + module README carry the bring-up/release runbooks and the slot-WAL-retention alert. Validated: migration on scratch+QA, jest 5/5, `dbt build` 52/52 against the migrated scratch DB. |
| F2 operational marts | ✅ | `9eb448d8` | `mart_bed_flow_daily` (per-ward admits/discharges/transfers, midnight census via day-spine interval join, occupancy vs seeded ward structure — 819 ward-day rows materialize from the seeded structure alone), `mart_ot_utilization_daily` (cases + planned/utilized minutes vs the `ot_available_minutes_per_day` var; completed cases without `actual_duration` fall back to estimate), `mart_department_revenue_monthly` (gross/discounts/net/collected/outstanding/voided — **deliberately P&L-lite**: payroll cost tables stay out of replication pending an explicit privacy sign-off), `mart_payer_mix_monthly` (encounter mix by payer_class + IPD billed + TPA/insurance settlement). Column tests per mart + singular grain/occupancy-bounds test. Full project `dbt build` 52/52. |
| G4 Tier-H pairing | ⏭ deferred | — | Per the session brief: only after F1 runs clean in prod. Modules stay `enabled=false`, unwired; pairing is its own roadmap item (`docs/ANALYTICS_WAREHOUSE.md#g4`). |

### Environment notes

- **Port 55432 was hijacked at session start**: a WSL ssh tunnel
  (`ssh -N -L 0.0.0.0:55432:127.0.0.1:5433 bahuleyan@dalekdefender`, started
  07:01) was shadowing the QA cluster port — `qa-cluster-up` saw "already
  accepting connections" then died on SCRAM (the local QA cluster is trust;
  the remote isn't). Killed per user choice; if the tunnel comes back, give
  it a different local port.
- **`robocopy`/`xcopy` into the repo clobbered fresher working-tree edits**
  (robocopy copies on ANY size/time difference; xcopy also silently skipped
  6 files mid-directory). When staging generated files from outside the
  repo, copy then re-verify every in-repo edit — or write files in place.
- **Bare `pip install dbt-postgres` resolves the dbt Fusion 2.0 alpha**,
  which has no postgres adapter. Pin `"dbt-core<2"` everywhere (done in
  `ci-warehouse.yml`); validated combo is core 1.11.x + dbt-postgres 1.9.1.
  Keep `schema.yml` in pre-1.10 test syntax — the in-cluster CronJob image
  (`dbt-postgres:1.9.latest`) predates the `arguments:` property.
- **Prisma 7 driver adapter cannot deserialize `name[]`** (pg catalog
  arrays): `pg_publication_tables.attnames` needs `::text[]` — same family
  as the 42P08 untyped-param rule.
- The C4 chain-hole failure mode is **order-dependent**: deletes of audit
  rows only break `document-integrity` when later appends land behind them
  before the check runs — a green suite does NOT prove cleanups are clean.
  `git grep "DELETE FROM clinical_audit_events" src/tests` should stay empty.
- **kustomize configMapGenerator load restrictions** (caught at merge-review
  by a local `kubectl kustomize` build): generator file sources must live
  in/below the kustomization root — ArgoCD would have refused the module as
  first committed. The dbt project therefore lives INSIDE the module
  (`optional/analytics-warehouse/dbt/`), not at a top-level `analytics/`.
- `ci-setup-db.mjs` now supports `--skip-seeds` / `CI_DB_SKIP_SEEDS=1`.
  Note: without the flag it seeds test staff (EMP-1001..) unconditionally —
  including under NODE_ENV=production (pre-existing; the prod migration job
  inherits this. Flagged for owner review).

### Owner-side actions queued (Pillar F)

1. Enable the warehouse: seal the 3 secrets, add
   `optional/analytics-warehouse` to the prod overlay, run
   publisher-setup → migrate → subscribe, first dbt build, then repoint
   Metabase at `vhhealth-warehouse-rw` as `vh_metabase` and retire its OLTP
   connection (module README has the exact commands).
2. ~~Add the `AnalyticsReplicationSlotStalled` PrometheusRule~~ — shipped
   in-module (`slot-alerts.yaml`, stalled + inactive rules) later this same
   session; verify CNPG metric names once post-enablement.
3. Decide the payroll-cost question: publishing payslip aggregates would
   upgrade `mart_department_revenue_monthly` to true P&L — needs an explicit
   privacy sign-off; queue as its own item if wanted.
4. Confirm `ot_available_minutes_per_day` (default 600) per theatre with the
   OT incharge; override via dbt vars.
5. Review the unconditional test-staff seeding in prod's migration job
   (pre-existing; `--skip-seeds` now exists if it should stop).
6. G4 Tier-H pairing decision once F1 has real data flowing.
7. Merge `roadmap/pillar-f` → main after review.

## Session 2026-06-10 (late night) — Pillar E Flutter items (branch `roadmap/pillar-e`)

Pre-work: an abandoned `roadmap/pillar-d-d5` branch (at main `8edae310`)
had the D5 stash applied **and staged**; parked it as its own stash entry
— **stash@{0} is now "WIP D5 rebased-on-main 8edae310 … resume this one"**
(the original pillar-d stash slid to stash@{1}) — then switched back to
`roadmap/pillar-e`. Dalekdefender overlay edits left untouched throughout.

| Item | State | Commit | Notes |
|---|---|---|---|
| E1 CPOE order composer | ✅ | `0a2341cc` | Staff-app composer over the existing backend CPOE (zero backend changes): formulary + investigation-catalog type-ahead (`/pharmacy-orders/catalog`, `/investigations/catalog`), quick-add forms for med/lab/radiology/ecg/consult/nursing/diet, basket signed atomically via `POST /emr/orders/bulk` (per-item CDS server-side before any row), advisory per-draft CDS pre-check chips (`/emr/cds/check-order`), 400 `CDS_BLOCKER` surfaces structured blockers in `CdsBlockerModal` — new no-override mode because the order endpoints accept none (the prescription flow keeps its recorded-override path). Phone-mode write gate (`CLINICAL_WRITE_DESKTOP_ONLY`/`DEVICE_TYPE_MISSING`) handled with friendly copy. Medication items doctor-gated client-side mirroring `MEDICATION_ORDER_WRITE_ROLES`. **Found+fixed en route:** the Sprint-8 order-sets "apply" only wrote the `clinical_order_set_applications` analytics row while telling the doctor "Applied N orders" — no clinical_orders ever existed; it now places REAL orders through the bulk endpoint (analytics log demoted to best-effort) and doubles as the composer's set picker. OrdersScreen rewritten: renders canonical nested `details`, full status set incl. discontinued, cancel/discontinue with mandatory reasons, order_number + priority chips. 27 unit tests on the pure helpers (payload contract, set-item mapping, CDS envelope parsing, role gate). |
| E2 staff i18n | ✅ | `6d6c6a1f` | Scope agreed with owner: **user-facing parity, not ARB churn** (the roadmap line predates the staff app's existing 1,7xx-key AppStrings system; a gen-l10n port = ~1.5k call-site rewrites for zero user-visible gain — deliberately deferred). Shipped: `LocaleProvider` + Settings language picker (SharedPreferences-persisted; null = follow device locale, the historical default) wired into `MaterialApp.locale`; **Malayalam added as a declared-partial locale** — 532 nurse-facing keys (vitals/vitals chart, MAR scan, due meds, nursing notes, handover, bed sheet, code blue, CDS, orders/composer/order sets, drug chart, login/dashboard/settings/common), register matched to the patient app's ml ARB, English fallback for the rest by design, `i18n-verify` reports ml separately; **hi/ta/te restored to 100%** (43 keys later sessions had added en-only); drug-chart screen de-hardcoded (`drug_chart.*` ×5 locales). All new clinical strings `// REVIEW:`-flagged for fluent clinical review pre-rollout. `LANGUAGE_HEALTH.md` rewritten with current numbers + the ~300-string hardcoded-English backlog (pharmacy screen next; nav labels need a coordinated role_config+tests change). 8 tests incl. a supportedLocales↔languageNames consistency lock. |
| E3 accessibility | ✅ | `09935ec2` | **Font-scaling parity**: in-app preference (Settings → Appearance → Font size, 12–22 pt, ThemeProvider-persisted) composed with the OS text scale through a `MediaQuery` `TextScaler` in `main.dart` — so the many hard-coded chip/pill `fontSize:`s scale too (A11y #9), closing the staff-vs-patient `font_scaler` gap; pure `composeTextScaleFactor` with floor = slider-min at neutral OS. **Screen-reader plan executed to the extent a machine can**: `test/a11y/screen_reader_plan_test.dart` pins the semantics tree per plan scenario — S3 toast live regions (Success/ErrorToast announce + flag survives label merge), S8 reduce-motion freeze + `Loading…` live region, S9 scale clamps + preference persistence. Plan doc records the automated coverage; **S1/S2/S4–S7/S10–S12 (the by-ear NVDA/TalkBack pass) stay owner-side** — like the DR drill, code can't listen. |
| E5 patient summary + tap depth | ✅ | `77655547` | `PatientSummarySheet` — Epic-style density: allergies (loud, first), active problems (**B7's first staff-app surface**), active medication orders, last-vitals line, pending results (result-type orders not completed), quick links to Orders/Vitals/Timeline/Notes. Composed client-side from existing endpoints in parallel (command board, `/problems/patient/:uid`, vitals chart, clinical orders partitioned); each section degrades independently. Reachable in **1 tap** from Timeline/Orders/Composer/Command Board (app-bar/row icon) and **2 taps from ANY screen** via the global patient search (`summaryOpener` injected at boot so the core widget stays feature-free). `docs/TAP_DEPTH_AUDIT.md` records before/after (active problems previously had NO staff surface; "all five together" was impossible) + the follow-up queue. 11 unit tests. |
| E4 admin i18n | ⏭ skipped | — | Post-pilot per the roadmap and the session brief. |
| Wrap-up | ✅ | (this commit) | `melos run analyze` + `melos run test` green across the workspace (core + staff 332 + patient). i18n-health: hi/ta/te 100% of 1,7xx keys, ml 31% declared-partial. No backend or schema changes this session — migrations stay at 294; backend suite state unchanged from `8edae310`. |

### Environment notes

- **Desktop Commander cmd sessions don't inherit `%PROGRAMFILES(X86)%`** —
  `flutter.bat` hard-fails on it. Prefix host-side Flutter/melos runs with
  `set "PROGRAMFILES(X86)=C:\Program Files (x86)"`.
- The machine's melos global activation was gone (Dart SDK update wiped
  pub-cache bin); re-activated `melos 7.8.1` (root pubspec pins ^7.8.1 —
  the root CLAUDE.md still says 7.5.1).
- cdsEngine pre-check (`/emr/cds/check-order`) returns `{safe, alerts[]}`
  with severities critical|warning|info, while `createOrder(sBulk)` hard
  blockers come back as 400 `CDS_BLOCKER` with
  `details.{order_index, blockers[], warnings[]}` — two different shapes;
  the composer treats the former as advisory chips only.

### Owner-side actions queued (Pillar E this session)

1. Malayalam + the new hi/ta/te batches need a fluent clinical review
   pass before rollout to Malayalam/Tamil/Telugu-speaking wards
   (`// REVIEW:` flags mark every string; `melos run i18n-health`).
2. Run the by-ear NVDA/TalkBack scenarios (S1/S2/S4–S7/S10–S12 in
   `SCREEN_READER_TEST_PLAN.md`) — one tester per platform, 60–90 min.
3. Seed real order sets (`clinical_order_sets`) for the pilot wards — the
   composer's one-tap flow is only as good as the bundles loaded.
4. Small backend follow-up for OP allergies in the summary sheet: expose
   A10's `getUnifiedActiveAllergies` over HTTP (today the sheet reads the
   admission-scoped command-board payload, so un-admitted patients show
   "No allergies recorded").
5. Merge `roadmap/pillar-e` → main after review (E-pillar UI items are
   complete; E4 stays post-pilot).

## Session 2026-06-10 (night) — Pillar E start (branch `roadmap/pillar-e`)

Pre-work: merged `roadmap/pillar-d` `--no-ff` → main `8edae310` (suite 57
chunks + drift + full lint green, per-item review done in-session) and
pushed; `roadmap/pillar-e` branched from that main.

| Item | State | Commit | Notes |
|---|---|---|---|
| E6 portal results + proxy | ✅ | `5a5c87fd` | **Release rules**: portal visibility = signed off AND not held AND (auto-release delay elapsed OR clinician released early). `PORTAL_RESULT_RELEASE_DELAY_HOURS` (default 24, in validateEnv); migration 294 backfills pre-existing signed-off rows as released so nothing patients could already see disappears. Doctor hold needs a reason; early release overrides a hold; both audited. Staff surface `/api/v1/lab/release` (mounted before `/lab` so the narrower lab gate can't shadow it). **Trends**: `/portal/lab-results/trends` — released-only longitudinal numeric series per test (min/max/latest + points). **Proxy access**: `portal_proxy_grants` is the consent trail (method/ref/grantor/expiry/revocation; one active per patient×proxy); `for_patient=` is the one sanctioned exception to never-trust-caller-patient-uid — resolves only through an active grant with matching scope, every proxy read audited with the grant id. 7-test deep round-trip; portal+abdm regression suites green (29 tests). |

Remaining Pillar E is mostly Flutter-side and lands in following sessions:
E1 CPOE order composer in the staff app (backend orders/order-sets are
ready — pure UI), E2 staff-app i18n (port the patient app's l10n pipeline;
nurse-facing screens first), E3 execute `SCREEN_READER_TEST_PLAN.md` +
font-scaling parity, E5 one-screen patient summary / tap-depth audit, E4
admin i18n (explicitly post-pilot per the roadmap).

### Owner-side actions queued (Pillar E so far)

1. Confirm the result-release policy with the medical director: default
   delay 24 h? Which test families should clinicians hold by default
   (e.g. histopathology)? Hold workflow comms to doctors.
2. Decide the proxy-consent ceremony at reception (OTP vs written) so
   `consent_method`/`consent_ref` get real values from day one.
3. Merge `roadmap/pillar-e` → main after review (or hold until more E
   items land).

## Session 2026-06-10 (evening) — Pillar D continuation + C1 encryption (branch `roadmap/pillar-d`)

Pre-work happened in an interrupted earlier half-session: `roadmap/pillar-c`
was merged `--no-ff` → main `db75b945`, `roadmap/pillar-d` branched, and
D2/D4/D3 landed there before the session stopped mid-D5. This session
resumed per user direction: **D5 infection control deferred** (WIP stashed,
see below), everything else proceeded — including D1/D7 in full depth.

| Item | State | Commit | Notes |
|---|---|---|---|
| D2 scheduling | ✅ (earlier half-session) | `97fb36d4` | Provider availability templates (weekly recurrence, slot sizing), provider_leaves auto-block, appointment_waitlist with 10-min auto-fill sweep, bookable_resources + tx-serialised overlap guard, overbook allowance fed by `clinical_ai_no_show_predictions`. 11 tests. |
| D4 NABH pack | ✅ (earlier half-session) | `2a7f5b08` | Indicator pack computed from captured data + assessor export. |
| D3 credentialing | ✅ (earlier half-session) | `521b3338` | `staff_credentials` registry (credential_type incl. `privilege`), expiry radar, `hasActivePrivilege()` gate for clinical surfaces. |
| D5 infection control | ⏸ deferred | `stash@{0}` | User call 2026-06-10: do later. WIP (service+routes+test+app.js mount) stashed as "WIP D5 infection-control workbench (deferred per user 2026-06-10)". Resume = `git stash pop`, finish, migration, tests. |
| C1 follow-up: FHIR-bundle encryption | ✅ | `dda199b9` | `abdmCrypto.js` — FIDELIUS-equivalent ECDH(X25519) + HKDF-SHA256 (salt = first 20 bytes of nonce XOR, IV = last 12) + AES-256-GCM (tag appended). Unit-anchored to the RFC 7748 vector + an independent AES-GCM re-derivation; accepts raw-32/DER-44 peer keys. Data push now REFUSES plaintext, POSTs encrypted entries to the HIU `dataPushUrl` (captured per hiRequest, migration 288), embeds our ephemeral public keyMaterial, fires `/health-information/notify` best-effort. Preflight gap flipped to non-blocker; **byte-level interop sign-off rides the sandbox M2 dry run (owner blockers 1–2 in `docs/ABDM_READINESS.md`)**. Also fixed 5 un-spread `dateParams` sites (the Phase-0.5 lint blind spot). |
| C1 fix: collect drift | ✅ | `adb63a10` | **Every** `collectHealthData` HI-type branch selected nonexistent columns (written against an imagined schema) — M2 collection could never have produced a bundle. Repointed to real columns; DiagnosticReport now reads `lab_results` (the B3 canonical store); OPConsultation resolves `users.uid → appointments.patient_id`. 5-test deep regression incl. the date-binding case. |
| D6 research/registry | ✅ | `c6945f6b` | RDC-lite riding the trial-matcher catalog: registries, versioned CRF forms (JSONB field schemas; fields may declare **bindings** that auto-pull `vitals_latest` / `lab_latest` / `demographics` at capture — column-whitelisted), pseudonymous enrollments (`REG-NNNN`, one live per registry×patient, optional link to the AI match), responses draft→submitted→verified→locked with per-field autofill provenance. Export = flat CSV/xlsx grid, **de-identified by default**; `include_phi` is admin/leadership-gated. Enrollment/withdrawal/submission on the canonical timeline. 10 tests. |
| D1 oncology foundations | ✅ | `de2ce1f2` | Chemo protocols (mg/m² XOR fixed dosing, days-of-cycle validation, vesicant flag, `max_lifetime_dose_per_m2`), plans (Mosteller BSA from latest vitals; one live per patient×protocol), per-cycle re-weigh + BSA recompute, administrations with **two-person verification** (different-human guard, B5 pattern; wristband mismatch blocks) and `chemo_cumulative_doses` updated in the SAME tx. Cycle scheduling **blocks ceiling breaches** without an override reason (recorded + on the timeline). Optional D3 hook: `CHEMO_REQUIRE_ADMIN_PRIVILEGE=true` requires an active `chemo_administration` privilege. **Protocol content ships empty by design — regimens are pilot-side data pending clinical review.** 18 tests. |
| D7 dialysis depth | ✅ | `998c7d61` | `dialysis_prescriptions` (one active per patient, supersession in-tx, roster snapshot sync, sessions inherit params), machine-data ingestion via the B3 inbox (raw JSON first → `lab_interface_messages`, then obs land through the standard path tagged `source=device`, matched by `machine_no` to the in-progress session; failures replayable), `dialysis_session_events` structured complications (typed/severity/intervention; keeps the legacy session boolean flags in sync; timeline events). Fixed a dormant 42P08 in `enrolPatient`. 6 tests. |
| D7 dental + ophthalmology | ✅ | `3d05a896` | Both greenfield. Dental: FDI-validated tooth findings (active/resolved) + procedures whose completion **auto-resolves the finding treated**; odontogram chart endpoint. Ophthalmology: per-eye exams (VA notations `6/x|CF|HM|PL|NPL|Nx` validated, IOP 0–80 with mandatory method, **>21 mmHg raises a glaucoma alert** + distinct timeline event, lens grading), refractions (sphere/cyl/axis/add CHECKed both sides, axis mandatory with non-zero cylinder; `final_glasses` rows are the dispensable spectacle prescription). 14 tests. |
| Wrap-up | ✅ | (this commit) | Migrations 288–293; per-commit `prisma db pull` regen from a migrations-built fresh DB + drift check green each time (also picked up partial-index annotations the 285/287 regen had missed). Full backend lint green (eslint + raw-params + phi-tenant-id 178 tables + secret scan). Full sharded suite (57 chunks) **green** after one self-inflicted finding: the new deep tests' cleanup deleted `clinical_audit_events` rows, punching holes in the C4 hash chain — `document-integrity` failed. Fix: cleanups no longer delete audit rows (append-only by design), and the test DB chain was rebuilt with the 282 backfill logic. |

### Environment notes

- **Prisma 7 driver adapter surfaces 42P08 on untyped param contexts.**
  `CASE WHEN $n IS NOT NULL` / param reuse across `text`-vs-`varchar`
  contexts that old drivers tolerated now fail with `inconsistent types
  deduced` / `could not determine data type`. Two dormant instances found
  (dialysis `enrolPatient`, new CRF-form insert). Rule: cast explicitly
  (`$n::numeric`, `$n::varchar`) wherever a param lacks a single typed
  context.
- Schema regen scratch DB: `vhhealth_drift_fresh` on the QA cluster
  (127.0.0.1:55432), built by `ci-setup-db.mjs` from 000_baseline + all
  migrations (needs `CREATE EXTENSION vector, pg_trgm` first on a fresh
  DB). `prisma db pull` only from this (never the long-lived QA DB).
  Reused incrementally across the session; safe to drop after.
- Test-data timezone: server-local `NOW()` (IST) vs JS UTC `Date` windows —
  use ±2-day windows when asserting date-range filters (Phase-0.5 note).
- **Never DELETE from `clinical_audit_events` in test cleanup** — the C4
  hash chain treats it as append-only; holes fail `document-integrity`
  for the whole tenant. Scope assertions by the per-run patient uid
  instead. (Repair if it ever happens again: NULL the chain columns and
  re-run the migration-282 backfill block.)

### Owner-side actions queued (Pillar D continuation)

1. ABDM sandbox credentials + bridge registration, then the **M2 dry run
   against the sandbox HIU** — validates the new encryption byte-level
   (`docs/ABDM_READINESS.md`; preflight now passes the encryption gap).
2. Source chemo protocol content (regimen library) with the pilot
   hospital's oncology board; load via `/api/v1/oncology/protocols`; decide
   whether `CHEMO_REQUIRE_ADMIN_PRIVILEGE` goes ON (needs D3 privileges
   loaded for chemo nurses first).
3. Point dialysis machine bridges/middleware at
   `POST /api/v1/dialysis/machines/ingest` (JSON; `machine_no` must match
   the session board) for the pilot dialysis unit.
4. Pick the registries/CRFs the research office wants first (D6) and seed
   them; decide the de-identified-export sharing policy.
5. Resume D5 infection control when ready: `git stash pop` on
   `roadmap/pillar-d` (stash message above), finish workbench + migration.
6. Merge `roadmap/pillar-d` → main after review.

## Session 2026-06-10 (later) — Pillar B merge + Pillar C (branch `roadmap/pillar-c`)

Pre-work: merged `roadmap/pillar-b` `--no-ff` → main `8d6a5880` (9 commits,
suite + drift green, per-item review done in-session) and pushed;
`roadmap/pillar-c` branched from that main.

| Item | State | Commit | Notes |
|---|---|---|---|
| C4 integrity | ✅ | `d28a7cfa` | Per-tenant sha256 hash chain on `clinical_audit_events`, computed by a BEFORE INSERT trigger (advisory-lock serialised; covers every write path; existing rows backfilled; hash expression lives in ONE SQL function shared by trigger + verification). `clinical_document_signatures`: content-hash e-signatures over notes/discharge summaries/encounters/consents/radiology reports — verification recomputes the hash, so any post-signature edit is detectable; `aadhaar_esign`/`dsc` methods schema-ready (gateway owner-side). Encounter sign-off auto-attaches a signature. `/api/v1/integrity` + admin chain verify. |
| C3 FHIR R4 server | ✅ | `0865356f` | Write interactions on the existing read server: POST Observation (vital-sign LOINCs incl. BP panels → vitals_chart through the standard path — NEWS2/anomaly/canonical events fire), POST Condition (→ B7 problem list with dedupe + terminology verdicts; 409 on duplicate active code), POST AllergyIntolerance (→ `patient_allergies`, the store all CDS reads). Condition search + `$everything` surface the longitudinal problem list as `problem-list-item` alongside encounter diagnoses. Router-level OperationOutcome error contract; CapabilityStatement updated; writes gated to doctor/admin/integration. MedicationRequest stays read-only by design (the prescription safety engine owns that write path). |
| C2 HL7v2 outbound feeds | ✅ | `fa4b930e` | `hl7_feed_subscriptions` (per-type fan-out over an HTTP bridge; MLLP terminates into the bridge owner-side, mirroring B3 inbound) + `hl7_outbound_messages` durable queue (tenant RLS — payloads are PHI). Emission hooks (Phase 1.5 best-effort): ADT^A01 on admission, ADT^A03 on discharge, ORU^R01 at pathologist sign-off. Delivery worker every 2 min, exponential backoff, dead after 7 attempts, replay + manual tick; `x-application/hl7-v2+er7`. Deep test runs a live local HTTP receiver. |
| C5 device vitals | ✅ | `f2430f34` | Provenance labelling on `vitals_chart` (`source` staff/device/fhir/patient_app, `source_device`, `device_verified` + verification stamps; partial index = ICU review queue). Monitor ORU^R01 (PID-3 = patient uid, the BCMA wristband identifier) lands through the STANDARD `recordVitals` path — NEWS2, anomaly alerts, canonical events all fire — tagged `device-synced`/`unverified` per the canonical timeline convention; clinician verify endpoint flips the flag with a chained audit event. Raw payloads persist in the B3 interface inbox. |
| C1 ABDM readiness | ✅ pack | `f5c21989` | Substrate is largely built (ABHA, consents, care contexts, gateway client, 9 `abdm_*` tables; FHIR sources strong post-C3, audit chained post-C4). Shipping a machine-readable preflight (`scripts/abdm-preflight.mjs`) + `docs/ABDM_READINESS.md`. **Blockers: sandbox credentials + bridge registration (owner-side) and the ECDH(Curve25519)+AES-GCM FHIR-bundle encryption gap (FIDELIUS-equivalent, ~2-3 days) — schedule as the first Pillar-C follow-up before any M2 attempt.** |
| Wrap-up | ✅ | (this commit) | `prisma db pull` regen + drift check green; full sharded suite (55 chunks) **passed first run, zero fallout** — the C-pillar additions (hash-chain trigger included) were transparent to every existing suite. |

### Owner-side actions queued (Pillar C)

1. ABDM sandbox signup + bridge registration; then schedule the
   FHIR-bundle encryption work (the M2 blocker) — `docs/ABDM_READINESS.md`.
2. Point real third-party receivers (LIS/insurer/HIE bridges) at
   `/api/v1/hl7-feeds` subscriptions; stand up MLLP terminators where
   needed.
3. Decide which documents beyond encounter sign-off auto-sign (discharge
   summaries at `/ready`? consents at capture?) and whether to procure the
   Aadhaar eSign gateway for `aadhaar_esign` signatures.
4. Point ICU monitors/gateways at `/api/v1/devices/vitals/ingest` (PID-3
   must carry the wristband uid) for the pilot ICU.
5. Merge `roadmap/pillar-c` → main after review.

## Session 2026-06-10 — Pillar A merge + Pillar B (branch `roadmap/pillar-b`)

Pre-work: reviewed `roadmap/pillar-a` (8 commits — focus: Prisma model-API
RLS wrapper, migrations 272–274, downtime route auth, $transaction
conversions, CNPG/monitoring manifests), independently re-ran lint + the 33
pillar-a unit tests, then merged `--no-ff` → main `7d5a3e9f` and pushed.
Merge is deploy-safe: prod image digest stays pinned, so migration 272 + the
runtime-role env var activate at the next backend image release; the CNPG
managed role + nightly ScheduledBackup apply immediately (intended).

| Item | State | Commit | Notes |
|---|---|---|---|
| B8 terminology service | ✅ | `164bea13` | Code-system registry (ICD-10/11, SNOMED CT, LOINC, ATC) + concepts (+pg_trgm search when available) + concept maps + local-catalog bindings (`investigation_test_catalog`/`pharmacy_catalog`/`medications`, suggest+confirm flow, coverage report). ICD-10 federated from `icd10_codes`; LOINC keeps the structural fallback until the full catalogue is imported so HL7 ingestion behaviour is unchanged. Importer CLI: SNOMED RF2 (free NRC license), LOINC csv, generic CSV. `/api/v1/terminology`. |
| B7 problem list | ✅ | `a031eaae` | `patient_problems` (active/resolved/inactive/entered_in_error, onset, managing doctor via the A9 canonical resolver, ICD-10/SNOMED soft-validated through B8, chronicity, provenance to the per-visit diagnosis row) + tenant RLS + one-active-coded-problem guard. Idempotent diagnosis promotion. Active problems feed encounter-start CDS cards and the B2 drug–disease checks. Timeline invariant honoured (detail+timeline+audit in one tx). |
| B2 drug knowledge base | ✅ code-complete | `b51b9d7a` | 7 `drug_kb_*` tables (monographs w/ Indian brand aliases, interactions, allergy cross-sensitivity groups, drug–disease by ICD-10 prefix vs the B7 problem list, dose ceilings incl. renal, IV Y-site) + clearly-flagged textbook starter set (~160 rows). Engine is TTL-cached and schema-tolerant (never bricks prescribing pre-migration). Wired as section 8 of `validatePrescriptionSafety`: contraindicated/major interactions, same-class allergy hits, disease contraindications and major dose breaches → blockers (same override path); dedupes against the legacy antithrombotic/allergy floor checks. **Licensing a real KB (Medi-Span/FDB/CIMS) is owner-side — import via `scripts/drug-kb-import.mjs`, then deactivate `vh_starter_set`.** |
| B1 BCMA closed loop | ✅ | `359b9f12` | Pharmacist clinical-verification gate as orthogonal columns on `pharmacy_orders` (client status enums untouched): `/pharmacy/orders/:id/verify` runs the full safety engine (allergy stores + B2 KB + B7 problems), writes `medication_safety_reviews` + canonical events in-tx, blockers require override-with-reason; PREPARING/DISPATCH/counter-dispense hard-gated server-side (grandfathered pre-existing orders). MAR is now scan-first: bare `/administer` 409s without a documented override (persisted + audited). Dispenses issue `VHMP-` pack barcodes the 5-rights drug-right matches exactly; wristband endpoint prints Code 39 of the patient uid (dependency-free SVG). Flags `MAR_REQUIRE_BARCODE_SCAN`, `PHARMACY_REQUIRE_CLINICAL_VERIFICATION` (both default ON). |
| B6 med-rec three-point | ✅ | `cf969458` | `medication_reconciliations` + items (tenant RLS; one open rec per patient/type/admission). Start snapshots home meds + active prescriptions + scheduled MAR (deduped, source priority per rec point); every drug needs an explicit continue/stop/change/new/hold decision (stop/change/hold need reasons; change needs instructions); completion blocked while undecided; discharge recs emit the take-home list. Per-item decisions audited; start/complete on the canonical timeline. The G2 stage-1 ward pilot (med-rec AI module) rides on this workflow. |
| B5 transfusion loop | ✅ | `33be670d` | `blood_units` registry pinned to requests at crossmatch (ABO/Rh matrix guard — recording an incompatible pairing as 'compatible' needs an override reason); two-person bedside verification (`first`/`second` must be different humans; scan unit + wristband; group/expiry verdicts; override audited); start/complete + the legacy `/transfused` path all hard-gate on both verifications; structured `transfusion_reactions` (type/severity/vitals/intervention) replaces notes-append. Canonical events at every step. |
| B3 lab closed loop | ✅ foundations | `04e2d2c9` | Specimen `barcode` (backfilled from accession) + printable Code 39 labels + case-insensitive scan-on-receipt (status history + canonical events). `lab_interface_messages` inbox persists every raw analyzer payload with parse/ingest outcome — failures are visible and replayable. Pure ASTM E1394 parser; ASTM results land in `lab_results` pinned to the scanned specimen and run critical detection + the autoverification delta/critical-band helpers at ingestion. **Per-analyzer serial/MLLP transports for the pilot hospital's instruments are owner-side; middleware-capable analyzers can POST to `/api/v1/lab/interface/ingest` today.** |
| B4 PACS + viewer | ✅ foundations | `6d41fc6d` | Opt-in infra module `infra/kubernetes/optional/pacs` (Orthanc StatefulSet w/ DICOMweb+worklists, OHIF viewer) — deliberately NOT in `base/` because `overlays/prod` consumes base wholesale; enabling is an explicit overlay edit per the README. Backend `/api/v1/pacs`: study linking pins `pacs_study_instance_uid` and puts an `imaging.study_linked` event with the OHIF deep link on the patient timeline; MWL-shaped worklist feed (`RAD-<orderId>` accessions, DICOM DA/TM) for the Orthanc worklist sidecar. `PACS_*` env in validateEnv. **Deploy, PVC sizing, modality pointing, Lua link hook: owner-side.** |
| Schema sync + suite | ✅ | (this commit) | `prisma db pull` regen against the migrations-built test DB; `check-schema-drift` green. Full suite via the sharded `test:ci` runner (the plain 4 GB run OOMs). Gate-fallout fixed forward: 3 `prescription-deep` dispense tests now verify (or override the paediatric-dose blocker) before dispensing; `clinical-safety` non-scan administrations carry documented overrides — both are the B1 policy working as designed. |

### Environment notes

- `scripts/ci-setup-db.mjs` does not load `.env` itself — run via
  `node -r dotenv/config scripts/ci-setup-db.mjs` when applying migrations
  to the test DB by hand.
- Targeted deep-test runs need `--forceExit` (app timers keep jest alive;
  the full-suite scripts already pass it).
- **Sandbox `sed -i` against the Windows mount TRUNCATES files** (corrupted
  a test file mid-session; rewritten host-side). Same hazard class as the
  Pillar A `.git/index` warning: mutate repo files only via host-side
  tooling.
- The full suite must run through `npm run test:ci` (54 sharded chunks);
  the single-process `npm test` run exhausts the 4 GB heap.

### Owner-side actions queued (Pillar B)

1. License a real drug KB (Medi-Span / FDB / CIMS), transform to the
   documented CSVs, import via `scripts/drug-kb-import.mjs`, validate, then
   deactivate `vh_starter_set` — the B2 acceptance gate.
2. Download SNOMED CT (NRC India) + LOINC releases and run
   `scripts/terminology-import.mjs` (B8 content; schema+API are live).
3. B1 go-live ceremony on the pilot ward: print wristbands + pack labels,
   confirm scanner hardware, decide whether the
   `MAR_REQUIRE_BARCODE_SCAN` / `PHARMACY_REQUIRE_CLINICAL_VERIFICATION`
   defaults (ON) stand during week one.
4. Stand up analyzer transports (serial/ASTM or MLLP → POST
   `/api/v1/lab/interface/ingest`) for the instruments the pilot hospital
   owns (B3).
5. Enable `infra/kubernetes/optional/pacs` in the prod overlay (size the
   imaging PVC first), point modalities at AET `VHHEALTH`, wire the Orthanc
   OnStableStudy Lua hook to `/api/v1/pacs/orders/:id/link-study` (B4).
6. Merge `roadmap/pillar-b` → main after review.

## Session 2026-06-09/10 — Pillar A (branch `roadmap/pillar-a`)

| Item | State | Commit | Notes |
|---|---|---|---|
| A2 tenant RLS end-to-end | ✅ code-complete | `7445d25f` | Migration 272 FORCEs all 62 tenant_isolation tables (075 set incl. `users` was owner-exempt in prod). **Found+fixed a live cross-tenant PHI leak**: Prisma model-API calls (`findMany` etc., batches 26–38) bypassed the RLS auto-wrapper entirely — proven by the new HTTP deep test (tenant-B admin read tenant-A appointments through /appointments/list), then closed by wrapping model delegates in the same setTenant path. Posture probe now flags owner-exempt-unforced tables. `AUTH_TENANT_RLS_RUNTIME_ROLE` canonical env + CNPG managed role `vhhealth_app` + boot-time grant ensure. 4 array-form `$transaction([model…])` sites converted to interactive form. 32 RLS tests green. |
| A9 doctor-ID resolver | ✅ | `0101bbb6` | Write path already canonical (`resolveDoctorRef`). Added lenient `resolveDoctorFilterId` + adopted at 7 read surfaces (appointments list + /doctor/:id ownership check, investigations, feedback, records list + PDF/Excel export, OPD dashboard). |
| A10 allergy propagation | ✅ | `422a7e66` | `getUnifiedActiveAllergies` unions all four allergy stores; adopted in the prescription gate, encounter-start CDS card (which had NEVER rendered — selected a nonexistent `allergen` column, 42703 silently swallowed), pharmacy dispense label. ER→IPD order carry-over verified already implemented (`carryActiveErOrdersToAdmission`). |
| A3 downtime mode | ✅ | `c6713db7` | Scheduled (15 min) per-ward printable packs: census, unified allergies, code status, 12 h MAR due-list, active orders, vitals+NEWS2. Migration 273; routes `/api/v1/downtime/*`; `docs/DOWNTIME_PROCEDURE.md`. Migration 274 repairs pre-existing drift (`staff_queries` model had no migration). |
| A5 load testing | ✅ | `a51c3f76` | k6 hospital-day profile + SLO thresholds (read p95<400 ms, write p95<800 ms, err<1%). Baseline run on prod-shaped hardware still owner-side. |
| A6 observability | ✅ | `a51c3f76` | PrometheusRule RED alerts (incl. clinical-route 5xx, stale downtime packs, CNPG backup freshness) + `docs/RUNBOOK_ONCALL.md`; Sentry samples clinical writes at 100%. |
| A4 DR | ✅ code-complete | `f1a1e22a` | Nightly CNPG `ScheduledBackup` (WAL-only archiving existed → PITR was unreplayable). `docs/DR_RESTORE_DRILL.md` (RPO ≤5 m, RTO ≤60 m). **First timed drill is owner-side and is the acceptance gate.** |
| A7+A8 security | ✅ checklist | `f1a1e22a` | `docs/SECURITY_HARDENING_CHECKLIST.md` — rotation order, purge list, image-signature verification gap, pen-test scope, DPDP review. Execution is owner-side. |
| A1 suite/journeys | ◐ partial | (this commit) | Fixed fresh regression: phone-mode gate (`rejectMobileClinicalWrite`, commit `84d882ca`) 403'd every harness token (`DEVICE_TYPE_MISSING`) — investigation-deep 18 failures → 19/19 green after `generateTestToken` stamps `deviceType: 'desktop'`. Full-suite status: see below. The 11 swarm journeys proper still need the swarm harness re-armed (`start-loop-codex.sh`, dalekdefender) — out of session scope. |

### Environment notes

- **pgvector restored** into `C:\Program Files\PostgreSQL\17` from
  `D:\Dev\Tools\pgvector-windows\vector.v0.8.2-pg17` (a PG reinstall had
  wiped it; tenant deletes cascading into vector tables failed with 58P01).
- `qa-cluster-up.mjs` now provisions the three `rls_*` test roles +
  `qa_writer` memberships idempotently.
- **Never run git from the Cowork sandbox against this repo** — the
  Windows-mount filesystem corrupts `.git/index` (recovered via host-side
  index rebuild; fsck clean). All git on the host.
- QA DB is long-lived and predates the current `000_baseline.sql` — do NOT
  `prisma db pull` from it (produces false deletions). Regenerate schema
  from a fresh DB per `apps/backend/CLAUDE.md`.

### Owner-side actions queued (cannot be done from the repo)

1. Run the first DR restore drill (`docs/DR_RESTORE_DRILL.md`) — A4 gate.
2. Execute the secret rotation checklist — A7 gate.
3. Commission the pen test — A8 gate.
4. k6 baseline against prod-shaped hardware — A5 gate.
5. Downtime drill on one ward — A3 gate.
6. Re-arm the QA swarm for the 11 journeys — A1 completion.
7. Merge `roadmap/pillar-a` → main after review.

## Next pillar

Pillar G is merged to main (`8d8d0ecc`; G3 landed; G4 Tier-H pairing
blocked until the owner reports F1 live with real data; G1/G2/G5–G8 are
owner-led ceremonies riding existing code). **D5 infection control is
done** on `roadmap/pillar-d-d5` (this session) — merge after review; the
D5 stashes are dropped. With D1–D7 complete, the code-side roadmap is
fully landed pending owner ceremonies: warehouse bring-up (F1 DEPLOY →
unblocks G4) and the standing A–D owner queues tracked in the session
entries above.
