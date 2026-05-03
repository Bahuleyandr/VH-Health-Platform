// Clinical AI compose runs list — apps/staff Flutter.
//
// Phase 5+ rollout deferred item that's now landing: the "compose tree"
// surface on mobile. Lists recent discharge_summary_compose runs (parent
// runs only — children load in detail screen). Status filter; tap to
// detail.
//
// Backend contract: GET /clinical-ai/clinical/discharge-compose returns
// `{ runs: [{ id, status, started_at, finished_at, admission_id,
//   review_status, ... }] }`. The clinical-plane-RBAC gate (DOCTOR /
// CLINICAL_LEAD / NURSE_MANAGER / ADMIN) is applied by the backend; if
// the caller's role isn't allowed they get a 403 from the api service.
//
// Companion: ClinicalAiComposeRunDetailScreen (sister file) shows the
// parent + 4 child subgraph runs and the resume button.

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../core/services/clinical_ai_api_service.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

List<_StatusFilter> _statusFiltersFor(AppStrings s) => <_StatusFilter>[
  _StatusFilter(label: s.clinicalAiComposeFilterActive, value: 'running'),
  _StatusFilter(label: s.clinicalAiComposeFilterPaused, value: 'paused'),
  _StatusFilter(label: s.clinicalAiComposeFilterCompleted, value: 'completed'),
  _StatusFilter(label: s.clinicalAiComposeFilterFailed, value: 'failed'),
  _StatusFilter(label: s.clinicalAiComposeFilterAll, value: null),
];

class ClinicalAiComposeRunsScreen extends StatefulWidget {
  const ClinicalAiComposeRunsScreen({super.key});

  @override
  State<ClinicalAiComposeRunsScreen> createState() =>
      _ClinicalAiComposeRunsScreenState();
}

class _ClinicalAiComposeRunsScreenState
    extends State<ClinicalAiComposeRunsScreen> {
  String? _statusFilter;
  List<Map<String, dynamic>> _runs = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final runs = await ClinicalAiApiService.listDischargeComposeRuns(
        status: _statusFilter,
        limit: 100,
      );
      if (!mounted) return;
      setState(() {
        _runs = runs;
        _loading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _error = err.toString();
        _loading = false;
      });
    }
  }

  void _onFilterChanged(String? value) {
    setState(() {
      _statusFilter = value;
    });
    _load();
  }

  void _openDetail(Map<String, dynamic> run) {
    final id = run['id'];
    if (id is int) {
      context.push('/clinical-ai/compose/$id', extra: run);
    } else if (id is String) {
      context.push('/clinical-ai/compose/$id', extra: run);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.clinicalAiComposeRunsTitle,
      body: Column(
        children: [
          _FilterBar(
            filters: _statusFiltersFor(s),
            value: _statusFilter,
            onChanged: _onFilterChanged,
          ),
          Expanded(child: _buildBody()),
        ],
      ),
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return _ErrorState(message: _error!, onRetry: _load);
    }
    if (_runs.isEmpty) return const _EmptyState();
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        itemCount: _runs.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final run = _runs[index];
          return _RunListTile(run: run, onTap: () => _openDetail(run));
        },
      ),
    );
  }
}

class _StatusFilter {
  const _StatusFilter({required this.label, required this.value});
  final String label;
  final String? value;
}

class _FilterBar extends StatelessWidget {
  const _FilterBar({
    required this.filters,
    required this.value,
    required this.onChanged,
  });
  final List<_StatusFilter> filters;
  final String? value;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: filters.map((filter) {
            final selected = filter.value == value;
            return Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ChoiceChip(
                label: Text(filter.label),
                selected: selected,
                onSelected: (_) => onChanged(filter.value),
              ),
            );
          }).toList(),
        ),
      ),
    );
  }
}

class _RunListTile extends StatelessWidget {
  const _RunListTile({required this.run, required this.onTap});
  final Map<String, dynamic> run;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final id = run['id']?.toString() ?? '—';
    final status = run['status']?.toString() ?? '—';
    final admissionId = run['admission_id']?.toString() ?? '—';
    final startedAt = run['started_at']?.toString();
    final reviewStatus = run['review_status']?.toString();
    final pauseReason = run['pause_reason']?.toString();

    return ListTile(
      onTap: onTap,
      leading: CircleAvatar(
        backgroundColor: _statusColor(context, status).withValues(alpha: 0.15),
        foregroundColor: _statusColor(context, status),
        child: const Icon(Icons.account_tree_outlined),
      ),
      title: Text(s.clinicalAiComposeRunHeader(id, admissionId)),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 6,
            runSpacing: 4,
            children: [
              _Chip(label: status, color: _statusColor(context, status)),
              if (reviewStatus != null && reviewStatus != 'null')
                _Chip(
                  label: '${s.clinicalAiComposeReviewPrefix} $reviewStatus',
                  color: Theme.of(context).colorScheme.tertiary,
                ),
              if (pauseReason != null && pauseReason != 'null')
                _Chip(
                  label: pauseReason,
                  color: Theme.of(context).colorScheme.error,
                ),
            ],
          ),
          if (startedAt != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '${s.clinicalAiComposeStartedPrefix} $startedAt',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
        ],
      ),
      trailing: const Icon(Icons.chevron_right),
    );
  }

  Color _statusColor(BuildContext context, String status) {
    switch (status.toLowerCase()) {
      case 'running':
        return Colors.blue.shade700;
      case 'paused':
        return Colors.orange.shade700;
      case 'completed':
        return Colors.green.shade700;
      case 'failed':
        return Theme.of(context).colorScheme.error;
      default:
        return Theme.of(context).colorScheme.onSurfaceVariant;
    }
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
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.4), width: 1),
      ),
      child: Text(label, style: TextStyle(color: color, fontSize: 11)),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();
  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.account_tree_outlined,
              size: 48,
              color: Colors.grey,
            ),
            const SizedBox(height: 8),
            Text(s.clinicalAiComposeRunsEmpty),
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
    final s = AppStrings.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, color: Colors.red, size: 48),
            const SizedBox(height: 8),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton(onPressed: onRetry, child: Text(s.actionRetry)),
          ],
        ),
      ),
    );
  }
}
