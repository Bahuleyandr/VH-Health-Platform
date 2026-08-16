// settings_controller.dart
import 'dart:async';

import 'package:go_router/go_router.dart';

import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:local_auth/local_auth.dart';
import 'package:permission_handler/permission_handler.dart';

import 'package:vhhealth/core/providers/language_provider.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/services/logout_service.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';
import 'package:vhhealth/features/settings/services/account_deletion_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class SettingsController {
  final void Function() refresh;
  final String phone;
  final String name;
  final String hospitalNumber;

  final LocalAuthentication _auth = LocalAuthentication();
  final _secureStorage = VHSecureStorage.instance;
  final AccountDeletionService _accountDeletionService;

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
  // [accountDeletionService] is injectable so the account-deletion logout
  // path is testable without Firebase.
  SettingsController(
    this.phone,
    this.name,
    this.refresh, {
    this.hospitalNumber = '',
    AccountDeletionService? accountDeletionService,
  }) : _accountDeletionService =
           accountDeletionService ?? AccountDeletionService();

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
        LiveRegionSnackBar.build(
          message: '${loc.settingsFontSizeChanged} ${size.toInt()} pt',
          announcementPrefix: loc.settingsAccessibility,
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
          LiveRegionSnackBar.build(
            message: loc.settingsBiometricNotSupported,
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
            LiveRegionSnackBar.build(
              message: 'Authentication failed: $e',
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

  // NOTE: the manual logout path lives in LogoutButton.confirmAndLogout —
  // the Settings screen renders a LogoutButton. A parallel logout() here was
  // dead code (never wired to any UI) and a second place for teardown steps
  // to silently drift, so it was removed (PAT-4).

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
    unawaited(
      showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (_) => AlertDialog(
          content: Row(
            children: [
              const SizedBox(
                width: 24,
                height: 24,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              const SizedBox(width: 16),
              Expanded(child: Text(loc.settingsDeletingAccount)),
            ],
          ),
        ),
      ),
    );

    try {
      await _accountDeletionService.deleteAccount(
        freshFirebaseIdToken: freshToken,
      );
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
      _showSnackBar(loc.settingsDeleteAccountFailed);
    }
  }

  Future<bool?> _showDeletionConsequences() {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(loc.settingsDeleteAccountTitle),
        content: Text(loc.settingsDeleteAccountConsequences),
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
            child: Text(loc.commonContinueButton),
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
        setDialogState(() => errorText = loc.settingsEnterOtp);
        return;
      }
      if (verificationId == null) {
        setDialogState(() => errorText = loc.settingsOtpNotReady);
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
          errorText = loc.settingsOtpVerificationFailed;
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
                title: Text(loc.settingsVerifyPhoneTitle),
                content: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(loc.settingsFreshOtpSent(phone)),
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
                      Row(
                        children: [
                          const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                          const SizedBox(width: 8),
                          Text(loc.settingsSendingOtp),
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
                    child: Text(loc.settingsResendOtp),
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
                        : Text(loc.settingsVerifyButton),
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
        title: Text(loc.settingsConfirmDeletionTitle),
        content: Text(loc.settingsConfirmDeletionBody),
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
            child: Text(loc.settingsDeleteAccountButton),
          ),
        ],
      ),
    );
  }

  String _messageForDeletionError(AccountDeletionException e) {
    if (e.code == 'ACTIVE_ADMISSION_BLOCKS_ACCOUNT_DELETION') {
      return loc.settingsActiveAdmissionBlocksDeletion;
    }
    return e.message;
  }

  void _showSnackBar(String message) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(LiveRegionSnackBar.build(message: message));
  }

  Future<void> triggerSOS() async {
    await SOSService.triggerWithFeedback(context);
  }
}
