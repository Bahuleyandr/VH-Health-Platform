import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_strings.dart';
import '../providers/clinical_inbox_provider.dart';
import '../services/clinical_inbox_api_service.dart';
import 'online_only_action_state.dart';

class PostDischargeCrossSignReview {
  final PostDischargeCrossSignCommand command;
  final String patientSafeLabel;
  final String diagnosticClassification;
  final String diagnosticActionKind;
  final String diagnosticDisposition;
  final DateTime? diagnosticActionOccurredAt;
  final bool canCrossSign;

  const PostDischargeCrossSignReview({
    required this.command,
    required this.patientSafeLabel,
    required this.diagnosticClassification,
    required this.diagnosticActionKind,
    required this.diagnosticDisposition,
    required this.diagnosticActionOccurredAt,
    required this.canCrossSign,
  });

  bool hasSameBinding(PostDischargeCrossSignReview other) {
    final current = command;
    final refreshed = other.command;
    return current.admissionId == refreshed.admissionId &&
        current.handoffId == refreshed.handoffId &&
        current.generationId == refreshed.generationId &&
        current.diagnosticActionId == refreshed.diagnosticActionId &&
        current.generationSnapshotSha256 ==
            refreshed.generationSnapshotSha256 &&
        current.actionTaskId == refreshed.actionTaskId;
  }
}

typedef RefreshPostDischargeCrossSignReview =
    Future<PostDischargeCrossSignReview?> Function();

Future<void> showPostDischargeCrossSignSheet(
  BuildContext context, {
  required PostDischargeCrossSignReview review,
  required RefreshPostDischargeCrossSignReview refreshReview,
  VoidCallback? onOpenResult,
}) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => PostDischargeCrossSignSheet(
      review: review,
      refreshReview: refreshReview,
      onOpenResult: onOpenResult,
    ),
  );
}

class PostDischargeCrossSignSheet extends StatefulWidget {
  final PostDischargeCrossSignReview review;
  final RefreshPostDischargeCrossSignReview refreshReview;
  final VoidCallback? onOpenResult;

  const PostDischargeCrossSignSheet({
    super.key,
    required this.review,
    required this.refreshReview,
    this.onOpenResult,
  });

  @override
  State<PostDischargeCrossSignSheet> createState() =>
      _PostDischargeCrossSignSheetState();
}

class _PostDischargeCrossSignSheetState
    extends State<PostDischargeCrossSignSheet> {
  late PostDischargeCrossSignReview _review;
  bool _attested = false;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _review = widget.review;
  }

  Future<void> _submit() async {
    final strings = AppStrings.of(context);
    if (!OnlineOnlyActionGuard.require(context)) return;
    if (!_attested) {
      setState(() {});
      return;
    }
    setState(() => _submitting = true);
    try {
      final refreshed = await widget.refreshReview();
      if (!mounted) return;
      if (refreshed == null || !refreshed.canCrossSign) {
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              strings.lookup('clinical_inbox.cross_sign.no_longer_actionable'),
            ),
          ),
        );
        return;
      }
      if (!_review.hasSameBinding(refreshed)) {
        setState(() {
          _review = refreshed;
          _attested = false;
          _submitting = false;
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              strings.lookup('clinical_inbox.cross_sign.binding_refreshed'),
            ),
          ),
        );
        return;
      }

      await context.read<ClinicalInboxProvider>().crossSignPendingResult(
        _review.command,
      );
      await widget.refreshReview();
      if (!mounted) return;
      Navigator.pop(context);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(strings.lookup('clinical_inbox.cross_sign.recorded')),
        ),
      );
    } catch (error) {
      final refreshed =
          error is PostDischargeCrossSignException && error.requiresRefresh
          ? await widget.refreshReview()
          : null;
      if (!mounted) return;
      if (refreshed != null && refreshed.canCrossSign) {
        setState(() {
          if (!_review.hasSameBinding(refreshed)) {
            _review = refreshed;
          }
          _attested = false;
          _submitting = false;
        });
      } else {
        setState(() => _submitting = false);
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            error is PostDischargeCrossSignException && error.requiresRefresh
                ? strings.lookup('clinical_inbox.cross_sign.binding_refreshed')
                : strings.format('clinical_inbox.cross_sign.failed', {
                    'reason': error.toString(),
                  }),
          ),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final review = _review;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                strings.lookup('clinical_inbox.cross_sign.title'),
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 8),
              Text(review.patientSafeLabel),
              const SizedBox(height: 16),
              _ExactEvidenceLine(
                label: strings.clinicalInboxClassification,
                value: review.diagnosticClassification,
              ),
              _ExactEvidenceLine(
                label: strings.lookup(
                  'clinical_inbox.cross_sign.generation_id',
                ),
                value: review.command.generationId,
                valueKey: const Key('post-discharge-generation-id'),
              ),
              _ExactEvidenceLine(
                label: strings.lookup(
                  'clinical_inbox.cross_sign.generation_hash',
                ),
                value: review.command.generationSnapshotSha256,
                valueKey: const Key('post-discharge-generation-hash'),
              ),
              _ExactEvidenceLine(
                label: strings.lookup(
                  'clinical_inbox.cross_sign.authoritative_action',
                ),
                value: review.command.diagnosticActionId,
              ),
              _ExactEvidenceLine(
                label: strings.lookup('clinical_inbox.cross_sign.action_kind'),
                value: review.diagnosticActionKind,
              ),
              _ExactEvidenceLine(
                label: strings.lookup(
                  'clinical_inbox.cross_sign.prior_disposition',
                ),
                value: review.diagnosticDisposition,
                valueKey: const Key('post-discharge-authoritative-disposition'),
              ),
              if (review.diagnosticActionOccurredAt != null)
                _ExactEvidenceLine(
                  label: strings.lookup(
                    'clinical_inbox.cross_sign.action_recorded_at',
                  ),
                  value: review.diagnosticActionOccurredAt!
                      .toLocal()
                      .toIso8601String(),
                ),
              if (widget.onOpenResult != null) ...[
                const SizedBox(height: 2),
                OutlinedButton.icon(
                  key: const Key('post-discharge-open-result'),
                  onPressed: _submitting
                      ? null
                      : () {
                          Navigator.pop(context);
                          widget.onOpenResult!();
                        },
                  icon: const Icon(Icons.open_in_new),
                  label: Text(
                    strings.lookup('clinical_inbox.cross_sign.open_result'),
                  ),
                ),
              ],
              const SizedBox(height: 4),
              CheckboxListTile(
                key: const Key('post-discharge-cross-sign-attestation'),
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _attested,
                onChanged: _submitting
                    ? null
                    : (value) => setState(() => _attested = value == true),
                title: Text(
                  strings.lookup('clinical_inbox.cross_sign.attestation'),
                ),
                subtitle: !_attested
                    ? Text(
                        strings.clinicalInboxFieldRequired,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      )
                    : null,
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: OnlineOnlyActionState(
                  builder: (context, isOnline, offlineMessage) => Tooltip(
                    message: isOnline ? '' : offlineMessage,
                    child: FilledButton.icon(
                      key: const Key('post-discharge-cross-sign-submit'),
                      onPressed:
                          _submitting || !review.canCrossSign || !isOnline
                          ? null
                          : _submit,
                      icon: _submitting
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.verified_user_outlined),
                      label: Text(
                        strings.lookup(
                          _submitting
                              ? 'clinical_inbox.cross_sign.recording'
                              : 'clinical_inbox.cross_sign.submit',
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ExactEvidenceLine extends StatelessWidget {
  final String label;
  final String value;
  final Key? valueKey;

  const _ExactEvidenceLine({
    required this.label,
    required this.value,
    this.valueKey,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 2),
          SelectableText(
            value.isEmpty ? '-' : value,
            key: valueKey,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ],
      ),
    );
  }
}
