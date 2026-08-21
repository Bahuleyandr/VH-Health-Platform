// test/core/navigation/backend_session_authority_test.dart
//
// Route authority in the Patient app comes from exactly one place: a validated
// backend session. Two surfaces can put a user in front of PHI without the
// router's ordinary redirect running — the redirect's own login predicate, and
// the splash screen's biometric fast-path — so both are pinned here.
//
// These assertions used to grep splash_screen.dart for a local
// `_hasValidJwtShape(jwt)` helper. That helper no longer exists: the JWT check
// was lifted out of the splash screen into PatientSessionAuthority, which is
// strictly stronger than the old shape test (bounded Patient claims — sub/jti/
// role/exp/nbf — plus expiry, plus the PAT-003 token-bound offline lease).
// The invariant is unchanged, so it is asserted here against that authority's
// BEHAVIOUR, with source assertions kept only for the wiring that proves each
// surface still routes its decision through it.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/patient_session_authority.dart';

void main() {
  test('router derives login state only from a validated backend session', () {
    final router = File('lib/core/navigation/app_router.dart')
        .readAsStringSync();

    // Login state is the backend session and nothing else.
    expect(router, contains('final isLoggedIn = hasBackendSession;'));

    // ...and that session is decided by PatientSessionAuthority, not by
    // reading a token out of storage and checking it is non-empty.
    expect(
      router,
      matches(
        RegExp(
          r'hasBackendSession\s*=\s*await\s+PatientSessionAuthority'
          r'[\s\S]{0,80}?currentSessionAllowsProtectedAccess\(\)',
        ),
      ),
    );

    // Fail-closed default: a storage failure must leave the user logged out.
    expect(router, contains('bool hasBackendSession = false;'));

    // A cached profile phone is an input to hydration, never proof of a
    // session. This is the exact regression that let a wiped-but-cached
    // account walk back into protected routes.
    expect(router, isNot(contains('providerPhone.isNotEmpty')));

    // /terms stays reachable while logged out, or the disclaimer gate
    // deadlocks against the redirect that sends unauthenticated users away.
    expect(
      router,
      matches(
        RegExp(
          r"isAuthRoute\s*=\s*location == '/login'"
          r"[\s\S]{0,40}?location == '/terms'",
        ),
      ),
    );
  });

  test('biometric splash unlock is gated on the same session authority', () {
    final splash = File('lib/features/splash/screens/splash_screen.dart')
        .readAsStringSync();

    // The splash screen validates the stored JWT through the authority rather
    // than trusting its presence.
    expect(
      splash,
      matches(
        RegExp(
          r'sessionAllowsProtectedAccess\s*=\s*await\s+PatientSessionAuthority'
          r'[\s\S]{0,80}?allowsProtectedAccess\(jwt\)',
        ),
      ),
    );

    // ...and the biometric fast-path is gated on that verdict, so a successful
    // fingerprint cannot admit a user whose backend session is invalid.
    expect(
      splash,
      matches(
        RegExp(
          r"biometricEnabled == 'true'"
          r'[\s\S]{0,160}?sessionAllowsProtectedAccess',
        ),
      ),
    );
  });

  test(
    'the shared session gate refuses opaque, foreign-role and expired tokens',
    () async {
      final now = DateTime.utc(2026, 1, 1);
      final nowSeconds = now.millisecondsSinceEpoch ~/ 1000;
      final authority = PatientSessionAuthority.forTesting(
        // No offline lease is stored, so PAT-003 cannot extend anything here.
        read: (_) async => null,
        write: (_, _) async {},
        clock: () => now,
      );

      // No token at all.
      expect(await authority.allowsProtectedAccess(null), isFalse);
      expect(await authority.allowsProtectedAccess(''), isFalse);

      // An opaque non-JWT string. Mere presence of *something* under the 'jwt'
      // key is not a session.
      expect(await authority.allowsProtectedAccess('not-a-jwt'), isFalse);
      expect(await authority.allowsProtectedAccess('a.b'), isFalse);

      // Well-formed, unexpired, but not a Patient token.
      expect(
        await authority.allowsProtectedAccess(
          _jwt(role: 'STAFF', exp: nowSeconds + 3600),
        ),
        isFalse,
      );

      // Patient token missing the bounded claims the authority requires.
      expect(
        await authority.allowsProtectedAccess(
          _jwt(role: 'PATIENT', exp: nowSeconds + 3600, jti: ''),
        ),
        isFalse,
      );

      // Expired Patient token with no server-confirmed lease behind it.
      expect(
        await authority.allowsProtectedAccess(
          _jwt(role: 'PATIENT', exp: nowSeconds - 1),
        ),
        isFalse,
      );

      // The one case that may pass.
      expect(
        await authority.allowsProtectedAccess(
          _jwt(role: 'PATIENT', exp: nowSeconds + 3600),
        ),
        isTrue,
      );
    },
  );
}

String _jwt({
  required String role,
  required int exp,
  String sub = 'patient-1',
  String jti = 'token-1',
}) {
  String segment(Map<String, Object?> claims) =>
      base64UrlEncode(utf8.encode(jsonEncode(claims))).replaceAll('=', '');

  final header = segment({'alg': 'HS256', 'typ': 'JWT'});
  final payload = segment({'sub': sub, 'jti': jti, 'role': role, 'exp': exp});
  return '$header.$payload.signature';
}
