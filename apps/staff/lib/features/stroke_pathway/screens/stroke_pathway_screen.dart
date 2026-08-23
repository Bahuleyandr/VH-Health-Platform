import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/services/stroke_pathway_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class StrokePathwayScreen extends StatefulWidget {
  const StrokePathwayScreen({super.key});

  @override
  State<StrokePathwayScreen> createState() => _StrokePathwayScreenState();
}

class _StrokePathwayScreenState extends State<StrokePathwayScreen> {
  bool _loading = true;
  String? _error;
  List<dynamic> _activations = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final data = await StrokePathwayApiService.listActivations();
      if (mounted) {
        setState(() {
          _activations = data['activations'] as List? ?? [];
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.lookup('s4.lib.stroke_pathway.title')),
        actions: [
          IconButton(
            tooltip: s.lookup('s4.lib.stroke_pathway.refresh'),
            icon: const Icon(Icons.refresh),
            onPressed: _load,
          ),
          const LogoutAction(),
        ],
      ),
      body: ConstrainedContent(child: _buildBody(context)),
    );
  }

  Widget _buildBody(BuildContext context) {
    final s = AppStrings.of(context);
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.error_outline,
                size: 48,
                color: AppTheme.errorRed,
              ),
              const SizedBox(height: 12),
              Text(
                s.lookup('s4.lib.stroke_pathway.load_failed'),
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: AppTheme.textPrimary,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: TextStyle(color: AppTheme.textSecondary),
              ),
              const SizedBox(height: 16),
              ElevatedButton.icon(
                onPressed: _load,
                icon: const Icon(Icons.refresh),
                label: Text(s.lookup('action.retry')),
              ),
            ],
          ),
        ),
      );
    }
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_activations.isEmpty) {
      return RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          children: [
            const SizedBox(height: 120),
            Icon(
              Icons.emergency_outlined,
              size: 64,
              color: Theme.of(context).colorScheme.outline,
            ),
            const SizedBox(height: 12),
            Center(
              child: Text(
                s.lookup('s4.lib.stroke_pathway.empty'),
                style: Theme.of(context).textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _activations.length,
        itemBuilder: (context, index) {
          final row = _activations[index] as Map<String, dynamic>;
          return _StrokeActivationCard(row: row);
        },
      ),
    );
  }
}

class _StrokeActivationCard extends StatelessWidget {
  const _StrokeActivationCard({required this.row});

  final Map<String, dynamic> row;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final status = row['status']?.toString();
    final nihss = _asMap(row['latest_nihss']);
    final decision = _asMap(row['latest_thrombolysis_decision']);
    final slas = row['sla_instances'] as List? ?? const [];
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                CircleAvatar(
                  backgroundColor: AppTheme.errorRed.withValues(alpha: 0.14),
                  foregroundColor: AppTheme.errorRed,
                  child: const Icon(Icons.emergency_outlined),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        _shortUid(context, row['patient_uid']),
                        style: Theme.of(context).textTheme.titleMedium
                            ?.copyWith(fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        _formatDate(context, row['activated_at']),
                        style: TextStyle(color: AppTheme.textSecondary),
                      ),
                    ],
                  ),
                ),
                _StatusPill(status: status),
              ],
            ),
            const SizedBox(height: 16),
            _StageRow(
              icon: Icons.local_hospital_outlined,
              label: s.lookup('s4.lib.stroke_pathway.activation'),
              value: _statusLabel(context, status),
            ),
            _StageRow(
              icon: Icons.fact_check_outlined,
              label: s.lookup('s4.lib.stroke_pathway.nihss'),
              value: nihss == null
                  ? s.lookup('s4.lib.stroke_pathway.pending')
                  : s
                        .lookup('s4.lib.stroke_pathway.nihss_score')
                        .replaceAll('{score}', '${nihss['total_score']}'),
            ),
            _StageRow(
              icon: Icons.medication_liquid_outlined,
              label: s.lookup('s4.lib.stroke_pathway.thrombolysis'),
              value: decision == null
                  ? s.lookup('s4.lib.stroke_pathway.pending')
                  : _decisionLabel(context, decision['decision_status']),
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: slas.map((raw) {
                final item = raw as Map<String, dynamic>;
                return _TimerChip(row: item);
              }).toList(),
            ),
          ],
        ),
      ),
    );
  }
}

class _StageRow extends StatelessWidget {
  const _StageRow({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Icon(icon, size: 18, color: AppTheme.primaryBlue),
          const SizedBox(width: 8),
          SizedBox(
            width: 118,
            child: Text(
              label,
              style: TextStyle(
                color: AppTheme.textSecondary,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.status});

  final String? status;

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Text(
        _statusLabel(context, status),
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

class _TimerChip extends StatelessWidget {
  const _TimerChip({required this.row});

  final Map<String, dynamic> row;

  @override
  Widget build(BuildContext context) {
    final status = row['status']?.toString();
    final color = _slaColor(status);
    return Chip(
      avatar: Icon(Icons.timer_outlined, color: color, size: 18),
      label: Text(
        '${_timerLabel(context, row['rule_code'])} ${_slaLabel(context, status)}',
      ),
      backgroundColor: color.withValues(alpha: 0.12),
      side: BorderSide(color: color.withValues(alpha: 0.25)),
    );
  }
}

Map<String, dynamic>? _asMap(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return null;
}

String _shortUid(BuildContext context, dynamic uid) {
  final text = uid?.toString() ?? '';
  if (text.isEmpty) return AppStrings.of(context).lookup('label.no_data');
  return text.length > 8 ? text.substring(0, 8) : text;
}

String _formatDate(BuildContext context, dynamic value) {
  final text = value?.toString() ?? '';
  if (text.isEmpty) return AppStrings.of(context).lookup('label.no_data');
  try {
    return DateFormat('dd MMM yyyy, HH:mm').format(DateTime.parse(text));
  } catch (_) {
    return text;
  }
}

Color _statusColor(String? status) {
  return switch (status?.toLowerCase()) {
    'active' => AppTheme.errorRed,
    'imaging' => AppTheme.primaryBlue,
    'decision_pending' => AppTheme.warningAmber,
    'treated' => AppTheme.successGreen,
    'transferred' => AppTheme.primaryBlue,
    'disposed' || 'closed' => Colors.grey,
    'cancelled' => Colors.grey,
    _ => Colors.grey,
  };
}

Color _slaColor(String? status) {
  return switch (status?.toLowerCase()) {
    'completed' => AppTheme.successGreen,
    'breached' => AppTheme.errorRed,
    'active' => AppTheme.warningAmber,
    _ => Colors.grey,
  };
}

String _statusLabel(BuildContext context, String? status) {
  final s = AppStrings.of(context);
  return switch (status?.toLowerCase()) {
    'active' => s.lookup('s4.lib.stroke_pathway.status.active'),
    'imaging' => s.lookup('s4.lib.stroke_pathway.status.imaging'),
    'decision_pending' => s.lookup('s4.lib.stroke_pathway.status.decision'),
    'treated' => s.lookup('s4.lib.stroke_pathway.status.treated'),
    'transferred' => s.lookup('s4.lib.stroke_pathway.status.transferred'),
    'disposed' => s.lookup('s4.lib.stroke_pathway.status.disposed'),
    'closed' => s.lookup('s4.lib.stroke_pathway.status.closed'),
    'cancelled' => s.lookup('s4.lib.stroke_pathway.status.cancelled'),
    _ => s.lookup('label.no_data'),
  };
}

String _decisionLabel(BuildContext context, dynamic value) {
  final s = AppStrings.of(context);
  return switch (value?.toString().toLowerCase()) {
    'approved' => s.lookup('s4.lib.stroke_pathway.decision.approved'),
    'administered' => s.lookup('s4.lib.stroke_pathway.decision.administered'),
    'withheld' => s.lookup('s4.lib.stroke_pathway.decision.withheld'),
    'rejected' => s.lookup('s4.lib.stroke_pathway.decision.rejected'),
    'pending_approval' => s.lookup('s4.lib.stroke_pathway.decision.pending'),
    'draft' => s.lookup('s4.lib.stroke_pathway.decision.draft'),
    _ => s.lookup('label.no_data'),
  };
}

String _timerLabel(BuildContext context, dynamic value) {
  final s = AppStrings.of(context);
  return switch (value?.toString()) {
    'stroke_door_to_ct' => s.lookup('s4.lib.stroke_pathway.timer.ct'),
    'stroke_door_to_needle' => s.lookup('s4.lib.stroke_pathway.timer.needle'),
    _ => s.lookup('s4.lib.stroke_pathway.timer.other'),
  };
}

String _slaLabel(BuildContext context, String? status) {
  final s = AppStrings.of(context);
  return switch (status?.toLowerCase()) {
    'active' => s.lookup('s4.lib.stroke_pathway.sla.active'),
    'completed' => s.lookup('s4.lib.stroke_pathway.sla.completed'),
    'breached' => s.lookup('s4.lib.stroke_pathway.sla.breached'),
    'cancelled' => s.lookup('s4.lib.stroke_pathway.sla.cancelled'),
    _ => s.lookup('label.no_data'),
  };
}
