import 'package:flutter/material.dart';
import 'package:vhhealth/features/gamification/utils/tier_utils.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class MilestonesTab extends StatelessWidget {
  final List<Map<String, dynamic>> milestones;
  final bool loading;
  final Set<String> claimingIds;
  final void Function(String milestoneId) onClaim;
  final Future<void> Function() onRefresh;

  const MilestonesTab({
    super.key,
    required this.milestones,
    required this.loading,
    required this.claimingIds,
    required this.onClaim,
    required this.onRefresh,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    if (loading && milestones.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    if (milestones.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.emoji_events_outlined,
              size: 48,
              color: Theme.of(context).colorScheme.onSurface
                  .withValues(alpha: 0.3),
            ),
            const SizedBox(height: 12),
            Text(
              l10n.gamificationNoMilestones,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 8),
            TextButton(onPressed: onRefresh, child: Text(l10n.commonRetry)),
          ],
        ),
      );
    }

    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView.builder(
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: milestones.length,
        itemBuilder: (context, index) {
          final m = milestones[index];
          final id = m['id']?.toString() ?? m['_id']?.toString() ?? '';
          final name =
              m['name']?.toString() ?? l10n.gamificationMilestoneFallback;
          final tierName = m['tier']?.toString() ?? name;
          final pointsRequired = (m['pointsRequired'] as num?)?.toInt() ?? 0;
          final rewardDesc =
              m['rewardDescription']?.toString() ??
              m['reward']?.toString() ??
              '';
          final status = m['status']?.toString().toUpperCase() ?? 'LOCKED';
          final voucherCode = m['voucherCode']?.toString() ?? '';

          final isLocked = status == 'LOCKED';
          final isClaimable = status == 'CLAIMABLE';
          final isClaimed = status == 'CLAIMED';
          final isClaiming = claimingIds.contains(id);
          final tierColor = getTierColor(tierName);

          return Card(
            elevation: 0,
            margin: const EdgeInsets.only(bottom: 10),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
              side: isClaimable
                  ? BorderSide(color: tierColor, width: 2)
                  : BorderSide.none,
            ),
            child: Opacity(
              opacity: isLocked ? 0.5 : 1.0,
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Row(
                  children: [
                    Container(
                      width: 48,
                      height: 48,
                      decoration: BoxDecoration(
                        color: isLocked
                            ? cs.onSurface.withValues(alpha: 0.08)
                            : tierColor.withValues(alpha: 0.15),
                        shape: BoxShape.circle,
                      ),
                      child: Icon(
                        isClaimed ? Icons.check_circle : getTierIcon(tierName),
                        color: isLocked
                            ? cs.onSurface.withValues(alpha: 0.3)
                            : tierColor,
                        size: 24,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            tierName,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              fontWeight: FontWeight.bold,
                              color: isLocked
                                  ? cs.onSurface.withValues(alpha: 0.5)
                                  : cs.onSurface,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            l10n.gamificationPointsRequired(pointsRequired),
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: cs.onSurface.withValues(alpha: 0.5),
                              fontSize: 11,
                            ),
                          ),
                          if (rewardDesc.isNotEmpty) ...[
                            const SizedBox(height: 2),
                            Text(
                              rewardDesc,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: cs.onSurface.withValues(alpha: 0.7),
                                fontSize: 11,
                              ),
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                          if (isClaimed && voucherCode.isNotEmpty) ...[
                            const SizedBox(height: 4),
                            Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(
                                  Icons.confirmation_num,
                                  size: 14,
                                  color: cs.primary,
                                ),
                                const SizedBox(width: 4),
                                Text(
                                  voucherCode,
                                  style: theme.textTheme.bodySmall?.copyWith(
                                    fontWeight: FontWeight.bold,
                                    color: cs.primary,
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ],
                      ),
                    ),
                    if (isClaimable)
                      SizedBox(
                        height: 32,
                        child: FilledButton(
                          onPressed: isClaiming ? null : () => onClaim(id),
                          style: FilledButton.styleFrom(
                            backgroundColor: tierColor,
                            padding: const EdgeInsets.symmetric(horizontal: 14),
                          ),
                          child: isClaiming
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : Text(l10n.gamificationClaimButton),
                        ),
                      ),
                    if (isClaimed)
                      Icon(Icons.check_circle, color: cs.primary, size: 24),
                    if (isLocked)
                      Icon(
                        Icons.lock,
                        color: cs.onSurface.withValues(alpha: 0.3),
                        size: 20,
                      ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
