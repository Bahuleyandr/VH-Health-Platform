// HIGH-1 regression pins for the honest SOS trigger contract:
//   * a failed backend POST is SURFACED (SosBackendOutcome.failed + error),
//     never swallowed into an implied success;
//   * the dialer (the safety net) launches regardless of the backend outcome
//     and is never blocked waiting on the network;
//   * guest / no-phone sessions report `skipped`, not success.
import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/widgets/sos_button.dart';

/// In-memory flutter_secure_storage fake (same channel fake as
/// auth_service_test.dart).
Map<String, String> _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final Map<String, String> store = {};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = call.arguments is Map
            ? Map<String, dynamic>.from(call.arguments as Map)
            : <String, dynamic>{};
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key']] = args['value'] as String;
            return null;
          case 'delete':
            store.remove(args['key']);
            return null;
          case 'readAll':
            return Map<String, String>.from(store);
          case 'deleteAll':
            store.clear();
            return null;
          case 'containsKey':
            return store.containsKey(args['key']);
          default:
            return null;
        }
      });
  return store;
}

/// Geolocator fake: permission permanently denied so the flow skips location
/// without touching further platform surface.
void _installGeolocatorFake() {
  const channel = MethodChannel('flutter.baseflow.com/geolocator');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        switch (call.method) {
          case 'isLocationServiceEnabled':
            return true;
          case 'checkPermission':
            return 1; // LocationPermission.deniedForever
          default:
            return null;
        }
      });
}

/// url_launcher fake recording dialer launches.
List<String> _installUrlLauncherFake() {
  const channel = MethodChannel('plugins.flutter.io/url_launcher');
  final launched = <String>[];
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = call.arguments is Map
            ? Map<String, dynamic>.from(call.arguments as Map)
            : <String, dynamic>{};
        switch (call.method) {
          case 'canLaunch':
            return true;
          case 'launch':
            launched.add(args['url']?.toString() ?? '');
            return true;
          default:
            return null;
        }
      });
  return launched;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> storage;
  late List<String> launchedUrls;

  setUp(() {
    storage = _installSecureStorageFake();
    _installGeolocatorFake();
    launchedUrls = _installUrlLauncherFake();
  });

  test(
    'failed backend POST is surfaced AND the dialer still launches',
    () async {
      storage['user_phone'] = '+919999999999';
      final thrown = Exception('backend unreachable');

      final result = await triggerSOS(null, ({
        required String phone,
        double? latitude,
        double? longitude,
      }) async {
        throw thrown;
      });

      expect(result.backendOutcome, SosBackendOutcome.failed);
      expect(result.backendReported, isFalse);
      expect(result.error, same(thrown));
      // The safety net is untouched by the backend failure.
      expect(result.dialerLaunched, isTrue);
      expect(launchedUrls, ['tel:$kSosEmergencyNumber']);
    },
  );

  test(
    'successful backend POST reports reported with the sent phone',
    () async {
      storage['user_phone'] = '+919999999999';
      String? postedPhone;

      final result = await triggerSOS(null, ({
        required String phone,
        double? latitude,
        double? longitude,
      }) async {
        postedPhone = phone;
      });

      expect(result.backendOutcome, SosBackendOutcome.reported);
      expect(result.backendReported, isTrue);
      expect(postedPhone, '+919999999999');
      expect(result.dialerLaunched, isTrue);
    },
  );

  test(
    'guest session: POST skipped (never attempted), dialer still launches',
    () async {
      storage['user_phone'] = 'guest';
      var posterCalled = false;

      final result = await triggerSOS(null, ({
        required String phone,
        double? latitude,
        double? longitude,
      }) async {
        posterCalled = true;
      });

      expect(result.backendOutcome, SosBackendOutcome.skipped);
      expect(posterCalled, isFalse);
      expect(result.dialerLaunched, isTrue);
      expect(launchedUrls, isNotEmpty);
    },
  );

  test('dialer launches BEFORE the backend POST completes (never blocked on '
      'the network)', () async {
    storage['user_phone'] = '+919999999999';
    final gate = Completer<void>();

    final pending = triggerSOS(null, ({
      required String phone,
      double? latitude,
      double? longitude,
    }) {
      return gate.future;
    });

    // Let the flow run up to the awaited backend outcome.
    await pumpEventQueue();
    expect(
      launchedUrls,
      isNotEmpty,
      reason: 'dialer must launch while the POST is still in flight',
    );

    gate.complete();
    final result = await pending;
    expect(result.backendOutcome, SosBackendOutcome.reported);
  });
}
