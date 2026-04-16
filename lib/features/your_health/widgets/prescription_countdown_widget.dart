// lib/features/your_health/widgets/prescription_countdown_widget.dart
//
// Small circular ring that visualises how much of a prescription's duration
// has elapsed, and how many days remain. Uses `RingProgressPainter` from
// `lib/core/widgets/health_charts.dart`.

import 'package:flutter/material.dart';

import 'package:vhhealth/core/widgets/health_charts.dart';

class PrescriptionCountdown extends StatelessWidget {
  final DateTime startDate;
  final int durationDays;

  /// Diameter of the ring. Defaults to 56 so it fits in the CircleAvatar slot
  /// on prescription cards.
  final double size;

  const PrescriptionCountdown({
    super.key,
    required this.startDate,
    required this.durationDays,
    this.size = 56,
  });

  /// Parses a best-effort duration (in days) from prescription data. Looks at:
  ///  1. top-level `duration_days` (backend `prescriptions` table)
  ///  2. the maximum duration in `medications[].duration` parsed as text
  ///     (e.g. "30 days", "2 weeks", "10d")
  /// Returns null if no usable duration can be extracted.
  static int? parseDurationDays(Map<String, dynamic> rx) {
    final top = rx['duration_days'];
    if (top is int) return top;
    if (top is num) return top.toInt();
    if (top is String) {
      final n = int.tryParse(top);
      if (n != null) return n;
    }
    final meds = rx['medications'] as List? ?? const [];
    int? best;
    for (final m in meds) {
      if (m is! Map) continue;
      final text = (m['duration'] ?? '').toString().toLowerCase().trim();
      if (text.isEmpty) continue;
      final days = _parseDurationString(text);
      if (days != null && (best == null || days > best)) best = days;
    }
    return best;
  }

  static int? _parseDurationString(String text) {
    final m = RegExp(r'(\d+)\s*(d|day|days|w|wk|week|weeks|m|mo|month|months)?')
        .firstMatch(text);
    if (m == null) return null;
    final n = int.tryParse(m.group(1)!);
    if (n == null) return null;
    final unit = (m.group(2) ?? 'd').toLowerCase();
    if (unit.startsWith('w')) return n * 7;
    if (unit.startsWith('m')) return n * 30;
    return n; // days (default)
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final total = durationDays.clamp(1, 365);
    final elapsed = DateTime.now().difference(startDate).inDays.clamp(0, total);
    final remaining = (total - elapsed).clamp(0, total);
    final progress = (elapsed / total).clamp(0.0, 1.0);
    final isCompleted = remaining == 0;
    final lowTime = remaining > 0 && remaining <= 7;

    final ringColor = isCompleted
        ? Colors.green.shade600
        : lowTime
            ? Colors.red.shade600
            : theme.colorScheme.primary;

    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(
        painter: RingProgressPainter(
          progress: isCompleted ? 1.0 : progress,
          color: ringColor,
          backgroundColor: ringColor.withValues(alpha: 0.12),
          strokeWidth: 5,
          padding: 4,
        ),
        child: Center(
          child: isCompleted
              ? Icon(Icons.check, color: ringColor, size: size * 0.4)
              : Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      '$remaining',
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: ringColor,
                        height: 1.0,
                      ),
                    ),
                    Text(
                      remaining == 1 ? 'day' : 'days',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: ringColor,
                        fontSize: 9,
                        height: 1.0,
                      ),
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}
