import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';
import 'package:permission_handler/permission_handler.dart';

import 'package:vhhealth/core/providers/language_provider.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class SettingsController {
  final BuildContext context;
  final void Function() refresh;
  final String phone;
  final String name;

  final LocalAuthentication _auth = LocalAuthentication();
  final FlutterSecureStorage _secureStorage = const FlutterSecureStorage();

  late AppLocalizations loc;
  late ThemeProvider tp;
  late LanguageProvider lang;

  bool biometricEnabled = false;
  bool biometricSupported = false;
  bool calendarGranted = false;
  bool locationGranted = false;
  bool cameraGranted = false;

  bool _initialized = false;

  SettingsController(this.phone, this.name, this.context, this.refresh);

  void initialize() {
    if (_initialized) return;
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

  void toggleTheme(bool isDark) => tp.setThemeMode(isDark ? ThemeMode.dark : ThemeMode.light);

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
          options: const AuthenticationOptions(biometricOnly: true),
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
    await _secureStorage.write(key: 'biometric_enabled', value: value.toString());
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
            style: FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error),
            onPressed: () => nav.pop(true),
            child: Text(loc.settingsConfirmLogout),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      await _secureStorage.deleteAll();
      if (context.mounted) {
        nav.pushNamedAndRemoveUntil('/login', (_) => false);
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
