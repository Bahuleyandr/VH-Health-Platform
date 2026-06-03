import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/services/clinical_ai_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../op_ai_assist_availability.dart';

class OpAiAssistScreen extends StatefulWidget {
  const OpAiAssistScreen({super.key, this.initialAppointmentId});

  final int? initialAppointmentId;

  @override
  State<OpAiAssistScreen> createState() => _OpAiAssistScreenState();
}

class _OpAiAssistScreenState extends State<OpAiAssistScreen> {
  final _appointmentIdController = TextEditingController();
  final _patientIdController = TextEditingController();
  final _patientUidController = TextEditingController();
  final _medicationsController = TextEditingController();
  final _investigationIdController = TextEditingController();
  final _resultTextController = TextEditingController();
  final _clinicalQuestionController = TextEditingController();
  final _chiefComplaintController = TextEditingController();
  final _ageController = TextEditingController();
  final _sexController = TextEditingController();
  final _vitalsController = TextEditingController();
  final _examNotesController = TextEditingController();
  final _knownDiagnosesController = TextEditingController();
  final _diagnosisController = TextEditingController();
  final _treatmentPlanController = TextEditingController();
  final _monitoringController = TextEditingController();
  final _referralReasonController = TextEditingController();
  final _targetSpecialtyController = TextEditingController();
  final _clinicalSummaryController = TextEditingController();
  final _currentTreatmentController = TextEditingController();

  Map<String, _OpAiModule> _modules = const {};
  bool _loadingModules = true;
  String? _moduleError;
  String? _busyKey;
  StaffRole _role = StaffRole.general;
  bool _roleLoaded = false;

  @override
  void initState() {
    super.initState();
    final initialId = widget.initialAppointmentId;
    if (initialId != null) {
      _appointmentIdController.text = initialId.toString();
    }
    _loadRoleAndModules();
  }

  @override
  void dispose() {
    _appointmentIdController.dispose();
    _patientIdController.dispose();
    _patientUidController.dispose();
    _medicationsController.dispose();
    _investigationIdController.dispose();
    _resultTextController.dispose();
    _clinicalQuestionController.dispose();
    _chiefComplaintController.dispose();
    _ageController.dispose();
    _sexController.dispose();
    _vitalsController.dispose();
    _examNotesController.dispose();
    _knownDiagnosesController.dispose();
    _diagnosisController.dispose();
    _treatmentPlanController.dispose();
    _monitoringController.dispose();
    _referralReasonController.dispose();
    _targetSpecialtyController.dispose();
    _clinicalSummaryController.dispose();
    _currentTreatmentController.dispose();
    super.dispose();
  }

  Future<void> _loadRoleAndModules() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    if (!mounted) return;
    setState(() {
      _role = role;
      _roleLoaded = true;
    });
    if (!RoleFeatures.hasOpAiAssist(role)) {
      setState(() => _loadingModules = false);
      return;
    }
    await _loadModules();
  }

  Future<void> _loadModules() async {
    if (!RoleFeatures.hasOpAiAssist(_role)) {
      setState(() => _loadingModules = false);
      return;
    }
    setState(() {
      _loadingModules = true;
      _moduleError = null;
    });
    try {
      final list = await ClinicalAiApiService.listOpAssistModules();
      if (!mounted) return;
      setState(() {
        _modules = {
          for (final item in list)
            _OpAiModule.fromJson(item).key: _OpAiModule.fromJson(item),
        };
        _loadingModules = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _moduleError = err.toString();
        _loadingModules = false;
      });
    }
  }

  bool _enabled(String key) => _modules[key]?.enabled == true;

  _OpAiModule _module(
    String key,
    String fallbackLabel,
    String fallbackPurpose,
  ) {
    return _modules[key] ??
        _OpAiModule(
          key: key,
          label: fallbackLabel,
          purpose: fallbackPurpose,
          enabled: false,
        );
  }

  Future<void> _run(
    String key,
    String title,
    Future<Map<String, dynamic>> Function() action,
  ) async {
    if (!_enabled(key)) {
      _showSnack('$title is disabled in Clinical AI Admin.');
      return;
    }
    setState(() => _busyKey = key);
    try {
      final result = await action();
      if (!mounted) return;
      _showResultSheet(title, result);
    } catch (err) {
      if (!mounted) return;
      _showSnack(err.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  void _showSnack(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  int? _intFrom(TextEditingController controller) {
    final text = controller.text.trim();
    if (text.isEmpty) return null;
    return int.tryParse(text);
  }

  String? _textFrom(TextEditingController controller) {
    final text = controller.text.trim();
    return text.isEmpty ? null : text;
  }

  Map<String, dynamic>? _parseVitals() {
    final text = _vitalsController.text.trim();
    if (text.isEmpty) return null;
    final values = <String, dynamic>{};
    for (final rawLine in text.split('\n')) {
      final line = rawLine.trim();
      if (line.isEmpty) continue;
      final idx = line.indexOf(':');
      if (idx <= 0) continue;
      final key = line.substring(0, idx).trim();
      final value = line.substring(idx + 1).trim();
      if (key.isNotEmpty && value.isNotEmpty) values[key] = value;
    }
    return values.isEmpty ? {'notes': text} : values;
  }

  List<String>? _parseKnownDiagnoses() {
    final text = _knownDiagnosesController.text.trim();
    if (text.isEmpty) return null;
    return text
        .split(RegExp(r'[\n,]'))
        .map((item) => item.trim())
        .where((item) => item.isNotEmpty)
        .toList();
  }

  List<Map<String, dynamic>> _parseMedications() {
    return _medicationsController.text
        .split('\n')
        .map((raw) => raw.trim())
        .where((line) => line.isNotEmpty)
        .map((line) {
          final parts = line.split('|').map((p) => p.trim()).toList();
          if (parts.length == 1) return {'name': parts.first};
          return {
            'name': parts.isNotEmpty ? parts[0] : '',
            if (parts.length > 1 && parts[1].isNotEmpty) 'dose': parts[1],
            if (parts.length > 2 && parts[2].isNotEmpty) 'route': parts[2],
            if (parts.length > 3 && parts[3].isNotEmpty) 'frequency': parts[3],
          };
        })
        .where((med) => (med['name']?.toString().trim().isNotEmpty ?? false))
        .toList();
  }

  Future<void> _visitPrep() async {
    final id = _intFrom(_appointmentIdController);
    if (id == null) {
      _showSnack('Enter a valid appointment ID.');
      return;
    }
    await _run(
      'op_visit_prep',
      'OP Visit Prep',
      () => ClinicalAiApiService.generateOpVisitPrep(appointmentId: id),
    );
  }

  Future<void> _prescriptionSafety() async {
    final meds = _parseMedications();
    if (meds.isEmpty) {
      _showSnack('Enter at least one medication.');
      return;
    }
    await _run(
      'polypharmacy_ai_review',
      'Prescription Safety Assistant',
      () => ClinicalAiApiService.reviewOpPrescriptionSafety(
        patientId: _intFrom(_patientIdController),
        patientUid: _textFrom(_patientUidController),
        medications: meds,
      ),
    );
  }

  Future<void> _investigationReview() async {
    final investigationId = _intFrom(_investigationIdController);
    final resultText = _textFrom(_resultTextController);
    if (investigationId == null && resultText == null) {
      _showSnack('Enter an investigation ID or paste a result.');
      return;
    }
    await _run(
      'op_investigation_review',
      'Investigation Review Aid',
      () => ClinicalAiApiService.generateOpInvestigationReview(
        investigationId: investigationId,
        patientUid: _textFrom(_patientUidController),
        resultText: resultText,
        clinicalQuestion: _textFrom(_clinicalQuestionController),
      ),
    );
  }

  Future<void> _differentialRedFlags() async {
    final complaint = _textFrom(_chiefComplaintController);
    if (complaint == null) {
      _showSnack('Enter the chief complaint.');
      return;
    }
    await _run(
      'op_differential_red_flags',
      'Differential / Red Flag Checklist',
      () => ClinicalAiApiService.generateOpDifferentialRedFlags(
        patientUid: _textFrom(_patientUidController),
        chiefComplaint: complaint,
        ageYears: _intFrom(_ageController),
        sex: _textFrom(_sexController),
        vitals: _parseVitals(),
        examNotes: _textFrom(_examNotesController),
        knownDiagnoses: _parseKnownDiagnoses(),
      ),
    );
  }

  Future<void> _followUpPlan() async {
    final diagnosis = _textFrom(_diagnosisController);
    final plan = _textFrom(_treatmentPlanController);
    if (diagnosis == null || plan == null) {
      _showSnack('Enter diagnosis and treatment plan.');
      return;
    }
    await _run(
      'op_follow_up_plan',
      'Follow-Up Plan Draft',
      () => ClinicalAiApiService.generateOpFollowUpPlan(
        patientUid: _textFrom(_patientUidController),
        diagnosis: diagnosis,
        treatmentPlan: plan,
        monitoringContext: _textFrom(_monitoringController),
      ),
    );
  }

  Future<void> _referralDraft() async {
    final reason = _textFrom(_referralReasonController);
    final summary = _textFrom(_clinicalSummaryController);
    if (reason == null || summary == null) {
      _showSnack('Enter referral reason and clinical summary.');
      return;
    }
    await _run(
      'op_referral_draft',
      'Referral / Second Opinion Draft',
      () => ClinicalAiApiService.generateOpReferralDraft(
        patientUid: _textFrom(_patientUidController),
        referralReason: reason,
        clinicalSummary: summary,
        targetSpecialty: _textFrom(_targetSpecialtyController),
        currentTreatment: _textFrom(_currentTreatmentController),
      ),
    );
  }

  void _showResultSheet(String title, Map<String, dynamic> result) {
    final reviewId = result['review_id'];
    final canOpenReview =
        reviewId != null && result['module_key'] != 'polypharmacy_ai_review';
    final encoded = const JsonEncoder.withIndent('  ').convert(result);

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) {
        return SafeArea(
          child: FractionallySizedBox(
            heightFactor: 0.82,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.auto_awesome, size: 20),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          title,
                          style: Theme.of(context).textTheme.titleMedium
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                      ),
                      IconButton(
                        tooltip: 'Close',
                        onPressed: () => Navigator.pop(sheetContext),
                        icon: const Icon(Icons.close),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  _ResultMeta(result: result),
                  const SizedBox(height: 12),
                  Expanded(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: AppTheme.cardSurface,
                        border: Border.all(color: AppTheme.divider),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.all(12),
                        child: SelectableText(
                          encoded,
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 12,
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      OutlinedButton.icon(
                        onPressed: () {
                          Navigator.pop(sheetContext);
                          context.push('/clinical-ai/queue');
                        },
                        icon: const Icon(Icons.fact_check_outlined, size: 16),
                        label: const Text('Review queue'),
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size(0, 40),
                        ),
                      ),
                      const Spacer(),
                      if (canOpenReview)
                        FilledButton.icon(
                          onPressed: () {
                            Navigator.pop(sheetContext);
                            context.push(
                              '/clinical-ai/review/$reviewId',
                              extra: result,
                            );
                          },
                          icon: const Icon(Icons.open_in_new, size: 16),
                          label: const Text('Open draft'),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'OP AI Assist',
      actions: [
        IconButton(
          tooltip: 'Refresh services',
          onPressed: _loadingModules ? null : _loadModules,
          icon: const Icon(Icons.refresh),
        ),
      ],
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (!_roleLoaded || _loadingModules) {
      return const Center(child: CircularProgressIndicator());
    }
    if (!RoleFeatures.hasOpAiAssist(_role)) {
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [_AccessRestrictedPanel(role: _role)],
      );
    }
    if (_moduleError != null) {
      return _ErrorState(message: _moduleError!, onRetry: _loadModules);
    }

    return RefreshIndicator(
      onRefresh: _loadModules,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final contentWidth = constraints.maxWidth > 1180
              ? 1180.0
              : constraints.maxWidth;
          final cardWidth = contentWidth >= 900
              ? (contentWidth - 16) / 2
              : contentWidth;
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(16),
            children: [
              _GovernanceBand(
                enabledCount: _modules.values.where((m) => m.enabled).length,
                totalCount: _modules.length,
              ),
              const SizedBox(height: 16),
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1180),
                  child: Wrap(
                    spacing: 16,
                    runSpacing: 16,
                    children: [
                      SizedBox(width: cardWidth, child: _visitPrepCard()),
                      SizedBox(
                        width: cardWidth,
                        child: _prescriptionSafetyCard(),
                      ),
                      SizedBox(
                        width: cardWidth,
                        child: _investigationReviewCard(),
                      ),
                      SizedBox(
                        width: cardWidth,
                        child: _differentialRedFlagsCard(),
                      ),
                      SizedBox(width: cardWidth, child: _followUpPlanCard()),
                      SizedBox(width: cardWidth, child: _referralDraftCard()),
                      SizedBox(width: cardWidth, child: _voiceNoteCard()),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _visitPrepCard() {
    const key = 'op_visit_prep';
    return _ToolCard(
      module: _module(
        key,
        'OP Visit Prep',
        'Pre-consult doctor brief from appointment and chart context.',
      ),
      icon: Icons.assignment_outlined,
      busy: _busyKey == key,
      onSubmit: _visitPrep,
      submitLabel: 'Draft visit prep',
      child: _Field(
        controller: _appointmentIdController,
        label: 'Appointment ID',
        keyboardType: TextInputType.number,
      ),
    );
  }

  Widget _prescriptionSafetyCard() {
    const key = 'polypharmacy_ai_review';
    return _ToolCard(
      module: _module(
        key,
        'Prescription Safety Assistant',
        'Rules plus AI advisory review of a medication list.',
      ),
      icon: Icons.medication_liquid_outlined,
      busy: _busyKey == key,
      onSubmit: _prescriptionSafety,
      submitLabel: 'Review safety',
      child: Column(
        children: [
          _Field(
            controller: _patientIdController,
            label: 'Patient ID (optional)',
            keyboardType: TextInputType.number,
          ),
          const SizedBox(height: 10),
          _Field(
            controller: _patientUidController,
            label: 'Patient UID (optional)',
          ),
          const SizedBox(height: 10),
          _Field(
            controller: _medicationsController,
            label: 'Medications',
            hint: 'name | dose | route | frequency',
            maxLines: 5,
          ),
        ],
      ),
    );
  }

  Widget _investigationReviewCard() {
    const key = 'op_investigation_review';
    return _ToolCard(
      module: _module(
        key,
        'Investigation Review Aid',
        'Doctor-facing interpretation aid for OP lab/radiology results.',
      ),
      icon: Icons.biotech_outlined,
      busy: _busyKey == key,
      onSubmit: _investigationReview,
      submitLabel: 'Review result',
      child: Column(
        children: [
          _Field(
            controller: _investigationIdController,
            label: 'Investigation ID (optional)',
            keyboardType: TextInputType.number,
          ),
          const SizedBox(height: 10),
          _Field(
            controller: _resultTextController,
            label: 'Result text',
            maxLines: 5,
          ),
          const SizedBox(height: 10),
          _Field(
            controller: _clinicalQuestionController,
            label: 'Clinical question (optional)',
            maxLines: 2,
          ),
        ],
      ),
    );
  }

  Widget _differentialRedFlagsCard() {
    const key = 'op_differential_red_flags';
    return _ToolCard(
      module: _module(
        key,
        'Differential / Red Flag Checklist',
        'Differentials to consider, red flags, and next checks.',
      ),
      icon: Icons.emergency_outlined,
      busy: _busyKey == key,
      onSubmit: _differentialRedFlags,
      submitLabel: 'Draft checklist',
      child: Column(
        children: [
          _Field(
            controller: _chiefComplaintController,
            label: 'Chief complaint',
            maxLines: 3,
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: _Field(
                  controller: _ageController,
                  label: 'Age',
                  keyboardType: TextInputType.number,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _Field(controller: _sexController, label: 'Sex'),
              ),
            ],
          ),
          const SizedBox(height: 10),
          _Field(
            controller: _vitalsController,
            label: 'Vitals',
            hint: 'BP: 120/80',
            maxLines: 3,
          ),
          const SizedBox(height: 10),
          _Field(
            controller: _examNotesController,
            label: 'Exam notes',
            maxLines: 4,
          ),
          const SizedBox(height: 10),
          _Field(
            controller: _knownDiagnosesController,
            label: 'Known diagnoses',
            hint: 'One per line or comma-separated',
            maxLines: 2,
          ),
        ],
      ),
    );
  }

  Widget _followUpPlanCard() {
    const key = 'op_follow_up_plan';
    return _ToolCard(
      module: _module(
        key,
        'Follow-Up Plan Draft',
        'Monitoring, repeat tests, review timing, and escalation cues.',
      ),
      icon: Icons.event_repeat_outlined,
      busy: _busyKey == key,
      onSubmit: _followUpPlan,
      submitLabel: 'Draft follow-up',
      child: Column(
        children: [
          _Field(
            controller: _diagnosisController,
            label: 'Diagnosis / working diagnosis',
            maxLines: 2,
          ),
          const SizedBox(height: 10),
          _Field(
            controller: _treatmentPlanController,
            label: 'Treatment plan',
            maxLines: 4,
          ),
          const SizedBox(height: 10),
          _Field(
            controller: _monitoringController,
            label: 'Monitoring context (optional)',
            maxLines: 3,
          ),
        ],
      ),
    );
  }

  Widget _referralDraftCard() {
    const key = 'op_referral_draft';
    return _ToolCard(
      module: _module(
        key,
        'Referral / Second Opinion Draft',
        'Structured referral draft for clinician editing.',
      ),
      icon: Icons.forward_to_inbox_outlined,
      busy: _busyKey == key,
      onSubmit: _referralDraft,
      submitLabel: 'Draft referral',
      child: Column(
        children: [
          _Field(
            controller: _referralReasonController,
            label: 'Referral reason',
            maxLines: 2,
          ),
          const SizedBox(height: 10),
          _Field(
            controller: _targetSpecialtyController,
            label: 'Target specialty (optional)',
          ),
          const SizedBox(height: 10),
          _Field(
            controller: _clinicalSummaryController,
            label: 'Clinical summary',
            maxLines: 5,
          ),
          const SizedBox(height: 10),
          _Field(
            controller: _currentTreatmentController,
            label: 'Current treatment (optional)',
            maxLines: 3,
          ),
        ],
      ),
    );
  }

  Widget _voiceNoteCard() {
    final module = _module(
      'soap_from_dictation',
      'Voice Note to SOAP Draft',
      'Convert clinician voice-note transcripts into reviewable SOAP drafts.',
    );
    return _ToolCard(
      module: module,
      icon: Icons.mic_none_outlined,
      busy: false,
      onSubmit: module.enabled
          ? () => context.push('/clinical-ai/voice-notes')
          : null,
      submitLabel: 'Open voice notes',
      child: Text(
        'Completed transcripts can be converted into SOAP drafts for clinician review.',
        style: TextStyle(color: AppTheme.textSecondary),
      ),
    );
  }
}

class _OpAiModule {
  const _OpAiModule({
    required this.key,
    required this.label,
    required this.purpose,
    required this.enabled,
  });

  final String key;
  final String label;
  final String purpose;
  final bool enabled;

  factory _OpAiModule.fromJson(Map<String, dynamic> json) {
    return _OpAiModule(
      key: json['module_key']?.toString() ?? json['key']?.toString() ?? '',
      label:
          json['display_name']?.toString() ??
          json['label']?.toString() ??
          'Clinical AI service',
      purpose:
          json['description']?.toString() ?? json['purpose']?.toString() ?? '',
      enabled: opAiModuleEnabled(json),
    );
  }
}

class _GovernanceBand extends StatelessWidget {
  const _GovernanceBand({required this.enabledCount, required this.totalCount});

  final int enabledCount;
  final int totalCount;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 1180),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: AppTheme.cardSurface,
            border: Border.all(color: AppTheme.divider),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                _StatusChip(
                  icon: Icons.admin_panel_settings_outlined,
                  label: '$enabledCount/$totalCount enabled by Admin',
                  color: AppTheme.primaryBlue,
                ),
                const _StatusChip(
                  icon: Icons.verified_user_outlined,
                  label: 'Doctor decision support',
                  color: AppTheme.primaryTeal,
                ),
                const _StatusChip(
                  icon: Icons.assignment_turned_in_outlined,
                  label: 'Clinician sign-off required',
                  color: AppTheme.warningAmber,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ToolCard extends StatelessWidget {
  const _ToolCard({
    required this.module,
    required this.icon,
    required this.busy,
    required this.submitLabel,
    required this.child,
    this.onSubmit,
  });

  final _OpAiModule module;
  final IconData icon;
  final bool busy;
  final String submitLabel;
  final Widget child;
  final VoidCallback? onSubmit;

  @override
  Widget build(BuildContext context) {
    final enabled = module.enabled;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(
                    color: enabled
                        ? AppTheme.primaryBlue.withValues(alpha: 0.10)
                        : Colors.grey.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Icon(
                    icon,
                    color: enabled ? AppTheme.primaryBlue : Colors.grey,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        module.label,
                        style: Theme.of(context).textTheme.titleMedium
                            ?.copyWith(fontWeight: FontWeight.w700),
                      ),
                      if (module.purpose.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            module.purpose,
                            style: TextStyle(
                              color: AppTheme.textSecondary,
                              fontSize: 12,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                _ToggleChip(enabled: enabled),
              ],
            ),
            const SizedBox(height: 14),
            child,
            const SizedBox(height: 14),
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton.icon(
                onPressed: enabled && !busy ? onSubmit : null,
                icon: busy
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.auto_awesome, size: 16),
                label: Text(enabled ? submitLabel : 'Disabled in Admin'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({
    required this.controller,
    required this.label,
    this.hint,
    this.maxLines = 1,
    this.keyboardType,
  });

  final TextEditingController controller;
  final String label;
  final String? hint;
  final int maxLines;
  final TextInputType? keyboardType;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      keyboardType: keyboardType,
      maxLines: maxLines,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        border: const OutlineInputBorder(),
        isDense: true,
      ),
    );
  }
}

class _ToggleChip extends StatelessWidget {
  const _ToggleChip({required this.enabled});

  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final color = enabled ? AppTheme.successGreen : Colors.grey;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            enabled ? Icons.toggle_on_outlined : Icons.toggle_off_outlined,
            size: 16,
            color: color,
          ),
          const SizedBox(width: 4),
          Text(
            enabled ? 'On' : 'Off',
            style: TextStyle(
              color: color,
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({
    required this.icon,
    required this.label,
    required this.color,
  });

  final IconData icon;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: color),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _ResultMeta extends StatelessWidget {
  const _ResultMeta({required this.result});

  final Map<String, dynamic> result;

  @override
  Widget build(BuildContext context) {
    final moduleKey = result['module_key']?.toString() ?? 'unknown';
    final provider = result['provider']?.toString() ?? 'template';
    final reviewId = result['review_id']?.toString();
    final usedAi = result['used_ai'] == true ? 'AI used' : 'Template/rules';
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        _StatusChip(
          icon: Icons.extension_outlined,
          label: moduleKey,
          color: AppTheme.primaryBlue,
        ),
        _StatusChip(
          icon: Icons.memory_outlined,
          label: '$provider - $usedAi',
          color: AppTheme.primaryTeal,
        ),
        if (reviewId != null && reviewId != 'null')
          _StatusChip(
            icon: Icons.fact_check_outlined,
            label: 'Review #$reviewId',
            color: AppTheme.warningAmber,
          ),
      ],
    );
  }
}

class _AccessRestrictedPanel extends StatelessWidget {
  const _AccessRestrictedPanel({required this.role});

  final StaffRole role;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.lock_outline, color: AppTheme.primaryBlue),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'OP Doctor Assist unavailable',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              'This OP clinical decision-support workspace is available to doctors, duty doctors, and the medical superintendent. ${role.displayName} can continue using the Clinical AI review queue where permitted.',
              style: TextStyle(color: AppTheme.textSecondary),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: () => context.push('/clinical-ai/queue'),
                  icon: const Icon(Icons.fact_check_outlined, size: 16),
                  label: const Text('Review queue'),
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(0, 40),
                  ),
                ),
                OutlinedButton.icon(
                  onPressed: () => context.go('/dashboard'),
                  icon: const Icon(Icons.dashboard_outlined, size: 16),
                  label: const Text('Dashboard'),
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(0, 40),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, color: AppTheme.errorOnSurface, size: 40),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh, size: 16),
              label: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }
}
