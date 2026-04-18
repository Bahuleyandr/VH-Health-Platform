// test/helpers/plugin_channel_mocks.dart
//
// Reusable plugin-channel mocks for staff-app tests. The plugins we depend on
// (local_auth, connectivity_plus, mobile_scanner, flutter_local_notifications)
// all talk to platform code via MethodChannels that don't exist in the Flutter
// test harness. Stub them here so the clinical-safety test backlog in
// test/README.md can move forward without each test reinventing the same
// plumbing.
//
// Usage:
//   setUp(() {
//     TestWidgetsFlutterBinding.ensureInitialized();
//     mockLocalAuth(canAuthenticate: true, authenticateResult: true);
//     mockConnectivity(initialResult: ConnectivityResult.wifi);
//   });
//
//   tearDown(clearAllPluginMocks);

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

// ─────────────────────────────────────────────────────────────────────────────
// local_auth
// ─────────────────────────────────────────────────────────────────────────────

const _kLocalAuthChannel = MethodChannel('plugins.flutter.io/local_auth');

/// Install a mock handler for `plugins.flutter.io/local_auth` so widget tests
/// can simulate biometric prompts without a device.
///
/// - [canAuthenticate] sets what `canCheckBiometrics` + `isDeviceSupported`
///   return.
/// - [authenticateResult] sets what `authenticate` returns (`true` = success,
///   `false` = cancelled).
/// - [availableBiometrics] is the list reported by `getAvailableBiometrics`
///   ('fingerprint', 'face', 'weak', 'strong' are the real values).
/// - [throwOnAuthenticate] causes `authenticate` to throw a
///   [PlatformException] with the given code (e.g. 'NotEnrolled').
void mockLocalAuth({
  bool canAuthenticate = true,
  bool authenticateResult = true,
  List<String> availableBiometrics = const ['fingerprint'],
  String? throwOnAuthenticate,
}) {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(_kLocalAuthChannel, (call) async {
    switch (call.method) {
      case 'canCheckBiometrics':
      case 'isDeviceSupported':
        return canAuthenticate;
      case 'getAvailableBiometrics':
        return availableBiometrics;
      case 'authenticate':
        if (throwOnAuthenticate != null) {
          throw PlatformException(code: throwOnAuthenticate);
        }
        return authenticateResult;
      case 'stopAuthentication':
        return true;
      default:
        return null;
    }
  });
}

void clearLocalAuthMock() {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(_kLocalAuthChannel, null);
}

// ─────────────────────────────────────────────────────────────────────────────
// connectivity_plus
// ─────────────────────────────────────────────────────────────────────────────

const _kConnectivityMethodChannel =
    MethodChannel('dev.fluttercommunity.plus/connectivity');
const _kConnectivityEventChannel =
    MethodChannel('dev.fluttercommunity.plus/connectivity_status');

/// Stub `connectivity_plus` so tests that enqueue offline work + verify
/// flush-on-reconnect have a deterministic network state.
///
/// - [initialResult] is what `checkConnectivity` returns.
/// - Subsequent changes should be simulated via [pushConnectivityChange].
void mockConnectivity({ConnectivityResult initialResult = ConnectivityResult.wifi}) {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(_kConnectivityMethodChannel, (call) async {
    if (call.method == 'check') {
      return _connectivityResultToString(initialResult);
    }
    return null;
  });
  // The event channel is a stream; to push events, call [pushConnectivityChange].
}

/// Simulate a network state change (e.g. transition from none → wifi) on the
/// connectivity_plus event channel. Call AFTER the widget under test has
/// subscribed.
Future<void> pushConnectivityChange(ConnectivityResult result) async {
  final envelope = const StandardMethodCodec().encodeSuccessEnvelope(
    _connectivityResultToString(result),
  );
  await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .handlePlatformMessage(
    _kConnectivityEventChannel.name,
    envelope,
    (data) {},
  );
}

String _connectivityResultToString(ConnectivityResult r) {
  switch (r) {
    case ConnectivityResult.wifi:
      return 'wifi';
    case ConnectivityResult.mobile:
      return 'mobile';
    case ConnectivityResult.ethernet:
      return 'ethernet';
    case ConnectivityResult.bluetooth:
      return 'bluetooth';
    case ConnectivityResult.vpn:
      return 'vpn';
    case ConnectivityResult.other:
      return 'other';
    case ConnectivityResult.satellite:
      return 'satellite';
    case ConnectivityResult.none:
      return 'none';
  }
}

void clearConnectivityMock() {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(_kConnectivityMethodChannel, null);
}

// ─────────────────────────────────────────────────────────────────────────────
// mobile_scanner (barcode scanner)
// ─────────────────────────────────────────────────────────────────────────────
//
// mobile_scanner uses its own MethodChannel for camera lifecycle. For the MAR
// 5-rights tests the realistic approach is usually the mirror-class pattern
// (see test/features/nursing/mar_rights_state_machine_test.dart). This stub
// is the fallback for widget tests that must render the scanner surface —
// it silences the "No implementation found" error and returns plausible
// empty responses.

const _kMobileScannerChannel = MethodChannel('dev.steenbakker.mobile_scanner/scanner');

void mockMobileScanner() {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(_kMobileScannerChannel, (call) async {
    switch (call.method) {
      case 'state':
        return <String, Object?>{'isRunning': false, 'hasTorch': false};
      case 'start':
      case 'stop':
      case 'toggleTorch':
      case 'updateScanWindow':
        return null;
      default:
        return null;
    }
  });
}

void clearMobileScannerMock() {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(_kMobileScannerChannel, null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience
// ─────────────────────────────────────────────────────────────────────────────

/// Clear every mock set up above. Call from `tearDown` so tests don't leak
/// handlers to each other.
void clearAllPluginMocks() {
  clearLocalAuthMock();
  clearConnectivityMock();
  clearMobileScannerMock();
}
