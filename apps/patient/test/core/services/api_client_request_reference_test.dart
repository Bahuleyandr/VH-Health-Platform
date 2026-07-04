import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/api_client.dart';

void main() {
  group('ApiClient.failureMessage', () {
    test('appends a short backend request reference to API errors', () {
      const response = ApiResponse(
        statusCode: 500,
        isSuccess: false,
        message: 'Save failed',
        requestId: 'abcdef1234567890',
      );

      expect(
        ApiClient.failureMessage(response, 'Fallback failed'),
        'Save failed · ref abcdef12',
      );
    });

    test('uses the fallback message when backend message is blank', () {
      const response = ApiResponse(
        statusCode: 503,
        isSuccess: false,
        requestId: 'req-9000000',
      );

      expect(
        ApiClient.failureMessage(response, 'Try again later'),
        'Try again later · ref req-9000',
      );
    });

    test('does not duplicate an existing request reference', () {
      const response = ApiResponse(
        statusCode: 400,
        isSuccess: false,
        message: 'Invalid file · ref abcdef12',
        requestId: 'abcdef1234567890',
      );

      expect(
        ApiClient.failureMessage(response, 'Upload failed'),
        'Invalid file · ref abcdef12',
      );
    });
  });
}
