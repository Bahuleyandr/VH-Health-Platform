// test/core/services/patient_session_expiry_wiring_test.dart
//
// `logout_teardown_paths_test.dart` path 7 drives a real 4001 close through a
// RealtimeProvider it constructs itself, so it proves the HANDLER runs the full
// wipe. It cannot prove that production actually installs that handler — and
// the defect this closes was exactly that: `main.dart` built
// `RealtimeProvider()` with no callback, so `onSessionExpired?.call()` in
// `realtime_client.dart` hit a null and a server-side revocation left every
// byte of local PHI on the device.
//
// `_VHRootState` cannot be instantiated in a unit test (Firebase, screen
// protector, platform channels), so the wiring is pinned at the source level —
// same technique as `deep_link_platform_wiring_test.dart` pins the native
// deep-link manifests.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  late String mainSource;

  setUpAll(() {
    mainSource = File('lib/main.dart').readAsStringSync();
  });

  test('the patient RealtimeProvider is constructed with a session-expiry '
      'handler', () {
    final construction = RegExp(
      r'RealtimeProvider\(\s*onSessionExpired:\s*handlePatientSessionExpired\s*,?\s*\)',
      multiLine: true,
    );

    expect(
      construction.hasMatch(mainSource),
      isTrue,
      reason:
          'RealtimeClient fires onSessionExpired after a 4001 auth close whose '
          'refresh failed — the server-side revocation path. Without the '
          'callback the client only drops its two tokens and every local PHI '
          'store survives.',
    );
    expect(
      RegExp(r'RealtimeProvider\(\s*\)').hasMatch(mainSource),
      isFalse,
      reason: 'a bare RealtimeProvider() re-opens the unwired revocation gap',
    );
  });

  test('both session-death transports share one teardown entry point', () {
    // A second definition is how the two legs drift apart: the HTTP 401 leg
    // and the realtime 4001 leg must not be able to disagree about what a dead
    // session means.
    expect(
      mainSource,
      contains(
        'ApiClient.onSessionExpired = (_) => handlePatientSessionExpired',
      ),
    );
    expect(
      mainSource,
      isNot(contains('LogoutService.handleSessionExpired')),
      reason:
          'main.dart must route both transports through '
          'handlePatientSessionExpired rather than calling LogoutService '
          'directly on one leg only',
    );
  });
}
