import 'package:flutter/material.dart';

import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';
import '../models/cath_consumable_models.dart';

/// The patient's blood-borne reuse restriction, stated once in the two places
/// a device decision is taken: the capture sheet (before a reprocessed device
/// is picked up) and the case panel (before post-use is dispositioned).
///
/// Shared rather than duplicated so the two never drift into saying different
/// things about the same patient. Renders nothing when the status is `clear`.
/// `reasons` is empty for roles outside the clinical-staff set — the headline
/// still shows, only the clinical detail behind it is withheld.
class CathReuseRestrictionStrip extends StatelessWidget {
  const CathReuseRestrictionStrip({super.key, required this.restriction});

  /// A serology panel can carry a long tail of markers; past this many the
  /// strip would push the decision it precedes off the screen.
  static const int maxVisibleReasons = 4;

  final CathReuseRestriction restriction;

  @override
  Widget build(BuildContext context) {
    // A cleared patient has nothing to warn about: the guard lives here so no
    // caller can render an empty amber box by forgetting to check.
    if (restriction.isClear) return const SizedBox.shrink();
    final s = AppStrings.of(context);
    final restricted = restriction.isRestricted;
    final visibleReasons = restriction.reasons.length > maxVisibleReasons
        ? restriction.reasons.take(maxVisibleReasons).toList(growable: false)
        : restriction.reasons;
    final hiddenReasons = restriction.reasons.length - visibleReasons.length;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: (restricted ? AppTheme.errorRed : AppTheme.warningAmber)
            .withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            s.lookup(
              restricted
                  ? 's4.lib.cath_lab.consumables.restriction_restricted'
                  : 's4.lib.cath_lab.consumables.restriction_unknown',
            ),
            style: TextStyle(
              fontWeight: FontWeight.w700,
              color: restricted
                  ? AppTheme.errorOnSurface
                  : AppTheme.warningOnSurface,
            ),
          ),
          for (final reason in visibleReasons)
            Text(reason, style: Theme.of(context).textTheme.bodySmall),
          if (hiddenReasons > 0)
            Text(
              s.format('s4.dynamic.cath_lab.consumables.more_reasons', {
                'count': hiddenReasons,
              }),
              style: Theme.of(context).textTheme.bodySmall,
            ),
        ],
      ),
    );
  }
}
