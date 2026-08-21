// Acting-as delegation header exemption (guardian-self surfaces).
//
// `X-Acting-As-Uid` must ride only on DEPENDENT-AWARE (patient-record)
// calls. Surfaces whose identity is the person holding the phone — SOS,
// the guardian's own profile/roster, feedback, devices, notifications,
// steps, gamification, and the auth realm — must NEVER carry it, or they
// either 403 against the dependent's synthetic phone (SOS, profile save)
// or silently mis-attribute the guardian's activity to the child.
// See VHHttpClient.actingAsExemptPathPrefixes for the rule.
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/http_client.dart';

/// In-memory fake for the flutter_secure_storage method channel.
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

const _depUid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final capturedHeaders = <String, Map<String, String>>{};

  setUp(() async {
    _installSecureStorageFake();
    await AuthService.setJwt('test-jwt');
    capturedHeaders.clear();
    VHHttpClient.actingAsUidProvider = () => _depUid;
    VHHttpClient.setClientForTesting(
      MockClient((req) async {
        capturedHeaders[req.url.path] = Map<String, String>.from(req.headers);
        return http.Response(jsonEncode({'success': true, 'data': {}}), 200);
      }),
    );
  });

  tearDown(() async {
    VHHttpClient.actingAsUidProvider = null;
    VHHttpClient.resetClientForTesting();
    await AuthService.clearAll();
  });

  String? sentHeaderFor(String pathSuffix) {
    final entry = capturedHeaders.entries
        .where((e) => e.key.endsWith(pathSuffix))
        .toList();
    expect(entry, hasLength(1), reason: 'expected one call to $pathSuffix');
    return entry.single.value['X-Acting-As-Uid'];
  }

  group('isActingAsExemptPath', () {
    test('matches exempt prefixes on whole segments only', () {
      expect(VHHttpClient.isActingAsExemptPath('/sos'), isTrue);
      expect(VHHttpClient.isActingAsExemptPath('/sos/'), isTrue);
      expect(VHHttpClient.isActingAsExemptPath('/sos/cancel/12'), isTrue);
      expect(
        VHHttpClient.isActingAsExemptPath('/sos/nearby-services?lat=1&lng=2'),
        isTrue,
      );
      expect(VHHttpClient.isActingAsExemptPath('/users/me'), isTrue);
      expect(VHHttpClient.isActingAsExemptPath('/users/dependents'), isTrue);
      expect(VHHttpClient.isActingAsExemptPath('/feedback'), isTrue);
      expect(VHHttpClient.isActingAsExemptPath('/devices/register'), isTrue);
      expect(VHHttpClient.isActingAsExemptPath('/notifications/my'), isTrue);
      expect(VHHttpClient.isActingAsExemptPath('/steps/session/start'), isTrue);
      expect(
        VHHttpClient.isActingAsExemptPath('/gamification/summary'),
        isTrue,
      );
      expect(VHHttpClient.isActingAsExemptPath('/auth/refresh-token'), isTrue);

      // A sibling path that merely shares the prefix characters is NOT exempt.
      expect(VHHttpClient.isActingAsExemptPath('/sos-extra'), isFalse);
      expect(VHHttpClient.isActingAsExemptPath('/usersx/me'), isFalse);

      // Dependent-aware record surfaces stay non-exempt.
      expect(
        VHHttpClient.isActingAsExemptPath('/appointments/patient/7'),
        isFalse,
      );
      expect(
        VHHttpClient.isActingAsExemptPath('/prescriptions/patient/my'),
        isFalse,
      );
      expect(
        VHHttpClient.isActingAsExemptPath('/health/patient/7/vitals'),
        isFalse,
      );
      expect(
        VHHttpClient.isActingAsExemptPath('/investigations/bookings/my'),
        isFalse,
      );
      expect(
        VHHttpClient.isActingAsExemptPath('/pharmacy-orders/orders/my'),
        isFalse,
      );
      expect(VHHttpClient.isActingAsExemptPath('/portal/bills'), isFalse);
      expect(VHHttpClient.isActingAsExemptPath('/upload'), isFalse);
    });
  });

  group('X-Acting-As-Uid attachment', () {
    test('rides on dependent-aware GET calls', () async {
      await VHHttpClient.get('/appointments/patient/7');
      expect(sentHeaderFor('/appointments/patient/7'), _depUid);
    });

    test(
      'suppressed on SOS trigger POST — the alert is the guardian\'s own',
      () async {
        await VHHttpClient.post('/sos/', body: {'phone': '9876543210'});
        expect(sentHeaderFor('/sos/'), isNull);
      },
    );

    test('suppressed across guardian-self surfaces', () async {
      await VHHttpClient.get('/sos/emergency-contact');
      await VHHttpClient.post('/sos/medical-info', body: {});
      await VHHttpClient.get('/users/me');
      await VHHttpClient.post('/users/profile', body: {});
      await VHHttpClient.post('/feedback', body: {});
      await VHHttpClient.post('/devices/register', body: {});
      await VHHttpClient.get('/notifications/my');
      await VHHttpClient.post('/steps/session/start', body: {});
      await VHHttpClient.post('/gamification/check-in', body: {});

      for (final path in const [
        '/sos/emergency-contact',
        '/sos/medical-info',
        '/users/me',
        '/users/profile',
        '/feedback',
        '/devices/register',
        '/notifications/my',
        '/steps/session/start',
        '/gamification/check-in',
      ]) {
        expect(
          sentHeaderFor(path),
          isNull,
          reason: '$path is a guardian-self surface',
        );
      }
    });

    test('still rides on record mutations (PUT/PATCH/DELETE)', () async {
      await VHHttpClient.put('/appointments/9', body: {});
      await VHHttpClient.patch('/appointments/9/reschedule', body: {});
      await VHHttpClient.delete('/reminders/medication/3');
      expect(sentHeaderFor('/appointments/9'), _depUid);
      expect(sentHeaderFor('/appointments/9/reschedule'), _depUid);
      expect(sentHeaderFor('/reminders/medication/3'), _depUid);
    });

    test('absent everywhere when no acting-as profile is active', () async {
      VHHttpClient.actingAsUidProvider = () => null;
      await VHHttpClient.get('/appointments/patient/7');
      await VHHttpClient.get('/sos/my-alerts');
      expect(sentHeaderFor('/appointments/patient/7'), isNull);
      expect(sentHeaderFor('/sos/my-alerts'), isNull);
    });
  });
}
