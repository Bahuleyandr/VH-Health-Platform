import 'package:flutter/material.dart';

import '../../../core/services/ophthalmology_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';
import '../widgets/ophthalmology_eye_entry_panel.dart';

class OphthalmologyScreen extends StatefulWidget {
  const OphthalmologyScreen({super.key});

  @override
  State<OphthalmologyScreen> createState() => _OphthalmologyScreenState();
}

class _OphthalmologyScreenState extends State<OphthalmologyScreen> {
  final _historyPatientUid = TextEditingController();

  Map<String, dynamic>? _history;
  bool _loadingHistory = false;
  bool _savingExam = false;
  String? _historyError;

  @override
  void dispose() {
    _historyPatientUid.dispose();
    super.dispose();
  }

  Future<void> _recordExam(Map<String, dynamic> payload) async {
    final s = AppStrings.of(context);
    if ((payload['patient_uid'] as String?)?.isEmpty ?? true) {
      _showMessage(s.lookup('s4.lib.ophthalmology.patient_uid_required'));
      return;
    }

    setState(() => _savingExam = true);
    try {
      await OphthalmologyApiService.recordExam(payload);
      if (!mounted) return;
      _showMessage(s.lookup('s4.lib.ophthalmology.exam_recorded'));
      _historyPatientUid.text = payload['patient_uid'] as String;
      await _loadHistory();
    } catch (e) {
      if (mounted) {
        _showMessage(s.lookup('s4.lib.ophthalmology.exam_failed'));
      }
    } finally {
      if (mounted) setState(() => _savingExam = false);
    }
  }

  Future<void> _loadHistory() async {
    final s = AppStrings.of(context);
    final patientUid = _historyPatientUid.text.trim();
    if (patientUid.isEmpty) {
      _showMessage(s.lookup('s4.lib.ophthalmology.patient_uid_required'));
      return;
    }

    setState(() {
      _loadingHistory = true;
      _historyError = null;
    });
    try {
      final data = await OphthalmologyApiService.getPatientHistory(patientUid);
      if (mounted) {
        setState(() {
          _history = data;
          _loadingHistory = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _historyError = s.lookup('s4.lib.ophthalmology.history_failed');
          _loadingHistory = false;
        });
      }
    }
  }

  void _showMessage(String message) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.lookup('s4.lib.ophthalmology.title')),
        actions: const [LogoutAction()],
      ),
      body: Stack(
        children: [
          ListView(
            padding: const EdgeInsets.all(16),
            children: [
              OphthalmologyEyeEntryPanel(onSubmit: _recordExam),
              const SizedBox(height: 16),
              _HistoryPanel(
                controller: _historyPatientUid,
                loading: _loadingHistory,
                error: _historyError,
                history: _history,
                onLoad: _loadHistory,
              ),
            ],
          ),
          if (_savingExam)
            Positioned.fill(
              child: ColoredBox(
                color: Colors.black.withValues(alpha: 0.08),
                child: const Center(child: CircularProgressIndicator()),
              ),
            ),
        ],
      ),
    );
  }
}

class _HistoryPanel extends StatelessWidget {
  final TextEditingController controller;
  final bool loading;
  final String? error;
  final Map<String, dynamic>? history;
  final VoidCallback onLoad;

  const _HistoryPanel({
    required this.controller,
    required this.loading,
    required this.error,
    required this.history,
    required this.onLoad,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final exams = (history?['exams'] as List?) ?? const [];
    final latestGlasses = (history?['latest_glasses'] as List?) ?? const [];

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
                  child: AppText(
                    's4.lib.ophthalmology.history',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                IconButton(
                  key: const Key('ophtho_load_history'),
                  tooltip: s.lookup('s4.lib.ophthalmology.load_history'),
                  onPressed: loading ? null : onLoad,
                  icon: const Icon(Icons.search),
                ),
              ],
            ),
            const SizedBox(height: 10),
            TextField(
              key: const Key('ophtho_history_patient_uid'),
              controller: controller,
              decoration: InputDecoration(
                labelText: s.lookup('s4.lib.ophthalmology.patient_uid'),
                border: const OutlineInputBorder(),
              ),
              onSubmitted: (_) => onLoad(),
            ),
            const SizedBox(height: 16),
            if (loading)
              const Center(child: CircularProgressIndicator())
            else if (error != null)
              Text(error!, style: TextStyle(color: AppTheme.errorOnSurface))
            else if (history == null)
              const AppText('s4.lib.ophthalmology.history_empty_state')
            else if (exams.isEmpty)
              const AppText('s4.lib.ophthalmology.no_history')
            else ...[
              _LatestGlasses(rows: latestGlasses),
              const SizedBox(height: 12),
              for (final row in exams)
                _ExamSummaryCard(exam: Map<String, dynamic>.from(row as Map)),
            ],
          ],
        ),
      ),
    );
  }
}

class _LatestGlasses extends StatelessWidget {
  final List<dynamic> rows;

  const _LatestGlasses({required this.rows});

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AppText(
          's4.lib.ophthalmology.latest_glasses',
          style: Theme.of(context).textTheme.titleSmall,
        ),
        const SizedBox(height: 6),
        for (final row in rows)
          Text(
            _formatRefraction(Map<String, dynamic>.from(row as Map)),
            style: TextStyle(color: AppTheme.textSecondary),
          ),
      ],
    );
  }
}

class _ExamSummaryCard extends StatelessWidget {
  final Map<String, dynamic> exam;

  const _ExamSummaryCard({required this.exam});

  @override
  Widget build(BuildContext context) {
    final biometries = (exam['biometries'] as List?) ?? const [];
    final attachments = (exam['imaging_attachments'] as List?) ?? const [];
    final refractions = (exam['refractions'] as List?) ?? const [];

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.visibility_outlined, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '${exam['exam_type'] ?? ''}  ${exam['recorded_at'] ?? ''}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            _MetricRow(
              labelKey: 's4.lib.ophthalmology.iop_mmhg',
              value:
                  '${exam['od_iop_mmhg'] ?? '-'} / ${exam['os_iop_mmhg'] ?? '-'}',
            ),
            _MetricRow(
              labelKey: 's4.lib.ophthalmology.diagnosis',
              value: '${exam['diagnosis'] ?? '-'}',
            ),
            if (refractions.isNotEmpty) ...[
              const SizedBox(height: 8),
              const AppText('s4.lib.ophthalmology.refractions'),
              for (final row in refractions)
                Text(
                  _formatRefraction(Map<String, dynamic>.from(row as Map)),
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
            ],
            if (biometries.isNotEmpty) ...[
              const SizedBox(height: 8),
              const AppText('s4.lib.ophthalmology.biometry'),
              for (final row in biometries)
                Text(
                  _formatBiometry(Map<String, dynamic>.from(row as Map)),
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
            ],
            if (attachments.isNotEmpty) ...[
              const SizedBox(height: 8),
              const AppText('s4.lib.ophthalmology.attachments'),
              for (final row in attachments)
                Text(
                  _formatAttachment(Map<String, dynamic>.from(row as Map)),
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _MetricRow extends StatelessWidget {
  final String labelKey;
  final String value;

  const _MetricRow({required this.labelKey, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: AppText(
              labelKey,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }
}

String _eyeLabel(Map<String, dynamic> row) {
  return '${row['eye'] ?? ''}'.toUpperCase();
}

String _formatRefraction(Map<String, dynamic> row) {
  return '${_eyeLabel(row)}  ${row['sphere'] ?? '-'} / ${row['cylinder'] ?? '-'} x ${row['axis'] ?? '-'}  ${row['va_with_correction'] ?? '-'}';
}

String _formatBiometry(Map<String, dynamic> row) {
  return '${_eyeLabel(row)}  ${row['axial_length_mm'] ?? '-'} mm  ${row['selected_iol_power'] ?? '-'} D  ${row['iol_formula'] ?? '-'}';
}

String _formatAttachment(Map<String, dynamic> row) {
  return '${_eyeLabel(row)}  ${row['image_type'] ?? '-'}  ${row['mime_type'] ?? '-'}';
}
