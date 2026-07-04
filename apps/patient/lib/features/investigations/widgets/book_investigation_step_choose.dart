// Step 1 of the book-investigation wizard: choose tests (catalog search,
// custom test names, prescription-slip upload, estimated cost). Extracted
// from book_investigation_screen.dart — presentational only; the screen
// owns the form state and handles every callback.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class BookInvestigationStepChoose extends StatelessWidget {
  final bool loadingCatalog;
  final Map<String, List<dynamic>> groupedCatalog;
  final Set<int> selectedTestIds;
  final TextEditingController customTestController;
  final File? slipPhoto;
  final String? slipPhotoName;
  final double estimatedCost;
  final ValueChanged<String> onSearchChanged;
  final void Function(int id, bool? selected) onTestToggle;
  final VoidCallback onCustomTestChanged;
  final VoidCallback onPickCamera;
  final VoidCallback onPickGallery;
  final VoidCallback onRemoveSlip;

  const BookInvestigationStepChoose({
    super.key,
    required this.loadingCatalog,
    required this.groupedCatalog,
    required this.selectedTestIds,
    required this.customTestController,
    required this.slipPhoto,
    required this.slipPhotoName,
    required this.estimatedCost,
    required this.onSearchChanged,
    required this.onTestToggle,
    required this.onCustomTestChanged,
    required this.onPickCamera,
    required this.onPickGallery,
    required this.onRemoveSlip,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Search
        TextField(
          decoration: InputDecoration(
            hintText: l.bookInvestigationSearchHint,
            prefixIcon: const Icon(Icons.search),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
            isDense: true,
          ),
          onChanged: onSearchChanged,
        ),
        const SizedBox(height: 12),

        // Test catalog
        if (loadingCatalog)
          const Center(child: CircularProgressIndicator())
        else ...[
          ...groupedCatalog.entries.map((entry) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    entry.key.toUpperCase(),
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: theme.colorScheme.primary,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                ...entry.value.map((test) {
                  final id = test['id'] as int;
                  final selected = selectedTestIds.contains(id);
                  final cost = test['default_cost'] ?? 0;
                  return CheckboxListTile(
                    value: selected,
                    onChanged: (v) => onTestToggle(id, v),
                    title: Text(test['name'] ?? ''),
                    subtitle: Text(
                      test['requires_fasting'] == true
                          ? l.bookInvestigationCostFasting(cost.toString())
                          : '₹$cost',
                      style: TextStyle(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    controlAffinity: ListTileControlAffinity.leading,
                  );
                }),
              ],
            );
          }),
        ],

        const Divider(height: 24),

        // Custom test names
        Text(l.bookInvestigationOrType, style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        TextField(
          controller: customTestController,
          decoration: InputDecoration(
            hintText: l.bookInvestigationCustomTestHint,
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
            isDense: true,
          ),
          maxLines: 2,
          onChanged: (_) => onCustomTestChanged(),
        ),

        const Divider(height: 24),

        // Upload prescription slip
        Text(
          l.bookInvestigationOrUploadSlip,
          style: theme.textTheme.titleSmall,
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            OutlinedButton.icon(
              onPressed: onPickCamera,
              icon: const Icon(Icons.camera_alt),
              label: Text(l.bookInvestigationCameraButton),
            ),
            const SizedBox(width: 8),
            OutlinedButton.icon(
              onPressed: onPickGallery,
              icon: const Icon(Icons.photo_library),
              label: Text(l.bookInvestigationGalleryButton),
            ),
          ],
        ),
        if (slipPhoto != null) ...[
          const SizedBox(height: 8),
          Row(
            children: [
              const Icon(Icons.check_circle, color: Colors.green, size: 20),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  slipPhotoName ?? l.bookInvestigationPhotoSelected,
                  style: theme.textTheme.bodySmall,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              IconButton(
                icon: const Icon(Icons.close, size: 18),
                onPressed: onRemoveSlip,
              ),
            ],
          ),
        ],

        // Estimated cost
        if (selectedTestIds.isNotEmpty) ...[
          const Divider(height: 24),
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
