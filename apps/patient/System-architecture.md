# System Architecture — VHHealth Patient App

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Flutter Patient App                      │
│                                                              │
│  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌──────────┐ │
│  │ Provider  │  │  GoRouter │  │  ApiClient │  │ Firebase │ │
│  │  (State)  │  │   (Nav)   │  │   (HTTP)   │  │  (Auth)  │ │
│  └────┬─────┘  └─────┬─────┘  └─────┬──────┘  └────┬─────┘ │
│       │               │              │               │       │
│  ┌────▼───────────────▼──────────────▼───────────────▼─────┐ │
│  │                   Feature Screens                        │ │
│  │  Dashboard │ Appointments │ Pharmacy │ Health │ ...      │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTPS (JWT Bearer)
                               ▼
                    ┌─────────────────────┐
                    │   Node.js Backend   │
                    │   api.vhhealth.app  │
                    └─────────────────────┘
```

## Layer Architecture

### 1. Presentation Layer (Features)

Each feature follows a consistent structure:

```
features/<name>/
  screens/<name>_screen.dart    # StatefulWidget, the screen entry point
  widgets/                      # Extracted sub-widgets (for complex features)
```

**Screen patterns:**
- Simple screens (trivia, about) — single file, self-contained
- Medium screens (departments, notifications) — single file, uses `DataStateBuilder`
- Complex screens (pharmacy, your_health) — coordinator screen + extracted tab widgets

**God-class prevention:** Large screens are split into tab widgets that manage their own state and API calls. The parent screen acts as a coordinator (tab controller, shared callbacks). Examples:
- `PharmacyScreen` (71 lines) → `OrderFormTab` + `OrderListTab` + `OrderStatusWidgets`
- `YourHealthScreen` (430 lines) → `PrescriptionsTab` + `ConsultationsTab` + `HealthSummaryTab` + `HospitalDocumentsTab` + `MyUploadsTab`

### 2. State Management Layer (Providers)

```
MultiProvider
  ├── ThemeProvider        # Theme mode, light/dark ThemeData
  ├── LanguageProvider     # Locale switching (5 languages)
  ├── NotificationProvider # Unread badge count
  └── UserProvider         # User phone + name (replaces AppRouter statics)
```

- All providers extend `ChangeNotifier`
- Feature-level state is kept local in `StatefulWidget`s (not lifted to providers)
- Only cross-cutting concerns (theme, locale, auth, notifications) are in providers

### 3. Service Layer

```
ApiClient (centralized HTTP)
  ├── Handles: auth headers, timeouts, JSON parsing, 401 detection
  ├── Returns: ApiResponse (isSuccess, data, message, isUnauthorized, dataAsList, dataAsMap)
  ├── 401 handling: clears stale JWT, fires onSessionExpired → redirect to /login
  └── Used by: all services + screens

BackendApiService (unauthenticated)
  └── Firebase login + profile save (no JWT yet)

Domain Services
  ├── DeviceService         # Device registration, heartbeat
  ├── SosApiService         # SOS alerts, emergency contacts
  ├── FeedbackApiService    # Feedback history, stats
  └── FirebaseSessionService # FCM token, session revoke
```

### 4. Navigation Layer (GoRouter)

```
GoRouter
  ├── / (SplashScreen)
  ├── /login, /terms, /profile-setup, /profile-edit
  ├── ShellRoute (bottom nav)
  │   ├── /home (DashboardScreen)
  │   ├── /health (YourHealthScreen)
  │   ├── /notifications (NotificationsScreen)
  │   └── /settings (SettingsScreen)
  └── Feature Routes (full screen, outside shell)
      ├── /appointments, /pharmacy, /investigations, ...
      └── Redirects: /records→/health, /dashboard→/home
```

**Auth guard:** `redirect` callback checks `FirebaseAuth.instance.currentUser` and redirects unauthenticated users to `/login`.

## Data Flow

### API Request Flow

```
Screen calls ApiClient.get('/path')
  → ApiClient reads JWT from FlutterSecureStorage
  → Adds Authorization header + Content-Type
  → Sends HTTP request with 15s timeout
  → Parses JSON response
  → If 401: clears JWT, fires onSessionExpired → redirect to /login
  → Returns ApiResponse { isSuccess, data, message, statusCode }
Screen checks response.isSuccess, uses response.data
```

### Authentication Flow

```
Phone → Firebase verifyPhoneNumber → OTP
  → Firebase signInWithCredential
  → BackendApiService.firebaseLogin(idToken)
  → Backend returns { accessToken, user }
  → JWT stored in FlutterSecureStorage (key: 'jwt')
  → UserProvider.setUser(phone, name)
  → Navigate to /home (or /profile-setup if new user)
```

### Logout Flow

```
LogoutButton._confirmAndLogout()
  → DeviceService.unregisterDevice()
  → FirebaseSessionService.revokeSession()
  → FlutterSecureStorage.deleteAll()
  → FirebaseAuth.signOut()
  → AppRouter.clearUserData()
  → context.go('/login')
```

## Key Design Patterns

### ApiClient + ApiResponse
Centralized HTTP wrapper that eliminates boilerplate:
- **Before:** Every screen had `Uri.parse('${ApiConfig.baseUrl}/...') + authenticatedAuthHeaders() + timeout() + jsonDecode() + body['data']`
- **After:** `ApiClient.get('/path')` returns parsed `ApiResponse` with `.data` already unwrapped

### DataStateBuilder
Generic widget that handles the 4 data states every list screen needs:
- Loading → `CircularProgressIndicator`
- Error → error message + retry button
- Empty → empty state icon + message
- Data → custom builder

### Tab Widget Extraction
Complex features split into self-managing tab widgets:
- Each tab fetches its own data independently
- Parent coordinates via `GlobalKey<TabState>` for cross-tab callbacks
- Controllers and state are local to each tab (disposed properly)

## Backend Integration

### Response Envelope
All backend responses follow: `{ success: bool, data: {...}, message?: string }`

`ApiResponse` automatically:
- Unwraps `data` field → `response.data`
- Extracts `message` → `response.message`
- Provides helpers: `dataAsList()`, `dataAsMap()`

### File Uploads
Use `ApiClient.multipart()` with `http.MultipartFile`:
```dart
final response = await ApiClient.multipart('/upload',
  fields: {'type': 'prescription'},
  files: [await http.MultipartFile.fromPath('file', filePath)],
);
```
Upload timeout is 30s (vs 15s default for standard calls).

## Resilience Patterns

- **401 session expiry**: ApiClient detects 401 responses, clears stale JWT, redirects to login via `onSessionExpired` callback
- **Polling backoff**: Dashboard pollers use exponential backoff on consecutive failures (base interval × 2^failures, capped at 16x)
- **Startup resilience**: Splash screen wraps all storage reads and biometric auth in try-catch — failures fall through to login
- **SOS error propagation**: Critical SOS methods (triggerAlert, cancelAlert) throw `SosException` instead of returning null — callers must show user feedback
- **Error logging**: All catch blocks log errors with `debugPrint` in debug mode — no silent `catch (_) {}` swallowing

## Security Considerations

- JWT tokens stored in `FlutterSecureStorage` (encrypted at rest)
- Tokens are NOT logged in production (`kDebugMode` guard)
- Phone numbers are masked in debug logs
- Firebase OTP is the only auth mechanism (no passwords stored)
- Logout revokes backend session + unregisters device before clearing storage
- All HTTP calls have explicit timeouts (15s/30s) to prevent hanging
- 401 responses automatically clear local tokens to prevent stale token reuse

## Offline Support

Limited offline support via `RecordCacheManager`:
- Health records cached to local JSON file
- Cache manifest tracks what's stored
- Used in YourHealthScreen's Health Records tab
- No offline write/sync — read-only cache

## Localization

5 languages supported via Flutter intl:
- English (en) — template
- Hindi (hi)
- Tamil (ta)
- Telugu (te)
- Malayalam (ml)

ARB files in `lib/l10n/`, generated output in `lib/generated/`.
`AppLocalizations.of(context)` for translations, `app_localizations_ext.dart` for extension methods.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`):
1. Checkout patient app + `vhhealth-core` (fixes path dependency)
2. `flutter pub get`
3. `flutter analyze` (continue-on-error)
4. `flutter test` (if test files exist)

Currently only a smoke test exists. Real widget tests need Firebase mock setup.
