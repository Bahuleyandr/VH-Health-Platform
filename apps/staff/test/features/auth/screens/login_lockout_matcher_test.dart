// Lockout-detector precision (P3 hygiene 2026-08).
//
// The old matcher treated any message containing "temporarily" (or "locked",
// or "too many") as an account lockout, so a generic outage error rendered
// the amber account-locked UI. These tests pin the matcher to the actual
// staff lockout responses from the backend's staffAuthService and pin that
// outage / generic rate-limit wording stays on the ordinary error surface.
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/auth/screens/login_screen.dart';

void main() {
  group('looksLikeStaffLockoutMessage', () {
    test('matches the shared password/quick/PIN-backstop lockout', () {
      // staffAuthService._checkStaffLockout (STAFF_LOGIN_RATE_LIMITED) and
      // the PIN distributed-guessing backstop use identical wording.
      expect(
        looksLikeStaffLockoutMessage(
          'Account temporarily locked due to multiple failed attempts',
        ),
        isTrue,
      );
      // The transport appends a request-ref suffix to failure messages.
      expect(
        looksLikeStaffLockoutMessage(
          'Account temporarily locked due to multiple failed attempts '
          '· ref abcdef12',
        ),
        isTrue,
      );
    });

    test('matches the per-vantage PIN lockout', () {
      // staffAuthService._checkStaffPinLockout (STAFF_PIN_RATE_LIMITED).
      expect(
        looksLikeStaffLockoutMessage(
          'Too many failed PIN attempts from this device. '
          'Try again later or use password login.',
        ),
        isTrue,
      );
    });

    test('is case-insensitive', () {
      expect(
        looksLikeStaffLockoutMessage('ACCOUNT TEMPORARILY LOCKED'),
        isTrue,
      );
    });

    test('generic outage wording renders the ordinary error surface', () {
      expect(
        looksLikeStaffLockoutMessage('Service temporarily unavailable'),
        isFalse,
      );
      expect(
        looksLikeStaffLockoutMessage(
          'The server is temporarily overloaded. Please retry.',
        ),
        isFalse,
      );
    });

    test('plain rate-limit and credential errors are not lockouts', () {
      expect(
        looksLikeStaffLockoutMessage(
          'Too many requests, please try again later.',
        ),
        isFalse,
      );
      expect(looksLikeStaffLockoutMessage('Invalid credentials'), isFalse);
      expect(
        looksLikeStaffLockoutMessage(
          'This device is not registered. Sign in with your password first.',
        ),
        isFalse,
      );
      expect(looksLikeStaffLockoutMessage(''), isFalse);
    });
  });
}
