// Clinical AI review queue screen — apps/staff Flutter.
//
// First clinician-facing screen of the multi-agent system. Shows the
// caller's own review queue (filtered server-side by role + module's
// reviewRoles[]), with a status filter and a tap-to-detail flow into
// ClinicalAiDraftDetailScreen.
//
// Phase 2 of the rollout plan (docs/CLINICAL_AI_ROLLOUT_PLAN.md). The
// intentional MVP scope is "doctor sees what's in their queue, can
// open a draft, can sign / edit / reject" — explicitly NOT the compose
// tree visualisation (deferred to a later phase) and NOT generating new
// drafts from this screen (the workflow is: draft is generated
// elsewhere → lands in clinician's queue → clinician reviews here).

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../core/services/clinical_ai_api_service.dart';
import '../../../core/widgets/staff_scaffold.dart';

const _statusFilters = <_StatusFilter>[
  _StatusFilter(label: 'Pending', value: 'pending'),
  _StatusFilter(label: 'Accepted', value: 'accepted'),
  _StatusFilter(label: 'Edited', value: 'edited'),
  _StatusFilter(label: 'Rejected', value: 'rejected'),
  _StatusFilter(label: 'All', value: null),
];

class ClinicalAiReviewQueueScreen extends StatefulWidget {
  const ClinicalAiReviewQueueScreen({super.key});

  @override
  State<ClinicalAiReviewQueueScreen> createState() => _ClinicalAiReviewQueueScreenState();
}

class _ClinicalAiReviewQueueScreenState extends State<ClinicalAiReviewQueueScreen> {
  String? _statusFilter = 'pending';
  List<Map<String, dynamic>> _reviews = const [];
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
      final reviews = await ClinicalAiApiService.listMyReviews(
        decision: _statusFilter,
        limit: 100,
      );
      if (!mounted) return;
      setState(() {
        _reviews = reviews;
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

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'AI Review Queue',
      body: Column(
        children: [
          _FilterBar(
            filters: _statusFilters,
            value: _statusFilter,
            onChanged: _onFilterChanged,
          ),
          Expanded(child: _buildBody()),
        ],
      ),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return _ErrorState(message: _error!, onRetry: _load);
    }
    if (_reviews.isEmpty) {
      return const _EmptyState();
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        itemCount: _reviews.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final review = _reviews[index];
          return _ReviewListTile(
            review: review,
            onTap: () => _openDetail(review),
          );
        },
      ),
    );
  }

  void _openDetail(Map<String, dynamic> review) {
    final id = review['id'];
    if (id is int || id is String) {
      context.push('/clinical-ai/review/$id', extra: review);
    }
  }
}

class _StatusFilter {
  const _StatusFilter({required this.label, required this.value});
  final String label;
  final String? value;
}

class _FilterBar extends StatelessWidget {
  const _FilterBar({required this.filters, required this.value, required this.onChanged});
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

class _ReviewListTile extends StatelessWidget {
  const _ReviewListTile({required this.review, required this.onTap});
  final Map<String, dynamic> review;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final moduleKey = review['module_key']?.toString() ?? '—';
    final decision = review['decision']?.toString() ?? 'pending';
    final patientName = review['patient_name']?.toString() ?? 'Patient';
    final flags = (review['safety_flags'] as List?) ?? const [];
    final criticalCount = flags
        .where((f) => f is Map && f['severity']?.toString().toLowerCase() == 'critical')
        .length;
    final highCount = flags
        .where((f) => f is Map && f['severity']?.toString().toLowerCase() == 'high')
        .length;

    return ListTile(
      onTap: onTap,
      leading: _DecisionIcon(decision: decision),
      title: Text(
        _humanizeModuleKey(moduleKey),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        patientName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (criticalCount > 0) _SeverityBadge(label: '$criticalCount', severity: 'critical'),
          if (highCount > 0)
            Padding(
              padding: const EdgeInsets.only(left: 4),
              child: _SeverityBadge(label: '$highCount', severity: 'high'),
            ),
          const SizedBox(width: 4),
          const Icon(Icons.chevron_right, size: 20),
        ],
      ),
    );
  }
}

class _DecisionIcon extends StatelessWidget {
  const _DecisionIcon({required this.decision});
  final String decision;

  @override
  Widget build(BuildContext context) {
    switch (decision.toLowerCase()) {
      case 'accepted':
        return const Icon(Icons.check_circle, color: Colors.green);
      case 'edited':
        return const Icon(Icons.edit_note, color: Colors.blue);
      case 'rejected':
        return const Icon(Icons.cancel, color: Colors.red);
      case 'needs_revision':
        return const Icon(Icons.refresh, color: Colors.orange);
      default:
        return const Icon(Icons.pending, color: Colors.grey);
    }
  }
}

class _SeverityBadge extends StatelessWidget {
  const _SeverityBadge({required this.label, required this.severity});
  final String label;
  final String severity;

  @override
  Widget build(BuildContext context) {
    final color = severity == 'critical' ? Colors.red : Colors.orange;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        label,
        style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.bold),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: const [
        SizedBox(height: 80),
        Icon(Icons.inbox, size: 64, color: Colors.grey),
        SizedBox(height: 12),
        Center(child: Text('No drafts in this filter', style: TextStyle(fontSize: 16))),
        SizedBox(height: 6),
        Center(
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: 32),
            child: Text(
              'When a clinical AI draft is generated for an admission you reviewer-cover, it will appear here.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.grey),
            ),
          ),
        ),
      ],
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
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 12),
            Text('Failed to load reviews', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 6),
            Text(
              message,
              textAlign: TextAlign.center,
              style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }
}

String _humanizeModuleKey(String moduleKey) {
  // Convert 'medication_reconciliation' -> 'Medication Reconciliation'.
  return moduleKey
      .split('_')
      .where((part) => part.isNotEmpty)
      .map((part) => part[0].toUpperCase() + part.substring(1))
      .join(' ');
}
