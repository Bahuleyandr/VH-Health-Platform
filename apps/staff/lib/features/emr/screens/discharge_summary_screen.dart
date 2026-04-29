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
  bool _isSigned = false;
  String? _error;

  // Editable controllers
  final _hospitalCourseCtrl = TextEditingController();
  final _dischargeDiagnosisCtrl = TextEditingController();
  final _dischargeConditionCtrl = TextEditingController();
  final _followUpCtrl = TextEditingController();
  final _activityCtrl = TextEditingController();
  final _dietCtrl = TextEditingController();
  final _warningSignsCtrl = TextEditingController();

  @override
  void dispose() {
    _hospitalCourseCtrl.dispose();
    _dischargeDiagnosisCtrl.dispose();
    _dischargeConditionCtrl.dispose();
    _followUpCtrl.dispose();
    _activityCtrl.dispose();
    _dietCtrl.dispose();
    _warningSignsCtrl.dispose();
    super.dispose();
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
      setState(() => _error = 'Failed to generate summary: $e');
    } finally {
      if (mounted) setState(() => _generating = false);
    }
  }

  void _populateControllers(Map<String, dynamic> summary) {
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
      'hospital_course': _hospitalCourseCtrl.text,
      'discharge_diagnosis': _dischargeDiagnosisCtrl.text,
      'discharge_condition': _dischargeConditionCtrl.text,
      'follow_up_instructions': _followUpCtrl.text,
      'activity_restrictions': _activityCtrl.text,
      'diet_instructions': _dietCtrl.text,
      'warning_signs': _warningSignsCtrl.text,
    };
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final edited = _buildSummaryFromControllers();
      await MedicalApiService.saveDischargeSummary(widget.admissionId, edited);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Draft saved'),
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
    // Confirm before signing
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Sign Discharge Summary'),
        content: const Text(
          'Once signed, this discharge summary becomes the official record '
          'and cannot be modified (only addenda are allowed).\n\n'
          'Are you sure you want to sign?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Sign'),
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
      setState(() => _isSigned = true);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Discharge summary signed — now official'),
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
    if (!_isSigned) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Discharge summary must be signed by a doctor first'),
          backgroundColor: Colors.orange,
        ),
      );
      return;
    }

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Confirm Discharge'),
        content: Text(
          'Discharge ${widget.patientName}? This will release the bed and finalize the admission.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Discharge'),
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
          const SnackBar(
            content: Text('Patient discharged successfully'),
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

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text('Discharge — ${widget.patientName}'),
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
              label: const Text('Save Draft'),
            ),
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
                          label: const Text('Sign Summary'),
                        ),
                      ),
                    if (!_isSigned) const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: _isSigned ? _proceedToDischarge : null,
                        icon: const Icon(Icons.exit_to_app),
                        label: const Text('Discharge Patient'),
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
            Text(
              'Generate Discharge Summary',
              style: theme.textTheme.titleLarge,
            ),
            const SizedBox(height: 8),
            Text(
              'This will automatically aggregate all ward notes, vitals, '
              'investigations, medications, and diagnoses from this admission '
              'into a structured discharge summary.',
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
              label: Text(_generating ? 'Generating...' : 'Generate Summary'),
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
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_isSigned)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(
                color: Colors.green.shade50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.green),
              ),
              child: const Row(
                children: [
                  Icon(Icons.verified, color: Colors.green),
                  SizedBox(width: 8),
                  Text(
                    'Signed — This summary is now official and immutable',
                    style: TextStyle(
                      color: Colors.green,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
          if (_error != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(
                color: Colors.red.shade50,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                _error!,
                style: TextStyle(color: theme.colorScheme.error),
              ),
            ),

          _buildSection('Hospital Course', _hospitalCourseCtrl, maxLines: 8),
          _buildSection(
            'Discharge Diagnosis',
            _dischargeDiagnosisCtrl,
            maxLines: 3,
          ),
          _buildSection(
            'Discharge Condition',
            _dischargeConditionCtrl,
            maxLines: 2,
          ),
          _buildSection('Follow-up Instructions', _followUpCtrl, maxLines: 4),
          _buildSection('Activity Restrictions', _activityCtrl, maxLines: 3),
          _buildSection('Diet Instructions', _dietCtrl, maxLines: 3),
          _buildSection('Warning Signs', _warningSignsCtrl, maxLines: 4),

          // Medications on discharge (read-only)
          if (_summary?['medications_on_discharge'] != null) ...[
            const SizedBox(height: 16),
            Text('Medications on Discharge', style: theme.textTheme.titleSmall),
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
            Text('Investigations', style: theme.textTheme.titleSmall),
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
            Text('Procedures Performed', style: theme.textTheme.titleSmall),
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
                label: const Text('Regenerate Summary'),
              ),
            ),
          const SizedBox(height: 80), // space for bottom bar
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
        decoration: InputDecoration(
          labelText: label,
          border: const OutlineInputBorder(),
          filled: _isSigned,
          fillColor: _isSigned ? Colors.grey.shade100 : null,
        ),
      ),
    );
  }
}
