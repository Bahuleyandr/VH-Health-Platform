// otp_widget.dart - Main widget file (Business logic only)
import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:vhhealth/features/auth/widgets/otp_ui_components.dart';
import 'package:vhhealth/features/auth/services/otp_service.dart';
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
  final _secureStorage = const FlutterSecureStorage();
  final _otpService = OtpService();

  String? verificationId;
  bool otpSent = false;
  bool isVerifying = false;
  bool isResending = false;

  @override
  void initState() {
    super.initState();
    _sendOTP();
  }

  @override
  void dispose() {
    otpController.dispose();
    super.dispose();
  }

  Future<void> _sendOTP() async {
    setState(() {
      otpSent = false;
      isResending = true;
    });

    // No need to store the result if you're not using it
    await _otpService.sendOTP(
      phoneNumber: widget.phoneNumber,
      onCodeSent: (id) {
        if (!mounted) return;
        setState(() {
          verificationId = id;
          otpSent = true;
          isResending = false;
        });
        _showMessage("OTP sent to ${widget.phoneNumber}");
      },
      onAutoRetrieved: (credential, smsCode) async {
        if (!mounted) return;
        otpController.text = smsCode;
        _showMessage("OTP auto-filled ✅");
        await _handleFirebaseAuthSuccess(credential);
      },
      onError: (error) {
        _showMessage("Error sending OTP: $error");
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

    try {
      final credential = PhoneAuthProvider.credential(
        verificationId: verificationId!,
        smsCode: otp,
      );
      await _handleFirebaseAuthSuccess(credential);
    } catch (e) {
      _showMessage("Invalid OTP. Please try again.");
      developer.log("OTP verification error: $e", name: 'OtpWidget');
    }

    if (mounted) setState(() => isVerifying = false);
  }

  Future<void> _handleFirebaseAuthSuccess(PhoneAuthCredential credential) async {
    try {
      await FirebaseAuth.instance.signInWithCredential(credential);
      _showMessage("OTP verified ✅");
      
      developer.log("Firebase authentication successful - awaiting backend login", name: 'OtpWidget');

      // Await backend login BEFORE navigating so JWT is stored first
      await _otpService.loginToBackendInBackground(
        secureStorage: _secureStorage,
        phoneNumber: widget.phoneNumber,
      );

      developer.log("Backend login complete - triggering navigation", name: 'OtpWidget');
      widget.onSuccess();
      
    } catch (e) {
      _showMessage("Authentication failed: ${e.toString()}");
      developer.log("Firebase auth error: $e", name: 'OtpWidget');
      rethrow;
    }
  }

  void _showMessage(String msg) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(msg),
          duration: const Duration(seconds: 2),
        ),
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