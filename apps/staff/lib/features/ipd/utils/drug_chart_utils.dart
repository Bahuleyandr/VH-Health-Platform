String deriveDoseFromDrug(String drugName) {
  final text = drugName.trim();
  if (text.isEmpty) return '';

  final matches =
      RegExp(
            r'(\d+(?:\.\d+)?\s*(?:mcg|mg|gm|g|kg|ml|mL|ML|l|L|iu|IU|units?|%)\b(?:\s*/\s*\d+(?:\.\d+)?\s*(?:ml|mL|ML|l|L))?)',
            caseSensitive: false,
          )
          .allMatches(text)
          .map((match) => match.group(1) ?? '')
          .where((match) => match.trim().isNotEmpty);

  final values = matches.toList();
  if (values.isEmpty) return '';

  final raw = values.last.trim();
  return raw
      .replaceAll(RegExp(r'\s+'), ' ')
      .replaceAllMapped(
        RegExp(
          r'^(\d+(?:\.\d+)?)(mcg|mg|gm|g|kg|ml|mL|ML|l|L|iu|IU|units?|%)$',
        ),
        (match) => '${match.group(1)} ${match.group(2)}',
      )
      .replaceAll(RegExp(r'\bgm\b', caseSensitive: false), 'g')
      .replaceAll(RegExp(r'\bml\b', caseSensitive: false), 'mL')
      .replaceAll(RegExp(r'\biu\b', caseSensitive: false), 'IU');
}

bool isAntibioticMedication(String drugName, {Map<String, dynamic>? details}) {
  final explicit = details?['is_antibiotic'] ?? details?['antibiotic'];
  if (explicit == true) return true;

  final category =
      [
            details?['category'],
            details?['drug_class'],
            details?['therapeutic_class'],
          ]
          .whereType<Object>()
          .map((value) => value.toString().toLowerCase())
          .join(' ');
  if (category.contains('antibiotic') || category.contains('antimicrobial')) {
    return true;
  }

  final text = [drugName, details?['generic_name'], details?['generic']]
      .whereType<Object>()
      .map((value) => value.toString().toLowerCase())
      .join(' ');

  return RegExp(
    r'\b(amoxicillin|amoxyclav|amoxiclav|clavulanate|cef|ceftriaxone|cefixime|cefotaxime|cefuroxime|ceftazidime|piperacillin|tazobactam|meropenem|imipenem|ertapenem|azithromycin|clarithromycin|doxycycline|metronidazole|ciprofloxacin|levofloxacin|ofloxacin|moxifloxacin|gentamicin|amikacin|vancomycin|teicoplanin|linezolid|clindamycin|colistin|polymyxin|nitrofurantoin|fosfomycin)\b',
  ).hasMatch(text);
}

int antibioticDay(DateTime startedAt, {DateTime? now}) {
  final current = now ?? DateTime.now();
  final startDate = DateTime(startedAt.year, startedAt.month, startedAt.day);
  final today = DateTime(current.year, current.month, current.day);
  final days = today.difference(startDate).inDays + 1;
  return days < 1 ? 1 : days;
}

String formatDrugChartDate(DateTime? value) {
  if (value == null) return '-';
  final day = value.day.toString().padLeft(2, '0');
  final month = value.month.toString().padLeft(2, '0');
  return '$day/$month';
}
