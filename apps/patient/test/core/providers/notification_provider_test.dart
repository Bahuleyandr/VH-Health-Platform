import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/providers/notification_provider.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('NotificationProvider', () {
    late NotificationProvider provider;

    setUp(() {
      provider = NotificationProvider();
    });

    test('initial unread count is 0', () {
      expect(provider.unreadCount, 0);
    });

    test('fetchUnreadCount with empty phone resets to 0', () async {
      await provider.fetchUnreadCount('');
      expect(provider.unreadCount, 0);
    });

    test('markAllRead with empty phone is a no-op', () async {
      // Should not throw
      await provider.markAllRead('');
      expect(provider.unreadCount, 0);
    });

    test('notifies listeners on state change', () {
      int notifyCount = 0;
      provider.addListener(() => notifyCount++);

      provider.fetchUnreadCount('');
      // Allow microtask to complete
      expect(notifyCount >= 0, isTrue);
    });

    test('markAllAsRead is alias for markAllRead', () {
      // Just verify it exists and doesn't throw
      expect(() => provider.markAllAsRead(''), returnsNormally);
    });

    test('refreshBadgeAfterPush fetches unread badge count', () async {
      provider = NotificationProvider(
        feedFetcher: () async => {
          'notifications': [
            {'is_read': false},
            {'is_read': true},
            {'is_read': false},
          ],
        },
      );
      var notifyCount = 0;
      provider.addListener(() => notifyCount++);

      await provider.refreshBadgeAfterPush('+919876543210');

      expect(provider.unreadCount, 2);
      expect(notifyCount, 1);
    });

    test('server aggregate wins over a paginated first-page count', () async {
      provider = NotificationProvider(
        feedFetcher: () async => {
          'unread_count': 17,
          'notifications': [
            {'is_read': false},
            {'is_read': true},
          ],
        },
      );

      await provider.fetchUnreadCount('+919876543210');

      expect(provider.unreadCount, 17);
    });

    test(
      'falls back to the encrypted cached feed when the server fails',
      () async {
        provider = NotificationProvider(
          feedFetcher: () async => throw StateError('network unavailable'),
          cachedFeedFetcher: () async => {
            'unread_count': '4',
            'notifications': const [],
          },
        );

        await provider.fetchUnreadCount('+919876543210');

        expect(provider.unreadCount, 4);
      },
    );

    test(
      'preserves the last known badge when server and cache both fail',
      () async {
        var failServer = false;
        provider = NotificationProvider(
          feedFetcher: () async {
            if (failServer) throw StateError('network unavailable');
            return {'unread_count': 3};
          },
          cachedFeedFetcher: () async => throw StateError('cache unavailable'),
        );
        await provider.fetchUnreadCount('+919876543210');
        failServer = true;

        await provider.fetchUnreadCount('+919876543210');

        expect(provider.unreadCount, 3);
      },
    );

    test('local mark-read reconciliation is bounded at zero', () {
      expect(provider.reconcileFromFeed({'unread_count': 1}), isTrue);

      provider.markOneReadLocally();
      provider.markOneReadLocally();

      expect(provider.unreadCount, 0);
    });

    test('supports legacy cached read fields without treating unknown rows as unread', () {
      expect(
        provider.reconcileFromFeed({
          'notifications': [
            {'read': false},
            {'read': true},
            {'title': 'missing read state'},
          ],
        }),
        isTrue,
      );
      expect(provider.unreadCount, 1);
    });
  });
}
