/// Presentation helpers shared by the consumables capture sheet and the case
/// consumables panel.
///
/// Both surfaces render the same backend vocabulary — snake_case status and
/// reason codes, NUMERIC quantities, `Exception:`-prefixed failures — so the
/// formatting lives here rather than being copied into each file, where the
/// two copies could quietly drift into rendering the same row differently.
library;

/// A backend enum (`sent_for_reprocessing`, `max_cycles_reached`) rendered as
/// a human-readable phrase. Returns `-` for an empty code so a missing value
/// never collapses a joined line into a stray separator.
String cathHumanize(String value) {
  final text = value.replaceAll('_', ' ').trim();
  if (text.isEmpty) return '-';
  return text
      .split(' ')
      .map(
        (part) => part.isEmpty
            ? part
            : '${part[0].toUpperCase()}${part.substring(1)}',
      )
      .join(' ');
}

/// A NUMERIC quantity without trailing zeroes: `2` rather than `2.00`, `1.5`
/// rather than `1.50`.
String cathFormatQuantity(double value) {
  return value == value.roundToDouble()
      ? value.toInt().toString()
      : value
            .toStringAsFixed(2)
            .replaceFirst(RegExp(r'0+$'), '')
            .replaceFirst(RegExp(r'\.$'), '');
}

/// Trimmed text, or null when the field was left empty — the shape the draft
/// JSON wants, since an empty string and an absent key mean different things
/// to the backend validators.
String? cathNullableText(String value) {
  final text = value.trim();
  return text.isEmpty ? null : text;
}

/// The message inside a thrown [Exception] without Dart's `Exception: ` echo,
/// which is noise in a snackbar or an inline error line.
String cathCleanError(Object error) {
  return error.toString().replaceFirst(RegExp(r'^Exception:\s*'), '');
}
