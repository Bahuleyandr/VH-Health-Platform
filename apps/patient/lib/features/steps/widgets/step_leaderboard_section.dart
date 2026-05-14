// "Leaderboard" section on the Step Challenge screen — the caller's rank
// banner plus the ranked list. Display-only; extracted from
// step_challenge_screen.dart.
import 'package:flutter/material.dart';
import 'package:vhhealth/features/steps/models/step_models.dart';
import 'package:vhhealth/features/steps/step_formatters.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class StepLeaderboardSection extends StatelessWidget {
  final List<LeaderEntry> leaderboard;
  final Map<String, dynamic>? myRank;
  final bool loading;

  const StepLeaderboardSection({
    super.key,
    required this.leaderboard,
    required this.myRank,
    required this.loading,
  });

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              l.stepsLeaderboard,
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
            ),
            const Spacer(),
            Text(
              l.stepsThisMonth,
              style: const TextStyle(fontSize: 12, color: Colors.grey),
            ),
          ],
        ),
        const SizedBox(height: 4),
        if (myRank != null)
          Container(
            margin: const EdgeInsets.only(bottom: 8),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: const Color(0xFFE8F5E9),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: const Color(0xFF4CAF50)),
            ),
            child: Row(
              children: [
                const Icon(Icons.person, color: Color(0xFF4CAF50), size: 18),
                const SizedBox(width: 8),
                Text(
                  'Your rank: #${myRank!['rank']} — ${myRank!['totalSteps']} steps',
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF2E7D32),
                  ),
                ),
              ],
            ),
          ),
        loading
            ? const Center(
                child: Padding(
                  padding: EdgeInsets.all(16),
                  child: CircularProgressIndicator(),
                ),
              )
            : leaderboard.isEmpty
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    l.stepsNoLeaderboardData,
                    style: const TextStyle(color: Colors.grey),
                  ),
                ),
              )
            : ListView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: leaderboard.length,
                itemBuilder: (ctx, i) => _LeaderboardTile(entry: leaderboard[i]),
              ),
      ],
    );
  }
}

class _LeaderboardTile extends StatelessWidget {
  final LeaderEntry entry;
  const _LeaderboardTile({required this.entry});

  @override
  Widget build(BuildContext context) {
    final rankLabel = entry.rank == 1
        ? '🥇'
        : entry.rank == 2
        ? '🥈'
        : entry.rank == 3
        ? '🥉'
        : '#${entry.rank}';

    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: entry.isMe
            ? const Color(0xFFE8F5E9)
            : Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: entry.isMe
              ? const Color(0xFF4CAF50)
              : Theme.of(context).colorScheme.outlineVariant,
          width: entry.isMe ? 2 : 1,
        ),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 32,
            child: Text(
              rankLabel,
              style: const TextStyle(fontSize: 16),
              textAlign: TextAlign.center,
            ),
          ),
          const SizedBox(width: 8),
          CircleAvatar(
            radius: 16,
            backgroundColor: stepHexColor(entry.displayColor),
            child: Text(
              entry.displayName.isNotEmpty
                  ? entry.displayName[0].toUpperCase()
                  : '?',
              style: const TextStyle(
                color: Colors.white,
                fontSize: 12,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              entry.isMe ? '${entry.displayName} (You)' : entry.displayName,
              style: TextStyle(
                fontWeight: entry.isMe ? FontWeight.bold : FontWeight.normal,
              ),
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                '${entry.totalSteps}',
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF4CAF50),
                ),
              ),
              Text(
                stepDistKm(entry.totalDistanceMeters),
                style: const TextStyle(fontSize: 11, color: Colors.grey),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
