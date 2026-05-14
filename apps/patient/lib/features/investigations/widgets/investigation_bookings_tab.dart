// "My Bookings" tab of InvestigationsScreen — a Book button plus the
// embedded MyBookingsScreen list. Extracted unchanged (the dead unused
// `theme` local was dropped).
import 'package:flutter/material.dart';
import 'package:vhhealth/features/investigations/screens/book_investigation_screen.dart';
import 'package:vhhealth/features/investigations/screens/my_bookings_screen.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class InvestigationBookingsTab extends StatelessWidget {
  const InvestigationBookingsTab({super.key});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // Book Investigation button
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
          child: SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: () async {
                await Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => const BookInvestigationScreen(),
                  ),
                );
              },
              icon: const Icon(Icons.add),
              label: Text(
                AppLocalizations.of(context)!.investigationsBookButton,
              ),
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
          ),
        ),
        // My bookings list
        const Expanded(child: MyBookingsScreen()),
      ],
    );
  }
}
