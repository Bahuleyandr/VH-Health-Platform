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
- `getUserPhone()` / `setUserPhone()`
- `getUserRole()` / `setUserRole()`
- `getEmployeeId()` / `setEmployeeId()`
- `clearAll()`

### VHHttpClient
HTTP helper with automatic auth:
- `VHHttpClient.get('/endpoint')` — auto-adds auth headers
- `VHHttpClient.post('/endpoint', body)` — JSON encoded
- `VHHttpClient.put('/endpoint', body)`
- `VHHttpClient.patch('/endpoint', body)`
- `VHHttpClient.delete('/endpoint')`
- Set `auth: false` to skip JWT header

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


## Future Directions

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the current A+/S-tier roadmap.
It tracks Phase 1 (security floor), Phase 2 (polish), and Phase 3 (marquee features).
When starting a new Claude session, run `cat docs/ROADMAP.md` and pick any unchecked item.
