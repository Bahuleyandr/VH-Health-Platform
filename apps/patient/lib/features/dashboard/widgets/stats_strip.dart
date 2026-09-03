import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:vhhealth/core/widgets/health_charts.dart';
import 'package:vhhealth/features/period_tracker/models/cycle_tracker.dart';
import 'package:vhhealth/generated/app_localizations.dart';

/// Glance strip for the patient's top daily signals. It intentionally fits
/// the available screen width instead of scrolling so the right edge never
/// looks clipped on phones.
class StatsStrip extends StatelessWidget {
  final int? wellnessScore;
  final int? healthPoints;
  final String? healthTier;
  final int? stepsToday;
  final int? stepGoal;
  final CycleEstimate? cycleEstimate;
  final bool wellnessExpanded;
  final bool stepsExpanded;
  final bool pointsExpanded;
  final bool periodExpanded;
  final bool showPeriodTracker;

  final VoidCallback? onWellnessTap;
  final VoidCallback? onPointsTap;
  final VoidCallback? onStepsTap;
  final VoidCallback? onPeriodTap;

  const StatsStrip({
    super.key,
    this.wellnessScore,
    this.healthPoints,
    this.healthTier,
    this.stepsToday,
    this.stepGoal,
    this.cycleEstimate,
    this.wellnessExpanded = false,
    this.stepsExpanded = false,
    this.pointsExpanded = false,
    this.periodExpanded = false,
    this.showPeriodTracker = false,
    this.onWellnessTap,
    this.onPointsTap,
    this.onStepsTap,
    this.onPeriodTap,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final cards = <Widget>[
      _WellnessStatCard(
        score: wellnessScore,
        expanded: wellnessExpanded,
        onTap: onWellnessTap,
      ),
      _StatCard(
        icon: LucideIcons.footprints,
        tint: Colors.lightBlueAccent,
        label: l10n.dashboardMetricSteps,
        value: stepsToday != null ? _formatThousands(stepsToday!) : '-',
        subValue: stepGoal != null ? '/${_formatThousands(stepGoal!)}' : null,
        expanded: stepsExpanded,
        progress: (stepsToday != null && stepGoal != null && stepGoal! > 0)
            ? (stepsToday! / stepGoal!).clamp(0, 1).toDouble()
            : null,
        onTap: onStepsTap,
      ),
      _StatCard(
        icon: LucideIcons.award,
        tint: Colors.amber,
        label: healthTier != null
            ? '${healthTier![0]}${healthTier!.substring(1).toLowerCase()}'
            : l10n.healthPointsPoints,
        value: healthPoints != null ? '$healthPoints' : '-',
        subValue: 'pts',
        expanded: pointsExpanded,
        onTap: onPointsTap,
      ),
      if (showPeriodTracker)
        _PeriodStatCard(
          estimate: cycleEstimate,
          expanded: periodExpanded,
          onTap: onPeriodTap,
        ),
    ];

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
      child: SizedBox(height: 106, child: Row(children: _spacedCards(cards))),
    );
  }

  List<Widget> _spacedCards(List<Widget> cards) {
    return [
      for (var i = 0; i < cards.length; i++) ...[
        Expanded(child: cards[i]),
        if (i != cards.length - 1) const SizedBox(width: 6),
      ],
    ];
  }

  String _formatThousands(int n) {
    if (n < 1000) return '$n';
    return '${(n / 1000).toStringAsFixed(n % 1000 == 0 ? 0 : 1)}k';
  }
}

class _StatHeaderLabel extends StatelessWidget {
  final String text;
  final TextStyle? style;

  const _StatHeaderLabel({required this.text, this.style});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 16,
      child: Align(
        alignment: Alignment.centerLeft,
        child: FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(
            text,
            maxLines: 1,
            softWrap: false,
            overflow: TextOverflow.visible,
            style: style,
          ),
        ),
      ),
    );
  }
}

class _WellnessStatCard extends StatelessWidget {
  final int? score;
  final bool expanded;
  final VoidCallback? onTap;

  const _WellnessStatCard({
    required this.score,
    required this.expanded,
    this.onTap,
  });

  Color _scoreColor(int? score) {
    if (score == null) return Colors.tealAccent.shade400;
    if (score >= 80) return Colors.green.shade500;
    if (score >= 55) return Colors.amber.shade600;
    return Colors.redAccent.shade200;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final tint = _scoreColor(score);
    final isLight = theme.brightness == Brightness.light;
    final progress = score == null ? 0.0 : (score!.clamp(0, 100) / 100);

    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(8),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: double.infinity,
          padding: const EdgeInsets.fromLTRB(9, 8, 9, 8),
          decoration: BoxDecoration(
            border: Border.all(
              color: tint.withValues(alpha: expanded ? 0.82 : 0.50),
              width: expanded ? 1.4 : 1.1,
            ),
            borderRadius: BorderRadius.circular(8),
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                tint.withValues(alpha: isLight ? 0.45 : 0.20),
                tint.withValues(alpha: isLight ? 0.16 : 0.05),
              ],
            ),
            boxShadow: [
              if (expanded)
                BoxShadow(
                  color: tint.withValues(alpha: isLight ? 0.18 : 0.10),
                  blurRadius: 12,
                  offset: const Offset(0, 4),
                ),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Icon(LucideIcons.activity, size: 14, color: tint),
                  const SizedBox(width: 5),
                  Expanded(
                    child: _StatHeaderLabel(
                      text: 'Wellness',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: cs.onSurface.withValues(alpha: 0.72),
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  Icon(
                    expanded ? LucideIcons.chevronUp : LucideIcons.chevronDown,
                    size: 14,
                    color: cs.onSurface.withValues(alpha: 0.62),
                  ),
                ],
              ),
              const Spacer(),
              Align(
                alignment: Alignment.center,
                child: SizedBox(
                  width: 50,
                  height: 50,
                  child: CustomPaint(
                    painter: RingProgressPainter(
                      progress: progress,
                      color: tint,
                      backgroundColor: tint.withValues(alpha: 0.14),
                      strokeWidth: 5,
                    ),
                    child: Center(
                      child: Text(
                        score != null ? '$score' : '-',
                        maxLines: 1,
                        style: theme.textTheme.titleMedium?.copyWith(
                          color: tint,
                          fontWeight: FontWeight.w900,
                          height: 1,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const Spacer(),
              Text(
                AppLocalizations.of(context)!.healthPointsOutOfHundred,
                textAlign: TextAlign.center,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: cs.onSurface.withValues(alpha: 0.56),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PeriodStatCard extends StatelessWidget {
  final CycleEstimate? estimate;
  final bool expanded;
  final VoidCallback? onTap;

  const _PeriodStatCard({
    required this.estimate,
    required this.expanded,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    const tint = Colors.pinkAccent;
    final isLight = theme.brightness == Brightness.light;
    final estimate = this.estimate;
    final hasEstimate = estimate != null;
    final value = _centerValue(estimate);
    final unit = _centerUnit(estimate);
    final footer = _footer(estimate);
    final progress = estimate?.cycleProgress ?? 0.0;

    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(8),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: double.infinity,
          padding: const EdgeInsets.fromLTRB(9, 8, 9, 8),
          decoration: BoxDecoration(
            border: Border.all(
              color: tint.withValues(alpha: expanded ? 0.82 : 0.55),
              width: expanded ? 1.4 : 1.1,
            ),
            borderRadius: BorderRadius.circular(8),
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                tint.withValues(alpha: isLight ? 0.45 : 0.20),
                tint.withValues(alpha: isLight ? 0.18 : 0.05),
              ],
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
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Icon(LucideIcons.calendarHeart, size: 14, color: tint),
                  const SizedBox(width: 5),
                  Expanded(
                    child: _StatHeaderLabel(
                      text: AppLocalizations.of(context)!.dashboardMetricPeriod,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: cs.onSurface.withValues(alpha: 0.7),
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  Icon(
                    expanded ? LucideIcons.chevronUp : LucideIcons.chevronDown,
                    size: 14,
                    color: cs.onSurface.withValues(alpha: 0.62),
                  ),
                ],
              ),
              const Spacer(),
              Align(
                alignment: Alignment.center,
                child: SizedBox(
                  width: 54,
                  height: 54,
                  child: CustomPaint(
                    painter: RingProgressPainter(
                      progress: progress,
                      color: tint,
                      backgroundColor: tint.withValues(alpha: 0.16),
                      strokeWidth: hasEstimate ? 4 : 3,
                    ),
                    child: Center(
                      child: Padding(
                        padding: const EdgeInsets.all(9),
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(
                                value,
                                maxLines: 1,
                                style: theme.textTheme.titleMedium?.copyWith(
                                  color: tint,
                                  fontWeight: FontWeight.w900,
                                  height: 0.95,
                                ),
                              ),
                              if (unit != null)
                                Text(
                                  unit,
                                  maxLines: 1,
                                  style: theme.textTheme.labelSmall?.copyWith(
                                    color: tint.withValues(alpha: 0.86),
                                    fontWeight: FontWeight.w800,
                                    height: 0.95,
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const Spacer(),
              Text(
                footer,
                textAlign: TextAlign.center,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: cs.onSurface.withValues(alpha: 0.58),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _centerValue(CycleEstimate? estimate) {
    if (estimate == null) return 'Track';
    if (estimate.mayBePregnant) return 'Late';
    if (estimate.isDelayed) return '+${estimate.delayedDays}';
    if (estimate.status == CycleStatus.dueToday) return 'Due';
    return '${estimate.daysToNextPeriod}';
  }

  String? _centerUnit(CycleEstimate? estimate) {
    if (estimate == null) return null;
    if (estimate.mayBePregnant) return null;
    if (estimate.status == CycleStatus.dueToday) return null;
    return 'days';
  }

  String _footer(CycleEstimate? estimate) {
    if (estimate == null) return 'Add date';
    if (estimate.mayBePregnant) return 'May be pregnant';
    if (estimate.isDelayed) return 'Delayed';
    if (estimate.status == CycleStatus.dueToday) return 'Record today';
    return 'Due ${DateFormat.MMMd().format(estimate.nextPeriod)}';
  }
}

class _StatCard extends StatelessWidget {
  final IconData icon;
  final Color tint;
  final String label;
  final String value;
  final String? subValue;
  final bool expanded;
  final double? progress;
  final VoidCallback? onTap;

  const _StatCard({
    required this.icon,
    required this.tint,
    required this.label,
    required this.value,
    this.subValue,
    this.expanded = false,
    this.progress,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final isLight = theme.brightness == Brightness.light;
    final gradStart = tint.withValues(alpha: isLight ? 0.45 : 0.20);
    final gradEnd = tint.withValues(alpha: isLight ? 0.18 : 0.05);

    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(8),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: double.infinity,
          padding: const EdgeInsets.fromLTRB(9, 8, 9, 8),
          decoration: BoxDecoration(
            border: Border.all(
              color: tint.withValues(alpha: expanded ? 0.82 : 0.55),
              width: expanded ? 1.4 : 1.1,
            ),
            borderRadius: BorderRadius.circular(8),
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
                  const SizedBox(width: 5),
                  Expanded(
                    child: _StatHeaderLabel(
                      text: label,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: cs.onSurface.withValues(alpha: 0.7),
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  Icon(
                    expanded ? LucideIcons.chevronUp : LucideIcons.chevronDown,
                    size: 14,
                    color: cs.onSurface.withValues(alpha: 0.62),
                  ),
                ],
              ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Flexible(
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.bottomLeft,
                      child: Text(
                        value,
                        maxLines: 1,
                        style: theme.textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                          color: tint,
                          height: 1,
                        ),
                      ),
                    ),
                  ),
                  if (subValue != null) ...[
                    const SizedBox(width: 2),
                    Expanded(
                      child: Text(
                        subValue!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: cs.onSurface.withValues(alpha: 0.55),
                        ),
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
