import 'package:firebase_auth/firebase_auth.dart';
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

  group('OTP verification error messages', () {
    test('maps a wrong code to actionable copy, not the raw exception', () {
      final message = OtpService.userMessageForOtpVerificationCode(
        'invalid-verification-code',
      );
      expect(message, 'That OTP is incorrect. Check the code and try again.');
      expect(message.contains('firebase_auth'), isFalse);
    });

    test('maps expired-session codes to a resend hint', () {
      for (final code in <String>[
        'invalid-verification-id',
        'session-expired',
        'code-expired',
      ]) {
        expect(
          OtpService.userMessageForOtpVerificationCode(code),
          'This OTP has expired. Tap Resend to get a new code.',
        );
      }
    });

    test('maps throttling and quota errors', () {
      expect(
        OtpService.userMessageForOtpVerificationCode('too-many-requests'),
        'Too many verification attempts. Please wait and try again.',
      );
      expect(
        OtpService.userMessageForOtpVerificationCode('quota-exceeded'),
        'OTP service is temporarily unavailable. Please try again later.',
      );
    });

    test('maps network errors', () {
      expect(
        OtpService.userMessageForOtpVerificationCode('network-request-failed'),
        'Network error while verifying OTP. Check your connection and try again.',
      );
    });

    test('maps disabled accounts', () {
      expect(
        OtpService.userMessageForOtpVerificationCode('user-disabled'),
        'This account has been disabled. Please contact the hospital for help.',
      );
    });

    test('uses a safe fallback for unknown errors', () {
      expect(
        OtpService.userMessageForOtpVerificationCode('internal-error'),
        'Unable to verify OTP. Please try again.',
      );
    });
  });

  group('sendOTP resend-token handling', () {
    test(
      'surfaces the forceResendingToken from codeSent to the caller',
      () async {
        final service = OtpService(
          verifyPhoneNumber:
              ({
                required phoneNumber,
                required verificationCompleted,
                required verificationFailed,
                required codeSent,
                required codeAutoRetrievalTimeout,
                int? forceResendingToken,
              }) async {
                codeSent('verification-id-1', 42);
              },
        );

        String? receivedId;
        int? receivedToken;
        await service.sendOTP(
          phoneNumber: '+919876543210',
          onCodeSent: (id, token) {
            receivedId = id;
            receivedToken = token;
          },
          onAutoRetrieved: (_, _) {},
          onError: (_) => fail('should not error'),
        );

        expect(receivedId, 'verification-id-1');
        expect(receivedToken, 42);
      },
    );

    test('passes the stored token back to Firebase on resend', () async {
      final forwardedTokens = <int?>[];
      final service = OtpService(
        verifyPhoneNumber:
            ({
              required phoneNumber,
              required verificationCompleted,
              required verificationFailed,
              required codeSent,
              required codeAutoRetrievalTimeout,
              int? forceResendingToken,
            }) async {
              forwardedTokens.add(forceResendingToken);
              codeSent('verification-id', 42);
            },
      );

      int? token;
      // Initial send: no token yet.
      await service.sendOTP(
        phoneNumber: '+919876543210',
        onCodeSent: (_, t) => token = t,
        onAutoRetrieved: (_, _) {},
        onError: (_) {},
      );
      // Resend: caller passes the token from the first codeSent, and it must
      // reach Firebase's verifyPhoneNumber so the session is reused.
      await service.sendOTP(
        phoneNumber: '+919876543210',
        forceResendingToken: token,
        onCodeSent: (_, _) {},
        onAutoRetrieved: (_, _) {},
        onError: (_) {},
      );

      expect(forwardedTokens, [null, 42]);
    });

    test('maps verificationFailed callback errors to friendly copy', () async {
      final service = OtpService(
        verifyPhoneNumber:
            ({
              required phoneNumber,
              required verificationCompleted,
              required verificationFailed,
              required codeSent,
              required codeAutoRetrievalTimeout,
              int? forceResendingToken,
            }) async {
              verificationFailed(
                FirebaseAuthException(code: 'too-many-requests'),
              );
            },
      );

      String? errorMessage;
      await service.sendOTP(
        phoneNumber: '+919876543210',
        onCodeSent: (_, _) => fail('should not send'),
        onAutoRetrieved: (_, _) {},
        onError: (message) => errorMessage = message,
      );

      expect(
        errorMessage,
        'Too many verification attempts. Please wait and try again.',
      );
    });
  });
}
