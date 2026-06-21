import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/config/tenant_config.dart';

void main() {
  group('TenantConfig (W6 T1)', () {
    // This test run has no --dart-define, so it exercises the UNSTAMPED (default
    // single-tenant) build — the NO-OP invariant. The stamped path is verified
    // by a build with `--dart-define=VH_TENANT_SLUG=<slug>` (the const resolves
    // at compile time), which a per-tenant build matrix supplies (W7).
    test('an unstamped build is the default tenant (NO-OP)', () {
      expect(TenantConfig.slug, '');
      expect(TenantConfig.isDefaultTenant, isTrue);
      expect(TenantConfig.cacheNamespace, 'default');
      expect(TenantConfig.primaryColorHex, '');
    });

    test('defaults to the platform default tenant id', () {
      expect(TenantConfig.id, '00000000-0000-4000-8000-000000000001');
    });
  });
}
