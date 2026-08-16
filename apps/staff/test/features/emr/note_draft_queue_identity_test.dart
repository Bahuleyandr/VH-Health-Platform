import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/staff_clinical_action_gateway.dart';
import 'package:vhhealth_staff/features/emr/note_draft_autosave.dart';

void main() {
  test('offline OP draft enters the typed local-draft facade exactly once', () {
    fakeAsync((async) {
      var onlinePuts = 0;
      final captures = <Map<String, dynamic>>[];
      final autosave = NoteDraftAutosave(
        captureCallSite: StaffCaptureCallSite.opConsultationDraftStorage,
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
          get: ({
            required patientUid,
            appointmentId,
            required noteType,
          }) async => null,
          delete: ({
            required patientUid,
            appointmentId,
            required noteType,
          }) async => const {},
        ),
        sync: NoteDraftSync(
          isOnline: () => false,
          capturePrivateDraft:
              ({
                required callSite,
                required patientReference,
                appointmentId,
                required body,
                contextLabel,
              }) async {
                captures.add({
                  'call_site': callSite,
                  'patient_reference': patientReference,
                  'appointment_id': appointmentId,
                  'body': body,
                  'context_label': contextLabel,
                });
                return true;
              },
          cancelPrivateDrafts: ({
            required callSite,
            required patientReference,
            appointmentId,
          }) async => 0,
        ),
      );

      autosave.onContentChanged();
      async.elapse(const Duration(milliseconds: 1));
      async.flushMicrotasks();

      expect(onlinePuts, 0);
      expect(captures, hasLength(1));
      final captured = captures.single;
      expect(
        captured['call_site'],
        StaffCaptureCallSite.opConsultationDraftStorage,
      );
      expect(captured['patient_reference'], 'patient-uid-1');
      expect(captured['appointment_id'], 17);
      expect(captured['body'], {
        'patient_uid': 'patient-uid-1',
        'appointment_id': 17,
        'note_type': 'op_consultation',
        'content': {'assessment': 'Stable'},
      });
      autosave.dispose();
    });
  });
}
