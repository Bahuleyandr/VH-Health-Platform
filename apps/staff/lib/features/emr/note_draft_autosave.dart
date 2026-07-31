// lib/features/emr/note_draft_autosave.dart
//
// Reusable debounce/heartbeat autosave controller for in-progress clinical
// notes (OP Doctor Workspace + nursing notes). It writes to the server-side
// note-draft scratchpad (`PUT/GET/DELETE /emr/notes/draft`) which emits NO
// canonical timeline/audit events — the existing finalize (Save/Sign) path is
// the only writer of canonical rows. See
// docs/superpowers/specs/2026-06-17-clinical-notes-autosave-design.md.
//
// Design notes:
//  - Autosave NEVER throws to the UI. Any failure sets status=error and the
//    next debounce/heartbeat retries. Typing is never blocked.
//  - When the device is offline, only the C4.3 typed action gateway may persist
//    a signed private-draft command. Missing policy/facility authority leaves
//    the form dirty for a later online save.
//  - The API surface is injected as plain function fields so screens use the
//    real `MedicalApiService` static methods while tests pass fakes without
//    touching HTTP.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/platform_info.dart';
import '../../core/services/connectivity_sync_service.dart';
import '../../core/services/medical_api_service.dart';
import '../../core/services/staff_clinical_action_gateway.dart';

/// Lifecycle state surfaced to the screen so it can render a small
/// "Unsaved changes… / Saving… / Saved 2m ago / Offline / Couldn't save"
/// indicator.
///
/// [dirty] is a transient state between an edit and the debounce firing so the
/// author sees "Unsaved changes…" while the ~3 s debounce is pending. It never
/// alarms — a failed PUT still flips to [error] on its own.
enum NoteDraftStatusKind { idle, dirty, saving, saved, offline, error }

/// Immutable status snapshot. [savedAt] is set only for [NoteDraftStatusKind.saved].
@immutable
class NoteDraftStatus {
  final NoteDraftStatusKind kind;
  final DateTime? savedAt;

  const NoteDraftStatus._(this.kind, [this.savedAt]);

  const NoteDraftStatus.idle() : this._(NoteDraftStatusKind.idle);
  const NoteDraftStatus.dirty() : this._(NoteDraftStatusKind.dirty);
  const NoteDraftStatus.saving() : this._(NoteDraftStatusKind.saving);
  const NoteDraftStatus.saved(DateTime at)
    : this._(NoteDraftStatusKind.saved, at);
  const NoteDraftStatus.offline() : this._(NoteDraftStatusKind.offline);
  const NoteDraftStatus.error() : this._(NoteDraftStatusKind.error);

  @override
  bool operator ==(Object other) =>
      other is NoteDraftStatus &&
      other.kind == kind &&
      other.savedAt == savedAt;

  @override
  int get hashCode => Object.hash(kind, savedAt);

  @override
  String toString() => 'NoteDraftStatus($kind, $savedAt)';
}

/// Injectable HTTP surface. Defaults forward to [MedicalApiService]; tests
/// pass fakes. Signatures mirror the api-service draft methods exactly.
class NoteDraftApi {
  final Future<Map<String, dynamic>> Function({
    required String patientUid,
    int? appointmentId,
    required String noteType,
    required Map<String, dynamic> content,
  })
  put;

  final Future<Map<String, dynamic>?> Function({
    required String patientUid,
    int? appointmentId,
    required String noteType,
  })
  get;

  final Future<Map<String, dynamic>> Function({
    required String patientUid,
    int? appointmentId,
    required String noteType,
  })
  delete;

  const NoteDraftApi({
    required this.put,
    required this.get,
    required this.delete,
  });

  /// The production wiring against the real backend.
  factory NoteDraftApi.live() => const NoteDraftApi(
    put: MedicalApiService.putNoteDraft,
    get: MedicalApiService.getNoteDraft,
    delete: MedicalApiService.deleteNoteDraft,
  );
}

/// Injectable connectivity + typed-capture surface. Defaults forward to the
/// C4.3 gateway; tests pass fakes to drive the offline
/// branch — which is otherwise unreachable, since the real singleton reports
/// `isOnline == true` in a headless test VM and its state cannot be faked
/// (private ctor, no setter). Mirrors [NoteDraftApi]'s function-field injection.
class NoteDraftSync {
  /// Whether the device currently has connectivity.
  final bool Function() isOnline;

  final Future<bool> Function({
    required StaffCaptureCallSite callSite,
    required String patientReference,
    int? appointmentId,
    required Map<String, dynamic> body,
    String? contextLabel,
  })
  capturePrivateDraft;

  final Future<int> Function({
    required StaffCaptureCallSite callSite,
    required String patientReference,
    int? appointmentId,
  })
  cancelPrivateDrafts;

  const NoteDraftSync({
    required this.isOnline,
    required this.capturePrivateDraft,
    required this.cancelPrivateDrafts,
  });

  /// Production wiring against the shared connectivity/offline-queue service.
  factory NoteDraftSync.live() {
    final svc = ConnectivitySyncService.instance;
    final gateway = StaffClinicalActionGateway.instance;
    return NoteDraftSync(
      isOnline: () => svc.isOnline,
      capturePrivateDraft:
          ({
            required callSite,
            required patientReference,
            appointmentId,
            required body,
            contextLabel,
          }) async {
            final result = await gateway.capturePrivateDraft(
              callSite: callSite,
              patientReference: patientReference,
              appointmentId: appointmentId?.toString(),
              payload: body,
              contextLabel: contextLabel,
            );
            return result.allowed;
          },
      cancelPrivateDrafts:
          ({required callSite, required patientReference, appointmentId}) =>
              svc.cancelPreparedDrafts(
                actionId: callSite.actionId,
                patientReference: patientReference,
                appointmentId: appointmentId?.toString(),
              ),
    );
  }
}

/// Drives debounced + heartbeat autosave of a single note draft.
///
/// Usage:
/// ```dart
/// final autosave = NoteDraftAutosave(
///   patientUid: uid,
///   appointmentId: appointmentId,
///   noteType: 'op_consultation',
///   snapshot: () => _currentContentMap(),
/// );
/// // attach to controllers: ctrl.addListener(autosave.onContentChanged);
/// // restore on open: final draft = await autosave.restore();
/// // on finalize success: await autosave.clear();
/// // in State.dispose(): autosave.dispose();
/// ```
class NoteDraftAutosave {
  NoteDraftAutosave({
    required this.patientUid,
    required this.noteType,
    required this.captureCallSite,
    required Map<String, dynamic> Function() snapshot,
    this.appointmentId,
    NoteDraftApi? api,
    NoteDraftSync? sync,
    this.debounce = const Duration(seconds: 3),
    this.heartbeat = const Duration(seconds: 15),
    DateTime Function()? clock,
    String Function()? deviceType,
  }) : _snapshot = snapshot,
       _api = api ?? NoteDraftApi.live(),
       _sync = sync ?? NoteDraftSync.live(),
       _clock = clock ?? DateTime.now,
       _deviceType = deviceType ?? (() => currentDeviceType);

  final String patientUid;
  final int? appointmentId;
  final String noteType;
  final StaffCaptureCallSite captureCallSite;
  final Duration debounce;
  final Duration heartbeat;

  final Map<String, dynamic> Function() _snapshot;
  final NoteDraftApi _api;
  final NoteDraftSync _sync;
  final DateTime Function() _clock;

  /// Current device posture (`currentDeviceType`). Autosave shadows the
  /// desktop/tablet-only note-finalize write, so on a phone/mobile (or an
  /// empty/unknown) deviceType it no-ops — never PUTting nor enqueuing —
  /// exactly as `buildOfflineOrderIntent` gates the offline order path.
  final String Function() _deviceType;

  /// JSON of the last SUCCESSFULLY-saved snapshot (online PUT success only).
  /// Used to skip re-PUTting byte-identical content. Deliberately NOT set on a
  /// failed save (so an identical retry still attempts) nor on an offline
  /// enqueue (an enqueued-but-unconfirmed save must not poison the cache).
  String? _lastSavedJson;

  /// Timestamp of the last successful save (and seeded on restore). Lets the
  /// skip-unchanged branch re-assert `saved(<when>)` instead of leaving the
  /// indicator stuck on "Unsaved changes…" when nothing actually changed.
  DateTime? _lastSavedAt;

  /// True once a non-empty snapshot has been saved. Before that we refuse to
  /// persist an empty/whitespace-only draft (never create a blank scratchpad).
  /// After that, an intentional clear-to-empty IS a legitimate edit and saves.
  bool _everSaved = false;

  /// Set when `_save()` is entered while a save is already in flight — the
  /// completion path re-runs `_save()` so an edit made DURING an in-flight PUT
  /// is persisted immediately (not only at the next 15 s heartbeat). Without
  /// this, a flush() on app-pause during a slow save would silently drop the
  /// newest delta.
  bool _pendingSave = false;

  /// Monotonic generation bumped by every `clear()`. A `_save()` captures it
  /// before awaiting its PUT; if it changed by the time the PUT resolves, a
  /// clear() (finalize/discard) happened meanwhile, so the now-superseded save
  /// must NOT be cached or marked authoritative-saved.
  int _clearGeneration = 0;

  /// Observable status for the screen's "Saving… / Saved <time>" indicator.
  final ValueNotifier<NoteDraftStatus> status = ValueNotifier<NoteDraftStatus>(
    const NoteDraftStatus.idle(),
  );

  Timer? _debounceTimer;
  Timer? _heartbeatTimer;
  bool _dirty = false;
  bool _saveInFlight = false;
  bool _disposed = false;

  /// Call on every content change (e.g. a `TextEditingController` listener).
  /// Resets the ~3 s debounce and, if not already running, starts the ~15 s
  /// max-interval heartbeat so a steadily-typing user still gets periodic
  /// saves even though the debounce keeps deferring.
  void onContentChanged() {
    if (_disposed) return;
    _dirty = true;
    // Transient "Unsaved changes…" while the debounce is pending. Quiet by
    // design — a failed PUT flips to error on its own, so no separate alarm.
    // Don't clobber a mid-flight "Saving…" indicator.
    if (status.value.kind != NoteDraftStatusKind.saving) {
      status.value = const NoteDraftStatus.dirty();
    }
    _debounceTimer?.cancel();
    _debounceTimer = Timer(debounce, _save);
    _heartbeatTimer ??= Timer.periodic(heartbeat, (_) {
      if (_dirty) _save();
    });
  }

  /// Restore the author's saved draft for this context, if any.
  /// Returns `{ 'content': Map<String,dynamic>, 'updatedAt': DateTime? }` or
  /// `null` when there is no draft / on failure (failures never throw).
  Future<Map<String, dynamic>?> restore() async {
    try {
      final draft = await _api.get(
        patientUid: patientUid,
        appointmentId: appointmentId,
        noteType: noteType,
      );
      if (draft == null) return null;
      final content = draft['content'];
      final updatedAt = DateTime.tryParse(
        draft['updated_at']?.toString() ?? '',
      );
      final contentMap = content is Map
          ? Map<String, dynamic>.from(content)
          : <String, dynamic>{};
      // Seed the skip-unchanged cache to the restored content so the immediate
      // post-restore save (fired when controllers rehydrate) is correctly
      // skipped, and treat a non-empty restored draft as an existing save so a
      // later intentional clear-to-empty still persists.
      _lastSavedJson = jsonEncode(contentMap);
      _lastSavedAt = updatedAt ?? _clock();
      if (!_isEffectivelyEmpty(contentMap)) _everSaved = true;
      return {'content': contentMap, 'updatedAt': updatedAt};
    } catch (e) {
      if (kDebugMode) debugPrint('NoteDraftAutosave.restore failed: $e');
      return null;
    }
  }

  /// Delete the draft and stop all timers. Call on finalize (Save/Sign
  /// success) so the scratchpad never lingers after the real note is
  /// committed. Best-effort — the server also deletes post-commit and a
  /// janitor sweeps stragglers — so failures here never throw.
  Future<void> clear() async {
    _dirty = false;
    _pendingSave = false;
    _lastSavedJson = null;
    _lastSavedAt = null;
    // A discard/finalize means the just-typed content is gone: re-arm
    // skip-empty so a post-discard empty snapshot can't resurrect a blank
    // scratchpad, and bump the generation so an in-flight PUT that lands after
    // this DELETE is treated as superseded (not re-cached / re-marked saved).
    _everSaved = false;
    _clearGeneration++;
    _debounceTimer?.cancel();
    _debounceTimer = null;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    // Durable discard while offline. The raw DELETE below no-ops with no
    // connectivity, but a draft PUT enqueued earlier while typing offline
    // survives in the offline queue and would RECREATE this draft on reconnect
    // (there is no finalize POST to reap it, unlike Save/Sign). Drop any queued
    // draft PUT for THIS context so the discard is durable instead of leaning
    // on the 14-day TTL janitor. Best-effort — never throws to the caller.
    if (!_sync.isOnline()) {
      try {
        await _sync.cancelPrivateDrafts(
          callSite: captureCallSite,
          patientReference: patientUid,
          appointmentId: appointmentId,
        );
      } catch (e) {
        if (kDebugMode) {
          debugPrint('NoteDraftAutosave.clear dequeue failed: $e');
        }
      }
    }
    try {
      await _api.delete(
        patientUid: patientUid,
        appointmentId: appointmentId,
        noteType: noteType,
      );
    } catch (e) {
      if (kDebugMode) debugPrint('NoteDraftAutosave.clear failed: $e');
    }
    if (!_disposed) status.value = const NoteDraftStatus.idle();
  }

  /// Force an immediate save (e.g. on field blur or app-lifecycle pause).
  /// No-op when there are no unsaved changes.
  void flush() {
    if (_disposed || !_dirty) return;
    _debounceTimer?.cancel();
    _save();
  }

  Future<void> _save() async {
    if (_disposed) return;
    // Coalesce: a save already running. Remember that more work is due so the
    // in-flight save's completion path re-runs _save() with the latest
    // snapshot — otherwise an edit made during a slow PUT (and a flush() on
    // app-pause) would be lost until the next 15 s heartbeat.
    if (_saveInFlight) {
      _pendingSave = true;
      return;
    }
    final content = _snapshot();

    // Guard 1 (A) — deviceType. Autosave shadows the desktop/tablet-only
    // note-finalize write, so on a phone/mobile (or empty/unknown) deviceType
    // it no-ops: no PUT, no enqueue. Mirrors buildOfflineOrderIntent's gate
    // (`dt == 'mobile' || dt.isEmpty`). Clear dirty so the heartbeat stops
    // retrying, and settle the indicator to a neutral (idle) state so it never
    // lingers on "Unsaved changes…" on a device where autosave is OFF.
    final dt = _deviceType().trim().toLowerCase();
    if (dt == 'mobile' || dt.isEmpty) {
      _dirty = false;
      _pendingSave = false;
      if (!_disposed && status.value.kind != NoteDraftStatusKind.idle) {
        status.value = const NoteDraftStatus.idle();
      }
      return;
    }

    final currentJson = jsonEncode(content);

    // Guard 2 (E skip-empty) — never create a blank draft. An all-empty
    // snapshot before any real save is skipped; once something has been saved,
    // an intentional clear-to-empty is a legit edit and must persist.
    if (!_everSaved && _isEffectivelyEmpty(content)) {
      _dirty = false;
      return;
    }

    // Guard 3 (E skip-unchanged) — don't re-PUT byte-identical content. Only
    // compares against the last SUCCESSFULLY-saved snapshot. Re-assert the
    // saved status (with the remembered timestamp) so a transient "Unsaved
    // changes…" set by onContentChanged resolves instead of lingering.
    if (currentJson == _lastSavedJson) {
      _dirty = false;
      if (!_disposed && _lastSavedAt != null) {
        status.value = NoteDraftStatus.saved(_lastSavedAt!);
      }
      return;
    }

    _saveInFlight = true;
    _dirty = false;
    // Snapshot the clear generation BEFORE awaiting. If clear() (finalize /
    // discard) bumps it while the write is in flight, this save is superseded
    // and must not be cached or marked authoritative-saved on completion.
    final generation = _clearGeneration;

    try {
      // Offline: only the typed C4.3 gateway may persist a private draft. A
      // missing signed policy or provisioned facility leaves the form dirty
      // for a later online retry.
      if (!_sync.isOnline()) {
        try {
          final captured = await _sync.capturePrivateDraft(
            callSite: captureCallSite,
            patientReference: patientUid,
            appointmentId: appointmentId,
            body: {
              'patient_uid': patientUid,
              if (appointmentId != null) 'appointment_id': appointmentId,
              'note_type': noteType,
              'content': content,
            },
            contextLabel: 'Note draft ($noteType)',
          );
          if (!captured) _dirty = true;
        } catch (e) {
          if (kDebugMode) debugPrint('NoteDraftAutosave capture failed: $e');
          // The draft is still safe in the in-memory form; mark dirty so the
          // next heartbeat/debounce retries once connectivity returns.
          _dirty = true;
        }
        if (!_disposed && _clearGeneration == generation) {
          status.value = const NoteDraftStatus.offline();
        }
        return;
      }

      if (!_disposed) status.value = const NoteDraftStatus.saving();
      try {
        await _api.put(
          patientUid: patientUid,
          appointmentId: appointmentId,
          noteType: noteType,
          content: content,
        );
        // A clear() during the PUT supersedes this save — do NOT cache it or
        // mark saved (the draft was just deleted; caching would wrongly skip a
        // future identical save, and "saved" would contradict the discard).
        if (_clearGeneration != generation) return;
        // SUCCESS branch only: remember what we saved so the next identical
        // heartbeat is skipped, and record that a real save has happened.
        _lastSavedJson = currentJson;
        _lastSavedAt = _clock();
        if (!_isEffectivelyEmpty(content)) _everSaved = true;
        if (!_disposed) status.value = NoteDraftStatus.saved(_lastSavedAt!);
      } catch (e) {
        if (kDebugMode) debugPrint('NoteDraftAutosave save failed: $e');
        // Never surface to the UI as an exception. Re-arm so the next tick
        // retries the latest content (unless a clear superseded it).
        if (_clearGeneration != generation) return;
        _dirty = true;
        if (!_disposed) status.value = const NoteDraftStatus.error();
      }
    } finally {
      _saveInFlight = false;
      // Coalesce: re-run ONLY when a save was explicitly requested while this
      // one was in flight (a debounce/heartbeat/flush() that hit the
      // `_saveInFlight` guard and set `_pendingSave`). That is the flush-on-
      // pause "persist the newest delta now" case. Do NOT key this on `_dirty`:
      // the failure/offline branches set `_dirty = true` to mean "retry at the
      // next heartbeat" — following up on that would busy-loop this microtask
      // against a failing/offline endpoint with no backoff. `_pendingSave` is
      // set only by the in-flight guard and consumed here, so the follow-up is
      // bounded (it re-fires only for genuinely new content). Skip when a
      // clear() superseded us.
      final shouldFollowUp = _pendingSave;
      _pendingSave = false;
      if (!_disposed && _clearGeneration == generation && shouldFollowUp) {
        scheduleMicrotask(() {
          if (!_disposed) _save();
        });
      }
    }
  }

  /// True when a snapshot carries no meaningful content — every string field
  /// is empty after `.trim()` and no collection field holds a value. Used to
  /// refuse creating a blank draft before any real save (skip-empty).
  bool _isEffectivelyEmpty(Map<String, dynamic> content) {
    for (final value in content.values) {
      if (value == null) continue;
      if (value is String) {
        if (value.trim().isNotEmpty) return false;
      } else if (value is Iterable) {
        if (value.isNotEmpty) return false;
      } else if (value is Map) {
        if (value.isNotEmpty) return false;
      } else {
        // Non-string SCALARS (int/double/num/bool) are identity metadata — a
        // note draft only ever carries them as machine keys like the injected
        // `appointment_id`, never as clinical text. They must NOT count as
        // content, or skip-empty is defeated for every appointment-scoped OP
        // note (which always carries an int appointment_id) and a blank draft
        // is created on the first heartbeat. Only Strings and non-empty
        // List/Map fields represent real authored content.
        continue;
      }
    }
    return true;
  }

  void dispose() {
    _disposed = true;
    _debounceTimer?.cancel();
    _debounceTimer = null;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    status.dispose();
  }
}
