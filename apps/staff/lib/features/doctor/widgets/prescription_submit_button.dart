import 'package:flutter/material.dart';

import '../../../l10n/app_strings.dart';

class PrescriptionSubmitButton extends StatelessWidget {
  final bool submitting;
  final bool locked;
  final String submitLabel;
  final VoidCallback onSubmit;

  const PrescriptionSubmitButton({
    super.key,
    required this.submitting,
    required this.locked,
    required this.submitLabel,
    required this.onSubmit,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return ElevatedButton.icon(
      onPressed: submitting || locked ? null : onSubmit,
      icon: submitting
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                color: Colors.white,
                strokeWidth: 2,
              ),
            )
          : const Icon(Icons.save, color: Colors.white),
      label: Text(submitting ? s.prescriptionsCreating : submitLabel),
      style: ElevatedButton.styleFrom(
        backgroundColor: const Color(0xFF00838F),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      ),
    );
  }
}
