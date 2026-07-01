import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

/// In-memory fake for the `flutter_secure_storage` platform channel, so
/// [AuthService] (staff id / AES key) works headless. Mirrors the fake used by
/// offline_queue_drain_order_test.dart.
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
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  setUp(() async {
    _installSecureStorageFake();
    await OfflineQueue.resetForTesting();
    await OfflineQueue.clearAll();
    await AuthService.setStaffId('staff-1');
  });

  tearDown(() async {
    await OfflineQueue.clearAll();
    await OfflineQueue.resetForTesting();
  });

  group('OfflineQueue.removePendingMatching', () {
    test('removes only the pending write whose decoded body matches', () async {
      // Two draft PUTs on the SAME endpoint but for different draft contexts.
      // Discarding pt-B's draft must dequeue exactly that one, so it can't
      // recreate the server draft on reconnect — pt-A's draft stays queued.
      final keepId = await OfflineQueue.enqueue(
        endpoint: '/emr/notes/draft',
        method: 'PUT',
        body: {
          'patient_uid': 'pt-A',
          'appointment_id': 1,
          'note_type': 'op_consultation',
          'content': {'chief_complaint': 'keep me'},
        },
      );
      await OfflineQueue.enqueue(
        endpoint: '/emr/notes/draft',
        method: 'PUT',
        body: {
          'patient_uid': 'pt-B',
          'appointment_id': 2,
          'note_type': 'op_consultation',
          'content': {'chief_complaint': 'discard me'},
        },
      );

      final removed = await OfflineQueue.removePendingMatching(
        endpoint: '/emr/notes/draft',
        matches: (body) =>
            body['patient_uid'] == 'pt-B' &&
            body['appointment_id'] == 2 &&
            body['note_type'] == 'op_consultation',
      );

      expect(removed, 1);
      final remaining = await OfflineQueue.getPending();
      expect(
        remaining.map((r) => r['id']).toList(),
        [keepId],
        reason: 'only the matching draft context is dequeued',
      );
    });

    test('matches a context with a null appointment_id', () async {
      // Nursing drafts have no appointment_id — the decoded body has no such
      // key, so the predicate compares against null.
      await OfflineQueue.enqueue(
        endpoint: '/emr/notes/draft',
        method: 'PUT',
        body: {
          'patient_uid': 'pt-A',
          'note_type': 'nursing_note',
          'content': {'free_text': 'obs'},
        },
      );

      final removed = await OfflineQueue.removePendingMatching(
        endpoint: '/emr/notes/draft',
        matches: (body) =>
            body['patient_uid'] == 'pt-A' &&
            body['note_type'] == 'nursing_note' &&
            body['appointment_id'] == null,
      );

      expect(removed, 1);
      expect(await OfflineQueue.getPending(), isEmpty);
    });

    test('does not remove writes on a different endpoint', () async {
      await OfflineQueue.enqueue(
        endpoint: '/emr/notes',
        method: 'POST',
        body: {'patient_uid': 'pt-A', 'note_type': 'op_consultation'},
      );

      final removed = await OfflineQueue.removePendingMatching(
        endpoint: '/emr/notes/draft',
        matches: (_) => true,
      );

      expect(removed, 0, reason: 'endpoint scoping — note POST is untouched');
      expect(await OfflineQueue.getPending(), hasLength(1));
    });

    test('leaves conflicted rows untouched', () async {
      final id = await OfflineQueue.enqueue(
        endpoint: '/emr/notes/draft',
        method: 'PUT',
        body: {'patient_uid': 'pt-A', 'note_type': 'op_consultation'},
      );
      await OfflineQueue.markConflict(id, 'server changed');

      final removed = await OfflineQueue.removePendingMatching(
        endpoint: '/emr/notes/draft',
        matches: (_) => true,
      );

      expect(removed, 0, reason: 'only status=pending rows are dequeued');
      expect(await OfflineQueue.getConflicts(), hasLength(1));
    });

    test('is scoped to the current staff identity', () async {
      // staff-1 queues a draft; staff-2 must not be able to dequeue it on a
      // shared ward device (mirrors getPending owner-scoping).
      await OfflineQueue.enqueue(
        endpoint: '/emr/notes/draft',
        method: 'PUT',
        body: {'patient_uid': 'pt-A', 'note_type': 'op_consultation'},
      );

      await AuthService.setStaffId('staff-2');
      final removed = await OfflineQueue.removePendingMatching(
        endpoint: '/emr/notes/draft',
        matches: (_) => true,
      );
      expect(removed, 0, reason: 'a different staff cannot dequeue the write');

      await AuthService.setStaffId('staff-1');
      expect(await OfflineQueue.getPending(), hasLength(1));
    });
  });
}
