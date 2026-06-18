// test/features/period_tracker/cycle_tracker_store_test.dart
//
// Verifies that cycle/period/fertility data — which is PHI — round-trips
// through the encrypted-at-rest store (VHSecureStorage, AES-256/GCM via the
// platform keystore) instead of plaintext SharedPreferences, that the
// one-time migration moves any legacy plaintext keys into the encrypted store
// and PURGES the plaintext copy, and that logout (`clearAll`) wipes the new
// encrypted location.
//
// Uses in-memory fakes for both the flutter_secure_storage channel and the
// shared_preferences channel so neither native plugin is needed.

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/features/period_tracker/models/cycle_tracker.dart';

/// In-memory fake of the flutter_secure_storage method channel. Returns the
/// backing map so tests can assert directly on what was persisted (and that it
/// is the ONLY place cycle data lives).
Map<String, String> _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final Map<String, String> store = {};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key']] = args['value'] as String;
            return null;
          case 'delete':
            store.remove(args['key']);
            return null;
          case 'readAll':
            return Map<String, String>.from(store);
          case 'deleteAll':
            store.clear();
            return null;
          case 'containsKey':
            return store.containsKey(args['key']);
          default:
            return null;
        }
      });
  return store;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;

  setUp(() {
    secureStore = _installSecureStorageFake();
    SharedPreferences.setMockInitialValues({});
  });

  group('CycleTrackerStore encrypted-at-rest persistence', () {
    test('save then load round-trips through the encrypted store', () async {
      await CycleTrackerStore.save(
        CycleTrackerSnapshot(
          ownerKey: '9876543210',
          lastPeriodStart: DateTime(2026, 6, 1),
          cycleLength: 30,
          periodLength: 6,
        ),
      );

      final loaded = await CycleTrackerStore.load(userPhone: '9876543210');

      expect(loaded.ownerKey, '9876543210');
      expect(loaded.lastPeriodStart, DateTime(2026, 6, 1));
      expect(loaded.cycleLength, 30);
      expect(loaded.periodLength, 6);
    });

    test('cycle data is written ONLY to secure storage, never to SharedPreferences',
        () async {
      await CycleTrackerStore.save(
        CycleTrackerSnapshot(
          ownerKey: '9876543210',
          lastPeriodStart: DateTime(2026, 6, 1),
          cycleLength: 30,
          periodLength: 6,
        ),
      );

      // The snapshot lives under the secure-storage key.
      expect(secureStore.containsKey('period_tracker_9876543210'), isTrue);

      // Nothing cycle-related was written to plaintext SharedPreferences.
      final prefs = await SharedPreferences.getInstance();
      final leaked = prefs
          .getKeys()
          .where((k) => k.startsWith('period_tracker_'))
          .toList();
      expect(leaked, isEmpty);
    });

    test('defaults when nothing is stored', () async {
      final loaded = await CycleTrackerStore.load(userPhone: '9876543210');
      expect(loaded.lastPeriodStart, isNull);
      expect(loaded.cycleLength, 28);
      expect(loaded.periodLength, 5);
    });

    test('null start clears the stored start without dropping the record',
        () async {
      await CycleTrackerStore.save(
        CycleTrackerSnapshot(
          ownerKey: '9876543210',
          lastPeriodStart: DateTime(2026, 6, 1),
          cycleLength: 30,
          periodLength: 6,
        ),
      );
      await CycleTrackerStore.save(
        const CycleTrackerSnapshot(
          ownerKey: '9876543210',
          lastPeriodStart: null,
          cycleLength: 30,
          periodLength: 6,
        ),
      );

      final loaded = await CycleTrackerStore.load(userPhone: '9876543210');
      expect(loaded.lastPeriodStart, isNull);
      expect(loaded.cycleLength, 30);
      expect(loaded.periodLength, 6);
    });

    test('dependent profiles are stored under their own key', () async {
      await CycleTrackerStore.save(
        CycleTrackerSnapshot(
          ownerKey: 'dep-uid-1',
          lastPeriodStart: DateTime(2026, 5, 10),
          cycleLength: 26,
          periodLength: 4,
        ),
      );

      final dependent = await CycleTrackerStore.load(
        userPhone: '9876543210',
        dependentUid: 'dep-uid-1',
      );
      expect(dependent.lastPeriodStart, DateTime(2026, 5, 10));
      expect(dependent.cycleLength, 26);

      // The guardian's own profile is independent (and unset).
      final guardian = await CycleTrackerStore.load(userPhone: '9876543210');
      expect(guardian.lastPeriodStart, isNull);
    });
  });

  group('one-time plaintext -> encrypted migration', () {
    test('migrates legacy SharedPreferences data and PURGES the plaintext copy',
        () async {
      // Seed a legacy plaintext record the way the old implementation wrote it.
      SharedPreferences.setMockInitialValues({
        'period_tracker_9876543210_last_start': '2026-04-15',
        'period_tracker_9876543210_cycle_length': 31,
        'period_tracker_9876543210_period_length': 7,
      });

      // First read after upgrade.
      final loaded = await CycleTrackerStore.load(userPhone: '9876543210');

      // Data preserved.
      expect(loaded.lastPeriodStart, DateTime(2026, 4, 15));
      expect(loaded.cycleLength, 31);
      expect(loaded.periodLength, 7);

      // Now lives in the encrypted store.
      expect(secureStore.containsKey('period_tracker_9876543210'), isTrue);

      // Plaintext copy is gone.
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('period_tracker_9876543210_last_start'), isNull);
      expect(prefs.getInt('period_tracker_9876543210_cycle_length'), isNull);
      expect(prefs.getInt('period_tracker_9876543210_period_length'), isNull);
    });

    test('migration survives a subsequent load (data not re-read from plaintext)',
        () async {
      SharedPreferences.setMockInitialValues({
        'period_tracker_9876543210_last_start': '2026-04-15',
        'period_tracker_9876543210_cycle_length': 31,
        'period_tracker_9876543210_period_length': 7,
      });

      await CycleTrackerStore.load(userPhone: '9876543210');
      // Second read comes purely from the encrypted store.
      final again = await CycleTrackerStore.load(userPhone: '9876543210');
      expect(again.lastPeriodStart, DateTime(2026, 4, 15));
      expect(again.cycleLength, 31);
      expect(again.periodLength, 7);
    });

    test('no migration when no legacy plaintext exists', () async {
      final loaded = await CycleTrackerStore.load(userPhone: '9876543210');
      expect(loaded.lastPeriodStart, isNull);
      expect(secureStore.containsKey('period_tracker_9876543210'), isFalse);
    });
  });

  group('clearAll (logout)', () {
    test('wipes the encrypted location for every owner', () async {
      await CycleTrackerStore.save(
        CycleTrackerSnapshot(
          ownerKey: '9876543210',
          lastPeriodStart: DateTime(2026, 6, 1),
          cycleLength: 30,
          periodLength: 6,
        ),
      );
      await CycleTrackerStore.save(
        CycleTrackerSnapshot(
          ownerKey: 'dep-uid-1',
          lastPeriodStart: DateTime(2026, 5, 10),
          cycleLength: 26,
          periodLength: 4,
        ),
      );

      await CycleTrackerStore.clearAll();

      // No cycle keys survive in secure storage.
      final survivors = secureStore.keys
          .where((k) => k.startsWith('period_tracker_'))
          .toList();
      expect(survivors, isEmpty);

      // And a fresh load returns defaults.
      final loaded = await CycleTrackerStore.load(userPhone: '9876543210');
      expect(loaded.lastPeriodStart, isNull);
    });

    test('clearAll also purges any leftover legacy plaintext keys', () async {
      SharedPreferences.setMockInitialValues({
        'period_tracker_9876543210_last_start': '2026-04-15',
        'period_tracker_9876543210_cycle_length': 31,
        'period_tracker_9876543210_period_length': 7,
      });

      await CycleTrackerStore.clearAll();

      final prefs = await SharedPreferences.getInstance();
      final leftover = prefs
          .getKeys()
          .where((k) => k.startsWith('period_tracker_'))
          .toList();
      expect(leftover, isEmpty);
    });
  });
}
