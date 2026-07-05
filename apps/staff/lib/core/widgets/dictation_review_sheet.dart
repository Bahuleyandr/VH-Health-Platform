import 'package:flutter/material.dart';

import '../../l10n/app_strings.dart';

class DictationReviewDestination {
  const DictationReviewDestination({
    required this.id,
    required this.label,
    required this.controller,
    required this.text,
  });

  final String id;
  final String label;
  final TextEditingController controller;
  final String text;
}

Future<bool> showDictationReviewSheet({
  required BuildContext context,
  required List<DictationReviewDestination> destinations,
}) async {
  final nonEmpty = destinations
      .where((destination) => destination.text.trim().isNotEmpty)
      .toList(growable: false);
  if (nonEmpty.isEmpty) return false;

  final editors = <String, TextEditingController>{
    for (final destination in nonEmpty)
      destination.id: TextEditingController(text: destination.text.trim()),
  };

  try {
    final inserted = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) {
        final strings = AppStrings.of(sheetContext);
        return SafeArea(
          child: Padding(
            padding: EdgeInsets.only(
              left: 20,
              right: 20,
              top: 18,
              bottom: MediaQuery.of(sheetContext).viewInsets.bottom + 16,
            ),
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    strings.voiceDictateReviewTitle,
                    style: Theme.of(sheetContext).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 16),
                  for (final destination in nonEmpty) ...[
                    Text(
                      destination.label,
                      style: Theme.of(sheetContext).textTheme.labelLarge,
                    ),
                    const SizedBox(height: 6),
                    TextField(
                      controller: editors[destination.id],
                      minLines: 2,
                      maxLines: 6,
                      decoration: const InputDecoration(
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 14),
                  ],
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      TextButton(
                        onPressed: () => Navigator.of(sheetContext).pop(false),
                        child: Text(strings.actionCancel),
                      ),
                      const SizedBox(width: 8),
                      FilledButton.icon(
                        onPressed: () {
                          for (final destination in nonEmpty) {
                            final text = editors[destination.id]!.text.trim();
                            if (text.isEmpty) continue;
                            _appendToController(destination.controller, text);
                          }
                          Navigator.of(sheetContext).pop(true);
                        },
                        icon: const Icon(Icons.playlist_add_check),
                        label: Text(strings.voiceDictateReviewInsert),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
    return inserted ?? false;
  } finally {
    for (final editor in editors.values) {
      editor.dispose();
    }
  }
}

void _appendToController(TextEditingController controller, String text) {
  final existing = controller.text.trimRight();
  final glue = existing.isEmpty ? '' : '\n';
  controller.value = TextEditingValue(
    text: '$existing$glue$text',
    selection: TextSelection.collapsed(offset: '$existing$glue$text'.length),
  );
}
