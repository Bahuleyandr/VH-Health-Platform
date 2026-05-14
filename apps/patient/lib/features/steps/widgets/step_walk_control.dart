// GPS walk control on the Step Challenge screen — the big Start button,
// or the live in-progress card with steps/distance/elapsed + Stop.
// Presentational; the screen owns the GPS/pedometer session state and
// handles onStart / onStop.
import 'package:flutter/material.dart';
import 'package:vhhealth/features/steps/step_formatters.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class StepWalkControl extends StatelessWidget {
  final bool isWalking;
  final int estimatedSteps;
  final double totalDistanceMeters;
  final int elapsedSeconds;
  final VoidCallback onStart;
  final VoidCallback onStop;

  const StepWalkControl({
    super.key,
    required this.isWalking,
    required this.estimatedSteps,
    required this.totalDistanceMeters,
    required this.elapsedSeconds,
    required this.onStart,
    required this.onStop,
  });

  static String _formatElapsed(int seconds) {
    final m = (seconds ~/ 60).toString().padLeft(2, '0');
    final s = (seconds % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    if (!isWalking) {
      return SizedBox(
        width: double.infinity,
        height: 64,
        child: ElevatedButton.icon(
          icon: const Icon(Icons.directions_walk, size: 28),
          label: Text(
            l.stepsStartWalkUpper,
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
          ),
          style: ElevatedButton.styleFrom(
            backgroundColor: Colors.green[600],
            foregroundColor: Colors.white,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
            ),
          ),
          onPressed: onStart,
        ),
      );
    }

    // Active walk
    return Card(
      color: Colors.green[50],
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Text(
              l.stepsWalkInProgress,
              style: const TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 16,
                color: Colors.green,
              ),
            ),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                _statChip(Icons.directions_walk, '$estimatedSteps', 'steps'),
                _statChip(
                  Icons.straighten,
                  stepDistKm(totalDistanceMeters),
                  'distance',
                ),
                _statChip(
                  Icons.timer,
                  _formatElapsed(elapsedSeconds),
                  'elapsed',
                ),
              ],
            ),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              height: 52,
              child: ElevatedButton.icon(
                icon: const Icon(Icons.stop_circle_outlined, size: 24),
                label: Text(
                  l.stepsStopWalkUpper,
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.red[600],
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
                onPressed: onStop,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _statChip(IconData icon, String value, String label) {
    return Column(
      children: [
        Icon(icon, color: Colors.green[700], size: 22),
        const SizedBox(height: 4),
        Text(
          value,
          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
        ),
        Text(label, style: const TextStyle(fontSize: 11, color: Colors.grey)),
      ],
    );
  }
}
