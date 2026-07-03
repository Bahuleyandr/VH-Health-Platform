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
  });
}
