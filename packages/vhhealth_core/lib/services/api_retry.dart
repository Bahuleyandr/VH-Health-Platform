import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

/// Retry wrapper with exponential backoff for API calls.
class ApiRetry {
  ApiRetry._();

  static Future<T> withRetry<T>(
    Future<T> Function() action, {
    int maxRetries = 3,
    Duration initialDelay = const Duration(seconds: 1),
    bool Function(dynamic error)? shouldRetry,
  }) async {
    int attempt = 0;
    while (true) {
      try {
        return await action();
      } catch (e) {
        attempt++;
        if (attempt >= maxRetries) rethrow;
        if (shouldRetry != null && !shouldRetry(e)) rethrow;

        final delay = initialDelay * pow(2, attempt - 1).toInt();
        if (kDebugMode) {
          debugPrint(
            'ApiRetry: attempt $attempt failed, retrying in ${delay.inMilliseconds}ms',
          );
        }
        await Future.delayed(delay);
      }
    }
  }
}
