# Staff app tests

## Current coverage

- `widget_test.dart` — legacy smoke test.
- `core/config/campus_config_test.dart` — campus config helpers (pre-existing).
- `core/config/role_config_test.dart` — **NEW 2026-04-14.** 13 test cases locking in `StaffRole.fromString` behaviour (canonical parse, trim + case-insensitive, fallback to `general` for unknown), the `isAdminTier` membership, and per-role dispatch of `getFeaturesForRole` + `getBottomNavForRole`. Every role-aware feature gate runs through this file.
- `core/widgets/debounced_button_test.dart` — debounce behaviour (pre-existing).
- `features/auth/services/login_service_test.dart` — login flow validators (pre-existing).

## Running

```bash
flutter pub get
flutter test
```

## Deferred — needs mock scaffolding

These are the highest-value next tests; all need plugin-channel mocks that aren't present:

- **MAR 5-rights verification** (`features/nursing/screens/mar_scan_screen.dart` — the `_Step` state-machine walk: `scanWristband → scanDrug → verify → done`). Needs mocked barcode scanner + `ConnectivitySyncService` + `medical_api_service`.
- **CDS allergy blocker** on Rx entry (`features/doctor/screens/prescriptions_screen.dart` — the modal that blocks save when patient allergy conflicts with the drug).
- **Offline queue drain** on reconnect (`ConnectivitySyncService.enqueue` + `MutationQueue` — needs `connectivity_plus` channel mock).
- **Code Blue receive + wake-from-terminated** — needs FCM background handler harness + `flutter_local_notifications` mock + full-screen-intent permission stub.
- **Employee-ID login lockout** after 5 failed attempts (login_service with mocked backend returning 423).
- **Quick-login via biometric** (`local_auth` plugin mock).

Target: 15+ tests across these areas within Phase 2.

## Philosophy

These tests are intentionally **pure-Dart / no-plugin**. Once plugin mocks exist, the second wave should concentrate on the clinical-safety paths (MAR + CDS + Code Blue) because those are the ones where a silent failure actually harms a patient.
