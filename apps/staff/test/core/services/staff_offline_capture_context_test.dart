import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/staff_offline_capture_context.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const storageChannel = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );
  final secureStore = <String, String>{};

  setUp(() {
    secureStore.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(storageChannel, (call) async {
          final arguments = Map<String, dynamic>.from(call.arguments as Map);
          return switch (call.method) {
            'read' => secureStore[arguments['key']],
            'write' => () {
              secureStore[arguments['key'] as String] =
                  arguments['value'] as String;
              return null;
            }(),
            'delete' => secureStore.remove(arguments['key']),
            'deleteAll' => secureStore.clear(),
            'readAll' => Map<String, String>.from(secureStore),
            'containsKey' => secureStore.containsKey(arguments['key']),
            _ => null,
          };
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(storageChannel, null);
  });

  test(
    'production resolution fails closed while facility is unprovisioned',
    () {
      expect(
        () => StaffOfflineCaptureContext.resolve(appVersion: '6.0.0+600'),
        throwsA(
          isA<StaffOfflineCaptureContextUnavailable>().having(
            (error) => error.reasonCode,
            'reasonCode',
            'facility_context_unavailable',
          ),
        ),
      );
    },
  );

  test(
    'explicit provisioned context yields a stable capture session',
    () async {
      Future<StaffOfflineCaptureContext> resolve({
        int facilityId = 17,
        String actorUid = 'actor-1',
      }) {
        return StaffOfflineCaptureContext.resolve(
          appVersion: '6.0.0+600',
          facilityIdResolver: () async => facilityId,
          actorUidResolver: () async => actorUid,
          roleResolver: () async => 'doctor',
          deviceIdResolver: () async => 'device-opaque-1',
          devicePostureResolver: () => 'Desktop',
        );
      }

      final first = await resolve();
      final second = await resolve();
      final differentActor = await resolve(actorUid: 'actor-2');
      final differentFacility = await resolve(facilityId: 18);

      expect(first.facilityId, 17);
      expect(first.captureActorUuid, 'actor-1');
      expect(first.captureRole, 'doctor');
      expect(first.deviceId, 'device-opaque-1');
      expect(first.devicePosture, 'desktop');
      expect(first.appVersion, '6.0.0+600');
      expect(first.captureSessionId, second.captureSessionId);
      expect(differentActor.captureSessionId, isNot(first.captureSessionId));
      expect(differentFacility.captureSessionId, isNot(first.captureSessionId));
      expect(secureStore, hasLength(3));

      await StaffOfflineCaptureContext.rotateCaptureSession(
        tenantId: first.tenantId,
        facilityId: first.facilityId,
        deviceId: first.deviceId,
        actorUid: first.captureActorUuid,
      );
      final rotated = await resolve();
      expect(rotated.captureSessionId, isNot(first.captureSessionId));
      expect(secureStore, hasLength(3));
    },
  );

  test('tenant, department, host, and screen text are never substitutes', () {
    for (final invalidFacility in [null, 0, -1]) {
      expect(
        () => StaffOfflineCaptureContext.resolve(
          appVersion: '6.0.0+600',
          facilityIdResolver: () async => invalidFacility,
          actorUidResolver: () async => 'actor-1',
          roleResolver: () async => 'doctor',
          deviceIdResolver: () async => 'tenant-or-host-looking-value',
          devicePostureResolver: () => 'desktop',
        ),
        throwsA(
          isA<StaffOfflineCaptureContextUnavailable>().having(
            (error) => error.reasonCode,
            'reasonCode',
            'facility_context_unavailable',
          ),
        ),
      );
    }
  });
}
