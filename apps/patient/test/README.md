# Patient app tests

## Current coverage

- `widget_test.dart` — legacy smoke test (`1 + 1 == 2`). Kept for CI to have a passing test during bootstrap; replace when real widget tests land.
- `core/models/status_enums_test.dart` — Unit tests for appointment, pharmacy, and investigation status enums. Validates canonical string parsing, legacy alias handling (`PLACED` → `pending` for backward compatibility with pre-2026-04-14 backend), and `isActive` / `isTerminal` classifications.
- `core/utils/font_scaler_test.dart` — Widget test for the dynamic font scaler.

## Running

```bash
flutter pub get
flutter test
```

## Philosophy

These tests are intentionally **pure-Dart / no-plugin**. Widget tests that require Firebase, `flutter_secure_storage`, `http`, or backend connectivity should be added in a follow-up — they need mock setup for plugin channel methods that isn't present yet.

## Deferred — needs mock scaffolding

- `ApiClient` single-flight 401 refresh behavior (needs `http` mock)
- `flutter_secure_storage` JWT persistence (needs plugin mock)
- Appointment booking form validation (needs full widget tree + mocked `ApiClient`)
- Pharmacy order place flow (multipart upload mock)
- Offline mutation queue drain behavior (needs `ConnectivityService` mock)

Target: 15+ tests across these areas within Phase 2.
