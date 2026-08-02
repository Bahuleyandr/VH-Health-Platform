import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The staff app resolves its readiness tenant from the same build stamp
/// (`ClientReadinessService._configuredTenantId` returns `TenantConfig.id`)
/// and ships from the same release workflow, so it carries both build-config
/// hazards the patient app does and needs both startup guards.
///
/// See the sibling test in `apps/patient` for why the wiring itself is pinned:
/// `ClientReadinessConfig.verifyOrThrow` shipped with no production call site.
void main() {
  late String source;

  setUpAll(() {
    source = File('lib/main.dart').readAsStringSync();
  });

  test('staff startup invokes TenantConfig.verifyOrThrow', () {
    expect(
      source.contains('TenantConfig.verifyOrThrow('),
      isTrue,
      reason:
          'apps/staff/lib/main.dart must call TenantConfig.verifyOrThrow() '
          'during startup, beside SecurityConfig.verifyOrWarn().',
    );
  });

  test('staff startup invokes ClientReadinessConfig.verifyOrThrow', () {
    expect(
      source.contains('ClientReadinessConfig.verifyOrThrow('),
      isTrue,
      reason:
          'apps/staff/lib/main.dart must call '
          'ClientReadinessConfig.verifyOrThrow() during startup so a production '
          'build carrying the wrong clock-skew tolerance fails loudly instead '
          'of silently falling back to the bundled default.',
    );
  });
}
