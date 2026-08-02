// W6 T1 — per-tenant build stamp.
//
// A per-tenant build is produced by `scripts/build-tenant-client.sh`, which
// stamps `VH_TENANT_SLUG`, `VH_TENANT_ID` and `VH_BASE_URL` together and
// requires all three (see docs/TENANT_ONBOARDING_RUNBOOK.md). The per-tenant
// host is FLAT — `https://<slug>-api.vhhealth.app/api/v1`, not
// `<slug>.api.vhhealth.app`; the runbook and that script are the authority.
// An UNSTAMPED build is the default single-tenant build, byte-identical to
// today.
//
// `verifyOrThrow` below refuses to launch a build whose stamp cannot match the
// deployment it points at, because the readiness adapters compare the server's
// tenant to `id` with a strict `==`.
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

  /// The platform default tenant. Matches the backend's `DEFAULT_TENANT_ID`
  /// (`apps/backend/src/services/tenant/tenantService.js`).
  static const String defaultTenantId = '00000000-0000-4000-8000-000000000001';

  /// Tenant UUID baked in at build time. Defaults to the platform default tenant
  /// (matches the backend's DEFAULT_TENANT_ID), so an unstamped build is a NO-OP.
  static const String id = String.fromEnvironment(
    'VH_TENANT_ID',
    defaultValue: defaultTenantId,
  );

  /// Same shape the backend accepts for a tenant id.
  static final RegExp _uuidPattern = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    caseSensitive: false,
  );

  /// Fails closed on a build stamp that cannot possibly match the backend.
  ///
  /// The readiness adapters compare the server's tenant against [id] with a
  /// strict `==` (`ClientReadiness.isReadyForTenant`). A stamp that disagrees
  /// with the deployment the build points at can never reach `available`, and
  /// only two matching readiness successes reopen the client (C-D12 5.3), so
  /// the resulting outage is permanent: the app refuses every hospital-facing
  /// mutation, including SOS, while the backend is perfectly healthy. Refusing
  /// to launch is the louder, safer failure.
  ///
  /// Only unambiguous mis-stamps throw, so no legitimate build can trip this:
  ///
  /// * [id] absent/empty/malformed — notably `--dart-define=VH_TENANT_ID=`
  ///   with an unset CI variable yields `''`, NOT the default; and
  /// * a stamped [slug] carrying [defaultTenantId], which contradicts
  ///   [isDefaultTenant].
  ///
  /// Deliberately NOT checked: any relationship between the API base URL host
  /// and [slug]. A single-tenant deployment on its own domain is legitimate,
  /// and blocking that launch would be worse than the defect this prevents.
  /// That check belongs in the release workflow, which owns the naming
  /// convention.
  static void verifyOrThrow({
    String slug = TenantConfig.slug,
    String id = TenantConfig.id,
  }) {
    if (!_uuidPattern.hasMatch(id)) {
      throw StateError(
        'TenantConfig: VH_TENANT_ID must be a tenant UUID, got "$id". '
        'An unset build variable stamps an empty define rather than falling '
        'back to the default tenant — omit the --dart-define entirely for a '
        'default single-tenant build.',
      );
    }
    if (slug.isNotEmpty && id == defaultTenantId) {
      throw StateError(
        'TenantConfig: the build is stamped for tenant "$slug" but carries the '
        'platform default tenant id. Stamp VH_TENANT_ID with that tenant\'s '
        'UUID, or drop VH_TENANT_SLUG for a default single-tenant build.',
      );
    }
  }

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
