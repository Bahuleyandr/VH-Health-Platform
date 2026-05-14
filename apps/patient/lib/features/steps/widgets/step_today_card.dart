// "Today's Activity" card on the Step Challenge screen — steps, distance
// and a goal-progress bar. Display-only; extracted from
// step_challenge_screen.dart.
import 'package:flutter/material.dart';
import 'package:vhhealth/features/steps/models/step_models.dart';
import 'package:vhhealth/features/steps/step_formatters.dart';

class StepTodayCard extends StatelessWidget {
  final DailyRow? today;
  final int dailyGoal;

  const StepTodayCard({
    super.key,
    required this.today,
    required this.dailyGoal,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final steps = today?.steps ?? 0;
    final dist = today?.distanceMeters ?? 0.0;
    final goal = dailyGoal;
    final pct = (steps / goal).clamp(0.0, 1.0);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              "Today's Activity",
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
            ),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                Column(
                  children: [
                    Text(
                      '$steps',
                      style: const TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.bold,
                        color: Color(0xFF4CAF50),
                      ),
                    ),
                    Text(
                      'steps',
                      style: TextStyle(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
                Column(
                  children: [
                    Text(
                      stepDistKm(dist),
                      style: const TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.bold,
                        color: Color(0xFF2196F3),
                      ),
                    ),
                    Text(
                      'distance',
                      style: TextStyle(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 12),
            LinearProgressIndicator(
              value: pct,
              backgroundColor: theme.colorScheme.outlineVariant,
              color: pct >= 1.0 ? Colors.green : const Color(0xFF4CAF50),
              minHeight: 8,
              borderRadius: BorderRadius.circular(4),
            ),
            const SizedBox(height: 4),
            Text(
              pct >= 1.0
                  ? '🎉 Daily goal reached!'
                  : '${(pct * 100).toStringAsFixed(0)}% of $goal-step goal',
              style: TextStyle(
                fontSize: 12,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
