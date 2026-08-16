import 'package:flutter/material.dart';
import 'package:vhhealth_core/widgets/data_state_builder.dart';

import '../../../core/services/connectivity_sync_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/staff_clinical_action_gateway.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/api_error_messages.dart';
import '../../../core/widgets/offline_clinical_fallback_dialog.dart';
import '../../../core/widgets/patient_context_chip.dart';
import '../../../core/widgets/patient_notes_list.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/success_toast.dart';
import '../../../core/widgets/voice_dictate_button.dart';
import '../../../l10n/app_strings.dart';
import '../../emr/note_draft_autosave.dart';
import '../../emr/widgets/note_draft_status_indicator.dart';

typedef RecentNursingNotesLoader = Future<Map<String, dynamic>> Function(
  String patientUid, {
  int page,
  int limit,
  String? noteType,
});

typedef NursingNotesOnlineProbe = bool Function();
typedef NursingNoteCreator = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> body,
);

bool defaultNursingNotesOnlineProbe() =>
    ConnectivitySyncService.instance.isOnline;

Future<Map<String, dynamic>> defaultNursingNoteCreator(
  Map<String, dynamic> body,
) => MedicalApiService.createClinicalNote(body);

Future<Map<String, dynamic>> defaultRecentNursingNotesLoader(
  String patientUid, {
  int page = 1,
  int limit = 10,
  String? noteType,
}) {
  return MedicalApiService.getPatientNotes(
    patientUid,
    noteType: noteType,
    page: page,
    limit: limit,
  );
}

/// Nursing Notes screen — for Nursing Staff to add clinical notes per patient.
/// Notes are saved to /emr/notes as append-only nursing assessments.
///
/// Optional prefill via route query params: `?patient_uid=&name=&phone=`.
/// Used by the bed-board's "Add Note" quick action so the nurse doesn't
/// re-key the patient's phone number for every note during a round.
class NursingNotesScreen extends StatefulWidget {
  final String? prefillPatientUid;
  final String? prefillPatientName;
  final String? prefillPatientPhone;
  final RecentNursingNotesLoader recentNotesLoader;
  final NursingNotesOnlineProbe isOnline;
  final NursingNoteCreator createNote;
  const NursingNotesScreen({
    super.key,
    this.prefillPatientUid,
    this.prefillPatientName,
    this.prefillPatientPhone,
    this.recentNotesLoader = defaultRecentNursingNotesLoader,
    this.isOnline = defaultNursingNotesOnlineProbe,
    this.createNote = defaultNursingNoteCreator,
  });

  @override
  State<NursingNotesScreen> createState() => _NursingNotesScreenState();
}

class _NursingNotesScreenState extends State<NursingNotesScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    // 3 tabs: Add (new nursing note), Recent (own/this-screen history),
    // and All Notes (cross-visibility: every author role's notes for the
    // patient, with read-only rendering and an admin-only edit button).
    _tabController = TabController(length: 3, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final hasContext =
        (widget.prefillPatientName ?? '').isNotEmpty ||
        (widget.prefillPatientPhone ?? '').isNotEmpty;

    return StaffScaffold(
      title: s.nursingNotesTitle,
      body: Column(
        children: [
          if (hasContext)
            PatientContextChip(
              name: widget.prefillPatientName,
              phone: widget.prefillPatientPhone,
              accent: const Color(0xFF00695C),
            ),
          Container(
            color: AppTheme.cardSurface,
            child: TabBar(
              controller: _tabController,
              labelColor: const Color(0xFF00695C),
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: const Color(0xFF00695C),
              tabs: [
                Tab(text: s.nursingNotesTabAdd),
                Tab(text: s.nursingNotesTabRecent),
                Tab(
                  text: AppStrings.of(context)
                      .lookup('s4.lib.nursing_notes.all_notes'),
                ),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _AddNoteTab(
                  prefillPatientUid: widget.prefillPatientUid,
                  prefillPhone: widget.prefillPatientPhone,
                  isOnline: widget.isOnline,
                  createNote: widget.createNote,
                ),
                RecentNursingNotesTab(
                  patientUid: widget.prefillPatientUid,
                  patientName: widget.prefillPatientName,
                  loadNotes: widget.recentNotesLoader,
                ),
                // Cross-role visibility: doctor + nurse + every other author
                // role for this patient, read-only with role badges. Admin
                // sees an edit pencil on each row (PUT /emr/notes/:id).
                // If we don't have a patientUid in context (screen opened
                // standalone, not from the bed board), prompt the user.
                (widget.prefillPatientUid ?? '').isEmpty
                    ? _NoPatientContext()
                    : PatientNotesList(
                        patientUid: widget.prefillPatientUid!,
                        patientName: widget.prefillPatientName,
                      ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _AddNoteTab extends StatefulWidget {
  final String? prefillPatientUid;
  final String? prefillPhone;
  final NursingNotesOnlineProbe isOnline;
  final NursingNoteCreator createNote;
  const _AddNoteTab({
    this.prefillPatientUid,
    this.prefillPhone,
    required this.isOnline,
    required this.createNote,
  });

  @override
  State<_AddNoteTab> createState() => _AddNoteTabState();
}

class _AddNoteTabState extends State<_AddNoteTab> with WidgetsBindingObserver {
  final _formKey = GlobalKey<FormState>();
  final _phoneCtrl = TextEditingController();
  final _noteCtrl = TextEditingController();

  // Autosave the in-progress nursing note to the server-side draft scratchpad
  // (no canonical timeline/audit events). The finalized nursing note is always
  // stored as 'nursing_assessment' (the backend's normalizeNotePayload folds the
  // picker code into content.note_category), so the draft is keyed by that
  // canonical type — one in-progress draft per patient, the picked category
  // carried in the content. This keeps the draft consistent with the stored note
  // AND lets the server-side finalize-clear (which fires on 'nursing_assessment')
  // match it. Requires a patient context (drafts are keyed by patient_uid);
  // without one, autosave stays inert.
  NoteDraftAutosave? _autosave;
  bool _restoringDraft = false;

  bool get _hasPatientContext => (widget.prefillPatientUid ?? '').isNotEmpty;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if ((widget.prefillPhone ?? '').isNotEmpty) {
      _phoneCtrl.text = widget.prefillPhone!;
    }
    _noteCtrl.addListener(_onNoteChanged);
    // Bind autosave once after the first frame (restore() may show a snackbar,
    // which needs a mounted Scaffold). The note-type picker does NOT rebind.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _initNursingAutosave();
    });
  }

  void _onNoteChanged() {
    if (_restoringDraft) return;
    _autosave?.onContentChanged();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    super.didChangeAppLifecycleState(state);
    // Data-loss guard: force-save the pending debounced delta when the app is
    // backgrounded/closed so the last <3s of typing isn't lost. flush() is
    // idempotent, offline-safe, and no-ops when not dirty / disposed / on a
    // non-workbench device — and `_autosave` may still be null before the
    // post-frame bind, so the null-safe call just no-ops then.
    // Deliberately NOT flushed in dispose(): flush() defers an async _save()
    // that reads the note controller, which dispose() tears down synchronously.
    if (state == AppLifecycleState.inactive ||
        state == AppLifecycleState.paused) {
      _autosave?.flush();
    }
  }

  // The finalized nursing note is always note_type 'nursing_assessment'; the
  // draft is keyed by it so the server-side finalize-clear matches.
  static const _nursingDraftNoteType = 'nursing_assessment';

  /// Bind the autosave once for this patient and restore any saved draft.
  /// One in-progress nursing draft per patient; the picked category lives in
  /// the content (note_category), so the picker change feeds the snapshot
  /// rather than rebinding.
  Future<void> _initNursingAutosave() async {
    if (!_hasPatientContext || _autosave != null) return;
    final autosave = NoteDraftAutosave(
      patientUid: widget.prefillPatientUid!,
      noteType: _nursingDraftNoteType,
      captureCallSite: StaffCaptureCallSite.nursingAssessmentDraftStorage,
      snapshot: () => {
        'free_text': _noteCtrl.text.trim(),
        if (_noteType != null) 'note_category': _noteType,
      },
    );
    _autosave = autosave;
    if (mounted) setState(() {});

    final draft = await autosave.restore();
    if (!mounted || !identical(_autosave, autosave)) return;
    if (draft != null) {
      final content = (draft['content'] as Map?)?.cast<String, dynamic>() ?? {};
      final text = content['free_text']?.toString() ?? '';
      final category = content['note_category']?.toString();
      final hasText = text.trim().isNotEmpty;
      final hasCategory = category != null && _noteTypeCodes.contains(category);
      if (hasText || hasCategory) {
        _restoringDraft = true;
        if (hasText) _noteCtrl.text = text;
        if (hasCategory) _noteType = category;
        _restoringDraft = false;
        if (mounted) setState(() {});
        _showDraftRestoredBanner(draft['updatedAt'] as DateTime?);
      }
    }
  }

  void _showDraftRestoredBanner(DateTime? updatedAt) {
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final s = AppStrings.of(context);
    final when = updatedAt != null
        ? TimeOfDay.fromDateTime(updatedAt.toLocal()).format(context)
        : null;
    messenger.clearSnackBars();
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          when != null
              ? s.format('s4.dynamic.nursing_notes.restored_draft_from', {
                  'time': when,
                })
              : s.lookup('s4.lib.nursing_notes.restored_draft'),
        ),
        backgroundColor: const Color(0xFF00695C),
        duration: const Duration(seconds: 6),
        action: SnackBarAction(
          label: s.lookup('s4.lib.nursing_notes.discard_draft'),
          textColor: Colors.white,
          onPressed: _discardRestoredDraft,
        ),
      ),
    );
  }

  /// Discard a restored draft the nurse doesn't want: delete the server-side
  /// draft + reset autosave state (`clear()`), and wipe the restored content
  /// out of the note fields so the UI reflects the discard. The programmatic
  /// clears run under `_restoringDraft` so emptying the field doesn't
  /// immediately re-enqueue an empty draft (mirrors _submit's reset guard).
  void _discardRestoredDraft() {
    final messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentSnackBar();
    // Delete the server draft + reset autosave (best-effort; never throws).
    _autosave?.clear();
    _restoringDraft = true;
    _noteCtrl.clear();
    _restoringDraft = false;
    if (!mounted) return;
    setState(() => _noteType = null);
    messenger.showSnackBar(
      const SnackBar(
        content: AppText('s4.lib.nursing_notes.draft_discarded'),
        duration: Duration(seconds: 3),
      ),
    );
  }

  String? _noteType;
  String _priority = 'normal';
  bool _submitting = false;

  // Localised note-type labels are looked up via AppStrings; canonical
  // codes go to the backend. Order matches the previous English list so
  // any analytics keyed off "Observation" etc. remain stable.
  static const _noteTypeCodes = <String>[
    'Observation',
    'Medication Note',
    'Post-Procedure',
    'Intake/Output',
    'Patient Complaint',
    'Wound Care',
    'Shift Handover',
    'Emergency Note',
    'Other',
  ];

  String _noteTypeLabel(AppStrings s, String code) {
    switch (code) {
      case 'Observation':
        return s.nursingNotesTypeObservation;
      case 'Medication Note':
        return s.nursingNotesTypeMedication;
      case 'Post-Procedure':
        return s.nursingNotesTypePostProcedure;
      case 'Intake/Output':
        return s.nursingNotesTypeIntakeOutput;
      case 'Patient Complaint':
        return s.nursingNotesTypePatientComplaint;
      case 'Wound Care':
        return s.nursingNotesTypeWoundCare;
      case 'Shift Handover':
        return s.nursingNotesTypeShiftHandover;
      case 'Emergency Note':
        return s.nursingNotesTypeEmergencyNote;
      case 'Other':
        return s.nursingNotesTypeOther;
      default:
        return code;
    }
  }

  String _priorityLabel(AppStrings s, String code) {
    switch (code) {
      case 'low':
        return s.priorityLow;
      case 'normal':
        return s.priorityNormal;
      case 'high':
        return s.priorityHigh;
      case 'urgent':
        return s.priorityUrgent;
      default:
        return code.toUpperCase();
    }
  }

  static const _priorities = ['low', 'normal', 'high', 'urgent'];

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _autosave?.dispose();
    _phoneCtrl.dispose();
    _noteCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _submitting = true);
    try {
      final body = {
        if ((widget.prefillPatientUid ?? '').isNotEmpty)
          'patient_uid': widget.prefillPatientUid,
        'phone': _phoneCtrl.text.trim(),
        'note_type': _noteType!,
        // Structured content (the backend normalizeNotePayload reads free_text);
        // mirrors the draft's content shape. Stored note is unchanged.
        'content': {'free_text': _noteCtrl.text.trim()},
        'priority': _priority,
      };

      if (!widget.isOnline()) {
        final s = AppStrings.of(context);
        await showOfflineClinicalFallbackDialog(
          context,
          paperFormSet: s.offlineClinicalFallbackNursingNoteForms,
        );
        return;
      }

      await widget.createNote(body);
      if (mounted) {
        SuccessToast.show(
          context,
          AppStrings.of(context).nursingNotesSavedSuccess,
        );
      }

      // The note is committed — drop the draft scratchpad. Keep the autosave
      // bound for the next note; the form reset below runs under the
      // _restoringDraft guard so clearing the fields doesn't immediately
      // re-save an empty draft. Best-effort.
      await _autosave?.clear();

      if (mounted) {
        _restoringDraft = true;
        _formKey.currentState!.reset();
        _noteCtrl.clear();
        _restoringDraft = false;
        setState(() {
          _noteType = null;
          _priority = 'normal';
        });
      }
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, e.toString());
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header banner
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFF00695C).withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: const Color(0xFF00695C).withValues(alpha: 0.3),
              ),
            ),
            child: Row(
              children: [
                const Icon(
                  Icons.info_outline,
                  color: Color(0xFF00695C),
                  size: 18,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    s.nursingNotesBackendComingSoon,
                    style: const TextStyle(
                      color: Color(0xFF00695C),
                      fontSize: 12,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          Form(
            key: _formKey,
            child: Column(
              children: [
                // Patient phone
                TextFormField(
                  controller: _phoneCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: InputDecoration(
                    labelText: s.nursingNotesPatientPhoneLabel,
                    hintText: s.nursingNotesPatientPhoneHint,
                    prefixIcon: const ExcludeSemantics(
                      child: Icon(Icons.phone_outlined),
                    ),
                  ),
                  validator: (v) {
                    if (v == null || v.trim().isEmpty) {
                      return s.nursingNotesPhoneRequired;
                    }
                    if (v.trim().length < 10) {
                      return s.nursingNotesPhoneInvalid;
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 14),

                // Note type
                DropdownButtonFormField<String>(
                  initialValue: _noteType,
                  decoration: InputDecoration(
                    labelText: s.nursingNotesTypeLabel,
                    prefixIcon: const ExcludeSemantics(
                      child: Icon(Icons.category_outlined),
                    ),
                  ),
                  items: _noteTypeCodes
                      .map(
                        (t) => DropdownMenuItem(
                          value: t,
                          child: Text(_noteTypeLabel(s, t)),
                        ),
                      )
                      .toList(),
                  onChanged: (v) {
                    setState(() => _noteType = v);
                    // The picked category is part of the same draft — autosave
                    // it (the snapshot reads _noteType as note_category).
                    _autosave?.onContentChanged();
                  },
                  validator: (v) =>
                      v == null ? s.nursingNotesTypeRequired : null,
                ),
                const SizedBox(height: 14),

                // Priority
                Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    s.nursingNotesPriorityLabel,
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 13,
                    ),
                  ),
                ),
                const SizedBox(height: 6),
                Row(
                  children: _priorities.map((p) {
                    final selected = _priority == p;
                    final color = switch (p) {
                      'low' => AppTheme.successGreen,
                      'normal' => AppTheme.primaryBlue,
                      'high' => AppTheme.warningAmber,
                      'urgent' => AppTheme.errorRed,
                      _ => AppTheme.textSecondary,
                    };
                    return Expanded(
                      child: Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: GestureDetector(
                          onTap: () => setState(() => _priority = p),
                          child: AnimatedContainer(
                            duration: const Duration(milliseconds: 150),
                            padding: const EdgeInsets.symmetric(vertical: 8),
                            decoration: BoxDecoration(
                              color: selected
                                  ? color
                                  : color.withValues(alpha: 0.08),
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(
                                color: color.withValues(alpha: 0.4),
                              ),
                            ),
                            child: Text(
                              _priorityLabel(s, p),
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.bold,
                                color: selected ? Colors.white : color,
                              ),
                            ),
                          ),
                        ),
                      ),
                    );
                  }).toList(),
                ),
                const SizedBox(height: 14),

                // Note text
                TextFormField(
                  controller: _noteCtrl,
                  decoration: InputDecoration(
                    labelText: s.nursingNotesClinicalNoteLabel,
                    hintText: s.nursingNotesClinicalNoteHint,
                    prefixIcon: const ExcludeSemantics(
                      child: Icon(Icons.edit_note_outlined),
                    ),
                    // Voice dictation — appends transcript to the note.
                    suffixIcon: VoiceDictateButton(controller: _noteCtrl),
                    alignLabelWithHint: true,
                  ),
                  maxLines: 6,
                  validator: (v) {
                    if (v == null || v.trim().isEmpty) {
                      return s.nursingNotesNoteRequired;
                    }
                    if (v.trim().length < 10) {
                      return s.nursingNotesNoteTooShort;
                    }
                    return null;
                  },
                ),
                if (_autosave != null) ...[
                  const SizedBox(height: 10),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: NoteDraftStatusIndicator(status: _autosave!.status),
                  ),
                ],
                const SizedBox(height: 24),

                ElevatedButton.icon(
                  onPressed: _submitting ? null : _submit,
                  icon: _submitting
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            color: Colors.white,
                            strokeWidth: 2,
                          ),
                        )
                      : const Icon(Icons.save, color: Colors.white),
                  label: Text(
                    _submitting
                        ? s.bedSheetSavingLabel
                        : s.nursingNotesSaveButton,
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF00695C),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Placeholder shown in the All-Notes tab when the screen was opened
/// without a patient context (e.g. bottom nav -> Nursing notes directly,
/// not via the bed board's per-patient quick action).
class _NoPatientContext extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 40),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.person_search, size: 56, color: AppTheme.textSecondary),
            const SizedBox(height: 12),
            AppText(
              's4.lib.nursing_notes.open_this_screen_from_the_bed_board_to_see_all_n',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}

@visibleForTesting
List<Map<String, dynamic>> recentNursingNotesFromResponse(
  Map<String, dynamic> response,
) {
  final data = response['data'];
  final candidates = <dynamic>[
    response['notes'],
    response['items'],
    data,
    if (data is Map) data['notes'],
    if (data is Map) data['items'],
  ];
  for (final candidate in candidates) {
    if (candidate is List) {
      return candidate
          .whereType<Map>()
          .map((row) => row.cast<String, dynamic>())
          .toList(growable: false);
    }
  }
  return const [];
}

@visibleForTesting
bool recentNursingNotesHasNextPage(Map<String, dynamic> response) {
  final data = response['data'];
  final meta = _mapFromAny(response['meta']);
  final pagination = _mapFromAny(response['pagination'] ?? meta?['pagination']);
  final nestedPagination = data is Map ? _mapFromAny(data['pagination']) : null;
  final page = nestedPagination ?? pagination;
  if (page == null) return false;
  final explicit = page['hasNext'] ?? page['has_next'] ?? page['has_more'];
  if (explicit is bool) return explicit;
  final currentPage = _intFrom(page['page']);
  final totalPages = _intFrom(page['totalPages'] ?? page['pages']);
  if (currentPage != null && totalPages != null) {
    return currentPage < totalPages;
  }
  final total = _intFrom(page['total']);
  final limit = _intFrom(page['limit']);
  if (currentPage != null && total != null && limit != null && limit > 0) {
    return currentPage * limit < total;
  }
  return false;
}

class RecentNursingNotesTab extends StatefulWidget {
  final String? patientUid;
  final String? patientName;
  final RecentNursingNotesLoader loadNotes;
  final int pageSize;

  const RecentNursingNotesTab({
    super.key,
    required this.patientUid,
    this.patientName,
    this.loadNotes = defaultRecentNursingNotesLoader,
    this.pageSize = 10,
  });

  @override
  State<RecentNursingNotesTab> createState() => _RecentNursingNotesTabState();
}

class _RecentNursingNotesTabState extends State<RecentNursingNotesTab> {
  static const _noteType = 'nursing_assessment';

  bool _loading = false;
  bool _loadingMore = false;
  String? _error;
  int _page = 1;
  bool _hasNext = false;
  List<Map<String, dynamic>> _notes = const [];

  String get _patientUid => widget.patientUid?.trim() ?? '';

  @override
  void initState() {
    super.initState();
    if (_patientUid.isNotEmpty) {
      Future<void>.microtask(_loadFirstPage);
    }
  }

  @override
  void didUpdateWidget(covariant RecentNursingNotesTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.patientUid != widget.patientUid && _patientUid.isNotEmpty) {
      _loadFirstPage();
    }
  }

  Future<void> _loadFirstPage() async => _loadPage(1, reset: true);

  Future<void> _loadNextPage() async {
    if (!_hasNext || _loadingMore || _loading) return;
    await _loadPage(_page + 1);
  }

  Future<void> _loadPage(int page, {bool reset = false}) async {
    final uid = _patientUid;
    if (uid.isEmpty) return;
    setState(() {
      if (reset) {
        _loading = true;
        _notes = const [];
      } else {
        _loadingMore = true;
      }
      _error = null;
    });
    try {
      final response = await widget.loadNotes(
        uid,
        noteType: _noteType,
        page: page,
        limit: widget.pageSize,
      );
      final notes = recentNursingNotesFromResponse(response);
      notes.sort((a, b) {
        final left = _dateTime(a['created_at']) ?? DateTime(1970);
        final right = _dateTime(b['created_at']) ?? DateTime(1970);
        return right.compareTo(left);
      });
      if (!mounted) return;
      setState(() {
        _page = page;
        _notes = reset ? notes : [..._notes, ...notes];
        _hasNext = recentNursingNotesHasNextPage(response);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = localizedApiErrorFromRaw(AppStrings.of(context), e);
      });
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
          _loadingMore = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (_patientUid.isEmpty) return _NoPatientContext();

    return DataStateBuilder<Map<String, dynamic>>(
      isLoading: _loading,
      error: _error,
      data: _notes,
      onRetry: _loadFirstPage,
      emptyIcon: Icons.edit_note_outlined,
      emptyTitle: s.nursingNotesTabRecent,
      emptySubtitle: s.nursingNotesRecentEmpty,
      builder: (context, notes) {
        return RefreshIndicator(
          onRefresh: _loadFirstPage,
          child: ListView.separated(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 20),
            itemCount: notes.length + (_hasNext ? 1 : 0),
            separatorBuilder: (_, _) => const SizedBox(height: 8),
            itemBuilder: (context, index) {
              if (index >= notes.length) {
                return Center(
                  child: OutlinedButton.icon(
                    onPressed: _loadingMore ? null : _loadNextPage,
                    icon: _loadingMore
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.expand_more),
                    label: Text(
                      _loadingMore
                          ? AppStrings.of(context).labelLoading
                          : AppStrings.of(context)
                                .lookup('s4.lib.nursing_notes.load_more'),
                    ),
                  ),
                );
              }
              return _RecentNursingNoteCard(note: notes[index]);
            },
          ),
        );
      },
    );
  }
}

class _RecentNursingNoteCard extends StatelessWidget {
  final Map<String, dynamic> note;

  const _RecentNursingNoteCard({required this.note});

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final type = _text(note['note_type'], fallback: 'nursing_assessment');
    final content = note['content'];
    final body = _noteBody(content);
    final category = content is Map
        ? _text(
            content['note_category'],
            fallback: _displayNoteType(strings, type),
          )
        : _displayNoteType(strings, type);
    final author = _firstText([
      note['author_name'],
      note['created_by_name'],
      note['author'] is Map ? (note['author'] as Map)['name'] : null,
    ]);
    final createdAt = _dateTime(note['created_at']);
    final signed = note['is_signed'] == true;

    return Card(
      elevation: 0,
      color: AppTheme.cardSurface,
      shape: RoundedRectangleBorder(
        side: BorderSide(color: AppTheme.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                _RecentNoteBadge(
                  label: category,
                  color: const Color(0xFF00695C),
                ),
                if (signed) ...[
                  const SizedBox(width: 6),
                  _RecentNoteBadge(
                    label: AppStrings.of(context)
                        .lookup('s4.lib.nursing_notes.signed'),
                    color: AppTheme.successOnSurface,
                  ),
                ],
                const Spacer(),
                Text(
                  _formatDateTime(createdAt),
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 11),
                ),
              ],
            ),
            if (author.isNotEmpty) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  Icon(
                    Icons.person_outline,
                    size: 14,
                    color: AppTheme.textSecondary,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    author,
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 8),
            Text(
              body.isEmpty ? '-' : body,
              style: TextStyle(color: AppTheme.textPrimary),
            ),
          ],
        ),
      ),
    );
  }

  String _noteBody(dynamic content) {
    if (content is Map) {
      return _firstText([
        content['free_text'],
        content['body'],
        content['note'],
        content['summary'],
        content['text'],
      ]);
    }
    return _text(content);
  }
}

class _RecentNoteBadge extends StatelessWidget {
  final String label;
  final Color color;

  const _RecentNoteBadge({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: color.withValues(alpha: 0.36)),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

Map<String, dynamic>? _mapFromAny(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return null;
}

int? _intFrom(dynamic value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '');
}

DateTime? _dateTime(dynamic value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString())?.toLocal();
}

String _formatDateTime(DateTime? value) {
  if (value == null) return '-';
  final year = value.year.toString().padLeft(4, '0');
  final month = value.month.toString().padLeft(2, '0');
  final day = value.day.toString().padLeft(2, '0');
  final hour = value.hour.toString().padLeft(2, '0');
  final minute = value.minute.toString().padLeft(2, '0');
  return '$year-$month-$day $hour:$minute';
}

String _displayNoteType(AppStrings strings, String type) {
  final normalized = type.trim().toLowerCase().replaceAll('_', ' ');
  if (normalized.isEmpty || normalized == 'nursing assessment') {
    return strings.lookup('s4.lib.nursing_notes.nursing_note');
  }
  return normalized.replaceFirstMapped(
    RegExp(r'^.'),
    (match) => match[0]!.toUpperCase(),
  );
}

String _firstText(Iterable<dynamic> values) {
  for (final value in values) {
    final text = _text(value);
    if (text.isNotEmpty && text.toLowerCase() != 'null') return text;
  }
  return '';
}

String _text(dynamic value, {String fallback = ''}) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? fallback : text;
}
