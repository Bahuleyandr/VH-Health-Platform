// otp_service.dart - Business logic service
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:vhhealth/core/services/backend_api_service.dart';
import 'dart:convert';

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

  /// Handle backend login in background (non-blocking)
  Future<void> loginToBackendInBackground({
    required FlutterSecureStorage secureStorage,
    required String phoneNumber,
  }) async {
    try {
      print("🔄 Starting background backend login...");
      
      final idToken = await FirebaseAuth.instance.currentUser?.getIdToken();
      if (idToken == null) {
        print("❌ No Firebase ID token available for backend login");
        return;
      }

      final response = await BackendApiService.firebaseLogin(idToken);
      
      // Check if response is valid
      if (response.body.isEmpty) {
        print("⚠️ Backend returned empty response");
        return;
      }
      
      final decoded = jsonDecode(response.body);

      // Safely access nested data
      final isNewUser = decoded['isNewUser'] ?? false;
      final jwt = decoded['token'];
      final userPhone = decoded['user']?.isNotEmpty == true ? decoded['user']['phone'] : null;

      if (jwt != null && userPhone != null) {
        await secureStorage.write(key: 'jwt', value: jwt);
        await secureStorage.write(key: 'phone', value: userPhone);
        await secureStorage.write(key: 'isNewUser', value: isNewUser.toString());
        
        print("✅ Backend login completed successfully");
        print("📱 Phone: $userPhone, New User: $isNewUser");
      } else {
        print("⚠️ Backend response missing required fields");
        print("📋 Response structure: ${decoded.keys.toList()}");
      }
      
    } catch (e) {
      print("❌ Background backend login failed: $e");
      
      // Store basic Firebase info as fallback
      final user = FirebaseAuth.instance.currentUser;
      if (user != null) {
        await secureStorage.write(key: 'phone', value: phoneNumber);
        await secureStorage.write(key: 'firebase_uid', value: user.uid);
        print("💾 Stored basic Firebase user info as fallback");
      }
    }
  }
}