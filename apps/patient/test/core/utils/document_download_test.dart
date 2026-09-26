import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth/core/utils/document_download.dart';
import 'package:vhhealth_core/config/api_config.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/http_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    const channel = MethodChannel(
      'plugins.it_nomads.com/flutter_secure_storage',
    );
    final store = <String, String>{};
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
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
          }
          return null;
        });
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
  });

  test('rejects unsafe initial URLs before any network request', () async {
    var sends = 0;
    final client = MockClient((_) async {
      sends++;
      return http.Response('unexpected', 200);
    });
    final backend = Uri.parse(ApiConfig.baseUrl);
    final invalid = [
      'http://documents.example.test/report.pdf',
      'file:///tmp/report.pdf',
      'data:application/pdf,report',
      'javascript:alert(1)',
      '//documents.example.test/report.pdf',
      '/report.pdf',
      'https://user:pass@documents.example.test/report.pdf',
      'https://documents.example.test/report.pdf#fragment',
      '${backend.origin}/outside/report.pdf',
      '${backend.origin}${backend.path}evil/report.pdf',
      '${backend.origin}${backend.path}/%2e%2e/outside/report.pdf',
      '${backend.origin}${backend.path}/%2e%2e%2foutside/report.pdf',
      '${backend.replace(port: backend.port + 1)}/report.pdf',
    ];
    for (final url in invalid) {
      await expectLater(
        DocumentDownload.get(url, externalClient: client),
        throwsA(isA<DocumentUrlException>()),
        reason: url,
      );
    }
    expect(sends, 0);
  });

  test('off-host HTTPS signed documents use an unauthenticated GET', () async {
    final client = MockClient((request) async {
      expect(
        request.url.toString(),
        'https://storage.example.test/report.pdf?signature=abc',
      );
      expect(request.headers, isEmpty);
      expect(request.followRedirects, isFalse);
      return http.Response.bytes([1, 2, 3], 200);
    });
    final response = await DocumentDownload.get(
      'https://storage.example.test/report.pdf?signature=abc',
      externalClient: client,
    );
    expect(response.bodyBytes, [1, 2, 3]);
  });

  test('HTTPS redirects are checked before every subsequent request', () async {
    final requests = <Uri>[];
    final client = MockClient((request) async {
      requests.add(request.url);
      expect(request.followRedirects, isFalse);
      if (requests.length == 1) {
        return http.Response(
          '',
          302,
          headers: {'location': '/final.pdf?signature=abc'},
        );
      }
      return http.Response.bytes([4, 5], 200);
    });
    final response = await DocumentDownload.get(
      'https://storage.example.test/first.pdf',
      externalClient: client,
    );
    expect(response.bodyBytes, [4, 5]);
    expect(requests.map((url) => url.toString()), [
      'https://storage.example.test/first.pdf',
      'https://storage.example.test/final.pdf?signature=abc',
    ]);
  });

  test(
    'redirect downgrade and API-origin redirect stop before a second send',
    () async {
      for (final location in [
        'http://storage.example.test/final.pdf',
        'data:application/pdf,unsafe',
        '${ApiConfig.baseUrl}/storage/file/report.pdf',
      ]) {
        var sends = 0;
        final client = MockClient((_) async {
          sends++;
          return http.Response('', 302, headers: {'location': location});
        });
        await expectLater(
          DocumentDownload.get(
            'https://storage.example.test/first.pdf',
            externalClient: client,
          ),
          throwsA(isA<DocumentUrlException>()),
        );
        expect(sends, 1);
      }
    },
  );

  test('rejects a downgrade before reading a failed redirect body', () async {
    var sends = 0;
    final client = _StreamClient((request) async {
      sends++;
      return http.StreamedResponse(
        Stream<List<int>>.error(StateError('redirect body was read')),
        302,
        headers: {'location': 'http://storage.example.test/report.pdf'},
        request: request,
      );
    });
    await expectLater(
      DocumentDownload.get(
        'https://storage.example.test/first.pdf',
        externalClient: client,
      ),
      throwsA(isA<DocumentUrlException>()),
    );
    expect(sends, 1);
  });

  test('same-origin API path keeps duplicate query parameters and blocks redirects', () async {
    final backend = Uri.parse(ApiConfig.baseUrl);
    final url =
        '${backend.origin}${backend.path}/storage/file/report.pdf?token=a&token=b';
    var sends = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        sends++;
        expect(request.url.toString(), url);
        expect(request.followRedirects, isFalse);
        return http.Response(
          '',
          302,
          headers: {'location': 'http://elsewhere.test'},
        );
      }),
    );
    await expectLater(
      DocumentDownload.get(url),
      throwsA(isA<DocumentUrlException>()),
    );
    expect(sends, 1);
  });

  test(
    'equivalent API-origin spelling keeps the pinned authenticated path',
    () async {
      await AuthService.setJwt('patient-document-token');
      final backend = Uri.parse(ApiConfig.baseUrl);
      final url =
          '${backend.scheme.toUpperCase()}://${backend.authority.toUpperCase()}'
          '${backend.path}/storage/file/report.pdf?token=a&token=b';
      var sends = 0;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          sends++;
          expect(request.url.host, backend.host);
          expect(request.url.path, '${backend.path}/storage/file/report.pdf');
          expect(request.url.query, 'token=a&token=b');
          expect(
            request.headers['Authorization'],
            'Bearer patient-document-token',
          );
          expect(request.followRedirects, isFalse);
          return http.Response.bytes([7, 8], 200);
        }),
      );
      final response = await DocumentDownload.get(url);
      expect(response.bodyBytes, [7, 8]);
      expect(sends, 1);
    },
  );

  test(
    'an explicit default API port keeps the pinned authenticated path',
    () async {
      final backend = Uri.parse(ApiConfig.baseUrl);
      final url =
          '${backend.scheme}://${backend.host}:${backend.port}'
          '${backend.path}/storage/file/report.pdf';
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.url.host, backend.host);
          expect(request.url.port, backend.port);
          expect(request.followRedirects, isFalse);
          return http.Response.bytes([9], 200);
        }),
      );
      final response = await DocumentDownload.get(url);
      expect(response.bodyBytes, [9]);
    },
  );
}

class _StreamClient extends http.BaseClient {
  _StreamClient(this._send);

  final Future<http.StreamedResponse> Function(http.BaseRequest) _send;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      _send(request);
}
