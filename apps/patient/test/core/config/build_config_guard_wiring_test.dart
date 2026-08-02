import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// A build-configuration guard is worth nothing unless startup actually calls
/// it.
///
/// `ClientReadinessConfig.verifyOrThrow` is the cautionary example: it was
/// written to fail production builds that omit the owner-approved clock-skew
/// value, was unit-tested, and then shipped with no production call site at
/// all — so it protected nothing. These tests pin both call sites so neither
/// guard can decay that way.
void main() {
  late String source;

  setUpAll(() {
    source = File('lib/main.dart').readAsStringSync();
  });

  // A stamp that cannot match the backend pins the app in a PERMANENT readiness
  // outage (C-D12 5.3) that blocks every hospital mutation including SOS.
  // Refusing to launch is the louder failure.
  test('patient startup invokes TenantConfig.verifyOrThrow', () {
    expect(
      source.contains('TenantConfig.verifyOrThrow('),
      isTrue,
      reason:
          'apps/patient/lib/main.dart must call TenantConfig.verifyOrThrow() '
          'during startup, beside SecurityConfig.verifyOrWarn().',
    );
  });

  test('patient startup invokes ClientReadinessConfig.verifyOrThrow', () {
    expect(
      source.contains('ClientReadinessConfig.verifyOrThrow('),
      isTrue,
      reason:
          'apps/patient/lib/main.dart must call '
          'ClientReadinessConfig.verifyOrThrow() during startup so a production '
          'build carrying the wrong clock-skew tolerance fails loudly instead '
          'of silently falling back to the bundled default.',
    );
  });
}
