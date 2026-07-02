import 'package:flutter/material.dart';

class ClinicalPrintPdfAction extends StatelessWidget {
  final bool visible;
  final bool busy;
  final VoidCallback? onPressed;

  const ClinicalPrintPdfAction({
    super.key,
    required this.visible,
    required this.busy,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    if (!visible) return const SizedBox.shrink();
    return OutlinedButton.icon(
      onPressed: busy ? null : onPressed,
      icon: busy
          ? const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.print_outlined, size: 18),
      label: const Text('Print / Share PDF'),
    );
  }
}
