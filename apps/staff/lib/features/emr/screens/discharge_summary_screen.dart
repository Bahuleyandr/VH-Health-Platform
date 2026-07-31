// lib/features/emr/screens/discharge_summary_screen.dart
//
// Auto-generated discharge summary screen.
// Flow: Generate → Review/Edit → Sign (doctor only) → Discharge
//
// The summary is auto-populated from ward notes, vitals, investigations,
// medications, and diagnoses. It can be freely edited until signed.
// Once signed by a doctor, it becomes the official discharge summary.

import 'dart:async';
import 'package:flutter/material.dart';
import '../../../core/models/care_pathway_work_models.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/online_only_action_state.dart';
import '../../../l10n/app_strings.dart';

class DischargeSummaryScreen extends StatefulWidget {
  final int admissionId;
  final String patientName;

  const DischargeSummaryScreen({
    super.key,
    required this.admissionId,
    required this.patientName,
  });

  @override
  State<DischargeSummaryScreen> createState() => _DischargeSummaryScreenState();
}

class _DischargeSummaryScreenState extends State<DischargeSummaryScreen> {
  bool _loading = false;
  bool _generating = false;
  bool _signing = false;
  bool _saving = false;
  Map<String, dynamic>? _summary;
  Map<String, dynamic>? _summaryEnvelope;
  bool _isSigned = false;
  String? _error;

  // Editable controllers
  final _formattedSummaryCtrl = TextEditingController();
  final _hospitalCourseCtrl = TextEditingController();
  final _dischargeDiagnosisCtrl = TextEditingController();
  final _dischargeConditionCtrl = TextEditingController();
  final _followUpCtrl = TextEditingController();
  final _activityCtrl = TextEditingController();
  final _dietCtrl = TextEditingController();
  final _warningSignsCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _loadExistingSummary();
  }

  @override
  void dispose() {
    _formattedSummaryCtrl.dispose();
    _hospitalCourseCtrl.dispose();
    _dischargeDiagnosisCtrl.dispose();
    _dischargeConditionCtrl.dispose();
    _followUpCtrl.dispose();
    _activityCtrl.dispose();
    _dietCtrl.dispose();
    _warningSignsCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadExistingSummary() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await MedicalApiService.getDischargeSummary(
        widget.admissionId,
      );
      final pathwayMetadata = <String, dynamic>{
        for (final key in [
          'pathway_mode',
          'pending_results',
          'pending_result_handoffs',
        ])
          if (result[key] != null) key: result[key],
      };
      final wrapper = result['discharge_summary'];
      if (wrapper is Map) {
        final item = Map<String, dynamic>.from(wrapper);
        for (final entry in pathwayMetadata.entries) {
          item.putIfAbsent(entry.key, () => entry.value);
        }
        final content = item['content'];
        if (content is Map) {
          final summary = Map<String, dynamic>.from(content);
          _mergeSummaryEnvelope(summary, item);
          _populateControllers(summary);
          setState(() {
            _summary = summary;
            _summaryEnvelope = item;
            _isSigned =
                item['is_signed'] == true || summary['is_signed'] == true;
          });
        }
      } else if (pathwayMetadata.isNotEmpty) {
        setState(() => _summaryEnvelope = pathwayMetadata);
      }
    } catch (e) {
      if (!mounted) return;
      final s = AppStrings.of(context);
      setState(
        () => _error = s.format('s4.dynamic.discharge_summary.load_error', {
          'error': e,
        }),
      );
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _generate() async {
    setState(() {
      _generating = true;
      _error = null;
    });
    try {
      final result = await MedicalApiService.generateDischargeSummary(
        widget.admissionId,
      );
      final summary =
          result['discharge_summary'] as Map<String, dynamic>? ?? {};
      _populateControllers(summary);
      setState(() {
        _summary = summary;
        _isSigned = false;
      });
    } catch (e) {
      if (!mounted) return;
      final s = AppStrings.of(context);
      setState(
        () => _error = s.format('s4.dynamic.discharge_summary.generate_error', {
          'error': e,
        }),
      );
    } finally {
      if (mounted) setState(() => _generating = false);
    }
  }

  void _mergeSummaryEnvelope(
    Map<String, dynamic> summary,
    Map<String, dynamic> envelope,
  ) {
    for (final key in [
      'ai_metadata',
      'safety_flags',
      'source_citations',
      'is_signed',
      'signed_by',
      'signed_by_name',
      'signed_by_role',
      'signed_at',
      'source',
      'note_id',
    ]) {
      if (summary[key] == null && envelope[key] != null) {
        summary[key] = envelope[key];
      }
    }
  }

  void _populateControllers(Map<String, dynamic> summary) {
    _formattedSummaryCtrl.text =
        summary['formatted_summary']?.toString() ??
        _fallbackFormattedSummary(summary);
    _hospitalCourseCtrl.text = summary['hospital_course']?.toString() ?? '';
    _dischargeDiagnosisCtrl.text =
        summary['discharge_diagnosis']?.toString() ?? '';
    _dischargeConditionCtrl.text =
        summary['discharge_condition']?.toString() ?? '';
    _followUpCtrl.text = summary['follow_up_instructions']?.toString() ?? '';
    _activityCtrl.text = summary['activity_restrictions']?.toString() ?? '';
    _dietCtrl.text = summary['diet_instructions']?.toString() ?? '';
    _warningSignsCtrl.text = summary['warning_signs']?.toString() ?? '';
  }

  Map<String, dynamic> _buildSummaryFromControllers() {
    return {
      ...?_summary,
      'formatted_summary': _formattedSummaryCtrl.text,
      'hospital_course': _hospitalCourseCtrl.text,
      'discharge_diagnosis': _dischargeDiagnosisCtrl.text,
      'discharge_condition': _dischargeConditionCtrl.text,
      'follow_up_instructions': _followUpCtrl.text,
      'activity_restrictions': _activityCtrl.text,
      'diet_instructions': _dietCtrl.text,
      'warning_signs': _warningSignsCtrl.text,
    };
  }

  String _fallbackFormattedSummary(Map<String, dynamic> summary) {
    final s = AppStrings.of(context);
    final medication = s.lookup('s4.lib.discharge_summary.medication');
    final notDocumented = s.lookup('s4.lib.discharge_summary.not_documented');
    final meds = summary['medications_on_discharge'];
    final medLines = meds is List
        ? meds
              .map((med) {
                if (med is! Map) return med.toString();
                final name =
                    med['name'] ?? med['medication_name'] ?? medication;
                final dose = med['dose'] ?? med['dosage'] ?? '';
                final route = med['route'] ?? '';
                final frequency = med['frequency'] ?? '';
                final duration = med['duration'] ?? '';
                return '$name $dose $route $frequency $duration'.trim();
              })
              .join('\n')
        : notDocumented;
    return [
      s.lookup('s4.lib.discharge_summary.fallback_title'),
      '',
      s.format('s4.dynamic.discharge_summary.patient_name_line', {
        'patient': widget.patientName,
      }),
      '',
      s.lookup('s4.lib.discharge_summary.diagnosis_heading'),
      summary['discharge_diagnosis'] ?? notDocumented,
      '',
      s.lookup('s4.lib.discharge_summary.hospital_course_heading'),
      summary['hospital_course'] ?? notDocumented,
      '',
      s.lookup('s4.lib.discharge_summary.condition_heading'),
      summary['discharge_condition'] ?? notDocumented,
      '',
      s.lookup('s4.lib.discharge_summary.advised_to_continue_heading'),
      medLines,
      '',
      s.lookup('s4.lib.discharge_summary.follow_up_heading'),
      summary['follow_up_instructions'] ??
          s.lookup('s4.lib.discharge_summary.review_as_advised'),
    ].join('\n');
  }

  Future<void> _save() async {
    final s = AppStrings.of(context);
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final edited = _buildSummaryFromControllers();
      await MedicalApiService.saveDischargeSummary(widget.admissionId, edited);
      if (mounted) setState(() => _summary = edited);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.dischargeDraftSaved),
            backgroundColor: Colors.green,
          ),
        );
      }
    } catch (e) {
      setState(
        () => _error = s.format('s4.dynamic.discharge_summary.save_error', {
          'error': e,
        }),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _sign() async {
    if (!OnlineOnlyActionGuard.require(context)) return;
    final s = AppStrings.of(context);
    // Confirm before signing
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.dischargeSignDialogTitle),
        content: Text(s.dischargeSignDialogBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(s.dischargeSignButton),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    // Save latest edits first
    await _save();

    setState(() {
      _signing = true;
      _error = null;
    });
    try {
      await MedicalApiService.signDischargeSummary(widget.admissionId);
      await _loadExistingSummary();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.dischargeSignedSuccess),
            backgroundColor: Colors.green,
          ),
        );
      }
    } catch (e) {
      setState(
        () => _error = s.format('s4.dynamic.discharge_summary.sign_error', {
          'error': e,
        }),
      );
    } finally {
      if (mounted) setState(() => _signing = false);
    }
  }

  Future<void> _proceedToDischarge() async {
    if (!OnlineOnlyActionGuard.require(context)) return;
    final s = AppStrings.of(context);
    if (!_isSigned) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.dischargeMustSignFirst),
          backgroundColor: Colors.orange,
        ),
      );
      return;
    }

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.dischargeProceedTitle),
        content: Text('${s.dischargeProceedBodyPrefix} ${widget.patientName}'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(s.dischargeProceedButton),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() => _loading = true);
    try {
      final summary = _buildSummaryFromControllers();
      await MedicalApiService.dischargePatient(widget.admissionId, {
        'discharge_type': 'home',
        'discharge_summary': summary,
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.dischargePatientDischarged),
            backgroundColor: Colors.green,
          ),
        );
        Navigator.of(context).pop(true); // Return to admission list
      }
    } catch (e) {
      setState(
        () => _error = s.format(
          's4.dynamic.discharge_summary.discharge_error',
          {'error': e},
        ),
      );
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  List<Map<String, dynamic>> _listOfMaps(dynamic value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList(growable: false);
  }

  Future<void> _showSafetyFlags() async {
    final s = AppStrings.of(context);
    final flags = _listOfMaps(_summary?['safety_flags']);
    final theme = Theme.of(context);
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      backgroundColor: theme.colorScheme.surface,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AppText(
                'clinical_ai.draft.safety_header',
                style: theme.textTheme.titleLarge,
              ),
              const SizedBox(height: 12),
              if (flags.isEmpty)
                AppText(
                  's4.lib.discharge_hub.no_safety_flags_are_attached_to_this_summary',
                  style: theme.textTheme.bodyMedium,
                )
              else
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 320),
                  child: ListView.separated(
                    shrinkWrap: true,
                    itemCount: flags.length,
                    separatorBuilder: (_, separatorIndex) =>
                        const Divider(height: 16),
                    itemBuilder: (context, index) {
                      final flag = flags[index];
                      final severity = (flag['severity'] ?? 'review')
                          .toString()
                          .toUpperCase();
                      final code = (flag['code'] ?? flag['type'] ?? 'FLAG')
                          .toString();
                      final message =
                          (flag['message'] ??
                                  flag['description'] ??
                                  flag['reason'] ??
                                  s.lookup(
                                    's4.lib.discharge_summary.doctor_review_required',
                                  ))
                              .toString();
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(
                          Icons.health_and_safety,
                          color: theme.colorScheme.error,
                        ),
                        title: Text('$severity - $code'),
                        subtitle: Text(message),
                      );
                    },
                  ),
                ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => Navigator.pop(ctx),
                      child: const AppText('action.close'),
                    ),
                  ),
                  if (!_isSigned && flags.isNotEmpty) ...[
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: () => Navigator.pop(ctx),
                        icon: const Icon(Icons.edit_note),
                        label: const AppText(
                          's4.lib.discharge_summary.correct_summary',
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _showSignerDetails() async {
    final summary = _summary ?? const <String, dynamic>{};
    final envelope = _summaryEnvelope ?? const <String, dynamic>{};
    final signedByName =
        (summary['signed_by_name'] ?? envelope['signed_by_name'] ?? '')
            .toString()
            .trim();
    final signedByRole =
        (summary['signed_by_role'] ?? envelope['signed_by_role'] ?? '')
            .toString()
            .trim();
    final signedBy = (summary['signed_by'] ?? envelope['signed_by'] ?? '')
        .toString()
        .trim();
    final signedAt = (summary['signed_at'] ?? envelope['signed_at'] ?? '')
        .toString()
        .trim();
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const AppText('s4.lib.discharge_hub.signature_details'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (!_isSigned)
              const AppText(
                's4.lib.discharge_summary.this_summary_has_not_been_signed_yet',
              )
            else ...[
              Text(
                signedByName.isNotEmpty
                    ? signedByName
                    : AppStrings.of(
                        context,
                      ).lookup('s4.lib.discharge_summary.signer_unavailable'),
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              if (signedByRole.isNotEmpty) Text(signedByRole),
              if (signedBy.isNotEmpty)
                AppText(
                  's4.dynamic.common.user_id',
                  values: {'userId': signedBy},
                ),
              if (signedAt.isNotEmpty)
                AppText(
                  's4.dynamic.common.signed_at',
                  values: {'signedAt': signedAt},
                ),
            ],
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const AppText('action.close'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);

    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: AppText(
          's4.dynamic.discharge_summary.title_for_patient',
          values: {
            'prefix': s.dischargeTitlePrefix,
            'patient': widget.patientName,
          },
        ),
        actions: [
          if (_summary != null && !_isSigned)
            TextButton.icon(
              onPressed: _saving ? null : _save,
              icon: _saving
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.save_outlined),
              label: Text(s.dischargeSaveDraft),
            ),
          const LogoutAction(),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _summary == null
          ? _buildGeneratePrompt(theme)
          : _buildSummaryEditor(theme),
      bottomNavigationBar: _summary != null
          ? SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    if (!_isSigned)
                      Expanded(
                        child: OnlineOnlyActionState(
                          builder: (context, isOnline, offlineMessage) =>
                              Tooltip(
                                message: isOnline ? '' : offlineMessage,
                                child: OutlinedButton.icon(
                                  onPressed: _signing || !isOnline
                                      ? null
                                      : _sign,
                                  icon: _signing
                                      ? const SizedBox(
                                          width: 16,
                                          height: 16,
                                          child: CircularProgressIndicator(
                                            strokeWidth: 2,
                                          ),
                                        )
                                      : const Icon(Icons.verified_outlined),
                                  label: Text(s.dischargeSignSummary),
                                ),
                              ),
                        ),
                      ),
                    if (!_isSigned) const SizedBox(width: 12),
                    Expanded(
                      child: OnlineOnlyActionState(
                        builder: (context, isOnline, offlineMessage) => Tooltip(
                          message: isOnline ? '' : offlineMessage,
                          child: FilledButton.icon(
                            onPressed: _isSigned && isOnline
                                ? _proceedToDischarge
                                : null,
                            icon: const Icon(Icons.exit_to_app),
                            label: Text(s.dischargePatientButton),
                            style: FilledButton.styleFrom(
                              backgroundColor: _isSigned
                                  ? Colors.red
                                  : Colors.grey,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            )
          : null,
    );
  }

  Widget _buildGeneratePrompt(ThemeData theme) {
    final s = AppStrings.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.summarize_outlined,
              size: 64,
              color: theme.colorScheme.primary,
            ),
            const SizedBox(height: 16),
            Text(s.dischargeGenerateTitle, style: theme.textTheme.titleLarge),
            const SizedBox(height: 8),
            Text(
              s.dischargeGenerateBody,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: _generating ? null : _generate,
              icon: _generating
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Icon(Icons.auto_awesome),
              label: Text(
                _generating ? s.dischargeGenerating : s.dischargeGenerateButton,
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildSummaryEditor(ThemeData theme) {
    final s = AppStrings.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_isSigned)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: Material(
                color: AppTheme.successOnSurface.withValues(alpha: 0.12),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8),
                  side: BorderSide(color: AppTheme.successOnSurface),
                ),
                child: InkWell(
                  onTap: _showSignerDetails,
                  borderRadius: BorderRadius.circular(8),
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      children: [
                        Icon(Icons.verified, color: AppTheme.successOnSurface),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            s.dischargeSignedBadge,
                            style: TextStyle(
                              color: AppTheme.successOnSurface,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        Icon(
                          Icons.info_outline,
                          color: AppTheme.successOnSurface,
                          size: 18,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          if (_error != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(
                color: AppTheme.errorOnSurface.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: AppTheme.errorOnSurface.withValues(alpha: 0.35),
                ),
              ),
              child: Text(
                _error!,
                style: TextStyle(color: AppTheme.errorOnSurface),
              ),
            ),
          _buildAiBanner(theme),
          const SizedBox(height: 16),

          _buildSection(
            s.lookup('s4.lib.discharge_summary.hospital_formatted_summary'),
            _formattedSummaryCtrl,
            maxLines: 18,
          ),
          _buildSection(
            s.dischargeSectionHospitalCourse,
            _hospitalCourseCtrl,
            maxLines: 8,
          ),
          _buildSection(
            s.dischargeSectionDiagnosis,
            _dischargeDiagnosisCtrl,
            maxLines: 3,
          ),
          _buildSection(
            s.dischargeSectionCondition,
            _dischargeConditionCtrl,
            maxLines: 2,
          ),
          _buildSection(s.dischargeSectionFollowUp, _followUpCtrl, maxLines: 4),
          _buildSection(s.dischargeSectionActivity, _activityCtrl, maxLines: 3),
          _buildSection(s.dischargeSectionDiet, _dietCtrl, maxLines: 3),
          _buildSection(
            s.dischargeSectionWarningSigns,
            _warningSignsCtrl,
            maxLines: 4,
          ),

          // Medications on discharge (read-only)
          if (_summary?['medications_on_discharge'] != null) ...[
            const SizedBox(height: 16),
            Text(
              s.dischargeSectionMedications,
              style: theme.textTheme.titleSmall,
            ),
            const SizedBox(height: 8),
            ...(_summary!['medications_on_discharge'] as List).map(
              (med) => Card(
                child: ListTile(
                  leading: const Icon(Icons.medication),
                  title: Text(
                    med['name']?.toString() ??
                        s.lookup('s4.lib.discharge_summary.unknown_item'),
                  ),
                  subtitle: Text(
                    '${med['dose'] ?? ''} ${med['route'] ?? ''} ${med['frequency'] ?? ''}',
                  ),
                ),
              ),
            ),
          ],

          // Investigations summary (read-only)
          if (_summary?['investigations_summary'] != null) ...[
            const SizedBox(height: 16),
            Text(
              s.dischargeSectionInvestigations,
              style: theme.textTheme.titleSmall,
            ),
            const SizedBox(height: 8),
            ...(_summary!['investigations_summary'] as List).map(
              (inv) => Card(
                child: ListTile(
                  leading: const Icon(Icons.biotech),
                  title: Text(
                    inv['test']?.toString() ??
                        s.lookup('s4.lib.discharge_summary.test_fallback'),
                  ),
                  subtitle: Text(
                    '${inv['status'] ?? ''} — ${inv['result'] ?? s.lookup('s4.lib.discharge_summary.pending_result')}',
                  ),
                ),
              ),
            ),
          ],

          if (_pendingResultHandoffs.isNotEmpty) ...[
            const SizedBox(height: 16),
            _buildPendingResultReview(theme),
          ],

          // Procedures (read-only)
          if (_summary?['procedures_performed'] != null &&
              (_summary!['procedures_performed'] as List).isNotEmpty) ...[
            const SizedBox(height: 16),
            Text(
              s.dischargeSectionProcedures,
              style: theme.textTheme.titleSmall,
            ),
            const SizedBox(height: 8),
            ...(_summary!['procedures_performed'] as List).map(
              (proc) => Card(
                child: ListTile(
                  leading: const Icon(Icons.medical_services),
                  title: Text(
                    proc?.toString() ??
                        s.lookup('s4.lib.discharge_summary.procedure_fallback'),
                  ),
                ),
              ),
            ),
          ],

          const SizedBox(height: 24),
          if (!_isSigned)
            Center(
              child: TextButton.icon(
                onPressed: _generate,
                icon: const Icon(Icons.refresh),
                label: Text(s.dischargeRegenerate),
              ),
            ),
          const SizedBox(height: 80), // space for bottom bar
        ],
      ),
    );
  }

  List<DischargePendingResultHandoff> get _pendingResultHandoffs {
    final summary = _summary ?? const <String, dynamic>{};
    final envelope = _summaryEnvelope ?? const <String, dynamic>{};
    var raw =
        summary['pending_result_handoffs'] ??
        summary['pending_results'] ??
        envelope['pending_result_handoffs'] ??
        envelope['pending_results'];
    if (raw is Map) {
      raw = raw['items'] ?? raw['pending_result_handoffs'];
    }
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map(
          (item) => DischargePendingResultHandoff.fromJson(
            Map<String, dynamic>.from(item),
          ),
        )
        .toList(growable: false);
  }

  Widget _buildPendingResultReview(ThemeData theme) {
    final s = AppStrings.of(context);
    final mode = _pendingResultPathwayMode;
    final explanationKey = switch (mode) {
      'off' => 's4.lib.discharge_hub.pathway_mode_off_explanation',
      'shadow' => 's4.lib.discharge_hub.pathway_mode_shadow_explanation',
      _ => 's4.lib.discharge_summary.pending_result_review_explanation',
    };
    return Card(
      key: const Key('discharge-summary-pending-results'),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.lookup('s4.lib.discharge_summary.pending_result_review'),
              style: theme.textTheme.titleSmall?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 4),
            Text(s.lookup(explanationKey)),
            const SizedBox(height: 10),
            ..._pendingResultHandoffs.map(
              (item) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _buildPendingResultRow(theme, item),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPendingResultRow(
    ThemeData theme,
    DischargePendingResultHandoff item,
  ) {
    final s = AppStrings.of(context);
    final mode = _pendingResultPathwayMode;
    final enforcesBlocking = item.blocking && mode != 'off' && mode != 'shadow';
    final label = item.safeLabel.isEmpty
        ? s.lookup('s4.lib.discharge_hub.pending_result')
        : item.safeLabel;
    final owner = [
      item.ownerName,
      item.ownerRole,
      item.ownerRoute,
    ].whereType<String>().where((part) => part.isNotEmpty).join(' · ');
    final blockerDetails = item.blockerCodes
        .map((code) => code.trim())
        .where((part) => part.isNotEmpty)
        .toSet()
        .toList();

    return Container(
      key: Key('summary-pending-result-${item.sourceType}-${item.sourceId}'),
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color:
            (enforcesBlocking
                    ? AppTheme.errorOnSurface
                    : AppTheme.warningOnSurface)
                .withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color:
              (enforcesBlocking
                      ? AppTheme.errorOnSurface
                      : AppTheme.warningOnSurface)
                  .withValues(alpha: 0.3),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                enforcesBlocking
                    ? Icons.report_outlined
                    : Icons.science_outlined,
                size: 20,
                color: enforcesBlocking
                    ? AppTheme.errorOnSurface
                    : AppTheme.warningOnSurface,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    Text(
                      [
                        item.sourceType.replaceAll('_', ' '),
                        item.currentStatus.replaceAll('_', ' '),
                      ].where((part) => part.isNotEmpty).join(' · '),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            owner.isEmpty
                ? s.lookup('s4.lib.discharge_hub.named_physician_not_recorded')
                : s.format('s4.dynamic.discharge_hub.named_physician', {
                    'owner': owner,
                  }),
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          Text(
            item.summaryIncluded
                ? s.lookup('s4.lib.discharge_hub.included_in_signed_summary')
                : s.lookup('s4.lib.discharge_hub.not_in_signed_summary'),
          ),
          Text(
            item.handoffComplete
                ? s.lookup('s4.lib.discharge_hub.handoff_accepted')
                : s.lookup('s4.lib.discharge_hub.handoff_incomplete'),
          ),
          if (blockerDetails.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              s.lookup(
                mode == 'off' || mode == 'shadow'
                    ? 's4.lib.discharge_hub.review_findings'
                    : 's4.lib.discharge_hub.blocking_reasons',
              ),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            ...blockerDetails.map((reason) => Text('• $reason')),
          ],
        ],
      ),
    );
  }

  String get _pendingResultPathwayMode {
    final summary = _summary ?? const <String, dynamic>{};
    final envelope = _summaryEnvelope ?? const <String, dynamic>{};
    return (summary['pathway_mode'] ?? envelope['pathway_mode'] ?? '')
        .toString()
        .trim()
        .toLowerCase();
  }

  Widget _buildAiBanner(ThemeData theme) {
    final s = AppStrings.of(context);
    final metadata = _summary?['ai_metadata'];
    final citations = _summary?['source_citations'];
    final flags = _summary?['safety_flags'];
    final ai = metadata is Map ? Map<String, dynamic>.from(metadata) : {};
    final usedAi = ai['used_ai'] == true;
    final fallback = (ai['fallback_reason'] ?? '').toString();
    final sourceCount = citations is List ? citations.length : 0;
    final flagCount = flags is List ? flags.length : 0;
    final label = usedAi
        ? s.lookup('s4.lib.discharge_summary.ai_generated_review_required')
        : fallback.isNotEmpty
        ? s.lookup('s4.lib.discharge_summary.ai_fallback_unavailable')
        : s.lookup('s4.lib.discharge_summary.structured_review_required');

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.primaryContainer.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: theme.colorScheme.primary.withValues(alpha: 0.25),
        ),
      ),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Icon(Icons.auto_awesome, color: theme.colorScheme.primary, size: 18),
          Text(
            label,
            style: theme.textTheme.bodyMedium?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          _infoPill(
            theme,
            sourceCount == 1
                ? s.format('s4.dynamic.discharge_summary.source_count_one', {
                    'count': sourceCount,
                  })
                : s.format('s4.dynamic.discharge_summary.source_count', {
                    'count': sourceCount,
                  }),
            Icons.source_outlined,
          ),
          _safetyFlagButton(theme, flagCount, s),
        ],
      ),
    );
  }

  Widget _infoPill(ThemeData theme, String label, IconData icon) {
    return Chip(
      visualDensity: VisualDensity.compact,
      avatar: Icon(icon, size: 16, color: theme.colorScheme.primary),
      label: Text(label),
      side: BorderSide(color: theme.colorScheme.outlineVariant),
      backgroundColor: theme.colorScheme.surfaceContainerHighest.withValues(
        alpha: 0.65,
      ),
    );
  }

  Widget _safetyFlagButton(ThemeData theme, int flagCount, AppStrings s) {
    final hasFlags = flagCount > 0;
    final color = hasFlags
        ? AppTheme.errorOnSurface
        : theme.colorScheme.primary;
    return OutlinedButton.icon(
      onPressed: _showSafetyFlags,
      icon: Icon(Icons.health_and_safety, size: 18, color: color),
      label: Text(
        hasFlags
            ? flagCount == 1
                  ? s.format('s4.dynamic.discharge_summary.safety_flag_one', {
                      'count': flagCount,
                    })
                  : s.format('s4.dynamic.discharge_summary.safety_flags', {
                      'count': flagCount,
                    })
            : s.lookup('s4.lib.discharge_summary.no_safety_flags'),
      ),
      style: OutlinedButton.styleFrom(
        visualDensity: VisualDensity.compact,
        minimumSize: const Size(0, 38),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        foregroundColor: color,
        side: BorderSide(color: color),
        backgroundColor: color.withValues(alpha: 0.10),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
    );
  }

  InputDecoration _summaryFieldDecoration(ThemeData theme, String label) {
    final fill = theme.brightness == Brightness.dark
        ? const Color(0xFF202032)
        : theme.colorScheme.surface;
    final border = theme.brightness == Brightness.dark
        ? const Color(0xFF4A4A63)
        : theme.colorScheme.outlineVariant;
    final labelColor = theme.brightness == Brightness.dark
        ? const Color(0xFFC8C8D8)
        : theme.colorScheme.onSurfaceVariant;
    final focused = theme.colorScheme.primary;
    return InputDecoration(
      labelText: label,
      filled: true,
      fillColor: fill,
      labelStyle: TextStyle(color: labelColor, fontWeight: FontWeight.w600),
      floatingLabelStyle: TextStyle(
        color: focused,
        fontWeight: FontWeight.w700,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: focused, width: 1.5),
      ),
      disabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: border.withValues(alpha: 0.70)),
      ),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: border),
      ),
    );
  }

  TextStyle _summaryFieldTextStyle(ThemeData theme) {
    return (theme.textTheme.bodyMedium ?? const TextStyle()).copyWith(
      color: theme.brightness == Brightness.dark
          ? const Color(0xFFF1F1F7)
          : theme.colorScheme.onSurface,
      height: 1.35,
      fontWeight: FontWeight.w500,
    );
  }

  TextStyle _summaryFieldLabelStyle(ThemeData theme) {
    return (theme.textTheme.titleSmall ?? const TextStyle()).copyWith(
      color: theme.brightness == Brightness.dark
          ? const Color(0xFFD9D9E6)
          : theme.colorScheme.onSurface,
      fontWeight: FontWeight.w700,
    );
  }

  Widget _buildSection(
    String label,
    TextEditingController controller, {
    int maxLines = 4,
  }) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 2, bottom: 6),
            child: Text(label, style: _summaryFieldLabelStyle(theme)),
          ),
          TextField(
            controller: controller,
            maxLines: maxLines,
            readOnly: _isSigned,
            style: _summaryFieldTextStyle(theme),
            decoration: _summaryFieldDecoration(
              theme,
              label,
            ).copyWith(labelText: null),
          ),
        ],
      ),
    );
  }
}
