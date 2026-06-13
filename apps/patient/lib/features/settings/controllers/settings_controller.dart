// settings_controller.dart
import 'package:go_router/go_router.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:provider/provider.dart';

import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:local_auth/local_auth.dart';
import 'package:permission_handler/permission_handler.dart';

import 'package:vhhealth/core/providers/language_provider.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/device_service.dart';
import 'package:vhhealth/core/services/firebase_session_service.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class SettingsController {
  final void Function() refresh;
  final String phone;
  final String name;
  final String hospitalNumber;

  final LocalAuthentication _auth = LocalAuthentication();
  final _secureStorage = VHSecureStorage.instance;

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
      await _secureStorage.deleteAll();
      await FirebaseAuth.instance.signOut();
      if (context.mounted) {
        context.read<UserProvider>().clear();
        context.go('/login');
      }
    }
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
