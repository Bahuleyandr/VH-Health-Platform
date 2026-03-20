import 'dart:developer' as developer;

import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/navigation/app_router.dart';

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/core/widgets/phone_input_field.dart';
import 'package:vhhealth/core/widgets/terms_agreement_notice.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/features/auth/widgets/otp_widget.dart';

class LoginForm extends StatefulWidget {
  const LoginForm({super.key});

  @override
  State<LoginForm> createState() => _LoginFormState();
}

class _LoginFormState extends State<LoginForm> {
  final _formKey = GlobalKey<FormState>();
  final _phoneController = TextEditingController();
  final _secureStorage = const FlutterSecureStorage();

  bool _isLoading = false;
  bool _showOtpWidget = false;
  String? _submittedPhone;

  void _showSnackBar(String message, Color bgColor) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        behavior: SnackBarBehavior.floating,
        backgroundColor: bgColor,
      ),
    );
  }

  void _continueAsGuest() {
    if (_isLoading) return;
    AppRouter.setUserData('guest', 'Guest');
context.go('/home');
  }

  Future<void> _triggerSOS() async {
    if (_isLoading) return;
    FocusScope.of(context).unfocus();
    await SOSService.triggerSOS(context);
  }

  void _startOtpFlow() {
    if (_isLoading) return;
    FocusScope.of(context).unfocus();

    if (!_formKey.currentState!.validate()) return;

    final phone = _phoneController.text.trim();
    final fullPhone = '+91$phone';

    setState(() {
      _submittedPhone = fullPhone;
      _showOtpWidget = true;
    });
  }

  void _goBackToPhoneInput() {
    setState(() {
      _showOtpWidget = false;
      _submittedPhone = null;
    });
  }

  /// Handle successful OTP verification and determine navigation
  Future<void> _handleOtpSuccess() async {
    try {
      final user = FirebaseAuth.instance.currentUser;
      if (user == null) {
        _showSnackBar(
          "Authentication failed. Please try again.",
          Theme.of(context).colorScheme.error,
        );
        return;
      }

      if (kDebugMode) {
        developer.log('🎉 User authenticated: ${user.uid}', name: 'Auth');
        developer.log('📱 Phone: ${user.phoneNumber}', name: 'Auth');
      }

      // Check stored user data to determine navigation
      final storedIsNewUser = await _secureStorage.read(key: 'isNewUser');
      final storedJwt = await _secureStorage.read(key: 'jwt');
      
      String targetRoute;
      
      if (storedIsNewUser != null) {
        // Backend login was successful, use its determination
        final isNewUser = storedIsNewUser.toLowerCase() == 'true';
        targetRoute = isNewUser ? '/profile/setup' : '/dashboard';
        if (kDebugMode) {
          developer.log('📊 Backend determined: ${isNewUser ? 'New User' : 'Existing User'}', name: 'Auth');
        }
      } else {
        // Backend login might have failed, use fallback logic
        if (kDebugMode) {
          developer.log('⚠️ Backend data not available, using fallback logic', name: 'Auth');
        }
        
        // Simple fallback: check if we have any stored user data
        final storedPhone = await _secureStorage.read(key: 'phone');
        if (storedPhone != null && storedPhone != user.phoneNumber) {
          // Different user, likely existing
          targetRoute = '/dashboard';
        } else {
          // Default to profile setup for safety
          targetRoute = '/profile-setup';
        }
      }

      if (kDebugMode) {
        developer.log('🧭 Navigating to: $targetRoute', name: 'Auth');
      }

      if (mounted) {
        // Store user data before navigation
final phoneNumber = user.phoneNumber ?? '';
AppRouter.setUserData(phoneNumber, 'User'); // Name will be set later in profile setup

if (targetRoute == '/profile-setup') {
  context.go('/profile-setup', extra: phoneNumber);
} else {
  context.go('/home');
}
      }

    } catch (e) {
      if (kDebugMode) {
        developer.log('❌ Error in OTP success handler: $e', name: 'Auth');
      }
      _showSnackBar(
        "Login completed but navigation failed. Please restart the app.",
        Theme.of(context).colorScheme.error,
      );
    }
  }

  @override
  void dispose() {
    _phoneController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);

    return GestureDetector(
      onTap: () => FocusScope.of(context).unfocus(),
      child: SizedBox.expand(
        child: Stack(
          children: [
            SafeArea(
              child: Column(
                children: [
                  const SizedBox(height: 8),
                  Expanded(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 24,
                        vertical: 16,
                      ),
                      child: Form(
                        key: _formKey,
                        child: Column(
                          children: [
                            const SizedBox(height: 16),
                            
                            // Back button when showing OTP
                            if (_showOtpWidget)
                              Align(
                                alignment: Alignment.centerLeft,
                                child: IconButton(
                                  onPressed: _goBackToPhoneInput,
                                  icon: const Icon(Icons.arrow_back),
                                  tooltip: "Back to phone input",
                                ),
                              ),
                            
                            // Logo
                            Image.asset(
                              'assets/images/hospital_icon.png',
                              height: 100,
                            ),
                            const SizedBox(height: 16),
                            
                            // Title
                            Text(
                              _showOtpWidget 
                                ? "Verify Your Phone" 
                                : l10n.authLoginTitle,
                              style: theme.textTheme.headlineSmall,
                              textAlign: TextAlign.center,
                            ),
                            const SizedBox(height: 30),

                            // Phone Input (when not showing OTP)
                            if (!_showOtpWidget) ...[
                              PhoneInputField(
                                controller: _phoneController,
                                readOnly: _isLoading,
                              ),
                              const SizedBox(height: 24),
                              
                              // Send OTP Button
                              SizedBox(
                                width: double.infinity,
                                height: 50,
                                child: ElevatedButton.icon(
                                  onPressed: _isLoading ? null : _startOtpFlow,
                                  style: ElevatedButton.styleFrom(
                                    shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(12),
                                    ),
                                  ),
                                  icon: _isLoading
                                      ? const SizedBox.shrink()
                                      : const Icon(Icons.send_outlined, size: 18),
                                  label: _isLoading
                                      ? Row(
                                          mainAxisAlignment: MainAxisAlignment.center,
                                          children: [
                                            const SizedBox(
                                              width: 20,
                                              height: 20,
                                              child: CircularProgressIndicator(
                                                strokeWidth: 2,
                                              ),
                                            ),
                                            const SizedBox(width: 12),
                                            Text(l10n.authSendingOtp),
                                          ],
                                        )
                                      : Text(
                                          l10n.authGetOtp,
                                          style: const TextStyle(
                                            fontSize: 16,
                                            fontWeight: FontWeight.w600,
                                          ),
                                        ),
                                ),
                              ),
                            ],

                            // OTP Widget (when showing OTP)
                            if (_showOtpWidget && _submittedPhone != null)
                              OtpWidget(
                                phoneNumber: _submittedPhone!,
                                onSuccess: _handleOtpSuccess,
                              ),

                            const SizedBox(height: 24),

                            // Guest login (when not showing OTP)
                            if (!_showOtpWidget) ...[
                              const Row(
                                children: [
                                  Expanded(child: Divider()),
                                  Padding(
                                    padding: EdgeInsets.symmetric(horizontal: 16),
                                    child: Text(
                                      "OR",
                                      style: TextStyle(
                                        color: Colors.grey,
                                        fontWeight: FontWeight.w500,
                                      ),
                                    ),
                                  ),
                                  Expanded(child: Divider()),
                                ],
                              ),
                              const SizedBox(height: 16),
                              
                              SizedBox(
                                width: double.infinity,
                                height: 50,
                                child: OutlinedButton.icon(
                                  onPressed: _isLoading ? null : _continueAsGuest,
                                  style: OutlinedButton.styleFrom(
                                    shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(12),
                                    ),
                                  ),
                                  icon: const Icon(Icons.person_outline, size: 20),
                                  label: Text(
                                    l10n.authContinueAsGuest,
                                    style: const TextStyle(
                                      fontSize: 16,
                                      fontWeight: FontWeight.w500,
                                    ),
                                  ),
                                ),
                              ),
                            ],

                            const SizedBox(height: 24),
                            const TermsAgreementNotice(),
                            const SizedBox(height: 40),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            
            // SOS Button
            Positioned(
              bottom: 20,
              right: 20,
              child: FloatingActionButton(
                onPressed: _isLoading ? null : _triggerSOS,
                tooltip: l10n.authSosTooltip,
                backgroundColor: Colors.red,
                foregroundColor: Colors.white,
                child: const Icon(CupertinoIcons.heart_fill),
              ),
            ),
          ],
        ),
      ),
    );
  }
}