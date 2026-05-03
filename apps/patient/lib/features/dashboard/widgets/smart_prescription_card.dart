import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class SmartPrescriptionCard extends StatelessWidget {
  final Map<String, dynamic> prescription;
  final VoidCallback onOrderTap;
  final VoidCallback onViewTap;

  const SmartPrescriptionCard({
    super.key,
    required this.prescription,
    required this.onOrderTap,
    required this.onViewTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final doctorName = prescription['doctor_name']?.toString() ?? 'Doctor';
    final rxNumber = prescription['prescription_number']?.toString() ?? '';
    final itemCount =
        (prescription['items'] as List?)?.length ??
        prescription['medicine_count'] ??
        prescription['item_count'] ??
        0;

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.purple.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.purple.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: Colors.purple.withValues(alpha: 0.15),
              shape: BoxShape.circle,
            ),
            child: const Icon(
              LucideIcons.fileText,
              color: Colors.purple,
              size: 22,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'New Prescription${rxNumber.isNotEmpty ? ' $rxNumber' : ''}',
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Text(
                  'Dr. $doctorName${itemCount > 0 ? ' • $itemCount medicines' : ''}',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurface.withValues(alpha: 0.7),
                  ),
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    SizedBox(
                      height: 28,
                      child: FilledButton(
                        onPressed: onOrderTap,
                        style: FilledButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 10),
                          textStyle: const TextStyle(fontSize: 11),
                        ),
                        child: Text(AppLocalizations.of(context)!.yourHealthOrderMedicines),
                      ),
                    ),
                    const SizedBox(width: 8),
                    SizedBox(
                      height: 28,
                      child: OutlinedButton(
                        onPressed: onViewTap,
                        style: OutlinedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 10),
                          textStyle: const TextStyle(fontSize: 11),
                        ),
                        child: const Text('View'),
                      ),
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
}
