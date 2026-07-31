import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/offline_action_ids.dart';
import 'package:vhhealth_staff/features/emr/note_draft_autosave.dart';

void main() {
  test('offline OP draft enters the temporary facade exactly once', () {
    fakeAsync((async) {
      var onlinePuts = 0;
      final enqueues = <Map<String, dynamic>>[];
      final autosave = NoteDraftAutosave(
        patientUid: 'patient-uid-1',
        appointmentId: 17,
        noteType: 'op_consultation',
        snapshot: () => const {'assessment': 'Stable'},
        deviceType: () => 'desktop',
        debounce: const Duration(milliseconds: 1),
        api: NoteDraftApi(
          put:
              ({
                required patientUid,
                appointmentId,
                required noteType,
                required content,
              }) async {
                onlinePuts++;
                return const {};
              },
          get:
              ({required patientUid, appointmentId, required noteType}) async =>
                  null,
          delete:
              ({required patientUid, appointmentId, required noteType}) async =>
                  const {},
        ),
        sync: NoteDraftSync(
          isOnline: () => false,
          enqueue:
              ({
                required endpoint,
                required method,
                required body,
                contextLabel,
              }) async {
                enqueues.add({
                  'endpoint': endpoint,
                  'method': method,
                  'body': body,
                  'context_label': contextLabel,
                });
                return 1;
              },
          removePendingWrites: ({required endpoint, required matches}) async =>
              0,
        ),
      );

      autosave.onContentChanged();
      async.elapse(const Duration(milliseconds: 1));
      async.flushMicrotasks();

      expect(onlinePuts, 0);
      expect(enqueues, hasLength(1));
      final queued = enqueues.single;
      expect(queued['endpoint'], '/emr/notes/draft');
      expect(queued['method'], 'PUT');
      expect(
        OfflineActionIds.fromLegacyControl(
          method: queued['method'] as String,
          path: queued['endpoint'] as String,
          body: Map<String, dynamic>.from(queued['body'] as Map),
        ),
        OfflineActionIds.opNoteDraftStore,
      );
      expect(queued['body'], {
        'patient_uid': 'patient-uid-1',
        'appointment_id': 17,
        'note_type': 'op_consultation',
        'content': {'assessment': 'Stable'},
      });
      autosave.dispose();
    });
  });
}
