class Validators {
  Validators._();

  static bool isValidPhone(String value) {
    final normalized = value.replaceAll(RegExp(r'\s+'), '');
    return RegExp(r'^[+]?[0-9]{10,15}$').hasMatch(normalized);
  }

  static bool isNotBlank(String? value) {
    return value != null && value.trim().isNotEmpty;
  }
}
