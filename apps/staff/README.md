# VH Health Staff App

Flutter app for hospital staff workflows: staff authentication, day-to-day
dashboard work, appointments, bed board, vitals, nursing notes, medication
administration, investigations, pharmacy, HR tasks, alerts, and offline sync.

## Stack

| Area | Current choice |
| --- | --- |
| Framework | Flutter 3.41 |
| Auth | Employee ID/password with backend JWT and refresh token |
| Routing | `go_router` |
| Shared code | `vhhealth_core` through the root Dart pub workspace |
| Realtime | Shared WebSocket client from `vhhealth_core` |
| Desktop | Windows build supported for staff pilot testing |
| Localization | Manual map in `lib/l10n/app_strings.dart` |

## Local Setup

Run from the repo root:

```bash
dart pub get
dart run melos bootstrap
```

Run staff-only commands from this directory:

```bash
cd apps/staff
flutter analyze --no-fatal-infos
flutter test
flutter build windows --debug
```

Or run workspace checks from the repo root:

```bash
dart run melos run format
dart run melos run analyze
dart run melos run test
dart run melos run i18n-health-staff
```

## Configuration

Backend configuration is injected through `vhhealth_core`:

```bash
flutter run \
  --dart-define=VH_BASE_URL=http://localhost:5000/api/v1 \
  --dart-define=VH_API_KEY=<local-api-key>
```

Example Windows release build:

```powershell
cd apps/staff
flutter build windows --release `
  --dart-define=VH_BASE_URL=https://<host>/api/v1 `
  --dart-define=VH_API_KEY=<release-smoke-api-key>
```

Do not commit real staff credentials, API keys, or deployment secrets.

## Localization And Accessibility

Supported app locales:

- English
- Hindi
- Tamil
- Telugu

The AI first-pass Tamil/Telugu fill provides structural coverage, but clinical,
security, payroll, medication, incident, and discharge wording still needs
fluent human validation before production rollout. See
[`docs/LANGUAGE_HEALTH.md`](docs/LANGUAGE_HEALTH.md) and
[`../../docs/TRANSLATION_REVIEW_TRACKER.md`](../../docs/TRANSLATION_REVIEW_TRACKER.md).

Accessibility docs:

- [`docs/ACCESSIBILITY_AUDIT.md`](docs/ACCESSIBILITY_AUDIT.md)
- [`docs/SCREEN_READER_TEST_PLAN.md`](docs/SCREEN_READER_TEST_PLAN.md)
- [`docs/COLOR_CONTRAST_AUDIT.md`](docs/COLOR_CONTRAST_AUDIT.md)

## Useful Docs

| Topic | Document |
| --- | --- |
| App conventions | [`CLAUDE.md`](CLAUDE.md) |
| Feature boundaries | [`docs/FEATURE_STRUCTURE.md`](docs/FEATURE_STRUCTURE.md) |
| Release gate | [`../../docs/RELEASE_READINESS.md`](../../docs/RELEASE_READINESS.md) |
| Smoke journeys | [`../../docs/SMOKE_E2E_JOURNEYS.md`](../../docs/SMOKE_E2E_JOURNEYS.md) |

The old staff roadmap was removed because it predated the current dashboard,
accessibility, localization, and release-gate work.
