import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_core/utils/request_reference.dart';

void main() {
  group('ApiResponse.parse', () {
    test('parses successful response with data envelope', () {
      final body = jsonEncode({
        'success': true,
        'message': 'Fetched successfully',
        'data': {'id': 1, 'name': 'Test'},
      });
      final resp = ApiResponse.parse(200, body);

      expect(resp.statusCode, 200);
      expect(resp.isSuccess, isTrue);
      expect(resp.isUnauthorized, isFalse);
      expect(resp.message, 'Fetched successfully');
      expect(resp.data, isA<Map>());
      expect(resp.data['id'], 1);
    });

    test('parses 401 as unauthorized', () {
      final body = jsonEncode({'success': false, 'message': 'Token expired'});
      final resp = ApiResponse.parse(401, body);

      expect(resp.isUnauthorized, isTrue);
      expect(resp.isSuccess, isFalse);
      expect(resp.message, 'Token expired');
    });

    test('uses error field as fallback message', () {
      final body = jsonEncode({'error': 'Invalid API Key'});
      final resp = ApiResponse.parse(401, body);

      expect(resp.isSuccess, isFalse);
      expect(resp.message, 'Invalid API Key');
    });

    test('parses 500 as server error', () {
      final body = jsonEncode({
        'success': false,
        'message': 'Internal server error',
      });
      final resp = ApiResponse.parse(500, body);

      expect(resp.isSuccess, isFalse);
      expect(resp.isUnauthorized, isFalse);
    });

    test('handles malformed JSON gracefully', () {
      final resp = ApiResponse.parse(200, 'not json');

      expect(resp.statusCode, 200);
      expect(resp.isSuccess, isTrue);
      expect(resp.data, 'not json');
    });

    test('handles empty body', () {
      final resp = ApiResponse.parse(204, '');

      expect(resp.statusCode, 204);
      expect(resp.isSuccess, isTrue);
    });

    test('parses array data correctly', () {
      final body = jsonEncode({
        'success': true,
        'data': [
          {'id': 1},
          {'id': 2},
        ],
      });
      final resp = ApiResponse.parse(200, body);

      expect(resp.data, isA<List>());
      expect(resp.data.length, 2);
    });

    test('captures request id from HTTP headers', () {
      final response = http.Response(
        jsonEncode({'success': false, 'message': 'Nope'}),
        500,
        headers: {'x-request-id': 'abcdef1234567890'},
      );

      final resp = ApiResponse.fromHttp(response);

      expect(resp.requestId, 'abcdef1234567890');
      expect(resp.failureMessage(), 'Nope · ref abcdef12');
    });

    test(
      'captures request id from response envelope when header is absent',
      () {
        final resp = ApiResponse.parse(
          400,
          jsonEncode({
            'success': false,
            'message': 'Invalid request',
            'requestId': 'req-9000000',
          }),
        );

        expect(resp.requestId, 'req-9000000');
        expect(resp.failureMessage(), 'Invalid request · ref req-9000');
      },
    );
  });

  group('request reference formatter', () {
    test('appends the first eight request-id characters', () {
      expect(
        formatErrorWithRequestRef('Save failed', requestId: 'abcdef1234567890'),
        'Save failed · ref abcdef12',
      );
    });

    test('leaves blank request ids and existing refs alone', () {
      expect(
        formatErrorWithRequestRef(' Save failed ', requestId: ' '),
        'Save failed',
      );
      expect(
        formatErrorWithRequestRef(
          'Save failed · ref abcdef12',
          requestId: 'abcdef1234567890',
        ),
        'Save failed · ref abcdef12',
      );
    });
  });

  group('ApiResponse.dataAsList', () {
    test('returns list from data when data is a list', () {
      final body = jsonEncode({
        'data': [1, 2, 3],
      });
      final resp = ApiResponse.parse(200, body);

      expect(resp.dataAsList(), [1, 2, 3]);
    });

    test('returns empty list when data is a map', () {
      final body = jsonEncode({
        'data': {'key': 'value'},
      });
      final resp = ApiResponse.parse(200, body);

      expect(resp.dataAsList(), isEmpty);
    });

    test('returns nested list by key', () {
      final body = jsonEncode({
        'data': {
          'items': [1, 2, 3],
        },
      });
      final resp = ApiResponse.parse(200, body);

      expect(resp.dataAsList('items'), [1, 2, 3]);
    });

    test('returns empty list for missing key', () {
      final body = jsonEncode({
        'data': {'other': 'value'},
      });
      final resp = ApiResponse.parse(200, body);

      expect(resp.dataAsList('items'), isEmpty);
    });
  });

  group('ApiResponse.dataAsMap', () {
    test('returns map when data is a map', () {
      final body = jsonEncode({
        'data': {'id': 1, 'name': 'Test'},
      });
      final resp = ApiResponse.parse(200, body);

      expect(resp.dataAsMap(), {'id': 1, 'name': 'Test'});
    });

    test('returns empty map when data is a list', () {
      final body = jsonEncode({
        'data': [1, 2, 3],
      });
      final resp = ApiResponse.parse(200, body);

      expect(resp.dataAsMap(), isEmpty);
    });

    test('returns empty map when data is null', () {
      final body = jsonEncode({'success': true, 'message': 'OK'});
      final resp = ApiResponse.parse(200, body);

      expect(resp.dataAsMap(), isEmpty);
    });
  });

  group('Status code ranges', () {
    test('200-299 are success', () {
      for (final code in [200, 201, 204, 299]) {
        final resp = ApiResponse.parse(code, '{}');
        expect(resp.isSuccess, isTrue, reason: 'Expected $code to be success');
      }
    });

    test('300+ are not success', () {
      for (final code in [300, 400, 401, 403, 404, 500]) {
        final resp = ApiResponse.parse(code, '{}');
        expect(
          resp.isSuccess,
          isFalse,
          reason: 'Expected $code to not be success',
        );
      }
    });
  });
}
