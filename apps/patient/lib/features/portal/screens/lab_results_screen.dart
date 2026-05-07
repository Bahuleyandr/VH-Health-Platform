// lib/features/portal/screens/lab_results_screen.dart
//
// Patient-facing lab results — Sprint 10. Only signed-off results are
// returned by the backend (NABH 5.6 — pre-signoff values can change),
// so we don't have to filter client-side.

import 'package:flutter/material.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

class _LabResult {
  _LabResult.fromJson(Map<String, dynamic> j)
    : id = j['id'] as int,
      testName = j['test_name']?.toString() ?? '—',
      testCode = j['test_code']?.toString(),
      observationTime = j['observation_datetime']?.toString(),
      valueText = j['value_text']?.toString(),
      valueNumeric = j['value_numeric'],
      unit = j['unit']?.toString(),
      referenceRange = j['reference_range']?.toString(),
      abnormalFlag = j['abnormal_flag']?.toString();

  final int id;
  final String testName;
  final String? testCode;
  final String? observationTime;
  final String? valueText;
  final dynamic valueNumeric;
  final String? unit;
  final String? referenceRange;
  final String? abnormalFlag;

  String get displayValue {
    if (valueNumeric != null) return valueNumeric.toString();
    return valueText ?? '—';
  }

  bool get isAbnormal {
    final f = abnormalFlag?.toUpperCase() ?? '';
    return f.contains('H') || f.contains('L') || f.contains('A');
  }
}

class LabResultsScreen extends StatefulWidget {
  const LabResultsScreen({super.key});

  @override
  State<LabResultsScreen> createState() => _LabResultsScreenState();
}

class _LabResultsScreenState extends State<LabResultsScreen> {
  bool _loading = true;
  String? _error;
  List<_LabResult> _results = [];

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get('/portal/lab-results');
      if (!mounted) return;
      if (response.isSuccess) {
        final list = response.dataAsList();
        setState(() {
          _results = list
              .whereType<Map<String, dynamic>>()
              .map(_LabResult.fromJson)
              .toList();
          _loading = false;
        });
      } else {
        setState(() {
          _error = response.message ?? 'Failed to load lab results';
          _loading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return FeatureScreenScaffold(
      title: 'Lab Results',
      icon: Icons.biotech,
      color: const Color(0xFF80DEEA),
      child: RefreshIndicator(
        onRefresh: _fetch,
        child: DataStateBuilder<_LabResult>(
          isLoading: _loading,
          error: _error,
          data: _results,
          onRetry: _fetch,
          emptyIcon: Icons.science_outlined,
          emptyTitle: 'No lab results yet',
          emptySubtitle:
              'Verified lab results will appear here. Pull to refresh.',
          builder: (context, results) {
            return ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: results.length,
              separatorBuilder: (_, _) => const SizedBox(height: 8),
              itemBuilder: (_, i) => _LabResultCard(result: results[i]),
            );
          },
        ),
      ),
    );
  }
}

class _LabResultCard extends StatelessWidget {
  const _LabResultCard({required this.result});
  final _LabResult result;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    result.testName,
                    style: theme.textTheme.titleMedium,
                  ),
                ),
                if (result.isAbnormal)
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.errorContainer,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      result.abnormalFlag!,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onErrorContainer,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text(
                  result.displayValue,
                  style: theme.textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                    color: result.isAbnormal
                        ? theme.colorScheme.error
                        : theme.colorScheme.onSurface,
                  ),
                ),
                if (result.unit != null) ...[
                  const SizedBox(width: 4),
                  Text(
                    result.unit!,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.outline,
                    ),
                  ),
                ],
              ],
            ),
            if (result.referenceRange != null) ...[
              const SizedBox(height: 4),
              Text(
                'Reference: ${result.referenceRange}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.outline,
                ),
              ),
            ],
            if (result.observationTime != null) ...[
              const SizedBox(height: 6),
              Text(
                _fmtTime(result.observationTime!),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.outline,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _fmtTime(String iso) {
    final d = DateTime.tryParse(iso);
    if (d == null) return iso;
    return '${d.day}/${d.month}/${d.year} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }
}
