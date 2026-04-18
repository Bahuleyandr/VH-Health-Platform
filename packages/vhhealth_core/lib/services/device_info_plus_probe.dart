import 'dart:io' show Platform;

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'device_trust_service.dart';

/// Richer [DeviceTrustProbe] backed by `device_info_plus`. Use at app startup:
///
/// ```dart
/// DeviceTrust.installProbe(DeviceInfoPlusProbe());
/// ```
///
/// Improvements over the default probe:
/// - Actual emulator/simulator detection on both Android and iOS via the
///   device fingerprints (Android: `isPhysicalDevice`, iOS:
///   `AppAttest`-equivalent via simulator model strings).
/// - Android developer-mode / USB-debug detection via the native
///   `android.provider.Settings.Global.ADB_ENABLED` flag — surfaced through
///   a MethodChannel the host app must implement (see below).
///
/// What this probe does NOT do (deferred work for the full DeviceTrust story):
/// - Play Integrity / SafetyNet attestation (Android) — requires a native
///   plugin + backend JWS verification. Plan lives in
///   `docs/DEVICE_TRUST_ROADMAP.md`.
/// - DeviceCheck / AppAttest (iOS) — same story, requires native integration.
/// - Runtime debugger detection — `kDebugMode` is a compile-time constant,
///   release-mode debuggers attached via ptrace/gdb are not detected.
class DeviceInfoPlusProbe extends DeviceTrustProbe {
  DeviceInfoPlusProbe({MethodChannel? developerModeChannel})
      : _developerModeChannel = developerModeChannel ??
            const MethodChannel('vhhealth/device_trust_developer_mode');

  final DeviceInfoPlugin _deviceInfo = DeviceInfoPlugin();
  final MethodChannel _developerModeChannel;

  @override
  Future<bool> isEmulator() async {
    try {
      if (Platform.isAndroid) {
        final info = await _deviceInfo.androidInfo;
        // `isPhysicalDevice` is the authoritative check; fingerprint contains
        // 'generic' or 'sdk' on every AOSP-based emulator as a fallback.
        if (!info.isPhysicalDevice) return true;
        final fingerprint = info.fingerprint.toLowerCase();
        if (fingerprint.startsWith('generic/') ||
            fingerprint.startsWith('unknown/') ||
            fingerprint.contains('google_sdk') ||
            fingerprint.contains('emulator') ||
            fingerprint.contains('sdk_gphone')) {
          return true;
        }
        return false;
      }
      if (Platform.isIOS) {
        final info = await _deviceInfo.iosInfo;
        if (!info.isPhysicalDevice) return true;
        // Simulator fallback — model contains 'Simulator' on the x86 simulator.
        return info.model.toLowerCase().contains('simulator');
      }
    } catch (e) {
      if (kDebugMode) debugPrint('DeviceInfoPlusProbe.isEmulator failed: $e');
    }
    return false;
  }

  @override
  Future<bool> isDeveloperModeOn() async {
    // iOS has no equivalent runtime check; developer-mode is a build-time signing thing.
    if (!Platform.isAndroid) return false;
    try {
      final enabled =
          await _developerModeChannel.invokeMethod<bool>('isDeveloperModeEnabled');
      return enabled == true;
    } on MissingPluginException {
      // Host app didn't wire the method channel — fall through to the default
      // (false). Not an error; the probe just reports "unknown = safe".
      if (kDebugMode) {
        debugPrint(
          'DeviceInfoPlusProbe: MethodChannel `vhhealth/device_trust_developer_mode` '
          'not implemented on host. Wire it to read '
          'Settings.Global.ADB_ENABLED to enable developer-mode detection.',
        );
      }
      return false;
    } catch (e) {
      if (kDebugMode) debugPrint('DeviceInfoPlusProbe.isDeveloperModeOn failed: $e');
      return false;
    }
  }

  // isDebuggerAttached keeps the default (kDebugMode-only) behaviour.
  // Release-mode debugger detection requires a native hook (e.g. ptrace check
  // on Android, sysctl on iOS). Tracked in DEVICE_TRUST_ROADMAP.md.
}
