import 'dart:convert';
import 'dart:developer' as developer;

import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:vhhealth_core/config/api_config.dart';

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/session_timeout_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
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
  static const bool _devLoginEnabled = bool.fromEnvironment(
    'VH_DEV_LOGIN_ENABLED',
    defaultValue: false,
  );
  static const String _devLoginPhone = String.fromEnvironment(
    'VH_DEV_LOGIN_PHONE',
    defaultValue: '1234567890',
  );
  static const String _devLoginName = String.fromEnvironment(
    'VH_DEV_LOGIN_NAME',
    defaultValue: 'Dev Patient',
  );
  static const String _devLoginSecret = String.fromEnvironment(
    'VH_DEV_LOGIN_SECRET',
  );

  final _formKey = GlobalKey<FormState>();
  final _phoneController = TextEditingController();
  final _secureStorage = const FlutterSecureStorage();

  final bool _isLoading = false;
  bool _showOtpWidget = false;
  String? _submittedPhone;

  bool get _showDevLogin => kDebugMode || _devLoginEnabled;

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

  Future<void> _continueAsGuest() async {
    if (_isLoading) return;
    FocusScope.of(context).unfocus();
    final userProvider = context.read<UserProvider>();
    final sessionProvider = context.read<SessionTimeoutProvider>();
    await FirebaseAuth.instance.signOut();
    sessionProvider.pauseForGuest();
    await userProvider.setGuest();
    if (!mounted) return;
    context.go('/home');
  }

  /// Debug-only shortcut that skips Firebase OTP. Calls the backend's
  /// /auth/dev/patient-login (which is itself only mounted when
  /// NODE_ENV !== 'production'), stores the returned JWT, and navigates
  /// to the dashboard. Used for emulator / CI runs where a real phone-OTP
  /// round-trip cannot complete.
  Future<void> _devLogin() async {
    if (!_showDevLogin) return;
    if (_isLoading) return;

    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/auth/dev/patient-login');
      final resp = await http
          .post(
            url,
            headers: {
              ...ApiConfig.jsonHeaders,
              if (_devLoginSecret.isNotEmpty)
                'x-dev-login-secret': _devLoginSecret,
            },
            body: jsonEncode({
              'phone': _devLoginPhone,
              'name': _devLoginName,
              'deviceType': 'desktop',
            }),
          )
          .timeout(const Duration(seconds: 10));

      if (resp.statusCode != 200) {
        developer.log(
          'Dev login HTTP ${resp.statusCode}: ${resp.body}',
          name: 'Auth',
        );
        if (!mounted) return;
        // 401 = the dev/* routes aren't mounted; the operator forgot
        // ENABLE_DEV_AUTH=true. 404 = same shape but expressed differently
        // by the auth router. Steer the operator at the actual fix.
        final hint = resp.statusCode == 401 || resp.statusCode == 404
            ? 'Dev login is disabled on the backend. Set '
                  'ENABLE_DEV_AUTH=true on the backend and restart.'
            : 'Dev login failed (${resp.statusCode}).';
        _showSnackBar(hint, Theme.of(context).colorScheme.error);
        return;
      }

      final body = jsonDecode(resp.body) as Map<String, dynamic>;
      final data = body['data'] as Map<String, dynamic>?;
      final token = data?['accessToken'] as String?;
      final user = data?['user'] as Map<String, dynamic>?;
      final phone = (user?['phone'] as String?) ?? _devLoginPhone;
      final name = (user?['name'] as String?) ?? _devLoginName;
      final hospitalNumber =
          (user?['hospital_number'] ?? user?['hospitalNumber'] ?? '')
              .toString();
      final isNewUser = data?['isNewUser'] == true;

      if (token == null || token.isEmpty) {
        if (!mounted) return;
        _showSnackBar(
          'Dev login response missing token.',
          Theme.of(context).colorScheme.error,
        );
        return;
      }

      await _secureStorage.write(key: 'jwt', value: token);
      await _secureStorage.write(key: 'user_phone', value: phone);
      await _secureStorage.write(key: 'user_name', value: name);
      if (hospitalNumber.isNotEmpty) {
        await _secureStorage.write(
          key: 'hospital_number',
          value: hospitalNumber,
        );
      }
      await _secureStorage.write(key: 'isNewUser', value: isNewUser.toString());

      if (!mounted) return;
      // UserProvider is the single source of truth for identity — pages
      // that read it directly (Your Health guest-gate) treat empty as
      // "not logged in" otherwise.
      await context.read<UserProvider>().setUser(
        phone,
        name,
        hospitalNumber: hospitalNumber.isEmpty ? null : hospitalNumber,
      );
      if (!mounted) return;
      // /profile-setup needs the phone via state.extra so the form's
      // submit can pass it to /complete-profile.
      if (isNewUser) {
        context.go('/profile-setup', extra: phone);
      } else {
        context.go('/home');
      }
    } catch (e, st) {
      developer.log('Dev login error: $e', name: 'Auth', stackTrace: st);
      if (!mounted) return;
      _showSnackBar('Dev login error: $e', Theme.of(context).colorScheme.error);
    }
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
        developer.log('🎉 User authenticated successfully', name: 'Auth');
      }

      // Check stored user data to determine navigation
      final storedIsNewUser = await _secureStorage.read(key: 'isNewUser');
      // ignore: unused_local_variable
      final storedJwt = await _secureStorage.read(key: 'jwt');

      String targetRoute;

      if (storedIsNewUser != null) {
        // Backend login was successful, use its determination.
        // Route names must match app_router.dart exactly: /profile-setup
        // and /home are the canonical paths. Earlier this code wrote
        // '/profile/setup' (no such route) which then never matched the
        // string-equality check below, so new users were sent to /home
        // and skipped profile setup entirely.
        final isNewUser = storedIsNewUser.toLowerCase() == 'true';
        targetRoute = isNewUser ? '/profile-setup' : '/home';
        if (kDebugMode) {
          developer.log(
            '📊 Backend determined: ${isNewUser ? 'New User' : 'Existing User'}',
            name: 'Auth',
          );
        }
      } else {
        // Backend login might have failed, use fallback logic
        if (kDebugMode) {
          developer.log(
            '⚠️ Backend data not available, using fallback logic',
            name: 'Auth',
          );
        }

        // Simple fallback: check if we have any stored user data
        final storedPhone = await _secureStorage.read(key: 'user_phone');
        if (storedPhone != null && storedPhone != user.phoneNumber) {
          // Different user, likely existing
          targetRoute = '/home';
        } else {
          // Default to profile setup for safety
          targetRoute = '/profile-setup';
        }
      }

      if (kDebugMode) {
        developer.log('🧭 Navigating to: $targetRoute', name: 'Auth');
      }

      if (mounted) {
        // Store user data before navigation. UserProvider is the single
        // source of truth — guest-gated pages (Your Health) treat the
        // user as logged-in immediately, not "Guest".
        final phoneNumber = user.phoneNumber ?? '';
        final storedName =
            await _secureStorage.read(key: 'user_name') ?? 'User';
        final hospitalNumber =
            await _secureStorage.read(key: 'hospital_number') ?? '';
        if (!mounted) return;
        await context.read<UserProvider>().setUser(
          phoneNumber,
          storedName,
          hospitalNumber: hospitalNumber.isEmpty ? null : hospitalNumber,
        );
        if (!mounted) return;

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
      if (!mounted) return;
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
                                      : const Icon(
                                          Icons.send_outlined,
                                          size: 18,
                                        ),
                                  label: _isLoading
                                      ? Row(
                                          mainAxisAlignment:
                                              MainAxisAlignment.center,
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
                                    padding: EdgeInsets.symmetric(
                                      horizontal: 16,
                                    ),
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
                                  onPressed: _isLoading
                                      ? null
                                      : _continueAsGuest,
                                  style: OutlinedButton.styleFrom(
                                    shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(12),
                                    ),
                                  ),
                                  icon: const Icon(
                                    Icons.person_outline,
                                    size: 20,
                                  ),
                                  label: Text(
                                    l10n.authContinueAsGuest,
                                    style: const TextStyle(
                                      fontSize: 16,
                                      fontWeight: FontWeight.w500,
                                    ),
                                  ),
                                ),
                              ),
                              if (_showDevLogin) ...[
                                const SizedBox(height: 12),
                                SizedBox(
                                  width: double.infinity,
                                  height: 50,
                                  child: OutlinedButton.icon(
                                    onPressed: _isLoading ? null : _devLogin,
                                    style: OutlinedButton.styleFrom(
                                      shape: RoundedRectangleBorder(
                                        borderRadius: BorderRadius.circular(12),
                                      ),
                                      foregroundColor: Colors.deepOrange,
                                      side: const BorderSide(
                                        color: Colors.deepOrange,
                                      ),
                                    ),
                                    icon: const Icon(
                                      Icons.developer_mode,
                                      size: 20,
                                    ),
                                    label: Text(
                                      'Dev login $_devLoginPhone',
                                      style: const TextStyle(
                                        fontSize: 16,
                                        fontWeight: FontWeight.w500,
                                      ),
                                    ),
                                  ),
                                ),
                              ],
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
