import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/config/security_config.dart';

void main() {
  group('SecurityConfig', () {
    test('isProduction is false in test environment', () {
      // In test builds, PRODUCTION define is not set → defaults to false
      expect(SecurityConfig.isProduction, isFalse);
    });

    test('enableCertPinning mirrors isProduction', () {
      expect(SecurityConfig.enableCertPinning, SecurityConfig.isProduction);
    });

    test('pinnedCertFingerprints is currently empty (pre-production)', () {
      expect(SecurityConfig.pinnedCertFingerprints, isEmpty);
    });

    test('verifyOrWarn does not throw in non-production builds', () {
      // In test/debug builds, isProduction is false → no pinning enabled
      // so verifyOrWarn should not throw even with empty fingerprints
      expect(() => SecurityConfig.verifyOrWarn(), returnsNormally);
    });
  });
}
