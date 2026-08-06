// lib/api/vhhealth_api.dart
//
// Public entry point for the OpenAPI-generated API models + client.
//
// The generated files live in `lib/api/generated/` and are re-exported here.
// `melos run codegen` (or `dart run build_runner build` inside this package)
// regenerates them from `swagger/openapi.json`.
//
// On a fresh clone (before the first codegen run) this file intentionally fails
// to resolve the exports below — that's the signal to run the generator. See
// `docs/API_CODEGEN.md` for the full migration playbook.

// The generator names output files after the input — swagger/openapi.json
// produces generated/openapi.swagger.dart (models + the `Openapi`
// ChopperService) + openapi.enums.swagger.dart, and client_index.dart
// re-exports the `Openapi` client class.
export 'generated/openapi.swagger.dart';
export 'generated/openapi.enums.swagger.dart';
export 'generated/client_index.dart';
export 'hl7_inbound_receive_request.dart';
