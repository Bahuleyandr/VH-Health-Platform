import 'package:flutter/material.dart';
import '../../../l10n/app_strings.dart';

class ShiftCard extends StatelessWidget {
  final Map<String, dynamic>? shift;
  const ShiftCard({super.key, this.shift});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (shift == null || shift!.isEmpty) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              const Icon(Icons.schedule_outlined, size: 18, color: Colors.grey),
              const SizedBox(width: 8),
              Text(
                s.shiftCardNoShift,
                style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
              ),
            ],
          ),
        ),
      );
    }

    final name = shift!['name'] as String? ?? s.shiftCardFallbackName;
    final start = shift!['start_time'] as String? ?? '--:--';
    final end = shift!['end_time'] as String? ?? '--:--';
    final grace = shift!['grace_period_minutes'] as int? ?? 15;

    return Card(
      color: const Color(0xFF007A64).withValues(alpha: 0.08),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: const BorderSide(color: Color(0xFF007A64), width: 0.8),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          children: [
            const Icon(Icons.access_time, size: 18, color: Color(0xFF007A64)),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.shiftCardDisplayName(name),
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 13,
                      color: Color(0xFF007A64),
                    ),
                  ),
                  Text(
                    s.shiftCardTimeRangeGrace(start, end, grace),
                    style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
