// lib/features/auth/widgets/phone_input_field.dart

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class PhoneInputField extends StatelessWidget {
  final TextEditingController controller;
  final bool readOnly;

  const PhoneInputField({
    super.key,
    required this.controller,
    required this.readOnly,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return TextFormField(
      controller: controller,
      keyboardType: TextInputType.phone,
      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
      readOnly: readOnly,
      textInputAction: TextInputAction.done,
      decoration: InputDecoration(
        labelText: l10n.authPhoneNumber,
        prefixText: l10n.authPhonePrefix,
        prefixIcon: const Icon(Icons.phone_outlined),
      ),
      validator: (v) {
        if (v == null || v.trim().isEmpty) {
          return l10n.authPhoneValidationEmpty;
        }
        if (!RegExp(r'^[0-9]{10}$').hasMatch(v.trim())) {
          return l10n.authPhoneValidationInvalid;
        }
        return null;
      },
      style: Theme.of(context).textTheme.bodyLarge,
    );
  }
}
