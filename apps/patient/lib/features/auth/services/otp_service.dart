// otp_service.dart - Business logic service
import 'dart:convert';
import 'dart:developer' as developer;

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:vhhealth/core/services/backend_api_service.dart';

/// Signature of [FirebaseAuth.verifyPhoneNumber] (the subset this app uses).
/// Injectable so unit tests can drive the codeSent/verificationFailed paths
/// without a Firebase app.
typedef VerifyPhoneNumberFn =
    Future<void> Function({
      required String phoneNumber,
      required PhoneVerificationCompleted verificationCompleted,
      required PhoneVerificationFailed verificationFailed,
      required PhoneCodeSent codeSent,
      required PhoneCodeAutoRetrievalTimeout codeAutoRetrievalTimeout,
      int? forceResendingToken,
    });

class OtpService {
  OtpService({VerifyPhoneNumberFn? verifyPhoneNumber})
    : _verifyPhoneNumber = verifyPhoneNumber ?? _firebaseVerifyPhoneNumber;

  final VerifyPhoneNumberFn _verifyPhoneNumber;

  static Future<void> _firebaseVerifyPhoneNumber({
    required String phoneNumber,
    required PhoneVerificationCompleted verificationCompleted,
    required PhoneVerificationFailed verificationFailed,
    required PhoneCodeSent codeSent,
    required PhoneCodeAutoRetrievalTimeout codeAutoRetrievalTimeout,
    int? forceResendingToken,
  }) {
    return FirebaseAuth.instance.verifyPhoneNumber(
      phoneNumber: phoneNumber,
      verificationCompleted: verificationCompleted,
      verificationFailed: verificationFailed,
      codeSent: codeSent,
      codeAutoRetrievalTimeout: codeAutoRetrievalTimeout,
      forceResendingToken: forceResendingToken,
    );
  }

  /// Send OTP to phone number.
  ///
  /// [forceResendingToken] — pass the token surfaced by a previous
  /// [onCodeSent] when the user taps "Resend" so Firebase reuses the same
  /// verification session instead of starting a fresh one (which burns
  /// quota and can trip abuse throttling).
  Future<void> sendOTP({
    required String phoneNumber,
    required Function(String verificationId, int? resendToken) onCodeSent,
    required Function(PhoneAuthCredential, String) onAutoRetrieved,
    required Function(String) onError,
    int? forceResendingToken,
  }) async {
    try {
      await _verifyPhoneNumber(
        phoneNumber: phoneNumber,
        verificationCompleted: (credential) {
          final smsCode = credential.smsCode;
          if (smsCode != null) {
            onAutoRetrieved(credential, smsCode);
          }
        },
        verificationFailed: (e) {
          if (kDebugMode) {
            developer.log(
              'Firebase phone verification failed (${e.code})',
              name: 'Auth',
            );
          }
          onError(userMessageForFirebaseAuthCode(e.code));
        },
        codeSent: (id, resendToken) {
          onCodeSent(id, resendToken);
        },
        codeAutoRetrievalTimeout: (id) {
          // Handle timeout if needed
        },
        forceResendingToken: forceResendingToken,
      );
    } on FirebaseAuthException catch (e) {
      if (kDebugMode) {
        developer.log(
          'Firebase phone verification request failed (${e.code})',
          name: 'Auth',
        );
      }
      onError(userMessageForFirebaseAuthCode(e.code));
    } catch (e, stackTrace) {
      if (kDebugMode) {
        developer.log(
          'Unexpected phone verification failure',
          name: 'Auth',
          error: e,
          stackTrace: stackTrace,
        );
      }
      onError('Unable to send OTP. Please try again.');
    }
  }

  @visibleForTesting
  static String userMessageForFirebaseAuthCode(String code) {
    return switch (code) {
      'invalid-phone-number' =>
        'The phone number is invalid. Check it and try again.',
      'too-many-requests' =>
        'Too many verification attempts. Please wait and try again.',
      'quota-exceeded' =>
        'OTP service is temporarily unavailable. Please try again later.',
      'network-request-failed' =>
        'Network error while sending OTP. Check your connection and try again.',
      'app-not-authorized' ||
      'captcha-check-failed' ||
      'invalid-app-credential' ||
      'missing-client-identifier' =>
        'This app cannot send OTPs right now. Please update the app or contact support.',
      _ => 'Unable to send OTP. Please try again.',
    };
  }

  /// Friendly copy for [FirebaseAuthException] codes raised while verifying
  /// an entered OTP (`signInWithCredential`). Companion to
  /// [userMessageForFirebaseAuthCode], which covers the send step — without
  /// this, a wrong code surfaced the raw
  /// `[firebase_auth/invalid-verification-code] ...` string to the patient.
  static String userMessageForOtpVerificationCode(String code) {
    return switch (code) {
      'invalid-verification-code' =>
        'That OTP is incorrect. Check the code and try again.',
      'invalid-verification-id' ||
      'session-expired' ||
      'code-expired' => 'This OTP has expired. Tap Resend to get a new code.',
      'too-many-requests' =>
        'Too many verification attempts. Please wait and try again.',
      'quota-exceeded' =>
        'OTP service is temporarily unavailable. Please try again later.',
      'network-request-failed' =>
        'Network error while verifying OTP. Check your connection and try again.',
      'user-disabled' =>
        'This account has been disabled. Please contact the hospital for help.',
      _ => 'Unable to verify OTP. Please try again.',
    };
  }

  /// Exchange the Firebase ID token for the VH backend JWT.
  ///
  /// Firebase confirms phone ownership; the backend JWT is still required for
  /// patient data, ownership checks, dependents, and protected portal routes.
  Future<bool> loginToBackendInBackground({
    required FlutterSecureStorage secureStorage,
    required String phoneNumber,
  }) async {
    try {
      if (kDebugMode) {
        developer.log('🔄 Starting background backend login...', name: 'Auth');
      }

      final idToken = await FirebaseAuth.instance.currentUser?.getIdToken();
      if (idToken == null) {
        if (kDebugMode) {
          developer.log(
            '❌ No Firebase ID token available for backend login',
            name: 'Auth',
          );
        }
        return false;
      }

      final response = await BackendApiService.firebaseLogin(idToken);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        if (kDebugMode) {
          developer.log(
            '❌ Backend Firebase login failed: HTTP ${response.statusCode}',
            name: 'Auth',
          );
        }
        return false;
      }

      // Check if response is valid
      if (response.body.isEmpty) {
        if (kDebugMode) {
          developer.log('⚠️ Backend returned empty response', name: 'Auth');
        }
        return false;
      }

      final decoded = jsonDecode(response.body);

      // Safely access nested data from { success, data: { accessToken, user: { ... } } }
      final data = decoded['data'] as Map<String, dynamic>?;
      final user = data?['user'] as Map<String, dynamic>?;
      final isNewUser = data?['isNewUser'] ?? user?['isNewUser'] ?? false;
      final jwt = data?['accessToken'];
      // C-9 companion (audit 2026-06-18): the backend now returns a separate
      // type:'refresh' token. Persist it so VHHttpClient refreshes via the
      // { refreshToken } body path — the old bearer-rotation now 401s at
      // /refresh-token (which accepts type:'refresh' only), which would force
      // a re-login every time the 1h access token expires.
      final refreshToken = data?['refreshToken'];
      final userPhone = user?['phone'];
      final userName = user?['name'];
      final hospitalNumber =
          user?['hospital_number'] ?? user?['hospitalNumber'];

      if (jwt != null && userPhone != null) {
        await secureStorage.write(key: 'jwt', value: jwt);
        // Stored under the same key vhhealth_core AuthService.getRefreshToken()
        // reads, so VHHttpClient._performRefresh switches to the body path.
        if (refreshToken != null) {
          await secureStorage.write(
            key: 'refreshToken',
            value: refreshToken.toString(),
          );
        }
        await secureStorage.write(key: 'user_phone', value: userPhone);
        if (userName != null) {
          await secureStorage.write(
            key: 'user_name',
            value: userName.toString(),
          );
        }
        if (hospitalNumber != null) {
          await secureStorage.write(
            key: 'hospital_number',
            value: hospitalNumber.toString(),
          );
        }
        await secureStorage.write(
          key: 'isNewUser',
          value: isNewUser.toString(),
        );

        // Store user ID for appointment booking and other features.
        // Written under both keys so that screens reading 'patient_id'
        // (health summary, consultations, vitals) and those reading
        // 'user_id' (appointments, investigations) both find the value.
        final userId = user?['id'];
        if (userId != null) {
          await secureStorage.write(key: 'user_id', value: userId.toString());
          await secureStorage.write(
            key: 'patient_id',
            value: userId.toString(),
          );
        }
        final userUid = user?['uid'];
        if (userUid != null) {
          await secureStorage.write(
            key: 'firebase_uid',
            value: userUid.toString(),
          );
        }

        if (kDebugMode) {
          developer.log('✅ Backend login completed successfully', name: 'Auth');
          developer.log('📱 New User: $isNewUser', name: 'Auth');
        }
        return true;
      } else {
        if (kDebugMode) {
          developer.log(
            '⚠️ Backend response missing required fields',
            name: 'Auth',
          );
          developer.log(
            '📋 Response structure: ${decoded.keys.toList()}',
            name: 'Auth',
          );
        }
        return false;
      }
    } catch (e) {
      if (kDebugMode) {
        developer.log('❌ Background backend login failed: $e', name: 'Auth');
      }
      return false;
    }
  }
}
