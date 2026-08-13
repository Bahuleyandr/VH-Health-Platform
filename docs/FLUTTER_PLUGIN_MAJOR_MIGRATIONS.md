# Flutter Plugin Major Migrations

**How to read this document.** The P3 section below is a *historical record* —
its version numbers are permanently correct as a statement about that pass and
are not maintained. Every section after it describes current state and
therefore names no current constraints; read those from the pubspecs.

That split is enforced, not just conventional:
[`scripts/check-docs-plugin-versions.mjs`](../scripts/check-docs-plugin-versions.mjs)
fails the build if a plugin version stated outside a historical block
disagrees with the pubspec it describes.

## The P3 pass — applied 2026-04-29, commit `ebd0204ed`

<!-- vh:historical-start P3 plugin migration pass, commit ebd0204ed -->

P3 was the breaking Flutter plugin migration pass that had been deferred until
release health, CI, and security gates were stable. The table records the
constraints **as applied in that pass**. They are not current constraints and
several have since moved.

| Package                       | Constraint applied in P3 |
| ----------------------------- | ------------------------ |
| `connectivity_plus`           | `^7.1.1`                 |
| `file_picker`                 | `^11.0.2`                |
| `flutter_local_notifications` | `^21.0.0`                |
| `flutter_secure_storage`      | `^10.0.0`                |
| `go_router`                   | `^17.2.2`                |
| `local_auth`                  | `^3.0.1`                 |
| `mobile_scanner`              | `^7.2.0`                 |
| `pin_code_fields`             | `^9.3.0`                 |
| `share_plus`                  | `^12.0.2`                |
| `timezone`                    | `^0.11.0`                |

Code changes made in that pass — these explain why the call sites look the way
they do, and stay true regardless of the current constraint:

- `flutter_local_notifications` calls were moved to the named-argument form of
  `initialize`, `show`, `zonedSchedule`, and `cancel` (introduced in v21).
- `local_auth` calls were moved to `biometricOnly` and
  `persistAcrossBackgrounding` directly, replacing `AuthenticationOptions`
  (v3).
- `file_picker` calls were moved to the static `FilePicker.pickFiles` (v11).
- OTP input was moved off the removed `PinCodeTextField` API to
  `MaterialPinField`, with a retained `PinInputController`.
- Achievement sharing was moved to `SharePlus.instance.share(ShareParams(...))`.

<!-- vh:historical-end -->

## Current constraints

This document deliberately does not track them. Between P3 and 2026-08-06 the
table above drifted three separate times — `flutter_local_notifications`,
`flutter_secure_storage`, and `go_router` — while still reading as current
state. Duplicating a constraint whose home is a pubspec is what caused that.

Read current constraints from source:

- `apps/patient/pubspec.yaml`
- `apps/staff/pubspec.yaml`
- `packages/vhhealth_core/pubspec.yaml`

Resolved versions for the entire graph, including transitive packages, are in
the root `pubspec.lock`.

## Consolidated dependency pass — applied 2026-08-13

<!-- vh:historical-start 2026-08-13 consolidated dependency pass -->

The post-#865 pass upgraded every dependency that the current toolchain can
resolve safely in one graph. The Flutter-specific changes were:

| Component | Version applied |
| --------- | --------------- |
| `flutter_local_notifications` | `^22.3.0` |
| `flutter_web_auth_2` | `^5.1.0` |
| `go_router` | `^17.5.0` |
| `livekit_client` | `^2.11.0` |
| `permission_handler` | `^13.0.1` |
| `table_calendar` | `^3.2.1` |
| `file_picker` | `^11.0.3` |
| Melos | `^8.2.2` |
| Android Gradle Plugin | `8.13.2` |
| Gradle | `8.14.5` |
| Kotlin | `2.3.20` |
| Android compile SDK | `37` |

Both Android debug APKs built successfully with that toolchain. AGP 9.0.1 and
Gradle 9.1 were also tested, but upstream plugins that omit their Kotlin Gradle
plugin under AGP 9 failed to compile on Flutter 3.44.0. Flutter's built-in
Kotlin migration is only available from Flutter 3.47, so the AGP 8 toolchain
above is the newest safe bridge for the repository's pinned Flutter release.

<!-- vh:historical-end -->

## Deferred upgrades

Every entry below was re-verified on 2026-08-13 against the repository tree and
a live `dart pub outdated` run after the consolidated pass. Nothing here is
carried forward unchecked.

- **`vector_math` — held by the Flutter SDK, not by this repo.** The
  SDK-vendored `flutter` and `flutter_test` packages depend on an exact version,
  so the resolver cannot move it independently of the Flutter SDK.
- **`intl` — held by `flutter_localizations`.** It must move with a Flutter SDK
  release whose localization package advances the exact pin.
- **`build_runner` — held by the Flutter test graph.** Newer analyzer and
  build-runner releases require a newer `meta` patch than the pinned Flutter
  test package currently permits.
- **The Win32 plugin cohort must move together.** Stable `file_picker` still
  requires the older Win32 generation, which prevents the next majors of
  `device_info_plus`, `package_info_plus`, `share_plus`, and
  `flutter_secure_storage`, plus the next compatible `geolocator` patch, from
  resolving in one stable graph. The first compatible `file_picker` line is
  still prerelease-only, so forcing individual packages would trade a stable
  graph for a beta transitive base.
- **AGP 9 waits for Flutter's built-in Kotlin support.** Move the pinned Flutter
  SDK to a release with built-in Kotlin support, confirm all Android plugins use
  it correctly, and only then advance AGP and Gradle together.

Do not force any of these blindly. Re-derive the whole list before the next
migration wave:

```bash
dart pub outdated
dart pub upgrade --major-versions --dry-run
```

Then validate patient and staff Android release builds with signing and
production `--dart-define` values before acting on the result.

The next safe upgrade order is therefore:

1. Move Flutter to a release with built-in Kotlin support and re-run the full
   analyzer, test, code-generation, Android, web, and Windows matrix.
2. Migrate to built-in Kotlin and AGP 9 after every Android plugin compiles on
   that path.
3. Once a stable `file_picker` supports the newer Win32 generation, advance the
   Win32 plugin cohort as a single resolver and platform-build change.
4. Re-evaluate the SDK-owned `intl`, `vector_math`, `meta`, and `build_runner`
   ceilings after the Flutter move.

## Validation

```bash
dart run melos run analyze
dart run melos run test
dart run melos run codegen
flutter build apk --debug
flutter build web --release
node scripts/check-docs-plugin-versions.mjs
```
