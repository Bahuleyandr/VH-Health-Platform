// "Your Rewards" section on the Step Challenge screen. Display-only;
// extracted from step_challenge_screen.dart.
import 'package:flutter/material.dart';
import 'package:vhhealth/features/steps/models/step_models.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class StepRewardsSection extends StatelessWidget {
  final List<Reward> rewards;
  final bool loading;

  const StepRewardsSection({
    super.key,
    required this.rewards,
    required this.loading,
  });

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(8),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (rewards.isEmpty) return const SizedBox.shrink();

    final l = AppLocalizations.of(context)!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '${l.stepsYourRewards} 🏆',
          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
        ),
        const SizedBox(height: 8),
        ...rewards.map(
          (r) => Card(
            color: r.isApplied
                ? Theme.of(context).colorScheme.surfaceContainerLow
                : const Color(0xFFFFF9C4),
            child: ListTile(
              leading: const Icon(Icons.emoji_events, color: Colors.amber),
              title: Text(
                r.displayText,
                style: TextStyle(
                  fontSize: 14,
                  color: r.isApplied
                      ? Theme.of(context).colorScheme.onSurfaceVariant
                      : Theme.of(context).colorScheme.onSurface,
                  decoration: r.isApplied ? TextDecoration.lineThrough : null,
                ),
              ),
              trailing: r.isApplied
                  ? const Icon(Icons.check_circle, color: Colors.grey, size: 20)
                  : const Icon(Icons.star, color: Colors.amber, size: 20),
            ),
          ),
        ),
      ],
    );
  }
}
