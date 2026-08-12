import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('router and biometric splash require a JWT-shaped backend session', () {
    final router = File(
      'lib/core/navigation/app_router.dart',
    ).readAsStringSync();
    final splash = File(
      'lib/features/splash/screens/splash_screen.dart',
    ).readAsStringSync();

    expect(router, contains('final isLoggedIn = hasBackendSession;'));
    expect(router, isNot(contains('providerPhone.isNotEmpty')));
    expect(router, contains("location == '/terms';"));
    expect(splash, contains('_hasValidJwtShape(jwt)'));
    expect(
      splash,
      matches(
        RegExp(
          r"biometricEnabled == 'true'[\s\S]{0,100}_hasValidJwtShape\(jwt\)",
        ),
      ),
    );
  });
}
