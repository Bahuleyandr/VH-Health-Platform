import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

class SmartInvestigationCard extends StatelessWidget {
  final Map<String, dynamic> booking;
  final VoidCallback onTap;

  const SmartInvestigationCard({
    super.key,
    required this.booking,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final bookingNumber = booking['booking_number']?.toString() ?? '';
    final status = booking['status']?.toString().toUpperCase() ?? '';
    final color = _invStatusColor(status);

    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.fromLTRB(16, 4, 16, 4),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: color.withValues(alpha: 0.25)),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.15),
                shape: BoxShape.circle,
              ),
              child: Icon(LucideIcons.flaskConical, color: color, size: 22),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Lab Booking ${bookingNumber.isNotEmpty ? bookingNumber : ''}',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 1,
                    ),
                    decoration: BoxDecoration(
                      color: color,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      _invStatusLabel(status),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: Colors.white,
                        fontWeight: FontWeight.bold,
                        fontSize: 9,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Icon(LucideIcons.chevronRight, color: color, size: 20),
          ],
        ),
      ),
    );
  }

  Color _invStatusColor(String status) {
    switch (status) {
      case 'BOOKED':
        return Colors.orange;
      case 'DISPATCHED':
        return Colors.teal;
      case 'SAMPLE_COLLECTED':
        return Colors.blue;
      default:
        return Colors.grey;
    }
  }

  String _invStatusLabel(String status) {
    switch (status) {
      case 'BOOKED':
        return 'BOOKED';
      case 'DISPATCHED':
        return 'COLLECTOR ON THE WAY';
      case 'SAMPLE_COLLECTED':
        return 'SAMPLE COLLECTED';
      default:
        return status;
    }
  }
}
