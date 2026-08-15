import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/config/api_config.dart';
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

String get _refreshUrl => '${ApiConfig.baseUrl}/auth/refresh-token';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    _installSecureStorageFake();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
    VHHttpClient.appCheckTokenProvider = null;
  });

  tearDown(() async {
    await AuthService.clearAll();
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
    VHHttpClient.appCheckTokenProvider = null;
    VHHttpClient.appCheckTokenTimeout = const Duration(seconds: 2);
  });

  group('VHHttpClient — _performRefresh (bearer path, no refresh token)', () {
    test('success: parses `token` from envelope and stores it', () async {
      await AuthService.setJwt('old-access');

      var callCount = 0;
      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          callCount++;
          expect(req.url.toString(), _refreshUrl);
          expect(req.method, 'POST');
          expect(req.headers['Authorization'], 'Bearer old-access');
          // No body — bearer rotation path.
          expect(req.body, isEmpty);
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'token': 'new-access'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final ok = await VHHttpClient.debugTryRefreshToken();
      expect(ok, isTrue);
      expect(callCount, 1);
      expect(await AuthService.getJwt(), 'new-access');
      expect(await AuthService.getRefreshToken(), isNull);
    });

    test('also accepts `accessToken` field name in response', () async {
      await AuthService.setJwt('old-access');

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'accessToken': 'new-access'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final ok = await VHHttpClient.debugTryRefreshToken();
      expect(ok, isTrue);
      expect(await AuthService.getJwt(), 'new-access');
    });

    test('failure on non-2xx: returns false, keeps old token', () async {
      await AuthService.setJwt('old-access');

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          return http.Response(
            jsonEncode({'success': false, 'message': 'Expired'}),
            401,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final ok = await VHHttpClient.debugTryRefreshToken();
      expect(ok, isFalse);
      expect(await AuthService.getJwt(), 'old-access');
    });

    test('failure on missing token: returns false', () async {
      await AuthService.setJwt('old-access');

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          return http.Response(
            jsonEncode({'success': true, 'data': {}}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final ok = await VHHttpClient.debugTryRefreshToken();
      expect(ok, isFalse);
      expect(await AuthService.getJwt(), 'old-access');
    });
  });

  group('VHHttpClient — _performRefresh (refresh-token path)', () {
    test('POSTs {refreshToken} in body and rotates both tokens', () async {
      await AuthService.setJwt('old-access');
      await AuthService.setRefreshToken('old-refresh');
      final installationId = await AuthService.getOrCreateInstallationId();

      Map<String, dynamic>? observedBody;
      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          expect(req.url.toString(), _refreshUrl);
          observedBody = jsonDecode(req.body) as Map<String, dynamic>;
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'accessToken': 'new-access',
                'refreshToken': 'new-refresh',
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final ok = await VHHttpClient.debugTryRefreshToken();
      expect(ok, isTrue);
      expect(observedBody?['refreshToken'], 'old-refresh');
      expect(observedBody?['installationId'], installationId);
      expect(await AuthService.getJwt(), 'new-access');
      expect(await AuthService.getRefreshToken(), 'new-refresh');
    });

    test('keeps old refresh token when response omits rotation', () async {
      await AuthService.setJwt('old-access');
      await AuthService.setRefreshToken('old-refresh');

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'accessToken': 'new-access'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final ok = await VHHttpClient.debugTryRefreshToken();
      expect(ok, isTrue);
      expect(await AuthService.getJwt(), 'new-access');
      expect(await AuthService.getRefreshToken(), 'old-refresh');
    });
  });

  group('VHHttpClient — single-flight refresh', () {
    test(
      'two concurrent refresh calls make exactly one HTTP request',
      () async {
        await AuthService.setJwt('old-access');

        var callCount = 0;
        final completer = Completer<http.Response>();
        VHHttpClient.setClientForTesting(
          MockClient((req) async {
            callCount++;
            return completer.future;
          }),
        );

        // Kick off two concurrent refreshes before the first completes.
        final f1 = VHHttpClient.debugTryRefreshToken();
        final f2 = VHHttpClient.debugTryRefreshToken();

        // Allow the event loop to schedule both.
        await Future<void>.delayed(Duration.zero);

        completer.complete(
          http.Response(
            jsonEncode({
              'success': true,
              'data': {'token': 'new-access'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          ),
        );

        final results = await Future.wait([f1, f2]);
        expect(results, [true, true]);
        expect(
          callCount,
          1,
          reason: 'Single-flight should dedupe concurrent refreshes',
        );
      },
    );
  });

  group('VHHttpClient — 401 retry on GET', () {
    test(
      '401 → refresh → retry succeeds (one extra request with new token)',
      () async {
        await AuthService.setJwt('old-access');

        var getCount = 0;
        VHHttpClient.setClientForTesting(
          MockClient((req) async {
            if (req.url.toString() == _refreshUrl) {
              // The refresh call itself
              return http.Response(
                jsonEncode({
                  'success': true,
                  'data': {'token': 'new-access'},
                }),
                200,
                headers: {'content-type': 'application/json'},
              );
            }
            // The original GET — fail first, succeed on retry
            getCount++;
            if (getCount == 1) {
              expect(req.headers['Authorization'], 'Bearer old-access');
              return http.Response(
                jsonEncode({'success': false, 'message': 'Token expired'}),
                401,
                headers: {'content-type': 'application/json'},
              );
            }
            expect(req.headers['Authorization'], 'Bearer new-access');
            return http.Response(
              jsonEncode({'success': true, 'data': 'ok'}),
              200,
              headers: {'content-type': 'application/json'},
            );
          }),
        );

        final resp = await VHHttpClient.get('/ping');
        expect(resp.isSuccess, isTrue);
        expect(
          getCount,
          2,
          reason: 'Original request should have been retried',
        );
        expect(await AuthService.getJwt(), 'new-access');
      },
    );

    test(
      '401 → refresh fails → clears tokens + fires onSessionExpired',
      () async {
        await AuthService.setJwt('old-access');
        await AuthService.setRefreshToken('old-refresh');

        String? expiredMessage;
        VHHttpClient.onSessionExpired = (msg) => expiredMessage = msg;

        VHHttpClient.setClientForTesting(
          MockClient((req) async {
            if (req.url.toString() == _refreshUrl) {
              return http.Response(
                jsonEncode({'success': false}),
                401,
                headers: {'content-type': 'application/json'},
              );
            }
            return http.Response(
              jsonEncode({'success': false, 'message': 'Expired'}),
              401,
              headers: {'content-type': 'application/json'},
            );
          }),
        );

        final resp = await VHHttpClient.get('/ping');
        expect(resp.isUnauthorized, isTrue);
        expect(expiredMessage, isNotNull);
        expect(await AuthService.getJwt(), isNull);
        expect(await AuthService.getRefreshToken(), isNull);
      },
    );
  });

  group('VHHttpClient - getBytes', () {
    test('returns binary body bytes with authenticated headers', () async {
      await AuthService.setJwt('pdf-access');

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          expect(req.method, 'GET');
          expect(req.url.toString(), '${ApiConfig.baseUrl}/billing.pdf');
          expect(req.headers['Authorization'], 'Bearer pdf-access');
          return http.Response.bytes(
            [0x25, 0x50, 0x44, 0x46],
            200,
            headers: {'content-type': 'application/pdf'},
          );
        }),
      );

      final resp = await VHHttpClient.getBytes('/billing.pdf');

      expect(resp.statusCode, 200);
      expect(resp.bodyBytes, [0x25, 0x50, 0x44, 0x46]);
    });

    test('401 refresh retry preserves binary response', () async {
      await AuthService.setJwt('old-access');

      var pdfCount = 0;
      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          if (req.url.toString() == _refreshUrl) {
            return http.Response(
              jsonEncode({
                'success': true,
                'data': {'token': 'new-access'},
              }),
              200,
              headers: {'content-type': 'application/json'},
            );
          }

          pdfCount++;
          if (pdfCount == 1) {
            expect(req.headers['Authorization'], 'Bearer old-access');
            return http.Response(
              jsonEncode({'success': false, 'message': 'Expired'}),
              401,
              headers: {'content-type': 'application/json'},
            );
          }

          expect(req.headers['Authorization'], 'Bearer new-access');
          return http.Response.bytes(
            [0x25, 0x50, 0x44, 0x46],
            200,
            headers: {'content-type': 'application/pdf'},
          );
        }),
      );

      final resp = await VHHttpClient.getBytes('/billing.pdf');

      expect(resp.statusCode, 200);
      expect(resp.bodyBytes, [0x25, 0x50, 0x44, 0x46]);
      expect(pdfCount, 2);
      expect(await AuthService.getJwt(), 'new-access');
    });
  });

  group('VHHttpClient - multipart', () {
    test('captures request id from streamed response headers', () async {
      await AuthService.setJwt('access');

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          expect(req.method, 'POST');
          expect(req.url.toString(), '${ApiConfig.baseUrl}/upload');
          return http.Response(
            jsonEncode({'success': false, 'message': 'Upload failed'}),
            500,
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'upload-ref-123456',
            },
          );
        }),
      );

      final resp = await VHHttpClient.multipart(
        '/upload',
        fields: {'kind': 'photo'},
      );

      expect(resp.requestId, 'upload-ref-123456');
      expect(resp.failureMessage(), 'Upload failed · ref upload-r');
    });
  });

  group('VHHttpClient - device type header', () {
    test(
      'adds a normalized X-Device-Type hint to authenticated requests',
      () async {
        await AuthService.setJwt('staff-access');
        VHHttpClient.deviceTypeProvider = () => ' Desktop ';

        VHHttpClient.setClientForTesting(
          MockClient((req) async {
            expect(req.method, 'GET');
            expect(req.headers['Authorization'], 'Bearer staff-access');
            expect(req.headers['X-Device-Type'], 'desktop');
            return http.Response(
              jsonEncode({'success': true, 'data': 'ok'}),
              200,
              headers: {'content-type': 'application/json'},
            );
          }),
        );

        final resp = await VHHttpClient.get('/device-check');
        expect(resp.isSuccess, isTrue);
      },
    );

    test('adds X-Device-Type to unauthenticated JSON requests', () async {
      VHHttpClient.deviceTypeProvider = () => 'tablet';

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          expect(req.method, 'POST');
          expect(req.headers['X-Device-Type'], 'tablet');
          expect(req.headers['Content-Type'], 'application/json');
          return http.Response(
            jsonEncode({'success': true, 'data': {}}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final resp = await VHHttpClient.post(
        '/auth/staff/login',
        auth: false,
        body: {'employeeId': 'EMP-1004'},
      );
      expect(resp.isSuccess, isTrue);
    });

    test('drops unknown device type values', () async {
      await AuthService.setJwt('staff-access');
      VHHttpClient.deviceTypeProvider = () => 'kiosk';

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          expect(req.headers.containsKey('X-Device-Type'), isFalse);
          return http.Response(
            jsonEncode({'success': true}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final resp = await VHHttpClient.get('/device-check');
      expect(resp.isSuccess, isTrue);
    });
  });

  group('VHHttpClient - App Check header', () {
    test('attaches X-Firebase-AppCheck on authenticated POST', () async {
      await AuthService.setJwt('access');
      VHHttpClient.appCheckTokenProvider = () async => 'attest-token';

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          expect(req.method, 'POST');
          expect(req.headers['Authorization'], 'Bearer access');
          expect(req.headers['X-Firebase-AppCheck'], 'attest-token');
          return http.Response(
            jsonEncode({'success': true, 'data': {}}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final resp = await VHHttpClient.post('/vitals', body: {'bp': '120/80'});
      expect(resp.isSuccess, isTrue);
    });

    test('attaches X-Firebase-AppCheck on unauthenticated requests', () async {
      // The pre-API-key /auth/firebase mount verifies App Check before any
      // JWT exists, so the header must ride auth:false calls too.
      VHHttpClient.appCheckTokenProvider = () async => 'attest-token';

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          expect(req.headers.containsKey('Authorization'), isFalse);
          expect(req.headers['X-Firebase-AppCheck'], 'attest-token');
          return http.Response(
            jsonEncode({'success': true, 'data': {}}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final resp = await VHHttpClient.post(
        '/auth/firebase/firebase-login',
        auth: false,
        body: {'idToken': 'firebase-id-token'},
      );
      expect(resp.isSuccess, isTrue);
    });

    test('omits the header when no provider is installed', () async {
      await AuthService.setJwt('access');

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          expect(req.headers.containsKey('X-Firebase-AppCheck'), isFalse);
          return http.Response(
            jsonEncode({'success': true, 'data': 'ok'}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final resp = await VHHttpClient.get('/ping');
      expect(resp.isSuccess, isTrue);
    });

    test('omits the header when the provider returns null or empty', () async {
      await AuthService.setJwt('access');

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          expect(req.headers.containsKey('X-Firebase-AppCheck'), isFalse);
          return http.Response(
            jsonEncode({'success': true, 'data': 'ok'}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      VHHttpClient.appCheckTokenProvider = () async => null;
      expect((await VHHttpClient.get('/ping')).isSuccess, isTrue);

      VHHttpClient.appCheckTokenProvider = () async => '';
      expect((await VHHttpClient.get('/ping')).isSuccess, isTrue);
    });

    test('fails open when the provider throws — request succeeds', () async {
      await AuthService.setJwt('access');
      VHHttpClient.appCheckTokenProvider = () async =>
          throw StateError('App Check not activated');

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          expect(req.headers.containsKey('X-Firebase-AppCheck'), isFalse);
          return http.Response(
            jsonEncode({'success': true, 'data': 'ok'}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final resp = await VHHttpClient.get('/ping');
      expect(resp.isSuccess, isTrue);
    });

    test('fails open when the provider hangs past the timeout', () async {
      await AuthService.setJwt('access');
      VHHttpClient.appCheckTokenTimeout = const Duration(milliseconds: 50);
      // Never completes — the timeout must release the request without it.
      VHHttpClient.appCheckTokenProvider = () => Completer<String?>().future;

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          expect(req.headers.containsKey('X-Firebase-AppCheck'), isFalse);
          return http.Response(
            jsonEncode({'success': true, 'data': 'ok'}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final resp = await VHHttpClient.get('/ping');
      expect(resp.isSuccess, isTrue);
    });
  });

  group('VHHttpClient - server-issued continuity facility context', () {
    test('sends the facility ID and signed context together', () async {
      await AuthService.setJwt('staff-access');
      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          expect(req.headers['X-VH-Continuity-Facility-Id'], '17');
          expect(
            req.headers['X-VH-Continuity-Facility-Context'],
            'signed-envelope',
          );
          return http.Response(
            jsonEncode({'success': true, 'data': {}}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final response = await VHHttpClient.get(
        '/downtime/reconciliation/workbench',
        continuityFacilityId: '17',
        continuityFacilityContext: 'signed-envelope',
      );
      expect(response.isSuccess, isTrue);
    });

    test(
      'rejects partial or malformed facility authority before transport',
      () async {
        await expectLater(
          VHHttpClient.get(
            '/downtime/reconciliation/workbench',
            continuityFacilityId: '17',
          ),
          throwsArgumentError,
        );
        await expectLater(
          VHHttpClient.get(
            '/downtime/reconciliation/workbench',
            continuityFacilityId: 'client-facility',
            continuityFacilityContext: 'signed-envelope',
          ),
          throwsArgumentError,
        );
      },
    );
  });

  group('VHHttpClient — idempotency key (#10)', () {
    test(
      'auto-mints a stable Idempotency-Key reused across a 5xx retry',
      () async {
        await AuthService.setJwt('access');

        var postCount = 0;
        final keys = <String?>[];
        VHHttpClient.setClientForTesting(
          MockClient((req) async {
            postCount++;
            keys.add(req.headers['Idempotency-Key']);
            if (postCount == 1) {
              // First attempt 5xx → _sendWithRetry retries the SAME request.
              return http.Response(
                jsonEncode({'success': false, 'message': 'flaky'}),
                500,
                headers: {'content-type': 'application/json'},
              );
            }
            return http.Response(
              jsonEncode({'success': true, 'data': {}}),
              200,
              headers: {'content-type': 'application/json'},
            );
          }),
        );

        final resp = await VHHttpClient.post(
          '/pharmacy-orders/orders/place',
          body: {'x': 1},
        );

        expect(resp.isSuccess, isTrue);
        expect(postCount, 2, reason: 'a 5xx must be retried');
        // Both attempts must carry a non-null, IDENTICAL key so the backend
        // dedups the retried (possibly lost-2xx) write instead of double-writing.
        expect(keys[0], isNotNull);
        expect(keys[0], keys[1]);
      },
    );

    test('uses the caller-supplied Idempotency-Key verbatim', () async {
      await AuthService.setJwt('access');

      String? observed;
      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          observed = req.headers['Idempotency-Key'];
          return http.Response(
            jsonEncode({'success': true, 'data': {}}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      await VHHttpClient.post('/x', body: {}, idempotencyKey: 'caller-key-123');
      expect(observed, 'caller-key-123');
    });
  });

  group('VHHttpClient — retryTransientFailures: false (teardown calls)', () {
    test(
      'a teardown 401 cannot refresh or rewrite credentials when disabled',
      () async {
        await AuthService.setJwt('old-access');

        var logoutCalls = 0;
        var refreshCalls = 0;
        var sessionExpiryCallbacks = 0;
        VHHttpClient.onSessionExpired = (_) => sessionExpiryCallbacks++;
        VHHttpClient.setClientForTesting(
          MockClient((req) async {
            if (req.url.toString() == _refreshUrl) {
              refreshCalls++;
              return http.Response(
                jsonEncode({
                  'success': true,
                  'data': {'accessToken': 'late-access'},
                }),
                200,
                headers: {'content-type': 'application/json'},
              );
            }
            logoutCalls++;
            return http.Response(
              jsonEncode({'success': false, 'message': 'expired'}),
              401,
              headers: {'content-type': 'application/json'},
            );
          }),
        );

        final resp = await VHHttpClient.post(
          '/auth/logout',
          body: const {},
          retryTransientFailures: false,
          refreshOnUnauthorized: false,
        );

        expect(resp.isUnauthorized, isTrue);
        expect(logoutCalls, 1);
        expect(refreshCalls, 0);
        expect(await AuthService.getJwt(), 'old-access');
        expect(sessionExpiryCallbacks, 1);
      },
    );

    test('the default POST policy still refreshes and retries a 401', () async {
      await AuthService.setJwt('old-access');

      var logoutCalls = 0;
      var refreshCalls = 0;
      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          if (req.url.toString() == _refreshUrl) {
            refreshCalls++;
            return http.Response(
              jsonEncode({
                'success': true,
                'data': {'accessToken': 'new-access'},
              }),
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          logoutCalls++;
          if (logoutCalls == 1) {
            return http.Response(
              jsonEncode({'success': false, 'message': 'expired'}),
              401,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(
            jsonEncode({'success': true, 'data': {}}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final resp = await VHHttpClient.post('/auth/logout', body: const {});

      expect(resp.isSuccess, isTrue);
      expect(logoutCalls, 2);
      expect(refreshCalls, 1);
      expect(await AuthService.getJwt(), 'new-access');
    });

    test('a 5xx is NOT retried when transient retries are disabled', () async {
      await AuthService.setJwt('access');

      var postCount = 0;
      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          postCount++;
          return http.Response(
            jsonEncode({'success': false, 'message': 'down'}),
            503,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final resp = await VHHttpClient.post(
        '/auth/logout',
        body: const {},
        retryTransientFailures: false,
      );

      expect(resp.isSuccess, isFalse);
      expect(
        postCount,
        1,
        reason:
            'logout-style teardown calls must be single-shot — the standard '
            '3-attempt backoff holds the local PHI wipe hostage',
      );
    });

    test(
      'a network error surfaces immediately instead of backing off',
      () async {
        await AuthService.setJwt('access');

        var postCount = 0;
        VHHttpClient.setClientForTesting(
          MockClient((req) async {
            postCount++;
            throw http.ClientException('connection refused');
          }),
        );

        await expectLater(
          VHHttpClient.post(
            '/auth/logout',
            body: const {},
            retryTransientFailures: false,
          ),
          throwsA(isA<http.ClientException>()),
        );
        expect(postCount, 1);
      },
    );

    test('the default policy still retries a 5xx (unchanged)', () async {
      await AuthService.setJwt('access');

      var postCount = 0;
      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          postCount++;
          if (postCount == 1) {
            return http.Response(
              jsonEncode({'success': false, 'message': 'flaky'}),
              500,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(
            jsonEncode({'success': true, 'data': {}}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final resp = await VHHttpClient.post('/x', body: {'a': 1});
      expect(resp.isSuccess, isTrue);
      expect(postCount, 2);
    });
  });
}
