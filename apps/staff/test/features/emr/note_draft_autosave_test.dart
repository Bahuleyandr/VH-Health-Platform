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

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/staff_clinical_action_gateway.dart';
import 'package:vhhealth_staff/features/emr/note_draft_autosave.dart';

const _testCaptureCallSite = StaffCaptureCallSite.nursingAssessmentDraftStorage;

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

/// Records every offline-sync call the controller makes and lets a test drive
/// connectivity, so the otherwise-unreachable offline branch (the real
/// `ConnectivitySyncService.instance` reports `isOnline == true` in a test VM
/// and cannot be faked) can be exercised. Mirrors [_FakeDraftApi].
class _FakeSync {
  _FakeSync({this.online = true});

  bool online;

  /// When true, the next [enqueue] throws (simulates a queue write failure).
  bool enqueueThrows = false;

  /// When set, [enqueue] returns this future instead of completing eagerly, so
  /// a test can hold an enqueue in flight and resolve it after a `clear()`.
  Completer<bool>? enqueueGate;

  final List<Map<String, dynamic>> enqueues = [];
  final List<Map<String, dynamic>> removals = [];

  NoteDraftSync build() => NoteDraftSync(
    isOnline: () => online,
    capturePrivateDraft:
        ({
          required StaffCaptureCallSite callSite,
          required String patientReference,
          int? appointmentId,
          required Map<String, dynamic> body,
          String? contextLabel,
        }) {
          enqueues.add({
            'callSite': callSite,
            'patientReference': patientReference,
            'appointmentId': appointmentId,
            'body': body,
            'contextLabel': contextLabel,
          });
          if (enqueueThrows) throw Exception('enqueue failed');
          if (enqueueGate != null) return enqueueGate!.future;
          return Future.value(true);
        },
    cancelPrivateDrafts:
        ({
          required StaffCaptureCallSite callSite,
          required String patientReference,
          int? appointmentId,
        }) {
          removals.add({
            'callSite': callSite,
            'patientReference': patientReference,
            'appointmentId': appointmentId,
          });
          return Future.value(0);
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
          captureCallSite: _testCaptureCallSite,
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
          captureCallSite: _testCaptureCallSite,
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
          captureCallSite: _testCaptureCallSite,
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
        captureCallSite: _testCaptureCallSite,
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
        captureCallSite: _testCaptureCallSite,
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
          captureCallSite: _testCaptureCallSite,
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
          captureCallSite: _testCaptureCallSite,
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
            captureCallSite: _testCaptureCallSite,
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
            captureCallSite: _testCaptureCallSite,
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
            captureCallSite: _testCaptureCallSite,
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
            captureCallSite: _testCaptureCallSite,
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
            captureCallSite: _testCaptureCallSite,
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
            captureCallSite: _testCaptureCallSite,
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
            captureCallSite: _testCaptureCallSite,
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
            captureCallSite: _testCaptureCallSite,
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

      test('all-empty strings + an int metadata field → no PUT', () {
        fakeAsync((async) {
          // Mirrors _currentOpContent() for a BLANK appointment-scoped OP note:
          // every clinical field is empty, but `appointment_id` (an int) is
          // always injected. That identity metadata must NOT count as content,
          // otherwise skip-empty is defeated and merely opening a scheduled OP
          // patient creates a blank draft on the first heartbeat.
          final autosave = NoteDraftAutosave(
            captureCallSite: _testCaptureCallSite,
            patientUid: 'pt-1',
            appointmentId: 77,
            noteType: 'op_consultation',
            snapshot: () => {
              'chief_complaint': '',
              'history': '',
              'examination': '',
              'diagnosis': '',
              'plan': '',
              'summary': '',
              'appointment_id': 77,
            },
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
            reason:
                'appointment_id metadata alone is not clinical text — '
                'skip-empty must still refuse to create a blank draft',
          );

          autosave.dispose();
        });
      });
    });

    // ── Sub-task B2-5: confidence UI (dirty + relative-time state) ─────────
    group('confidence UI (B2-5)', () {
      test('status is dirty while editing, saved after the debounce', () {
        fakeAsync((async) {
          final autosave = NoteDraftAutosave(
            captureCallSite: _testCaptureCallSite,
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

    // ── Review fix 1: coalescing flush (no lost edit while a save is inflight)
    group('coalescing flush (review #1)', () {
      test('an edit during an in-flight PUT is persisted on completion', () {
        fakeAsync((async) {
          // First PUT is held open via a Completer so we can inject an edit
          // while it is in flight; later PUTs resolve immediately.
          final gate = Completer<Map<String, dynamic>>();
          final puts = <Map<String, dynamic>>[];
          var first = true;
          final api = NoteDraftApi(
            put:
                ({
                  required String patientUid,
                  int? appointmentId,
                  required String noteType,
                  required Map<String, dynamic> content,
                }) {
                  puts.add(Map<String, dynamic>.from(content));
                  if (first) {
                    first = false;
                    return gate.future;
                  }
                  return Future.value({
                    'id': 1,
                    'updated_at': '2026-06-17T10:00:00Z',
                  });
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
          var body = 'A';
          final autosave = NoteDraftAutosave(
            captureCallSite: _testCaptureCallSite,
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': body},
            api: api,
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
          );

          // Type 'A', let the debounce fire → PUT('A') starts and is in flight.
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(puts, hasLength(1));
          expect((puts.single['chief_complaint']), 'A');

          // Type 'AB' while the first PUT is still awaiting, then flush (as a
          // pause/blur would). flush() must NOT drop the newest delta.
          body = 'AB';
          autosave.onContentChanged();
          autosave.flush();
          async.flushMicrotasks();
          // Still only one PUT — the second is coalesced behind the in-flight.
          expect(puts, hasLength(1), reason: 'second PUT waits for the first');

          // Complete the first PUT → the coalesced save must fire with 'AB'.
          gate.complete({'id': 1, 'updated_at': '2026-06-17T10:00:00Z'});
          async.flushMicrotasks();
          async.elapse(const Duration(seconds: 1));
          async.flushMicrotasks();

          expect(
            puts,
            hasLength(2),
            reason: 'the edit made during the in-flight save is persisted',
          );
          expect(
            puts.last['chief_complaint'],
            'AB',
            reason: 'the coalesced follow-up sends the LATEST snapshot',
          );

          autosave.dispose();
        });
      });
    });

    // ── Review fix 2: blocked device must not linger on "Unsaved changes…"
    group('blocked-device status (review #2)', () {
      test(
        'mobile device: status is not dirty after the debounce, no PUTs',
        () {
          fakeAsync((async) {
            final autosave = NoteDraftAutosave(
              captureCallSite: _testCaptureCallSite,
              patientUid: 'pt-1',
              noteType: 'op_consultation',
              snapshot: () => {'chief_complaint': 'x'},
              api: fake.build(),
              deviceType: () => 'mobile',
              debounce: const Duration(seconds: 3),
            );

            autosave.onContentChanged();
            // onContentChanged optimistically shows dirty…
            expect(autosave.status.value.kind, NoteDraftStatusKind.dirty);

            async.elapse(const Duration(seconds: 3));
            async.flushMicrotasks();

            // …but after the guarded save runs it must NOT still read as dirty.
            expect(
              autosave.status.value.kind,
              isNot(NoteDraftStatusKind.dirty),
              reason: 'blocked device must not linger on Unsaved changes…',
            );
            expect(autosave.status.value.kind, NoteDraftStatusKind.idle);
            expect(fake.puts, isEmpty);

            autosave.dispose();
          });
        },
      );
    });

    // ── Review fix 3: skip-unchanged must resolve dirty → saved
    group('skip-unchanged resolves status (review #3)', () {
      test('retyping identical content settles to saved, not dirty', () {
        fakeAsync((async) {
          final autosave = NoteDraftAutosave(
            captureCallSite: _testCaptureCallSite,
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': 'stable'},
            api: fake.build(),
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
            clock: () => DateTime(2026, 6, 17, 14, 14),
          );

          // First save.
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(fake.puts, hasLength(1));
          expect(autosave.status.value.kind, NoteDraftStatusKind.saved);

          // Retype identical content → status flips to dirty transiently…
          autosave.onContentChanged();
          expect(autosave.status.value.kind, NoteDraftStatusKind.dirty);

          // …but after the debounce the skip-unchanged branch must resolve it
          // back to saved (with the remembered timestamp), not leave it dirty.
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(fake.puts, hasLength(1), reason: 'no new PUT — unchanged');
          expect(autosave.status.value.kind, NoteDraftStatusKind.saved);
          expect(autosave.status.value.savedAt, DateTime(2026, 6, 17, 14, 14));

          autosave.dispose();
        });
      });
    });

    // ── Review fix 4: clear() resets _everSaved so skip-empty re-engages
    group('clear resets everSaved (review #4)', () {
      test(
        'after clear, an empty snapshot does not resurrect a blank draft',
        () {
          fakeAsync((async) {
            var body = 'chest pain';
            final autosave = NoteDraftAutosave(
              captureCallSite: _testCaptureCallSite,
              patientUid: 'pt-1',
              noteType: 'op_consultation',
              snapshot: () => {'chief_complaint': body},
              api: fake.build(),
              deviceType: () => 'desktop',
              debounce: const Duration(seconds: 3),
            );

            // Real non-empty save → _everSaved = true.
            autosave.onContentChanged();
            async.elapse(const Duration(seconds: 3));
            async.flushMicrotasks();
            expect(fake.puts, hasLength(1));

            // Discard the draft.
            autosave.clear();
            async.flushMicrotasks();
            expect(fake.deletes, hasLength(1));

            // Author types then re-empties the field. skip-empty must re-engage
            // (because clear reset _everSaved) → NO blank-draft PUT.
            body = 'typo';
            autosave.onContentChanged();
            body = '';
            autosave.onContentChanged();
            async.elapse(const Duration(seconds: 3));
            async.flushMicrotasks();

            expect(
              fake.puts,
              hasLength(1),
              reason: 'empty after discard must not resurrect the scratchpad',
            );

            autosave.dispose();
          });
        },
      );
    });

    // ── Review fix 5: an in-flight PUT that lands after clear() must not
    // re-cache/recreate the draft (clear generation guard).
    group('clear generation guard (review #5)', () {
      test('a PUT resolving after clear() does not mark saved / cache', () {
        fakeAsync((async) {
          final gate = Completer<Map<String, dynamic>>();
          final puts = <Map<String, dynamic>>[];
          final api = NoteDraftApi(
            put:
                ({
                  required String patientUid,
                  int? appointmentId,
                  required String noteType,
                  required Map<String, dynamic> content,
                }) {
                  puts.add(Map<String, dynamic>.from(content));
                  return gate.future;
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
                }) async => {'removed': true},
          );
          final autosave = NoteDraftAutosave(
            captureCallSite: _testCaptureCallSite,
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': 'x'},
            api: api,
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
          );

          // Arm a save → PUT in flight (held by the gate).
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(puts, hasLength(1));

          // clear() runs its DELETE while the PUT is still in flight.
          autosave.clear();
          async.flushMicrotasks();

          // Now the superseded PUT resolves.
          gate.complete({'id': 1, 'updated_at': '2026-06-17T10:00:00Z'});
          async.flushMicrotasks();
          async.elapse(const Duration(seconds: 1));
          async.flushMicrotasks();

          // The stale PUT must NOT flip the indicator to saved (clear left it
          // idle) — a superseded save is not authoritative.
          expect(
            autosave.status.value.kind,
            NoteDraftStatusKind.idle,
            reason: 'a save superseded by clear() must not mark saved',
          );

          autosave.dispose();
        });
      });
    });

    // ── Sub-task F: offline branch (private draft / cache / discard) ───────
    // The offline path is reachable only through the injected sync seam — the
    // real ConnectivitySyncService.instance reports isOnline==true headless.
    group('offline path (F)', () {
      test('a debounced save captures a private draft and shows offline', () {
        fakeAsync((async) {
          final sync = _FakeSync(online: false);
          final autosave = NoteDraftAutosave(
            captureCallSite: _testCaptureCallSite,
            patientUid: 'pt-1',
            appointmentId: 42,
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': 'chest pain'},
            api: fake.build(),
            sync: sync.build(),
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
          );

          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();

          expect(sync.enqueues, hasLength(1), reason: 'offline draft capture');
          expect(sync.enqueues.single['callSite'], _testCaptureCallSite);
          expect(sync.enqueues.single['patientReference'], 'pt-1');
          expect(sync.enqueues.single['appointmentId'], 42);
          expect(
            sync.enqueues.single['contextLabel'],
            'Note draft (op_consultation)',
            reason: 'the local draft carries a human-readable recovery label',
          );
          final body = sync.enqueues.single['body'] as Map;
          expect(body['patient_uid'], 'pt-1');
          expect(body['appointment_id'], 42);
          expect((body['content'] as Map)['chief_complaint'], 'chest pain');
          expect(fake.puts, isEmpty, reason: 'offline never PUTs directly');
          expect(autosave.status.value.kind, NoteDraftStatusKind.offline);

          autosave.dispose();
        });
      });

      test('an offline enqueue does NOT poison the skip-unchanged cache', () {
        fakeAsync((async) {
          final sync = _FakeSync(online: false);
          final autosave = NoteDraftAutosave(
            captureCallSite: _testCaptureCallSite,
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': 'same'},
            api: fake.build(),
            sync: sync.build(),
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
          );

          // Offline: the content is enqueued, not confirmed-saved.
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(sync.enqueues, hasLength(1));
          expect(fake.puts, isEmpty);

          // Reconnect and re-save the SAME content. Because the offline enqueue
          // must not seed _lastSavedJson, the confirming online PUT still fires
          // (skip-unchanged must not swallow an unconfirmed write).
          sync.online = true;
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(
            fake.puts,
            hasLength(1),
            reason:
                'an offline enqueue must not poison the cache — the identical '
                'online write still PUTs to actually confirm the draft',
          );

          autosave.dispose();
        });
      });

      test(
        'an enqueue failure re-arms dirty so the next heartbeat retries',
        () {
          fakeAsync((async) {
            final sync = _FakeSync(online: false)..enqueueThrows = true;
            final autosave = NoteDraftAutosave(
              captureCallSite: _testCaptureCallSite,
              patientUid: 'pt-1',
              noteType: 'op_consultation',
              snapshot: () => {'chief_complaint': 'x'},
              api: fake.build(),
              sync: sync.build(),
              deviceType: () => 'desktop',
              debounce: const Duration(seconds: 3),
              heartbeat: const Duration(seconds: 15),
            );

            // First enqueue throws → status=offline, dirty re-armed for retry.
            autosave.onContentChanged();
            async.elapse(const Duration(seconds: 3));
            async.flushMicrotasks();
            expect(
              sync.enqueues,
              hasLength(1),
              reason: 'first enqueue attempted',
            );
            expect(autosave.status.value.kind, NoteDraftStatusKind.offline);

            // The queue recovers; the 15s heartbeat must retry the enqueue
            // because the failed attempt re-armed dirty.
            sync.enqueueThrows = false;
            async.elapse(const Duration(seconds: 15));
            async.flushMicrotasks();
            expect(
              sync.enqueues,
              hasLength(2),
              reason: 'a failed enqueue re-arms dirty so the heartbeat retries',
            );

            autosave.dispose();
          });
        },
      );

      test('offline discard cancels the private draft for this context', () {
        fakeAsync((async) {
          final sync = _FakeSync(online: false);
          final autosave = NoteDraftAutosave(
            captureCallSite: _testCaptureCallSite,
            patientUid: 'pt-9',
            appointmentId: 7,
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': 'typed offline'},
            api: fake.build(),
            sync: sync.build(),
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
          );

          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(sync.enqueues, hasLength(1));

          // Discard while offline removes only this typed draft context.
          autosave.clear();
          async.flushMicrotasks();

          expect(
            sync.removals,
            hasLength(1),
            reason: 'offline clear cancels the typed draft',
          );
          expect(sync.removals.single['callSite'], _testCaptureCallSite);
          expect(sync.removals.single['patientReference'], 'pt-9');
          expect(sync.removals.single['appointmentId'], 7);

          autosave.dispose();
        });
      });

      test('an online discard does not touch the offline queue', () {
        fakeAsync((async) {
          final sync = _FakeSync(online: true);
          final autosave = NoteDraftAutosave(
            captureCallSite: _testCaptureCallSite,
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': 'x'},
            api: fake.build(),
            sync: sync.build(),
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
          );

          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(fake.puts, hasLength(1));

          autosave.clear();
          async.flushMicrotasks();

          expect(
            sync.removals,
            isEmpty,
            reason: 'online clear relies on the raw DELETE, not the queue',
          );
          expect(fake.deletes, hasLength(1));

          autosave.dispose();
        });
      });

      test('an enqueue resolving after clear() does not re-assert offline', () {
        fakeAsync((async) {
          final gate = Completer<bool>();
          final sync = _FakeSync(online: false)..enqueueGate = gate;
          final autosave = NoteDraftAutosave(
            captureCallSite: _testCaptureCallSite,
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': 'x'},
            api: fake.build(),
            sync: sync.build(),
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
          );

          // Arm a save → enqueue is in flight, held by the gate.
          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 3));
          async.flushMicrotasks();
          expect(sync.enqueues, hasLength(1));

          // Discard while the enqueue is still awaiting.
          autosave.clear();
          async.flushMicrotasks();
          expect(autosave.status.value.kind, NoteDraftStatusKind.idle);

          // The superseded enqueue now resolves — it must NOT flip to offline.
          gate.complete(true);
          async.flushMicrotasks();
          expect(
            autosave.status.value.kind,
            NoteDraftStatusKind.idle,
            reason: 'a save superseded by clear() must not re-assert offline',
          );

          autosave.dispose();
        });
      });

      test('a mobile device offline still refuses to enqueue', () {
        fakeAsync((async) {
          // The deviceType guard must short-circuit BEFORE the offline branch:
          // a phone with no connectivity must NOT queue draft writes (they'd
          // replay on reconnect and defeat the desktop/tablet-only gate that
          // exists to stop 403-spam / unauthorized clinical writes from phones).
          final sync = _FakeSync(online: false);
          final autosave = NoteDraftAutosave(
            captureCallSite: _testCaptureCallSite,
            patientUid: 'pt-1',
            noteType: 'op_consultation',
            snapshot: () => {'chief_complaint': 'x'},
            api: fake.build(),
            sync: sync.build(),
            deviceType: () => 'mobile',
            debounce: const Duration(seconds: 3),
            heartbeat: const Duration(seconds: 15),
          );

          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 20));
          async.flushMicrotasks();

          expect(
            sync.enqueues,
            isEmpty,
            reason: 'phone-mode never enqueues, even offline',
          );
          expect(fake.puts, isEmpty);

          autosave.dispose();
        });
      });

      test('a blank draft is never enqueued while offline', () {
        fakeAsync((async) {
          // skip-empty must short-circuit BEFORE the offline branch: merely
          // opening a scheduled OP patient offline (all clinical fields empty,
          // only appointment_id metadata) must NOT queue a blank draft PUT that
          // would recreate an empty scratchpad on reconnect.
          final sync = _FakeSync(online: false);
          final autosave = NoteDraftAutosave(
            captureCallSite: _testCaptureCallSite,
            patientUid: 'pt-1',
            appointmentId: 77,
            noteType: 'op_consultation',
            snapshot: () => {
              'chief_complaint': '',
              'history': '',
              'examination': '',
              'diagnosis': '',
              'plan': '',
              'summary': '',
              'appointment_id': 77,
            },
            api: fake.build(),
            sync: sync.build(),
            deviceType: () => 'desktop',
            debounce: const Duration(seconds: 3),
          );

          autosave.onContentChanged();
          async.elapse(const Duration(seconds: 5));
          async.flushMicrotasks();

          expect(
            sync.enqueues,
            isEmpty,
            reason: 'skip-empty precedes the offline branch — no blank enqueue',
          );

          autosave.dispose();
        });
      });

      test(
        'a null-appointment draft omits appointment_id and dequeues by null',
        () {
          fakeAsync((async) {
            // Nursing drafts carry no appointment_id. The enqueued body must OMIT
            // the key (not send null), and the discard predicate must still match
            // that null context (absent key == null appointmentId).
            final sync = _FakeSync(online: false);
            final autosave = NoteDraftAutosave(
              captureCallSite: _testCaptureCallSite,
              patientUid: 'pt-1',
              noteType: 'nursing_note',
              snapshot: () => {'free_text': 'obs'},
              api: fake.build(),
              sync: sync.build(),
              deviceType: () => 'desktop',
              debounce: const Duration(seconds: 3),
            );

            autosave.onContentChanged();
            async.elapse(const Duration(seconds: 3));
            async.flushMicrotasks();

            expect(sync.enqueues, hasLength(1));
            final body = sync.enqueues.single['body'] as Map;
            expect(
              body.containsKey('appointment_id'),
              isFalse,
              reason: 'a null appointmentId must be OMITTED, not sent as null',
            );

            // Discard offline preserves the null appointment in the typed key.
            autosave.clear();
            async.flushMicrotasks();
            expect(sync.removals.single['patientReference'], 'pt-1');
            expect(sync.removals.single['appointmentId'], isNull);

            autosave.dispose();
          });
        },
      );
    });
  });
}
