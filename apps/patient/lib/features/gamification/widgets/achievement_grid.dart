// lib/features/gamification/widgets/achievement_grid.dart
//
// Grid of badges the user has earned (or can earn). Each tile shows the
// badge icon, title, and an unlocked/locked state. Tapping an unlocked
// badge opens a shareable achievement card (see achievement_share_card.dart).
//
// Data is sourced client-side from the gamification history endpoint plus a
// small catalog of known badges. When the backend later tracks dedicated
// badges in `health_point_ledger` with activity_type `BADGE_*`, the same
// code path lights them up.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/gamification/widgets/achievement_share_card.dart';

/// Static catalog of achievements the patient app tracks. Each entry maps to
/// one or more `activity_type` values in the ledger; seeing the activity_type
/// implies the badge is unlocked.
class AchievementDef {
  final String id;
  final String title;
  final String description;
  final IconData icon;
  final Color color;

  /// Ledger activity_types that trigger this badge.
  final List<String> triggerTypes;

  /// If set, badge is earned once [triggerCount] total ledger entries of
  /// any of [triggerTypes] exist.
  final int triggerCount;

  const AchievementDef({
    required this.id,
    required this.title,
    required this.description,
    required this.icon,
    required this.color,
    required this.triggerTypes,
    this.triggerCount = 1,
  });
}

const kAchievements = <AchievementDef>[
  AchievementDef(
    id: 'first_vitals',
    title: 'First Log',
    description: 'Logged your very first set of vitals.',
    icon: Icons.favorite,
    color: Colors.red,
    triggerTypes: ['VITALS_LOG'],
  ),
  AchievementDef(
    id: 'vitals_streak_7',
    title: 'Week of Wellness',
    description: '7-day vitals logging streak.',
    icon: Icons.local_fire_department,
    color: Colors.deepOrange,
    triggerTypes: ['VITALS_STREAK_7'],
  ),
  AchievementDef(
    id: 'checkin_7',
    title: '7-Day Check-In',
    description: 'Checked in for 7 consecutive days.',
    icon: Icons.emoji_emotions,
    color: Colors.amber,
    triggerTypes: ['DAILY_CHECKIN'],
    triggerCount: 7,
  ),
  AchievementDef(
    id: 'checkin_30',
    title: 'Monthly Mindfulness',
    description: '30 daily check-ins completed.',
    icon: Icons.self_improvement,
    color: Colors.purple,
    triggerTypes: ['DAILY_CHECKIN'],
    triggerCount: 30,
  ),
  AchievementDef(
    id: 'appointment_first',
    title: 'First Visit',
    description: 'Completed your first appointment.',
    icon: Icons.event_available,
    color: Colors.blue,
    triggerTypes: ['APPOINTMENT_COMPLETED'],
  ),
  AchievementDef(
    id: 'appointment_streak_3',
    title: 'On Track',
    description: '3 consecutive completed appointments.',
    icon: Icons.verified,
    color: Colors.teal,
    triggerTypes: ['APPOINTMENT_STREAK'],
  ),
  AchievementDef(
    id: 'on_time',
    title: 'Punctual Patient',
    description: 'Arrived on time for an appointment.',
    icon: Icons.schedule,
    color: Colors.indigo,
    triggerTypes: ['APPOINTMENT_ON_TIME'],
  ),
  AchievementDef(
    id: 'step_goal',
    title: 'Step It Up',
    description: 'Hit your daily step goal.',
    icon: Icons.directions_walk,
    color: Colors.green,
    triggerTypes: ['STEP_DAILY_GOAL'],
  ),
  AchievementDef(
    id: 'step_streak_7',
    title: 'Moving Strong',
    description: '7-day step-goal streak.',
    icon: Icons.directions_run,
    color: Colors.lightGreen,
    triggerTypes: ['STEP_STREAK_7'],
  ),
  AchievementDef(
    id: 'step_streak_30',
    title: 'Marathon Mind',
    description: '30-day step-goal streak.',
    icon: Icons.emoji_events,
    color: Colors.amber,
    triggerTypes: ['STEP_STREAK_30'],
  ),
];

class AchievementGrid extends StatefulWidget {
  const AchievementGrid({super.key});

  @override
  State<AchievementGrid> createState() => _AchievementGridState();
}

class _AchievementGridState extends State<AchievementGrid> {
  bool _loading = true;
  Map<String, int> _counts = const {};
  Map<String, DateTime> _firstEarnedAt = const {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      // Pull a large page of history to compute activity_type counts. The
      // ledger rarely exceeds a few hundred rows for a patient.
      final res = await ApiClient.get(
        '/gamification/history',
        queryParameters: const {'page': '1', 'limit': '100'},
      );
      if (!mounted) return;
      if (res.isSuccess) {
        final data = res.dataAsMap();
        final entries = (data['entries'] as List?) ?? const [];
        final counts = <String, int>{};
        final firstAt = <String, DateTime>{};
        for (final e in entries) {
          if (e is! Map) continue;
          final type = (e['activity_type'] ?? '').toString();
          if (type.isEmpty) continue;
          counts[type] = (counts[type] ?? 0) + 1;
          final earned = e['earned_at'];
          if (earned is String) {
            final dt = DateTime.tryParse(earned);
            if (dt != null) {
              final prev = firstAt[type];
              if (prev == null || dt.isBefore(prev)) firstAt[type] = dt;
            }
          }
        }
        setState(() {
          _counts = counts;
          _firstEarnedAt = firstAt;
          _loading = false;
        });
      } else {
        setState(() => _loading = false);
      }
    } catch (e) {
      if (kDebugMode) debugPrint('AchievementGrid: $e');
      if (mounted) setState(() => _loading = false);
    }
  }

  bool _isUnlocked(AchievementDef a) {
    int total = 0;
    for (final t in a.triggerTypes) {
      total += _counts[t] ?? 0;
    }
    return total >= a.triggerCount;
  }

  DateTime? _earnedAt(AchievementDef a) {
    DateTime? earliest;
    for (final t in a.triggerTypes) {
      final dt = _firstEarnedAt[t];
      if (dt == null) continue;
      if (earliest == null || dt.isBefore(earliest)) earliest = dt;
    }
    return earliest;
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: CircularProgressIndicator(),
        ),
      );
    }
    final unlocked = kAchievements.where(_isUnlocked).length;

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            '$unlocked of ${kAchievements.length} badges earned',
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 12),
          GridView.count(
            crossAxisCount: 3,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            mainAxisSpacing: 12,
            crossAxisSpacing: 10,
            childAspectRatio: 0.68,
            children: [
              for (final a in kAchievements)
                _badgeTile(context, a, _isUnlocked(a), _earnedAt(a)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _badgeTile(
    BuildContext context,
    AchievementDef a,
    bool unlocked,
    DateTime? earnedAt,
  ) {
    final theme = Theme.of(context);
    final color = unlocked ? a.color : theme.hintColor.withValues(alpha: 0.4);
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: () {
        if (!unlocked) return;
        showModalBottomSheet(
          context: context,
          isScrollControlled: true,
          backgroundColor: Colors.transparent,
          builder: (_) => AchievementShareCard(
            achievement: a,
            earnedAt: earnedAt ?? DateTime.now(),
          ),
        );
      },
      child: Container(
        decoration: BoxDecoration(
          color: theme.cardColor,
          border: Border.all(color: color.withValues(alpha: 0.4)),
          borderRadius: BorderRadius.circular(14),
        ),
        padding: const EdgeInsets.all(10),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 46,
              height: 46,
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.14),
                shape: BoxShape.circle,
              ),
              child: Icon(a.icon, color: color, size: 25),
            ),
            const SizedBox(height: 7),
            Expanded(
              child: Center(
                child: Text(
                  a.title,
                  textAlign: TextAlign.center,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                    fontSize: 12,
                    height: 1.05,
                    letterSpacing: 0,
                    color: unlocked ? null : theme.hintColor,
                  ),
                ),
              ),
            ),
            const SizedBox(height: 4),
            Text(
              unlocked ? 'Earned' : 'Locked',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.labelSmall?.copyWith(
                color: color,
                letterSpacing: 0,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
