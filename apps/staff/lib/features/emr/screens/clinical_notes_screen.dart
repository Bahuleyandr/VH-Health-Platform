import 'package:flutter/material.dart';
import '../../../core/services/clinical_ai_api_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

/// EMR Clinical Notes screen — tabbed view for SOAP, Progress, and Procedure notes.
class ClinicalNotesScreen extends StatefulWidget {
  final String patientUid;
  final String? patientName;

  const ClinicalNotesScreen({
    super.key,
    required this.patientUid,
    this.patientName,
  });

  @override
  State<ClinicalNotesScreen> createState() => _ClinicalNotesScreenState();
}

class _ClinicalNotesScreenState extends State<ClinicalNotesScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  static const _noteTypes = ['soap', 'progress', 'procedure'];

  List<String> _tabLabels(BuildContext context) {
    final s = AppStrings.of(context);
    return [
      s.clinicalNotesTabSoap,
      s.clinicalNotesTabProgress,
      s.clinicalNotesTabProcedure,
    ];
  }

  final Map<String, List<Map<String, dynamic>>> _notesByType = {};
  final Map<String, bool> _loadingByType = {};
  final Map<String, String?> _errorByType = {};

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: _noteTypes.length, vsync: this);
    _tabController.addListener(() {
      if (!_tabController.indexIsChanging) {
        _loadNotesForTab(_tabController.index);
      }
    });
    // Load first tab
    _loadNotesForTab(0);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadNotesForTab(int index) async {
    final type = _noteTypes[index];
    if (_notesByType.containsKey(type) && _errorByType[type] == null) return;

    setState(() {
      _loadingByType[type] = true;
      _errorByType[type] = null;
    });

    try {
      final data = await MedicalApiService.getPatientNotes(
        widget.patientUid,
        noteType: type,
      );
      final list = data['notes'];
      setState(() {
        _notesByType[type] = list is List
            ? list.map((e) => Map<String, dynamic>.from(e as Map)).toList()
            : [];
        _loadingByType[type] = false;
      });
    } catch (e) {
      setState(() {
        _errorByType[type] = e.toString();
        _loadingByType[type] = false;
      });
    }
  }

  void _refreshCurrentTab() {
    final type = _noteTypes[_tabController.index];
    _notesByType.remove(type);
    _loadNotesForTab(_tabController.index);
  }

  // ── Note Status Badge ──

  Widget _signedBadge(bool signed) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: signed
            ? AppTheme.successGreen.withValues(alpha: 0.12)
            : AppTheme.warningAmber.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        signed
            ? AppStrings.of(context).clinicalNotesSigned
            : AppStrings.of(context).clinicalNotesUnsigned,
        style: TextStyle(
          color: signed ? AppTheme.successGreen : AppTheme.warningAmber,
          fontSize: 10,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }

  // ── Note List Tab ──

  Widget _buildNoteList(String type) {
    final loading = _loadingByType[type] ?? true;
    final error = _errorByType[type];
    final notes = _notesByType[type] ?? [];

    if (loading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 48, color: AppTheme.errorRed),
            const SizedBox(height: 12),
            Text(error, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: _refreshCurrentTab,
              child: Text(AppStrings.of(context).clinicalNotesRetry),
            ),
          ],
        ),
      );
    }

    if (notes.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.note_alt_outlined,
              size: 64,
              color: AppTheme.divider,
            ),
            const SizedBox(height: 12),
            Text(
              AppStrings.of(context).clinicalNotesNoFound(type),
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () async {
        _notesByType.remove(type);
        await _loadNotesForTab(_tabController.index);
      },
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: notes.length,
        itemBuilder: (ctx, i) {
          final note = notes[i];
          final signed = note['signed'] == true;
          final noteId = note['id'];
          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () => _showNoteDetail(note),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            note['title'] as String? ??
                                AppStrings.of(ctx).clinicalNotesNoteFallback,
                            style: const TextStyle(
                              fontWeight: FontWeight.w600,
                              fontSize: 15,
                            ),
                          ),
                        ),
                        _signedBadge(signed),
                      ],
                    ),
                    SizedBox(height: 6),
                    Row(
                      children: [
                        Icon(
                          Icons.person_outline,
                          size: 14,
                          color: AppTheme.textSecondary,
                        ),
                        SizedBox(width: 4),
                        Text(
                          note['author_name'] as String? ??
                              AppStrings.of(ctx).clinicalNotesUnknownAuthor,
                          style: TextStyle(
                            fontSize: 12,
                            color: AppTheme.textSecondary,
                          ),
                        ),
                        SizedBox(width: 12),
                        Icon(
                          Icons.access_time,
                          size: 14,
                          color: AppTheme.textSecondary,
                        ),
                        SizedBox(width: 4),
                        Text(
                          _formatTimestamp(note['created_at'] as String?),
                          style: TextStyle(
                            fontSize: 12,
                            color: AppTheme.textSecondary,
                          ),
                        ),
                      ],
                    ),
                    if (note['summary'] != null) ...[
                      const SizedBox(height: 8),
                      Text(
                        note['summary'] as String,
                        style: const TextStyle(fontSize: 13),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                    if (!signed && noteId is int) ...[
                      const SizedBox(height: 10),
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton.icon(
                          onPressed: () => _signNoteAction(noteId),
                          icon: const Icon(
                            Icons.check_circle_outline,
                            size: 18,
                          ),
                          label: Text(
                              AppStrings.of(ctx).clinicalNotesSignNote),
                          style: TextButton.styleFrom(
                            foregroundColor: AppTheme.successGreen,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  // ── Sign Note ──

  Future<void> _signNoteAction(int noteId) async {
    try {
      await MedicalApiService.signNote(noteId);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context).clinicalNotesSignedSuccess),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _refreshCurrentTab();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context)
                .clinicalNotesSignFailed(e.toString())),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  // ── Note Detail ──

  void _showNoteDetail(Map<String, dynamic> note) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Container(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(ctx).size.height * 0.85,
        ),
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppTheme.divider,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      note['title'] as String? ??
                          AppStrings.of(ctx).clinicalNotesNoteFallback,
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w600,
                        color: AppTheme.textPrimary,
                      ),
                    ),
                  ),
                  _signedBadge(note['signed'] == true),
                ],
              ),
              SizedBox(height: 4),
              Text(
                '${note['author_name'] ?? AppStrings.of(ctx).clinicalNotesUnknownAuthor} - ${_formatTimestamp(note['created_at'] as String?)}',
                style: TextStyle(
                  color: AppTheme.textSecondary,
                  fontSize: 13,
                ),
              ),
              const Divider(height: 24),
              // SOAP fields
              if (note['subjective'] != null)
                _noteSection(AppStrings.of(ctx).clinicalNotesSubjective,
                    note['subjective'] as String),
              if (note['objective'] != null)
                _noteSection(AppStrings.of(ctx).clinicalNotesObjective,
                    note['objective'] as String),
              if (note['assessment'] != null)
                _noteSection(AppStrings.of(ctx).clinicalNotesAssessment,
                    note['assessment'] as String),
              if (note['plan'] != null)
                _noteSection(AppStrings.of(ctx).clinicalNotesPlan,
                    note['plan'] as String),
              // Generic content
              if (note['content'] != null)
                _noteSection(AppStrings.of(ctx).clinicalNotesContent,
                    note['content'] as String),
              if (note['findings'] != null)
                _noteSection(AppStrings.of(ctx).clinicalNotesFindings,
                    note['findings'] as String),
              if (note['procedure_details'] != null)
                _noteSection(
                  AppStrings.of(ctx).clinicalNotesProcedureDetails,
                  note['procedure_details'] as String,
                ),
              if (note['complications'] != null)
                _noteSection(AppStrings.of(ctx).clinicalNotesComplications,
                    note['complications'] as String),
              const SizedBox(height: 16),
              // ── AI Assist — generate patient-friendly explainer ──
              // The button is enabled regardless of signed status so a doctor
              // can preview the AI explanation before finalizing the note,
              // OR generate it after sign-off for downstream patient delivery.
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  border: Border.all(color: AppTheme.primaryBlue.withValues(alpha: 0.25)),
                  borderRadius: BorderRadius.circular(12),
                  color: AppTheme.primaryBlue.withValues(alpha: 0.04),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.auto_awesome,
                            size: 20, color: AppTheme.primaryBlue),
                        const SizedBox(width: 8),
                        Text(
                          AppStrings.of(context).aiAssistTitle,
                          style: const TextStyle(
                            fontWeight: FontWeight.w600,
                            color: AppTheme.primaryBlue,
                            fontSize: 15,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      AppStrings.of(context).aiAssistGenerateBlurb,
                      style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
                    ),
                    const SizedBox(height: 10),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: () {
                          Navigator.of(context).pop();
                          _generateAiExplainer(note);
                        },
                        icon: const Icon(Icons.auto_awesome, size: 18),
                        label: Text(AppStrings.of(context).aiAssistGenerateButton),
                        style: FilledButton.styleFrom(
                          backgroundColor: AppTheme.primaryBlue,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),
            ],
          ),
        ),
      ),
    );
  }

  // ── AI Assist: generate + sign-off ──

  /// Build a single free-text report from whichever fields the note has.
  /// SOAP notes get S/O/A/P concatenated; progress + procedure notes use
  /// their content/findings/details fields.
  String _composeReportText(Map<String, dynamic> note) {
    final parts = <String>[];
    void add(String label, String? value) {
      final v = (value ?? '').trim();
      if (v.isNotEmpty) parts.add('$label: $v');
    }
    add('Subjective', note['subjective'] as String?);
    add('Objective', note['objective'] as String?);
    add('Assessment', note['assessment'] as String?);
    add('Plan', note['plan'] as String?);
    add('Content', note['content'] as String?);
    add('Findings', note['findings'] as String?);
    add('Procedure details', note['procedure_details'] as String?);
    add('Complications', note['complications'] as String?);
    return parts.join('\n\n');
  }

  String _reportTypeFor(Map<String, dynamic> note) {
    final t = (note['note_type'] as String?)?.toLowerCase() ?? 'consultation';
    // Map staff-app note_types to backend report_type allowed values.
    switch (t) {
      case 'soap': return 'consultation';
      case 'progress': return 'consultation';
      case 'procedure': return 'procedure';
      case 'discharge': return 'discharge';
      default: return 'consultation';
    }
  }

  Future<void> _generateAiExplainer(Map<String, dynamic> note) async {
    final s = AppStrings.of(context);
    final reportText = _composeReportText(note);
    if (reportText.length < 30) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.aiAssistNoteTooShort),
          backgroundColor: AppTheme.warningAmber,
        ),
      );
      return;
    }

    // Show a simple loading dialog while we wait on the LLM (3-30s typical).
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => Center(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const CircularProgressIndicator(),
                const SizedBox(height: 12),
                Text(AppStrings.of(ctx).aiAssistGenerating),
              ],
            ),
          ),
        ),
      ),
    );

    Map<String, dynamic>? result;
    String? error;
    try {
      result = await ClinicalAiApiService.explainPatientReport(
        reportType: _reportTypeFor(note),
        reportText: reportText,
        patientUid: widget.patientUid,
      );
    } catch (e) {
      error = e.toString();
    }

    if (!mounted) return;
    Navigator.of(context).pop(); // close loading dialog

    if (error != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.aiAssistFailed(error)),
          backgroundColor: AppTheme.errorRed,
        ),
      );
      return;
    }

    _showAiAssistDrawer(result!);
  }

  void _showAiAssistDrawer(Map<String, dynamic> result) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => _AiAssistDraftSheet(
        result: result,
        onDecided: () {
          // After sign-off, refresh the notes list (the explainer draft
          // doesn't appear in the notes table, but a future "Patient
          // explainers" tab will read the same review queue).
          _refreshCurrentTab();
        },
      ),
    );
  }

  Widget _noteSection(String title, String content) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontWeight: FontWeight.w600,
              fontSize: 14,
              color: AppTheme.primaryBlue,
            ),
          ),
          const SizedBox(height: 4),
          Text(content, style: const TextStyle(fontSize: 14, height: 1.5)),
        ],
      ),
    );
  }

  // ── Create Note FAB ──

  void _showCreateNoteSheet() {
    final type = _noteTypes[_tabController.index];
    switch (type) {
      case 'soap':
        _showSoapNoteForm();
        break;
      case 'progress':
        _showProgressNoteForm();
        break;
      case 'procedure':
        _showProcedureNoteForm();
        break;
    }
  }

  void _showSoapNoteForm() {
    final s = AppStrings.of(context);
    final formKey = GlobalKey<FormState>();
    final subjective = TextEditingController();
    final objective = TextEditingController();
    final assessment = TextEditingController();
    final plan = TextEditingController();

    _showNoteFormSheet(
      title: s.clinicalNotesNewSoap,
      formKey: formKey,
      fields: [
        _buildTextArea(
          subjective,
          s.clinicalNotesSubjective,
          s.clinicalNotesSubjectiveHint,
        ),
        _buildTextArea(
          objective,
          s.clinicalNotesObjective,
          s.clinicalNotesObjectiveHint,
        ),
        _buildTextArea(
          assessment,
          s.clinicalNotesAssessment,
          s.clinicalNotesAssessmentHint,
        ),
        _buildTextArea(plan, s.clinicalNotesPlan, s.clinicalNotesPlanHint),
      ],
      onSubmit: () => _submitNote(
        formKey: formKey,
        data: {
          'patient_uid': widget.patientUid,
          'note_type': 'soap',
          'subjective': subjective.text,
          'objective': objective.text,
          'assessment': assessment.text,
          'plan': plan.text,
        },
      ),
    );
  }

  void _showProgressNoteForm() {
    final s = AppStrings.of(context);
    final formKey = GlobalKey<FormState>();
    final title = TextEditingController();
    final content = TextEditingController();

    _showNoteFormSheet(
      title: s.clinicalNotesNewProgress,
      formKey: formKey,
      fields: [
        TextFormField(
          controller: title,
          decoration: InputDecoration(
            labelText: s.clinicalNotesTitleField,
            border: const OutlineInputBorder(),
          ),
          validator: (v) =>
              (v == null || v.isEmpty) ? s.clinicalNotesRequired : null,
        ),
        const SizedBox(height: 12),
        _buildTextArea(
          content,
          s.clinicalNotesContent,
          s.clinicalNotesContentHint,
        ),
      ],
      onSubmit: () => _submitNote(
        formKey: formKey,
        data: {
          'patient_uid': widget.patientUid,
          'note_type': 'progress',
          'title': title.text,
          'content': content.text,
        },
      ),
    );
  }

  void _showProcedureNoteForm() {
    final s = AppStrings.of(context);
    final formKey = GlobalKey<FormState>();
    final title = TextEditingController();
    final procedureDetails = TextEditingController();
    final findings = TextEditingController();
    final complications = TextEditingController();

    _showNoteFormSheet(
      title: s.clinicalNotesNewProcedure,
      formKey: formKey,
      fields: [
        TextFormField(
          controller: title,
          decoration: InputDecoration(
            labelText: s.clinicalNotesProcedureName,
            border: const OutlineInputBorder(),
          ),
          validator: (v) =>
              (v == null || v.isEmpty) ? s.clinicalNotesRequired : null,
        ),
        const SizedBox(height: 12),
        _buildTextArea(
          procedureDetails,
          s.clinicalNotesProcedureDetails,
          s.clinicalNotesProcedureDetailsHint,
        ),
        _buildTextArea(findings, s.clinicalNotesFindings,
            s.clinicalNotesFindingsHint),
        _buildTextArea(
          complications,
          s.clinicalNotesComplications,
          s.clinicalNotesComplicationsHint,
        ),
      ],
      onSubmit: () => _submitNote(
        formKey: formKey,
        data: {
          'patient_uid': widget.patientUid,
          'note_type': 'procedure',
          'title': title.text,
          'procedure_details': procedureDetails.text,
          'findings': findings.text,
          'complications': complications.text,
        },
      ),
    );
  }

  Widget _buildTextArea(
    TextEditingController controller,
    String label,
    String hint,
  ) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextFormField(
        controller: controller,
        decoration: InputDecoration(
          labelText: label,
          hintText: hint,
          border: const OutlineInputBorder(),
          alignLabelWithHint: true,
        ),
        maxLines: 4,
        minLines: 3,
      ),
    );
  }

  void _showNoteFormSheet({
    required String title,
    required GlobalKey<FormState> formKey,
    required List<Widget> fields,
    required VoidCallback onSubmit,
  }) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Container(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Form(
            key: formKey,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Center(
                    child: Container(
                      width: 40,
                      height: 4,
                      decoration: BoxDecoration(
                        color: AppTheme.divider,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                  SizedBox(height: 16),
                  Text(
                    title,
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w600,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 20),
                  ...fields,
                  const SizedBox(height: 8),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      onPressed: onSubmit,
                      icon: const Icon(Icons.save),
                      label: Text(AppStrings.of(ctx).clinicalNotesSaveNote),
                    ),
                  ),
                  const SizedBox(height: 12),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _submitNote({
    required GlobalKey<FormState> formKey,
    required Map<String, dynamic> data,
  }) async {
    if (!formKey.currentState!.validate()) return;
    Navigator.of(context).pop();

    try {
      await MedicalApiService.createClinicalNote(data);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context).clinicalNotesCreatedSuccess),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _refreshCurrentTab();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context)
                .clinicalNotesCreateFailed(e.toString())),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  // ── Helpers ──

  String _formatTimestamp(String? ts) {
    if (ts == null) return '-';
    try {
      final dt = DateTime.parse(ts);
      final now = DateTime.now();
      final diff = now.difference(dt);
      if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
      if (diff.inHours < 24) return '${diff.inHours}h ago';
      return '${dt.day}/${dt.month}/${dt.year} ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return ts;
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: widget.patientName != null
          ? s.clinicalNotesTitleWithName(widget.patientName!)
          : s.clinicalNotesTitle,
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _showCreateNoteSheet,
        backgroundColor: AppTheme.primaryBlue,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.note_add),
        label: Text(s.clinicalNotesNewNote),
      ),
      body: Column(
        children: [
          Material(
            color: Colors.white,
            elevation: 1,
            child: TabBar(
              controller: _tabController,
              labelColor: AppTheme.primaryBlue,
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: AppTheme.primaryBlue,
              tabs: _tabLabels(context).map((l) => Tab(text: l)).toList(),
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: _noteTypes.map((t) => _buildNoteList(t)).toList(),
            ),
          ),
        ],
      ),
    );
  }
}

/// Bottom-sheet drawer that renders an AI-generated patient explainer
/// draft and lets the doctor sign / edit / reject it on the spot.
///
/// Shape of [result] is the standard explainer envelope from
/// ClinicalAiApiService.explainPatientReport — see the doc on that method.
class _AiAssistDraftSheet extends StatefulWidget {
  const _AiAssistDraftSheet({required this.result, required this.onDecided});

  final Map<String, dynamic> result;
  final VoidCallback onDecided;

  @override
  State<_AiAssistDraftSheet> createState() => _AiAssistDraftSheetState();
}

class _AiAssistDraftSheetState extends State<_AiAssistDraftSheet> {
  bool _busy = false;

  Map<String, dynamic> get _draft =>
      (widget.result['draft'] as Map?)?.cast<String, dynamic>() ?? const {};

  List<Map<String, dynamic>> _list(String key) {
    final raw = _draft[key] ?? widget.result[key];
    if (raw is List) {
      return raw.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
    }
    return const [];
  }

  List<String> _stringList(String key) {
    final raw = _draft[key];
    if (raw is List) return raw.whereType<String>().toList();
    return const [];
  }

  int? get _reviewId {
    final v = widget.result['review_id'];
    if (v is int) return v;
    if (v is String) return int.tryParse(v);
    return null;
  }

  Future<void> _decide(String decision, {String? rejectionReason}) async {
    final s = AppStrings.of(context);
    final id = _reviewId;
    if (id == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.aiAssistCannotSign),
          backgroundColor: AppTheme.errorRed,
        ),
      );
      return;
    }
    setState(() => _busy = true);
    try {
      await ClinicalAiApiService.decideReview(
        id,
        decision: decision,
        rejectionReason: rejectionReason,
      );
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.aiAssistDecisionToast(decision)),
          backgroundColor: decision == 'rejected'
              ? AppTheme.warningAmber
              : AppTheme.successGreen,
        ),
      );
      widget.onDecided();
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.aiAssistSignFailed(e.toString())),
          backgroundColor: AppTheme.errorRed,
        ),
      );
    }
  }

  Future<void> _confirmReject() async {
    final s = AppStrings.of(context);
    final controller = TextEditingController();
    final reason = await showDialog<String>(
      context: context,
      builder: (ctx) {
        final ds = AppStrings.of(ctx);
        return AlertDialog(
          title: Text(ds.aiAssistRejectTitle),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(ds.aiAssistRejectPrompt),
              const SizedBox(height: 12),
              TextField(
                controller: controller,
                decoration: InputDecoration(
                  hintText: ds.aiAssistRejectHint,
                  border: const OutlineInputBorder(),
                ),
                maxLines: 3,
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(), child: Text(ds.actionCancel)),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(controller.text.trim()),
              style: FilledButton.styleFrom(backgroundColor: AppTheme.errorRed),
              child: Text(ds.clinicalAiDraftRejectButton),
            ),
          ],
        );
      },
    );
    if (reason == null) return;
    if (reason.length < 5) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.aiAssistRejectMinChars)),
      );
      return;
    }
    await _decide('rejected', rejectionReason: reason);
  }

  @override
  Widget build(BuildContext context) {
    final summary = ((_draft['explanation_summary'] as String?) ?? '').trim();
    final keyPoints = _list('key_points');
    final nextSteps = _stringList('next_steps');
    final whenToSeekHelp = _stringList('when_to_seek_help');
    final safetyFlagsRaw = (widget.result['safety_flags'] as List?) ?? const [];
    final safetyFlags = safetyFlagsRaw.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
    final critical = safetyFlags.where((f) => (f['severity'] as String?)?.toLowerCase() == 'critical').toList();
    final high = safetyFlags.where((f) => (f['severity'] as String?)?.toLowerCase() == 'high').toList();
    final usedAi = widget.result['used_ai'] == true;
    final provider = (widget.result['provider'] as String?) ?? 'unknown';
    final fallback = _draft['fallback_used'] == true;

    return DraggableScrollableSheet(
      initialChildSize: 0.85,
      minChildSize: 0.4,
      maxChildSize: 0.97,
      expand: false,
      builder: (ctx, scrollController) => Container(
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        child: SingleChildScrollView(
          controller: scrollController,
          padding: EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppTheme.divider,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Icon(Icons.auto_awesome, color: AppTheme.primaryBlue),
                  const SizedBox(width: 8),
                  Text(
                    AppStrings.of(context).aiAssistDrawerTitle,
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w600,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: [
                  const _Chip(label: 'review: pending', color: AppTheme.warningAmber),
                  _Chip(
                    label: usedAi ? provider : 'fallback',
                    color: usedAi ? AppTheme.successGreen : AppTheme.warningAmber,
                  ),
                  if (widget.result['generation_id'] != null)
                    _Chip(label: 'gen #${widget.result['generation_id']}', color: AppTheme.textSecondary),
                ],
              ),
              const SizedBox(height: 12),
              if (critical.isNotEmpty || high.isNotEmpty)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: Colors.red.shade50,
                    border: Border.all(color: Colors.red.shade200),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${critical.length} critical · ${high.length} high — review carefully',
                        style: const TextStyle(color: AppTheme.errorRed, fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 4),
                      ...[...critical, ...high].take(4).map((f) => Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(
                              '• ${(f['code'] as String?) ?? 'FLAG'} — ${(f['message'] as String?) ?? ''}',
                              style: const TextStyle(fontSize: 12),
                            ),
                          )),
                    ],
                  ),
                ),
              if (fallback)
                Container(
                  width: double.infinity,
                  margin: const EdgeInsets.only(top: 8),
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: Colors.amber.shade50,
                    border: Border.all(color: Colors.amber.shade300),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    AppStrings.of(context).aiAssistFallbackBanner,
                    style: const TextStyle(fontSize: 12),
                  ),
                ),
              const SizedBox(height: 16),
              Text(AppStrings.of(context).aiAssistSummary,
                  style: const TextStyle(fontWeight: FontWeight.w600, color: AppTheme.primaryBlue)),
              const SizedBox(height: 4),
              Text(summary.isEmpty ? AppStrings.of(context).aiAssistEmpty : summary,
                  style: const TextStyle(height: 1.5)),
              const SizedBox(height: 16),
              if (keyPoints.isNotEmpty) ...[
                Text(AppStrings.of(context).aiAssistKeyPoints,
                    style: const TextStyle(fontWeight: FontWeight.w600, color: AppTheme.primaryBlue)),
                const SizedBox(height: 4),
                ...keyPoints.map((kp) => Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${kp['label'] ?? ''}: ${kp['value'] ?? ''}',
                            style: TextStyle(fontWeight: FontWeight.w500),
                          ),
                          if (kp['what_it_means'] != null)
                            Padding(
                              padding: const EdgeInsets.only(left: 4, top: 2),
                              child: Text(
                                kp['what_it_means'] as String,
                                style: TextStyle(color: AppTheme.textSecondary, fontSize: 13),
                              ),
                            ),
                        ],
                      ),
                    )),
                const SizedBox(height: 12),
              ],
              if (nextSteps.isNotEmpty) ...[
                Text(AppStrings.of(context).aiAssistNextSteps,
                    style: const TextStyle(fontWeight: FontWeight.w600, color: AppTheme.primaryBlue)),
                const SizedBox(height: 4),
                ...nextSteps.map((s) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 2),
                      child: Text('• $s'),
                    )),
                const SizedBox(height: 12),
              ],
              if (whenToSeekHelp.isNotEmpty) ...[
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: Colors.amber.shade50,
                    border: Border.all(color: Colors.amber.shade200),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(AppStrings.of(context).aiAssistWhenToSeekHelp,
                          style: const TextStyle(fontWeight: FontWeight.w600)),
                      const SizedBox(height: 4),
                      ...whenToSeekHelp.map((s) => Padding(
                            padding: const EdgeInsets.symmetric(vertical: 2),
                            child: Text('• $s'),
                          )),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
              ],
              const Divider(),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _busy ? null : _confirmReject,
                      icon: const Icon(Icons.close),
                      label: Text(AppStrings.of(context).clinicalAiDraftRejectButton),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: AppTheme.errorRed,
                        side: BorderSide(color: AppTheme.errorRed.withValues(alpha: 0.5)),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _busy ? null : () => _decide('needs_revision'),
                      icon: const Icon(Icons.edit_note),
                      label: Text(AppStrings.of(context).aiAssistNeedsEdits),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    flex: 2,
                    child: FilledButton.icon(
                      onPressed: _busy ? null : () => _decide('accepted'),
                      icon: _busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                            )
                          : const Icon(Icons.check_circle),
                      label: Text(AppStrings.of(context).aiAssistAcceptSign),
                      style: FilledButton.styleFrom(backgroundColor: AppTheme.successGreen),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
            ],
          ),
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.label, required this.color});
  final String label;
  final Color color;
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(label, style: TextStyle(color: color, fontSize: 11)),
    );
  }
}
