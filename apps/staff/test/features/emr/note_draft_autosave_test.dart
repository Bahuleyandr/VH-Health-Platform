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

    // ── Sub-task A: deviceType guard ──────────────────────────────────────
    // Autosave shadows the desktop/tablet-only note-finalize write. On a
    // phone/mobile (or empty/unknown) deviceType it must NOT PUT and must NOT
    // enqueue — mirroring buildOfflineOrderIntent's `dt == 'mobile' || isEmpty`
    // gate so we never 403-spam the audit log every heartbeat.
    group('deviceType guard (A)', () {
      test('phone/mobile deviceType → zero PUTs, zero enqueues', () {
        fakeAsync((async) {
          final autosave = NoteDraftAutosave(
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': 'x'},
            api: fake.build(),
            deviceType: () => 'mobile',
            debounce: const Duration(seconds: 3),
            heartbeat: const Duration(seconds: 15),
          );

          // Edit + let the debounce fire, then several heartbeats.
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 20));
          async.flushMicrotasks();

          expect(fake.puts, isEmpty, reason: 'phone-mode never PUTs a draft');
          // Status stays quiet: the guard no-ops before the network, so it
          // never advances to saving/saved/error (a transient "dirty" hint
          // while typing is fine — it never becomes a save attempt).
          expect(
            autosave.status.value.kind,
            isNot(
              anyOf(
                NoteDraftStatusKind.saving,
                NoteDraftStatusKind.saved,
                NoteDraftStatusKind.error,
                NoteDraftStatusKind.offline,
              ),
            ),
          );

          autosave.dispose();
        });
      });

      test('empty / unknown deviceType → zero PUTs (fail-closed)', () {
        fakeAsync((async) {
          final autosave = NoteDraftAutosave(
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': 'x'},
            api: fake.build(),
            deviceType: () => '   ',
            debounce: const Duration(seconds: 3),
          );

          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 5));
          async.flushMicrotasks();

          expect(fake.puts, isEmpty, reason: 'empty deviceType fails closed');

          autosave.dispose();
        });
      });

      test('desktop/tablet deviceType → saves as before', () {
        fakeAsync((async) {
          final autosave = NoteDraftAutosave(
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': 'x'},
            api: fake.build(),
            deviceType: () => 'tablet',
            debounce: const Duration(seconds: 3),
          );

          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();

          expect(
            fake.puts,
            hasLength(1),
            reason: 'workbench device still autosaves',
          );

          autosave.dispose();
        });
      });
    });

    // ── Sub-task E: skip-unchanged + skip-empty ───────────────────────────
    group('skip-unchanged (E)', () {
      test('byte-identical content is saved once, then skipped', () {
        fakeAsync((async) {
          final autosave = NoteDraftAutosave(
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': 'stable'},
            api: fake.build(),
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
          );

          // First save persists.
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(fake.puts, hasLength(1), reason: 'first save PUTs');

          // Second cycle with identical content → skipped, no PUT.
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(
            fake.puts,
            hasLength(1),
            reason: 'identical content is not re-PUT',
          );

          autosave.dispose();
        });
      });

      test('a FAILED save does not cache — identical retry still attempts', () {
        fakeAsync((async) {
          var failNext = true;
          final calls = <Map<String, dynamic>>[];
          final api = NoteDraftApi(
            put:
                ({
                  required String patientUid,
                  int? appointmentId,
                  required String noteType,
                  required Map<String, dynamic> content,
                }) async {
                  calls.add(content);
                  if (failNext) {
                    failNext = false;
                    throw Exception('network down');
                  }
                  return {'id': 1, 'updated_at': '2026-06-17T10:00:00Z'};
                },
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
            snapshot: () => {'chief_complaint': 'same'},
            api: api,
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
          );

          // First attempt fails (must NOT poison _lastSavedJson).
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(calls, hasLength(1));
          expect(autosave.status.value.kind, NoteDraftStatusKind.error);

          // Identical content re-attempts (cache was not poisoned) → succeeds.
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(
            calls,
            hasLength(2),
            reason: 'a failed save must not cache, so the retry still PUTs',
          );

          autosave.dispose();
        });
      });

      test('post-restore save is skipped (cache seeded from restored draft)', () {
        fakeAsync((async) {
          fake.getResult = {
            'id': 9,
            'content': {'chief_complaint': 'chest pain'},
            'updated_at': '2026-06-17T09:30:00Z',
          };
          var body = 'chest pain';
          final autosave = NoteDraftAutosave(
            patientUid: 'pt-7',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': body},
            api: fake.build(),
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
          );

          // Restore seeds _lastSavedJson to the restored content.
          Map<String, dynamic>? restored;
          autosave.restore().then((r) => restored = r);
          async.flushMicrotasks();
          expect(restored, isNotNull);

          // Rehydrating controllers fires onContentChanged with identical text.
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(
            fake.puts,
            isEmpty,
            reason: 'the immediate post-restore save is skipped',
          );

          // A real edit after restore DOES save.
          body = 'chest pain radiating to arm';
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(fake.puts, hasLength(1), reason: 'a genuine edit still saves');

          autosave.dispose();
        });
      });
    });

    group('skip-empty (E)', () {
      test('all-whitespace before any real save → no PUT', () {
        fakeAsync((async) {
          final autosave = NoteDraftAutosave(
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': '   ', 'plan': ''},
            api: fake.build(),
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
          );

          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 5));
          async.flushMicrotasks();

          expect(
            fake.puts,
            isEmpty,
            reason: 'never create a blank draft before a real save',
          );

          autosave.dispose();
        });
      });

      test('after a real save, clearing a field to empty DOES persist', () {
        fakeAsync((async) {
          var body = 'chest pain';
          final autosave = NoteDraftAutosave(
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': body},
            api: fake.build(),
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
          );

          // Real non-empty save first.
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(fake.puts, hasLength(1));

          // Doctor deliberately clears the field back to empty → must save.
          body = '';
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(
            fake.puts,
            hasLength(2),
            reason: 'an intentional clear after a save is a legit edit',
          );
          expect((fake.puts.last['content'] as Map)['chief_complaint'], '');

          autosave.dispose();
        });
      });
    });

    // ── Sub-task B2-5: confidence UI (dirty + relative-time state) ─────────
    group('confidence UI (B2-5)', () {
      test('status is dirty while editing, saved after the debounce', () {
        fakeAsync((async) {
          final autosave = NoteDraftAutosave(
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': 'x'},
            api: fake.build(),
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
            clock: () => DateTime(2026, 6, 17, 14, 14),
          );

          // Between the edit and the debounce fire we surface "unsaved".
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 1));
          async.flushMicrotasks();
          expect(autosave.status.value.kind, NoteDraftStatusKind.dirty);

          // After the debounce fires and the PUT succeeds → saved + timestamp.
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(autosave.status.value.kind, NoteDraftStatusKind.saved);
          expect(autosave.status.value.savedAt, DateTime(2026, 6, 17, 14, 14));

          autosave.dispose();
        });
      });
    });
  });
}
