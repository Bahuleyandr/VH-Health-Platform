import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

/// In-memory fake for the `flutter_secure_storage` platform channel, so
/// [AuthService] (staff id / AES key) works headless. Mirrors the fake used by
/// mar_offline_cache_test.dart.
void _installSecureStorageFake() {
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
          case 'deleteAll':
            store.clear();
            return null;
          case 'readAll':
            return store;
          default:
            return null;
        }
      });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    // Route sqflite through the FFI (desktop/in-process) implementation so the
    // real OfflineQueue schema + queries run headless in the test VM.
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  setUp(() async {
    _installSecureStorageFake();
    await OfflineQueue.resetForTesting();
    // A clean queue every case; the drain is scoped to the staff identity.
    await OfflineQueue.clearAll();
    await AuthService.setStaffId('staff-1');
  });

  tearDown(() async {
    await OfflineQueue.clearAll();
    await OfflineQueue.resetForTesting();
  });

  group('OfflineQueue drain order (same-ms determinism)', () {
    test('drain order-by carries an id tiebreak after created_at '
        '(fails under the old bare `created_at ASC`)', () {
      // This is the load-bearing discriminator: the OLD order was the bare
      // string 'created_at ASC' (no secondary key), which this assertion
      // rejects. SQLite happens to break created_at ties in rowid order in
      // practice, so an output-only assertion would false-green against the
      // old code; asserting the ORDER BY contract itself is what genuinely
      // distinguishes the two orderings.
      expect(OfflineQueue.pendingDrainOrderBy, 'created_at ASC, id ASC');
      expect(
        OfflineQueue.pendingDrainOrderBy,
        contains('id ASC'),
        reason:
            'same-millisecond ties must fall back to insert order (id ASC) '
            'so the offline draft PUT drains before the final note POST',
      );
    });

    test(
      'getPending returns same-created_at rows in ascending id (insert) order',
      () async {
        final db = await OfflineQueue.database;
        // Three rows sharing ONE created_at millisecond. Insert the higher ids
        // out of natural order to prove the ordering is driven by the ORDER BY
        // key, not by physical insert sequence.
        const sameMs = 1751000000000;
        for (final id in [30, 10, 20]) {
          await db.insert('pending_writes', {
            'id': id,
            'endpoint': '/emr/notes/draft',
            'method': 'PUT',
            'body': 'ct', // opaque; getPending does not decode the body
            'created_at': sameMs,
            'retry_count': 0,
            'status': 'pending',
            'idempotency_key': 'k$id',
            'staff_id': 'staff-1',
          });
        }

        final pending = await OfflineQueue.getPending();
        expect(
          pending.map((r) => r['id']).toList(),
          [10, 20, 30],
          reason:
              'within one created_at ms, rows drain lowest-id (oldest '
              'insert) first',
        );
      },
    );

    test(
      'draft PUT (lower id) precedes note POST (higher id) at the same ms',
      () async {
        final db = await OfflineQueue.database;
        const sameMs = 1751000000001;
        // The final note POST gets the HIGHER id because it is enqueued on
        // finalize, after the autosave draft PUT was queued during typing.
        await db.insert('pending_writes', {
          'id': 100,
          'endpoint': '/emr/notes/draft',
          'method': 'PUT',
          'body': 'ct',
          'created_at': sameMs,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'draft',
          'staff_id': 'staff-1',
        });
        await db.insert('pending_writes', {
          'id': 101,
          'endpoint': '/emr/notes',
          'method': 'POST',
          'body': 'ct',
          'created_at': sameMs,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'note',
          'staff_id': 'staff-1',
        });

        final endpoints = (await OfflineQueue.getPending())
            .map((r) => '${r['method']} ${r['endpoint']}')
            .toList();
        expect(endpoints, ['PUT /emr/notes/draft', 'POST /emr/notes']);
      },
    );

    test(
      'created_at remains the primary sort key across milliseconds',
      () async {
        final db = await OfflineQueue.database;
        // An older row with a HIGHER id must still drain before a newer,
        // lower-id row — created_at dominates, id only breaks exact ties.
        await db.insert('pending_writes', {
          'id': 500,
          'endpoint': '/a',
          'method': 'POST',
          'body': 'ct',
          'created_at': 1000,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'older',
          'staff_id': 'staff-1',
        });
        await db.insert('pending_writes', {
          'id': 1,
          'endpoint': '/b',
          'method': 'POST',
          'body': 'ct',
          'created_at': 2000,
          'retry_count': 0,
          'status': 'pending',
          'idempotency_key': 'newer',
          'staff_id': 'staff-1',
        });

        final ids = (await OfflineQueue.getPending())
            .map((r) => r['id'])
            .toList();
        expect(ids, [500, 1]);
      },
    );

    test('enqueue → getPending round-trips in insert order', () async {
      // Exercises the real enqueue() path (AES encrypt + staff stamp) to prove
      // getPending wires the drain order through to actual queued writes.
      final first = await OfflineQueue.enqueue(
        endpoint: '/emr/notes/draft',
        method: 'PUT',
        body: {'text': 'partial'},
      );
      final second = await OfflineQueue.enqueue(
        endpoint: '/emr/notes',
        method: 'POST',
        body: {'text': 'final'},
      );

      final ids = (await OfflineQueue.getPending())
          .map((r) => r['id'])
          .toList();
      expect(ids, [first, second]);
      expect(first, lessThan(second));
    });
  });
}
