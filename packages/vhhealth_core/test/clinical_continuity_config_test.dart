import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/config/tenant_config.dart';

void main() {
  test('both continuity feature flags default OFF', () {
    expect(TenantConfig.clinicalContinuityCacheEnabled, isFalse);
    expect(TenantConfig.clinicalContinuityLocalUnlockEnabled, isFalse);
  });
}
