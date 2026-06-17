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
//  - When the device is offline and an offline queue is available, the draft
//    PUT is enqueued best-effort (status=offline); otherwise we just mark
//    status=offline and let the next online tick catch up.
//  - The API surface is injected as plain function fields so screens use the
//    real `MedicalApiService` static methods while tests pass fakes without
//    touching HTTP.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/services/connectivity_sync_service.dart';
import '../../core/services/medical_api_service.dart';

/// Lifecycle state surfaced to the screen so it can render a small
/// "Saving… / Saved 2:14 pm / Offline / Couldn't save" indicator.
enum NoteDraftStatusKind { idle, saving, saved, offline, error }

/// Immutable status snapshot. [savedAt] is set only for [NoteDraftStatusKind.saved].
@immutable
class NoteDraftStatus {
  final NoteDraftStatusKind kind;
  final DateTime? savedAt;

  const NoteDraftStatus._(this.kind, [this.savedAt]);

  const NoteDraftStatus.idle() : this._(NoteDraftStatusKind.idle);
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
    required Map<String, dynamic> Function() snapshot,
    this.appointmentId,
    NoteDraftApi? api,
    ConnectivitySyncService? connectivity,
    this.debounce = const Duration(seconds: 3),
    this.heartbeat = const Duration(seconds: 15),
    DateTime Function()? clock,
  }) : _snapshot = snapshot,
       _api = api ?? NoteDraftApi.live(),
       _connectivity = connectivity ?? ConnectivitySyncService.instance,
       _clock = clock ?? DateTime.now;

  final String patientUid;
  final int? appointmentId;
  final String noteType;
  final Duration debounce;
  final Duration heartbeat;

  final Map<String, dynamic> Function() _snapshot;
  final NoteDraftApi _api;
  final ConnectivitySyncService _connectivity;
  final DateTime Function() _clock;

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
      return {
        'content': content is Map
            ? Map<String, dynamic>.from(content)
            : <String, dynamic>{},
        'updatedAt': updatedAt,
      };
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
    _debounceTimer?.cancel();
    _debounceTimer = null;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
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
    if (_disposed || _saveInFlight) return;
    final content = _snapshot();
    _saveInFlight = true;
    _dirty = false;

    // Offline: enqueue best-effort if the queue is available, else just flag.
    if (!_connectivity.isOnline) {
      try {
        await _connectivity.enqueue(
          endpoint: _draftEndpoint(),
          method: 'PUT',
          body: {
            'patient_uid': patientUid,
            if (appointmentId != null) 'appointment_id': appointmentId,
            'note_type': noteType,
            'content': content,
          },
          contextLabel: 'Note draft ($noteType)',
        );
      } catch (e) {
        if (kDebugMode) debugPrint('NoteDraftAutosave enqueue failed: $e');
        // The draft is still safe in the in-memory form; mark dirty so the
        // next heartbeat/debounce retries once connectivity returns.
        _dirty = true;
      }
      _saveInFlight = false;
      if (!_disposed) status.value = const NoteDraftStatus.offline();
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
      if (!_disposed) status.value = NoteDraftStatus.saved(_clock());
    } catch (e) {
      if (kDebugMode) debugPrint('NoteDraftAutosave save failed: $e');
      // Never surface to the UI as an exception. Re-arm so the next tick
      // retries the latest content.
      _dirty = true;
      if (!_disposed) status.value = const NoteDraftStatus.error();
    } finally {
      _saveInFlight = false;
    }
  }

  /// The offline-queue endpoint string with the draft context encoded — the
  /// queue replays it verbatim via `VHHttpClient.put`, so the body carries the
  /// payload and the path stays the canonical draft route.
  String _draftEndpoint() => '/emr/notes/draft';

  void dispose() {
    _disposed = true;
    _debounceTimer?.cancel();
    _debounceTimer = null;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    status.dispose();
  }
}
