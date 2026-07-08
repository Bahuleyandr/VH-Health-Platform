import 'package:flutter/material.dart';

import '../../../l10n/app_strings.dart';
import '../models/physio_models.dart';

class PhysioWorklistCard extends StatelessWidget {
  final PhysioWorklistItem item;
  final bool selected;
  final VoidCallback? onTap;

  const PhysioWorklistCard({
    super.key,
    required this.item,
    this.selected = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    final outcome = item.latestOutcomeScore == null
        ? null
        : s.format('physio.outcome_value', {
            'score': item.latestOutcomeScore!.toStringAsFixed(0),
          });

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(
        side: BorderSide(
          color: selected ? theme.colorScheme.primary : theme.dividerColor,
          width: selected ? 2 : 1,
        ),
        borderRadius: BorderRadius.circular(8),
      ),
      child: InkWell(
        key: Key('physio_worklist_${item.patientUid}'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      item.patientName.isEmpty
                          ? item.patientUid
                          : item.patientName,
                      style: theme.textTheme.titleMedium,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  _Chip(label: s.lookup(_originKey(item.originKind))),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                item.reason?.trim().isNotEmpty == true
                    ? item.reason!.trim()
                    : item.patientUid,
                style: theme.textTheme.bodySmall,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  _Chip(
                    label: s.format('physio.status_value', {
                      'status': item.status,
                    }),
                  ),
                  if (item.carePlanName?.trim().isNotEmpty == true)
                    _Chip(label: item.carePlanName!.trim()),
                  if (outcome != null) _Chip(label: outcome),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  final String label;

  const _Chip({required this.label});

  @override
  Widget build(BuildContext context) {
    return Chip(
      label: Text(label),
      visualDensity: VisualDensity.compact,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
    );
  }
}

String _originKey(String value) {
  return switch (value) {
    'consultation' => 'physio.origin.consultation',
    'discharge' => 'physio.origin.discharge',
    _ => 'physio.origin.manual',
  };
}
