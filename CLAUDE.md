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
`../vhhealth-core` contains shared code (ApiConfig, AuthService, HttpClient, Theme, SOS widget).
Currently this app has its own copies — can be migrated to use the core package by adding to pubspec.yaml:
```yaml
dependencies:
  vhhealth_core:
    path: ../vhhealth-core
```

## Related Repos
- **Backend** (Node.js): `../vhhealth-backend` — github.com/Bahuleyandr/vh-health-backend
- **Patient App** (Flutter): `../vhhealth-patient` — github.com/Bahuleyandr/VH-health
- **Admin Portal** (Next.js): `../vhhealth-admin` — github.com/Bahuleyandr/VH-Health-Adminportal
- **Core Package** (Dart): `../vhhealth-core` — github.com/Bahuleyandr/vhhealth-core

## Conventions
- All HTTP calls use `await ApiConfig.authenticatedHeaders()` for auth
- JWT stored under key `staff_jwt` (separate from patient app's `jwt` key)
- Backend response envelope: `{ success, data: {...} }` — unwrap `body['data']`
- Staff-specific theme: blue/teal primary (distinct from patient app's teal/green)
- Use descriptive SnackBars for success/error feedback
- GoRouter redirect guard: unauthenticated users → `/login`
