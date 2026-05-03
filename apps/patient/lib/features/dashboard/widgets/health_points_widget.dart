// lib/features/dashboard/widgets/health_points_widget.dart
import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';

/// Compact dashboard card showing current health points, tier, progress
/// to next tier, and unclaimed reward count.
class HealthPointsWidget extends StatelessWidget {
  final Map<String, dynamic>? data;
  final VoidCallback onTap;

  const HealthPointsWidget({
    super.key,
    required this.data,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    if (data == null) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    final total = (data!['total'] as num?)?.toInt() ?? 0;
    final currentTier = data!['currentTier']?.toString() ?? 'Bronze';
    final nextTier = data!['nextTier']?.toString();
    final progressToNextTier =
        (data!['progressToNextTier'] as num?)?.toDouble().clamp(0.0, 1.0) ??
        0.0;
    final unclaimedCount = (data!['unclaimedCount'] as num?)?.toInt() ?? 0;

    // Gold/amber accent for points display
    final pointsColor = _tierColor(currentTier, cs);

    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                pointsColor.withValues(alpha: 0.08),
                pointsColor.withValues(alpha: 0.18),
              ],
            ),
          ),
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              // Points + tier icon
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  color: pointsColor.withValues(alpha: 0.15),
                  shape: BoxShape.circle,
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(_tierIcon(currentTier), color: pointsColor, size: 18),
                    const SizedBox(height: 1),
                    Text(
                      _formatPoints(total),
                      style: theme.textTheme.labelMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: pointsColor,
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 14),

              // Tier info + progress bar
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        // Tier badge
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: pointsColor,
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(
                            currentTier,
                            style: theme.textTheme.labelSmall?.copyWith(
                              color: Colors.white,
                              fontWeight: FontWeight.bold,
                              fontSize: 10,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          AppLocalizations.of(context)!.dashboardHealthPoints,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const Spacer(),
                        if (unclaimedCount > 0)
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 3,
                            ),
                            decoration: BoxDecoration(
                              color: cs.error,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: Text(
                              '$unclaimedCount reward${unclaimedCount > 1 ? 's' : ''} to claim!',
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: cs.onError,
                                fontWeight: FontWeight.bold,
                                fontSize: 9,
                              ),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 8),

                    // Progress bar to next tier
                    ClipRRect(
                      borderRadius: BorderRadius.circular(3),
                      child: LinearProgressIndicator(
                        value: progressToNextTier,
                        minHeight: 5,
                        backgroundColor: cs.onSurface.withValues(alpha: 0.1),
                        valueColor: AlwaysStoppedAnimation<Color>(pointsColor),
                      ),
                    ),

                    const SizedBox(height: 4),

                    if (nextTier != null && nextTier.isNotEmpty)
                      Text(
                        'Next: $nextTier',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: cs.onSurface.withValues(alpha: 0.5),
                          fontSize: 11,
                        ),
                      ),
                  ],
                ),
              ),

              const SizedBox(width: 4),
              Icon(
                Icons.chevron_right,
                color: cs.onSurface.withValues(alpha: 0.4),
                size: 20,
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Format large point numbers compactly (e.g. 1250 -> "1.2K").
  String _formatPoints(int pts) {
    if (pts >= 10000) {
      return '${(pts / 1000).toStringAsFixed(1)}K';
    }
    return pts.toString();
  }

  /// Tier-specific color, falling back to an amber/gold accent.
  Color _tierColor(String tier, ColorScheme cs) {
    switch (tier.toLowerCase()) {
      case 'bronze':
        return const Color(0xFFCD7F32);
      case 'silver':
        return const Color(0xFF9E9E9E);
      case 'gold':
        return const Color(0xFFFFD54F);
      case 'platinum':
        return const Color(0xFF78909C);
      case 'diamond':
        return const Color(0xFF4FC3F7);
      default:
        return const Color(0xFFFFD54F); // amber/gold default
    }
  }

  /// Tier-specific icon.
  IconData _tierIcon(String tier) {
    switch (tier.toLowerCase()) {
      case 'bronze':
        return Icons.emoji_events;
      case 'silver':
        return Icons.emoji_events;
      case 'gold':
        return Icons.emoji_events;
      case 'platinum':
        return Icons.workspace_premium;
      case 'diamond':
        return Icons.diamond;
      default:
        return Icons.emoji_events;
    }
  }
}
