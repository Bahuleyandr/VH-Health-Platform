// Step 2 of the book-investigation wizard: collection preference (home vs
// walk-in, address, preferred date + time slot, notes). Extracted from
// book_investigation_screen.dart — presentational only; the screen owns
// the form state and handles every callback.
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class BookInvestigationStepCollection extends StatelessWidget {
  final String collectionType;
  final TextEditingController addressController;
  final TextEditingController landmarkController;
  final TextEditingController notesController;
  final DateTime? preferredDate;
  final String? preferredTimeSlot;
  final List<String> timeSlots;
  final List<String> timeSlotLabels;
  final ValueChanged<String> onCollectionTypeChanged;
  final VoidCallback onAddressChanged;
  final ValueChanged<DateTime> onDatePicked;
  final ValueChanged<String?> onTimeSlotChanged;

  const BookInvestigationStepCollection({
    super.key,
    required this.collectionType,
    required this.addressController,
    required this.landmarkController,
    required this.notesController,
    required this.preferredDate,
    required this.preferredTimeSlot,
    required this.timeSlots,
    required this.timeSlotLabels,
    required this.onCollectionTypeChanged,
    required this.onAddressChanged,
    required this.onDatePicked,
    required this.onTimeSlotChanged,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Collection type
        SegmentedButton<String>(
          segments: [
            ButtonSegment(
              value: 'home',
              label: Text(l.bookInvestigationHomeCollection),
              icon: const Icon(Icons.home),
            ),
            ButtonSegment(
              value: 'walk_in',
              label: Text(l.bookInvestigationVisitLab),
              icon: const Icon(Icons.local_hospital),
            ),
          ],
          selected: {collectionType},
          onSelectionChanged: (v) => onCollectionTypeChanged(v.first),
        ),
        const SizedBox(height: 16),

        if (collectionType == 'home') ...[
          TextField(
            controller: addressController,
            decoration: InputDecoration(
              labelText: 'Collection Address *',
              hintText: 'Enter your full address',
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              isDense: true,
            ),
            maxLines: 2,
            onChanged: (_) => onAddressChanged(),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: landmarkController,
            decoration: InputDecoration(
              labelText: 'Landmark',
              hintText: 'Near/opposite...',
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              isDense: true,
            ),
          ),
          const SizedBox(height: 12),
        ],

        // Date picker
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.calendar_today),
          title: Text(
            preferredDate != null
                ? DateFormat('EEEE, d MMM yyyy').format(preferredDate!)
                : 'Preferred Date',
          ),
          subtitle: preferredDate == null
              ? Text(l.bookInvestigationTapToSelect)
              : null,
          onTap: () async {
            final picked = await showDatePicker(
              context: context,
              initialDate: DateTime.now().add(const Duration(days: 1)),
              firstDate: DateTime.now(),
              lastDate: DateTime.now().add(const Duration(days: 30)),
            );
            if (picked != null) onDatePicked(picked);
          },
        ),

        // Time slot
        const SizedBox(height: 8),
        Text(
          l.bookInvestigationPreferredTimeSlot,
          style: theme.textTheme.titleSmall,
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: List.generate(timeSlots.length, (i) {
            final selected = preferredTimeSlot == timeSlots[i];
            return ChoiceChip(
              label: Text(timeSlotLabels[i]),
              selected: selected,
              onSelected: (v) =>
                  onTimeSlotChanged(v ? timeSlots[i] : null),
            );
          }),
        ),

        const SizedBox(height: 16),
        TextField(
          controller: notesController,
          decoration: InputDecoration(
            labelText: 'Notes (optional)',
            hintText: 'Any special instructions...',
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
            isDense: true,
          ),
          maxLines: 2,
        ),
      ],
    );
  }
}
