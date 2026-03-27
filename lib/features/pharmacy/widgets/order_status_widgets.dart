import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

// ═══════════════════════════════════════════════════════════════════════════════
// Shared pharmacy status / display widgets
// ═══════════════════════════════════════════════════════════════════════════════

class PharmacyDeliveryOption extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const PharmacyDeliveryOption({
    super.key,
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: BoxDecoration(
          color: selected
              ? const Color(0xFF7E57C2).withValues(alpha: 0.1)
              : theme.colorScheme.surfaceContainerHighest.withAlpha(128),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: selected ? const Color(0xFF7E57C2) : theme.colorScheme.outlineVariant,
            width: selected ? 2 : 1,
          ),
        ),
        child: Column(
          children: [
            Icon(icon,
                color: selected ? const Color(0xFF7E57C2) : theme.colorScheme.onSurfaceVariant,
                size: 28),
            const SizedBox(height: 4),
            Text(label,
                style: TextStyle(
                    color: selected ? const Color(0xFF7E57C2) : theme.colorScheme.onSurfaceVariant,
                    fontWeight: selected ? FontWeight.bold : FontWeight.normal,
                    fontSize: 13)),
          ],
        ),
      ),
    );
  }
}

class PharmacyOrderCard extends StatelessWidget {
  final Map<String, dynamic> order;
  final VoidCallback onTap;

  const PharmacyOrderCard({super.key, required this.order, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = order['status'] ?? 'PLACED';
    final orderNum = order['order_number'] ?? '#${order['id']}';
    final date = order['created_at'];
    final cost = order['total_cost'];

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      elevation: 1,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(orderNum,
                      style: const TextStyle(
                          fontWeight: FontWeight.bold, fontSize: 15)),
                  PharmacyStatusChip(status: status),
                ],
              ),
              const SizedBox(height: 8),
              // Mini status tracker
              PharmacyMiniStatusTracker(status: status),
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  if (date != null)
                    Text(_formatCardDate(date),
                        style: TextStyle(
                            color: theme.colorScheme.onSurfaceVariant, fontSize: 12)),
                  if (cost != null)
                    Text('\u20B9$cost',
                        style: const TextStyle(
                            fontWeight: FontWeight.bold,
                            color: Color(0xFF7E57C2))),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _formatCardDate(dynamic d) {
    try {
      return DateFormat('dd MMM, hh:mm a').format(DateTime.parse(d.toString()));
    } catch (_) {
      return '';
    }
  }
}

class PharmacyStatusChip extends StatelessWidget {
  final String status;
  const PharmacyStatusChip({super.key, required this.status});

  @override
  Widget build(BuildContext context) {
    final (color, label) = switch (status.toUpperCase()) {
      'PLACED' => (Colors.orange, 'Placed'),
      'CONFIRMED' => (Colors.blue, 'Confirmed'),
      'PREPARING' => (Colors.amber.shade700, 'Preparing'),
      'DISPATCHED' => (Colors.teal, 'Dispatched'),
      'DELIVERED' => (Colors.green, 'Delivered'),
      'CANCELLED' => (Colors.red, 'Cancelled'),
      _ => (Colors.grey, status),
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(label,
          style: TextStyle(
              color: color, fontSize: 12, fontWeight: FontWeight.w600)),
    );
  }
}

class PharmacyMiniStatusTracker extends StatelessWidget {
  final String status;
  const PharmacyMiniStatusTracker({super.key, required this.status});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (status.toUpperCase() == 'CANCELLED') {
      return Row(
        children: [
          Icon(Icons.cancel, color: Colors.red.shade400, size: 16),
          const SizedBox(width: 4),
          Text('Order Cancelled',
              style: TextStyle(color: Colors.red.shade400, fontSize: 12)),
        ],
      );
    }

    const steps = ['PLACED', 'CONFIRMED', 'PREPARING', 'DISPATCHED', 'DELIVERED'];
    final currentIdx = steps.indexOf(status.toUpperCase());

    return Row(
      children: List.generate(steps.length * 2 - 1, (i) {
        if (i.isOdd) {
          // Connector line
          final stepIdx = i ~/ 2;
          return Expanded(
            child: Container(
              height: 2,
              color: stepIdx < currentIdx
                  ? const Color(0xFF7E57C2)
                  : theme.colorScheme.outlineVariant,
            ),
          );
        }
        final stepIdx = i ~/ 2;
        final done = stepIdx <= currentIdx;
        return Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: done ? const Color(0xFF7E57C2) : theme.colorScheme.outlineVariant,
          ),
        );
      }),
    );
  }
}

class PharmacyStatusTracker extends StatelessWidget {
  final String status;
  const PharmacyStatusTracker({super.key, required this.status});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (status.toUpperCase() == 'CANCELLED') {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.red.shade50,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: [
            Icon(Icons.cancel, color: Colors.red.shade400, size: 32),
            const SizedBox(width: 12),
            const Text('Order Cancelled',
                style: TextStyle(
                    color: Colors.red,
                    fontWeight: FontWeight.bold,
                    fontSize: 16)),
          ],
        ),
      );
    }

    const steps = [
      ('PLACED', 'Order Placed', Icons.receipt_long),
      ('CONFIRMED', 'Confirmed', Icons.check_circle),
      ('PREPARING', 'Preparing', Icons.medication),
      ('DISPATCHED', 'Dispatched', Icons.delivery_dining),
      ('DELIVERED', 'Delivered', Icons.done_all),
    ];
    final currentIdx =
        steps.indexWhere((s) => s.$1 == status.toUpperCase());

    return Column(
      children: List.generate(steps.length, (i) {
        final (_, label, icon) = steps[i];
        final done = i <= currentIdx;
        final current = i == currentIdx;

        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Column(
              children: [
                Container(
                  width: 28,
                  height: 28,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: done
                        ? const Color(0xFF7E57C2)
                        : theme.colorScheme.surfaceContainerHighest,
                  ),
                  child: Icon(icon,
                      size: 16,
                      color: done ? theme.colorScheme.onPrimary : theme.colorScheme.onSurfaceVariant),
                ),
                if (i < steps.length - 1)
                  Container(
                    width: 2,
                    height: 24,
                    color: i < currentIdx
                        ? const Color(0xFF7E57C2)
                        : theme.colorScheme.surfaceContainerHighest,
                  ),
              ],
            ),
            const SizedBox(width: 12),
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(label,
                  style: TextStyle(
                    fontWeight: current ? FontWeight.bold : FontWeight.normal,
                    color: done ? theme.colorScheme.onSurface : theme.colorScheme.onSurfaceVariant,
                    fontSize: 14,
                  )),
            ),
          ],
        );
      }),
    );
  }
}

class PharmacyInfoRow extends StatelessWidget {
  final IconData icon;
  final String text;
  const PharmacyInfoRow(this.icon, this.text, {super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: [
          Icon(icon, size: 16, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(width: 8),
          Expanded(
              child: Text(text,
                  style: TextStyle(color: theme.colorScheme.onSurfaceVariant, fontSize: 13))),
        ],
      ),
    );
  }
}
