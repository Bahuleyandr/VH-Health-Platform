import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/services/api_client.dart';

class AccountDeletionException implements Exception {
  final String message;
  final int? statusCode;
  final String? code;

  const AccountDeletionException(this.message, {this.statusCode, this.code});

  @override
  String toString() => message;
}

class AccountDeletionService {
  AccountDeletionService({FirebaseAuth? firebaseAuth})
    : _firebaseAuth = firebaseAuth ?? FirebaseAuth.instance;

  final FirebaseAuth _firebaseAuth;

  Future<void> sendFreshOtp({
    required String phoneNumber,
    required ValueChanged<String> onCodeSent,
    required ValueChanged<String> onAutoVerified,
    required ValueChanged<String> onError,
  }) async {
    await _firebaseAuth.verifyPhoneNumber(
      phoneNumber: phoneNumber,
      timeout: const Duration(seconds: 60),
      verificationCompleted: (credential) async {
        try {
          final token = await _signInAndGetFreshToken(credential);
          onAutoVerified(token);
        } catch (e) {
          onError(
            'Automatic OTP verification failed. Enter the code manually.',
          );
        }
      },
      verificationFailed: (e) {
        onError(e.message ?? 'Could not send OTP. Please try again.');
      },
      codeSent: (verificationId, _) {
        onCodeSent(verificationId);
      },
      codeAutoRetrievalTimeout: (_) {},
    );
  }

  Future<String> verifyOtpAndGetFreshToken({
    required String verificationId,
    required String smsCode,
  }) {
    final credential = PhoneAuthProvider.credential(
      verificationId: verificationId,
      smsCode: smsCode,
    );
    return _signInAndGetFreshToken(credential);
  }

  Future<String> _signInAndGetFreshToken(PhoneAuthCredential credential) async {
    final credentialResult = await _firebaseAuth.signInWithCredential(
      credential,
    );
    final token = await credentialResult.user?.getIdToken(true);
    if (token == null || token.isEmpty) {
      throw const AccountDeletionException(
        'Could not verify OTP. Please try again.',
        code: 'FRESH_REAUTH_TOKEN_MISSING',
      );
    }
    return token;
  }

  Future<void> deleteAccount({required String freshFirebaseIdToken}) async {
    final response = await ApiClient.delete(
      '/users/me/account',
      body: {'firebaseIdToken': freshFirebaseIdToken},
      timeout: const Duration(seconds: 20),
    );

    if (!response.isSuccess) {
      throw exceptionFromResponse(response);
    }
  }

  @visibleForTesting
  static AccountDeletionException exceptionFromResponse(ApiResponse response) {
    final raw = response.raw;
    String? code;
    if (raw is Map<String, dynamic>) {
      final details = raw['details'];
      if (details is Map<String, dynamic>) {
        code = details['code']?.toString();
      }
    }

    final fallback = code == 'ACTIVE_ADMISSION_BLOCKS_ACCOUNT_DELETION'
        ? 'Account deletion is blocked while an active admission is open.'
        : 'Could not delete account. Please try again.';

    return AccountDeletionException(
      response.failureMessage(fallback),
      statusCode: response.statusCode,
      code: code,
    );
  }
}
