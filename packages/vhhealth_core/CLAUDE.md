# CLAUDE.md — VHHealth Core Package

## Project Overview
Shared Dart package for the VHHealth ecosystem. Contains common code used by both the patient app and staff app to avoid duplication.

## Tech Stack
- **Language**: Dart (null-safe, SDK >=3.8.1)
- **Type**: Flutter package (not standalone app)
- **Dependencies**: http, flutter_secure_storage, geolocator, url_launcher

## Package Contents
```
lib/
  vhhealth_core.dart           # Barrel export (import this one file to get everything)
  config/
    api_config.dart             # Base URL, API key, header generators
  services/
    auth_service.dart           # JWT/phone/role/employeeId secure storage
    http_client.dart            # VHHttpClient — GET/POST/PUT/PATCH/DELETE with auto auth
  theme/
    app_theme.dart              # Material 3 light/dark theme definitions
    theme_colors.dart           # Shared color constants
  widgets/
    sos_button.dart             # Emergency SOS floating action button
```

## Usage
Add to consuming app's `pubspec.yaml`:
```yaml
dependencies:
  vhhealth_core:
    path: ../vhhealth-core
```

Then import:
```dart
import 'package:vhhealth_core/vhhealth_core.dart';

// Or import specific modules:
import 'package:vhhealth_core/config/api_config.dart';
import 'package:vhhealth_core/services/auth_service.dart';
```

## Key Classes

### ApiConfig
Single source of truth for backend connection:
- `baseUrl` — `https://api.vhhealth.app/api/v1`
- `apiKey` — `vhhealth123`
- `jsonHeaders` — sync, for public endpoints
- `authHeaders` — sync, API key only (no Content-Type)
- `authenticatedHeaders()` — async, includes JWT from secure storage
- `authenticatedAuthHeaders()` — async, JWT + API key (no Content-Type, for multipart)

### AuthService
Secure storage abstraction:
- `getJwt()` / `setJwt()` / `clearJwt()`
- `getRefreshToken()` / `setRefreshToken()` / `clearRefreshToken()`
- `setTokens({accessToken, refreshToken?})` — persist both in one call (empty `refreshToken` ignored)
- `getUserPhone()` / `setUserPhone()` / `getUserRole()` / `setUserRole()`
- `getEmployeeId()` / `setEmployeeId()` / `getStaffId()` / `setStaffId()`
- `isLoggedIn()` — true iff JWT present
- `clearAll()` — wipes every key

### VHHttpClient
HTTP helper with automatic auth, single-flight 401 refresh, and exponential-backoff retry:
- `VHHttpClient.get('/endpoint')` / `.post(...)` / `.put(...)` / `.patch(...)` / `.delete(...)`
- `VHHttpClient.multipart('/endpoint', fileBuilder: () async => [...])` — pass `fileBuilder` (not just `files`) to enable 401-retry; plain `files` still works but skips retry (streams are single-use).
- Set `auth: false` to skip JWT header.
- **401 refresh flow**: POSTs to `/auth/refresh-token` with `{refreshToken}` body when `AuthService.getRefreshToken()` has a value (staff path), otherwise bearer-based rotation (patient/admin path). Concurrent 401s share one refresh via a module-level `Completer`. Success → retry original request once; failure → clear all tokens + fire `onSessionExpired`.
- **Retry with backoff**: retries `TimeoutException`, `http.ClientException`, and 5xx responses with 1s → 2s backoff (3 attempts total). 4xx and 401 bypass retry — bugs won't self-heal, and the refresh path handles auth.
- **Test hook**: `setClientForTesting(http.Client)` + `resetClientForTesting()` (`@visibleForTesting`) allow swapping in `MockClient`. Pair with `debugTryRefreshToken()` to exercise refresh paths.

### CrashReporter
Abstraction over non-fatal error reporting. No-op by default; install a real impl at startup:
```dart
CrashReporter.install(FirebaseCrashReporter());
CrashReporter.instance.recordError(e, stack, context: 'vitals upload');
```
Methods: `recordError(error, stack, {context, extra, fatal})`, `log(message)`, `setUserId(id?)`, `setCustomKey(key, value)`. Implementations MUST strip PII before reporting. Call `CrashReporter.reset()` in tests.

### BiometricAuthService
Abstraction over platform biometrics (`local_auth`). No-op default returns `notAvailable`. Consumers install a real impl at startup:
```dart
BiometricAuthService.install(LocalAuthBiometricService());
final r = await BiometricAuthService.instance.authenticate(
  reason: 'Unlock to view your medical records',
);
if (r == BiometricAuthResult.success) { /* ... */ }
```
`BiometricAuthResult` distinguishes `success` / `cancelled` / `notEnrolled` / `notAvailable` / `error`.

### ApiRetry
Generic async retry with exponential backoff: `ApiRetry.withRetry(() async => ..., maxRetries: 3, initialDelay: 1s, shouldRetry: (e) => ...)`. Used internally by `VHHttpClient`; available for callers wrapping their own idempotent operations.

### SosButton
Reusable FAB widget for emergency:
```dart
SosButton(onBeforeTrigger: () => showSnackBar(...))
```

## Migration Status
Both patient and staff apps currently have their own copies of ApiConfig and auth code. This package exists for future consolidation — when migrating, replace local copies with imports from this package.

## Related Repos
- **Backend** (Node.js): `../vhhealth-backend` — github.com/Bahuleyandr/vh-health-backend
- **Patient App** (Flutter): `../vhhealth-patient` — github.com/Bahuleyandr/VH-health
- **Staff App** (Flutter): `../vhhealth-staff` — github.com/Bahuleyandr/vhhealth-staff
- **Admin Portal** (Next.js): `../vhhealth-admin` — github.com/Bahuleyandr/VH-Health-Adminportal

## Conventions
- This is a library package — no `main.dart`, no runnable app
- All public API exported via `lib/vhhealth_core.dart` barrel file
- Keep dependencies minimal — only things both apps need
- When adding new shared code, add it here AND export from the barrel file


## Audit correction (2026-04-15)

The first repo audit incorrectly claimed the patient app didn't import
this package. Grep proves otherwise — patient (`VH-Health`) imports core
21 times across 18 files; staff (`vhhealth-staff`) imports 25 times
across 23 files. Both apps are real consumers; the package is genuinely
shared. Each app's local `core/services/*.dart` files that look like
duplicates are usually thin re-exports (`export 'package:vhhealth_core/...'`)
or specialised wrappers (e.g. staff's `auth_service.dart` is staff-flow-
specific, NOT a duplicate of core's base auth_service).

When adding new shared code, prefer adding here + exporting via the
`vhhealth_core.dart` barrel over duplicating across the two apps.

## Future Directions

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the current roadmap and
[`../FINISH_BUILDING.md`](../FINISH_BUILDING.md) for the cross-repo
master plan. Top open items: `RealtimeClient` test coverage (zero today),
conditional dependency exports to slim per-consumer transitive graph.
