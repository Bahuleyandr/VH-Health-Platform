import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/auth/services/otp_service.dart';

void main() {
  group('OTP Firebase error messages', () {
    test('keeps invalid phone and throttling errors actionable', () {
      expect(
        OtpService.userMessageForFirebaseAuthCode('invalid-phone-number'),
        'The phone number is invalid. Check it and try again.',
      );
      expect(
        OtpService.userMessageForFirebaseAuthCode('too-many-requests'),
        'Too many verification attempts. Please wait and try again.',
      );
    });

    test('does not expose Firebase configuration details', () {
      for (final code in <String>[
        'app-not-authorized',
        'captcha-check-failed',
        'invalid-app-credential',
        'missing-client-identifier',
      ]) {
        expect(
          OtpService.userMessageForFirebaseAuthCode(code),
          'This app cannot send OTPs right now. Please update the app or contact support.',
        );
      }
    });

    test('uses a safe fallback for unknown errors', () {
      expect(
        OtpService.userMessageForFirebaseAuthCode('internal-error'),
        'Unable to send OTP. Please try again.',
      );
    });
  });
}
