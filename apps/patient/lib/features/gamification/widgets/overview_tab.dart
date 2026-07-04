import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:vhhealth/features/dashboard/widgets/next_visit_progress_widget.dart';
import 'package:vhhealth/features/gamification/utils/tier_utils.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class OverviewTab extends StatelessWidget {
  final Map<String, dynamic>? summary;
  final bool loading;
  final Future<void> Function() onRefresh;

  const OverviewTab({
    super.key,
    required this.summary,
    required this.loading,
    required this.onRefresh,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    if (loading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    if (summary == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.emoji_events_outlined,
              size: 48,
              color: Theme.of(
                context,
              ).colorScheme.onSurface.withValues(alpha: 0.3),
            ),
            const SizedBox(height: 12),
            Text(
              l10n.gamificationLoadFailed,
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
    final total =
        (summary!['totalPoints'] as num?)?.toInt() ??
        (summary!['total'] as num?)?.toInt() ??
        0;
    final currentTier = summary!['currentTier']?.toString() ?? 'Bronze';
    final nextTier = summary!['nextTier']?.toString() ?? '';
    final progress =
        (summary!['progressToNextTier'] as num?)?.toDouble().clamp(0.0, 1.0) ??
        0.0;
    final pointsToNext = (summary!['pointsToNextTier'] as num?)?.toInt() ?? 0;
    final tierColor = getTierColor(currentTier);

    final activities =
        summary!['activities'] as List? ??
        summary!['earnActivities'] as List? ??
        [];
    final nextAppt = summary!['nextAppointmentDetail'] as Map<String, dynamic>?;

    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          Center(
            child: SizedBox(
              width: 180,
              height: 180,
              child: CustomPaint(
                painter: TierRingPainter(
                  progress: progress,
                  tierColor: tierColor,
                  backgroundColor: cs.onSurface.withValues(alpha: 0.1),
                ),
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        total.toString(),
                        style: theme.textTheme.headlineLarge?.copyWith(
                          fontWeight: FontWeight.bold,
                          color: tierColor,
                        ),
                      ),
                      Text(
                        'points',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: cs.onSurface.withValues(alpha: 0.6),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Center(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(getTierIcon(currentTier), color: tierColor, size: 22),
                const SizedBox(width: 6),
                Text(
                  currentTier,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: tierColor,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 6),
          if (nextTier.isNotEmpty)
            Center(
              child: Text(
                'Next: $nextTier ${pointsToNext > 0 ? '-- $pointsToNext more points' : ''}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: cs.onSurface.withValues(alpha: 0.6),
                ),
              ),
            ),
          const SizedBox(height: 20),
          if (nextAppt != null) ...[
            NextVisitProgressWidget(
              detail: nextAppt,
              onTap: () {},
              onSchedule: () {},
            ),
            const SizedBox(height: 16),
          ],
          if (activities.isNotEmpty) ...[
            Card(
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(16),
              ),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(LucideIcons.zap, color: cs.primary, size: 18),
                        const SizedBox(width: 8),
                        Text(
                          AppLocalizations.of(context)!.gamificationHowToEarn,
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    ...activities.map((a) {
                      final activity = a is Map ? a : {};
                      final name = activity['name']?.toString() ?? 'Activity';
                      final points = (activity['points'] as num?)?.toInt() ?? 0;
                      final icon = activityIcon(
                        activity['type']?.toString() ?? '',
                      );
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Row(
                          children: [
                            Icon(
                              icon,
                              size: 16,
                              color: cs.onSurface.withValues(alpha: 0.6),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                name,
                                style: theme.textTheme.bodySmall,
                              ),
                            ),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: const Color(
                                  0xFFFFD54F,
                                ).withValues(alpha: 0.2),
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Text(
                                '+$points',
                                style: theme.textTheme.labelSmall?.copyWith(
                                  fontWeight: FontWeight.bold,
                                  color: const Color(0xFFFF8F00),
                                ),
                              ),
                            ),
                          ],
                        ),
                      );
                    }),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class TierRingPainter extends CustomPainter {
  final double progress;
  final Color tierColor;
  final Color backgroundColor;

  TierRingPainter({
    required this.progress,
    required this.tierColor,
    required this.backgroundColor,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = math.min(size.width, size.height) / 2 - 12;
    const strokeWidth = 10.0;

    final bgPaint = Paint()
      ..color = backgroundColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;

    canvas.drawCircle(center, radius, bgPaint);

    final fgPaint = Paint()
      ..color = tierColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;

    final sweepAngle = 2 * math.pi * progress;
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -math.pi / 2,
      sweepAngle,
      false,
      fgPaint,
    );
  }

  @override
  bool shouldRepaint(covariant TierRingPainter oldDelegate) {
    return oldDelegate.progress != progress ||
        oldDelegate.tierColor != tierColor;
  }
}
