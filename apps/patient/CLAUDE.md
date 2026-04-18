# CLAUDE.md — VHHealth Patient App

## Project Overview
Flutter mobile app for patients of VHHealth hospital (Venkataeswara Hospital, Chennai). Handles appointment booking, health records, prescriptions, pharmacy orders, investigation bookings, delivery tracking, notifications, feedback, and emergency SOS.

## Tech Stack
- **Framework**: Flutter 3.8.1+, Dart (null-safe)
- **State**: Provider (ThemeProvider, LanguageProvider, NotificationProvider, UserProvider)
- **Navigation**: GoRouter with ShellRoute for bottom nav + auth redirect guards
- **HTTP**: `ApiClient` (centralized wrapper over `package:http`) — handles auth headers, timeouts, response parsing
- **Auth**: Firebase OTP → backend JWT
- **Storage**: flutter_secure_storage (JWT, user data), SharedPreferences (settings)
- **Localisation**: Flutter intl (5 languages: en, hi, ta, te, ml)
- **Shared Core**: `vhhealth_core` package (resolved via the root Dart pub workspace — lives at `packages/vhhealth_core/` in the monorepo) — provides `ApiConfig`

## Repository Layout
```
lib/
  main.dart                    # Entry point, MultiProvider (Theme/Language/Notification/User), AppRouter
  firebase_options.dart        # Firebase config (auto-generated)
  core/
    config/
      api_config.dart          # Re-exports vhhealth_core ApiConfig (base URL, headers)
      firebase_config.dart     # Firebase configuration
    navigation/
      app_router.dart          # GoRouter: auth redirects, ShellRoute (bottom nav), feature routes
    services/
      api_client.dart          # Centralized HTTP client (auth, timeouts, JSON parsing, multipart)
      backend_api_service.dart # Firebase login + profile save helpers (unauthenticated)
      device_service.dart      # Device registration, heartbeat, FCM token updates
      feedback_api_service.dart # Feedback history, stats, quick-rating
      firebase_session_service.dart # FCM token update, session revoke
      shared_prefs_service.dart # SharedPreferences wrapper
      sos_api_service.dart     # SOS alerts, emergency contacts, nearby services, medical info
      sos_service.dart         # High-level SOS trigger (location + API call)
    providers/
      theme_provider.dart      # Light/dark/system theme, custom ThemeData
      language_provider.dart   # Locale switching (en/hi/ta/te/ml)
      notification_provider.dart # Notification badge count, fetch/mark-read
      user_provider.dart       # User phone/name state (replaces AppRouter statics)
    theme/
      app_theme.dart           # ThemeData construction
      theme_colors.dart        # Brand color palette
    widgets/
      appointment_widget.dart       # Appointment card display
      circular_feature_dial.dart    # Dashboard circular menu
      contact_banner.dart           # Contact info banners (phone numbers)
      data_state_builder.dart       # Reusable loading/error/empty/data state widget
      delivery_tracking_card.dart   # Real-time delivery tracking with ETA
      error_boundary.dart           # Error boundary wrapper (restores handler on dispose)
      feature_screen_scaffold.dart  # Standard scaffold for feature screens (requires icon, color, child)
      feedback_prompt.dart          # In-app feedback/rating prompt
      heartbeat_logo.dart           # Animated hospital logo
      language_dropdown.dart        # Language selector
      logo_background.dart          # Background with hospital branding
      logout_button.dart            # Logout action (signs out before navigating)
      main_scaffold_go_router.dart  # Bottom nav shell (Home, Health, Notifications, Settings)
      phone_input_field.dart        # Phone number input with country code
      terms_agreement_notice.dart   # Terms notice widget
      theme_card.dart               # Theme option card
    utils/
      cache_file_utils.dart    # File caching utilities
      calendar_utils.dart      # Date/calendar helpers
      font_scaler.dart         # Dynamic font scaling
      permissions_service.dart # Runtime permission requests
    offline/
      record_cache_manager.dart  # Offline record caching
      record_cache_manifest.dart # Cache manifest tracking
  features/
    about/                     # About Us screen (contact info, map, emergency numbers)
    appointments/              # Book appointments (dept/doctor fetch, slot picker, my appointments)
    auth/
      screens/                 # LoginScreen, TermsDisclaimerScreen
      services/otp_service.dart # Firebase OTP verification
      widgets/                 # LoginForm, OTP UI components
    bootstrap/
      permission_gate.dart     # Runtime permission gate on first launch
    calendar/                  # Calendar view (appointments + investigations + pharmacy orders)
    dashboard/                 # Home screen: circular dial, contextual widgets (active orders, prescriptions, follow-ups)
    departments/               # Browse departments + doctors (search with debounce, detail sheets)
    feedback/                  # Ask a Doubt (submit questions) + Feedback History
    investigations/
      screens/
        investigations_screen.dart      # Upload investigation files, view results, download
        book_investigation_screen.dart  # Book investigations (catalog, slip upload, home/walk-in)
        my_bookings_screen.dart         # View investigation bookings
    notifications/             # View + mark-read notifications with deep-linking
    pharmacy/
      screens/pharmacy_screen.dart      # Tab coordinator (Order + My Orders)
      widgets/
        order_form_tab.dart             # Prescription upload + order form
        order_list_tab.dart             # Order list + order detail sheet
        order_status_widgets.dart       # Status chips, trackers, delivery option cards
    profile/
      screens/
        profile_setup_screen.dart  # New user onboarding profile
        profile_edit_screen.dart   # Edit all profile fields
    records/                   # Hospital documents + patient uploads
    settings/                  # Theme, language, font size, biometrics
      controllers/settings_controller.dart
      widgets/settings_sections.dart
    splash/                    # Splash screen with auth state check
    trivia/                    # Health trivia
    your_health/
      screens/your_health_screen.dart   # Tab coordinator (6 tabs) + Health Records tab
      widgets/
        prescriptions_tab.dart          # Prescription list, detail sheet, order medicines
        consultations_tab.dart          # Consultation list with doctor/diagnosis
        health_summary_tab.dart         # Summary, allergies, conditions
        hospital_documents_tab.dart     # Hospital records using shared RecordCard
        my_uploads_tab.dart             # User uploads with CRUD + upload sheet
        record_card.dart                # Shared record card widget
  gen/                         # flutter_gen asset/font accessors (auto-generated)
  generated/                   # Generated l10n files (auto-generated)
  l10n/                        # ARB localisation source files + extensions
```

## Key Architecture Decisions
- **ApiClient** (`lib/core/services/api_client.dart`) is the centralized HTTP layer — all API calls go through it with automatic auth headers, 15s default timeout (30s for uploads), JSON response parsing via `ApiResponse`, and **single-flight 401 refresh**: on 401 it POSTs `/auth/refresh-token`, stores the new JWT, and retries the original request once; falls back to `onSessionExpired` (clears stale JWT + redirects to login) only when refresh fails.
- **ApiConfig** lives in `vhhealth_core` — re-exported by `lib/core/config/api_config.dart`. Base URL: `https://api.vhhealth.app/api/v1`
- **BackendApiService** is the only service that does NOT use ApiClient (it handles unauthenticated login requests)
- **DataStateBuilder** (`lib/core/widgets/data_state_builder.dart`) eliminates loading/error/empty boilerplate across screens
- **UserProvider** holds user phone/name in the Provider tree — AppRouter reads from it via `context.read<UserProvider>()` with static fallback for backward compat
- **SOS services** (`sos_api_service.dart`) throw `SosException` on critical failures (triggerAlert, cancelAlert) so callers can show user feedback — SOS must never fail silently
- **Firebase OTP** is the only patient auth mechanism — no username/password
- **ShellRoute** wraps the 4 bottom-nav tabs (Home, Health, Notifications, Settings); feature screens render full-screen outside the shell
- **Dashboard polling** uses exponential backoff on consecutive failures (30s base → capped at 16x) to avoid hammering the backend
- **Local plugins** (`local_plugins/`) contain forked `geolocator_android` and `flutter_plugin_android_lifecycle` with manual build.gradle lint fixes

## Making API Calls
Use `ApiClient` for all new API calls:
```dart
// GET
final response = await ApiClient.get('/appointments/patient/$id');
if (response.isSuccess) {
  final list = response.dataAsList();       // List from data field
  final map = response.dataAsMap();         // Map from data field
  final msg = response.message;             // Backend message field
}

// POST with body
final response = await ApiClient.post('/appointments/book', body: {...});

// Multipart upload
final response = await ApiClient.multipart('/upload',
  fields: {'type': 'prescription'},
  files: [await http.MultipartFile.fromPath('file', path)],
);
```

## Auth Flow
1. Patient enters phone number → Firebase `verifyPhoneNumber` (OTP)
2. Patient enters OTP → Firebase `signInWithCredential`
3. App calls `POST /auth/firebase/firebase-login` with Firebase `idToken`
4. Backend returns `{ data: { accessToken, user: { uid, phone, isNewUser, ... } } }`
5. JWT stored in flutter_secure_storage (key: `'jwt'`)
6. If `isNewUser` → redirect to `/profile-setup` → `POST /auth/firebase/complete-profile`
7. All subsequent API calls include `Authorization: Bearer <jwt>` (handled by ApiClient)

## Routes
| Path | Screen | Shell? |
|------|--------|--------|
| `/` | SplashScreen | No |
| `/login` | LoginScreen | No |
| `/terms` | TermsDisclaimerScreen | No |
| `/profile-setup` | ProfileSetupScreen | No |
| `/profile-edit` | ProfileEditScreen | No |
| `/home` | DashboardScreen | Yes (bottom nav) |
| `/health` | YourHealthScreen | Yes (bottom nav) |
| `/notifications` | NotificationsScreen | Yes (bottom nav) |
| `/settings` | SettingsScreen | Yes (bottom nav) |
| `/appointments` | AppointmentsScreen | No |
| `/pharmacy` | PharmacyScreen | No |
| `/investigations` | InvestigationsScreen | No |
| `/book-investigation` | BookInvestigationScreen | No |
| `/ask-a-doubt` | AskADoubtScreen | No |
| `/feedback-history` | FeedbackHistoryScreen | No |
| `/trivia` | TriviaScreen | No |
| `/departments` | DepartmentsScreen | No |
| `/about-us` | AboutUsScreen | No |
| `/calendar` | CalendarScreen | No |
| `/steps` | StepChallengeScreen | No |
| `/vitals` | VitalsScreen | No |
| `/refill` | RefillScreen | No |
| `/family` | FamilyScreen | No |
| `/abdm` | AbdmScreen | No |
| `/records` → `/health` | Redirect | — |
| `/your-health` → `/health` | Redirect | — |
| `/dashboard` → `/home` | Redirect | — |

## API Endpoints Used
| Feature | Endpoint | Method |
|---------|----------|--------|
| **Auth** | | |
| Login | `/auth/firebase/firebase-login` | POST |
| Profile setup | `/auth/firebase/complete-profile` | POST |
| FCM token | `/auth/firebase/update-fcm-token` | POST |
| Revoke session | `/auth/firebase/revoke-session` | POST |
| **Users** | | |
| Get/Update profile | `/users/:phone` | GET, PUT |
| **Dashboard** | | |
| Dashboard data | `/dashboard?phone=` | GET |
| **Appointments** | | |
| List departments | `/departments/departments-with-doctors` | GET |
| Book appointment | `/appointments/book` | POST |
| My appointments | `/appointments/patient/:patientId` | GET |
| Appointment by UID | `/appointments/uid/:uid` | GET |
| Appointment slots | `/appointments/slots?doctor_id=&date=` | GET |
| Appointment docs | `/appointments/:id/documents` | GET |
| Cancel/update appt | `/appointments/:id` | PUT/DELETE |
| **Records** | | |
| Health records | `/records/health-records/:phone` | GET |
| Consultations | `/records/consultations/:phone` | GET |
| Patient records | `/appointments/patient/records/all` | GET |
| Record detail | `/appointments/patient/records/:id` | GET |
| Upload record | `/appointments/patient/records/upload` | POST |
| **Health** | | |
| Health summary | `/health/patient/:patientId/summary` | GET |
| Allergies | `/health/patient/:patientId/allergies` | GET |
| Conditions | `/health/patient/:patientId/conditions` | GET |
| **Prescriptions** | | |
| My prescriptions | `/prescriptions/patient/my` | GET |
| Order from Rx | `/prescriptions/:id/order-pharmacy` | POST |
| **Investigations** | | |
| Upload file | `/upload` | POST |
| Create investigation | `/investigations` | POST |
| Investigations by UID | `/investigations/uid/:uid` | GET |
| Investigation files | `/investigations/:id/files` | GET |
| Download file | `/investigations/:id/files/:fileId/download` | GET |
| Catalog | `/investigations/catalog` | GET |
| Book investigation | `/investigations/bookings/create` | POST |
| My bookings | `/investigations/bookings/my` | GET |
| **Pharmacy** | | |
| Place order | `/pharmacy-orders/orders/place` | POST |
| My orders | `/pharmacy-orders/orders/my` | GET |
| Orders by UID | `/pharmacy-orders/orders/uid/:uid` | GET |
| **Delivery** | | |
| Track delivery | `/delivery/track/:orderType/:orderId` | GET |
| **File upload/download** | | |
| Upload file | `/upload` | POST |
| Download by key | `/upload/by-key/:storageKey` | GET |
| **Notifications** | | |
| List | `/notifications/:phone` | GET |
| Mark read | `/notifications/:id/read` | PATCH |
| **Feedback** | | |
| Submit feedback | `/feedback` | POST |
| My feedback | `/feedback/my-feedback` | GET |
| My stats | `/feedback/my-stats` | GET |
| Quick rating | `/feedback/quick-rating` | POST |
| **SOS** | | |
| Trigger SOS | `/sos/` | POST |
| Get emergency contact | `/sos/emergency-contact` | GET |
| Update emergency contact | `/sos/emergency-contact` | POST |
| Cancel alert | `/sos/cancel/:alertId` | POST |
| My alerts | `/sos/my-alerts` | GET |
| Nearby services | `/sos/nearby-services?lat=&lng=` | GET |
| Medical info | `/sos/medical-info` | GET |
| **Vitals** | | |
| Record vitals | `/health/patient/vitals` | POST |
| Vitals history | `/health/patient/:patientId/vitals` | GET |
| **Prescriptions (Refill)** | | |
| Request refill | `/prescriptions/:id/refill` | POST |
| **Family Members** | | |
| List members | `/users/family-members` | GET |
| Add member | `/users/family-members` | POST |
| Remove member | `/users/family-members/:id` | DELETE |
| **Steps Challenge** | | |
| Step profile | `/steps/profile` | GET |
| Update profile | `/steps/profile` | PUT |
| Start session | `/steps/session/start` | POST |
| Stop session | `/steps/session/stop` | POST |
| Step history | `/steps/history` | GET |
| Leaderboard | `/steps/leaderboard` | GET |
| Rewards | `/steps/rewards` | GET |
| **Medication Reminders** | | |
| List reminders | `/reminders/medication` | GET |
| Create reminder | `/reminders/medication` | POST |
| Update reminder | `/reminders/medication/:id` | PUT |
| Delete reminder | `/reminders/medication/:id` | DELETE |
| **Devices** | | |
| Register device | `/devices/register` | POST |
| My devices | `/devices/my-devices` | GET |
| Heartbeat | `/devices/heartbeat` | POST |
| Update token | `/devices/update-token` | POST |
| Unregister | `/devices/unregister` | DELETE |

## CI/CD
GitHub Actions workflows at the monorepo root:
- `.github/workflows/ci-flutter.yml` — path-filtered to `apps/{patient,staff}/**` and `packages/vhhealth_core/**`; runs `melos bootstrap → analyze → test → format`
- `.github/workflows/deploy-patient-staging.yml` — on push to main touching this app; builds debug APK, Firebase App Distribution upload
- `.github/workflows/release-patient.yml` — triggered by `patient-v*` tag; signed APK + AAB → GitHub Release

## Running
Run from the monorepo root — the Dart pub workspace resolves `vhhealth_core` automatically:
```bash
# Once per clone
dart pub global activate melos 7.5.1
dart pub get
melos bootstrap

# Run the patient app
cd apps/patient && flutter run

# Code generation (after changing assets/fonts/l10n)
cd apps/patient && dart run build_runner build --delete-conflicting-outputs
```

## Sibling apps (same monorepo)

See the [root `CLAUDE.md`](../../CLAUDE.md) for the cross-stack layout. Other apps in the same repo:

- `apps/backend` — Node/Express API
- `apps/admin` — Next.js admin portal
- `apps/staff` — Flutter staff app
- `packages/vhhealth_core` — shared Dart package

The five separate source repos these were merged from are archived on GitHub as of 2026-04-18.

## Conventions
- **ApiClient** is the standard for all authenticated HTTP calls — use `ApiClient.get/post/put/patch/delete/multipart`
- **BackendApiService** is the only exception — handles unauthenticated Firebase login calls directly
- **ApiConfig** is re-exported from `vhhealth_core` — do NOT duplicate base URL or headers
- **ApiResponse** auto-parses JSON: use `.data`, `.dataAsList()`, `.dataAsMap()`, `.isSuccess`, `.message`, `.isUnauthorized`
- Backend response envelope: `{ success, data: {...} }` — ApiResponse unwraps `data` automatically
- **DataStateBuilder** should be used for screens with loading/error/empty/data states
- **Error handling**: never use `catch (_) {}` — always log errors with `debugPrint` or `if (kDebugMode) debugPrint(...)`. SOS critical methods must throw, not return null.
- Use `developer.log()` guarded by `kDebugMode` — never `print()` in production
- Never log tokens or full phone numbers — mask sensitive data in debug logs
- Gender values: `MALE`, `FEMALE`, `OTHER` (uppercase, matching backend validator)
- Dates: ISO 8601 `YYYY-MM-DD` format when sending to backend
- Dead code files have `.dead` extension (not deleted, for reference)
- `FeatureScreenScaffold` requires `icon`, `color`, and `child` parameters
- Route navigation: use `context.go('/path')` for tab switches, `context.push('/path')` for feature screens
- User phone/name: prefer `context.read<UserProvider>()` in widgets; `AppRouter._phone(context)` in route builders
- Always check `mounted` before `setState` after any `await`
- Use theme colors (`theme.colorScheme.*`) instead of hardcoded `Colors.*` for dark mode support
- Debounce search inputs (300ms) to avoid excessive rebuilds
- Dispose TextEditingControllers in modals via `.whenComplete()`
- Polling: use exponential backoff on consecutive failures, not fixed intervals
- Linting: `package:flutter_lints` (see `analysis_options.yaml`)
- JWT stored in flutter_secure_storage with key `'jwt'`


## Status enums (added 2026-04-15)

`lib/core/models/status_enums.dart` is the canonical source for backend
status string handling:

- `AppointmentStatus` — SCHEDULED → CONFIRMED → IN_PROGRESS → COMPLETED;
  + CANCELLED / NO_SHOW terminal.
- `PharmacyOrderStatus` — PENDING → CONFIRMED → PREPARING → READY →
  DISPATCHED → DELIVERED; + CANCELLED terminal. Legacy `PLACED` accepted
  in `fromString` as alias for `pending` (backend renamed 2026-04-14).
- `InvestigationStatus` — PENDING → CONFIRMED → SAMPLE_COLLECTED →
  PROCESSING → COMPLETED → REPORT_READY; + CANCELLED.

Use `*.fromString(s)` instead of raw string compares. `isActive` /
`isTerminal` give classification. `PharmacyOrderStatus.orderedSteps`
is the canonical lifecycle list (no `PLACED`).

## Testing (added 2026-04-15)

Real tests live under `test/`. Pure-Dart unit tests need no plugin mocks:

- `test/core/models/status_enums_test.dart` — 14 enum tests.
- `test/core/utils/font_scaler_test.dart` — 2 widget tests.

Run with `flutter test`.

Mock-heavy tests (Firebase auth, ApiClient single-flight 401 refresh,
`SharedPrefsService`, offline mutation queue, multipart pharmacy upload)
need plugin-channel mock setup that isn't in place yet — see
`test/README.md` for the prioritised list.

## Future Directions

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the current roadmap and
[`../FINISH_BUILDING.md`](../FINISH_BUILDING.md) for the cross-repo
master plan (Phase 0.5 = current; ranked open items at the bottom).
