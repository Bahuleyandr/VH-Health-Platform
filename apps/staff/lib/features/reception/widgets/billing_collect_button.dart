import 'package:flutter/material.dart';

import '../../../l10n/app_strings.dart';

class BillingCollectButton extends StatelessWidget {
  final bool busy;
  final VoidCallback onPressed;

  const BillingCollectButton({
    super.key,
    required this.busy,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return SizedBox(
      height: 34,
      child: FilledButton.icon(
        onPressed: busy ? null : onPressed,
        icon: busy
            ? const SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.payments_outlined, size: 16),
        label: Text(busy ? s.billingCollectingButton : s.billingCollectButton),
      ),
    );
  }
}
