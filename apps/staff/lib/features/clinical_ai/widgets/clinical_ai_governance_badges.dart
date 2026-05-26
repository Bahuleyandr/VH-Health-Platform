import 'package:flutter/material.dart';

import '../../../l10n/app_strings.dart';
import '../clinical_ai_review_governance.dart';

class ClinicalAiGovernanceBadgeStrip extends StatelessWidget {
  const ClinicalAiGovernanceBadgeStrip({
    super.key,
    required this.governance,
    this.compact = false,
  });

  final ClinicalAiReviewGovernance governance;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Wrap(
      spacing: compact ? 4 : 6,
      runSpacing: compact ? 3 : 6,
      children: governance.badges
          .map(
            (badge) => _GovernanceBadge(
              label: _labelFor(s, badge.kind),
              color: _colorFor(badge.kind),
              compact: compact,
            ),
          )
          .toList(),
    );
  }

  String _labelFor(AppStrings s, ClinicalAiReviewGovernanceBadgeKind kind) {
    switch (kind) {
      case ClinicalAiReviewGovernanceBadgeKind.ai:
        return s.clinicalAiGovernanceLabelAi;
      case ClinicalAiReviewGovernanceBadgeKind.fallback:
        return s.clinicalAiGovernanceLabelFallback;
      case ClinicalAiReviewGovernanceBadgeKind.blocked:
        return s.clinicalAiGovernanceLabelBlocked;
      case ClinicalAiReviewGovernanceBadgeKind.schemaUnavailable:
        return s.clinicalAiGovernanceLabelSchemaUnavailable;
      case ClinicalAiReviewGovernanceBadgeKind.deepTier:
        return s.clinicalAiGovernanceLabelDeepTier;
    }
  }

  Color _colorFor(ClinicalAiReviewGovernanceBadgeKind kind) {
    switch (kind) {
      case ClinicalAiReviewGovernanceBadgeKind.ai:
        return Colors.green.shade700;
      case ClinicalAiReviewGovernanceBadgeKind.fallback:
        return Colors.blueGrey.shade700;
      case ClinicalAiReviewGovernanceBadgeKind.blocked:
      case ClinicalAiReviewGovernanceBadgeKind.schemaUnavailable:
        return Colors.red.shade700;
      case ClinicalAiReviewGovernanceBadgeKind.deepTier:
        return Colors.indigo.shade700;
    }
  }
}

class _GovernanceBadge extends StatelessWidget {
  const _GovernanceBadge({
    required this.label,
    required this.color,
    required this.compact,
  });

  final String label;
  final Color color;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: compact ? 5 : 7,
        vertical: compact ? 2 : 3,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        border: Border.all(color: color.withValues(alpha: 0.45)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: color,
          fontSize: compact ? 10 : 11,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
