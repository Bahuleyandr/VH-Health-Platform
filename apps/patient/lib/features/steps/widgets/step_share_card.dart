// lib/features/steps/widgets/step_share_card.dart
// Renderable share card for the Step Challenge feature
import 'package:flutter/material.dart';

/// A styled card widget designed to be rendered to an image for sharing.
/// Shows the patient's step stats, monthly rank, badges, and hospital branding.
class StepShareCard extends StatelessWidget {
  final String displayName;
  final int todaySteps;
  final double distanceKm;
  final int? weeklyRank;
  final int? monthlyRank;
  final String? monthlyRewardTier;
  final String avatarColor;
  final List<Map<String, String>> badges; // [{emoji, label}]

  const StepShareCard({
    super.key,
    required this.displayName,
    required this.todaySteps,
    required this.distanceKm,
    this.weeklyRank,
    this.monthlyRank,
    this.monthlyRewardTier,
    this.avatarColor = '#4CAF50',
    this.badges = const [],
  });

  Color _hexToColor(String hex) {
    final h = hex.replaceAll('#', '');
    try {
      return Color(int.parse('FF$h', radix: 16));
    } catch (_) {
      return Colors.teal;
    }
  }

  String _motivationalText() {
    if (todaySteps >= 10000) return '🎉 Daily goal crushed!';
    if (todaySteps >= 7500) return '💪 Almost there — keep going!';
    if (todaySteps >= 5000) return '🔥 Halfway to 10k!';
    if (todaySteps >= 2500) return '🚶 Great start today!';
    return '👟 Every step counts!';
  }

  @override
  Widget build(BuildContext context) {
    final accent = _hexToColor(avatarColor);

    return Container(
      width: 340,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [accent.withValues(alpha: 0.15), Colors.white],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: accent.withValues(alpha: 0.3), width: 1.5),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Header
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
            decoration: BoxDecoration(
              color: accent,
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(22),
                topRight: Radius.circular(22),
              ),
            ),
            child: Row(
              children: [
                CircleAvatar(
                  radius: 20,
                  backgroundColor: Colors.white.withValues(alpha: 0.3),
                  child: Text(
                    displayName.isNotEmpty ? displayName[0].toUpperCase() : 'W',
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 18,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        displayName,
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 16,
                        ),
                      ),
                      Text(
                        'VH Health Step Challenge',
                        style: TextStyle(
                          color: Colors.white.withValues(alpha: 0.8),
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
                const Text('🏥', style: TextStyle(fontSize: 24)),
              ],
            ),
          ),

          Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              children: [
                // Big step count
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(
                      _formatSteps(todaySteps),
                      style: TextStyle(
                        fontSize: 52,
                        fontWeight: FontWeight.bold,
                        color: accent,
                        height: 1,
                      ),
                    ),
                    const Padding(
                      padding: EdgeInsets.only(bottom: 8, left: 6),
                      child: Text('steps today', style: TextStyle(fontSize: 14, color: Colors.black54)),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  _motivationalText(),
                  style: const TextStyle(fontSize: 14, color: Colors.black87),
                ),
                const SizedBox(height: 16),

                // Stats row
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                  children: [
                    _StatPill(
                      emoji: '🗺️',
                      value: '${distanceKm.toStringAsFixed(2)} km',
                      label: 'Distance',
                      color: accent,
                    ),
                    if (weeklyRank != null)
                      _StatPill(
                        emoji: '📊',
                        value: '#$weeklyRank',
                        label: 'Week rank',
                        color: accent,
                      ),
                    if (monthlyRank != null)
                      _StatPill(
                        emoji: '📅',
                        value: '#$monthlyRank',
                        label: 'Month rank',
                        color: accent,
                      ),
                  ],
                ),

                // Reward tier
                if (monthlyRewardTier != null) ...[
                  const SizedBox(height: 12),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    decoration: BoxDecoration(
                      color: Colors.amber.shade50,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: Colors.amber.shade300),
                    ),
                    child: Row(
                      children: [
                        const Text('🎁', style: TextStyle(fontSize: 16)),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            monthlyRewardTier!,
                            style: TextStyle(
                              fontSize: 11,
                              color: Colors.amber.shade800,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],

                // Badges
                if (badges.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 6,
                    alignment: WrapAlignment.center,
                    children: badges.take(5).map((b) => Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: accent.withValues(alpha: 0.1),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: accent.withValues(alpha: 0.3)),
                      ),
                      child: Text(
                        '${b['emoji']} ${b['label']}',
                        style: TextStyle(fontSize: 11, color: accent, fontWeight: FontWeight.w500),
                      ),
                    )).toList(),
                  ),
                ],

                // Footer
                const SizedBox(height: 16),
                const Divider(height: 1),
                const SizedBox(height: 10),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      'Venkataeswara Hospitals, Chennai',
                      style: TextStyle(fontSize: 11, color: Colors.grey.shade500),
                    ),
                    const SizedBox(width: 6),
                    Text('•', style: TextStyle(color: Colors.grey.shade400)),
                    const SizedBox(width: 6),
                    Text(
                      'VH Health App',
                      style: TextStyle(fontSize: 11, color: Colors.grey.shade500, fontWeight: FontWeight.w500),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _formatSteps(int steps) {
    if (steps >= 1000) return '${(steps / 1000).toStringAsFixed(1)}k';
    return '$steps';
  }
}

class _StatPill extends StatelessWidget {
  final String emoji;
  final String value;
  final String label;
  final Color color;

  const _StatPill({
    required this.emoji,
    required this.value,
    required this.label,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(emoji, style: const TextStyle(fontSize: 20)),
        const SizedBox(height: 2),
        Text(value, style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: color)),
        Text(label, style: const TextStyle(fontSize: 10, color: Colors.black54)),
      ],
    );
  }
}
