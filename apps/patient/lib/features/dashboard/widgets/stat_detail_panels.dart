import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:vhhealth/features/gamification/utils/tier_utils.dart';

class StepsBreakdownPanel extends StatelessWidget {
  final int? stepsToday;
  final int? stepGoal;
  final VoidCallback onOpenFull;

  const StepsBreakdownPanel({
    super.key,
    required this.stepsToday,
    required this.stepGoal,
    required this.onOpenFull,
  });

  @override
  Widget build(BuildContext context) {
    final steps = stepsToday ?? 0;
    final goal = stepGoal ?? 8000;
    final remaining = (goal - steps).clamp(0, goal);
    final progress = goal > 0 ? (steps / goal).clamp(0.0, 1.0) : 0.0;
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final accent = Colors.lightBlueAccent;

    return _DetailShell(
      accent: accent,
      icon: LucideIcons.footprints,
      title: 'Steps breakdown',
      subtitle: progress >= 1
          ? 'Daily step goal reached'
          : '$remaining steps left for today',
      trailing: '${(progress * 100).round()}%',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: progress,
              minHeight: 7,
              backgroundColor: accent.withValues(alpha: 0.16),
              valueColor: AlwaysStoppedAnimation(accent),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: _MetricChip(
                  label: 'Today',
                  value: _formatThousands(steps),
                  accent: accent,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _MetricChip(
                  label: 'Goal',
                  value: _formatThousands(goal),
                  accent: accent,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _MetricChip(
                  label: 'Left',
                  value: _formatThousands(remaining),
                  accent: accent,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: onOpenFull,
              icon: const Icon(LucideIcons.arrowRight, size: 16),
              label: const Text('Open step challenge'),
              style: TextButton.styleFrom(foregroundColor: cs.primary),
            ),
          ),
        ],
      ),
    );
  }
}

class PointsBreakdownPanel extends StatelessWidget {
  final Map<String, dynamic>? summary;
  final VoidCallback onOpenFull;

  const PointsBreakdownPanel({
    super.key,
    required this.summary,
    required this.onOpenFull,
  });

  @override
  Widget build(BuildContext context) {
    final data = summary ?? const <String, dynamic>{};
    final total = _asInt(data['totalPoints']) ?? _asInt(data['total']) ?? 0;
    final currentTier = _tierName(data['currentTier']) ?? 'Points';
    final nextTierMap = _asMap(data['nextTier']);
    final nextTier = _tierName(nextTierMap) ?? _tierName(data['nextTier']);
    final progress =
        _asDouble(nextTierMap?['progress']) ??
        _asDouble(data['progressToNextTier']) ??
        0.0;
    final pointsNeeded =
        _asInt(nextTierMap?['pointsNeeded']) ??
        _asInt(data['pointsToNextTier']) ??
        0;
    final unclaimed = _asInt(data['unclaimedCount']) ?? 0;
    final recent = _asList(data['recentActivity']).take(2).toList();
    final accent = getTierColor(currentTier);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return _DetailShell(
      accent: accent,
      icon: getTierIcon(currentTier),
      title: 'Points breakdown',
      subtitle: nextTier == null || nextTier.isEmpty
          ? 'Keep earning with hospital activities'
          : '$pointsNeeded points to $nextTier',
      trailing: '$total pts',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: progress.clamp(0.0, 1.0),
              minHeight: 7,
              backgroundColor: accent.withValues(alpha: 0.16),
              valueColor: AlwaysStoppedAnimation(accent),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: _MetricChip(
                  label: 'Tier',
                  value: currentTier,
                  accent: accent,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _MetricChip(
                  label: 'Rewards',
                  value: '$unclaimed',
                  accent: accent,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _MetricChip(
                  label: 'Next',
                  value: nextTier ?? '-',
                  accent: accent,
                ),
              ),
            ],
          ),
          if (recent.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(
              'Recent activity',
              style: theme.textTheme.labelMedium?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 6),
            for (final item in recent) _RecentPointRow(item: item),
          ],
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: onOpenFull,
              icon: const Icon(LucideIcons.arrowRight, size: 16),
              label: const Text('Open health points'),
              style: TextButton.styleFrom(foregroundColor: cs.primary),
            ),
          ),
        ],
      ),
    );
  }
}

class _DetailShell extends StatelessWidget {
  final Color accent;
  final IconData icon;
  final String title;
  final String subtitle;
  final String trailing;
  final Widget child;

  const _DetailShell({
    required this.accent,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.trailing,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
      decoration: BoxDecoration(
        color: theme.cardColor.withValues(alpha: 0.92),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: accent.withValues(alpha: 0.30), width: 1.1),
        boxShadow: [
          BoxShadow(
            color: accent.withValues(alpha: 0.06),
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
              Container(
                width: 32,
                height: 32,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, color: accent, size: 18),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              Text(
                trailing,
                style: theme.textTheme.titleSmall?.copyWith(
                  color: accent,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }
}

class _MetricChip extends StatelessWidget {
  final String label;
  final String value;
  final Color accent;

  const _MetricChip({
    required this.label,
    required this.value,
    required this.accent,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.labelMedium?.copyWith(
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
    );
  }
}

class _RecentPointRow extends StatelessWidget {
  final Map<String, dynamic> item;

  const _RecentPointRow({required this.item});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final points = _asInt(item['points']) ?? 0;
    final description =
        item['description']?.toString().trim().isNotEmpty == true
        ? item['description'].toString()
        : item['activity_type']?.toString() ?? 'Activity';

    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: [
          Icon(LucideIcons.zap, size: 14, color: theme.colorScheme.primary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              description,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall,
            ),
          ),
          Text(
            '+$points',
            style: theme.textTheme.labelMedium?.copyWith(
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }
}

String _formatThousands(int n) {
  if (n < 1000) return '$n';
  return '${(n / 1000).toStringAsFixed(n % 1000 == 0 ? 0 : 1)}k';
}

Map<String, dynamic>? _asMap(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return null;
}

List<Map<String, dynamic>> _asList(dynamic value) {
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map((item) => Map<String, dynamic>.from(item))
      .toList();
}

int? _asInt(dynamic value) {
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}

double? _asDouble(dynamic value) {
  if (value is num) return value.toDouble();
  return double.tryParse(value?.toString() ?? '');
}

String? _tierName(dynamic value) {
  if (value is Map) {
    return value['name']?.toString();
  }
  final text = value?.toString();
  return text == null || text.trim().isEmpty ? null : text.trim();
}
