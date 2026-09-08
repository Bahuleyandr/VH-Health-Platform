import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/http_client.dart';

class _ControlledClient extends http.BaseClient {
  _ControlledClient(this.respond);

  final Future<http.StreamedResponse> Function(http.BaseRequest) respond;
  final requests = <http.BaseRequest>[];
  final finalizationFailure = Completer<Object>();
  var aborts = 0;
  var closes = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    if (request is http.Abortable) {
      request.abortTrigger?.then((_) => aborts++);
    }
    try {
      await request.finalize().toBytes();
    } catch (error) {
      finalizationFailure.complete(error);
      rethrow;
    }
    return respond(request);
  }

  @override
  void close() => closes++;
}

class _Outcome {
  _Outcome(Future<ApiResponse> pending) {
    pending.then<void>(
      (response) => value = response,
      onError: (Object failure, StackTrace stack) => error = failure,
    );
  }

  ApiResponse? value;
  Object? error;
}

http.StreamedResponse _response(
  int status, {
  Stream<List<int>>? body,
  Map<String, dynamic>? data,
}) => http.StreamedResponse(
  body ??
      Stream.value(
        utf8.encode(
          jsonEncode({
            'success': status == 200,
            'data': data ?? {'id': 71},
            if (status != 200) 'message': 'synthetic denial',
          }),
        ),
      ),
  status,
  headers: {'content-type': 'application/json', 'x-request-id': 'upload-ref'},
);

Future<ApiResponse> _upload({String path = '/upload', bool auth = false}) =>
    VHHttpClient.multipart(
      path,
      auth: auth,
      timeout: const Duration(seconds: 10),
      fileBuilder: () async => [
        http.MultipartFile.fromString('file', 'synthetic'),
      ],
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late int expired;
  late List<StreamController<List<int>>> bodies;

  StreamController<List<int>> body({FutureOr<void> Function()? onCancel}) {
    final controller = StreamController<List<int>>(onCancel: onCancel);
    bodies.add(controller);
    return controller;
  }

  setUp(() async {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    expired = 0;
    bodies = [];
    VHHttpClient.onSessionExpired = (_) => expired++;
    await AuthService.setTokens(
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
    );
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    for (final controller in bodies) {
      if (!controller.isClosed) unawaited(controller.close());
    }
  });

  void check(String description, Future<void> Function(WidgetTester) run) {
    testWidgets(description, (tester) async {
      try {
        await run(tester);
      } finally {
        for (final controller in bodies) {
          if (!controller.isClosed) unawaited(controller.close());
        }
        await tester.pump();
      }
    });
  }

  check('nonclosing body times out and cancels only its request', (
    tester,
  ) async {
    var cancelled = 0;
    final stalled = body(onCancel: () => cancelled++);
    final client = _ControlledClient(
      (_) async => _response(200, body: stalled.stream),
    );
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(_upload(auth: true));
    await tester.pump();
    await tester.pump(const Duration(seconds: 10));
    expect(outcome.error, isA<TimeoutException>());
    expect(outcome.value, isNull);
    expect(cancelled, 1);
    expect(client.aborts, 1);
    expect(client.closes, 0);
    expect(client.requests, hasLength(1));
    expect(expired, 0);
    expect(await AuthService.getJwt(), 'old-access');
  });

  check('headers and body share one absolute deadline', (tester) async {
    var cancelled = 0;
    final delayedBody = body(onCancel: () => cancelled++);
    final headers = Completer<http.StreamedResponse>();
    final client = _ControlledClient((_) => headers.future);
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(_upload());
    await tester.pump();
    await tester.pump(const Duration(seconds: 8));
    headers.complete(_response(200, body: delayedBody.stream));
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    expect(outcome.error, isA<TimeoutException>());
    expect(cancelled, 1);
    expect(client.requests, hasLength(1));
  });

  check('default upload deadline includes the response body', (tester) async {
    final stalled = body();
    final client = _ControlledClient(
      (_) async => _response(200, body: stalled.stream),
    );
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(VHHttpClient.multipart('/upload', auth: false));
    await tester.pump();
    await tester.pump(const Duration(seconds: 29));
    expect(outcome.error, isNull);
    await tester.pump(const Duration(seconds: 1));
    expect(outcome.error, isA<TimeoutException>());
    expect(client.requests, hasLength(1));
  });

  check('completed chunked UTF8 body retains its envelope before deadline', (
    tester,
  ) async {
    final chunks = body();
    final client = _ControlledClient(
      (_) async => _response(200, body: chunks.stream),
    );
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(_upload());
    await tester.pump();
    final encoded = utf8.encode(
      jsonEncode({
        'success': true,
        'data': {'label': 'synthetic π'},
      }),
    );
    final split = encoded.indexOf(207) + 1;
    expect(split, greaterThan(0));
    chunks.add(encoded.sublist(0, split));
    await tester.pump(const Duration(seconds: 9));
    expect(outcome.value, isNull);
    chunks.add(encoded.sublist(split));
    unawaited(chunks.close());
    await tester.pump();
    expect(outcome.error, isNull);
    expect(outcome.value?.data, {'label': 'synthetic π'});
    await tester.pump(const Duration(seconds: 1));
    expect(client.aborts, 0);
  });

  check('file preparation remains outside the transport deadline', (
    tester,
  ) async {
    final prepared = Completer<List<http.MultipartFile>>();
    final client = _ControlledClient((_) async => _response(200));
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(
      VHHttpClient.multipart(
        '/upload',
        auth: false,
        timeout: const Duration(seconds: 10),
        fileBuilder: () => prepared.future,
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 20));
    expect(client.requests, isEmpty);
    expect(outcome.error, isNull);
    prepared.complete([http.MultipartFile.fromString('file', 'synthetic')]);
    await tester.pump();
    expect(outcome.value?.statusCode, 200);
    expect(client.aborts, 0);
  });

  check('regular body chunks cannot extend the deadline', (tester) async {
    final trickle = body();
    final client = _ControlledClient(
      (_) async => _response(200, body: trickle.stream),
    );
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(_upload());
    await tester.pump();
    for (var second = 0; second < 10; second++) {
      trickle.add(utf8.encode(' '));
      await tester.pump(const Duration(seconds: 1));
    }
    expect(outcome.error, isA<TimeoutException>());
    expect(client.requests, hasLength(1));
  });

  check('late headers are cancelled without parsing or refreshing', (
    tester,
  ) async {
    var cancelled = 0;
    final lateBody = body(onCancel: () => cancelled++);
    final headers = Completer<http.StreamedResponse>();
    final client = _ControlledClient((_) => headers.future);
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(_upload(auth: true));
    await tester.pump();
    await tester.pump(const Duration(seconds: 10));
    expect(outcome.error, isA<TimeoutException>());
    headers.complete(_response(401, body: lateBody.stream));
    await tester.pump();
    lateBody.addError(StateError('late synthetic response error'));
    await tester.pump();
    expect(cancelled, 1);
    expect(client.requests, hasLength(1));
    expect(expired, 0);
    expect(outcome.value, isNull);
  });

  check('late send failure is handled after timeout', (tester) async {
    final headers = Completer<http.StreamedResponse>();
    final client = _ControlledClient((_) => headers.future);
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(_upload());
    await tester.pump();
    await tester.pump(const Duration(seconds: 10));
    expect(outcome.error, isA<TimeoutException>());
    headers.completeError(http.ClientException('late synthetic send failure'));
    await tester.pump();
    expect(outcome.error, isA<TimeoutException>());
    expect(client.requests, hasLength(1));
  });

  test('late request finalization failure is handled after timeout', () async {
    final source = body();
    final client = _ControlledClient((_) async => _response(200));
    VHHttpClient.setClientForTesting(client);
    final pending = VHHttpClient.multipart(
      '/upload',
      auth: false,
      timeout: Duration.zero,
      files: [http.MultipartFile('file', source.stream, 1)],
    );
    final outcome = _Outcome(pending);
    await expectLater(pending, throwsA(isA<TimeoutException>()));
    final failure = StateError('late synthetic upload failure');
    source.addError(failure);
    expect(await client.finalizationFailure.future, same(failure));
    expect(outcome.error, isA<TimeoutException>());
    expect(client.requests, hasLength(1));
    expect(expired, 0);
  });

  test('request finalization error is propagated without replay', () async {
    final source = body();
    final client = _ControlledClient((_) async => _response(200));
    VHHttpClient.setClientForTesting(client);
    final pending = VHHttpClient.multipart(
      '/upload',
      timeout: const Duration(seconds: 10),
      files: [http.MultipartFile('file', source.stream, 1)],
    );
    final failure = StateError('synthetic upload failure');
    final assertion = expectLater(pending, throwsA(same(failure)));
    source.addError(failure);
    await assertion;
    expect(await client.finalizationFailure.future, same(failure));
    expect(client.requests, hasLength(1));
    expect(client.aborts, 0);
    expect(expired, 0);
  });

  for (final failure in [false, true]) {
    check('cancellation cannot delay timeout (throws=$failure)', (
      tester,
    ) async {
      final stalled = body(
        onCancel: () => failure
            ? Future<void>.error(StateError('synthetic cancellation failure'))
            : Completer<void>().future,
      );
      final client = _ControlledClient(
        (_) async => _response(200, body: stalled.stream),
      );
      VHHttpClient.setClientForTesting(client);
      final outcome = _Outcome(_upload());
      await tester.pump();
      await tester.pump(const Duration(seconds: 10));
      expect(outcome.error, isA<TimeoutException>());
      expect(client.closes, 0);
      expect(client.requests, hasLength(1));
    });
  }

  check('body error is not retried and does not expire session', (
    tester,
  ) async {
    final broken = body();
    final client = _ControlledClient(
      (_) async => _response(200, body: broken.stream),
    );
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(_upload(auth: true));
    await tester.pump();
    final failure = http.ClientException('synthetic body failure');
    broken.addError(failure);
    await tester.pump();
    expect(outcome.error, same(failure));
    await tester.pump(const Duration(seconds: 10));
    expect(client.requests, hasLength(1));
    expect(client.aborts, 0);
    expect(expired, 0);
    expect(await AuthService.getJwt(), 'old-access');
  });

  check('UTF8 decoder error cancels the body without refresh or expiry', (
    tester,
  ) async {
    var cancelled = 0;
    final malformed = body(onCancel: () => cancelled++);
    final client = _ControlledClient(
      (_) async => _response(401, body: malformed.stream),
    );
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(_upload(auth: true));
    await tester.pump();
    malformed.add([255]);
    await tester.pump();
    expect(outcome.error, isA<FormatException>());
    expect(cancelled, 1);
    expect(client.requests, hasLength(1));
    expect(expired, 0);
    await tester.pump(const Duration(seconds: 10));
    expect(client.aborts, 0);
  });

  check('complete non-JSON 401 retains the existing refresh policy', (
    tester,
  ) async {
    var uploads = 0;
    final client = _ControlledClient((request) async {
      if (request.url.path.endsWith('/auth/refresh-token')) {
        return _response(200, data: {'accessToken': 'new-access'});
      }
      uploads++;
      return uploads == 1
          ? _response(401, body: Stream.value(utf8.encode('synthetic denial')))
          : _response(200);
    });
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(_upload(auth: true));
    await tester.pump();
    expect(outcome.error, isNull);
    expect(outcome.value?.statusCode, 200);
    expect(uploads, 2);
    expect(client.requests, hasLength(3));
    expect(client.requests.last.headers['Authorization'], 'Bearer new-access');
    expect(expired, 0);
  });

  check('retried response timeout cannot replay again or expire session', (
    tester,
  ) async {
    final stalled = body();
    var uploads = 0;
    final client = _ControlledClient((request) async {
      if (request.url.path.endsWith('/auth/refresh-token')) {
        return _response(200, data: {'accessToken': 'new-access'});
      }
      uploads++;
      return uploads == 1
          ? _response(401)
          : _response(401, body: stalled.stream);
    });
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(_upload(auth: true));
    await tester.pump();
    await tester.pump(const Duration(seconds: 10));
    expect(outcome.error, isA<TimeoutException>());
    expect(uploads, 2);
    expect(client.requests, hasLength(3));
    expect(client.aborts, 1);
    expect(expired, 0);
    expect(await AuthService.getJwt(), 'new-access');
  });

  for (final status in [200, 403, 500]) {
    check('complete $status response preserves envelope without replay', (
      tester,
    ) async {
      final client = _ControlledClient((_) async => _response(status));
      VHHttpClient.setClientForTesting(client);
      final outcome = _Outcome(_upload(auth: true));
      await tester.pump();
      expect(outcome.error, isNull);
      expect(outcome.value?.statusCode, status);
      expect(outcome.value?.requestId, 'upload-ref');
      await tester.pump(const Duration(seconds: 10));
      expect(client.aborts, 0);
      expect(client.requests, hasLength(1));
      expect(expired, 0);
    });
  }

  check('unrelated requests survive one stalled response', (tester) async {
    final stalled = body();
    final client = _ControlledClient(
      (request) async => request.url.path.endsWith('/slow')
          ? _response(200, body: stalled.stream)
          : _response(200),
    );
    VHHttpClient.setClientForTesting(client);
    final slow = _Outcome(_upload(path: '/slow'));
    final fast = _Outcome(_upload(path: '/fast'));
    await tester.pump();
    expect(fast.value?.statusCode, 200);
    await tester.pump(const Duration(seconds: 10));
    expect(slow.error, isA<TimeoutException>());
    final later = _Outcome(VHHttpClient.get('/later', auth: false));
    await tester.pump();
    expect(later.value?.statusCode, 200);
    expect(client.closes, 0);
    expect(client.requests, hasLength(3));
  });

  check('incomplete 401 cannot refresh or expire session', (tester) async {
    final stalled = body();
    final client = _ControlledClient(
      (_) async => _response(401, body: stalled.stream),
    );
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(_upload(auth: true));
    await tester.pump();
    await tester.pump(const Duration(seconds: 10));
    expect(outcome.error, isA<TimeoutException>());
    expect(client.requests, hasLength(1));
    expect(expired, 0);
    expect(await AuthService.getJwt(), 'old-access');
  });

  for (final refreshSucceeds in [true, false]) {
    check(
      'complete 401 preserves refresh behavior (success=$refreshSucceeds)',
      (tester) async {
        var uploads = 0;
        final client = _ControlledClient((request) async {
          if (request.url.path.endsWith('/auth/refresh-token')) {
            return _response(
              refreshSucceeds ? 200 : 401,
              data: {'accessToken': 'new-access'},
            );
          }
          uploads++;
          expectSync(
            request.headers['Authorization'],
            uploads == 1 ? 'Bearer old-access' : 'Bearer new-access',
          );
          return _response(uploads == 1 ? 401 : 200);
        });
        VHHttpClient.setClientForTesting(client);
        final outcome = _Outcome(_upload(auth: true));
        await tester.pump();
        expect(outcome.error, isNull);
        expect(outcome.value?.statusCode, refreshSucceeds ? 200 : 401);
        expect(uploads, refreshSucceeds ? 2 : 1);
        expect(client.requests, hasLength(refreshSucceeds ? 3 : 2));
        expect(expired, refreshSucceeds ? 0 : 1);
        await tester.pump(const Duration(seconds: 10));
        expect(client.aborts, 0);
      },
    );
  }

  check('refresh retry receives a fresh complete-response budget', (
    tester,
  ) async {
    final first = body();
    final retry = body();
    final refreshed = Completer<http.StreamedResponse>();
    var uploads = 0;
    var builds = 0;
    final client = _ControlledClient((request) async {
      if (request.url.path.endsWith('/auth/refresh-token'))
        return refreshed.future;
      uploads++;
      return _response(
        uploads == 1 ? 401 : 200,
        body: uploads == 1 ? first.stream : retry.stream,
      );
    });
    VHHttpClient.setClientForTesting(client);
    final outcome = _Outcome(
      VHHttpClient.multipart(
        '/upload',
        timeout: const Duration(seconds: 10),
        fileBuilder: () async {
          builds++;
          return [http.MultipartFile.fromString('file', 'synthetic')];
        },
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 9));
    first.add(utf8.encode('{"success":false,"message":"synthetic denial"}'));
    unawaited(first.close());
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(outcome.error, isNull);
    refreshed.complete(_response(200, data: {'accessToken': 'new-access'}));
    await tester.pump();
    await tester.pump(const Duration(seconds: 9));
    retry.add(utf8.encode('{"success":true,"data":{"id":71}}'));
    unawaited(retry.close());
    await tester.pump();
    expect(outcome.error, isNull);
    expect(outcome.value?.data, {'id': 71});
    expect(builds, 2);
    expect(uploads, 2);
    expect(client.requests, hasLength(3));
    expect(client.requests.last.headers['Authorization'], 'Bearer new-access');
    expect(client.aborts, 0);
    expect(expired, 0);
  });
}
