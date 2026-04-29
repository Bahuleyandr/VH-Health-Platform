# Flutter Plugin Major Migrations

P3 includes the breaking Flutter plugin migration pass that was intentionally
deferred until release health, CI, and security gates were stable.

## Applied And Analyzer-Clean

The following resolvable major upgrades were applied across patient, staff, and
`vhhealth_core` as applicable:

| Package                       | New constraint |
| ----------------------------- | -------------- |
| `connectivity_plus`           | `^7.1.1`       |
| `file_picker`                 | `^11.0.2`      |
| `flutter_local_notifications` | `^21.0.0`      |
| `flutter_secure_storage`      | `^10.0.0`      |
| `go_router`                   | `^17.2.2`      |
| `local_auth`                  | `^3.0.1`       |
| `mobile_scanner`              | `^7.2.0`       |
| `pin_code_fields`             | `^9.3.0`       |
| `share_plus`                  | `^12.0.2`      |
| `timezone`                    | `^0.11.0`      |

Code migrations completed:

- `flutter_local_notifications` calls now use v21 named arguments for
  `initialize`, `show`, `zonedSchedule`, and `cancel`.
- `local_auth` v3 calls use `biometricOnly` and `persistAcrossBackgrounding`
  directly instead of `AuthenticationOptions`.
- `file_picker` v11 calls use static `FilePicker.pickFiles`.
- OTP input moved from the removed `PinCodeTextField` API to `MaterialPinField`
  with a retained `PinInputController`.
- Achievement sharing moved to `SharePlus.instance.share(ShareParams(...))`.

Validation:

```bash
dart run melos run analyze
```

## Still Blocked Or Intentionally Deferred

These packages still show newer latest versions after the resolver pass:

- `device_info_plus` 13.x is still blocked by the current dependency graph.
- `share_plus` 13.x is still blocked; the resolver accepts 12.x.
- `vector_math` 2.3.x is still blocked by the explicit workspace override.
- Several `flutter_secure_storage_*` platform implementation packages remain
  overridden and need their own platform compatibility pass.

Do not force these blindly. Re-run `dart pub outdated` and
`dart pub upgrade --major-versions --dry-run` before the next migration wave,
then validate patient and staff Android release builds with signing and
production `--dart-define` values.
