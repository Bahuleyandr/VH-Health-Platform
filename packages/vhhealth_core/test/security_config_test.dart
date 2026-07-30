import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/config/security_config.dart';

const currentPin = 'sha256/tDs+NegRunKt8CnNuDfrWXaK7ZZ6cVG50HfPjAHzEoA=';
const nextPin = 'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

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

    test('validates and deduplicates the flat current/next pin set', () {
      expect(
        SecurityConfig.validatePinSet(
          '$currentPin, $nextPin, $currentPin',
          requireOverlap: false,
        ),
        [currentPin, nextPin],
      );
      expect(
        SecurityConfig.validatePinSet(
          '$currentPin,$nextPin',
          requireOverlap: true,
        ),
        [currentPin, nextPin],
      );
    });

    test('production overlap rejects zero, one, or duplicate-only pins', () {
      for (final raw in ['', currentPin, '$currentPin,$currentPin']) {
        expect(
          () => SecurityConfig.validatePinSet(raw, requireOverlap: true),
          throwsStateError,
        );
      }
    });

    test('rejects malformed and non-SPKI pin syntax', () {
      for (final raw in [
        'not-prefixed',
        'sha256/short',
        'sha256/!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!=',
      ]) {
        expect(
          () => SecurityConfig.validatePinSet(raw, requireOverlap: false),
          throwsStateError,
        );
      }
    });
  });
}
