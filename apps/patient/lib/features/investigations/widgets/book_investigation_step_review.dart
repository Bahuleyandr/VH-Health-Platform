// Step 3 of the book-investigation wizard: review & confirm. Extracted from
// book_investigation_screen.dart — read-only summary, no callbacks; the
// screen resolves the values and the Stepper triggers the submit.
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class BookInvestigationStepReview extends StatelessWidget {
  final List<dynamic> selectedTests;
  final String customTestNames;
  final bool hasSlipPhoto;
  final String collectionType;
  final String collectionAddress;
  final DateTime? preferredDate;
  final String? preferredTimeSlot;
  final double estimatedCost;

  const BookInvestigationStepReview({
    super.key,
    required this.selectedTests,
    required this.customTestNames,
    required this.hasSlipPhoto,
    required this.collectionType,
    required this.collectionAddress,
    required this.preferredDate,
    required this.preferredTimeSlot,
    required this.estimatedCost,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          l.bookInvestigationReviewBooking,
          style: theme.textTheme.titleMedium,
        ),
        const SizedBox(height: 12),

        if (selectedTests.isNotEmpty) ...[
          Text(
            l.bookInvestigationSelectedTests,
            style: theme.textTheme.titleSmall,
          ),
          ...selectedTests.map(
            (t) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(
                children: [
                  const Icon(Icons.check, size: 16, color: Colors.green),
                  const SizedBox(width: 8),
                  Expanded(child: Text(t['name'] ?? '')),
                  Text('₹${t['default_cost'] ?? 0}'),
                ],
              ),
            ),
          ),
          const Divider(height: 16),
        ],

        if (customTestNames.isNotEmpty) ...[
          Text(
            l.bookInvestigationCustomTests,
            style: theme.textTheme.titleSmall,
          ),
          Text(customTestNames),
          const Divider(height: 16),
        ],

        if (hasSlipPhoto) ...[
          Row(
            children: [
              const Icon(Icons.photo, size: 16),
              const SizedBox(width: 8),
              Text(
                l.bookInvestigationSlipAttached,
                style: theme.textTheme.bodyMedium,
              ),
            ],
          ),
          const Divider(height: 16),
        ],

        // Collection info
        Row(
          children: [
            Icon(
              collectionType == 'home' ? Icons.home : Icons.local_hospital,
              size: 18,
            ),
            const SizedBox(width: 8),
            Text(
              collectionType == 'home'
                  ? l.bookInvestigationHomeCollection
                  : l.bookInvestigationVisitLab,
              style: theme.textTheme.titleSmall,
            ),
          ],
        ),
        if (collectionType == 'home' && collectionAddress.isNotEmpty) ...[
          const SizedBox(height: 4),
          Text('📍 $collectionAddress', style: theme.textTheme.bodySmall),
        ],
        if (preferredDate != null) ...[
          const SizedBox(height: 4),
          Text(
            '📅 ${DateFormat('d MMM yyyy').format(preferredDate!)}${preferredTimeSlot != null ? ' • $preferredTimeSlot' : ''}',
            style: theme.textTheme.bodySmall,
          ),
        ],

        if (selectedTests.isNotEmpty) ...[
          const Divider(height: 16),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: theme.colorScheme.primaryContainer.withValues(alpha: 0.3),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  l.bookInvestigationEstimatedCost,
                  style: theme.textTheme.titleSmall,
                ),
                Text(
                  '₹${estimatedCost.toStringAsFixed(0)}',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: theme.colorScheme.primary,
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}
