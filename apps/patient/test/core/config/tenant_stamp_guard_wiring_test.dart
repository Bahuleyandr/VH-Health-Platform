import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// `TenantConfig.verifyOrThrow` is only worth anything if startup actually
/// calls it.
///
/// This repo already shipped a guard that nobody invokes:
/// `ClientReadinessConfig.verifyOrThrow` is defined and unit-tested but has no
/// production call site, so it protects nothing. This test stops the tenant
/// stamp guard from decaying the same way — a mis-stamped build must refuse to
/// launch rather than sit in a permanent false outage that blocks every
/// hospital mutation including SOS.
void main() {
  test('patient startup invokes TenantConfig.verifyOrThrow', () {
    final source = File('lib/main.dart').readAsStringSync();
    expect(
      source.contains('TenantConfig.verifyOrThrow('),
      isTrue,
      reason:
          'apps/patient/lib/main.dart must call TenantConfig.verifyOrThrow() '
          'during startup, beside SecurityConfig.verifyOrWarn().',
    );
  });
}
