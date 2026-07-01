import 'package:flutter/material.dart';
import '../../../core/services/connectivity_sync_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/patient_context_chip.dart';
import '../../../core/widgets/patient_notes_list.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/success_toast.dart';
import '../../../core/widgets/voice_dictate_button.dart';
import '../../../l10n/app_strings.dart';
import '../../emr/note_draft_autosave.dart';
import '../../emr/widgets/note_draft_status_indicator.dart';

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
  const NursingNotesScreen({
    super.key,
    this.prefillPatientUid,
    this.prefillPatientName,
    this.prefillPatientPhone,
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
                const Tab(text: 'All Notes'),
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
                ),
                const _RecentNotesTab(),
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
  const _AddNoteTab({this.prefillPatientUid, this.prefillPhone});

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
    final when = updatedAt != null
        ? TimeOfDay.fromDateTime(updatedAt.toLocal()).format(context)
        : null;
    messenger.clearSnackBars();
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          when != null
              ? 'Restored unsaved draft from $when'
              : 'Restored unsaved draft',
        ),
        backgroundColor: const Color(0xFF00695C),
        duration: const Duration(seconds: 6),
        action: SnackBarAction(
          label: 'Discard draft',
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
        content: Text('Draft discarded'),
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

      if (!ConnectivitySyncService.instance.isOnline) {
        await ConnectivitySyncService.instance.enqueue(
          endpoint: '/emr/notes',
          method: 'POST',
          body: body,
          contextLabel: 'Nursing note for ${_phoneCtrl.text.trim()}',
        );
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(AppStrings.of(context).nursingNotesOfflineQueued),
              backgroundColor: AppTheme.warningAmber,
            ),
          );
        }
      } else {
        await MedicalApiService.createClinicalNote(body);
        if (mounted) {
          SuccessToast.show(
            context,
            AppStrings.of(context).nursingNotesSavedSuccess,
          );
        }
      }

      // The note is committed (or queued for commit) — drop the draft
      // scratchpad. Keep the autosave bound for the next note; the form reset
      // below runs under the _restoringDraft guard so clearing the fields
      // doesn't immediately re-save an empty draft. Best-effort.
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
        ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
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
            Text(
              'Open this screen from the bed board to see all notes for a patient.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}

class _RecentNotesTab extends StatelessWidget {
  const _RecentNotesTab();

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    // TODO: Fetch recent notes from backend when API is available
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.edit_note, size: 56, color: AppTheme.textSecondary),
          const SizedBox(height: 16),
          Text(
            s.nursingNotesTabRecent,
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.bold,
              color: AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 40),
            child: Text(
              s.nursingNotesRecentEmpty,
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}
