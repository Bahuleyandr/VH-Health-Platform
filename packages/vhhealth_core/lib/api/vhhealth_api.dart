// lib/api/vhhealth_api.dart
//
// Public entry point for the OpenAPI-generated API models + client.
//
// The generated files live in `lib/api/generated/` and are re-exported here.
// Running `dart run build_runner build --delete-conflicting-outputs` from the
// vhhealth-core package (or a corresponding `melos run codegen` once the
// monorepo lands) regenerates them from `swagger/openapi.json`.
//
// Until the first codegen run, this file intentionally fails to resolve the
// exports below — that's the signal to run the generator. See
// `docs/API_CODEGEN.md` for the full migration playbook.

// The generator names output files after the input — swagger/openapi.json
// produces generated/openapi.swagger.dart (models + the `Openapi`
// ChopperService) + openapi.enums.swagger.dart, and client_index.dart
// re-exports the `Openapi` client class.
export 'generated/openapi.swagger.dart';
export 'generated/openapi.enums.swagger.dart';
export 'generated/client_index.dart';
