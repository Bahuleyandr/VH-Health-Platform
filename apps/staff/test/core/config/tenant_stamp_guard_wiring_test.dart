import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The staff app resolves its readiness tenant from the same build stamp
/// (`ClientReadinessService._configuredTenantId` returns `TenantConfig.id`),
/// so it carries the identical mis-stamp hazard as the patient app and needs
/// the identical startup guard.
///
/// See the sibling test in `apps/patient` for why wiring is pinned by a test:
/// `ClientReadinessConfig.verifyOrThrow` already exists in this repo with no
/// production call site.
void main() {
  test('staff startup invokes TenantConfig.verifyOrThrow', () {
    final source = File('lib/main.dart').readAsStringSync();
    expect(
      source.contains('TenantConfig.verifyOrThrow('),
      isTrue,
      reason:
          'apps/staff/lib/main.dart must call TenantConfig.verifyOrThrow() '
          'during startup, beside SecurityConfig.verifyOrWarn().',
    );
  });
}
