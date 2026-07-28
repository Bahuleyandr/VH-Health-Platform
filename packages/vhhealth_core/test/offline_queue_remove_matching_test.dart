import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

import 'helpers/offline_queue_test_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late OfflineQueueTestHarness harness;

  setUp(() async {
    harness = OfflineQueueTestHarness('offline_queue_remove_matching');
    await harness.setUp();
    await AuthService.setStaffId('staff-1');
  });

  tearDown(() => harness.tearDown());

  test('removes only the matching current-owner pending draft', () async {
    final keepId = await OfflineQueue.enqueue(
      endpoint: '/emr/notes/draft',
      method: 'PUT',
      body: {'patient_uid': 'pt-A', 'note_type': 'nursing_note'},
    );
    await OfflineQueue.enqueue(
      endpoint: '/emr/notes/draft',
      method: 'PUT',
      body: {'patient_uid': 'pt-B', 'note_type': 'nursing_note'},
    );

    expect(
      await OfflineQueue.removePendingMatching(
        endpoint: '/emr/notes/draft',
        matches: (body) => body['patient_uid'] == 'pt-B',
      ),
      1,
    );
    expect((await OfflineQueue.getPending()).map((row) => row['id']), [keepId]);
  });

  test('does not remove non-draft actions', () async {
    await OfflineQueue.enqueue(
      endpoint: '/health/records',
      method: 'POST',
      body: {'patient_uid': 'pt-A'},
    );
    expect(
      await OfflineQueue.removePendingMatching(
        endpoint: '/health/records',
        matches: (_) => true,
      ),
      0,
    );
    expect(await OfflineQueue.getPending(), hasLength(1));
  });

  test('does not remove conflicts or another owners drafts', () async {
    final conflictId = await OfflineQueue.enqueue(
      endpoint: '/emr/notes/draft',
      method: 'PUT',
      body: {'patient_uid': 'pt-A'},
    );
    await OfflineQueue.markConflict(conflictId, 'server changed');
    await AuthService.setStaffId('staff-2');

    expect(
      await OfflineQueue.removePendingMatching(
        endpoint: '/emr/notes/draft',
        matches: (_) => true,
      ),
      0,
    );
    await AuthService.setStaffId('staff-1');
    expect(await OfflineQueue.getConflicts(), hasLength(1));
  });
}
