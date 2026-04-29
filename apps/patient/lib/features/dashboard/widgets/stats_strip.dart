import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

/// Horizontal scrolling strip of small stat cards. Each card is a
/// glance-worthy KPI for the patient (steps today, wellness score,
/// health points + tier, streak). Tapping a card optionally routes to
/// the related feature.
///
/// Each entry self-renders an empty-data placeholder so the strip
/// always shows something rather than collapsing to zero entries.
class StatsStrip extends StatelessWidget {
  final int? wellnessScore; // 0-100, null = unknown
  final int? healthPoints;
  final String? healthTier; // 'BRONZE' | 'SILVER' | 'GOLD' | etc
  final int? stepsToday;
  final int? stepGoal;
  final int? streakDays;

  final VoidCallback? onWellnessTap;
  final VoidCallback? onPointsTap;
  final VoidCallback? onStepsTap;

  const StatsStrip({
    super.key,
    this.wellnessScore,
    this.healthPoints,
    this.healthTier,
    this.stepsToday,
    this.stepGoal,
    this.streakDays,
    this.onWellnessTap,
    this.onPointsTap,
    this.onStepsTap,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 88,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        children: [
          _StatCard(
            icon: LucideIcons.activity,
            tint: Colors.tealAccent.shade400,
            label: 'Wellness',
            value: wellnessScore != null ? '$wellnessScore' : '—',
            subValue: '/100',
            onTap: onWellnessTap,
          ),
          const SizedBox(width: 10),
          _StatCard(
            icon: LucideIcons.footprints,
            tint: Colors.lightBlueAccent,
            label: 'Steps today',
            value: stepsToday != null ? _formatThousands(stepsToday!) : '—',
            subValue: stepGoal != null
                ? '/${_formatThousands(stepGoal!)}'
                : null,
            progress: (stepsToday != null && stepGoal != null && stepGoal! > 0)
                ? (stepsToday! / stepGoal!).clamp(0, 1).toDouble()
                : null,
            onTap: onStepsTap,
          ),
          const SizedBox(width: 10),
          _StatCard(
            icon: LucideIcons.award,
            tint: Colors.amber,
            label: healthTier != null
                ? '${healthTier![0]}${healthTier!.substring(1).toLowerCase()}'
                : 'Points',
            value: healthPoints != null ? '$healthPoints' : '—',
            subValue: 'pts',
            onTap: onPointsTap,
          ),
          // Streak card hides when there's no streak yet — "0 days"
          // reads as broken rather than informative. Resurfaces the
          // moment the user logs a step day or completes a daily
          // check-in (gamification ledger then has STEP_DAILY_GOAL or
          // DAILY_CHECKIN entries).
          if (streakDays != null && streakDays! > 0) ...[
            const SizedBox(width: 10),
            _StatCard(
              icon: LucideIcons.flame,
              tint: Colors.deepOrangeAccent,
              label: 'Streak',
              value: '$streakDays',
              subValue: streakDays == 1 ? 'day' : 'days',
            ),
          ],
        ],
      ),
    );
  }

  String _formatThousands(int n) {
    if (n < 1000) return '$n';
    return '${(n / 1000).toStringAsFixed(n % 1000 == 0 ? 0 : 1)}k';
  }
}

class _StatCard extends StatelessWidget {
  final IconData icon;
  final Color tint;
  final String label;
  final String value;
  final String? subValue;
  final double? progress;
  final VoidCallback? onTap;

  const _StatCard({
    required this.icon,
    required this.tint,
    required this.label,
    required this.value,
    this.subValue,
    this.progress,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final isLight = theme.brightness == Brightness.light;
    // Light mode needs stronger fills against a white scaffold; dark
    // mode keeps the subtle glow over a dark surface.
    final gradStart = tint.withValues(alpha: isLight ? 0.45 : 0.20);
    final gradEnd = tint.withValues(alpha: isLight ? 0.18 : 0.05);
    final borderC = tint.withValues(alpha: isLight ? 0.55 : 0.32);

    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(16),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          width: 130,
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          decoration: BoxDecoration(
            border: Border.all(color: borderC, width: 1.1),
            borderRadius: BorderRadius.circular(16),
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [gradStart, gradEnd],
            ),
            boxShadow: [
              BoxShadow(
                color: tint.withValues(alpha: isLight ? 0.15 : 0.06),
                blurRadius: 10,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  Icon(icon, size: 14, color: tint),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: cs.onSurface.withValues(alpha: 0.7),
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  Text(
                    value,
                    style: theme.textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w800,
                      color: tint,
                      height: 1,
                    ),
                  ),
                  if (subValue != null) ...[
                    const SizedBox(width: 2),
                    Text(
                      subValue!,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.onSurface.withValues(alpha: 0.55),
                      ),
                    ),
                  ],
                ],
              ),
              if (progress != null)
                ClipRRect(
                  borderRadius: BorderRadius.circular(2),
                  child: LinearProgressIndicator(
                    value: progress,
                    minHeight: 3,
                    backgroundColor: tint.withValues(alpha: 0.2),
                    valueColor: AlwaysStoppedAnimation(tint),
                  ),
                )
              else
                const SizedBox(height: 3),
            ],
          ),
        ),
      ),
    );
  }
}
