// test/core/offline/api_cache_manager_test.dart
//
// Unit tests for CachedData — the pure data class from api_cache_manager.dart.
// Tests isStale() and ageLabel without file I/O or platform channels.

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';

void main() {
  group('CachedData.isStale', () {
    test('returns false when age is less than TTL', () {
      final cached = CachedData(
        data: {'key': 'value'},
        cachedAt: DateTime.now().subtract(const Duration(minutes: 5)),
      );

      // Default TTL is 15 minutes, 5 min old → not stale
      expect(cached.isStale(), isFalse);
    });

    test('returns true when age exceeds TTL', () {
      final cached = CachedData(
        data: {'key': 'value'},
        cachedAt: DateTime.now().subtract(const Duration(minutes: 20)),
      );

      // Default TTL is 15 minutes, 20 min old → stale
      expect(cached.isStale(), isTrue);
    });

    test('returns false when age exactly equals TTL (not strictly greater)', () {
      // age > ttl, not >=, so exactly equal should be false
      // This is hard to test exactly due to timing, so we use slightly less
      final cached = CachedData(
        data: null,
        cachedAt: DateTime.now().subtract(const Duration(minutes: 14, seconds: 59)),
      );

      expect(cached.isStale(), isFalse);
    });

    test('custom TTL is respected', () {
      final cached = CachedData(
        data: [1, 2, 3],
        cachedAt: DateTime.now().subtract(const Duration(seconds: 30)),
      );

      // 30 seconds old, TTL of 10 seconds → stale
      expect(cached.isStale(const Duration(seconds: 10)), isTrue);

      // 30 seconds old, TTL of 60 seconds → not stale
      expect(cached.isStale(const Duration(seconds: 60)), isFalse);
    });

    test('very old data is stale', () {
      final cached = CachedData(
        data: 'old stuff',
        cachedAt: DateTime.now().subtract(const Duration(days: 7)),
      );

      expect(cached.isStale(), isTrue);
    });

    test('just-created data is not stale', () {
      final cached = CachedData(
        data: 'fresh',
        cachedAt: DateTime.now(),
      );

      expect(cached.isStale(), isFalse);
    });
  });

  group('CachedData.ageLabel', () {
    test('returns "just now" for data less than 1 minute old', () {
      final cached = CachedData(
        data: null,
        cachedAt: DateTime.now().subtract(const Duration(seconds: 30)),
      );

      expect(cached.ageLabel, 'just now');
    });

    test('returns "just now" for data 0 seconds old', () {
      final cached = CachedData(
        data: null,
        cachedAt: DateTime.now(),
      );

      expect(cached.ageLabel, 'just now');
    });

    test('returns "X min ago" for data minutes old', () {
      final cached = CachedData(
        data: null,
        cachedAt: DateTime.now().subtract(const Duration(minutes: 5)),
      );

      expect(cached.ageLabel, '5 min ago');
    });

    test('returns "1 min ago" for data 1 minute old', () {
      final cached = CachedData(
        data: null,
        cachedAt: DateTime.now().subtract(const Duration(minutes: 1, seconds: 30)),
      );

      expect(cached.ageLabel, '1 min ago');
    });

    test('returns "59 min ago" just under an hour', () {
      final cached = CachedData(
        data: null,
        cachedAt: DateTime.now().subtract(const Duration(minutes: 59)),
      );

      expect(cached.ageLabel, '59 min ago');
    });

    test('returns "1 hour ago" for data 1 hour old', () {
      final cached = CachedData(
        data: null,
        cachedAt: DateTime.now().subtract(const Duration(hours: 1)),
      );

      expect(cached.ageLabel, '1 hour ago');
    });

    test('returns "X hours ago" for multiple hours', () {
      final cached = CachedData(
        data: null,
        cachedAt: DateTime.now().subtract(const Duration(hours: 5)),
      );

      expect(cached.ageLabel, '5 hours ago');
    });

    test('returns "23 hours ago" just under a day', () {
      final cached = CachedData(
        data: null,
        cachedAt: DateTime.now().subtract(const Duration(hours: 23)),
      );

      expect(cached.ageLabel, '23 hours ago');
    });

    test('returns "1 day ago" for data 1 day old', () {
      final cached = CachedData(
        data: null,
        cachedAt: DateTime.now().subtract(const Duration(days: 1)),
      );

      expect(cached.ageLabel, '1 day ago');
    });

    test('returns "X days ago" for multiple days', () {
      final cached = CachedData(
        data: null,
        cachedAt: DateTime.now().subtract(const Duration(days: 3)),
      );

      expect(cached.ageLabel, '3 days ago');
    });
  });

  group('CachedData.age', () {
    test('age is approximately correct', () {
      final cached = CachedData(
        data: null,
        cachedAt: DateTime.now().subtract(const Duration(minutes: 10)),
      );

      // Allow 1 second of tolerance for test execution time
      expect(cached.age.inMinutes, 10);
      expect(cached.age.inSeconds, greaterThanOrEqualTo(599));
      expect(cached.age.inSeconds, lessThanOrEqualTo(601));
    });
  });

  group('CachedData with different data types', () {
    test('stores and returns map data', () {
      final cached = CachedData(
        data: {'name': 'Test', 'value': 42},
        cachedAt: DateTime.now(),
      );

      expect(cached.data, isA<Map>());
      expect((cached.data as Map)['name'], 'Test');
    });

    test('stores and returns list data', () {
      final cached = CachedData(
        data: [1, 2, 3],
        cachedAt: DateTime.now(),
      );

      expect(cached.data, isA<List>());
      expect((cached.data as List).length, 3);
    });

    test('stores and returns null data', () {
      final cached = CachedData(
        data: null,
        cachedAt: DateTime.now(),
      );

      expect(cached.data, isNull);
    });

    test('stores and returns string data', () {
      final cached = CachedData(
        data: 'hello',
        cachedAt: DateTime.now(),
      );

      expect(cached.data, 'hello');
    });
  });

  group('ApiCacheManager.defaultTtl', () {
    test('default TTL is 15 minutes', () {
      expect(ApiCacheManager.defaultTtl, const Duration(minutes: 15));
    });
  });
}
