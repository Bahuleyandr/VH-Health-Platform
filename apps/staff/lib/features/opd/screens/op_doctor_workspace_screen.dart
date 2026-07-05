import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/services/recent_patients_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/coded_diagnosis_picker.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../core/widgets/states/success_toast.dart';
import '../../emr/note_draft_autosave.dart';
import '../../emr/widgets/note_draft_status_indicator.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

class OpDoctorWorkspaceScreen extends StatefulWidget {
  final String patientUid;
  final String? patientName;
  final int? appointmentId;
  final int? patientId;
  final String? patientPhone;
  final int? doctorId;
  final String? doctorName;
  final String? department;
  final String? reason;
  final String? appointmentDate;
  final String? appointmentTime;
  final String? status;

  const OpDoctorWorkspaceScreen({
    super.key,
    required this.patientUid,
    this.patientName,
    this.appointmentId,
    this.patientId,
    this.patientPhone,
    this.doctorId,
    this.doctorName,
    this.department,
    this.reason,
    this.appointmentDate,
    this.appointmentTime,
    this.status,
  });

  @override
  State<OpDoctorWorkspaceScreen> createState() =>
      _OpDoctorWorkspaceScreenState();
}

class _OpDoctorWorkspaceScreenState extends State<OpDoctorWorkspaceScreen>
    with WidgetsBindingObserver {
  List<Map<String, dynamic>> _events = const [];
  bool _loading = true;
  bool _completing = false;
  bool _savingNote = false;
  String? _error;
  late String _status;
  int? _opNoteId;
  bool _opNoteSigned = false;
  bool _hasAppointmentPrescription = false;
  Map<String, dynamic>? _diagnosisCoding;

  final _chiefCtrl = TextEditingController();
  final _historyCtrl = TextEditingController();
  final _examCtrl = TextEditingController();
  final _diagnosisCtrl = TextEditingController();
  final _planCtrl = TextEditingController();

  // Autosave the in-progress consultation note to the server-side draft
  // scratchpad (no canonical timeline/audit events). Finalize (Save/Sign)
  // commits the real note via the unchanged flow and clears the draft.
  late final NoteDraftAutosave _autosave;
  bool _draftRestoreChecked = false;
  // Suppresses the field listener while we programmatically empty the composer
  // on "Discard draft", so wiping the fields doesn't immediately re-PUT a blank
  // draft (autosave's skip-empty is bypassed once a draft has been saved).
  bool _discardingDraft = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _status = _clean(widget.status).isEmpty
        ? 'CONFIRMED'
        : _clean(widget.status).toUpperCase();
    _autosave = NoteDraftAutosave(
      patientUid: widget.patientUid,
      appointmentId: widget.appointmentId,
      noteType: 'op_consultation',
      snapshot: _currentOpContent,
    );
    for (final ctrl in [
      _chiefCtrl,
      _historyCtrl,
      _examCtrl,
      _diagnosisCtrl,
      _planCtrl,
    ]) {
      ctrl.addListener(_onNoteFieldChanged);
    }
    _loadTimeline();
    RecentPatientsService.add(widget.patientUid, widget.patientName);
  }

  void _onNoteFieldChanged() {
    // Don't autosave a signed/closed note or before the restore check has run
    // (restore itself populates the controllers, which would otherwise fire
    // this listener and immediately re-PUT the just-restored content).
    if (!_draftRestoreChecked ||
        _discardingDraft ||
        _opNoteSigned ||
        _opSessionClosed) {
      return;
    }
    _autosave.onContentChanged();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    super.didChangeAppLifecycleState(state);
    // Data-loss guard: when the app is backgrounded/closed, force-save the
    // pending debounced delta so the last <3s of typing isn't lost. flush() is
    // idempotent, offline-safe, and no-ops when not dirty / disposed / on a
    // non-workbench device, so firing it on transient `inactive` is cheap.
    // Deliberately NOT flushed in dispose(): flush() defers an async _save()
    // that reads the text controllers, which dispose() tears down synchronously
    // — a deferred save would then read disposed controllers.
    if (state == AppLifecycleState.inactive ||
        state == AppLifecycleState.paused) {
      _autosave.flush();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _autosave.dispose();
    _chiefCtrl.dispose();
    _historyCtrl.dispose();
    _examCtrl.dispose();
    _diagnosisCtrl.dispose();
    _planCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadTimeline() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await MedicalApiService.getPatientTimeline(
        widget.patientUid,
      );
      final notesData = await MedicalApiService.getPatientNotes(
        widget.patientUid,
        noteType: 'op_consultation',
      ).catchError((_) => <String, dynamic>{});
      final list = data['events'] ?? data['timeline'];
      final events = list is List
          ? list
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .toList()
          : <Map<String, dynamic>>[];
      final rawDataList = data['data'];
      if (rawDataList is List) {
        events.addAll(
          rawDataList.whereType<Map>().map(
            (item) => Map<String, dynamic>.from(item),
          ),
        );
      }
      _hydrateLatestOpNote(notesData);
      _mergeClinicalNotesIntoTimeline(events, notesData);
      await _mergeAppointmentPrescriptionIntoTimeline(events);
      if (!mounted) return;
      setState(() {
        _events = _dedupeAndSortEvents(events);
        _loading = false;
      });
      await _maybeRestoreDraft();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  /// After the timeline + any committed OP note have loaded, restore an
  /// unsaved autosave draft into the empty composer. Runs once. Per the spec's
  /// stale-draft rule, a committed note wins: if `_hydrateLatestOpNote` already
  /// populated a saved note (`_opNoteId != null`) we skip restore. Enables
  /// autosave afterwards via `_draftRestoreChecked`.
  Future<void> _maybeRestoreDraft() async {
    if (_draftRestoreChecked) return;
    if (_opNoteId != null || _opNoteSigned || _opSessionClosed) {
      _draftRestoreChecked = true;
      return;
    }
    final draft = await _autosave.restore();
    if (!mounted) {
      _draftRestoreChecked = true;
      return;
    }
    if (draft != null) {
      final content = (draft['content'] as Map?)?.cast<String, dynamic>() ?? {};
      final hasText = [
        'chief_complaint',
        'history',
        'examination',
        'diagnosis',
        'plan',
      ].any((k) => _clean(content[k]).isNotEmpty);
      if (hasText) {
        _chiefCtrl.text = _firstContentText(content, const [
          'chief_complaint',
          'chief_complaints',
          'subjective',
        ]);
        _historyCtrl.text = _firstContentText(content, const ['history']);
        _examCtrl.text = _firstContentText(content, const [
          'examination',
          'objective',
        ]);
        _diagnosisCtrl.text = _firstContentText(content, const [
          'diagnosis',
          'assessment',
        ]);
        _diagnosisCoding = _firstCoding(
          content['diagnosis_codings'] ?? content['codings'],
        );
        _planCtrl.text = _firstContentText(content, const ['plan']);
        final updatedAt = draft['updatedAt'] as DateTime?;
        if (mounted) setState(() {});
        _showDraftRestoredBanner(updatedAt);
      }
    }
    _draftRestoreChecked = true;
  }

  void _showDraftRestoredBanner(DateTime? updatedAt) {
    if (!mounted) return;
    final when = updatedAt != null
        ? DateFormat('h:mm a').format(updatedAt.toLocal())
        : null;
    final messenger = ScaffoldMessenger.of(context);
    messenger.clearSnackBars();
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          when != null
              ? 'Restored unsaved draft from $when'
              : 'Restored unsaved draft',
        ),
        backgroundColor: AppTheme.primaryBlue,
        duration: const Duration(seconds: 6),
        action: SnackBarAction(
          label: 'Discard draft',
          textColor: Colors.white,
          onPressed: _discardRestoredDraft,
        ),
      ),
    );
  }

  /// Discard a restored draft the author doesn't want: delete the server-side
  /// draft + reset autosave state (`clear()`), and wipe the restored content
  /// out of the composer fields so the UI reflects the discard.
  void _discardRestoredDraft() {
    final messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentSnackBar();
    // Delete the server draft + reset autosave (best-effort; never throws).
    _autosave.clear();
    // Wipe the restored content from the composer under the suppression guard
    // so emptying the fields doesn't fire the listener and re-PUT a blank draft
    // (autosave's skip-empty is bypassed once a draft has already been saved).
    _discardingDraft = true;
    _chiefCtrl.clear();
    _historyCtrl.clear();
    _examCtrl.clear();
    _diagnosisCtrl.clear();
    _planCtrl.clear();
    _discardingDraft = false;
    if (!mounted) return;
    setState(() => _diagnosisCoding = null);
    messenger.showSnackBar(
      const SnackBar(
        content: AppText('s4.lib.nursing_notes.draft_discarded'),
        duration: Duration(seconds: 3),
      ),
    );
  }

  void _mergeClinicalNotesIntoTimeline(
    List<Map<String, dynamic>> events,
    Map<String, dynamic> notesData,
  ) {
    final raw = notesData['notes'] ?? notesData['data'] ?? notesData['items'];
    if (raw is! List) return;
    for (final item in raw.whereType<Map>()) {
      final note = Map<String, dynamic>.from(item);
      final content = _contentMap(note);
      events.add({
        'event_type': 'clinical_note',
        'sub_type': _clean(note['note_type']).isEmpty
            ? 'op_consultation'
            : _clean(note['note_type']),
        'id': note['id'],
        'appointment_id':
            _asInt(note['appointment_id']) ?? _asInt(content['appointment_id']),
        'title': _clean(note['title']).isEmpty
            ? 'OP consultation note'
            : _clean(note['title']),
        'summary': _clean(content['summary']).isNotEmpty
            ? _clean(content['summary'])
            : _joinNonEmpty([
                if (_clean(content['chief_complaint']).isNotEmpty)
                  'CC: ${_clean(content['chief_complaint'])}',
                if (_clean(content['diagnosis']).isNotEmpty)
                  'Dx: ${_clean(content['diagnosis'])}',
                if (_clean(content['plan']).isNotEmpty)
                  'Plan: ${_clean(content['plan'])}',
              ]),
        'timestamp': _clean(note['updated_at']).isNotEmpty
            ? _clean(note['updated_at'])
            : _clean(note['created_at']),
        'payload': note,
      });
    }
  }

  Future<void> _mergeAppointmentPrescriptionIntoTimeline(
    List<Map<String, dynamic>> events,
  ) async {
    final appointmentId = widget.appointmentId;
    if (appointmentId == null) {
      _hasAppointmentPrescription = false;
      return;
    }
    try {
      final rx = await MedicalApiService.getEPrescriptionByAppointment(
        appointmentId,
      );
      _hasAppointmentPrescription = true;
      events.add({
        'event_type': 'prescription',
        'sub_type': _clean(rx['lifecycle_status']).isNotEmpty
            ? _clean(rx['lifecycle_status'])
            : _clean(rx['status']),
        'id': rx['id'],
        'appointment_id': _asInt(rx['appointment_id']) ?? appointmentId,
        'title': _clean(rx['prescription_number']).isNotEmpty
            ? 'Prescription ${_clean(rx['prescription_number'])}'
            : 'OP prescription',
        'summary': _clean(rx['diagnosis']).isNotEmpty
            ? _clean(rx['diagnosis'])
            : 'Prescription entered for this OP visit',
        'timestamp': _clean(rx['updated_at']).isNotEmpty
            ? _clean(rx['updated_at'])
            : _clean(rx['created_at']),
        'payload': rx,
      });
    } catch (_) {
      _hasAppointmentPrescription = false;
    }
  }

  List<Map<String, dynamic>> _dedupeAndSortEvents(
    List<Map<String, dynamic>> events,
  ) {
    final byKey = <String, Map<String, dynamic>>{};
    for (final event in events) {
      final type = _clean(event['event_type']).toLowerCase();
      final id = _clean(event['id']);
      final timestamp = _clean(event['timestamp']);
      final key = id.isNotEmpty ? '$type:$id' : '$type:$timestamp';
      byKey[key] = event;
    }
    final list = byKey.values.toList();
    list.sort((a, b) {
      final aTime = DateTime.tryParse(_clean(a['timestamp']));
      final bTime = DateTime.tryParse(_clean(b['timestamp']));
      if (aTime == null && bTime == null) return 0;
      if (aTime == null) return 1;
      if (bTime == null) return -1;
      return bTime.compareTo(aTime);
    });
    return list;
  }

  void _hydrateLatestOpNote(Map<String, dynamic> notesData) {
    final raw = notesData['notes'] ?? notesData['data'] ?? notesData['items'];
    if (raw is! List) {
      if (_chiefCtrl.text.trim().isEmpty && _clean(widget.reason).isNotEmpty) {
        _chiefCtrl.text = _clean(widget.reason);
      }
      return;
    }
    final notes = raw
        .whereType<Map>()
        .map((note) => Map<String, dynamic>.from(note))
        .toList();
    if (notes.isEmpty) {
      if (_chiefCtrl.text.trim().isEmpty && _clean(widget.reason).isNotEmpty) {
        _chiefCtrl.text = _clean(widget.reason);
      }
      return;
    }
    Map<String, dynamic>? selected;
    if (widget.appointmentId != null) {
      for (final note in notes) {
        final content = _contentMap(note);
        final noteAppointmentId =
            _asInt(note['appointment_id']) ?? _asInt(content['appointment_id']);
        if (noteAppointmentId == widget.appointmentId) {
          selected = note;
          break;
        }
      }
      if (selected == null) {
        if (_chiefCtrl.text.trim().isEmpty &&
            _clean(widget.reason).isNotEmpty) {
          _chiefCtrl.text = _clean(widget.reason);
        }
        return;
      }
    } else {
      selected = notes.first;
    }
    final content = _contentMap(selected);
    _opNoteId = _asInt(selected['id']);
    _opNoteSigned = selected['is_signed'] == true;
    _chiefCtrl.text = _firstContentText(content, const [
      'chief_complaint',
      'chief_complaints',
      'subjective',
    ]);
    _historyCtrl.text = _firstContentText(content, const ['history']);
    _examCtrl.text = _firstContentText(content, const [
      'examination',
      'objective',
    ]);
    _diagnosisCtrl.text = _firstContentText(content, const [
      'diagnosis',
      'assessment',
    ]);
    _diagnosisCoding = _firstCoding(
      content['diagnosis_codings'] ?? content['codings'],
    );
    _planCtrl.text = _firstContentText(content, const ['plan']);
  }

  String get _patientTitle {
    final name = _clean(widget.patientName);
    return name.isEmpty ? 'Patient' : name;
  }

  String get _patientQuery {
    final params = <String>[
      if (_clean(widget.patientName).isNotEmpty)
        'name=${Uri.encodeQueryComponent(_clean(widget.patientName))}',
      if (widget.patientId != null) 'patient_id=${widget.patientId}',
      if (_clean(widget.patientPhone).isNotEmpty)
        'phone=${Uri.encodeQueryComponent(_clean(widget.patientPhone))}',
      if (widget.appointmentId != null)
        'appointment_id=${widget.appointmentId}',
      if (widget.doctorId != null) 'doctor_id=${widget.doctorId}',
      if (_clean(widget.doctorName).isNotEmpty)
        'doctor_name=${Uri.encodeQueryComponent(_clean(widget.doctorName))}',
      if (_clean(widget.department).isNotEmpty)
        'department=${Uri.encodeQueryComponent(_clean(widget.department))}',
      if (_clean(widget.reason).isNotEmpty)
        'reason=${Uri.encodeQueryComponent(_clean(widget.reason))}',
      if (_clean(widget.appointmentDate).isNotEmpty)
        'appointment_date=${Uri.encodeQueryComponent(_clean(widget.appointmentDate))}',
      if (_clean(widget.appointmentTime).isNotEmpty)
        'appointment_time=${Uri.encodeQueryComponent(_clean(widget.appointmentTime))}',
      if (_clean(_status).isNotEmpty)
        'status=${Uri.encodeQueryComponent(_status)}',
      'context=op',
    ];
    return params.isEmpty ? '' : '?${params.join('&')}';
  }

  String get _timelineRoute =>
      '/emr/timeline/${widget.patientUid}$_patientQuery';

  String get _investigationsRoute {
    final params = <String>[
      'patient_uid=${Uri.encodeQueryComponent(widget.patientUid)}',
      if (widget.appointmentId != null)
        'appointment_id=${widget.appointmentId}',
      if (widget.patientId != null) 'patient_id=${widget.patientId}',
      if (_clean(widget.patientPhone).isNotEmpty)
        'phone=${Uri.encodeQueryComponent(_clean(widget.patientPhone))}',
      if (_clean(widget.patientName).isNotEmpty)
        'name=${Uri.encodeQueryComponent(_clean(widget.patientName))}',
      if (widget.doctorId != null) 'doctor_id=${widget.doctorId}',
      if (_clean(widget.doctorName).isNotEmpty)
        'doctor_name=${Uri.encodeQueryComponent(_clean(widget.doctorName))}',
      if (_clean(widget.department).isNotEmpty)
        'department=${Uri.encodeQueryComponent(_clean(widget.department))}',
      if (_clean(widget.appointmentDate).isNotEmpty)
        'appointment_date=${Uri.encodeQueryComponent(_clean(widget.appointmentDate))}',
      if (_clean(widget.appointmentTime).isNotEmpty)
        'appointment_time=${Uri.encodeQueryComponent(_clean(widget.appointmentTime))}',
      'context=op',
    ];
    return '/investigations?${params.join('&')}';
  }

  bool get _canComplete =>
      widget.appointmentId != null &&
      !_completing &&
      !_isTerminalStatus(_status);

  bool get _opSessionClosed {
    if (_isTerminalStatus(_status)) return true;
    final raw = _clean(widget.appointmentDate);
    if (raw.isEmpty) return false;
    final parsed = DateTime.tryParse(raw);
    if (parsed == null) return false;
    final local = parsed.toLocal();
    final now = DateTime.now();
    return local.year != now.year ||
        local.month != now.month ||
        local.day != now.day;
  }

  String get _opSessionClosedReason {
    if (_isTerminalStatus(_status)) {
      return 'This OP visit is ${_status.toLowerCase()}; create a new appointment for fresh documentation.';
    }
    return 'This OP visit is not dated today; create a new appointment for fresh documentation.';
  }

  String get _scheduledLabel {
    final parts = [
      _clean(widget.appointmentDate),
      _clean(widget.appointmentTime),
    ].where((part) => part.isNotEmpty).toList();
    return parts.isEmpty ? 'OP appointment' : parts.join(' at ');
  }

  Future<void> _completeAppointment() async {
    final id = widget.appointmentId;
    if (id == null || !_canComplete) return;
    setState(() => _completing = true);
    try {
      await ScheduleApiService.updateAppointmentStatus(
        id.toString(),
        'completed',
      );
      if (!mounted) return;
      setState(() {
        _status = 'COMPLETED';
        _completing = false;
      });
      SuccessToast.show(context, 'OP consultation marked complete');
    } catch (e) {
      if (!mounted) return;
      setState(() => _completing = false);
      ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _openPrescription() async {
    final content = _currentOpContent();
    await context.push(
      '/prescriptions',
      extra: {
        if (widget.appointmentId != null) 'id': widget.appointmentId,
        if (widget.patientId != null) 'patient_id': widget.patientId,
        if (widget.doctorId != null) 'doctor_id': widget.doctorId,
        'patient_uid': widget.patientUid,
        'patient_name': _patientTitle,
        if (_clean(widget.doctorName).isNotEmpty)
          'doctor_name': _clean(widget.doctorName),
        if (_clean(widget.department).isNotEmpty)
          'department': _clean(widget.department),
        if (_clean(widget.reason).isNotEmpty) 'reason': _clean(widget.reason),
        if (_clean(widget.appointmentDate).isNotEmpty)
          'appointment_date': _clean(widget.appointmentDate),
        if (_clean(widget.appointmentTime).isNotEmpty)
          'appointment_time': _clean(widget.appointmentTime),
        'diagnosis': _clean(content['diagnosis']),
        'clinical_notes': _prescriptionClinicalNotes(content),
      },
    );
    if (mounted) _loadTimeline();
  }

  Map<String, dynamic> _currentOpContent() {
    final chief = _chiefCtrl.text.trim();
    final diagnosis = _diagnosisCtrl.text.trim();
    final plan = _planCtrl.text.trim();
    return {
      'chief_complaint': chief,
      'history': _historyCtrl.text.trim(),
      'examination': _examCtrl.text.trim(),
      'diagnosis': diagnosis,
      if (_diagnosisCoding != null) 'diagnosis_codings': [_diagnosisCoding],
      'plan': plan,
      'summary': _joinNonEmpty([
        if (chief.isNotEmpty) 'CC: $chief',
        if (diagnosis.isNotEmpty) 'Dx: $diagnosis',
        if (plan.isNotEmpty) 'Plan: $plan',
      ]),
      if (widget.appointmentId != null) 'appointment_id': widget.appointmentId,
    };
  }

  String _prescriptionClinicalNotes(Map<String, dynamic> content) {
    final parts = <String>[];
    void add(String label, Object? value) {
      final text = value?.toString().trim() ?? '';
      if (text.isNotEmpty && text.toLowerCase() != 'null') {
        parts.add('$label: $text');
      }
    }

    add('Chief complaints', content['chief_complaint']);
    add('History', content['history']);
    add('Examination', content['examination']);
    add('Diagnosis', content['diagnosis']);
    add('Plan', content['plan']);
    return parts.join('\n\n');
  }

  Future<void> _openInvestigationsAfterNote() async {
    await context.push(_investigationsRoute);
    if (mounted) _loadTimeline();
  }

  Future<void> _saveOpNote({
    bool openInvestigationsAfter = false,
    bool signAfter = false,
  }) async {
    if (_savingNote || _opNoteSigned) return;
    if (_opSessionClosed) {
      ErrorToast.show(context, _opSessionClosedReason);
      return;
    }
    final content = _currentOpContent();
    if (_clean(content['chief_complaint']).isEmpty &&
        _clean(content['diagnosis']).isEmpty &&
        _clean(content['plan']).isEmpty) {
      ErrorToast.show(
        context,
        'Enter at least a complaint, diagnosis, or plan',
      );
      return;
    }
    setState(() => _savingNote = true);
    try {
      if (_opNoteId != null) {
        await MedicalApiService.updateClinicalNote(_opNoteId!, content);
      } else {
        final created = await MedicalApiService.createClinicalNote({
          'patient_uid': widget.patientUid,
          'note_type': 'op_consultation',
          'title': 'OP consultation - $_patientTitle',
          'content': content,
          if (widget.appointmentId != null)
            'appointment_id': widget.appointmentId,
        });
        final createdNote = _asMap(
          created['note'] ?? created['data'] ?? created['result'],
        );
        _opNoteId = _asInt(
          created['id'] ??
              created['note_id'] ??
              created['clinical_note_id'] ??
              createdNote['id'] ??
              createdNote['note_id'] ??
              createdNote['clinical_note_id'],
        );
      }
      if (signAfter && _opNoteId != null) {
        await MedicalApiService.signNote(_opNoteId!);
        _opNoteSigned = true;
      }
      // The content is now committed to the canonical note — drop the draft
      // scratchpad and stop autosave for this context (best-effort).
      await _autosave.clear();
      if (!mounted) return;
      setState(() => _savingNote = false);
      SuccessToast.show(
        context,
        signAfter
            ? 'Consultation note signed'
            : (_opNoteId != null ? 'Consultation note saved' : 'Note saved'),
      );
      if (openInvestigationsAfter) {
        await _openInvestigationsAfterNote();
      }
      _loadTimeline();
    } catch (e) {
      if (!mounted) return;
      setState(() => _savingNote = false);
      ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
    }
  }

  void _openPatientRecords() {
    final query = <String>[
      if (widget.patientId != null) 'patient_id=${widget.patientId}',
      if (_clean(widget.patientPhone).isNotEmpty)
        'phone=${Uri.encodeQueryComponent(_clean(widget.patientPhone))}',
      if (_clean(widget.patientName).isNotEmpty)
        'name=${Uri.encodeQueryComponent(_clean(widget.patientName))}',
      'context=op',
    ].join('&');
    context.push('/patient-records?$query');
  }

  Widget _buildVisitHeader() {
    final reason = _clean(widget.reason);
    final department = _clean(widget.department);
    final doctor = _clean(widget.doctorName);
    final statusColor = _statusColor(_status);

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(
                color: AppTheme.primaryBlue.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(14),
              ),
              child: const Icon(
                Icons.medical_services_outlined,
                color: AppTheme.primaryBlue,
                size: 28,
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 10,
                    runSpacing: 8,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(
                        _patientTitle,
                        style: Theme.of(context).textTheme.headlineSmall
                            ?.copyWith(
                              color: AppTheme.textPrimary,
                              fontWeight: FontWeight.w900,
                            ),
                      ),
                      _StatusPill(label: _status, color: statusColor),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 12,
                    runSpacing: 6,
                    children: [
                      _MetaChip(Icons.event_outlined, _scheduledLabel),
                      if (department.isNotEmpty)
                        _MetaChip(Icons.business_outlined, department),
                      if (doctor.isNotEmpty)
                        _MetaChip(Icons.person_outline, doctor),
                    ],
                  ),
                  if (reason.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    Text(
                      reason,
                      style: TextStyle(
                        color: AppTheme.textSecondary,
                        fontSize: 14,
                        height: 1.35,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildConsultationNotePanel() {
    final noteFieldsEnabled = !_opNoteSigned && !_opSessionClosed;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: _SectionTitle(
                    icon: _opNoteSigned
                        ? Icons.lock_outline
                        : Icons.edit_note_outlined,
                    title: 'OP consultation note',
                    subtitle: _opNoteSigned
                        ? 'Signed and locked'
                        : (_opSessionClosed
                              ? _opSessionClosedReason
                              : 'Editable until this consultation is signed'),
                  ),
                ),
                if (_opNoteId != null)
                  _StatusPill(
                    label: _opNoteSigned ? 'SIGNED' : 'DRAFT',
                    color: _opNoteSigned
                        ? AppTheme.successOnSurface
                        : AppTheme.warningOnSurface,
                  ),
              ],
            ),
            const SizedBox(height: 14),
            _ClinicalTextField(
              controller: _chiefCtrl,
              label: 'Chief complaint',
              hint: 'Main complaint or visit reason',
              minLines: 2,
              enabled: noteFieldsEnabled,
            ),
            const SizedBox(height: 10),
            _ClinicalTextField(
              controller: _historyCtrl,
              label: 'History',
              hint: 'Relevant history, negatives, risk factors',
              minLines: 3,
              enabled: noteFieldsEnabled,
            ),
            const SizedBox(height: 10),
            _ClinicalTextField(
              controller: _examCtrl,
              label: 'Examination',
              hint: 'Vitals, examination findings, bedside observations',
              minLines: 3,
              enabled: noteFieldsEnabled,
            ),
            const SizedBox(height: 10),
            CodedDiagnosisPicker(
              controller: _diagnosisCtrl,
              label: 'Diagnosis',
              hint: 'Working diagnosis or differential',
              enabled: noteFieldsEnabled,
              minLines: 2,
              selectedCoding: _diagnosisCoding,
              onCodingChanged: (coding) {
                if (!mounted) return;
                setState(() => _diagnosisCoding = coding);
              },
            ),
            const SizedBox(height: 10),
            _ClinicalTextField(
              controller: _planCtrl,
              label: 'Plan',
              hint: 'Medicines, investigations, advice, follow-up',
              minLines: 3,
              enabled: noteFieldsEnabled,
            ),
            const SizedBox(height: 14),
            if (noteFieldsEnabled) ...[
              NoteDraftStatusIndicator(status: _autosave.status),
              const SizedBox(height: 10),
            ],
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                FilledButton.icon(
                  onPressed: _savingNote || !noteFieldsEnabled
                      ? null
                      : () => _saveOpNote(),
                  icon: _savingNote
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.save_outlined, size: 18),
                  label: const AppText('s4.lib.op_doctor_workspace.save_note'),
                ),
                OutlinedButton.icon(
                  onPressed: _savingNote || !noteFieldsEnabled
                      ? null
                      : () => _saveOpNote(openInvestigationsAfter: true),
                  icon: const Icon(Icons.biotech_outlined, size: 18),
                  label: const AppText(
                    's4.lib.op_doctor_workspace.save_then_investigations',
                  ),
                ),
                OutlinedButton.icon(
                  onPressed:
                      _savingNote ||
                          _opNoteSigned ||
                          _opSessionClosed ||
                          _opNoteId == null
                      ? null
                      : () => _saveOpNote(signAfter: true),
                  icon: const Icon(Icons.verified_outlined, size: 18),
                  label: const AppText('s4.lib.op_doctor_workspace.sign_note'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildClinicalActions() {
    final actions = [
      _WorkspaceAction(
        icon: Icons.note_add_outlined,
        label: 'Doctor notes',
        detail: 'Write OP consultation notes',
        onTap: () =>
            context.push('/emr/notes/${widget.patientUid}$_patientQuery'),
      ),
      _WorkspaceAction(
        icon: Icons.medication_outlined,
        label: 'Prescription',
        detail: 'Create e-prescription from this appointment',
        onTap: _openPrescription,
      ),
      _WorkspaceAction(
        icon: Icons.receipt_long_outlined,
        label: 'Orders',
        detail: 'Medication, nursing, or investigation orders',
        onTap: () =>
            context.push('/emr/orders/${widget.patientUid}$_patientQuery'),
      ),
      _WorkspaceAction(
        icon: Icons.biotech_outlined,
        label: 'Investigations',
        detail: 'Review or request investigations',
        onTap: () => context.push(_investigationsRoute),
      ),
      _WorkspaceAction(
        icon: Icons.folder_shared_outlined,
        label: 'Prior records',
        detail: 'Open patient records with this patient selected',
        onTap: _openPatientRecords,
      ),
      _WorkspaceAction(
        icon: Icons.timeline_outlined,
        label: 'Full timeline',
        detail: 'Notes, drug chart, orders, vitals and reports',
        onTap: () => context.push(_timelineRoute),
      ),
    ];

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const _SectionTitle(
              icon: Icons.medical_information_outlined,
              title: 'Consultation actions',
              subtitle: 'Use one patient context for OP documentation',
            ),
            const SizedBox(height: 12),
            ...actions.map(
              (action) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _ActionTile(action: action),
              ),
            ),
            const SizedBox(height: 4),
            FilledButton.icon(
              onPressed: _canComplete ? _completeAppointment : null,
              icon: _completing
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.check_circle_outline, size: 18),
              label: Text(
                _isTerminalStatus(_status)
                    ? 'Consultation ${_status.toLowerCase()}'
                    : 'Complete consultation',
              ),
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(44),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTimelineSummary() {
    final latest = _events.take(8).toList();
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Expanded(
                  child: _SectionTitle(
                    icon: Icons.history_outlined,
                    title: 'Clinical timeline',
                    subtitle:
                        'Recent notes, prescriptions, drug chart and reports',
                  ),
                ),
                TextButton.icon(
                  onPressed: () => context.push(_timelineRoute),
                  icon: const Icon(Icons.open_in_new, size: 16),
                  label: const AppText('s4.lib.op_doctor_workspace.open_full'),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (latest.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 28),
                child: Center(
                  child: AppText(
                    's4.lib.op_doctor_workspace.no_clinical_timeline_entries_yet',
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                ),
              )
            else
              ...latest.asMap().entries.map(
                (entry) => _TimelineSummaryItem(
                  event: entry.value,
                  isLast: entry.key == latest.length - 1,
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildCockpitSummaryPanel() {
    final latestPrescription = _latestEvent({'medication', 'prescription'});
    final latestInvestigation = _latestEvent({'investigation', 'lab_result'});
    final latestNote = _latestEvent({
      'note',
      'clinical_note',
      'doctor_note',
      'op_consultation',
      'consultation_note',
      'soap',
      'progress',
    });
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const _SectionTitle(
              icon: Icons.dashboard_customize_outlined,
              title: 'Consultation cockpit',
              subtitle: 'Records, prescription, investigation and follow-up',
            ),
            const SizedBox(height: 12),
            LayoutBuilder(
              builder: (context, constraints) {
                final columns = constraints.maxWidth >= 900 ? 4 : 2;
                return GridView.count(
                  crossAxisCount: columns,
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  mainAxisSpacing: 10,
                  crossAxisSpacing: 10,
                  childAspectRatio: columns == 4 ? 2.5 : 2.1,
                  children: [
                    _CockpitTile(
                      icon: Icons.medication_outlined,
                      title: 'Prescription',
                      value: _eventTitle(latestPrescription) ?? 'Create Rx',
                      action: 'Open',
                      onTap: _openPrescription,
                    ),
                    _CockpitTile(
                      icon: Icons.biotech_outlined,
                      title: 'Investigations',
                      value: _eventTitle(latestInvestigation) ?? 'Review/order',
                      action: 'Open',
                      onTap: () => context.push(_investigationsRoute),
                    ),
                    _CockpitTile(
                      icon: Icons.folder_shared_outlined,
                      title: 'Old records',
                      value: _eventTitle(latestNote) ?? 'Timeline ready',
                      action: 'Open',
                      onTap: _openPatientRecords,
                    ),
                    _CockpitTile(
                      icon: Icons.event_repeat_outlined,
                      title: 'Follow-up',
                      value: _isTerminalStatus(_status)
                          ? 'Visit complete'
                          : 'Set in Rx/plan',
                      action: _canComplete ? 'Complete' : 'Status',
                      onTap: _canComplete ? _completeAppointment : () {},
                    ),
                  ],
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildVisitChecklist() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const _SectionTitle(
              icon: Icons.fact_check_outlined,
              title: 'OP visit checklist',
              subtitle: 'Keeps the consultation from scattering across pages',
            ),
            const SizedBox(height: 12),
            _ChecklistRow(
              complete: _hasEventType({
                'note',
                'clinical_note',
                'doctor_note',
                'op_consultation',
                'consultation_note',
                'soap',
                'progress',
              }),
              label: 'Clinical note entered',
            ),
            _ChecklistRow(
              complete: _hasEventType({
                'order',
                'clinical_order',
                'investigation',
              }),
              label: 'Orders or investigations reviewed',
            ),
            _ChecklistRow(
              complete:
                  _hasAppointmentPrescription ||
                  _hasEventType({'medication', 'prescription'}),
              label: 'Prescription reviewed if needed',
            ),
            _ChecklistRow(
              complete: _isTerminalStatus(_status),
              label: 'Appointment completed',
            ),
          ],
        ),
      ),
    );
  }

  bool _hasEventType(Set<String> types) {
    return _events.any((event) {
      final type = _clean(event['event_type']).toLowerCase();
      return types.contains(type) && _eventBelongsToCurrentVisit(event);
    });
  }

  Map<String, dynamic>? _latestEvent(Set<String> types) {
    for (final event in _events) {
      final type = _clean(event['event_type']).toLowerCase();
      if (types.contains(type) && _eventBelongsToCurrentVisit(event)) {
        return event;
      }
    }
    return null;
  }

  bool _eventBelongsToCurrentVisit(Map<String, dynamic> event) {
    final appointmentId = widget.appointmentId;
    if (appointmentId == null) return true;

    final payload = _asMap(event['payload'] ?? event['data'] ?? event['meta']);
    final content = _asMap(payload['content']);
    final details = _asMap(payload['details']);
    final candidateIds = <int?>[
      _asInt(event['appointment_id']),
      _asInt(event['appointmentId']),
      _asInt(payload['appointment_id']),
      _asInt(payload['appointmentId']),
      _asInt(content['appointment_id']),
      _asInt(content['appointmentId']),
      _asInt(details['appointment_id']),
      _asInt(details['appointmentId']),
    ];
    return candidateIds.any((id) => id == appointmentId);
  }

  String? _eventTitle(Map<String, dynamic>? event) {
    if (event == null) return null;
    for (final key in ['title', 'summary', 'label', 'name', 'description']) {
      final text = _clean(event[key]);
      if (text.isNotEmpty) return text;
    }
    final payload = _asMap(event['payload'] ?? event['data'] ?? event['meta']);
    for (final key in ['title', 'summary', 'diagnosis', 'test_name']) {
      final text = _clean(payload[key]);
      if (text.isNotEmpty) return text;
    }
    return null;
  }

  Widget _buildContent() {
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 1080;
        final actionPanel = Column(
          children: [
            _buildClinicalActions(),
            const SizedBox(height: 14),
            _buildVisitChecklist(),
          ],
        );
        final mainPanel = Column(
          children: [
            _buildConsultationNotePanel(),
            const SizedBox(height: 16),
            _buildCockpitSummaryPanel(),
            const SizedBox(height: 16),
            _buildTimelineSummary(),
          ],
        );

        return RefreshIndicator(
          onRefresh: _loadTimeline,
          child: SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _buildVisitHeader(),
                const SizedBox(height: 16),
                if (wide)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(flex: 4, child: mainPanel),
                      const SizedBox(width: 16),
                      SizedBox(width: 360, child: actionPanel),
                    ],
                  )
                else
                  Column(
                    children: [
                      mainPanel,
                      const SizedBox(height: 16),
                      actionPanel,
                    ],
                  ),
                const SizedBox(height: 24),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'OP Workspace - $_patientTitle',
      body: _loading
          ? const SkeletonList()
          : _error != null
          ? ErrorState(message: _error!, onRetry: _loadTimeline)
          : _buildContent(),
    );
  }
}

class _WorkspaceAction {
  final IconData icon;
  final String label;
  final String detail;
  final VoidCallback onTap;

  const _WorkspaceAction({
    required this.icon,
    required this.label,
    required this.detail,
    required this.onTap,
  });
}

class _ActionTile extends StatelessWidget {
  final _WorkspaceAction action;

  const _ActionTile({required this.action});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: action.onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppTheme.primaryBlue.withValues(alpha: 0.07),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: AppTheme.primaryBlue.withValues(alpha: 0.18),
          ),
        ),
        child: Row(
          children: [
            Icon(action.icon, color: AppTheme.primaryBlue, size: 22),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    action.label,
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    action.detail,
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right, color: AppTheme.textSecondary),
          ],
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;

  const _SectionTitle({
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: AppTheme.primaryBlue, size: 22),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: TextStyle(
                  color: AppTheme.textPrimary,
                  fontWeight: FontWeight.w900,
                  fontSize: 16,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                subtitle,
                style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ClinicalTextField extends StatelessWidget {
  final TextEditingController controller;
  final String label;
  final String hint;
  final int minLines;
  final bool enabled;

  const _ClinicalTextField({
    required this.controller,
    required this.label,
    required this.hint,
    this.minLines = 2,
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      minLines: minLines,
      maxLines: minLines + 4,
      enabled: enabled,
      style: TextStyle(color: AppTheme.textPrimary),
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        alignLabelWithHint: true,
        filled: true,
        fillColor: enabled
            ? AppTheme.cardSurface
            : AppTheme.divider.withValues(alpha: 0.45),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
      ),
    );
  }
}

class _CockpitTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String value;
  final String action;
  final VoidCallback onTap;

  const _CockpitTile({
    required this.icon,
    required this.title,
    required this.value,
    required this.action,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppTheme.divider.withValues(alpha: 0.35),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppTheme.divider),
        ),
        child: Row(
          children: [
            Icon(icon, color: AppTheme.primaryBlue, size: 24),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    value,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(
              action,
              style: const TextStyle(
                color: AppTheme.primaryBlue,
                fontWeight: FontWeight.w800,
                fontSize: 12,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MetaChip extends StatelessWidget {
  final IconData icon;
  final String label;

  const _MetaChip(this.icon, this.label);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: AppTheme.textSecondary),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String label;
  final Color color;

  const _StatusPill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w900,
        ),
      ),
    );
  }
}

class _ChecklistRow extends StatelessWidget {
  final bool complete;
  final String label;

  const _ChecklistRow({required this.complete, required this.label});

  @override
  Widget build(BuildContext context) {
    final color = complete ? AppTheme.successOnSurface : AppTheme.textSecondary;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Icon(
            complete ? Icons.check_circle : Icons.radio_button_unchecked,
            size: 18,
            color: color,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontWeight: complete ? FontWeight.w700 : FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TimelineSummaryItem extends StatelessWidget {
  final Map<String, dynamic> event;
  final bool isLast;

  const _TimelineSummaryItem({required this.event, required this.isLast});

  @override
  Widget build(BuildContext context) {
    final type = _normalizedEventType(event['event_type']);
    final color = _eventColor(type);
    final description = _eventDescription(event);
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 40,
            child: Column(
              children: [
                Container(
                  width: 28,
                  height: 28,
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.14),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(_eventIcon(type), color: color, size: 15),
                ),
                if (!isLast)
                  Expanded(child: Container(width: 2, color: AppTheme.divider)),
              ],
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppTheme.backgroundGrey.withValues(alpha: 0.7),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppTheme.divider),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        _StatusPill(label: type.toUpperCase(), color: color),
                        const Spacer(),
                        Text(
                          _formatTimestamp(event['timestamp']),
                          style: TextStyle(
                            color: AppTheme.textSecondary,
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      _eventTitle(event),
                      style: TextStyle(
                        color: AppTheme.textPrimary,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    if (description.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(
                        description,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: AppTheme.textSecondary,
                          fontSize: 13,
                          height: 1.35,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

String _eventTitle(Map<String, dynamic> event) {
  final explicit = _clean(event['title']);
  if (explicit.isNotEmpty) return explicit;
  final type = _normalizedEventType(event['event_type']);
  final payload = _asMap(event['payload']);
  if (type == 'note') {
    final noteType = _clean(payload['note_type']);
    return noteType.isEmpty ? 'Clinical note' : '${_formatKey(noteType)} note';
  }
  if (type == 'drug_chart') {
    final details = _asMap(payload['details']);
    final medication = _clean(
      details['medication_name'] ??
          details['name'] ??
          details['medication'] ??
          payload['medication_name'],
    );
    return medication.isEmpty ? 'Drug chart' : 'Drug chart - $medication';
  }
  return _formatKey(type);
}

String _eventDescription(Map<String, dynamic> event) {
  final explicit = _clean(event['description']);
  if (explicit.isNotEmpty) return explicit;
  final summary = _clean(event['summary']);
  if (summary.isNotEmpty) return summary;
  final payload = _asMap(event['payload']);
  final content = payload['content'];
  if (content is Map) {
    final parts = [
      content['chief_complaint'],
      content['chief_complaints'],
      content['history'],
      content['examination'],
      content['diagnosis'],
      content['subjective'],
      content['objective'],
      content['assessment'],
      content['plan'],
      content['notes'],
    ].map(_clean).where((value) => value.isNotEmpty).toList();
    if (parts.isNotEmpty) return parts.join(' ');
  }
  return _clean(content);
}

String _formatTimestamp(dynamic value) {
  final text = _clean(value);
  if (text.isEmpty) return '-';
  try {
    final dt = DateTime.parse(text).toLocal();
    return DateFormat('dd/MM HH:mm').format(dt);
  } catch (_) {
    return text;
  }
}

String _normalizedEventType(dynamic value) {
  final text = _clean(value).toLowerCase();
  switch (text) {
    case 'clinical_note':
    case 'doctor_note':
    case 'nursing_note':
    case 'op_consultation':
    case 'consultation_note':
    case 'soap':
    case 'progress':
      return 'note';
    case 'clinical_order':
      return 'order';
    case 'medication_order':
      return 'drug_chart';
    default:
      return text.isEmpty ? 'event' : text;
  }
}

IconData _eventIcon(String type) {
  switch (type) {
    case 'vitals':
      return Icons.monitor_heart_outlined;
    case 'note':
      return Icons.note_alt_outlined;
    case 'order':
      return Icons.receipt_long_outlined;
    case 'drug_chart':
    case 'medication':
    case 'prescription':
      return Icons.medication_outlined;
    case 'investigation':
      return Icons.biotech_outlined;
    case 'admission':
      return Icons.local_hospital_outlined;
    case 'discharge':
      return Icons.exit_to_app_outlined;
    default:
      return Icons.circle_outlined;
  }
}

Color _eventColor(String type) {
  switch (type) {
    case 'vitals':
      return AppTheme.primaryTeal;
    case 'note':
      return const Color(0xFF8E24AA);
    case 'order':
      return AppTheme.accentCyan;
    case 'drug_chart':
    case 'medication':
    case 'prescription':
      return AppTheme.warningOnSurface;
    case 'investigation':
      return AppTheme.successOnSurface;
    case 'admission':
      return AppTheme.primaryBlue;
    case 'discharge':
      return AppTheme.successOnSurface;
    default:
      return AppTheme.textSecondary;
  }
}

Color _statusColor(String status) {
  final normalized = status.toUpperCase();
  if (_isTerminalStatus(normalized)) return AppTheme.successOnSurface;
  if (normalized == 'NO_SHOW' || normalized == 'CANCELLED') {
    return AppTheme.errorOnSurface;
  }
  if (normalized == 'ARRIVED' || normalized == 'IN_PROGRESS') {
    return AppTheme.warningOnSurface;
  }
  return AppTheme.primaryBlue;
}

bool _isTerminalStatus(String status) {
  final normalized = status.toUpperCase();
  return normalized == 'COMPLETED' ||
      normalized == 'COMPLETE' ||
      normalized == 'CANCELLED' ||
      normalized == 'CANCELED' ||
      normalized == 'NO_SHOW';
}

Map<String, dynamic> _asMap(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return const {};
}

Map<String, dynamic>? _firstCoding(dynamic value) {
  if (value is List) {
    for (final item in value) {
      final map = _asMap(item);
      if (_clean(map['code']).isNotEmpty) return map;
    }
  }
  final map = _asMap(value);
  return _clean(map['code']).isNotEmpty ? map : null;
}

Map<String, dynamic> _contentMap(Map<String, dynamic> note) {
  final content = note['content'];
  if (content is Map<String, dynamic>) return content;
  if (content is Map) return Map<String, dynamic>.from(content);
  return note;
}

int? _asInt(Object? value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '');
}

String _firstContentText(Map<String, dynamic> content, List<String> keys) {
  for (final key in keys) {
    final text = _clean(content[key]);
    if (text.isNotEmpty && text.toLowerCase() != 'null') return text;
  }
  return '';
}

String _joinNonEmpty(Iterable<String> values, {String separator = ' | '}) {
  return values
      .map((value) => value.trim())
      .where((value) => value.isNotEmpty)
      .join(separator);
}

String _formatKey(String key) {
  return key
      .replaceAll('_', ' ')
      .split(' ')
      .map((word) {
        if (word.isEmpty) return word;
        return '${word[0].toUpperCase()}${word.substring(1)}';
      })
      .join(' ');
}

String _clean(Object? value) => value?.toString().trim() ?? '';
