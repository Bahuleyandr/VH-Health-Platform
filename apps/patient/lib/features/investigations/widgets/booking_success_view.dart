// Success confirmation shown after an investigation booking is created.
// Extracted from book_investigation_screen.dart — fully self-contained,
// it only needs the booking result map.
import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class BookingSuccessView extends StatelessWidget {
  final Map<String, dynamic> bookingResult;
  const BookingSuccessView({super.key, required this.bookingResult});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.check_circle,
              size: 80,
              color: theme.colorScheme.primary,
            ),
            const SizedBox(height: 16),
            Text(
              l.bookInvestigationBooked,
              style: theme.textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              bookingResult['booking_number'] ?? '',
              style: theme.textTheme.titleLarge?.copyWith(
                color: theme.colorScheme.primary,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 8),
            if (bookingResult['estimated_cost'] != null)
              Text(
                '${l.bookInvestigationEstimatedCost}: ₹${bookingResult['estimated_cost']}',
                style: theme.textTheme.bodyLarge,
              ),
            const SizedBox(height: 16),
            Text(
              l.bookInvestigationConfirmationNote,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 32),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(),
              child: Text(l.bookInvestigationBackButton),
            ),
          ],
        ),
      ),
    );
  }
}
