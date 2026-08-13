import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/offline/patient_cache_invalidation.dart';
import 'package:vhhealth/core/services/patient_session_authority.dart';
import 'package:vhhealth_core/services/http_client.dart';

import '../../support/patient_session_test_authority.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory tempDir;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('api_cache_test_');
    _installPathProviderFake(tempDir.path);
    _installSecureStorageFake();
    VHHttpClient.actingAsUidProvider = null;
    await ApiCacheManager.clearAll();
    installCurrentPatientSessionAuthority();
  });

  tearDown(() async {
    VHHttpClient.actingAsUidProvider = null;
    PatientSessionAuthority.resetAfterTesting();
    await ApiCacheManager.clearAll();
    if (await tempDir.exists()) {
      await tempDir.delete(recursive: true);
    }
  });

  test(
    'appointment mutation invalidates cached appointment dashboard reads',
    () async {
      await ApiCacheManager.save('/appointments/uid/user-1', {'id': 1});
      await ApiCacheManager.save('/portal/command-center', {'today': []});
      await ApiCacheManager.save('/portal/lab-results', {'keep': true});

      expect(await ApiCacheManager.load('/appointments/uid/user-1'), isNotNull);
      expect(await ApiCacheManager.load('/portal/command-center'), isNotNull);

      await PatientCacheInvalidation.afterAppointmentMutation();

      expect(await ApiCacheManager.load('/appointments/uid/user-1'), isNull);
      expect(await ApiCacheManager.load('/portal/command-center'), isNull);
      expect(await ApiCacheManager.load('/portal/lab-results'), isNotNull);
    },
  );

  test(
    'feature mutation helpers invalidate their cached read prefixes',
    () async {
      await ApiCacheManager.save('/pharmacy-orders/orders/my', {'orders': []});
      await PatientCacheInvalidation.afterPharmacyOrderMutation();
      expect(await ApiCacheManager.load('/pharmacy-orders/orders/my'), isNull);

      await ApiCacheManager.save('/prescriptions/patient/my', {'items': []});
      await PatientCacheInvalidation.afterRefillMutation();
      expect(await ApiCacheManager.load('/prescriptions/patient/my'), isNull);

      await ApiCacheManager.save('/health/patient/p1/vitals', {'items': []});
      await PatientCacheInvalidation.afterVitalsMutation();
      expect(await ApiCacheManager.load('/health/patient/p1/vitals'), isNull);

      await ApiCacheManager.save('/users/5551112222', {'name': 'Updated'});
      await PatientCacheInvalidation.afterProfileMutation();
      expect(await ApiCacheManager.load('/users/5551112222'), isNull);
    },
  );

  test(
    'dependent mutation invalidates profile-scoped caches across profiles',
    () async {
      VHHttpClient.actingAsUidProvider = () => 'child_1';
      await ApiCacheManager.save('/portal/command-center', {'child': true});
      await ApiCacheManager.save('/portal/lab-results', {'child': true});
      await ApiCacheManager.save('/appointments/uid/child_1', {'child': true});

      VHHttpClient.actingAsUidProvider = null;
      await ApiCacheManager.save('/portal/command-center', {'self': true});
      await ApiCacheManager.save('/users/dependents', {'dependents': []});

      await PatientCacheInvalidation.afterDependentMutation();

      expect(await ApiCacheManager.load('/portal/command-center'), isNull);
      expect(await ApiCacheManager.load('/users/dependents'), isNull);

      VHHttpClient.actingAsUidProvider = () => 'child_1';
      expect(await ApiCacheManager.load('/portal/command-center'), isNull);
      expect(await ApiCacheManager.load('/portal/lab-results'), isNull);
      expect(await ApiCacheManager.load('/appointments/uid/child_1'), isNull);
    },
  );
}

void _installPathProviderFake(String documentsPath) {
  const channel = MethodChannel('plugins.flutter.io/path_provider');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        if (call.method == 'getApplicationDocumentsDirectory') {
          return documentsPath;
        }
        return null;
      });
}

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key'] as String] = args['value'] as String;
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
}
