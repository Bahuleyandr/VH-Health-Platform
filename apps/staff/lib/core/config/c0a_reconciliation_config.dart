import 'package:vhhealth_core/config/security_config.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

import 'api_config.dart';

/// Tenant-stamped fallback ownership for the temporary C0A reconciliation
/// workflow.
///
/// Production builds must explicitly bind the configured tenant to the
/// clinical-safety-lead role. Development builds use the same stable role for
/// the active [TenantConfig] so local migration and reconciliation testing can
/// run without production configuration.
class C0AReconciliationConfig {
  C0AReconciliationConfig._();

  static const fallbackOwnerRoleCode = 'role:clinical_safety_lead';

  static const _configuredTenantId = String.fromEnvironment(
    'VH_C0A_RECONCILIATION_TENANT_ID',
  );
  static const _configuredFallbackOwner = String.fromEnvironment(
    'VH_C0A_RECONCILIATION_FALLBACK_OWNER',
  );

  static bool get isExplicitlyConfigured =>
      _configuredTenantId.isNotEmpty &&
      _configuredFallbackOwner == fallbackOwnerRoleCode;

  static String? reconciliationOwnerForTenant(String tenantId) {
    if (tenantId != TenantConfig.id) return null;
    if (isExplicitlyConfigured) {
      return _configuredTenantId == tenantId ? _configuredFallbackOwner : null;
    }
    return SecurityConfig.isProduction ? null : fallbackOwnerRoleCode;
  }

  static void registerBeforeQueueStartup() {
    _verifyProductionConfiguration();
    OfflineQueue.registerMetadataResolvers(
      tenantIdResolver: () => TenantConfig.id,
      reconciliationOwnerResolver: reconciliationOwnerForTenant,
      currentActorUidResolver: ApiConfig.getStaffUid,
      currentActorRoleResolver: ApiConfig.getRole,
    );
  }

  static void _verifyProductionConfiguration() {
    if (!SecurityConfig.isProduction) {
      if (_configuredTenantId.isNotEmpty &&
          _configuredTenantId != TenantConfig.id) {
        throw StateError(
          'C0A reconciliation tenant does not match VH_TENANT_ID.',
        );
      }
      if (_configuredFallbackOwner.isNotEmpty &&
          _configuredFallbackOwner != fallbackOwnerRoleCode) {
        throw StateError(
          'C0A reconciliation fallback owner must be '
          '$fallbackOwnerRoleCode.',
        );
      }
      return;
    }

    if (!isExplicitlyConfigured || _configuredTenantId != TenantConfig.id) {
      throw StateError(
        'Production C0A requires '
        'VH_C0A_RECONCILIATION_TENANT_ID=VH_TENANT_ID and '
        'VH_C0A_RECONCILIATION_FALLBACK_OWNER='
        '$fallbackOwnerRoleCode.',
      );
    }
  }
}
