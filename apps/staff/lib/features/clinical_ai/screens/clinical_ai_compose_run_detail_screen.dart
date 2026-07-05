// Clinical AI compose run detail — apps/staff Flutter.
//
// Visualises a parent compose run + its 4 child subgraph runs (med rec
// / aftercare / discharge readiness / clinical coding for the discharge
// compose meta-workflow). Backend contract: GET /clinical-ai/clinical/
// discharge-compose/:runId returns the parent run + a `children: []`
// array.
//
// Resume button is shown only when run.status === 'paused' and the
// caller's role can resume (the backend gates this; we surface the
// 403 as a SnackBar). Pause reason — typically `await_governance` —
// is shown when present.

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../core/services/clinical_ai_api_service.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

@visibleForTesting
Map<String, dynamic> normalizeComposeRunDetail(
  Map<String, dynamic> payload, {
  Map<String, dynamic>? fallbackRun,
}) {
  final rawParent = payload['run'];
  final normalized = <String, dynamic>{};
  if (fallbackRun != null) normalized.addAll(fallbackRun);
  if (rawParent is Map) {
    normalized.addAll(Map<String, dynamic>.from(rawParent));
  } else {
    normalized.addAll(payload);
  }

  final rawChildren = payload['children'] ?? normalized['children'];
  final children = rawChildren is List ? rawChildren : const [];
  normalized['children'] = children;
  normalized['child_count'] =
      payload['child_count'] ?? normalized['child_count'] ?? children.length;
  return normalized;
}

class ClinicalAiComposeRunDetailScreen extends StatefulWidget {
  const ClinicalAiComposeRunDetailScreen({
    super.key,
    required this.runId,
    this.initialRun,
  });

  final int runId;
  final Map<String, dynamic>? initialRun;

  @override
  State<ClinicalAiComposeRunDetailScreen> createState() =>
      _ClinicalAiComposeRunDetailScreenState();
}

class _ClinicalAiComposeRunDetailScreenState
    extends State<ClinicalAiComposeRunDetailScreen> {
  Map<String, dynamic>? _run;
  bool _loading = true;
  String? _error;
  bool _resuming = false;

  @override
  void initState() {
    super.initState();
    _run = widget.initialRun;
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await ClinicalAiApiService.getDischargeComposeRun(
        widget.runId,
      );
      if (!mounted) return;
      setState(() {
        _run = normalizeComposeRunDetail(result, fallbackRun: _run);
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

  Future<void> _resume() async {
    setState(() => _resuming = true);
    try {
      await ClinicalAiApiService.resumeDischargeCompose(widget.runId);
      if (!mounted) return;
      final s = AppStrings.of(context);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(s.clinicalAiComposeRunResumed)));
      await _load();
    } catch (err) {
      if (!mounted) return;
      final s = AppStrings.of(context);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.clinicalAiComposeResumeFailed(err.toString())),
        ),
      );
    } finally {
      if (mounted) setState(() => _resuming = false);
    }
  }

  void _openReview(int? reviewId) {
    if (reviewId == null) return;
    context.push('/clinical-ai/review/$reviewId');
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final run = _run;
    return StaffScaffold(
      title: s.clinicalAiComposeRunDetailTitle(widget.runId),
      body: _loading && run == null
          ? const Center(child: CircularProgressIndicator())
          : _error != null && run == null
          ? _ErrorState(message: _error!, onRetry: _load)
          : run == null
          ? Center(child: Text(s.clinicalAiComposeRunDetailNotFound))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(12),
                children: [
                  _ParentCard(run: run, resuming: _resuming, onResume: _resume),
                  const SizedBox(height: 12),
                  Text(
                    s.clinicalAiComposeSubgraphsHeader,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  ..._buildChildren(run),
                ],
              ),
            ),
    );
  }

  List<Widget> _buildChildren(Map<String, dynamic> run) {
    final s = AppStrings.of(context);
    final children = (run['children'] as List?) ?? const [];
    if (children.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 24),
          child: Center(
            child: Text(
              s.clinicalAiComposeNoSubgraphs,
              style: const TextStyle(color: Colors.grey),
            ),
          ),
        ),
      ];
    }
    return children
        .whereType<Map<String, dynamic>>()
        .map(
          (child) => Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: _ChildCard(child: child, onOpenReview: _openReview),
          ),
        )
        .toList();
  }
}

class _ParentCard extends StatelessWidget {
  const _ParentCard({
    required this.run,
    required this.resuming,
    required this.onResume,
  });
  final Map<String, dynamic> run;
  final bool resuming;
  final VoidCallback onResume;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final status = run['status']?.toString() ?? '—';
    final pauseReason = run['pause_reason']?.toString();
    final admissionId = run['admission_id']?.toString() ?? '—';
    final startedAt = run['started_at']?.toString();
    final finishedAt =
        run['finished_at']?.toString() ??
        run['completed_at']?.toString() ??
        run['failed_at']?.toString();
    final reviewStatus = run['review_status']?.toString();
    final canResume = status.toLowerCase() == 'paused';

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    s.clinicalAiComposeAdmissionHeader(admissionId),
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                _StatusChip(label: status),
              ],
            ),
            const SizedBox(height: 8),
            if (pauseReason != null && pauseReason != 'null')
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: Colors.orange.shade50,
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(color: Colors.orange.shade200),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(
                        Icons.pause_circle_outline,
                        size: 16,
                        color: Colors.orange,
                      ),
                      const SizedBox(width: 4),
                      Flexible(
                        child: Text(
                          s.clinicalAiComposePausedPrefix(pauseReason),
                          style: TextStyle(
                            color: Colors.orange.shade900,
                            fontSize: 12,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            if (reviewStatus != null && reviewStatus != 'null')
              _kv(s.clinicalAiComposeReviewStatusKey, reviewStatus, context),
            if (startedAt != null)
              _kv(s.clinicalAiComposeStartedKey, startedAt, context),
            if (finishedAt != null && finishedAt != 'null')
              _kv(s.clinicalAiComposeFinishedKey, finishedAt, context),
            if (canResume) ...[
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: resuming ? null : onResume,
                icon: resuming
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.play_arrow),
                label: Text(
                  resuming
                      ? s.clinicalAiComposeResumingButton
                      : s.clinicalAiComposeResumeButton,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _kv(String key, String value, BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 100,
            child: Text(
              key,
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 12,
              ),
            ),
          ),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 12))),
        ],
      ),
    );
  }
}

class _ChildCard extends StatelessWidget {
  const _ChildCard({required this.child, required this.onOpenReview});
  final Map<String, dynamic> child;
  final void Function(int? reviewId) onOpenReview;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final moduleKey = child['module_key']?.toString() ?? '—';
    final status = child['status']?.toString() ?? '—';
    final reviewId = child['review_id'];
    final reviewStatus = child['review_status']?.toString();
    final flagsRaw = (child['safety_flags'] as List?) ?? const [];
    final critical = flagsRaw
        .where(
          (f) =>
              f is Map &&
              (f['severity']?.toString().toLowerCase() ?? '') == 'critical',
        )
        .length;
    final high = flagsRaw
        .where(
          (f) =>
              f is Map &&
              (f['severity']?.toString().toLowerCase() ?? '') == 'high',
        )
        .length;
    final reviewIdInt = reviewId is int
        ? reviewId
        : int.tryParse(reviewId?.toString() ?? '');

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    s.clinicalAiModuleLabel(moduleKey),
                    style: const TextStyle(fontWeight: FontWeight.bold),
                  ),
                ),
                _StatusChip(label: status),
              ],
            ),
            if (reviewStatus != null && reviewStatus != 'null')
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: [
                    _SmallChip(
                      label:
                          '${AppStrings.of(context).clinicalAiComposeReviewPrefix} $reviewStatus',
                    ),
                    if (critical > 0)
                      _SmallChip(
                        label: AppStrings.of(
                          context,
                        ).clinicalAiComposeCriticalCount(critical),
                        color: Colors.red,
                      ),
                    if (high > 0)
                      _SmallChip(
                        label: AppStrings.of(
                          context,
                        ).clinicalAiComposeHighCount(high),
                        color: Colors.orange,
                      ),
                  ],
                ),
              ),
            if (reviewIdInt != null) ...[
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: () => onOpenReview(reviewIdInt),
                icon: const Icon(Icons.open_in_new, size: 16),
                label: Text(
                  AppStrings.of(context).clinicalAiComposeOpenInQueue,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.label});
  final String label;
  @override
  Widget build(BuildContext context) {
    Color color;
    switch (label.toLowerCase()) {
      case 'running':
        color = Colors.blue.shade700;
        break;
      case 'paused':
        color = Colors.orange.shade700;
        break;
      case 'completed':
        color = Colors.green.shade700;
        break;
      case 'failed':
        color = Theme.of(context).colorScheme.error;
        break;
      default:
        color = Theme.of(context).colorScheme.onSurfaceVariant;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(label, style: TextStyle(color: color, fontSize: 11)),
    );
  }
}

class _SmallChip extends StatelessWidget {
  const _SmallChip({required this.label, this.color});
  final String label;
  final Color? color;
  @override
  Widget build(BuildContext context) {
    final c = color ?? Theme.of(context).colorScheme.tertiary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: c.withValues(alpha: 0.3)),
      ),
      child: Text(label, style: TextStyle(color: c, fontSize: 10)),
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
