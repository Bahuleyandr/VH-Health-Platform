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
///
/// The HEADLINE states only what `reuse_restriction` itself guarantees: that
/// the serology status is unresolved, or that a reactive blood-borne marker is
/// on record. What the tenant's reprocessing policy then DOES about it —
/// acknowledge, block, or discard-only — is not in that payload at all
/// (`reuse_restriction` carries status/reasons/markers/validity/evaluated_at,
/// projected by role; the policy settings are never sent with it). It is in
/// the per-usage-row `allowed_post_use` the server recomputes on every
/// listing, so the policy sentence renders only where that row exists: the
/// post-use sheet. That is also where the policy actually binds — nothing in
/// `captureReusedDeviceTx` consults the patient's status, so a case-level
/// claim about reprocessing would be a claim about a decision the operator has
/// not reached yet.
class CathReuseRestrictionStrip extends StatelessWidget {
  const CathReuseRestrictionStrip({
    super.key,
    required this.restriction,
    this.postUseOptions,
  });

  /// A serology panel can carry a long tail of markers; past this many the
  /// strip would push the decision it precedes off the screen.
  static const int maxVisibleReasons = 4;

  static const String headlineRestrictedKey =
      's4.lib.cath_lab.consumables.restriction_restricted';
  static const String headlineUnknownKey =
      's4.lib.cath_lab.consumables.restriction_unknown';
  static const String policyAcknowledgementKey =
      's4.lib.cath_lab.consumables.restriction_ack_required';
  static const String policyBlockedKey =
      's4.lib.cath_lab.consumables.restriction_blocked';
  static const String policyDiscardOnlyKey =
      's4.lib.cath_lab.consumables.restriction_discard_only';
  static const String policyOverrideAllowedKey =
      's4.lib.cath_lab.consumables.restriction_override_allowed';

  final CathReuseRestriction restriction;

  /// The `allowed_post_use` the server sent for the usage row this strip
  /// precedes, or null where no device-level decision is on screen (the case
  /// header, the panel header, the capture sheet). Null means no policy
  /// sentence: the strip never guesses a policy it was not told.
  final CathPostUseOptions? postUseOptions;

  /// Which policy sentence — if any — the payload entitles the strip to say.
  ///
  /// Selected from `reason_codes` rather than from the shape of
  /// `dispositions`, because a reason code names the BRANCH of
  /// `computePostUseOptions` that produced the row, and three different
  /// branches collapse to `dispositions: ['discard']`: the patient's reactive
  /// marker under the `discard` rule, the DEVICE's own exposure flag, and a
  /// device at its cycle ceiling. Only the first is a statement about "devices
  /// used in this procedure"; the other two are facts about one device, and
  /// saying otherwise on a case-wide sentence would overclaim.
  static String? policyMessageKey(
    CathReuseRestriction restriction,
    CathPostUseOptions? options,
  ) {
    if (options == null) return null;
    // unknown + block_return: the return for reprocessing is refused outright.
    if (options.blockedCode != null ||
        options.reasonCodes.contains('serology_required')) {
      return policyBlockedKey;
    }
    // restricted + override_allowed: reprocess is offered, with an
    // acknowledgement.
    if (options.reasonCodes.contains('bloodborne_restricted_override')) {
      return policyOverrideAllowedKey;
    }
    // restricted + discard: every reprocessable device in the case is
    // discard-only.
    if (options.reasonCodes.contains('bloodborne_restricted')) {
      return policyDiscardOnlyKey;
    }
    // unknown + warn: reprocess is offered, with an acknowledgement.
    if (options.reasonCodes.contains('serology_unknown')) {
      return policyAcknowledgementKey;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    // A cleared patient has nothing to warn about: the guard lives here so no
    // caller can render an empty amber box by forgetting to check.
    if (restriction.isClear) return const SizedBox.shrink();
    final s = AppStrings.of(context);
    final restricted = restriction.isRestricted;
    final policyKey = policyMessageKey(restriction, postUseOptions);
    final visibleReasons = restriction.reasons.length > maxVisibleReasons
        ? restriction.reasons.take(maxVisibleReasons).toList(growable: false)
        : restriction.reasons;
    final hiddenReasons = restriction.reasons.length - visibleReasons.length;
    final onSurface = restricted
        ? AppTheme.errorOnSurface
        : AppTheme.warningOnSurface;
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
            s.lookup(restricted ? headlineRestrictedKey : headlineUnknownKey),
            style: TextStyle(fontWeight: FontWeight.w700, color: onSurface),
          ),
          if (policyKey != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                s.lookup(policyKey),
                key: const ValueKey('cath-reuse-restriction-policy'),
                style: TextStyle(fontWeight: FontWeight.w600, color: onSurface),
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
