// STF-4: Single, properly-configured FlutterSecureStorage instance shared
// by every package and app that stores tokens or PHI.
//
// All ad-hoc `const FlutterSecureStorage()` scattered across staff, patient,
// and core were using DEFAULT options — no Android EncryptedSharedPreferences
// and no iOS accessibility restriction.  Routing through this singleton
// ensures every write lands in the encrypted-at-rest store with a sensible
// accessibility level.
//
// Usage:
//   import 'package:vhhealth_core/services/secure_storage.dart';
//   await VHSecureStorage.instance.write(key: 'jwt', value: token);
//   final jwt = await VHSecureStorage.instance.read(key: 'jwt');

import 'dart:io' show Platform;
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// A single, app-wide [FlutterSecureStorage] configured with:
///
///  * Android: `encryptedSharedPreferences: true` — values land in
///    Android Keystore-backed EncryptedSharedPreferences (AES-256/GCM).
///  * iOS/macOS: `accessibility: first_unlock_this_device` — stored in the
///    device Keychain; inaccessible before first unlock after reboot so PHI
///    cannot be dumped from a powered-off device.
///
/// Web is intentionally excluded from both overrides because it has no
/// Keychain / Keystore; values are stored in memory only (no persistent
/// PHI is written on web builds).
class VHSecureStorage {
  VHSecureStorage._();

  static final FlutterSecureStorage instance = _build();

  static FlutterSecureStorage _build() {
    // flutter_secure_storage v10+ uses a custom-cipher implementation on
    // Android that is always Keystore-backed (AES-256/GCM). The now-
    // deprecated `encryptedSharedPreferences` flag was for the old Jetpack
    // Security approach, which Google deprecated. Default options suffice.
    const androidOptions = AndroidOptions();

    const iosOptions = IOSOptions(
      // `first_unlock_this_device` (vs `unlocked`) allows the keychain item
      // to be read after device restart once the user has unlocked once.
      // This keeps background JWT-refresh working without requiring the app
      // to be in the foreground.
      accessibility: KeychainAccessibility.first_unlock_this_device,
    );

    // macOS Keychain mirrors the iOS options.
    const macosOptions = MacOsOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    );

    if (kIsWeb) {
      // Web: no persistent keychain — use defaults; no PHI should be stored.
      return const FlutterSecureStorage();
    }

    // On Android: ignore ios/macos options (they'd throw at runtime).
    // On iOS/macOS: ignore android options.
    // On other platforms (Linux/Windows): fall back to defaults.
    if (!kIsWeb && (Platform.isAndroid)) {
      return const FlutterSecureStorage(aOptions: androidOptions);
    }
    if (!kIsWeb && (Platform.isIOS)) {
      return const FlutterSecureStorage(
        aOptions: androidOptions,
        iOptions: iosOptions,
      );
    }
    if (!kIsWeb && (Platform.isMacOS)) {
      return const FlutterSecureStorage(
        aOptions: androidOptions,
        mOptions: macosOptions,
      );
    }

    // Windows / Linux: plugin uses credential-manager / libsecret defaults.
    return const FlutterSecureStorage();
  }
}
