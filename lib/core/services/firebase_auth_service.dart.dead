import 'package:firebase_auth/firebase_auth.dart';

class FirebaseAuthService {
  final FirebaseAuth _auth = FirebaseAuth.instance;

  /// ✅ Send OTP to the phone number using Firebase
  Future<void> verifyPhoneNumber(
  String phoneNumber, {
  required void Function(String verificationId, int? resendToken) onCodeSent,
  required void Function(String errorMessage) onFailed,
}) async {
    try {
      await _auth.verifyPhoneNumber(
        phoneNumber: phoneNumber,
        timeout: const Duration(seconds: 60),
        verificationCompleted: (PhoneAuthCredential credential) async {
          await _auth.signInWithCredential(credential);
        },
        verificationFailed: (FirebaseAuthException e) {
          onFailed(e.message ?? 'Verification failed');
        },
        codeSent: (String verificationId, int? resendToken) {
          onCodeSent(verificationId, resendToken);
        },
        codeAutoRetrievalTimeout: (String verificationId) {},
      );
    } catch (e) {
      onFailed(e.toString());
    }
  }

  /// ✅ Verify OTP manually
  Future<UserCredential> verifyOTP({
    required String verificationId,
    required String smsCode,
  }) async {
    final credential = PhoneAuthProvider.credential(
      verificationId: verificationId,
      smsCode: smsCode,
    );
    return await _auth.signInWithCredential(credential);
  }

  /// ✅ Get Firebase ID Token
  Future<String?> getIdToken() async {
    final user = _auth.currentUser;
    return await user?.getIdToken();
  }

  /// ✅ Sign out
  Future<void> signOut() async {
    await _auth.signOut();
  }

  /// ✅ Check if Firebase is initialized and authenticated
  Future<bool> isInitialized() async {
    try {
      await _auth.authStateChanges().first;
      return true;
    } catch (_) {
      return false;
    }
  }
}
