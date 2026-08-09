// otp_widget.dart - Main widget file (Business logic only)
import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:vhhealth/features/auth/widgets/otp_ui_components.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:vhhealth/features/auth/services/otp_service.dart';
import 'package:vhhealth/features/auth/services/resend_cooldown.dart';
import 'dart:developer' as developer;

class OtpWidget extends StatefulWidget {
  final String phoneNumber;
  final VoidCallback onSuccess;

  const OtpWidget({
    super.key,
    required this.phoneNumber,
    required this.onSuccess,
  });

  @override
  State<OtpWidget> createState() => _OtpWidgetState();
}

class _OtpWidgetState extends State<OtpWidget> {
  final TextEditingController otpController = TextEditingController();
  final _secureStorage = VHSecureStorage.instance;
  final _otpService = OtpService();

  /// Returns a masked version of an E.164 phone number, keeping only the
  /// country code and last 2 digits visible.
  /// e.g. "+919876543210" → "+91 ******3210" (PAT-11)
  static String _maskPhone(String phone) {
    // Strip leading +
    final raw = phone.startsWith('+') ? phone.substring(1) : phone;
    // Heuristic: country codes are 1–3 digits. India (+91) → 2 digits.
    // We expose the full CC and the last 2 digits of the subscriber number.
    final ccLen = raw.startsWith('91')
        ? 2
        : raw.startsWith('1')
        ? 1
        : 2;
    if (raw.length <= ccLen + 2) return phone; // too short to mask
    final cc = raw.substring(0, ccLen);
    final last2 = raw.substring(raw.length - 2);
    final masked = '*' * (raw.length - ccLen - 2);
    return '+$cc $masked$last2';
  }

  String? verificationId;
  bool otpSent = false;
  bool isVerifying = false;
  bool isResending = false;

  /// Firebase resend token from the last codeSent callback. Passed back on
  /// resend so Firebase reuses the same verification session instead of
  /// starting a fresh one.
  int? _resendToken;
  final ResendCooldown _resendCooldown = ResendCooldown();

  @override
  void initState() {
    super.initState();
    _resendCooldown.addListener(_onCooldownTick);
    _sendOTP();
  }

  void _onCooldownTick() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    otpController.dispose();
    _resendCooldown.dispose();
    super.dispose();
  }

  Future<void> _sendOTP() async {
    // Belt-and-braces: the resend button is disabled during the cooldown,
    // but never let a queued tap restart the send early.
    if (_resendCooldown.isActive && otpSent) return;

    setState(() {
      otpSent = false;
      isResending = true;
    });

    // No need to store the result if you're not using it
    await _otpService.sendOTP(
      phoneNumber: widget.phoneNumber,
      forceResendingToken: _resendToken,
      onCodeSent: (id, resendToken) {
        if (!mounted) return;
        setState(() {
          verificationId = id;
          _resendToken = resendToken ?? _resendToken;
          otpSent = true;
          isResending = false;
        });
        _resendCooldown.start();
        _showMessage("OTP sent to ${_maskPhone(widget.phoneNumber)}");
      },
      onAutoRetrieved: (credential, smsCode) async {
        if (!mounted) return;
        otpController.text = smsCode;
        _showMessage("OTP auto-filled ✅");
        await _handleFirebaseAuthSuccess(credential);
      },
      onError: (error) {
        _showMessage(error);
        if (mounted) setState(() => isResending = false);
      },
    );
  }

  Future<void> _verifyOTP() async {
    final otp = otpController.text.trim();
    if (otp.length != 6) {
      _showMessage("Please enter a valid 6-digit OTP");
      return;
    }

    if (verificationId == null) {
      _showMessage("Verification ID missing. Please resend OTP.");
      return;
    }

    setState(() => isVerifying = true);

    final credential = PhoneAuthProvider.credential(
      verificationId: verificationId!,
      smsCode: otp,
    );
    // _handleFirebaseAuthSuccess catches and maps its own errors, so no
    // try/catch here — the old catch was dead code.
    await _handleFirebaseAuthSuccess(credential);

    if (mounted) setState(() => isVerifying = false);
  }

  Future<void> _handleFirebaseAuthSuccess(
    PhoneAuthCredential credential,
  ) async {
    try {
      await FirebaseAuth.instance.signInWithCredential(credential);
      _showMessage("OTP verified ✅");

      developer.log(
        "Firebase authentication successful - awaiting backend login",
        name: 'OtpWidget',
      );

      // Await backend login BEFORE navigating so JWT is stored first.
      final backendLoginOk = await _otpService.loginToBackendInBackground(
        secureStorage: _secureStorage,
        phoneNumber: widget.phoneNumber,
      );

      if (!backendLoginOk) {
        await FirebaseAuth.instance.signOut();
        _showMessage(
          "Phone verified, but hospital login failed. Please try again.",
        );
        return;
      }

      developer.log(
        "Backend login complete - triggering navigation",
        name: 'OtpWidget',
      );
      widget.onSuccess();
    } on FirebaseAuthException catch (e) {
      // Map Firebase codes (wrong code, expired session, throttling, network)
      // to friendly copy — never surface the raw exception string.
      _showMessage(OtpService.userMessageForOtpVerificationCode(e.code));
      developer.log("Firebase auth error (${e.code})", name: 'OtpWidget');
    } catch (e) {
      _showMessage("Unable to verify OTP. Please try again.");
      developer.log("Firebase auth error: $e", name: 'OtpWidget');
    }
  }

  void _showMessage(String msg) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg), duration: const Duration(seconds: 2)),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return OtpForm(
      phoneNumber: widget.phoneNumber,
      controller: otpController,
      otpSent: otpSent,
      isVerifying: isVerifying,
      isResending: isResending,
      resendCooldownSeconds: _resendCooldown.remainingSeconds,
      onVerifyPressed: _verifyOTP,
      onResendPressed: _sendOTP,
      onOtpChanged: (value) {
        if (value.length == 6 && !isVerifying) {
          _verifyOTP();
        }
      },
      onOtpCompleted: (value) {
        if (!isVerifying) {
          _verifyOTP();
        }
      },
    );
  }
}
