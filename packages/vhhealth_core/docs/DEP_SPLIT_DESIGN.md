# vhhealth-core — conditional dependency exports (design note)

**Status:** design proposal (2026-04-17) — not yet executed. Sketches the
path from the current fat core package to a structure where consumer
apps pull only the slices they need.

## Current state

`pubspec.yaml` direct runtime deps (15):

```
http                    — HTTP client (VHHttpClient)
flutter_secure_storage  — AuthService JWT persistence
geolocator              — LocationService
url_launcher            — deep-linking helpers
web_socket_channel      — RealtimeClient
cryptography            — MessageCrypto (E2E messaging)
chopper                 — generated API client
json_annotation         — generated model classes
sqflite                 — OfflineQueue
path                    — sqflite path construction
connectivity_plus       — ConnectivitySyncService
intl                    — DateFormatter + offline sync badge
flutter (via flutter_test) — widget tests only
```

## Problem

Every consumer (patient app, staff app, any future hospital-desk app)
gets every transitive dep. Concretely:

* The **staff app** doesn't use `cryptography` at all — E2E messaging
  is patient-to-doctor. But staff installs it because core imports it.
* The **patient app** uses HealthKit / Health Connect but not
  `geolocator` (SOS is staff-only). Geolocator still ships.
* A future **hospital-kiosk build** would only need `intl` + `http` +
  generated API types — not sqflite / cryptography / geolocator.

Impact:
* APK size grows for each app unnecessarily.
* Each dep's own transitive deps balloon the graph (e.g., `geolocator`
  pulls platform-channel boilerplate on all 6 Flutter platforms).
* Plugin version conflicts: if the staff app wants to upgrade
  `connectivity_plus` major version, it's stuck waiting on the patient
  app's schedule.

## Options

### Option A — Split into feature packages (recommended)

Restructure the monorepo:

```
packages/
  vhhealth_core/         # "true" core: VHHttpClient, ApiResponse, types.
                         # ONLY depends on: http, flutter.
  vhhealth_auth/         # AuthService + flutter_secure_storage.
                         # Depends on: vhhealth_core.
  vhhealth_realtime/     # RealtimeClient + web_socket_channel.
                         # Depends on: vhhealth_core, vhhealth_auth.
  vhhealth_offline/      # OfflineQueue + sqflite + connectivity_plus.
                         # Depends on: vhhealth_core.
  vhhealth_crypto/       # MessageCrypto + cryptography.
                         # Depends on: vhhealth_core.
  vhhealth_location/     # LocationService + geolocator.
                         # Depends on: vhhealth_core.
  vhhealth_api/          # Chopper-generated client + models.
                         # Depends on: vhhealth_core, chopper, json_annotation.
  vhhealth_intl_utils/   # DateFormatter etc. + intl.
                         # Depends on: flutter.
```

Consumer `pubspec.yaml` declares only the sub-packages it needs.
Wire-up is via Melos (already configured at repo root `melos.yaml`):

```yaml
# staff app
dependencies:
  vhhealth_core:       { path: ../packages/vhhealth_core }
  vhhealth_auth:       { path: ../packages/vhhealth_auth }
  vhhealth_realtime:   { path: ../packages/vhhealth_realtime }
  vhhealth_offline:    { path: ../packages/vhhealth_offline }
  vhhealth_location:   { path: ../packages/vhhealth_location }
  vhhealth_api:        { path: ../packages/vhhealth_api }
  vhhealth_intl_utils: { path: ../packages/vhhealth_intl_utils }
  # NOT vhhealth_crypto — staff doesn't E2E-message
```

**Pros:**
* Clean boundary per concern.
* Consumer APK shrinks by roughly the sum of unused sub-package weights.
* Each sub-package can version + release independently.

**Cons:**
* 8 `pubspec.yaml` files to maintain instead of 1.
* Moving files between sub-packages now requires a `melos bootstrap`
  cycle, slower than editing one package.
* Circular-dep risk: `vhhealth_offline` needs `connectivity_plus` which
  the real-time client *also* watches for reconnect. Mitigate with a
  thin `vhhealth_connectivity` abstraction that both depend on.

### Option B — Conditional imports in one package

Keep one core package but use Dart's conditional-import feature to
compile-strip the unused surfaces:

```dart
// lib/realtime.dart
export 'src/realtime/realtime_client_stub.dart'
    if (dart.library.io) 'src/realtime/realtime_client_io.dart';
```

Combined with `dart pub deps --style=compact` and tree-shaking, callers
that never import `vhhealth_core/realtime.dart` never pull
`web_socket_channel`.

**Pros:**
* Zero restructure. Just reshuffle exports inside `lib/`.
* Easy to revert if it turns out to bite.

**Cons:**
* Dart's tree-shaking across package boundaries is less aggressive than
  within one package. Empirical benefit often ≈ 60% of what package
  split achieves, not 100%.
* `pubspec.yaml` still lists every dep as required for the worst-case
  consumer — doesn't help plugin-version conflict resolution.

### Option C — Defer

Keep things as-is; invest in APK-size analysis (`flutter build apk
--analyze-size`) and revisit only if specific release-blocker shows up.

**Pros:**
* Zero effort now.

**Cons:**
* Problem compounds as new deps land. By the time it's urgent, the
  migration cost has doubled.

## Recommendation

**Option A, executed incrementally** — one sub-package per month, in
this order (low risk first):

1. `vhhealth_intl_utils` — leaf, no reverse deps. Migrate in 1 day.
2. `vhhealth_crypto` — leaf, isolated surface. 1 day.
3. `vhhealth_location` — leaf. 1 day.
4. `vhhealth_offline` — has reverse deps (staff uses it for MAR
   offline submission). 2-3 days + migration script.
5. `vhhealth_auth` — foundational; downstream of realtime + api.
   Last to ship; ~1 week.
6. `vhhealth_realtime` — after auth is a sub-package.
7. `vhhealth_api` — after everything else. Can be slowest because
   codegen output is large.

After each step, run `flutter build apk --analyze-size` on both apps
and record the delta in `docs/APP_SIZE_LEDGER.md` (TODO: create) —
justifies the effort to whoever's asking about progress.

## Blocking prerequisites

None structurally, but practically:
* Phase 5.1 Melos monorepo migration (`docs/MONOREPO_MIGRATION.md`) must
  run first — otherwise splitting core while the repos are still
  separate means each sub-package needs its own git repo.
* The current `vhhealth-core/lib/api/generated/` is gitignored (regen
  from backend swagger). Moving it to `vhhealth_api` changes the
  codegen output path — update `tool/melos_*.sh` scripts accordingly.

## Non-goals

- Publishing to pub.dev — these stay internal path-deps.
- Splitting `http` out — too foundational, every sub-package would
  need it back.
- Splitting test fixtures — stays in the consumer that uses it.
