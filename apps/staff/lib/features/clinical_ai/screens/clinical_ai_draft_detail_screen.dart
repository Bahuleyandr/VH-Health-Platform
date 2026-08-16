// Clinical AI draft detail screen — apps/staff Flutter.
//
// Shows a single draft + safety flags + accept/edit/reject actions.
// Phase 2 of the rollout plan.
//
// Critical-flag handling: drafts with a CRITICAL severity flag are
// marked failed by the backend and routed to a separate dead-letter
// dashboard, NOT this queue. So this screen should not normally see
// criticals — but if one slips through, surface it as a red banner the
// reviewer must explicitly dismiss before they can sign anything.
//
// Edit flow: the reviewer types into a text field; on Accept-edited,
// we POST decision='edited' with the edited JSON. Decision memory
// (clinical_ai_decision_memory) records the diff for future drafts on
// the same patient + similar context.

import 'dart:convert';

import 'package:flutter/material.dart';

import '../../../core/services/clinical_ai_api_service.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';
import '../clinical_ai_review_governance.dart';
import '../widgets/clinical_ai_governance_badges.dart';

class ClinicalAiDraftDetailScreen extends StatefulWidget {
  const ClinicalAiDraftDetailScreen({
    super.key,
    required this.reviewId,
    this.initialReview,
  });

  final int reviewId;
  // When the queue passed us its row data we can render immediately
  // and skip the round-trip.
  final Map<String, dynamic>? initialReview;

  @override
  State<ClinicalAiDraftDetailScreen> createState() =>
      _ClinicalAiDraftDetailScreenState();
}

class _ClinicalAiDraftDetailScreenState
    extends State<ClinicalAiDraftDetailScreen> {
  Map<String, dynamic>? _review;
  bool _loading = true;
  bool _submitting = false;
  String? _error;
  bool _editMode = false;
  late final TextEditingController _editController;
  late final TextEditingController _rejectionController;
  late final TextEditingController _reviewerNoteController;

  @override
  void initState() {
    super.initState();
    _editController = TextEditingController();
    _rejectionController = TextEditingController();
    _reviewerNoteController = TextEditingController();

    if (widget.initialReview != null) {
      _review = widget.initialReview;
      _initEditField();
      _loading = false;
    } else {
      _load();
    }
  }

  @override
  void dispose() {
    _editController.dispose();
    _rejectionController.dispose();
    _reviewerNoteController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final reviews = await ClinicalAiApiService.listMyReviews(limit: 200);
      final found = reviews.firstWhere(
        (r) => r['id'] == widget.reviewId,
        orElse: () => <String, dynamic>{},
      );
      if (!mounted) return;
      setState(() {
        _review = found.isEmpty ? null : found;
        _loading = false;
      });
      _initEditField();
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _error = err.toString();
        _loading = false;
      });
    }
  }

  void _initEditField() {
    final draft = _review?['draft'] ?? _review?['edited_draft'];
    if (draft is Map) {
      _editController.text = const JsonEncoder.withIndent('  ').convert(draft);
    }
  }

  Future<void> _submitDecision({
    required String decision,
    Map<String, dynamic>? editedDraft,
    String? rejectionReason,
    String? reviewerNote,
  }) async {
    setState(() => _submitting = true);
    try {
      await ClinicalAiApiService.decideReview(
        widget.reviewId,
        decision: decision,
        editedDraft: editedDraft,
        rejectionReason: rejectionReason,
        reviewerNote: reviewerNote,
      );
      if (!mounted) return;
      final s = AppStrings.of(context);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.clinicalAiDraftDecidedToast(decision))),
      );
      Navigator.of(context).pop();
    } catch (err) {
      if (!mounted) return;
      final s = AppStrings.of(context);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.clinicalAiDraftDecisionFailed(err.toString())),
        ),
      );
      setState(() => _submitting = false);
    }
  }

  Map<String, dynamic>? _parseEdits() {
    final text = _editController.text.trim();
    if (text.isEmpty) return null;
    try {
      final decoded = jsonDecode(text);
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.clinicalAiDraftScreenTitle,
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    final s = AppStrings.of(context);
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return _ErrorState(message: _error!, onRetry: _load);
    }
    if (_review == null) {
      return Center(child: Text(s.clinicalAiDraftReviewNotFound));
    }

    final review = _review!;
    final flags = (review['safety_flags'] as List?) ?? const [];
    final hasCritical = flags.any(
      (f) => f is Map && f['severity']?.toString().toLowerCase() == 'critical',
    );
    final governance = clinicalAiReviewGovernanceFor(review);
    final blocksSignoff = hasCritical || governance.blocksSignoff;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (hasCritical)
          _CriticalFlagBanner(
            flags: flags
                .whereType<Map>()
                .where(
                  (f) => f['severity']?.toString().toLowerCase() == 'critical',
                )
                .toList(),
          ),
        _ReviewHeader(review: review),
        const SizedBox(height: 16),
        _SafetyFlagsList(flags: flags),
        const SizedBox(height: 16),
        _DraftBody(
          review: review,
          editMode: _editMode,
          editController: _editController,
        ),
        const SizedBox(height: 24),
        _DecisionButtons(
          submitting: _submitting,
          editMode: _editMode,
          blocksSignoff: blocksSignoff,
          onAccept: () async {
            final note = await _askReviewerNote();
            if (note == null) return;
            await _submitDecision(decision: 'accepted', reviewerNote: note);
          },
          onAcceptEdited: () async {
            final edited = _parseEdits();
            if (edited == null) {
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text(s.clinicalAiDraftInvalidJson)),
              );
              return;
            }
            final note = await _askReviewerNote();
            if (note == null) return;
            await _submitDecision(
              decision: 'edited',
              editedDraft: edited,
              reviewerNote: note,
            );
          },
          onToggleEdit: () => setState(() => _editMode = !_editMode),
          onReject: () async {
            final reason = await _askRejectionReason();
            if (reason == null) return;
            await _submitDecision(
              decision: 'rejected',
              rejectionReason: reason,
            );
          },
          onNeedsRevision: () => _submitDecision(decision: 'needs_revision'),
        ),
      ],
    );
  }

  Future<String?> _askRejectionReason() async {
    final s = AppStrings.of(context);
    _rejectionController.clear();
    return showDialog<String>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: Text(s.clinicalAiDraftRejectTitle),
          content: TextField(
            controller: _rejectionController,
            decoration: InputDecoration(
              labelText: s.clinicalAiDraftRejectReasonLabel,
              hintText: s.clinicalAiDraftRejectReasonHint,
            ),
            maxLines: 4,
            autofocus: true,
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              onPressed: () {
                final text = _rejectionController.text.trim();
                if (text.isEmpty) return;
                Navigator.of(ctx).pop(text);
              },
              child: Text(s.clinicalAiDraftRejectButton),
            ),
          ],
        );
      },
    );
  }

  Future<String?> _askReviewerNote() async {
    final s = AppStrings.of(context);
    _reviewerNoteController.clear();
    return showDialog<String>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: Text(s.clinicalAiDraftReviewerNoteTitle),
          content: TextField(
            controller: _reviewerNoteController,
            decoration: InputDecoration(
              labelText: s.clinicalAiDraftReviewerNoteLabel,
              hintText: s.clinicalAiDraftReviewerNoteHint,
            ),
            maxLines: 4,
            autofocus: true,
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              onPressed: () {
                final text = _reviewerNoteController.text.trim();
                if (text.length < 12 ||
                    text
                            .split(RegExp(r'\s+'))
                            .where((w) => w.isNotEmpty)
                            .length <
                        3) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(s.clinicalAiDraftReviewerNoteMinChars),
                    ),
                  );
                  return;
                }
                Navigator.of(ctx).pop(text);
              },
              child: Text(s.clinicalAiDraftReviewerNoteButton),
            ),
          ],
        );
      },
    );
  }
}

class _CriticalFlagBanner extends StatelessWidget {
  const _CriticalFlagBanner({required this.flags});
  final List<Map> flags;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.red.withValues(alpha: 0.1),
        border: Border.all(color: Colors.red, width: 1),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.warning, color: Colors.red),
              const SizedBox(width: 8),
              Text(
                s.clinicalAiDraftCriticalTitle,
                style: TextStyle(
                  color: Colors.red.shade900,
                  fontWeight: FontWeight.bold,
                  fontSize: 16,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ...flags.map(
            (f) => Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '• ${f['code'] ?? ''}: ${f['message'] ?? ''}',
                style: TextStyle(color: Colors.red.shade900),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ReviewHeader extends StatelessWidget {
  const _ReviewHeader({required this.review});
  final Map<String, dynamic> review;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final governance = clinicalAiReviewGovernanceFor(review);
    final reason = governance.reason;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.clinicalAiModuleLabel(review['module_key']?.toString() ?? '—'),
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 4),
            Text(
              '${s.clinicalAiDraftPatientPrefix} ${review['patient_name'] ?? '—'}',
            ),
            if (review['admission_id'] != null)
              Text(
                '${s.clinicalAiDraftAdmissionPrefix} #${review['admission_id']}',
              ),
            Text(
              '${s.clinicalAiDraftStatusPrefix} ${review['decision'] ?? 'pending'}',
            ),
            if (review['provider'] != null)
              Text(
                '${s.clinicalAiDraftProviderPrefix} ${review['provider']} · ${review['model'] ?? '—'}',
              ),
            const SizedBox(height: 8),
            ClinicalAiGovernanceBadgeStrip(governance: governance),
            if (reason != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  '${s.clinicalAiGovernanceReasonPrefix} ${humanizeClinicalAiReason(reason)}',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _SafetyFlagsList extends StatelessWidget {
  const _SafetyFlagsList({required this.flags});
  final List flags;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (flags.isEmpty) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              const Icon(Icons.check_circle, color: Colors.green),
              const SizedBox(width: 8),
              Text(s.clinicalAiDraftNoSafetyFlags),
            ],
          ),
        ),
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.clinicalAiDraftSafetyHeader,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            ...flags.whereType<Map>().map((f) {
              final severity = f['severity']?.toString().toLowerCase() ?? 'low';
              return Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      _iconFor(severity),
                      color: _colorFor(severity),
                      size: 18,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        '${(f['code'] ?? '').toString()}: ${f['message'] ?? ''}',
                      ),
                    ),
                  ],
                ),
              );
            }),
          ],
        ),
      ),
    );
  }

  IconData _iconFor(String severity) {
    switch (severity) {
      case 'critical':
        return Icons.error;
      case 'high':
        return Icons.warning;
      case 'medium':
        return Icons.info;
      default:
        return Icons.info_outline;
    }
  }

  Color _colorFor(String severity) {
    switch (severity) {
      case 'critical':
        return Colors.red;
      case 'high':
        return Colors.orange;
      case 'medium':
        return Colors.amber;
      default:
        return Colors.grey;
    }
  }
}

class _DraftBody extends StatelessWidget {
  const _DraftBody({
    required this.review,
    required this.editMode,
    required this.editController,
  });
  final Map<String, dynamic> review;
  final bool editMode;
  final TextEditingController editController;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final draft = review['draft'] ?? review['edited_draft'];
    final pretty = draft is Map
        ? const JsonEncoder.withIndent('  ').convert(draft)
        : '—';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              editMode
                  ? s.clinicalAiDraftEditHeader
                  : s.clinicalAiDraftBodyHeader,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            if (editMode)
              TextField(
                controller: editController,
                maxLines: 16,
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                decoration: const InputDecoration(border: OutlineInputBorder()),
              )
            else
              SelectableText(
                pretty,
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
              ),
          ],
        ),
      ),
    );
  }
}

class _DecisionButtons extends StatelessWidget {
  const _DecisionButtons({
    required this.submitting,
    required this.editMode,
    required this.blocksSignoff,
    required this.onAccept,
    required this.onAcceptEdited,
    required this.onToggleEdit,
    required this.onReject,
    required this.onNeedsRevision,
  });

  final bool submitting;
  final bool editMode;
  final bool blocksSignoff;
  final VoidCallback onAccept;
  final VoidCallback onAcceptEdited;
  final VoidCallback onToggleEdit;
  final VoidCallback onReject;
  final VoidCallback onNeedsRevision;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        FilledButton.icon(
          onPressed: submitting || editMode || blocksSignoff ? null : onAccept,
          icon: const Icon(Icons.check),
          label: Text(s.clinicalAiDraftAccept),
          style: FilledButton.styleFrom(backgroundColor: Colors.green),
        ),
        FilledButton.icon(
          onPressed: submitting || !editMode || blocksSignoff
              ? null
              : onAcceptEdited,
          icon: const Icon(Icons.check_circle_outline),
          label: Text(s.clinicalAiDraftAcceptEdits),
          style: FilledButton.styleFrom(backgroundColor: Colors.blue),
        ),
        OutlinedButton.icon(
          onPressed: submitting ? null : onToggleEdit,
          icon: const Icon(Icons.edit),
          label: Text(
            editMode
                ? s.clinicalAiDraftCancelEditButton
                : s.clinicalAiDraftEditButton,
          ),
        ),
        OutlinedButton.icon(
          onPressed: submitting ? null : onNeedsRevision,
          icon: const Icon(Icons.refresh),
          label: Text(s.clinicalAiDraftNeedsRevision),
        ),
        OutlinedButton.icon(
          onPressed: submitting ? null : onReject,
          icon: const Icon(Icons.close),
          label: Text(s.clinicalAiDraftRejectButton),
          style: OutlinedButton.styleFrom(foregroundColor: Colors.red),
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
    final s = AppStrings.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 12),
            Text(
              s.clinicalAiDraftFailedLoad,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 6),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: Text(s.actionRetry),
            ),
          ],
        ),
      ),
    );
  }
}
