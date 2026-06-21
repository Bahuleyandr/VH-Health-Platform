// test/features/emr/note_draft_autosave_test.dart
//
// Unit tests for the clinical-notes autosave controller. The controller
// (`lib/features/emr/note_draft_autosave.dart`) debounces content changes into
// a draft PUT, restores a saved draft on open, and clears it on finalize.
//
// We inject a fake `NoteDraftApi` (plain function fields) so no HTTP runs, and
// use `fakeAsync` to drive the debounce/heartbeat timers deterministically —
// the same isolate-the-logic approach as
// `test/features/nursing/mar_rights_state_machine_test.dart`.

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/emr/note_draft_autosave.dart';

/// Records every call the controller makes so assertions can inspect them.
class _FakeDraftApi {
  final List<Map<String, dynamic>> puts = [];
  final List<Map<String, dynamic>> gets = [];
  final List<Map<String, dynamic>> deletes = [];

  /// Optional canned draft returned by `get`.
  Map<String, dynamic>? getResult;

  NoteDraftApi build() => NoteDraftApi(
    put:
        ({
          required String patientUid,
          int? appointmentId,
          required String noteType,
          required Map<String, dynamic> content,
        }) async {
          puts.add({
            'patient_uid': patientUid,
            'appointment_id': appointmentId,
            'note_type': noteType,
            'content': content,
          });
          return {'id': 1, 'updated_at': '2026-06-17T10:00:00Z'};
        },
    get:
        ({
          required String patientUid,
          int? appointmentId,
          required String noteType,
        }) async {
          gets.add({
            'patient_uid': patientUid,
            'appointment_id': appointmentId,
            'note_type': noteType,
          });
          return getResult;
        },
    delete:
        ({
          required String patientUid,
          int? appointmentId,
          required String noteType,
        }) async {
          deletes.add({
            'patient_uid': patientUid,
            'appointment_id': appointmentId,
            'note_type': noteType,
          });
          return {'removed': true};
        },
  );
}

void main() {
  group('NoteDraftAutosave', () {
    late _FakeDraftApi fake;

    setUp(() {
      fake = _FakeDraftApi();
    });

    test('debounces a content change into a single putNoteDraft', () {
      fakeAsync((async) {
        var body = 'a';
        final autosave = NoteDraftAutosave(
          patientUid: 'pt-1',
          appointmentId: 42,
          noteType: 'op_consultation',
          snapshot: () => {'chief_complaint': body},
          api: fake.build(),
          debounce: const Duration(seconds: 3),
          heartbeat: const Duration(seconds: 15),
        );

        // Three rapid changes within the debounce window → still no PUT.
        autosave.onContentChanged();
        async.elapse(const Duration(seconds: 1));
        body = 'ab';
        autosave.onContentChanged();
        async.elapse(const Duration(seconds: 1));
        body = 'abc';
        autosave.onContentChanged();
        expect(fake.puts, isEmpty, reason: 'debounce not yet elapsed');

        // Let the debounce fire.
        async.elapse(const Duration(seconds: 3));
        async.flushMicrotasks();

        expect(fake.puts, hasLength(1), reason: 'exactly one debounced PUT');
        expect(fake.puts.single['patient_uid'], 'pt-1');
        expect(fake.puts.single['appointment_id'], 42);
        expect(fake.puts.single['note_type'], 'op_consultation');
        expect(
          (fake.puts.single['content'] as Map)['chief_complaint'],
          'abc',
          reason: 'latest snapshot is sent, not the first',
        );

        autosave.dispose();
      });
    });

    test('status transitions idle → saving → saved on a successful save', () {
      fakeAsync((async) {
        final autosave = NoteDraftAutosave(
          patientUid: 'pt-1',
          noteType: 'op_consultation',
          snapshot: () => {'chief_complaint': 'x'},
          api: fake.build(),
          clock: () => DateTime(2026, 6, 17, 14, 14),
        );

        expect(autosave.status.value.kind, NoteDraftStatusKind.idle);

        autosave.onContentChanged();
        async.elapse(const Duration(seconds: 3));
        async.flushMicrotasks();

        expect(autosave.status.value.kind, NoteDraftStatusKind.saved);
        expect(autosave.status.value.savedAt, DateTime(2026, 6, 17, 14, 14));

        autosave.dispose();
      });
    });

    test('heartbeat saves while edits keep coming inside the debounce', () {
      fakeAsync((async) {
        final autosave = NoteDraftAutosave(
          patientUid: 'pt-1',
          noteType: 'op_consultation',
          snapshot: () => {'chief_complaint': 'typing'},
          api: fake.build(),
          debounce: const Duration(seconds: 3),
          heartbeat: const Duration(seconds: 15),
        );

        // Keep typing every 2s so the 3s debounce never settles, for ~16s.
        for (var i = 0; i < 8; i++) {
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 2));
          async.flushMicrotasks();
        }

        expect(
          fake.puts,
          isNotEmpty,
          reason:
              'the 15s heartbeat must save even though debounce keeps '
              'resetting',
        );

        autosave.dispose();
      });
    });

    test('restore() returns the mocked content and parsed updatedAt', () async {
      fake.getResult = {
        'id': 9,
        'content': {'chief_complaint': 'chest pain', 'plan': 'ECG'},
        'updated_at': '2026-06-17T09:30:00Z',
      };
      final autosave = NoteDraftAutosave(
        patientUid: 'pt-7',
        appointmentId: 5,
        noteType: 'op_consultation',
        snapshot: () => const {},
        api: fake.build(),
      );

      final restored = await autosave.restore();

      expect(fake.gets, hasLength(1));
      expect(fake.gets.single['patient_uid'], 'pt-7');
      expect(fake.gets.single['appointment_id'], 5);
      expect(restored, isNotNull);
      final content = restored!['content'] as Map<String, dynamic>;
      expect(content['chief_complaint'], 'chest pain');
      expect(content['plan'], 'ECG');
      expect(
        restored['updatedAt'],
        DateTime.utc(2026, 6, 17, 9, 30),
        reason: 'updated_at string is parsed to DateTime',
      );

      autosave.dispose();
    });

    test('restore() returns null when there is no draft', () async {
      fake.getResult = null; // backend { data: null }
      final autosave = NoteDraftAutosave(
        patientUid: 'pt-7',
        noteType: 'nursing_note',
        snapshot: () => const {},
        api: fake.build(),
      );

      expect(await autosave.restore(), isNull);
      expect(fake.gets, hasLength(1));

      autosave.dispose();
    });

    test('clear() calls deleteNoteDraft and cancels a pending save', () {
      fakeAsync((async) {
        final autosave = NoteDraftAutosave(
          patientUid: 'pt-1',
          appointmentId: 3,
          noteType: 'op_consultation',
          snapshot: () => {'chief_complaint': 'x'},
          api: fake.build(),
          debounce: const Duration(seconds: 3),
        );

        // Arm a debounced save, then clear before it fires.
        autosave.onContentChanged();
        async.elapse(const Duration(seconds: 1));

        autosave.clear();
        async.flushMicrotasks();

        // The pending debounce must NOT have produced a PUT.
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();

        expect(
          fake.puts,
          isEmpty,
          reason: 'clear() cancels the pending debounced save',
        );
        expect(fake.deletes, hasLength(1));
        expect(fake.deletes.single['patient_uid'], 'pt-1');
        expect(fake.deletes.single['appointment_id'], 3);
        expect(fake.deletes.single['note_type'], 'op_consultation');
        expect(autosave.status.value.kind, NoteDraftStatusKind.idle);

        autosave.dispose();
      });
    });

    test('a failed PUT sets status=error and never throws', () {
      fakeAsync((async) {
        final api = NoteDraftApi(
          put:
              ({
                required String patientUid,
                int? appointmentId,
                required String noteType,
                required Map<String, dynamic> content,
              }) async => throw Exception('network down'),
          get:
              ({
                required String patientUid,
                int? appointmentId,
                required String noteType,
              }) async => null,
          delete:
              ({
                required String patientUid,
                int? appointmentId,
                required String noteType,
              }) async => {'removed': false},
        );
        final autosave = NoteDraftAutosave(
          patientUid: 'pt-1',
          noteType: 'op_consultation',
          snapshot: () => {'chief_complaint': 'x'},
          api: api,
          debounce: const Duration(seconds: 3),
        );

        autosave.onContentChanged();
        async.elapse(const Duration(seconds: 3));
        async.flushMicrotasks();

        // No exception escaped fakeAsync, and the status reflects the failure.
        expect(autosave.status.value.kind, NoteDraftStatusKind.error);

        autosave.dispose();
      });
    });
  });
}
