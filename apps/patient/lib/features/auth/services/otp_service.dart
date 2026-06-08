// otp_service.dart - Business logic service
import 'dart:convert';
import 'dart:developer' as developer;

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:vhhealth/core/services/backend_api_service.dart';

class OtpService {
  /// Send OTP to phone number
  Future<void> sendOTP({
    required String phoneNumber,
    required Function(String) onCodeSent,
    required Function(PhoneAuthCredential, String) onAutoRetrieved,
    required Function(String) onError,
  }) async {
    try {
      await FirebaseAuth.instance.verifyPhoneNumber(
        phoneNumber: phoneNumber,
        verificationCompleted: (credential) async {
          final smsCode = credential.smsCode;
          if (smsCode != null) {
            onAutoRetrieved(credential, smsCode);
          }
        },
        verificationFailed: (e) {
          onError("Verification failed: ${e.message}");
        },
        codeSent: (id, _) {
          onCodeSent(id);
        },
        codeAutoRetrievalTimeout: (id) {
          // Handle timeout if needed
        },
      );
    } catch (e) {
      onError(e.toString());
    }
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
      final userPhone = user?['phone'];
      final userName = user?['name'];
      final hospitalNumber =
          user?['hospital_number'] ?? user?['hospitalNumber'];

      if (jwt != null && userPhone != null) {
        await secureStorage.write(key: 'jwt', value: jwt);
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
