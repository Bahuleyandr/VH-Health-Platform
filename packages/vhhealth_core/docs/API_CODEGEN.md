# OpenAPI → Dart codegen playbook

> Generates typed models + a chopper client from the backend's OpenAPI
> spec so the Flutter apps stop passing `Map<String, dynamic>` around.

## What this gives you

- **Typed request/response models** for every endpoint in the backend's
  `openapi.json` (generated from the live backend router, synced via openapi:sync-core).
- **A chopper-based API client** you can instantiate once with the backend
  base URL + JWT interceptor — generated method per endpoint, typed params
  and return type.
- **Compile-time failure** when a backend field renames or a response shape
  changes — no more "Null check operator used on a null value" surfaced
  three screens deep at runtime.

## First-time setup

```bash
cd /workspace/VH-Health-Platform/packages/vhhealth_core

# 1. Sync the spec from the backend.
npm --prefix ../../apps/backend run openapi:sync-core

# 2. Install build deps (first time only).
flutter pub get

# 3. Run codegen. The --delete-conflicting-outputs flag is needed because
# swagger_dart_code_generator and json_serializable both touch some files.
dart run build_runner build --delete-conflicting-outputs
```

Generated output lands in `lib/api/generated/vhhealth_api.swagger.dart` +
friends. The barrel `lib/api/vhhealth_api.dart` re-exports them.

## Every time the backend spec changes

```bash
# From the repo root — sync the spec, then regenerate.
npm --prefix apps/backend run openapi:sync-core
melos run codegen          # → node scripts/codegen.mjs (reports drops, then build_runner)
```

`melos run codegen` runs `scripts/codegen.mjs`, which first prints any
operations dropped via `exclude_paths` (see "Dropped operations" below — there
is no silent truncation) and then runs `build_runner` in this package. You can
also run it directly inside the package:

```bash
cd packages/vhhealth_core
dart run build_runner build --delete-conflicting-outputs
```

Any breaking changes surface as Dart compile errors at call sites — chase
them one by one. This is the point.

## Using the generated client

```dart
import 'package:vhhealth_core/api/vhhealth_api.dart';
import 'package:vhhealth_core/config/api_config.dart';
import 'package:vhhealth_core/services/http_client.dart';

// Create once, reuse everywhere.
final api = VhhealthApi.create(
  baseUrl: Uri.parse(ApiConfig.baseUrl),
  interceptors: [
    // Injects Authorization + x-api-key, same headers VHHttpClient produces.
    VHAuthInterceptor(),
  ],
);

// Typed call — compiler enforces the body + response shapes.
final resp = await api.appointmentsBookPost(body: BookAppointmentRequest(
  doctorId: 42,
  appointmentDate: '2026-04-20',
  reason: 'follow-up',
));
if (resp.isSuccessful) {
  final Appointment appointment = resp.body!.data!;
  // appointment.id, appointment.status — all typed.
}
```

## Migration order (per-app)

The handwritten `Map<String, dynamic>` call sites can migrate gradually.
Pick one feature at a time:

1. **Easy win first** — endpoints with simple request + response shapes
   (e.g., `GET /users/me`, `GET /departments`). Shallow migration, high
   confidence.
2. **Feature-by-feature** — when touching a feature for a bug fix, migrate
   its API calls to the generated client in the same PR. Don't do a
   big-bang rewrite.
3. **Flaky areas last** — anything with non-standard response envelopes
   (old endpoints that predate the `{success, data, message}` convention)
   stays handwritten until the backend is fixed.

## Interaction with `VHHttpClient`

Both clients live side-by-side during the migration:

- `VHHttpClient` — handwritten, retry / refresh / 401 logic, takes a raw
  path and body. Used by call sites that haven't migrated.
- `VhhealthApi` (generated) — typed, driven by the spec. Reuses the same
  refresh flow via a chopper interceptor that delegates to
  `VHHttpClient.refreshAuthToken` on 401.

There's no race — both read/write the same JWT in `AuthService`. The only
difference is the type safety at call sites.

When every app call site has migrated, we can delete `VHHttpClient` and
route the chopper interceptor stack through `http` directly.

## Dropped operations (no silent truncation)

A handful of operations in the canonical spec **cannot** be emitted into the
generated chopper client and are dropped via `exclude_paths` in
`build.yaml`. This list is the source of truth — `melos run codegen` (which
runs `scripts/codegen.mjs`) prints the dropped paths on every run, derived
from `exclude_paths` × the spec, so a drop can never go unnoticed.

| Dropped path | Why | Consumers |
|---|---|---|
| `GET /api/v1/fhir/Patient/{id}/$everything` | The literal `$` in the path becomes Dart string interpolation inside `@GET(path: '...$everything')` → `chopper_generator` throws `FormatException: Not an instance of String` and silently skips writing the entire `openapi.swagger.chopper.dart` part, so `_$Openapi` never resolves and the **whole client fails to compile**. It is the only `$`-prefixed op in the entire 2,636-path spec. | None — niche FHIR bulk-export op, zero Flutter call sites. |

**Important:** the canonical spec (`apps/backend/src/docs/openapi.json`) and the
byte-synced core copy (`packages/vhhealth_core/swagger/openapi.json`) are left
untouched — the `$everything` operation stays in both (the
`check-core-spec-sync.mjs` gate enforces byte-identity). Only the generated Dart
client omits it. If a Flutter consumer ever needs `$everything`, call it through
`VHHttpClient` with the raw path instead of the typed client.

## Known limitations

- **Nullable by default** — the generator treats most fields as optional,
  which can be annoying for clearly-required fields. Fix on the backend:
  ensure the OpenAPI spec marks fields `required:` when they are.
- **Free-form jsonb columns** — endpoints that return `Map<String, dynamic>`
  for legitimately-freeform payloads (e.g., `e_prescriptions.medications`)
  generate as `Object?`. Cast on the call site.
- **Endpoints that aren't in the spec** (anything added without updating
  `openapi.json`) won't be generated. Sync discipline matters —
  the backend team should regenerate the spec on every schema change
  (`npm run openapi:generate` in the backend).

## Troubleshooting

### `build_runner` stalls or produces nothing

```bash
dart run build_runner clean
dart run build_runner build --delete-conflicting-outputs --verbose
```

### Generated file references a type that doesn't exist

Usually a typo in the OpenAPI spec — a `$ref` pointing to a schema that
isn't defined. Validate the spec:

```bash
# From /workspace/VH-Health-Platform/apps/backend
npm run swagger:validate
```

### Chopper interceptor compile errors after a Dart SDK bump

Bump `chopper` + `chopper_generator` together. They have a tight coupling
and mismatched versions produce confusing errors.
