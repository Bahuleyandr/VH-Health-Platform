import 'package:flutter/material.dart';

import '../../l10n/app_strings.dart';

class VitalUnit {
  static const pulse = '/min';
  static const respiratoryRate = '/min';
  static const bp = 'mm Hg';
  static const spo2 = '%';
  static const cbg = 'mg/dl';
  static const weight = 'Kg';
  static const temperature = 'deg F';
  static const pain = '/10';
  static const gcs = '/15';
}

String normalizeVitalValue(String value, String unit) {
  var text = value.trim();
  if (text.isEmpty) return '';
  final pattern = switch (unit) {
    VitalUnit.temperature => r'(?:deg\s*F|°\s*F)',
    VitalUnit.bp => r'mm\s*Hg',
    VitalUnit.cbg => r'mg\s*/\s*d[lL]',
    VitalUnit.pulse => r'/\s*min',
    VitalUnit.weight => r'Kg|kg',
    VitalUnit.spo2 => r'%',
    VitalUnit.pain => r'/\s*10',
    VitalUnit.gcs => r'/\s*15',
    _ => RegExp.escape(unit),
  };
  text = text.replaceAll(
    RegExp('\\s*$pattern\\s*\$', caseSensitive: false),
    '',
  );
  return text.trim();
}

String vitalValueWithUnit(dynamic value, String unit) {
  final text = (value ?? '').toString().trim();
  if (text.isEmpty) return '';
  if (text.toLowerCase().contains(unit.toLowerCase()) ||
      (unit == VitalUnit.temperature &&
          RegExp(r'(deg\s*f|°\s*f)', caseSensitive: false).hasMatch(text)) ||
      (unit == VitalUnit.bp &&
          RegExp(r'mm\s*hg', caseSensitive: false).hasMatch(text)) ||
      (unit == VitalUnit.cbg &&
          RegExp(r'mg\s*/\s*dl', caseSensitive: false).hasMatch(text))) {
    return text;
  }
  return '$text $unit';
}

class VitalTextField extends StatelessWidget {
  final TextEditingController controller;
  final String label;
  final String unit;
  final IconData? icon;
  final bool validateNumber;
  final TextInputType keyboardType;

  const VitalTextField({
    super.key,
    required this.controller,
    required this.label,
    required this.unit,
    this.icon,
    this.validateNumber = false,
    this.keyboardType = const TextInputType.numberWithOptions(decimal: true),
  });

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: controller,
      keyboardType: keyboardType,
      decoration: InputDecoration(
        labelText: label,
        suffixText: unit,
        prefixIcon: icon == null
            ? null
            : ExcludeSemantics(child: Icon(icon, size: 20)),
        border: const OutlineInputBorder(),
        isDense: true,
      ),
      validator: validateNumber
          ? (value) {
              final text = normalizeVitalValue(value ?? '', unit);
              if (text.isEmpty) return null;
              return num.tryParse(text) == null
                  ? AppStrings.of(context)
                        .lookup('s4.lib.vital_text_field.enter_valid_number')
                  : null;
            }
          : null,
    );
  }
}
