import 'package:firebase_auth/firebase_auth.dart';

/// Thin wrapper around [FirebaseAuth] that hides the nitty-gritty
/// of OTP work and returns human-readable error messages.
class AuthService {
  static final FirebaseAuth _auth = FirebaseAuth.instance;

  // ────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────

  /// Sends an SMS OTP to [phoneNumber].  
  /// Callback order:
  ///  • if SMS is sent → [onCodeSent]  
  ///  • if instant/auto verify succeeds → [onAutoVerified]  
  ///  • on any failure → [onError]
  static Future<void> sendOtp({
    required String phoneNumber,
    required void Function(String verificationId, int? resendToken) onCodeSent,
    required void Function(String errorMessage) onError,
    required void Function(UserCredential credential) onAutoVerified,
  }) async {
    final formatted = _normalisePhone(phoneNumber);

    await _auth.verifyPhoneNumber(
      phoneNumber: formatted,
      timeout: const Duration(seconds: 60),
      verificationCompleted: (PhoneAuthCredential cred) async {
        try {
          final userCred = await _auth.signInWithCredential(cred);
          onAutoVerified(userCred);
        } on FirebaseAuthException catch (e) {
          onError(_prettyFirebaseError(e));
        } catch (_) {
          onError('Unexpected error during automatic sign-in.');
        }
      },
      verificationFailed: (FirebaseAuthException e) {
        onError(_prettyFirebaseError(e));
      },
      codeSent: onCodeSent,
      codeAutoRetrievalTimeout: (_) {},
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────

  /// Adds the +91 prefix if missing.
  static String _normalisePhone(String raw) =>
      raw.trim().startsWith('+') ? raw.trim() : '+91${raw.trim()}';

  /// Maps Firebase error codes to user-friendly messages.
  static String _prettyFirebaseError(FirebaseAuthException e) {
    const Map<String, String> map = {
      'invalid-phone-number': 'The phone number format looks incorrect.',
      'too-many-requests': 'Too many attempts. Try again later.',
      'session-expired': 'Session expired. Request a new OTP.',
      'network-request-failed': 'Network error. Check your connection.',
    };
    return map[e.code] ?? (e.message ?? 'OTP verification failed.');
  }
}
