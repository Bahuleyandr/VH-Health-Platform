# CLAUDE.md — VHHealth Staff App

## Project Overview
Flutter mobile app for hospital staff. Handles attendance logging, leave management, appointment confirmations, investigation uploads, pharmacy order management, and staff profile.

## Tech Stack
- **Framework**: Flutter 3.8.1+, Dart (null-safe)
- **State**: Provider (ThemeNotifier)
- **Navigation**: GoRouter with auth redirect guard
- **HTTP**: `package:http`
- **Auth**: Employee ID + password/PIN → backend JWT
- **Storage**: flutter_secure_storage (JWT, staff data)
- **UI**: Material 3, professional blue/teal theme

## Repository Layout
```
lib/
  main.dart                          # Entry point, ThemeNotifier, MaterialApp.router
  core/
    config/api_config.dart           # Base URL, API key, JWT headers
    navigation/app_router.dart       # GoRouter routes + auth guard
    services/
      auth_service.dart              # JWT/staffId/role secure storage
      staff_api_service.dart         # ALL backend API calls
    theme/app_theme.dart             # Material 3 blue/teal theme
    widgets/
      staff_scaffold.dart            # Bottom nav scaffold wrapper
      sos_button.dart                # Emergency SOS FAB
  features/
    auth/
      screens/login_screen.dart      # Employee ID + password/PIN login
      services/login_service.dart    # Auth flow handler
    dashboard/screens/               # Home: check-in status, stats, feature grid
    attendance/screens/              # Check in/out button + history
    leave/screens/                   # Apply leave form + balance + history
    appointments/screens/            # Today's appointments, confirm/cancel
    investigations/screens/          # Upload investigation results
    pharmacy/screens/                # Confirm/update pharmacy orders
    profile/screens/                 # View/edit staff profile
    settings/screens/                # Theme toggle, notifications, logout
```

## Auth Flow
1. Staff enters Employee ID + password (or PIN)
2. App calls `POST /api/v1/auth/staff/login` with `{ employeeId, password }`
3. Backend returns `{ data: { accessToken, refreshToken, staff: { id, name, role, department, ... } } }`
4. JWT stored in flutter_secure_storage under key `staff_jwt`
5. All subsequent calls include `Authorization: Bearer <jwt>`
6. PIN login: `POST /api/v1/auth/staff/login-pin` with `{ employeeId, pin }`

## API Endpoints Used
| Feature | Endpoint | Method |
|---------|----------|--------|
| Login (password) | `/auth/staff/login` | POST |
| Login (PIN) | `/auth/staff/login-pin` | POST |
| Dashboard/HR | `/staff/hr/dashboard` | GET |
| Mark attendance | `/staff/attendance` | POST |
| Attendance history | `/staff/attendance/:staffId` | GET |
| Apply leave | `/staff/hr/leave/apply` | POST |
| Leave balance | `/staff/hr/leave-balance/:staffId` | GET |
| Upload investigation | `/staff/medical/investigations` | POST |
| Upload consultation | `/staff/medical/consultations` | POST |
| Update pharmacy order | `/staff/pharmacy/orders` | PUT |
| Staff profile | `/staff/:identifier` (GET), `/staff/:id` (PUT) | GET, PUT |
| Appointments list | `/appointments/list` | GET |

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
Depends on `vhhealth_core` (at `packages/vhhealth_core/`) via the root Dart pub workspace — `vhhealth_core: any` in this app's `pubspec.yaml` resolves to the local package. Shared code: ApiConfig, AuthService, HttpClient, Theme, SOS widget, offline queue, connectivity sync, version gate, crash reporter adapter.

## Sibling apps (same monorepo)

See the [root `CLAUDE.md`](../../CLAUDE.md) for the cross-stack layout. Other apps in the same repo:

- `apps/backend` — Node/Express API
- `apps/admin` — Next.js admin portal
- `apps/patient` — Flutter patient app
- `packages/vhhealth_core` — shared Dart package

The five separate source repos these were merged from are archived on GitHub as of 2026-04-18.

## Conventions
- All HTTP calls use `await ApiConfig.authenticatedHeaders()` for auth
- JWT stored under key `staff_jwt` (separate from patient app's `jwt` key)
- Backend response envelope: `{ success, data: {...} }` — unwrap `body['data']`
- Staff-specific theme: blue/teal primary (distinct from patient app's teal/green)
- Use descriptive SnackBars for success/error feedback
- GoRouter redirect guard: unauthenticated users → `/login`
- **Offline writes**: queue via `ConnectivitySyncService.instance.enqueue(...)` — **not** `OfflineQueue.enqueue` directly — so the sync badge stays accurate.
- `OfflineSyncBadge` is mounted in `StaffScaffold` app-bar actions; hidden when online + empty + no conflicts. Tap opens `SyncStatusSheet` with per-conflict Discard/Retry.
- UI reads sync state via `ListenableBuilder(listenable: ConnectivitySyncService.instance, ...)` — the service is a `ChangeNotifier`.


## Testing (added 2026-04-15)

`test/core/config/role_config_test.dart` (13 tests) locks in the
`StaffRole` enum + `RoleFeatures` per-role dispatch + bottom-nav
consistency. This is the canonical reference for which features each role
sees — change `role_config.dart` and these tests catch the regression.

Mock-heavy clinical-safety tests (MAR 5-rights, CDS allergy blocker, Code
Blue receive, offline queue drain, biometric login) are the highest-value
next batch. Plug-in-channel mocks (barcode scanner, `connectivity_plus`,
`local_auth`) are the missing scaffolding. See `test/README.md` for the
prioritised list.

## Future Directions

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the current roadmap and
[`../FINISH_BUILDING.md`](../FINISH_BUILDING.md) for the cross-repo
master plan (Phase 0.5 = current; ranked open items at the bottom).
