# VH Health Patient App

Flutter app for patients and guests. It supports Firebase OTP login, profile
setup, appointments, records, pharmacy orders, investigations, SOS, doctor and
department browsing, localization, and offline-friendly record access.

## Stack

| Area | Current choice |
| --- | --- |
| Framework | Flutter 3.47.0 |
| Auth | Firebase OTP plus backend JWT |
| Routing | `go_router` |
| State | `provider` plus feature-local state |
| Shared code | `vhhealth_core` through the root Dart pub workspace |
| Localization | ARB files under `lib/l10n`, generated into `lib/generated` |

## Local Setup

Run from the repo root:

```bash
dart pub get
dart run melos bootstrap
```

Run patient-only commands from this directory:

```bash
cd apps/patient
flutter gen-l10n
flutter analyze --no-fatal-infos
flutter test
```

Or run workspace checks from the repo root:

```bash
dart run melos run format
dart run melos run analyze
dart run melos run test
dart run melos run i18n-health-patient
```

## Configuration

Backend configuration is injected through `vhhealth_core`:

```bash
flutter run \
  --dart-define=VH_BASE_URL=http://localhost:5000/api/v1 \
  --dart-define=VH_API_KEY=<local-api-key>
```

For release builds, use the same `VH_BASE_URL` and `VH_API_KEY` names through
GitHub Actions variables/secrets or local `--dart-define` values. Do not
hardcode secrets in Dart source.

The hard-upgrade policy has no built-in signing key. Production release builds
may trust an operator-owned Ed25519 current/next pair through these public
build variables:

- `VH_PATIENT_MIN_VERSION_CURRENT_KEY_ID`
- `VH_PATIENT_MIN_VERSION_CURRENT_PUBLIC_KEY_BASE64`
- `VH_PATIENT_MIN_VERSION_NEXT_KEY_ID` (optional rotation overlap)
- `VH_PATIENT_MIN_VERSION_NEXT_PUBLIC_KEY_BASE64` (optional rotation overlap)

Leave all four absent until the signing authority and the matching pre-signed
`PATIENT_MINIMUM_VERSION_POLICY_JSON` backend value are approved. The backend
forwards that envelope but never mints it from a JWT or application secret.
An authorized operator can create the envelope with the backend's existing
RFC 8785/Ed25519 primitive via `npm run patient:min-version:sign -- ...`; the
command requires an external private-key PEM and never generates a default.

## Localization

Supported app locales:

- English
- Hindi
- Tamil
- Telugu
- Malayalam

The AI first-pass Tamil/Telugu/Malayalam fill provides structural coverage, but
clinical, security, and financial wording still needs fluent human validation
before production rollout. See
[`docs/LANGUAGE_HEALTH.md`](docs/LANGUAGE_HEALTH.md) and
[`../../docs/TRANSLATION_REVIEW_TRACKER.md`](../../docs/TRANSLATION_REVIEW_TRACKER.md).

## Useful Docs

| Topic | Document |
| --- | --- |
| App conventions | [`CLAUDE.md`](CLAUDE.md) |
| Feature boundaries | [`docs/FEATURE_STRUCTURE.md`](docs/FEATURE_STRUCTURE.md) |
| Language health | [`docs/LANGUAGE_HEALTH.md`](docs/LANGUAGE_HEALTH.md) |
| Dark-mode audit | [`docs/DARK_MODE_AUDIT.md`](docs/DARK_MODE_AUDIT.md) |
| Release gate | [`../../docs/RELEASE_READINESS.md`](../../docs/RELEASE_READINESS.md) |
| Smoke journeys | [`../../docs/SMOKE_E2E_JOURNEYS.md`](../../docs/SMOKE_E2E_JOURNEYS.md) |

The old patient roadmap was removed because it predated the current monorepo,
translation state, and release gate.
