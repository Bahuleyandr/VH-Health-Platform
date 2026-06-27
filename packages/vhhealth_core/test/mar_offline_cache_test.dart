import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/mar_offline_cache.dart';

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final Map<String, String> store = {};
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
    final args = Map<String, dynamic>.from(call.arguments as Map);
    switch (call.method) {
      case 'read':
        return store[args['key']];
      case 'write':
        store[args['key']] = args['value'] as String;
        return null;
      case 'delete':
        store.remove(args['key']);
        return null;
      default:
        return null;
    }
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(_installSecureStorageFake);

  final patientUid = 'a1b2c3d4-0000-4000-8000-000000000001';
  final doses = [
    {'id': 11, 'patient_uid': patientUid, 'medication_name': 'Paracetamol', 'dose': '500mg', 'route': 'oral', 'scheduled_time': '2026-06-27T10:00:00Z', 'status': 'scheduled'},
    {'id': 12, 'patient_uid': patientUid, 'medication_name': 'Amoxicillin', 'dose': '250mg', 'route': 'oral', 'scheduled_time': '2026-06-27T12:00:00Z', 'status': 'scheduled'},
  ];

  test('cache → read round-trips encrypted + getCachedDose finds by maId', () async {
    await MarOfflineCache.cacheDueDoses(patientUid, doses);
    final got = await MarOfflineCache.getCachedDose(patientUid, 11);
    expect(got, isNotNull);
    expect(got!['medication_name'], 'Paracetamol');
    final all = await MarOfflineCache.getCachedDoses(patientUid);
    expect(all.length, 2);
  });

  test('getCachedDose returns null for an unknown maId', () async {
    await MarOfflineCache.cacheDueDoses(patientUid, doses);
    expect(await MarOfflineCache.getCachedDose(patientUid, 999), isNull);
  });

  test('cachedAt reflects the last cache write', () async {
    await MarOfflineCache.cacheDueDoses(patientUid, doses);
    final at = await MarOfflineCache.cachedAt(patientUid);
    expect(at, isNotNull);
  });
}
