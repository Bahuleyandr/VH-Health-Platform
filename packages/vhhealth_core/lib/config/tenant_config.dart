// W6 T1 — per-tenant build stamp.
//
// A per-tenant build is produced with `--dart-define=VH_TENANT_SLUG=<slug>`
// (plus `--dart-define=VH_BASE_URL=https://<slug>.api.vhhealth.app/api/v1` for the
// per-tenant subdomain — see ApiConfig). An UNSTAMPED build is the default
// single-tenant build, byte-identical to today.
//
// The backend derives the ACTUAL tenant from the request Host subdomain (W4 —
// trust-by-topology), and treats client `x-tenant-*` as untrusted. So these
// constants are NOT sent as a header; they are for the CLIENT's own use:
// on-device cache namespacing (defense-in-depth), branding, and display.
class TenantConfig {
  TenantConfig._();

  /// Tenant slug baked in at build time. Empty ⇒ the default (single-tenant) build.
  static const String slug = String.fromEnvironment(
    'VH_TENANT_SLUG',
    defaultValue: '',
  );

  /// Tenant UUID baked in at build time. Defaults to the platform default tenant
  /// (matches the backend's DEFAULT_TENANT_ID), so an unstamped build is a NO-OP.
  static const String id = String.fromEnvironment(
    'VH_TENANT_ID',
    defaultValue: '00000000-0000-4000-8000-000000000001',
  );

  /// Optional per-tenant primary colour (e.g. '#1565C0'); empty ⇒ current theme.
  static const String primaryColorHex = String.fromEnvironment(
    'VH_TENANT_PRIMARY',
    defaultValue: '',
  );

  /// Inert unless explicitly enabled in the tenant build.
  static const bool clinicalContinuityCacheEnabled = bool.fromEnvironment(
    'VH_CLINICAL_CONTINUITY_CACHE_ENABLED',
    defaultValue: false,
  );

  /// Cannot enable local access by itself; the cache flag and a complete,
  /// verified signed policy are also required.
  static const bool clinicalContinuityLocalUnlockEnabled = bool.fromEnvironment(
    'VH_CLINICAL_CONTINUITY_LOCAL_UNLOCK_ENABLED',
    defaultValue: false,
  );

  /// True for an unstamped (default single-tenant) build.
  static bool get isDefaultTenant => slug.isEmpty;

  /// Namespace for on-device cache keys (defense-in-depth). 'default' for an
  /// unstamped build so existing persisted data keeps its current keys (NO-OP).
  static String get cacheNamespace => slug.isEmpty ? 'default' : slug;
}
