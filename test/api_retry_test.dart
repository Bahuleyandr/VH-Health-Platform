import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/api_retry.dart';

void main() {
  group('ApiRetry.withRetry', () {
    test('returns immediately on first-try success', () async {
      var calls = 0;
      final result = await ApiRetry.withRetry(() async {
        calls++;
        return 'ok';
      });
      expect(result, 'ok');
      expect(calls, 1);
    });

    test('retries once on transient failure, then succeeds', () async {
      var calls = 0;
      final result = await ApiRetry.withRetry(
        () async {
          calls++;
          if (calls < 2) throw Exception('transient');
          return 'ok';
        },
        initialDelay: const Duration(milliseconds: 1),
      );
      expect(result, 'ok');
      expect(calls, 2);
    });

    test('rethrows after maxRetries exhausted', () async {
      var calls = 0;
      await expectLater(
        ApiRetry.withRetry(
          () async {
            calls++;
            throw StateError('still broken');
          },
          maxRetries: 3,
          initialDelay: const Duration(milliseconds: 1),
        ),
        throwsA(isA<StateError>()),
      );
      expect(calls, 3);
    });

    test('shouldRetry callback gates retries', () async {
      var calls = 0;
      await expectLater(
        ApiRetry.withRetry(
          () async {
            calls++;
            throw ArgumentError('client bug');
          },
          maxRetries: 3,
          initialDelay: const Duration(milliseconds: 1),
          shouldRetry: (e) => e is! ArgumentError,
        ),
        throwsA(isA<ArgumentError>()),
      );
      expect(calls, 1, reason: 'ArgumentError should not be retried');
    });

    test('shouldRetry=true still respects maxRetries', () async {
      var calls = 0;
      await expectLater(
        ApiRetry.withRetry(
          () async {
            calls++;
            throw Exception('transient');
          },
          maxRetries: 2,
          initialDelay: const Duration(milliseconds: 1),
          shouldRetry: (_) => true,
        ),
        throwsException,
      );
      expect(calls, 2);
    });
  });
}
