export 'config/api_config.dart';
export 'config/client_readiness_config.dart';
export 'config/security_config.dart';
export 'config/tenant_config.dart';
export 'entitlements/product_entitlements.dart';
export 'exceptions/app_exception.dart';
export 'models/api_models.dart';
export 'models/api_response.dart';
export 'models/client_readiness.dart';
export 'models/clinical_continuity.dart';
export 'models/clinical_continuity_action_policy.dart';
export 'models/offline_write_entry.dart';
export 'models/offline_command_envelope.dart';
export 'services/api_retry.dart';
export 'services/auth_service.dart';
export 'services/secure_storage.dart';
export 'services/certificate_pinner.dart';
export 'services/client_readiness_service.dart';
export 'services/clinical_continuity_cache.dart';
export 'services/clinical_continuity_action_gate.dart';
export 'services/clinical_continuity_canonical_json.dart';
export 'services/clinical_continuity_facility_context.dart';
export 'services/clinical_continuity_policy_delivery.dart';
export 'services/clinical_continuity_reconciliation_client.dart';
export 'services/clinical_continuity_source.dart';
export 'services/clinical_continuity_trust_store.dart';
export 'services/clinical_continuity_verifier.dart';
export 'services/clinical_local_draft_store.dart';
export 'services/connectivity_service.dart';
export 'services/connectivity_sync_service.dart';
export 'services/offline_queue.dart';
export 'services/offline_action_ids.dart';
export 'services/offline_command_codec.dart';
export 'services/offline_write_containment.dart';
export 'services/biometric_auth_service.dart';
export 'services/crash_reporter.dart';
export 'services/device_integrity_service.dart';
export 'services/device_trust_service.dart';
export 'services/http_client.dart';
export 'services/idempotency_key.dart';
// NOTE (audit finding M12, 2026-06-10): services/message_crypto.dart
// (X25519+HKDF+AES-GCM "E2E" helper) was DELETED — it was never wired into
// the patient↔hospital messaging path, so it only created a false assurance
// that "secure messages" were end-to-end encrypted (they are server-side
// plaintext over TLS). If product later wants true E2E messaging, recover
// the module from git history and wire it in with a real key-distribution
// design — do not re-export it unwired.
export 'services/mtls_client_service.dart';
export 'services/realtime_client.dart';
export 'services/realtime_provider.dart';
export 'services/version_gate.dart';
// OpenAPI-generated API (models + chopper client). Re-exported from
// lib/api/vhhealth_api.dart once `dart run build_runner build` has
// generated the artefacts. The auth interceptor is always available.
export 'api/vh_auth_interceptor.dart';
export 'theme/app_theme.dart';
export 'theme/design_tokens.dart';
export 'theme/theme_colors.dart';
export 'utils/color_contrast.dart';
export 'utils/date_formatter.dart';
export 'utils/input_sanitizer.dart';
export 'utils/log_sanitizer.dart';
export 'utils/request_reference.dart';
export 'utils/safe_url_launcher.dart';
export 'utils/validators.dart';
export 'widgets/data_state_builder.dart';
export 'widgets/error_boundary.dart';
export 'widgets/offline_sync_badge.dart';
export 'widgets/signature_pad_field.dart';
export 'widgets/sos_button.dart';
