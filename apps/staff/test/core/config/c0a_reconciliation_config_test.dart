import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/config/security_config.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_staff/core/config/c0a_reconciliation_config.dart';

void main() {
  group('C0AReconciliationConfig', () {
    test('uses only the stable clinical-safety-lead role code', () {
      expect(
        C0AReconciliationConfig.fallbackOwnerRoleCode,
        'role:clinical_safety_lead',
      );
    });

    test('never resolves the fallback for a different tenant', () {
      expect(
        C0AReconciliationConfig.reconciliationOwnerForTenant(
          '11111111-1111-4111-8111-111111111111',
        ),
        isNull,
      );
    });

    test(
      'development builds resolve the active tenant without a prod default',
      () {
        expect(SecurityConfig.isProduction, isFalse);
        expect(C0AReconciliationConfig.isExplicitlyConfigured, isFalse);
        expect(
          C0AReconciliationConfig.reconciliationOwnerForTenant(TenantConfig.id),
          C0AReconciliationConfig.fallbackOwnerRoleCode,
        );
      },
    );
  });
}
