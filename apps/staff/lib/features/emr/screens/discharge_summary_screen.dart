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
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
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
      final wrapper = result['discharge_summary'];
      if (wrapper is Map) {
        final item = Map<String, dynamic>.from(wrapper);
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
      }
    } catch (e) {
      setState(() => _error = 'Could not load existing summary: $e');
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
        _summaryEnvelope = null;
        _isSigned = false;
      });
    } catch (e) {
      setState(() => _error = 'Failed to generate summary: $e');
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
    final meds = summary['medications_on_discharge'];
    final medLines = meds is List
        ? meds
              .map((med) {
                if (med is! Map) return med.toString();
                final name =
                    med['name'] ?? med['medication_name'] ?? 'Medication';
                final dose = med['dose'] ?? med['dosage'] ?? '';
                final route = med['route'] ?? '';
                final frequency = med['frequency'] ?? '';
                final duration = med['duration'] ?? '';
                return '$name $dose $route $frequency $duration'.trim();
              })
              .join('\n')
        : 'Not documented';
    return [
      'DISCHARGE SUMMARY',
      '',
      'Name of the Patient : ${widget.patientName}',
      '',
      'DIAGNOSIS:',
      summary['discharge_diagnosis'] ?? 'Not documented',
      '',
      'COURSE IN THE HOSPITAL:',
      summary['hospital_course'] ?? 'Not documented',
      '',
      'CONDITION AT DISCHARGE:',
      summary['discharge_condition'] ?? 'Not documented',
      '',
      'ADVISED TO CONTINUE:',
      medLines,
      '',
      'FOLLOW UP:',
      summary['follow_up_instructions'] ?? 'Review as advised.',
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
      setState(() => _error = 'Failed to save: $e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _sign() async {
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
      setState(() => _error = 'Failed to sign: $e');
    } finally {
      if (mounted) setState(() => _signing = false);
    }
  }

  Future<void> _proceedToDischarge() async {
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
      setState(() => _error = 'Discharge failed: $e');
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
    final flags = _listOfMaps(_summary?['safety_flags']);
    final theme = Theme.of(context);
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Safety flags', style: theme.textTheme.titleLarge),
              const SizedBox(height: 12),
              if (flags.isEmpty)
                Text(
                  'No safety flags are attached to this summary.',
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
                                  'Doctor review required')
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
                      child: const Text('Close'),
                    ),
                  ),
                  if (!_isSigned && flags.isNotEmpty) ...[
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: () => Navigator.pop(ctx),
                        icon: const Icon(Icons.edit_note),
                        label: const Text('Correct summary'),
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
        title: const Text('Signature details'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (!_isSigned)
              const Text('This summary has not been signed yet.')
            else ...[
              Text(
                signedByName.isNotEmpty ? signedByName : 'Signer unavailable',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              if (signedByRole.isNotEmpty) Text(signedByRole),
              if (signedBy.isNotEmpty) Text('User ID: $signedBy'),
              if (signedAt.isNotEmpty) Text('Signed at: $signedAt'),
            ],
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Close'),
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
        title: Text('${s.dischargeTitlePrefix} ${widget.patientName}'),
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
                        child: OutlinedButton.icon(
                          onPressed: _signing ? null : _sign,
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
                    if (!_isSigned) const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: _isSigned ? _proceedToDischarge : null,
                        icon: const Icon(Icons.exit_to_app),
                        label: Text(s.dischargePatientButton),
                        style: FilledButton.styleFrom(
                          backgroundColor: _isSigned ? Colors.red : Colors.grey,
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
            'Hospital formatted summary',
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
                  title: Text(med['name']?.toString() ?? 'Unknown'),
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
                  title: Text(inv['test']?.toString() ?? 'Test'),
                  subtitle: Text(
                    '${inv['status'] ?? ''} — ${inv['result'] ?? 'Pending'}',
                  ),
                ),
              ),
            ),
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
                  title: Text(proc?.toString() ?? 'Procedure'),
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

  Widget _buildAiBanner(ThemeData theme) {
    final metadata = _summary?['ai_metadata'];
    final citations = _summary?['source_citations'];
    final flags = _summary?['safety_flags'];
    final ai = metadata is Map ? Map<String, dynamic>.from(metadata) : {};
    final usedAi = ai['used_ai'] == true;
    final fallback = (ai['fallback_reason'] ?? '').toString();
    final sourceCount = citations is List ? citations.length : 0;
    final flagCount = flags is List ? flags.length : 0;
    final label = usedAi
        ? 'AI-generated draft - doctor review required'
        : fallback.isNotEmpty
        ? 'Fallback draft - AI unavailable'
        : 'Structured draft - doctor review required';

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
          Chip(
            visualDensity: VisualDensity.compact,
            label: Text('$sourceCount sources'),
          ),
          ActionChip(
            visualDensity: VisualDensity.compact,
            avatar: Icon(
              Icons.health_and_safety,
              color: flagCount > 0
                  ? AppTheme.errorOnSurface
                  : theme.colorScheme.primary,
              size: 16,
            ),
            side: flagCount > 0
                ? BorderSide(color: AppTheme.errorOnSurface)
                : null,
            onPressed: _showSafetyFlags,
            label: Text('$flagCount safety flags'),
          ),
        ],
      ),
    );
  }

  Widget _buildSection(
    String label,
    TextEditingController controller, {
    int maxLines = 4,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: TextField(
        controller: controller,
        maxLines: maxLines,
        readOnly: _isSigned,
        style: Theme.of(context).textTheme.bodyMedium,
        decoration: InputDecoration(
          labelText: label,
          border: const OutlineInputBorder(),
        ),
      ),
    );
  }
}
