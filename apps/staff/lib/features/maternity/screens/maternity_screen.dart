// lib/features/maternity/screens/maternity_screen.dart
//
// Staff maternity home — lists active labour admissions with quick
// links to record a new partograph entry or view the chart.

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_staff/core/services/api_client.dart';

class _ActiveLabor {
  _ActiveLabor.fromJson(Map<String, dynamic> j)
    : id = j['id'] as int,
      patientUid = j['patient_uid']?.toString() ?? '',
      gravida = (j['gravida'] as num?)?.toInt() ?? 0,
      parity = (j['parity'] as num?)?.toInt() ?? 0,
      gestationalAge = j['gestational_age_weeks']?.toString(),
      cervixDilation = j['cervix_dilation_cm']?.toString(),
      fetalHr = (j['fetal_heart_rate_bpm'] as num?)?.toInt(),
      contractions = (j['contractions_per_10min'] as num?)?.toInt(),
      admittedAt = j['admitted_at']?.toString(),
      reason = j['admission_reason']?.toString(),
      highRisk = j['high_risk'] as bool? ?? false,
      highRiskReasons = (j['high_risk_reasons'] as List?)
              ?.map((r) => r.toString())
              .toList() ??
          const [];

  final int id;
  final String patientUid;
  final int gravida;
  final int parity;
  final String? gestationalAge;
  final String? cervixDilation;
  final int? fetalHr;
  final int? contractions;
  final String? admittedAt;
  final String? reason;
  final bool highRisk;
  final List<String> highRiskReasons;

  String get ageHours {
    if (admittedAt == null) return '—';
    final d = DateTime.tryParse(admittedAt!);
    if (d == null) return '—';
    final h = DateTime.now().difference(d).inMinutes / 60.0;
    return '${h.toStringAsFixed(1)}h';
  }
}

class MaternityScreen extends StatefulWidget {
  const MaternityScreen({super.key});

  @override
  State<MaternityScreen> createState() => _MaternityScreenState();
}

class _MaternityScreenState extends State<MaternityScreen> {
  bool _loading = true;
  String? _error;
  List<_ActiveLabor> _labors = const [];

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
      final response = await ApiClient.get(
        '/maternity/labor-admissions/active',
        queryParameters: {'limit': '50'},
      );
      if (!mounted) return;
      if (response.isSuccess) {
        final list = response.dataAsList();
        setState(() {
          _labors = list
              .whereType<Map<String, dynamic>>()
              .map(_ActiveLabor.fromJson)
              .toList();
          _loading = false;
        });
      } else {
        setState(() {
          _error = response.message ?? 'Failed to load labour board';
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
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Maternity'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _fetch,
            tooltip: 'Refresh',
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.error_outline,
                          size: 48,
                          color: theme.colorScheme.error,
                        ),
                        const SizedBox(height: 12),
                        Text(_error!, textAlign: TextAlign.center),
                        const SizedBox(height: 16),
                        ElevatedButton(
                          onPressed: _fetch,
                          child: const Text('Retry'),
                        ),
                      ],
                    ),
                  ),
                )
              : _labors.isEmpty
                  ? const Center(
                      child: Padding(
                        padding: EdgeInsets.all(32),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              Icons.child_friendly,
                              size: 64,
                              color: Colors.grey,
                            ),
                            SizedBox(height: 16),
                            Text(
                              'Labour ward is quiet',
                              style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                            SizedBox(height: 8),
                            Text(
                              'No active labour admissions right now.',
                              style: TextStyle(color: Colors.grey),
                            ),
                          ],
                        ),
                      ),
                    )
                  : RefreshIndicator(
                      onRefresh: _fetch,
                      child: ListView.separated(
                        padding: const EdgeInsets.all(12),
                        itemCount: _labors.length,
                        separatorBuilder: (_, _) => const SizedBox(height: 8),
                        itemBuilder: (_, i) =>
                            _LaborCard(labor: _labors[i], onChanged: _fetch),
                      ),
                    ),
    );
  }
}

class _LaborCard extends StatelessWidget {
  const _LaborCard({required this.labor, required this.onChanged});
  final _ActiveLabor labor;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      shape: RoundedRectangleBorder(
        side: labor.highRisk
            ? BorderSide(color: Colors.amber.shade700, width: 2)
            : BorderSide.none,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'G${labor.gravida}P${labor.parity}'
                        '${labor.gestationalAge != null ? ' · ${labor.gestationalAge}w' : ''}',
                        style: theme.textTheme.titleMedium,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Patient ${labor.patientUid.substring(0, 8)} · admitted ${labor.ageHours} ago',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.outline,
                        ),
                      ),
                    ],
                  ),
                ),
                if (labor.highRisk)
                  Tooltip(
                    message: labor.highRiskReasons.join(', '),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: Colors.amber.shade100,
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        '⚠ HIGH RISK',
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: Colors.amber.shade900,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 14,
              runSpacing: 6,
              children: [
                _stat('Cervix', '${labor.cervixDilation ?? "—"} cm'),
                _stat('FHR', '${labor.fetalHr ?? "—"}'),
                _stat('Ctx /10min', '${labor.contractions ?? "—"}'),
                if (labor.reason != null) _stat('Reason', labor.reason!),
              ],
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () =>
                        context.push('/maternity/labor/${labor.id}/chart'),
                    icon: const Icon(Icons.show_chart),
                    label: const Text('Partograph chart'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: () async {
                      final added = await context
                          .push<bool>('/maternity/partograph/${labor.id}');
                      if (added == true) onChanged();
                    },
                    icon: const Icon(Icons.add),
                    label: const Text('New entry'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _stat(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: TextStyle(fontSize: 10, color: Colors.grey.shade600),
        ),
        Text(value, style: const TextStyle(fontWeight: FontWeight.w500)),
      ],
    );
  }
}
