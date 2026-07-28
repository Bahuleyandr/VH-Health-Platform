import 'package:flutter/material.dart';

import '../../l10n/app_strings.dart';

Future<void> showOfflineClinicalFallbackDialog(
  BuildContext context, {
  required String paperFormSet,
}) {
  final strings = AppStrings.of(context);
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) => PopScope(
      canPop: false,
      child: AlertDialog(
        icon: const Icon(Icons.assignment_outlined),
        title: Text(strings.offlineClinicalFallbackTitle),
        content: Text(strings.offlineClinicalFallbackMessage(paperFormSet)),
        actions: [
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: Text(strings.offlineClinicalFallbackKeepOpen),
          ),
        ],
      ),
    ),
  );
}
