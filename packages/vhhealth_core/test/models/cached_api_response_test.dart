import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/api_response.dart';

void main() {
  test('cachedAt is additive and optional', () {
    const response = ApiResponse(statusCode: 200, isSuccess: true);
    final cachedAt = DateTime.utc(2026, 8, 2, 12);

    expect(
      const CachedApiResponse(
        response: response,
        fromCache: false,
        staleLabel: null,
      ).cachedAt,
      isNull,
    );
    expect(
      CachedApiResponse(
        response: response,
        fromCache: true,
        staleLabel: null,
        cachedAt: cachedAt,
      ).cachedAt,
      cachedAt,
    );
  });
}
