// test/core/providers/user_provider_test.dart
//
// Unit tests for UserProvider — setting/getting phone and name, clearing data,
// and the isGuest computed property.
//
// Note: UserProvider.setUser and loadFromStorage call FlutterSecureStorage
// internally which requires platform channels. These tests focus on the
// in-memory state changes. The setUser call will succeed for the in-memory
// part but may throw on the storage write — we catch that to still verify
// the state was updated before the await.

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/providers/user_provider.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('UserProvider — initial state', () {
    test('phone defaults to empty string', () {
      final provider = UserProvider();
      expect(provider.phone, '');
    });

    test('name defaults to Guest', () {
      final provider = UserProvider();
      expect(provider.name, 'Guest');
    });

    test('isGuest is true when phone is empty', () {
      final provider = UserProvider();
      expect(provider.isGuest, isTrue);
    });
  });

  group('UserProvider — setUser (in-memory behavior)', () {
    test('setUser updates phone and name before awaiting storage', () {
      final provider = UserProvider();

      // setUser sets fields synchronously before the await, so we can check
      // state after calling it (even if the Future fails on storage).
      provider.setUser('9876543210', 'Alice').catchError((_) {});

      expect(provider.phone, '9876543210');
      expect(provider.name, 'Alice');
    });

    test('isGuest is false after setUser with a real phone', () {
      final provider = UserProvider();

      provider.setUser('9876543210', 'Alice').catchError((_) {});

      expect(provider.isGuest, isFalse);
    });

    test('isGuest is true when phone is "guest"', () {
      final provider = UserProvider();

      provider.setUser('guest', 'Guest User').catchError((_) {});

      expect(provider.isGuest, isTrue);
    });

    test('setUser notifies listeners', () {
      final provider = UserProvider();

      int notifyCount = 0;
      provider.addListener(() => notifyCount++);

      provider.setUser('1234567890', 'Bob').catchError((_) {});

      expect(notifyCount, 1);
    });
  });

  group('UserProvider — clear (in-memory behavior)', () {
    test('clear resets phone and name to defaults', () {
      final provider = UserProvider();

      provider.setUser('9876543210', 'Alice').catchError((_) {});
      provider.clear().catchError((_) {});

      expect(provider.phone, '');
      expect(provider.name, 'Guest');
    });

    test('isGuest is true after clear', () {
      final provider = UserProvider();

      provider.setUser('9876543210', 'Alice').catchError((_) {});
      provider.clear().catchError((_) {});

      expect(provider.isGuest, isTrue);
    });

    test('clear notifies listeners', () {
      final provider = UserProvider();
      provider.setUser('9876543210', 'Alice').catchError((_) {});

      int notifyCount = 0;
      provider.addListener(() => notifyCount++);

      provider.clear().catchError((_) {});

      expect(notifyCount, 1);
    });
  });

  group('UserProvider — edge cases', () {
    test('setUser with empty phone keeps isGuest true', () {
      final provider = UserProvider();

      provider.setUser('', 'No Phone').catchError((_) {});

      expect(provider.isGuest, isTrue);
      expect(provider.name, 'No Phone');
    });

    test('multiple setUser calls overwrite previous values', () {
      final provider = UserProvider();

      provider.setUser('111', 'First').catchError((_) {});
      provider.setUser('222', 'Second').catchError((_) {});

      expect(provider.phone, '222');
      expect(provider.name, 'Second');
    });
  });
}
