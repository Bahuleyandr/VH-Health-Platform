import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

class SmartPharmacyCard extends StatelessWidget {
  final Map<String, dynamic> order;
  final VoidCallback onTap;

  const SmartPharmacyCard({
    super.key,
    required this.order,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final orderNumber = order['order_number']?.toString() ?? '';
    final status = order['status']?.toString().toUpperCase() ?? '';
    final color = _pharmacyStatusColor(status);

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
              child: Icon(LucideIcons.pill, color: color, size: 22),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Pharmacy Order ${orderNumber.isNotEmpty ? orderNumber : ''}',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
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
                          _pharmacyStatusLabel(status),
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: Colors.white,
                            fontWeight: FontWeight.bold,
                            fontSize: 9,
                          ),
                        ),
                      ),
                    ],
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

  Color _pharmacyStatusColor(String status) {
    switch (status) {
      case 'PENDING':
      case 'PLACED': // legacy alias — kept for backward compatibility
        return Colors.orange;
      case 'CONFIRMED':
        return Colors.blue;
      case 'PREPARING':
      case 'READY':
        return Colors.purple;
      case 'DISPATCHED':
        return Colors.teal;
      case 'OUT_FOR_DELIVERY':
        return Colors.green;
      default:
        return Colors.grey;
    }
  }

  String _pharmacyStatusLabel(String status) {
    switch (status) {
      case 'PENDING':
      case 'PLACED':
        return 'PENDING';
      case 'CONFIRMED':
        return 'CONFIRMED';
      case 'PREPARING':
        return 'PREPARING';
      case 'READY':
        return 'READY';
      case 'DISPATCHED':
        return 'DISPATCHED 🚗';
      case 'OUT_FOR_DELIVERY':
        return 'ON THE WAY 🚗';
      default:
        return status;
    }
  }
}
