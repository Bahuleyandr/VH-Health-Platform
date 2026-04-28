# Session handoff — 2026-04-26 evening + night

_Use this to bootstrap a fresh Claude session and pick up where we left off without re-reading the entire transcript._

## TL;DR

You were doing a sweeping polish + bug-fix pass on the **patient Flutter app + the backend it talks to**. Everything in the original [`AUDIT.md`](AUDIT.md) is now green on the backend side, including the investigation booking lifecycle GETs (queue/sla/detail) which were finished off in the night-session continuation. The audit doc is the canonical reference. The only remaining items are deferred (see **"What's deferred"** below).

You explicitly asked to **leave ABDM alone** for now (it needs gov-API credentials).

## Where the project is right now

### Patient app
- All 14 feature-grid tiles now use **hand-drawn SVG illustrations** (not Lucide icons). Icon circle uses a **saturated derived tint** in light mode so the white glyphs have real contrast against the otherwise-pastel backgrounds.
- Brightness-aware gradients across `FeatureGrid`, `StatsStrip`, `DashboardSection`, `QuickActionButton` — light mode is no longer washed-out.
- **Pull-to-refresh** on the dashboard (`RefreshIndicator` wrapping the scroll view; calls `_fetchAndStoreDashboard` + `_fetchSmartWidgetData` + `_pollAppointments` in parallel).
- **Streak card hides** in the `StatsStrip` when `streakDays` is null/0 (instead of rendering a confusing "0 days").
- **Daily Check-In modal** only pops once per app session (in-memory `_checkInPromptedThisSession` gate in `daily_checkin_sheet.dart`); no longer re-pops on every dashboard re-mount.
- Splash auto-dev-login takes `--dart-define=VH_DEV_PHONE=...` + `VH_DEV_NAME=...` so the same APK can target either Dev Patient (`+919999999999`) or Fresh Test User (`+919999999997`).

### Backend
- All 39 patient-app endpoints return 200.
- New-user signup flow works end-to-end (validator + dates + query-shim + login_form route + splash extra-passing all fixed across this session).
- HIPAA audit log writes succeed (migration 101).
- Investigation booking lifecycle works POST-side (confirm → dispatch → collected → processing all 200 against a real created booking). GET-side `getBookingQueue` had two issues — fixed in this session: missing `sla_confirm_target` column (migration 105) + Phase-0.5 anti-pattern `params` not spread (line 190 in `bookingController.js`).
- BigInt JSON serialization polyfill at app boot — every BIGSERIAL id encoded safely.

## What's deferred

### Investigation booking lifecycle — backend AND staff UI both verified
Backend fully green and the staff Flutter `lab_bookings_screen` was visually re-verified at the end of the night session against a real PROCESSING booking. Final state:

| Endpoint | Method | Status |
|---|---|---|
| `/investigations/bookings/queue` | GET | ✅ 200 + ✅ rendered correctly in staff app (Active tab shows the row, mins_since_booked formatted as "2.0h ago"). Backend bug found during visual verify: numeric `mins_since_booked` was serialized as a JSON string by Prisma's Decimal handling — fixed with `::float8` cast. |
| `/investigations/bookings/sla` | GET | ✅ 200 (`::date` casts on 4 BETWEEN clauses). No screen consumer — orphan API method exposed for future admin dashboard. |
| `/investigations/bookings/:id` | GET | ✅ 200 (history sub-query columns fixed: `from_status, to_status, changed_by_role`). No screen consumer — the `lab_bookings_screen` shows a card view with action buttons; there is no detail-page navigation by design. |
| `/investigations/bookings/:id/confirm` | POST | ✅ 200 backend; not visually walked through every state transition |
| `/investigations/bookings/:id/dispatch` | POST | ✅ 200 |
| `/investigations/bookings/:id/collected` | POST | ✅ 200 |
| `/investigations/bookings/:id/processing` | POST | ✅ 200 |
| `/investigations/bookings/:id/result` | POST (multipart) | Untested — needs a real file upload to verify R2 not blocking |

**Staff seed user used:** `EMP-1001` / `test1234` (Nurse Arya, NURSING_STAFF → maps to `StaffRole.nurse` which sees the Lab Bookings tile). Password was bcrypt-hashed and set directly via `UPDATE users SET encrypted_password = ...` because the existing seed scripts only set up patient + doctor data, not staff passwords.

**Truly remaining for the booking lifecycle:** nothing blocking — file persistence now works in dev via the local-disk fallback (see "Local-disk R2 fallback" below). For prod, set `CF_R2_*` env vars and the same code path uses real Cloudflare R2.

**State-transition walkthrough (DONE 2026-04-26 night):** created booking #2 as the patient, then drove it through the entire lifecycle from the staff app: BOOKED → tap Confirm → CONFIRMED → tap Dispatch Collector → DISPATCHED → tap Mark Collected → COLLECTED → tap Start Processing → PROCESSING. All 4 POSTs (confirm/dispatch/collected/processing) returned 200 with `Role: NURSING_STAFF`. The screen re-fetched after each transition and re-bucketed the row into the appropriate tab.

### Dev-environment .NET fix (separate from app)
- User had a recurring "`Microsoft.NETCore.App` 8.0.0 not installed" dialog from `AacAmbientLighting.exe` (ASUS Aura).
- Root cause: user-level `DOTNET_ROOT` env var pointed to `D:\Dev\Tools\dotnet` (.NET 9 only). The `.exe` apphost looked there first and never fell through to `C:\Program Files\dotnet\` (which has 8.0.26).
- **Fix applied at registry:** `[Environment]::SetEnvironmentVariable('DOTNET_ROOT', $null, 'User')`.
- **Caveat:** the `LightingService` Windows service (which auto-spawns `AacAmbientLighting.exe`) inherited the stale env from boot-time SCM. **A reboot is needed to flush this through.** User was advised but may not have rebooted yet.

### Items intentionally deferred
- **ABDM** — needs gov-API credentials. User said leave it alone.
- **Per-feature empty-state illustrations** elsewhere in the app (lists in Notifications, Records, etc.) — would benefit from the same SVG treatment. Not yet attempted.
- **`/notifications/:phone` deprecation** — backend logs a `DEPRECATED` warn per call from the patient app's `NotificationProvider`. Migration to `/notifications/my` would silence it.

## Key files added/touched this session

### Migrations (all applied to dev DB)
| File | Purpose |
|---|---|
| `apps/backend/src/migrations/097_prescriptions_wellness_columns.sql` | Adds `duration_days` + `issued_at` to `prescriptions` (gamification needed them) |
| `apps/backend/src/migrations/098_investigation_booking_schema.sql` | `investigation_test_catalog` + `investigation_bookings` (43 cols, with auto-gen `INV-yyyymmdd-NNNNN` booking number trigger) + `investigation_booking_history` |
| `apps/backend/src/migrations/099_records_and_documents.sql` | `appointment_documents` + `patient_records` |
| `apps/backend/src/migrations/100_family_members.sql` | `family_members` (uuid FK to `users.uid`) |
| `apps/backend/src/migrations/101_audit_canary_alerts.sql` | `hipaa_access_log` (varchar patient_id), `canary_checks`, `clinical_alerts.acknowledged_at` |
| `apps/backend/src/migrations/102_seed_investigation_test_catalog.sql` | Seed: 36 tests across 8 categories |
| `apps/backend/src/migrations/103_users_profile_completed_at.sql` | Adds the column the complete-profile endpoint was writing to |
| `apps/backend/src/migrations/104_scheduled_notifications.sql` | The cron-job table that didn't exist |
| `apps/backend/src/migrations/105_investigation_bookings_sla_confirm.sql` | `sla_confirm_target` column + trigger to default it |
| `apps/backend/src/migrations/106_appointment_status_history.sql` | `appointment_status_history` table — was referenced by 6 raw SQL queries in 2 controllers (confirm/cancel/no-show/complete/walk-in/getHistory) but had no migration; staff appointment workflow 500'd as a result. Mirrors `investigation_booking_history` shape. |

### Backend code touched
- `bin/www.js` — BigInt.prototype.toJSON polyfill at boot
- `middleware/identityValidator.js` — accepts E.164 + bare 10-digit phones, normalises into req.params/query
- `services/user/userService.js` — `getUserById` 3-way: numeric id, E.164 phone, OR uuid
- `services/auth/firebaseAuthService.js` — `query()` shim returns rows array (not `{rows,rowCount}`); 5 `.rows[0]` callers switched to `[0]`; complete-profile UPDATE uses `::date` casts
- `validators/auth/authValidator.js` — accepts E.164 phones; null/empty optional fields skip validation
- `controllers/auth/firebaseAuthController.js` — (no direct changes)
- `controllers/appointment/appointmentLegacyController.js` — `::uuid` cast + 200-on-empty
- `controllers/appointment/appointmentDocumentController.js` — per-query 42P01 graceful fallback
- `controllers/appointment/appointmentWorkflowController.js` — `parseInt(doctor_id, 10)` upfront
- `controllers/health/patientHealthController.js` — IDOR check accepts both id + uid; resolves int → uid before vitals query
- `controllers/investigation/bookingController.js` — `parseInt(req.params.id, 10)` at every lifecycle entry point; spread `...params` for queue; `$1::date`/`$2::date` casts on the 4 SLA-dashboard BETWEEN clauses; history sub-query in `getBookingDetail` now selects `from_status, to_status, changed_by_role` (was selecting non-existent `status`); queue `mins_since_booked` cast to `::float8` so JSON serializes it as a number — Prisma was returning Postgres `numeric` as a JSON string, which crashed the staff app's `as num?` cast
- `controllers/appointment/appointmentWorkflowController.js` — `getAppointmentHistory` now `parseInt(req.params.id, 10)` (was binding string against integer `appointment_id`) and the silent `catch (_err)` is now `logger.error(...)` so future errors surface
- **NEW** `controllers/upload/uploadController.js` + `routes/upload/uploadRoutes.js` — implements `GET /api/v1/upload/by-key/*splat` (file lookup by R2 key, returns `{quarantined, storage_url, ...}` matching the patient app's `your_health_screen.dart:200` consumer) and `POST /api/v1/upload` (multipart, returns `{storageKey, storage_url}` matching `investigations_screen.dart:172`). Mounted in app.js at line ~420 with `patientRateLimiter`. Uses path-to-regexp v8 named-wildcard syntax (`*splat` not `*`). Authorization: file owner OR staff role.
- `services/auth/staffAuthService.js` — `logActivity` SQL now binds `$1::uuid` for `admin_uid` and `$4::jsonb` for `details`; without these casts every staff login was logging "Failed to log activity: column \"admin_uid\" is of type uuid but expression is of type text" and silently dropping the audit row. Also added two missing static methods: `getTodayAttendance(staffUid)` (was being called from `staffAuthController.js:285` but never defined — `/auth/staff/attendance/today` 500'd on every staff dashboard load) and `getAttendanceHistory(staffUid, opts)` (called from `staffAuthController.js:298`, same root cause — without it the staff app would log in successfully, hit `/auth/staff/attendance/history` on dashboard load, get a 500, retry twice, and the Flutter exception would background/kill the app — looked exactly like "the Sign In button isn't working" because the user never saw a stable dashboard).
- `apps/staff/lib/features/auth/screens/login_screen.dart` — login UX + session-timeout fix:
  - **EMP- prefix**: `EMP-` is now a non-editable Material `prefixText` on the Employee ID field; users only type the digits (e.g. `1001`) and the submit handler reassembles `EMP-1001` before sending. `keyboardType: TextInputType.number` + `FilteringTextInputFormatter.digitsOnly` + `LengthLimitingTextInputFormatter(6)` enforce digit-only input. `_loadSavedCredentials` strips the `EMP-` prefix when restoring "Remember Employee ID" so the field doesn't display `EMP-EMP-1001`. Constant lives at file scope as `_empIdPrefix`.
  - **Session-timeout re-login fix**: `_submit()` now calls `context.read<SessionTimeoutProvider>().resetSession()` immediately before `context.go('/dashboard')`. Without this, when a previous session timed out (`_expired = true` + `ApiConfig.clearAll()` wipes the JWT), the next login would save a fresh JWT but the router's redirect guard would still see `isSessionExpired == true` and bounce the user right back to `/login` — looked like "Sign In button isn't working" but was actually a navigate→bounce→navigate→bounce cycle that GoRouter eventually gave up on. Resetting the session synchronously before the navigation makes the very first redirect see a fresh session.
  - Build needs `--dart-define=VH_BASE_URL=http://10.0.2.2:5000/api/v1 --dart-define=VH_API_KEY=...` for emulator dev (otherwise hits `api.vhhealth.app`).
- `utils/notifications/InvestigationNotificationJob.js` — INSERT into `notifications` now sets `updated_at = NOW()` and `user_id = row.user_id || null`. The previous INSERT omitted `updated_at` (a NOT NULL column with no default) so every cron tick failed silently with "null value in column updated_at violates not-null constraint" and the in-app notification row was never written, even though the SMS/push fired.

### Local-disk R2 fallback (2026-04-27)

`utils/r2Storage.js` now has two backends sharing the same public surface (`uploadFileToR2`, `getFileFromR2`, `deleteObject`, `listObjectsV2`, `copyObject`, `getSignedFileUrl`):

- **Cloudflare R2** when `CF_ACCOUNT_ID + CF_R2_BUCKET + CF_R2_URL + CF_R2_ACCESS_KEY_ID + CF_R2_SECRET_ACCESS_KEY` are all set (production)
- **Local disk** otherwise — files land under `apps/backend/storage/local-r2/<key>` (override with `STORAGE_LOCAL_DIR`)

`getSignedFileUrl` in local mode returns a backend URL with an HMAC-signed token — semantics match R2 signed URLs (short-lived, downloadable without JWT, can't be forged). The token is `base64url(HMAC_SHA256(JWT_SECRET, key|expiryMs)).<expiryMs>` and is verified by `routes/storage/storageRoutes.js` (mounted at `/api/v1/storage` BEFORE both `validateApiKey` and `jwtAuth` so plain-HTTP downloads work). Public base URL defaults to `http://10.0.2.2:5000` for the Android emulator; override with `STORAGE_PUBLIC_BASE_URL`.

End-to-end verified: POST `/upload` writes the file to disk + persists `file_metadata` row → GET `/upload/by-key/<key>` returns a signed URL → plain `curl <url>` (no auth headers) returns 200 + bytes byte-identical to the original PDF. Tampered + missing tokens both return 403.

The `bookingController` and `appointmentDocumentController` signed-URL calls also go through this path now — the patient app's slip-photo and result-file downloads work in dev without R2 credentials. Production behaviour is unchanged: same code path, R2 backend dispatches to Cloudflare directly.

Also fixed: `controllers/upload/uploadController.js` `INSERT INTO file_metadata` was missing `updated_at` (NOT NULL column without default) — added `updated_at = NOW()`. Same pattern as the InvestigationNotificationJob fix earlier.

### `clinical_ai_corpus` is intentional (not a bug)

The audit flagged `clinical_ai_corpus` as missing from the dev DB. It IS missing, but [migration 015](apps/backend/src/migrations/015_rag_corpus.sql) is gracefully designed: it only creates the table when the `pgvector` Postgres extension is available, and the runtime detects the missing table and returns empty retrievals + a `RAG_UNAVAILABLE` safety flag. To enable RAG locally, install pgvector (`brew install pgvector` / Docker `pgvector/pgvector:pg17`) then re-run migration 015. No code change needed.

### Dev-data fix (2026-04-27, surfaced during multi-role verification)

The seed staff users had role strings that don't match the canonical names the rest of the codebase uses:

| Staff | Was | Now (renamed in DB) |
|---|---|---|
| EMP-1002 (Pharmacist Bala) | `PHARMACIST` | `PHARMACY_STAFF` |
| EMP-1003 (LabTech Chitra)  | `LAB_TECH`   | `LAB_STAFF`     |

Why it mattered: the staff Flutter app's `StaffRole.fromString` matches DB role strings against the enum values (`pharmacy('PHARMACY_STAFF')`, `lab('LAB_STAFF')`) and falls back to `general` on no match. So a Pharmacist would log in and see the **general** feature set (Housekeeping, My Tasks, Appt Queue) instead of the **pharmacy** set (Pharmacy Orders); same for Lab Tech. Backend `requireRole(...)` chains across `app.js` also expect `PHARMACY_STAFF` / `LAB_STAFF` — explaining why my earlier Upload Result POST as `LAB_TECH` got 403 (it hit `requireRole('...', 'LAB_STAFF', ...)` and didn't match). Also renamed the employee IDs to the hyphenated form (`EMP1002` → `EMP-1002`, `EMP1003` → `EMP-1003`) because the staff app's login validator regex requires the hyphen format that `EMP-1001` already used.

End-to-end verified after the rename: Pharmacist login → sees "Pharmacy" badge + Orders bottom tab + Pharmacy tile; Lab Tech login → sees "Lab" badge (Investigations tab) + Lab Bookings/Lab Results/Upload Results tiles + can fetch the booking queue (200 from `Dart/3.11` with `Role: LAB_STAFF`).
- `controllers/investigation/investigationController.js` — `::uuid` cast; JOIN-resolved patient_name/doctor_name; catalog graceful fallback
- `services/record/recordService.js` — `${uid}::uuid` cast in template SQL
- `routes/user/familyRoutes.js` — `::uuid` casts, `id::int AS id`, `42P01` graceful fallback
- `utils/notifications/appointmentReminderJob.js` — template literal in error log so winston shows the message
- `utils/hipaaAudit.js` — `patient_id` no longer cast as uuid (column is varchar now)

### Patient Flutter touched
- New: `dashboard_header.dart`, `feature_grid.dart` (with brightness-aware tints + saturated derived tint), `hero_snapshot_row.dart`, `stats_strip.dart` (streak card hidden when 0), `dashboard_section.dart`, `stagger_entry.dart`
- New: `assets/images/features/*.svg` × 14 (your-health, appointments, records, pharmacy, investigations, ask-a-doubt, trivia, departments, about-us, step-challenge, vitals, refills, family, health-points)
- Modified: `splash_screen.dart` (VH_DEV_PHONE/VH_DEV_NAME defines, fades, auto-advance, profile-setup phone passing), `app_router.dart` (fade transitions), `dashboard_screen.dart` (RefreshIndicator wrap, _refreshAll, all _features now have svgAsset), `your_health_screen.dart` (regular Scaffold for tabbed body), `notifications_screen.dart` (FeatureScreenScaffold scrollable: false), `feature_screen_scaffold.dart` (scrollable: false default), `quick_action_button.dart` (brightness-aware), `daily_checkin_sheet.dart` (one-per-session gate), `logout_button.dart` (public confirmAndLogout), `connectivity_service.dart` (probe host fix), `main.dart` (unawaited _syncReminders), `login_form.dart` (route name + extra phone)
- `apps/patient/pubspec.yaml` — added `flutter_svg: ^2.0.10+1` + `assets/images/features/` to assets

### Other artefacts
- `apps/backend/scripts/seed-fresh-test-user.sql` — populates Fresh Test User (id 1734, +919999999997) with appointments, prescriptions, e_prescriptions, pharmacy_orders, investigations, vitals, allergies, family, reminders, notifications, gamification ledger
- `apps/backend/scripts/seed-test-staff-accounts.mjs` — idempotent seed for one staff account per `StaffRole` enum value (8 roles). All passwords are `test1234`. Re-run any time to reset.
- `AUDIT.md` — kept current, has a "2026-04-26 evening" section for the diff
- `SESSION_HANDOFF.md` — this file

### Test accounts (after running `node --import dotenv/config scripts/seed-test-staff-accounts.mjs`)

All staff log in via `POST /api/v1/auth/staff/login` with `{ employeeId, password: "test1234" }`. The staff app's login form now shows `EMP-` as a non-editable prefix on the Employee ID field — users type only the digits (e.g. `1001`), the submit handler reassembles `EMP-1001` before sending. The full ID is still `EMP-NNNN` everywhere on the wire.

| Employee ID | Role           | StaffRole enum     | Notes |
|-------------|---------------|---------------------|-------|
| EMP-1001    | NURSING_STAFF | `nurse`             | Sees Lab Bookings, Patient Records, Vitals, etc. — most-clinical view |
| EMP-1002    | PHARMACY_STAFF| `pharmacy`          | Pharmacy Orders tile, Orders bottom tab |
| EMP-1003    | LAB_STAFF     | `lab`               | Lab Bookings + Lab Results + Upload Results, Investigations bottom tab |
| EMP-1004    | DOCTOR        | `doctor`            | Doctor-scoped feature set |
| EMP-1005    | HR_STAFF      | `hr`                | HR dashboard, Staff Management |
| EMP-1006    | ADMIN         | `admin`             | Broad feature set incl. clinical + admin |
| EMP-1007    | SUPER_ADMIN   | `superAdmin`        | Same as admin |
| EMP-1008    | GENERAL_STAFF | `general`           | Fallback / minimum-role view (Housekeeping, My Tasks, Appt Queue) |

Patient testing:
- `POST /api/v1/auth/dev/patient-login` with `{ phone: "+919999999997" }` → Fresh Test User (seeded with appointments/prescriptions/etc. via `seed-fresh-test-user.sql`)

## How to resume

### Infra restart (if needed in fresh session)
```bash
# Postgres
"C:/Program Files/PostgreSQL/17/bin/pg_ctl" -D "D:/Dev/Tools/pgdata-vhhealth" -l "D:/Dev/Tools/pgdata-vhhealth/logfile" -o "-p 5433" start

# Backend (run in background)
cd "D:/Dev/Projects/VH Health/VH-Health-Platform/apps/backend"
node --import dotenv/config src/bin/www.js

# Emulator
"C:/Users/subas/AppData/Local/Android/Sdk/emulator/emulator.exe" -avd vh-pixel -no-boot-anim
```

### Building + running the patient app
```bash
cd "D:/Dev/Projects/VH Health/VH-Health-Platform/apps/patient"

flutter build apk --debug \
  --dart-define=VH_BASE_URL=http://10.0.2.2:5000/api/v1 \
  --dart-define=VH_API_KEY="L+Kj8VeNSvI6M9CM3GGfKZfHHkV/uugZ0WuOLQiiPOw=" \
  --dart-define=VH_AUTO_DEV_LOGIN=true \
  --dart-define=VH_DEV_PHONE=+919999999997 \
  --dart-define=VH_DEV_NAME="Fresh Test User"

adb -s emulator-5554 install -r build/app/outputs/flutter-apk/app-debug.apk
adb -s emulator-5554 shell am force-stop com.vh.vhhealth
adb -s emulator-5554 shell am start -n com.vh.vhhealth/com.vh.vhhealth.MainActivity
```

### Re-seed Fresh Test User data any time
```bash
"C:/Program Files/PostgreSQL/17/bin/psql" -h localhost -p 5433 -U vhhealth -d vhhealth \
  -f "D:/Dev/Projects/VH Health/VH-Health-Platform/apps/backend/scripts/seed-fresh-test-user.sql"
```
(Idempotent — deletes prior demo rows for this user before re-inserting.)

### Patient JWT for endpoint testing
```bash
curl -s -X POST http://localhost:5000/api/v1/auth/dev/patient-login \
  -H "Content-Type: application/json" \
  -H "x-api-key: L+Kj8VeNSvI6M9CM3GGfKZfHHkV/uugZ0WuOLQiiPOw=" \
  -d '{"phone":"+919999999997"}' \
  | python -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])"
```

## Picking up the booking lifecycle work — DONE 2026-04-26 night

All 3 GETs that were open at the end of the evening session are now 200. The patient endpoint sweep is complete; backend-side, the booking lifecycle is fully wired (queue + sla + detail GETs return real data including the 5-row history audit trail for booking #1).

**Next concrete step (separate task):** visual verification of the staff Flutter app lab-bookings flow against these endpoints. Will need a staff seed user — see `apps/staff/CLAUDE.md` for credentials approach.

## Final state at session end

The backend process (task `bv85cexm4`) was reported "failed exit 1" right at session close — this was the task wrapper exiting, **not** a backend crash. Last log lines show normal traffic + a healthy `kpi.snapshot` tick at 22:03:30 with 200s on every probed endpoint. **Just restart it cleanly** with the command in the "Infra restart" section above; nothing to debug there.

The `bookingController.js` was also auto-formatted by a linter at session close — the changes are intentional, don't revert.

## What NOT to touch
- ABDM (gated behind unset env vars; user said leave it).
- The 40 clinical-AI services under `apps/backend/src/services/ai/` — explicit carve-out from the original Phase-0.5 conventions.
- Migration 075 (RLS policies) — deliberately permissive when GUC unset.
- `apps/backend/migrations/` legacy tree — only `src/migrations/` is authoritative.
