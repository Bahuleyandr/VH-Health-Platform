# CLAUDE.md — VHHealth Staff App

## Project Overview
Flutter mobile app for hospital staff — a full clinical EMR covering MAR/BCMA closed-loop medication administration, CPOE order composer, structured e-prescribing, IPD ward management, maternity, operating theatre, blood bank, clinical-AI decision support, beds/housekeeping, payroll self-service, and the traditional HR functions (attendance, leave, profile). As of the latest count, the app has 226 Dart source files across 41 feature modules.

## Tech Stack
- **Framework**: Flutter 3.8.1+, Dart (null-safe)
- **State**: Provider (`ThemeProvider`, `LocaleProvider`, `NotificationProvider`, `RealtimeProvider`, `WebSocketProvider`, `MessageUnreadProvider`, `ClinicalInboxProvider`, `SessionTimeoutProvider`)
- **Navigation**: GoRouter with auth redirect guard
- **HTTP**: shared hardened `VHHttpClient` through the Staff `ApiClient`
- **Auth**: Employee ID + password/PIN or tenant-enabled OIDC SSO → backend JWT
- **Storage**: flutter_secure_storage (JWT, staff data)
- **UI**: Material 3, professional blue/teal theme
- **Desktop**: Windows runner with 1100x700 minimum size, persistent desktop scrollbars/hover polish, bed-board split view, OS toasts for Code Blue/messages, and an MSIX release channel on `staff-v*` tags

## Repository Layout
```
lib/
  main.dart                          # Entry point, MultiProvider root, MaterialApp.router
  firebase_options.dart              # Firebase config
  core/
    config/api_config.dart           # Base URL, API key, JWT headers
    navigation/app_router.dart       # GoRouter routes + auth guard
    services/
      auth_service.dart              # JWT/staffId/role secure storage
      api_client.dart                # shared hardened transport facade
    theme/app_theme.dart             # Material 3 blue/teal theme
    widgets/
      staff_scaffold.dart            # Bottom nav scaffold wrapper
  features/                          # 41 feature modules (226 Dart files total)
    auth/                            # Employee ID + password/PIN login plus tenant-enabled OIDC SSO
    dashboard/                       # Home: check-in status, stats, feature grid
    attendance/                      # Check in/out + history
    leave/                           # Apply leave form + balance + history
    appointments/                    # Today's appointments, confirm/cancel
    investigations/                  # Upload investigation results
    pharmacy/                        # Confirm/update pharmacy orders (BCMA/MAR)
    profile/                         # View/edit staff profile
    settings/                        # Theme toggle, notifications, logout
    emr/                             # Clinical EMR: notes, vitals, diagnoses, MAR
    ipd/                             # IPD ward management + patient command board
    opd/                             # Outpatient workspace + OP Workspace
    nursing/                         # Nursing tasks, I/O charts, medication rounds
    doctor/                          # Doctor workflows, CPOE order composer
    beds/                            # Bed board, bed transfers, housekeeping
    housekeeping/                    # Housekeeping task management
    maternity/                       # Maternity / labour & delivery
    theatre/                         # Operating theatre scheduling + CSSD
    bloodbank/                       # Blood bank requests + transfusion
    radiology/                       # Radiology orders + PACS viewer link
    dietary/                         # Dietary orders + nutrition management
    referrals/                       # Internal/external referral workflows
    clinical_ai/                     # Clinical AI decision support panels
    diagnostics/                     # Lab/diagnostic order management
    schedule/                        # Staff scheduling + shift management
    messaging/                       # Secure staff messaging
    notifications/                   # Push notification centre
    hr/                              # HR admin (payroll, credentialing)
    payroll/                         # Live payroll self-service: payslips, queries, declarations, tax summary
    reports/                         # Clinical + operational reports
    safety/                          # Incident reporting, code blue
    about/                           # App version + build info
    splash/                          # Splash + version-gate screen
    phone/                           # Staff phone directory
    directory/                       # Staff directory
    audit/                           # Audit log viewer
    productivity/                    # Task management + to-do
    reception/                       # Reception + visitor management
    ward/                            # Ward round support
    cath_lab/                        # Catheterisation lab workflows
```

## Auth Flow
1. Staff enters Employee ID + password/PIN, or taps SSO when tenant discovery returns an active staff OIDC provider.
2. App calls `POST /api/v1/auth/staff/register-device` with `{ employeeId, password }`
3. SSO uses `GET /api/v1/auth/staff/sso/oidc/providers`, launches the backend `start` URL in the system browser, receives `vhhealthstaff://sso/oidc/callback`, then posts code/state to the backend callback broker.
4. Backend returns `{ data: { accessToken, refreshToken, staff: { id, name, role, department, ... } } }`
5. JWT stored in flutter_secure_storage under the shared `jwt` key (via core `AuthService.setTokens` + `ApiConfig.saveJwt`) used by the shared HTTP/realtime helpers.
6. All subsequent calls include `Authorization: Bearer <jwt>`
7. PIN login: `POST /api/v1/auth/staff/login-pin` with `{ employeeId, pin }`

## API Endpoints Used (representative — not exhaustive)
| Feature | Endpoint | Method |
|---------|----------|--------|
| Login (password) | `/auth/staff/register-device` | POST |
| Login (PIN) | `/auth/staff/login-pin` | POST |
| Staff SSO discovery | `/auth/staff/sso/oidc/providers` | GET |
| Staff SSO start | `/auth/staff/sso/oidc/:provider/start` | GET |
| Staff SSO callback exchange | `/auth/staff/sso/oidc/:provider/callback` | POST |
| Dashboard/HR | `/staff/hr/dashboard` | GET |
| Mark attendance | `/staff/attendance` | POST |
| Attendance history | `/staff/attendance/:staffId` | GET |
| Apply leave | `/staff/hr/leave/apply` | POST |
| Leave balance | `/staff/hr/leave-balance/:staffId` | GET |
| Payroll self-service | `/staff/hr/payroll/my-payslips`, `/staff/hr/payroll/queries`, `/staff/hr/payroll/investment-declarations`, `/staff/hr/payroll/tax-summary` | GET, POST |
| Upload investigation | `/staff/medical/investigations` | POST |
| Upload consultation | `/staff/medical/consultations` | POST |
| MAR/BCMA administration | `/staff/mar/*` | GET, POST |
| CPOE orders (structured) | `/staff/orders/*` | GET, POST |
| IPD/admission management | `/staff/admissions/*`, `/staff/ipd/*` | GET, POST, PUT |
| Bed management | `/staff/beds/*` | GET, POST, PUT |
| Theatre scheduling | `/staff/theatre/*` | GET, POST |
| Blood bank | `/staff/blood-bank/*` | GET, POST |
| Clinical AI panels | `/staff/clinical-ai/*` | GET, POST |
| Staff profile | `/staff/:identifier` (GET), `/staff/:id` (PUT) | GET, PUT |
| Appointments list | `/appointments/list` | GET |
| Appointment reschedule | `/appointments/:id/reschedule` | PATCH |
| Consent signatures | `/consent/:id/signatures` | POST |
| Patient registration | `/patients` | POST (JSON or multipart photo) |

## Running
Requires Flutter SDK:
```bash
flutter pub get
flutter run
```
To scaffold native project files (first time):
```bash
flutter create . --org com.vhhealth.staff
```

## Shared Core Package
Depends on `vhhealth_core` (at `packages/vhhealth_core/`) via the root Dart pub workspace — `vhhealth_core: any` in this app's `pubspec.yaml` resolves to the local package. Shared code the staff app consumes: ApiConfig, AuthService, HttpClient, Theme, offline queue, connectivity sync, crash reporter adapter. (Core's `SosButton` is a patient-app surface — the staff app has no SOS FAB.)

Front-office registration follows backend duplicate-review semantics: a 409
`PATIENT_DUPLICATE_REVIEW_REQUIRED` opens the review dialog, and create-anyway
must send an audited reason. Optional profile photos use multipart upload. NL-4
front-office strings live in `app_strings.dart` for en/hi/ta/te; keep new copy in
that map with the existing i18n guard.

## Sibling apps (same monorepo)

See the [root `CLAUDE.md`](../../CLAUDE.md) for the cross-stack layout. Other apps in the same repo:

- `apps/backend` — Node/Express API
- `apps/admin` — Next.js admin portal
- `apps/patient` — Flutter patient app
- `packages/vhhealth_core` — shared Dart package

The five separate source repos these were merged from are archived on GitHub as of 2026-04-18.

## Conventions
- All Staff HTTP calls use `ApiClient`; do not bypass the shared hardened transport with raw `package:http`
- JWT stored under the shared `jwt` key (core `AuthService`) — same key the patient app uses; the staff app does not use a separate `staff_jwt` key
- Backend response envelope: `{ success, data: {...} }` — unwrap `body['data']`
- Staff-specific theme: blue/teal primary (distinct from patient app's teal/green)
- Use descriptive SnackBars for success/error feedback
- GoRouter redirect guard: unauthenticated users → `/login`
- Windows desktop builds enforce an 1100x700 minimum window size and use `ConstrainedContent`/split-view patterns to keep workbench screens readable on wide monitors.
- Windows desktop notifications are wired behind the desktop platform gate; Code Blue and message toasts focus the window/deep-link when cheap.
- MSIX packaging is configured in `pubspec.yaml` (`display_name: VH Health Staff`, `identity_name: com.vhhealth.staff`) and the release workflow attaches unsigned/test-signed `.msix` artifacts on `staff-v*` tags.
- **Offline writes**: queue via `ConnectivitySyncService.instance.enqueue(...)` — **not** `OfflineQueue.enqueue` directly — so the sync badge stays accurate.
- `OfflineSyncBadge` is mounted in `StaffScaffold` app-bar actions; hidden when online + empty + no conflicts. Tap opens `SyncStatusSheet` with per-conflict Discard/Retry.
- UI reads sync state via `ListenableBuilder(listenable: ConnectivitySyncService.instance, ...)` — the service is a `ChangeNotifier`.

## Teleconsultation

NL-3 staff teleconsults stay inside ordinary OP doctor/department queues:
`visit_type = 'TELE'` rows may show teleconsult badges, but there is no separate
queue kind. Clinician media joins must use backend-minted
`/api/v1/teleconsult/*` tokens through the LiveKit staff room boundary; raw room
names and client-minted media grants are not allowed.

Teleconsult documentation deep-links back into the existing appointment-bound OP
note editor with OP-compatible params. Do not add teleconsult note types, patient
visible documentation surfaces, or recording affordances. Ending the consult only
closes media; appointment completion remains the existing clinical action.

## Dictation

Staff dictation is an editor-fill aid only. It must not submit, save, sign, or bypass any existing CDS, composition, signoff, offline queue, or double-submit guard. Current surfaces are OP doctor workspace note fields, clinical/ward progress-note editors, drug-chart draft/notes affordances, and vitals notes; each surface still relies on its existing save path after the clinician reviews inserted text.

Multi-section note editors use `DictationSectionRouter`, which recognizes English and Hindi section keywords for chief complaint, history, examination, diagnosis, plan, and advice. Unmatched leading text routes to the currently focused field. The review sheet shows every destination with editable text; Insert applies to controllers and Cancel discards the transcript.

Drug-chart structured dictation uses `DictatedOrderParser` with the chart's existing AppStrings-backed route, frequency, dose-slot, food, PRN, and enum vocabulary. Drug names are resolved through the existing catalog search path only when the top match clears the conservative confidence threshold; ambiguous names require a clinician pick from candidates and leave the name empty until selected. Filled fields show dictated provenance chips, and the raw transcript remains expandable. Duration is surfaced in notes because the current draft-row save path has no duration field.

Backend STT remains disabled by default. Operator setup uses `STT_PROVIDER=openai-compatible`, `STT_BASE_URL`, `STT_MODEL`, `STT_TIMEOUT_MS`, and optional `STT_LANGUAGE` / `STT_PROMPT` / `STT_API_KEY`; see `../../docs/SCRIPTS_INDEX.md` for the local faster-whisper smoke command.


## Testing (added 2026-04-15)

`test/core/config/role_config_test.dart` (13 tests) locks in the
`StaffRole` enum + `RoleFeatures` per-role dispatch + bottom-nav
consistency. This is the canonical reference for which features each role
sees — change `role_config.dart` and these tests catch the regression.

Mock-heavy clinical-safety tests (MAR 5-rights, CDS allergy blocker, Code
Blue receive, offline queue drain) are the highest-value next batch.
Plug-in-channel mocks for the barcode scanner and `connectivity_plus` are
the remaining scaffolding to add. Biometric login already has channel-mocked
coverage — `test/features/auth/services/biometric_quick_login_test.dart`
exercises `local_auth` (the dependency is live; do not remove it). See
`test/README.md` for the prioritised list.

## Future Directions

Use [`../../docs/ROADMAP.md`](../../docs/ROADMAP.md),
[`../../docs/RELEASE_READINESS.md`](../../docs/RELEASE_READINESS.md),
[`docs/LANGUAGE_HEALTH.md`](docs/LANGUAGE_HEALTH.md), and
[`docs/SCREEN_READER_TEST_PLAN.md`](docs/SCREEN_READER_TEST_PLAN.md) for
current staff-app priorities and gates. [`../../AUDIT.md`](../../AUDIT.md) and
[`../../SESSION_HANDOFF.md`](../../SESSION_HANDOFF.md) are historical snapshots;
verify current state before acting.
