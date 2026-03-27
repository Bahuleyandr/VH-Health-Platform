// test/core/providers/user_provider_test.dart
//
// Unit tests for UserProvider state management.
// Tests the in-memory state transitions only (no secure storage platform calls).

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/providers/user_provider.dart';

void main() {
  group('UserProvider', () {
    late UserProvider provider;
    late List<String> notifications;

    setUp(() {
      provider = UserProvider();
      notifications = [];
      provider.addListener(() {
        notifications.add('notified');
      });
    });

    tearDown(() {
      provider.dispose();
    });

    group('initial state', () {
      test('phone is empty string', () {
        expect(provider.phone, '');
      });

      test('name is Guest', () {
        expect(provider.name, 'Guest');
      });

      test('isGuest is true when phone is empty', () {
        expect(provider.isGuest, isTrue);
      });
    });

    group('setUser', () {
      test('updates phone and name immediately (before storage await)', () async {
        // setUser is async (writes to storage), but it sets fields and
        // calls notifyListeners synchronously before the awaits.
        // We call it but don't await to test the synchronous part.
        //
        // Note: In the real implementation, setUser writes to
        // FlutterSecureStorage which requires platform channels.
        // The fields and notifyListeners happen before those awaits,
        // so the synchronous behavior is testable. However, the await
        // will throw a MissingPluginException in test. We catch that.
        try {
          await provider.setUser('1234567890', 'John');
        } catch (_) {
          // MissingPluginException from flutter_secure_storage is expected
        }

        expect(provider.phone, '1234567890');
        expect(provider.name, 'John');
        expect(provider.isGuest, isFalse);
      });

      test('notifyListeners is called on setUser', () async {
        try {
          await provider.setUser('9876543210', 'Jane');
        } catch (_) {
          // Expected: MissingPluginException from secure storage
        }

        expect(notifications, isNotEmpty);
        expect(notifications.length, 1);
      });
    });

    group('clear', () {
      test('resets to guest state', () async {
        // First set user data
        try {
          await provider.setUser('1234567890', 'John');
        } catch (_) {}

        notifications.clear();

        // Now clear
        await provider.clear();

        expect(provider.phone, '');
        expect(provider.name, 'Guest');
        expect(provider.isGuest, isTrue);
      });

      test('notifyListeners is called on clear', () async {
        try {
          await provider.setUser('1234567890', 'John');
        } catch (_) {}

        notifications.clear();

        await provider.clear();

        expect(notifications, isNotEmpty);
        expect(notifications.length, 1);
      });
    });

    group('isGuest edge cases', () {
      test('phone "guest" is treated as guest', () async {
        try {
          await provider.setUser('guest', 'Guest User');
        } catch (_) {}

        expect(provider.isGuest, isTrue);
      });

      test('non-empty, non-"guest" phone is not guest', () async {
        try {
          await provider.setUser('5551234567', 'Real User');
        } catch (_) {}

        expect(provider.isGuest, isFalse);
      });
    });
  });
}
