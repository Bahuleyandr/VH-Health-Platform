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

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/services/clinical_ai_api_service.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';
import '../op_ai_assist_availability.dart';
import '../clinical_ai_review_governance.dart';
import '../widgets/clinical_ai_governance_badges.dart';

class ClinicalAiReviewQueueScreen extends StatefulWidget {
  const ClinicalAiReviewQueueScreen({super.key});

  @override
  State<ClinicalAiReviewQueueScreen> createState() =>
      _ClinicalAiReviewQueueScreenState();
}

class _ClinicalAiReviewQueueScreenState
    extends State<ClinicalAiReviewQueueScreen> {
  String? _statusFilter = 'pending';
  List<Map<String, dynamic>> _reviews = const [];
  bool _loading = true;
  String? _error;
  bool _showOpAiAssist = false;

  @override
  void initState() {
    super.initState();
    _loadRole();
    _load();
  }

  Future<void> _loadRole() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    if (!mounted) return;
    setState(() => _showOpAiAssist = false);
    if (!RoleFeatures.hasOpAiAssist(role)) return;

    try {
      final modules = await ClinicalAiApiService.listOpAssistModules();
      if (!mounted) return;
      setState(() {
        _showOpAiAssist = shouldShowOpAiAssistEntryPoint(
          role: role,
          modules: modules,
        );
      });
    } catch (_) {
      if (mounted) setState(() => _showOpAiAssist = false);
    }
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
    final s = AppStrings.of(context);
    final statusFilters = <_StatusFilter>[
      _StatusFilter(label: s.clinicalAiQueueFilterPending, value: 'pending'),
      _StatusFilter(label: s.clinicalAiQueueFilterAccepted, value: 'accepted'),
      _StatusFilter(label: s.clinicalAiQueueFilterEdited, value: 'edited'),
      _StatusFilter(label: s.clinicalAiQueueFilterRejected, value: 'rejected'),
      _StatusFilter(label: s.clinicalAiQueueFilterAll, value: null),
    ];
    return StaffScaffold(
      title: s.clinicalAiQueueTitle,
      body: Column(
        children: [
          _QuickAccessRow(showOpAiAssist: _showOpAiAssist),
          _FilterBar(
            filters: statusFilters,
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
      return const SkeletonList();
    }
    if (_error != null) {
      return ErrorState(message: _error!, onRetry: _load);
    }
    if (_reviews.isEmpty) {
      final s = AppStrings.of(context);
      return RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            SizedBox(
              height: MediaQuery.sizeOf(context).height * 0.58,
              child: EmptyState(
                icon: Icons.inbox,
                title: s.clinicalAiQueueEmptyTitle,
                body: s.clinicalAiQueueEmptyBody,
              ),
            ),
          ],
        ),
      );
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

class _QuickAccessRow extends StatelessWidget {
  const _QuickAccessRow({required this.showOpAiAssist});

  final bool showOpAiAssist;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            // The app theme gives OutlinedButton a full-width (double.infinity)
            // minimumSize — fine stacked in a Column, but it forces an infinite
            // width as a direct child of this Row. Size both buttons to content.
            OutlinedButton.icon(
              onPressed: () => context.push('/clinical-ai/compose'),
              icon: const Icon(Icons.account_tree_outlined, size: 16),
              label: Text(s.clinicalAiQueueComposeButton),
              style: OutlinedButton.styleFrom(minimumSize: const Size(0, 40)),
            ),
            const SizedBox(width: 8),
            OutlinedButton.icon(
              onPressed: () => context.push('/clinical-ai/voice-notes'),
              icon: const Icon(Icons.mic_none, size: 16),
              label: Text(s.clinicalAiQueueVoiceNotesButton),
              style: OutlinedButton.styleFrom(minimumSize: const Size(0, 40)),
            ),
            if (showOpAiAssist) ...[
              const SizedBox(width: 8),
              OutlinedButton.icon(
                onPressed: () => context.push('/op-ai-assist'),
                icon: const Icon(Icons.auto_awesome, size: 16),
                label: const AppText(
                  's4.lib.clinical_ai_review_queue.op_ai_assist',
                ),
                style: OutlinedButton.styleFrom(minimumSize: const Size(0, 40)),
              ),
            ],
          ],
        ),
      ),
    );
  }
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

class _ReviewListTile extends StatelessWidget {
  const _ReviewListTile({required this.review, required this.onTap});
  final Map<String, dynamic> review;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final moduleKey = review['module_key']?.toString() ?? '—';
    final decision = review['decision']?.toString() ?? 'pending';
    final patientName =
        review['patient_name']?.toString() ?? s.clinicalAiQueuePatientFallback;
    final governance = clinicalAiReviewGovernanceFor(review);
    final flags = (review['safety_flags'] as List?) ?? const [];
    final criticalCount = flags
        .where(
          (f) =>
              f is Map && f['severity']?.toString().toLowerCase() == 'critical',
        )
        .length;
    final highCount = flags
        .where(
          (f) => f is Map && f['severity']?.toString().toLowerCase() == 'high',
        )
        .length;

    return ListTile(
      onTap: onTap,
      isThreeLine: true,
      leading: _DecisionIcon(decision: decision),
      title: Text(
        s.clinicalAiModuleLabel(moduleKey),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(patientName, maxLines: 1, overflow: TextOverflow.ellipsis),
          const SizedBox(height: 4),
          ClinicalAiGovernanceBadgeStrip(governance: governance, compact: true),
        ],
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (criticalCount > 0)
            _SeverityBadge(label: '$criticalCount', severity: 'critical'),
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
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.bold,
        ),
      ),
    );
  }
}
