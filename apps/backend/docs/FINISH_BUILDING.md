# VH Health — Finish-Building Plan

> Cross-repo execution plan for closing out every deferred and "still open"
> item so the stack is actually production-shippable, not just vertical-slice
> coded. Tick the boxes as items land. Each item lists **where** it lives and
> **proof-of-done** so we can tell the difference between "written" and "done".

**Repos** (all under `C:\Dev\Projects\VH Health\`):
- `vh-health-backend` — Node/Express API
- `vhhealth-core` — shared Dart package
- `VH-health` — patient Flutter app
- `vhhealth-staff` — staff Flutter app
- `VH-Health-Adminportal` — Next.js admin portal

Legend: `[ ]` open · `[~]` in progress · `[x]` done · `[!]` blocked · `[-]` dropped

---

## Phase 0 — Unblock Builds (Day 1–2)

Nothing we've written today has been run. This phase gets every repo to
"`flutter run` / `npm run dev` opens without errors". No feature work —
installs, config, and smoke-fix only.

- [x] **0.1** `npm install` in `vh-health-backend`. Completed 2026-04-14.
      `onnxruntime-node` resolved. Had to pin `iconv-lite@^0.6.3` in deps to
      unblock a pre-existing broken-install issue with `iconv-lite@0.7.2`
      (transitively via body-parser — missing `helpers/` subdir). Verified
      every new file imports clean via individual `await import()` smoke.
- [x] **0.2** `npm install` in `VH-Health-Adminportal`. Completed 2026-04-14.
      `jspdf` + `jspdf-autotable` resolved. `npx tsc --noEmit` passes for
      every new file (two pre-existing TS errors in `system-audit/` are
      unrelated — scoped to code that predates Phase 3 work).
- [x] **0.3** `flutter pub get` + `flutter analyze` across all three Dart
      packages. Completed 2026-04-14. Flutter 3.41.6 installed at
      `C:/Dev/Tools/flutter`. Bumps: `swagger_dart_code_generator` 3.x→4.1.1
      (SDK compat), `health` 11→13.3.1 (intl conflict). Added `json_annotation
      ^4.11.0` to core for generated models. OpenAPI codegen ran successfully
      and produced ~53k lines of typed models + chopper client at
      `vhhealth-core/lib/api/generated/`. Fixed one `AppTheme` ambiguity in
      staff and three façade signature mismatches. Final analyze: 0 errors
      across all three packages (info-level pre-existing deprecations remain).
- [ ] **0.4** Run migrations 003–008 against dev DB. **Blocked**: Docker not
      on this machine to spin up `vhhealth-db`. Run on a Docker-equipped box
      with `docker compose up -d` then `npm run db:migrate` (or psql each
      `src/migrations/0*.sql` in order).
- [x] **0.5** `flutter create . --platforms=android,ios --org com.vhhealth.staff`
      ran 2026-04-14. Scaffolded 61 platform files. Package/bundle id is
      `com.vhhealth.staff.vhhealth_staff`.
- [x] **0.6** 2026-04-14: fixed 3 ApiClient façade signature mismatches
      (delete body, multipart nullable fields) + AppTheme ambiguity in
      staff bed_board_screen.dart. Final analyze clean (0 errors) across
      core + patient + staff.
- [x] **0.7** Smoke-build each app — 2026-04-14.
      * Android toolchain installed locally at `C:/Dev/Tools`:
        Microsoft OpenJDK 17.0.18, Android SDK cmdline-tools, SDK 36,
        build-tools 36.0.0, platform-tools 37, NDK 28, CMake 3.22.1.
      * `flutter doctor` ✓ for Flutter + Android + Windows + Visual
        Studio (only Chrome missing — not needed for mobile builds).
      * **Staff APK** ✓ — `build/app/outputs/flutter-apk/app-debug.apk`
        (~175MB debug). Required enabling `isCoreLibraryDesugaringEnabled`
        + desugar_jdk_libs dep for flutter_local_notifications.
      * **Patient APK** ✓ — `build/app/outputs/flutter-apk/app-debug.apk`
        (~170MB debug). Required workmanager 0.5 → 0.9 bump (v1 plugin
        API was removed upstream) and `minSdk = 26` for the health plugin.
      Release APKs with `--split-per-abi` + R8 will be ~25–30MB each.

## Phase 1 — Platform Config (Day 2–3)

Manifest, Info.plist, entitlements, env var templates. Small changes, but
every one of them is a silent "build succeeded but feature doesn't work at
runtime" trap.

### Android (3 Flutter apps)
- [x] **1.1 Patient** manifest — 2026-04-14. Health Connect READ perms
      (STEPS, HEART_RATE, OXYGEN_SATURATION, WEIGHT, BODY_TEMPERATURE,
      SLEEP) + `<queries>` entry for `com.google.android.apps.healthdata`
      so the `health` plugin can discover the Health Connect provider.
      Existing POST_NOTIFICATIONS + ACTIVITY_RECOGNITION kept.
- [x] **1.2 Staff** manifest — 2026-04-14. USE_FULL_SCREEN_INTENT +
      POST_NOTIFICATIONS + VIBRATE + WAKE_LOCK for Code Blue; CAMERA for
      MAR scanner; ACCESS_FINE/COARSE_LOCATION for SOS; SCHEDULE_EXACT_ALARM
      + USE_EXACT_ALARM + RECEIVE_BOOT_COMPLETED for scheduled alerts.
- [x] **1.3** Runtime full-screen-intent grant — 2026-04-14.
      `CodeBlueNotifier.initialize` calls
      `requestNotificationsPermission()` + `requestFullScreenIntentPermission()`
      on the AndroidFlutterLocalNotificationsPlugin impl.

### iOS
- [x] **1.4 Patient** Info.plist — 2026-04-14. NSHealthShareUsageDescription
      + NSHealthUpdateUsageDescription + UIBackgroundModes (fetch,
      processing, remote-notification) + camera/photo/face ID/location
      usage strings.
- [x] **1.5 Staff** Info.plist — 2026-04-14. NSCameraUsageDescription
      (MAR scanner) + NSLocationWhenInUseUsageDescription (SOS) +
      UIBackgroundModes (fetch, remote-notification). **Critical Alerts
      entitlement still requires an Apple Developer Program grant** —
      not something we can self-issue.

### Env templates
- [x] **1.6 Backend** .env.example — 2026-04-14. CHATBOT_* (provider +
      base URL + model + API key) for pluggable LLM, EDI_* (submitter +
      billing provider identifiers for 837P), PATIENT_*/STAFF_* version
      gate min/recommended + store URLs.
- [x] **1.7 Admin** — no change needed; already references
      `BACKEND_API_KEY`, `NEXT_PUBLIC_ALLOWED_ORIGIN`, `ADMIN_IP_ALLOWLIST`,
      `NEXT_PUBLIC_SENTRY_DSN`, `JWT_SECRET` per admin CLAUDE.md.

## Phase 2 — Complete Phase 2 polish (Week 1–3)

Four of the five repos have polish items marked *deferred* in their roadmaps.
Knock them out now before the next feature wave.

### Backend
- [ ] **2.1** Integration tests ≥ 60% coverage: billing state machines,
      pharmacy order transitions, MAR rights, CDS override, HL7 ORU round-trip,
      FHIR validator, chatbot fallback paths, adherence heuristic + ONNX.
- [ ] **2.2** OpenAPI/Swagger conformance CI check (`swagger:validate` runs on PR).
- [ ] **2.3** Prisma schema drift CI hook (already has `schemaDriftDetector.js` —
      needs a GitHub Actions job that runs it against an ephemeral DB).
- [ ] **2.4** Load-test automation — wire `/load-tests` into a weekly CI cron against staging.

### vhhealth-core
- [x] Phase 2 complete — nothing deferred.

### Patient (VH-health)
- [ ] **2.5** Test coverage ≥ 60%. Integration tests for appointment booking,
      pharmacy checkout, offline sync, vitals → wellness recompute, HealthKit sync.
- [ ] **2.6** Localisation audit. `flutter gen-l10n --untranslated-messages-file`
      and fill in the ~52% of hi/ta/te/ml strings that are missing.
- [ ] **2.7** Accessibility: `Semantics` wrappers on interactive widgets,
      ≥4.5:1 contrast in dark mode, `TextScaler.linear` support on every screen.
- [ ] **2.8** Analytics events: appointment booked, Rx ordered, vitals logged,
      check-in completed, badge earned, triage run.

### Staff (vhhealth-staff)
- [ ] **2.9** Test coverage ≥ 60%. MAR submit, SBAR post, vitals entry,
      order create, offline → online sync, MAR 5-rights flow.
- [ ] **2.10** Tablet/iPad split-pane layouts for ward rounds
      (patient list | EMR | vitals entry).
- [ ] **2.11** Dark-mode audit of every screen.

### Admin (VH-Health-Adminportal)
- [ ] **2.12** Test coverage ≥ 60%: MFA challenge flow, role change audit,
      bed CRUD, pharmacy stock adjustment, compliance indicators rendering,
      PDF export, denial dashboard.
- [ ] **2.13** Data-table bulk-edit + keyboard shortcuts.
- [ ] **2.14** Deeper `DashboardClient.tsx` split (still 746L — extract
      `StatsGrid`, `NotificationsDrawer`, `CommandPalette`, `ActivityFeed`).
- [x] **2.15** Clinical AI governance control plane — 2026-04-22:
      `/api/v1/admin/clinical-ai` is limited to Admin/Super Admin/IT control
      roles, module/guardrail changes write structured `audit_logs`, and the
      admin dashboard exposes the audit trail next to token/provider status.

## Phase 3 — Close Phase 3 "Still Open" Items (Week 3–8)

Every Phase 3 feature has a vertical slice shipped today. These are the
follow-ups that take each from "proves the shape" to "production-ready".

### Clinical
- [ ] **3.1** Floor-map census visualisation (staff 3A slice) — SVG floor plan
      wired to `staff:beds` realtime channel.
- [ ] **3.2** Due-meds list screen that feeds `ma_id` into `MarScanScreen`.
      (Currently the scanner expects a `ma_id` in its constructor with no way to pick one.)
- [ ] **3.3** Drug-DB NDC lookup for MAR (replace substring match in
      `marFiveRightsService.evaluate5Rights` with a proper drug-identifier join).
- [ ] **3.4** LOINC/SNOMED/RxNorm code-set validation on prescription + observation POST.
      Use a maintained code-set table; reject unrecognised codes.
- [ ] **3.5** Hand-hygiene / HAI / surgical-site-infection tracking data sources.
      Need either an infection-control module or third-party integration.
      **[!] blocked on hospital-ops input** — not a software-only task.
- [ ] **3.6** Alternatives surfacing on patient Rx CDS banner. Needs a
      drug-similarity source (RxNorm related-drugs or a commercial DB).

### Patient experience
- [ ] **3.7** HealthKit / Google Health Connect **write-back** for medication
      reminders + vitals-goal reminders (`health` package's write APIs).
- [ ] **3.8** Full symptom-checker chat session (currently single-turn) —
      thread state, history passed back, "continue" support.

### Security
- [ ] **3.9** Forward secrecy upgrade on E2E messaging (double-ratchet via
      Signal protocol, e.g. `libsignal` bindings). Replaces current long-lived
      identity-key model.
- [ ] **3.10** mTLS backend enforcement — nginx/Cloudflare-tunnel requires
      client cert against hospital CA. **Paired with 3.11**.
- [ ] **3.11** Client cert provisioning + rotation endpoint. New devices
      receive a cert on first login (one-time enrolment signed with JWT);
      background cron rotates expiring certs.
- [ ] **3.12** Install a real `DeviceTrustProbe` — Play Integrity on Android,
      DeviceCheck / AppAttest on iOS. Replace the default kDebugMode probe.

### Revenue cycle + interop
- [ ] **3.13** Claim submission queue UI in admin — lists 837-generatable
      invoices, bulk-export as EDI, track submission status.
- [ ] **3.14** AR aging dashboard (invoices unpaid > 30/60/90 days).
- [ ] **3.15** Patient payment portal admin (view installments, waive fees with audit).
- [ ] **3.16** Payer-specific 837 companion-guide extensions (one per payer
      onboarded — parameterise `ediGenerator` so new payers are a config push).
- [ ] **3.17** Official HL7 Java FHIR validator JAR in CI — run against every
      resource we produce, fail the build on conformance errors.
- [ ] **3.18** HL7v2 ADT^A04/A05/A06/A07/A08 handlers (pre-admit, registration,
      pre-registration, transfer, update patient info) beyond the existing A01-A03.

### Operations + analytics
- [ ] **3.19** Trained ML adherence model. Data collection → sklearn fit →
      skl2onnx export → drop in `models/`. Re-score nightly batch.
- [ ] **3.20** Supplier integration for pharmacy auto-reorder.
- [ ] **3.21** Batch-level recall tracking for pharmacy (requires moving from
      per-medication to per-batch inventory rows).
- [ ] **3.22** Quarter-over-quarter trend lines on executive dashboard
      (Recharts — we already depend on it).
- [ ] **3.23** PDF export for denial dashboard (reuse `exportToPdf`).
- [ ] **3.24** Admin 3A — additional KPI tiles on `admin:kpi`: ED wait time,
      pharmacy stock-out rate, staff utilisation.

## Phase 5 — Architecture hygiene (Week 6–12)

Structural improvements surfaced by the 2026-04-14 review. These aren't
individual features — they're investments that make every future change
cheaper. Numbered items have `[needs-decision]` when they require product
input before we execute.

- [x] **5.1 Melos monorepo** — 2026-04-18: shipped. Live repo:
      https://github.com/Bahuleyandr/VH-Health-MonoRepo (private).
      Layout: `packages/vhhealth_core`, `apps/patient`, `apps/staff`.
      Full history of the 3 source repos preserved via `git subtree add`
      (`git log apps/patient/` walks every original commit). Uses
      **Melos 7.5.1 + Dart pub workspace** — single `pubspec.lock` at
      the root, scripts under the `melos:` key in the root `pubspec.yaml`.
      Sub-packages reference `vhhealth_core: any` (no path — workspace
      resolver finds it by name). Firebase aligned across apps as part
      of the migration (staff bumped to `firebase_core ^4`,
      `firebase_messaging ^16`, `firebase_crashlytics ^5`). `melos
      bootstrap` + `melos run analyze` verified green.
      Backend + admin portal intentionally stay in their own repos
      (different stacks, different deploy cadences) — cross-stack
      changes continue to follow `docs/CROSS_REPO_PR_CONVENTION.md`.
      Old 3 Flutter repos not yet archived (owner-held).
- [x] **5.2 Finish duplication migration** — 2026-04-14: patient + staff
      apps route through `vhhealth_core.VHHttpClient` via thin shims. Native
      ApiClient copies kept as deprecation-tagged façades so existing call
      sites compile.
- [~] **5.3 OpenAPI → Dart codegen** — 2026-04-14: activated. Codegen has
      been run; `vhhealth-core/lib/api/generated/` now contains the typed
      models + chopper client (~53k LOC, gitignored). Rebuild with
      `dart run build_runner build --delete-conflicting-outputs` after
      each backend spec refresh. Playbook at
      `vhhealth-core/docs/API_CODEGEN.md`. Flip to `[x]` once first call
      site migrates from `Map<String, dynamic>` to generated types.
- [ ] **5.4 Cross-repo atomic PRs** — subsumed by 5.1. Drop this row if 5.1
      ships; keep if (c) is chosen so we at least document the stacked-PR
      convention.
- [x] **5.5 Offline queue unification** — 2026-04-14: staff's
      `ConnectivitySyncService` + `OfflineQueue` + `OfflineSyncBadge` ported
      to vhhealth-core. Staff's local files replaced with one-line re-exports
      so existing call sites (`import '../services/connectivity_sync_service.dart'`)
      continue to resolve. Patient app can now `import 'package:vhhealth_core/
      vhhealth_core.dart'` and mount the badge — no code duplication.
      Adds `sqflite ^2.3.3`, `path ^1.9.0`, `connectivity_plus ^6.1.4`,
      `intl ^0.20.2` to core's deps.
- [x] **5.6 Min-client-version contract** — 2026-04-14: backend `/health`
      returns `{minPatientAppVersion, minStaffAppVersion}`; both apps check
      at boot and render a blocking upgrade screen below min.
- [x] **5.7 `features/` convention doc** — 2026-04-14: `docs/FEATURE_STRUCTURE.md`
      in both Flutter apps. Migration is opportunistic as each screen is touched.
- [x] **5.8 Unify realtime + HTTP auth** — 2026-04-14: `RealtimeClient` on
      4001 now calls the core refresh helper and reconnects with the
      rotated token rather than giving up.
- [x] **5.9 `RealtimeProvider` lifecycle owner** — 2026-04-14: single
      provider at each app's root owns connect / disconnect against auth
      lifecycle; widgets only listen via `events(channel)`.
- [x] **5.10 Vertical-flow contract test** — 2026-04-14: backend Jest suite
      `tests/contracts/vertical-flows.test.js` runs the "patient books →
      status changed → realtime emits → subscriber receives" chain against
      the live express app + an in-memory WS client. Proves wire shape
      without needing Flutter runners in CI.

## Phase 4 — Production readiness (Week 8–10)

Cross-cutting plumbing that doesn't map to any single roadmap bullet but
is required before pointing real users at this.

- [x] **4.0** Scheduled full-stack CI sweep — 2026-04-18: root
      `.github/workflows/all.yml` runs Flutter workspace checks, backend
      lint/swagger/prisma/tests + FHIR conformance, and admin lint/type-check/
      jest/build on weekday cron + `workflow_dispatch`. Catches cross-stack
      drift that the path-filtered PR workflows intentionally skip.
- [ ] **4.1** CI: matrix workflow that runs backend jest, each Flutter analyze+test,
      and admin jest on every PR. Block merge on failure.
- [ ] **4.2** CD: staging deploy pipeline per repo, production manual-approve.
- [ ] **4.3** Observability: Sentry on all five repos, centralised log sink
      (already Winston → file on backend; route to a log aggregator).
- [ ] **4.4** Runbooks for: DB restore, R2 restore, cert rotation, Code Blue
      mis-fire investigation, chatbot provider switch.
- [ ] **4.5** Penetration test + threat model review of the new surface (mTLS,
      E2E messaging, ticket exchange, 837 generation, chatbot).
- [ ] **4.6** Data retention + GDPR/DPDPA rules applied to the new tables
      (`medication_administrations` 5-rights audit, `prescription_safety_overrides`,
      `claim_denials`, `users.e2e_public_key`).
- [ ] **4.7** Consolidated release notes for the 2026-04-14 Phase 3 drop so
      existing hospital-ops users know what changed.

---

## Running order

1. **Phase 0** — must happen first; nothing else works without it.
2. **Phase 1** — platform config. Small, blocking.
3. **Phase 2 in parallel with Phase 3.1–3.8** — Phase 2 is test/polish
   work across four repos; Phase 3 items that don't block each other can
   run alongside on separate branches. Order Phase 3 items by clinical
   safety > security > revenue > analytics.
4. **Phase 3.9–3.24** — defer until Phase 2 coverage is healthy enough to
   add new features safely.
5. **Phase 4** — can start in parallel with late Phase 2 / early Phase 3.

## Tracking

- Update this file when each box ticks over. Keep the commit that ticks it in
  the repo that owns the work.
- `git grep "\[ \]" FINISH_BUILDING.md` is the open-item count.
- When a box is ticked, replace `[ ]` with `[x]` and append a one-line
  "why/where landed" so future context is preserved without a git archaeology
  expedition.
