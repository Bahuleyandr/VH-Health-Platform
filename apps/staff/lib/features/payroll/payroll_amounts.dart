import 'package:intl/intl.dart';

double payrollAmount(Object? value) {
  if (value == null) return 0;
  if (value is num) return value.toDouble();
  final normalized = value.toString().replaceAll(',', '').trim();
  if (normalized.isEmpty) return 0;
  return double.tryParse(normalized) ?? 0;
}

int payrollInt(Object? value) {
  if (value == null) return 0;
  if (value is num) return value.toInt();
  final normalized = value.toString().replaceAll(',', '').trim();
  if (normalized.isEmpty) return 0;
  return int.tryParse(normalized) ?? payrollAmount(normalized).toInt();
}

String payrollCurrency(
  Object? value, {
  NumberFormat? format,
  bool decimals = true,
}) {
  final fmt = format ?? NumberFormat(decimals ? '#,##,##0.00' : '#,##,##0');
  return '₹${fmt.format(payrollAmount(value))}';
}

bool payrollHasAmount(Object? value) => payrollAmount(value) > 0;
