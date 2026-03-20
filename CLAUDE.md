# CLAUDE.md — VHHealth Patient App

## Project Overview
Flutter mobile app for patients of VHHealth hospital. Handles appointment booking, health records, pharmacy orders, investigations, notifications, and emergency SOS.

## Tech Stack
- **Framework**: Flutter 3.8.1+, Dart (null-safe)
- **State**: Provider
- **Navigation**: GoRouter
- **HTTP**: `package:http` (NOT dio — dio is in pubspec but only used in one cache utility)
- **Auth**: Firebase OTP → backend JWT
- **Storage**: flutter_secure_storage (JWT, user data), SharedPreferences (settings)
- **Localisation**: Flutter intl (5 languages: en, hi, ta, te, ml)

## Repository Layout
```
lib/
  main.dart                    # Entry point, MultiProvider, AppRouter
  core/
    config/api_config.dart     # Base URL, API key, authenticated headers
    navigation/app_router.dart # GoRouter routes + auth guards
    services/                  # Backend API service, SOS service
    theme/                     # AppTheme + ThemeColors
    providers/                 # Theme, Language, Notification providers
    widgets/                   # Shared widgets (FeatureScreenScaffold, etc.)
    utils/                     # Permissions, calendar utils
  features/
    auth/                      # Login (Firebase OTP), profile setup
    dashboard/                 # Patient home screen with circular feature dial
    appointments/              # Book appointments (date/time picker, dept/doctor fetch)
    calendar/                  # Calendar view (appointments + investigations + pharmacy)
    departments/               # Browse departments + doctors
    investigations/            # Upload investigation files
    your_health/               # View health records + download files
    pharmacy/                  # Upload prescriptions + create orders
    notifications/             # View + mark-read notifications
    feedback/                  # Ask a Doubt (submit questions)
    profile/                   # Edit profile
    settings/                  # Theme, language, font size, biometrics
    trivia/                    # Health trivia
    splash/                    # Splash screen
  gen/                         # flutter_gen asset/font accessors
  generated/                   # Generated l10n files
  l10n/                        # ARB localisation files
```

## Key Architecture Decisions
- **ApiConfig** is the single source of truth for base URL (`https://api.vhhealth.app/api/v1`) and API key
- **authenticatedHeaders()** is async — reads JWT from secure storage, returns headers with Bearer token
- **All screens** use `await ApiConfig.authenticatedHeaders()` for protected endpoints
- **Firebase OTP** is the only patient auth mechanism — no username/password
- **Backend login** happens in background after Firebase auth, stores JWT for subsequent API calls

## Auth Flow
1. Patient enters phone number → Firebase `verifyPhoneNumber` (OTP)
2. Patient enters OTP → Firebase `signInWithCredential`
3. App calls `POST /api/v1/auth/firebase/firebase-login` with Firebase `idToken`
4. Backend returns `{ data: { accessToken, user: { uid, phone, isNewUser, ... } } }`
5. JWT stored in flutter_secure_storage
6. If `isNewUser` → redirect to profile setup (`POST /auth/firebase/complete-profile`)
7. All subsequent API calls include `Authorization: Bearer <jwt>`

## API Endpoints Used
| Feature | Endpoint | Method |
|---------|----------|--------|
| Login | `/auth/firebase/firebase-login` | POST |
| Profile setup | `/auth/firebase/complete-profile` | POST |
| Profile edit | `/users/:phone` | PUT |
| Dashboard | `/dashboard?phone=` | GET |
| Appointments (dept) | `/departments/departments-with-doctors` | GET |
| Appointments (book) | `/appointments` | POST |
| Calendar | `/appointments/uid/:uid`, `/investigations/uid/:uid`, `/pharmacy-orders/uid/:uid` | GET |
| Departments | `/departments/departments-with-doctors` | GET |
| Investigations | `/upload` (file), `/investigations` (create) | POST |
| Health Records | `/records/health-records/:phone` | GET |
| File Download | `/upload/by-key/:storageKey` | GET |
| Pharmacy | `/upload` (file), `/pharmacy-orders/orders` (create) | POST |
| Notifications | `/notifications/:phone` (list), `/notifications/:id/read` (mark) | GET, PATCH |
| Feedback | `/feedback` | POST |
| SOS | `/sos` | POST |

## Running
Requires Flutter SDK (not installed on the Pi — develop on your local machine):
```bash
flutter pub get
flutter run
```

## Related Repos
- **Backend** (Node.js): `../vhhealth-backend` — github.com/Bahuleyandr/vh-health-backend
- **Admin Portal** (Next.js): `../vhhealth-admin` — github.com/Bahuleyandr/VH-Health-Adminportal
- **Staff App** (Flutter): `../vhhealth-staff` — github.com/Bahuleyandr/vhhealth-staff
- **Core Package** (Dart): `../vhhealth-core` — github.com/Bahuleyandr/vhhealth-core

## Conventions
- All HTTP calls go through `ApiConfig.authenticatedHeaders()` (async, includes JWT)
- Backend response envelope: `{ success, data: {...} }` — always unwrap `body['data']`
- Upload responses: read `decoded['data']?['storageKey']` with fallback
- Use `developer.log()` guarded by `kDebugMode` — never `print()` in production
- Gender values: `MALE`, `FEMALE`, `OTHER` (uppercase, matching backend validator)
- Dates: ISO 8601 `YYYY-MM-DD` format when sending to backend
- Dead code files have `.dead` extension (not deleted, for reference)
