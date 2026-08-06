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

## Deferred upgrades

Every entry below was re-verified on 2026-08-06 — override and pin claims
against the repository tree, resolver claims against a live `dart pub outdated`
run on the dependency-majors tree (PR #752). Nothing here is carried forward
unchecked.

- **`permission_handler` — held back deliberately; the resolver is not the
  blocker.** `dart pub outdated` reports the next major as resolvable, so the
  constraint graph would allow it. It is held because upstream
  `permission_handler_android` 14.0.0 requires `compileSdk` 37, while both apps
  resolve `compileSdk` 36 from `flutter.compileSdkVersion` on the pinned
  Flutter 3.44.0 — and no CI lane builds Android, so a bad bump would surface
  only after merge, in the staging-deploy and release pipelines. It stays at
  the constraint recorded in the app pubspecs until the Flutter pin moves.
- **`vector_math` — held by the Flutter SDK, not by this repo.** The
  SDK-vendored `flutter` and `flutter_test` packages depend on it and each
  Flutter release pins an exact version (2.2.0 on Flutter 3.44.0, with 2.4.2
  latest upstream), so the resolver cannot move it whatever the app constraint
  allows. The P3 note attributed the hold to "the explicit workspace override";
  no such override exists anywhere in the tree.
- **`flutter_secure_storage` — a new major upstream that P3 predates.** The
  2026-08-06 resolver run shows 11.0.0 published while the dependency graph
  holds the workspace on the 10.x line. Separately, the P3 note recorded
  several `flutter_secure_storage_*` platform packages as "overridden" — none
  are. The only `dependency_overrides` in the repository are `lucide_icons`
  (root) and `geolocator_android` plus `flutter_plugin_android_lifecycle`
  (`apps/patient`), all path overrides unrelated to secure storage.
- **`device_info_plus` — still blocked by the dependency graph.** The resolver
  holds it at 12.4.0; 13.2.0 is published upstream but unreachable.
- **`share_plus` — still blocked by the dependency graph.** The resolver holds
  it at 12.0.2; 13.3.0 is published upstream but unreachable.

Do not force any of these blindly. Re-derive the whole list before the next
migration wave:

```bash
dart pub outdated
dart pub upgrade --major-versions --dry-run
```

Then validate patient and staff Android release builds with signing and
production `--dart-define` values before acting on the result.

## Validation

```bash
dart run melos run analyze
node scripts/check-docs-plugin-versions.mjs
```
