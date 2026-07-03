// settings_controller.dart
import 'package:go_router/go_router.dart';
import 'package:firebase_auth/firebase_auth.dart';

import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:local_auth/local_auth.dart';
import 'package:permission_handler/permission_handler.dart';

import 'package:vhhealth/core/providers/language_provider.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/services/device_service.dart';
import 'package:vhhealth/core/services/firebase_session_service.dart';
import 'package:vhhealth/core/services/logout_service.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/features/settings/services/account_deletion_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class SettingsController {
  final void Function() refresh;
  final String phone;
  final String name;
  final String hospitalNumber;

  final LocalAuthentication _auth = LocalAuthentication();
  final _secureStorage = VHSecureStorage.instance;
  final AccountDeletionService _accountDeletionService =
      AccountDeletionService();

  // These will be initialized with proper context
  late BuildContext context;
  late AppLocalizations loc;
  late ThemeProvider tp;
  late LanguageProvider lang;

  bool biometricEnabled = false;
  bool biometricSupported = false;
  bool calendarGranted = false;
  bool locationGranted = false;
  bool cameraGranted = false;

  bool _initialized = false;

  // Context is passed later via initialize() — not the constructor.
  SettingsController(
    this.phone,
    this.name,
    this.refresh, {
    this.hospitalNumber = '',
  });

  void initialize(BuildContext ctx) {
    if (_initialized) return;
    context = ctx;
    loc = AppLocalizations.of(context)!;
    tp = ThemeProvider.of(context);
    lang = LanguageProvider.of(context);
    _initialized = true;
  }

  Future<void> loadAll() async {
    await _loadSettings();
    await _checkBiometricSupport();
    await _loadPermissionStatuses();
  }

  Future<void> _loadSettings() async {
    final biometricPref = await _secureStorage.read(key: 'biometric_enabled');
    biometricEnabled = biometricPref == 'true';
    refresh();
  }

  Future<void> _checkBiometricSupport() async {
    final canCheck = await _auth.canCheckBiometrics;
    final supported = await _auth.isDeviceSupported();
    biometricSupported = canCheck || supported;
    refresh();
  }

  Future<void> _loadPermissionStatuses() async {
    final calendar = await Permission.calendarFullAccess.status;
    final location = await Permission.locationWhenInUse.status;
    final camera = await Permission.camera.status;

    calendarGranted = calendar.isGranted || calendar.isLimited;
    locationGranted = location.isGranted || location.isLimited;
    cameraGranted = camera.isGranted || camera.isLimited;
    refresh();
  }

  void toggleTheme(bool isDark) =>
      tp.setThemeMode(isDark ? ThemeMode.dark : ThemeMode.light);

  void changeFontSize(double size) {
    tp.setFontSize(size);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('${loc.settingsFontSizeChanged} ${size.toInt()} pt'),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
    refresh();
  }

  void onLanguageChange(String? langCode) {
    if (langCode != null) lang.setLocale(langCode);
  }

  Future<void> toggleBiometric(bool value) async {
    final messenger = ScaffoldMessenger.of(context);

    if (value && !biometricSupported) {
      if (context.mounted) {
        messenger.showSnackBar(
          SnackBar(
            content: Text(loc.settingsBiometricNotSupported),
            backgroundColor: Theme.of(context).colorScheme.error,
          ),
        );
      }
      return;
    }

    if (value) {
      try {
        final auth = await _auth.authenticate(
          localizedReason: loc.settingsBiometricLogin,
          biometricOnly: true,
        );
        if (!auth) return;
      } catch (e) {
        if (context.mounted) {
          messenger.showSnackBar(
            SnackBar(
              content: Text('Authentication failed: $e'),
              backgroundColor: Theme.of(context).colorScheme.error,
            ),
          );
        }
        return;
      }
    }

    biometricEnabled = value;
    await _secureStorage.write(
      key: 'biometric_enabled',
      value: value.toString(),
    );
    if (value) {
      await _secureStorage.write(key: 'user_phone_for_biometric', value: phone);
    } else {
      await _secureStorage.delete(key: 'user_phone_for_biometric');
    }

    refresh();
  }

  Future<void> logout() async {
    final nav = Navigator.of(context);

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(loc.settingsLogoutConfirmation),
        content: Text(loc.settingsAreYouSureLogout),
        actions: [
          TextButton(
            onPressed: () => nav.pop(false),
            child: Text(loc.commonCancelButton),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
            ),
            onPressed: () => nav.pop(true),
            child: Text(loc.settingsConfirmLogout),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      // Unregister device and revoke session before clearing storage
      try {
        await Future.wait([
          DeviceService.unregisterDevice(phone),
          FirebaseSessionService.revokeSession(),
        ]);
      } catch (e) {
        debugPrint('Settings logout cleanup failed: $e');
      }
      await FirebaseAuth.instance.signOut();
      await LogoutService.logout();
      if (context.mounted) {
        context.go('/login');
      }
    }
  }

  Future<void> deleteAccount() async {
    if (phone.trim().isEmpty) {
      _showSnackBar('A verified phone number is required to delete account.');
      return;
    }

    final understood = await _showDeletionConsequences();
    if (understood != true) return;

    final freshToken = await _showFreshOtpDialog();
    if (freshToken == null) return;

    final confirmed = await _showFinalDeletionConfirm();
    if (confirmed != true) return;

    if (!context.mounted) return;
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => const AlertDialog(
        content: Row(
          children: [
            SizedBox(
              width: 24,
              height: 24,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            SizedBox(width: 16),
            Expanded(child: Text('Deleting account...')),
          ],
        ),
      ),
    );

    try {
      await _accountDeletionService.deleteAccount(
        freshFirebaseIdToken: freshToken,
      );
      await FirebaseAuth.instance.signOut();
      await LogoutService.logout();
      if (context.mounted) {
        Navigator.of(context, rootNavigator: true).pop();
        context.go('/login');
      }
    } on AccountDeletionException catch (e) {
      if (context.mounted) {
        Navigator.of(context, rootNavigator: true).pop();
      }
      _showSnackBar(_messageForDeletionError(e));
    } catch (e) {
      if (context.mounted) {
        Navigator.of(context, rootNavigator: true).pop();
      }
      _showSnackBar('Could not delete account. Please try again.');
    }
  }

  Future<bool?> _showDeletionConsequences() {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete account'),
        content: const Text(
          'This will remove your login access and clear your personal identity details from your account. Clinical, billing, and audit records are retained where the hospital is legally required to keep them. You cannot delete the account while an active admission is open.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(loc.commonCancelButton),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
            ),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Continue'),
          ),
        ],
      ),
    );
  }

  Future<String?> _showFreshOtpDialog() async {
    final otpController = TextEditingController();
    String? verificationId;
    String? errorText;
    bool started = false;
    bool closed = false;
    bool sending = true;
    bool verifying = false;

    Future<void> sendOtp(
      StateSetter setDialogState,
      BuildContext dialogContext,
    ) async {
      setDialogState(() {
        sending = true;
        errorText = null;
      });
      await _accountDeletionService.sendFreshOtp(
        phoneNumber: phone,
        onCodeSent: (id) {
          if (closed) return;
          setDialogState(() {
            verificationId = id;
            sending = false;
            errorText = null;
          });
        },
        onAutoVerified: (token) {
          if (closed || !dialogContext.mounted) return;
          closed = true;
          Navigator.of(dialogContext).pop(token);
        },
        onError: (message) {
          if (closed) return;
          setDialogState(() {
            sending = false;
            errorText = message;
          });
        },
      );
    }

    Future<void> verifyOtp(
      StateSetter setDialogState,
      BuildContext dialogContext,
    ) async {
      final otp = otpController.text.trim();
      if (otp.length != 6) {
        setDialogState(() => errorText = 'Enter the 6-digit OTP.');
        return;
      }
      if (verificationId == null) {
        setDialogState(() => errorText = 'OTP is not ready yet. Resend code.');
        return;
      }

      setDialogState(() {
        verifying = true;
        errorText = null;
      });
      try {
        final token = await _accountDeletionService.verifyOtpAndGetFreshToken(
          verificationId: verificationId!,
          smsCode: otp,
        );
        if (closed || !dialogContext.mounted) return;
        closed = true;
        Navigator.of(dialogContext).pop(token);
      } catch (e) {
        if (closed) return;
        setDialogState(() {
          verifying = false;
          errorText = 'OTP verification failed. Please try again.';
        });
      }
    }

    try {
      return await showDialog<String>(
        context: context,
        barrierDismissible: false,
        builder: (dialogContext) {
          return StatefulBuilder(
            builder: (ctx, setDialogState) {
              if (!started) {
                started = true;
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (!closed) {
                    sendOtp(setDialogState, dialogContext);
                  }
                });
              }

              return AlertDialog(
                title: const Text('Verify your phone'),
                content: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('We sent a fresh OTP to $phone.'),
                    const SizedBox(height: 16),
                    TextField(
                      controller: otpController,
                      enabled: !sending && !verifying,
                      keyboardType: TextInputType.number,
                      maxLength: 6,
                      decoration: InputDecoration(
                        labelText: 'OTP',
                        errorText: errorText,
                        counterText: '',
                      ),
                      onChanged: (value) {
                        if (value.trim().length == 6 && !verifying) {
                          verifyOtp(setDialogState, dialogContext);
                        }
                      },
                    ),
                    const SizedBox(height: 8),
                    if (sending)
                      const Row(
                        children: [
                          SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                          SizedBox(width: 8),
                          Text('Sending OTP...'),
                        ],
                      ),
                  ],
                ),
                actions: [
                  TextButton(
                    onPressed: verifying
                        ? null
                        : () {
                            closed = true;
                            Navigator.of(dialogContext).pop();
                          },
                    child: Text(loc.commonCancelButton),
                  ),
                  TextButton(
                    onPressed: sending || verifying
                        ? null
                        : () => sendOtp(setDialogState, dialogContext),
                    child: const Text('Resend'),
                  ),
                  FilledButton(
                    onPressed: sending || verifying
                        ? null
                        : () => verifyOtp(setDialogState, dialogContext),
                    child: verifying
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Verify'),
                  ),
                ],
              );
            },
          );
        },
      );
    } finally {
      closed = true;
      otpController.dispose();
    }
  }

  Future<bool?> _showFinalDeletionConfirm() {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Confirm deletion'),
        content: const Text(
          'This action cannot be undone. You will be logged out on this device and all other sessions will be revoked.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(loc.commonCancelButton),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
            ),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Delete account'),
          ),
        ],
      ),
    );
  }

  String _messageForDeletionError(AccountDeletionException e) {
    if (e.code == 'ACTIVE_ADMISSION_BLOCKS_ACCOUNT_DELETION') {
      return 'Account deletion is blocked while an active admission is open.';
    }
    return e.message;
  }

  void _showSnackBar(String message) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> triggerSOS() async {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(loc.authSosTriggered),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    }
    await SOSService.triggerSOS();
  }
}
