// otp_widget.dart - Main widget file (Business logic only)
import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';
import 'package:vhhealth/features/auth/widgets/otp_ui_components.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:vhhealth/features/auth/services/otp_service.dart';
import 'dart:developer' as developer;

typedef OtpCredentialHandler =
    Future<void> Function(PhoneAuthCredential credential);

class OtpWidget extends StatefulWidget {
  final String phoneNumber;
  final VoidCallback onSuccess;
  final OtpService? otpService;
  final OtpCredentialHandler? credentialHandler;

  const OtpWidget({
    super.key,
    required this.phoneNumber,
    required this.onSuccess,
    this.otpService,
    this.credentialHandler,
  });

  @override
  State<OtpWidget> createState() => _OtpWidgetState();
}

class _OtpWidgetState extends State<OtpWidget> {
  final TextEditingController otpController = TextEditingController();
  final _secureStorage = VHSecureStorage.instance;
  late final OtpService _otpService;

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

  /// Inline error shown under the OTP field (and announced by screen
  /// readers via the field's live region). Cleared as soon as the user
  /// edits the code.
  String? errorText;

  @override
  void initState() {
    super.initState();
    _otpService = widget.otpService ?? OtpService();
    // Post-frame: _sendOTP reads AppLocalizations (an inherited widget),
    // which cannot be looked up from initState.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _sendOTP();
    });
  }

  @override
  void dispose() {
    otpController.dispose();
    super.dispose();
  }

  Future<void> _sendOTP() async {
    final l = AppLocalizations.of(context)!;
    setState(() {
      otpSent = false;
      isResending = true;
      errorText = null;
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
        _showMessage("${l.otpOtpSentTo} ${_maskPhone(widget.phoneNumber)}");
      },
      onAutoRetrieved: (credential, smsCode) async {
        if (!mounted || isVerifying) return;
        setState(() {
          isVerifying = true;
          errorText = null;
        });

        // pin_code_fields invokes onChanged/onCompleted synchronously when
        // controller.text changes. Set the single-flight guard first so the
        // auto-retrieved credential cannot race a second manual exchange.
        otpController.text = smsCode;
        _showMessage(l.otpAutoFilled);
        try {
          await _authenticate(credential);
        } finally {
          if (mounted) setState(() => isVerifying = false);
        }
      },
      onError: (error) {
        _showMessage(error);
        if (mounted) setState(() => isResending = false);
      },
    );
  }

  Future<void> _verifyOTP() async {
    if (isVerifying) return;

    final l = AppLocalizations.of(context)!;
    final otp = otpController.text.trim();
    if (otp.length != 6) {
      _setInlineError(l.otpOtpMustBe6Digits);
      return;
    }

    if (verificationId == null) {
      _setInlineError(l.otpVerificationSessionExpired);
      return;
    }

    setState(() {
      isVerifying = true;
      errorText = null;
    });

    try {
      final credential = PhoneAuthProvider.credential(
        verificationId: verificationId!,
        smsCode: otp,
      );
      await _authenticate(credential);
    } catch (e) {
      _setInlineError(l.otpInvalidTryAgain);
      developer.log("OTP verification error: $e", name: 'OtpWidget');
    }

    if (mounted) setState(() => isVerifying = false);
  }

  Future<void> _authenticate(PhoneAuthCredential credential) {
    return (widget.credentialHandler ?? _handleFirebaseAuthSuccess)(credential);
  }

  Future<void> _handleFirebaseAuthSuccess(
    PhoneAuthCredential credential,
  ) async {
    if (!mounted) return;
    final l = AppLocalizations.of(context)!;
    try {
      await FirebaseAuth.instance.signInWithCredential(credential);
      _showMessage(l.otpVerifiedSuccess);

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
        _setInlineError(l.otpBackendLoginFailed);
        return;
      }

      developer.log(
        "Backend login complete - triggering navigation",
        name: 'OtpWidget',
      );
      widget.onSuccess();
    } catch (e) {
      _setInlineError(l.otpAuthenticationFailed);
      developer.log("Firebase auth error: $e", name: 'OtpWidget');
    }
  }

  /// Surfaces an error inline under the OTP field instead of a transient
  /// snackbar, so it persists until the user edits the code and is
  /// announced by the field's live region (audit H9).
  void _setInlineError(String msg) {
    if (mounted) setState(() => errorText = msg);
  }

  void _showMessage(String msg) {
    if (mounted) {
      // Live-region snackbar so TalkBack/VoiceOver announce transient
      // confirmations ("OTP sent", "OTP verified") when they appear.
      LiveRegionSnackBar.show(context, message: msg);
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
      errorText: errorText,
      onVerifyPressed: _verifyOTP,
      onResendPressed: _sendOTP,
      onOtpChanged: (value) {
        if (errorText != null) {
          setState(() => errorText = null);
        }
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
