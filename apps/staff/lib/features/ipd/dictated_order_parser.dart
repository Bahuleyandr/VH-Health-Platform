class DictatedOrderParseResult {
  const DictatedOrderParseResult({
    required this.drugQuery,
    required this.dose,
    required this.route,
    required this.doseTimes,
    required this.foodTiming,
    required this.prn,
    required this.durationDays,
    required this.notes,
  });

  final String drugQuery;
  final String dose;
  final String? route;
  final List<String> doseTimes;
  final String? foodTiming;
  final bool prn;
  final int? durationDays;
  final String notes;

  bool get hasStructuredFields =>
      dose.isNotEmpty ||
      route != null ||
      doseTimes.isNotEmpty ||
      foodTiming != null ||
      prn ||
      durationDays != null;
}

class DictatedCatalogCandidate {
  const DictatedCatalogCandidate({required this.label, required this.row});

  final String label;
  final Map<String, dynamic> row;
}

class DictatedCatalogDecision {
  const DictatedCatalogDecision({
    required this.autoSelected,
    required this.candidates,
  });

  final DictatedCatalogCandidate? autoSelected;
  final List<DictatedCatalogCandidate> candidates;
}

class DictatedOrderParser {
  const DictatedOrderParser();

  static const morning = '08:00';
  static const afternoon = '14:00';
  static const evening = '20:00';
  static const night = '22:00';

  static const _numberWords = <String, int>{
    'one': 1,
    'two': 2,
    'three': 3,
    'four': 4,
    'five': 5,
    'six': 6,
    'seven': 7,
    'ten': 10,
  };

  static const _hiNumberWords = <String, int>{
    'एक': 1,
    'दो': 2,
    'तीन': 3,
    'चार': 4,
    'पांच': 5,
    'पाँच': 5,
    'छह': 6,
    'सात': 7,
    'दस': 10,
  };

  static final _dosePattern = RegExp(
    r'\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|ten)\s*(mg|milligram|milligrams|g|gram|grams|mcg|microgram|micrograms|ml|milliliter|milliliters|iu|unit|units|tablet|tablets|tab|tabs|capsule|capsules|cap|caps|drop|drops)\b',
    caseSensitive: false,
  );

  static final _durationPattern = RegExp(
    r'\b(?:for\s+)?(\d+|one|two|three|four|five|six|seven|ten)\s*(day|days|d|week|weeks)\b',
    caseSensitive: false,
  );

  static final _hiDurationPattern = RegExp(
    r'(एक|दो|तीन|चार|पांच|पाँच|छह|सात|दस|\d+)\s*(दिन|हफ्ते|सप्ताह)',
    caseSensitive: false,
  );

  static const _routes = <_PhraseValue<String>>[
    _PhraseValue('by mouth', 'oral'),
    _PhraseValue('orally', 'oral'),
    _PhraseValue('oral', 'oral'),
    _PhraseValue('po', 'oral'),
    _PhraseValue('मौखिक', 'oral'),
    _PhraseValue('intravenous', 'iv'),
    _PhraseValue('iv', 'iv'),
    _PhraseValue('आई वी', 'iv'),
    _PhraseValue('intramuscular', 'im'),
    _PhraseValue('im', 'im'),
    _PhraseValue('subcutaneous', 'sc'),
    _PhraseValue('sub cut', 'sc'),
    _PhraseValue('sc', 'sc'),
    _PhraseValue('sublingual', 'sublingual'),
    _PhraseValue('under tongue', 'sublingual'),
    _PhraseValue('inhaled', 'inhaled'),
    _PhraseValue('nebulized', 'inhaled'),
    _PhraseValue('nebulised', 'inhaled'),
    _PhraseValue('topical', 'topical'),
    _PhraseValue('local application', 'topical'),
  ];

  static const _frequencies = <_PhraseValue<List<String>>>[
    _PhraseValue('four times a day', [morning, afternoon, evening, night]),
    _PhraseValue('four times daily', [morning, afternoon, evening, night]),
    _PhraseValue('three times a day', [morning, afternoon, evening]),
    _PhraseValue('three times daily', [morning, afternoon, evening]),
    _PhraseValue('two times a day', [morning, evening]),
    _PhraseValue('twice daily', [morning, evening]),
    _PhraseValue('once daily', [morning]),
    _PhraseValue('once a day', [morning]),
    _PhraseValue('daily', [morning]),
    _PhraseValue('qid', [morning, afternoon, evening, night]),
    _PhraseValue('tds', [morning, afternoon, evening]),
    _PhraseValue('tid', [morning, afternoon, evening]),
    _PhraseValue('bd', [morning, evening]),
    _PhraseValue('bid', [morning, evening]),
    _PhraseValue('od', [morning]),
    _PhraseValue('दिन में चार बार', [morning, afternoon, evening, night]),
    _PhraseValue('चार बार', [morning, afternoon, evening, night]),
    _PhraseValue('दिन में तीन बार', [morning, afternoon, evening]),
    _PhraseValue('तीन बार', [morning, afternoon, evening]),
    _PhraseValue('दिन में दो बार', [morning, evening]),
    _PhraseValue('दो बार', [morning, evening]),
    _PhraseValue('सुबह शाम', [morning, evening]),
    _PhraseValue('एक बार', [morning]),
    _PhraseValue('रोज', [morning]),
  ];

  static const _doseSlots = <_PhraseValue<String>>[
    _PhraseValue('morning', morning),
    _PhraseValue('breakfast', morning),
    _PhraseValue('सुबह', morning),
    _PhraseValue('afternoon', afternoon),
    _PhraseValue('दोपहर', afternoon),
    _PhraseValue('evening', evening),
    _PhraseValue('शाम', evening),
    _PhraseValue('bedtime', night),
    _PhraseValue('night', night),
    _PhraseValue('रात', night),
  ];

  static const _food = <_PhraseValue<String>>[
    _PhraseValue('before food', 'before_food'),
    _PhraseValue('before meals', 'before_food'),
    _PhraseValue('after food', 'after_food'),
    _PhraseValue('after meals', 'after_food'),
    _PhraseValue('with food', 'with_food'),
    _PhraseValue('with meals', 'with_food'),
    _PhraseValue('empty stomach', 'empty_stomach'),
    _PhraseValue('bedtime', 'bedtime'),
  ];

  static const _prn = <String>[
    'as needed',
    'when required',
    'if required',
    'prn',
    'sos',
    'ज़रूरत पर',
    'जरूरत पर',
    'आवश्यकता अनुसार',
  ];

  DictatedOrderParseResult parse(String transcript) {
    final source = transcript.trim();
    if (source.isEmpty) {
      return const DictatedOrderParseResult(
        drugQuery: '',
        dose: '',
        route: null,
        doseTimes: [],
        foodTiming: null,
        prn: false,
        durationDays: null,
        notes: '',
      );
    }

    final spans = <_ParsedSpan>[];
    String dose = '';
    for (final match in _dosePattern.allMatches(source)) {
      dose = _normalizeDose(match.group(1)!, match.group(2)!);
      spans.add(_ParsedSpan(match.start, match.end));
      break;
    }

    String? route;
    final routeMatch = _firstPhrase(source, _routes);
    if (routeMatch != null) {
      route = routeMatch.value;
      spans.add(_ParsedSpan(routeMatch.start, routeMatch.end));
    }

    final doseTimes = <String>{};
    final frequencyMatch = _firstPhrase(source, _frequencies);
    if (frequencyMatch != null) {
      doseTimes.addAll(frequencyMatch.value);
      spans.add(_ParsedSpan(frequencyMatch.start, frequencyMatch.end));
    }
    for (final slot in _allPhrases(source, _doseSlots)) {
      doseTimes.add(slot.value);
      spans.add(_ParsedSpan(slot.start, slot.end));
    }

    String? foodTiming;
    final foodMatch = _firstPhrase(source, _food);
    if (foodMatch != null) {
      foodTiming = foodMatch.value;
      spans.add(_ParsedSpan(foodMatch.start, foodMatch.end));
    }

    var prn = false;
    final prnMatch = _firstRawPhrase(source, _prn);
    if (prnMatch != null) {
      prn = true;
      foodTiming = 'prn';
      spans.add(_ParsedSpan(prnMatch.start, prnMatch.end));
    }

    int? durationDays;
    final durationMatch = _durationPattern.firstMatch(source);
    if (durationMatch != null) {
      durationDays = _durationDays(
        durationMatch.group(1)!,
        durationMatch.group(2)!,
      );
      spans.add(_ParsedSpan(durationMatch.start, durationMatch.end));
    } else {
      final hiDurationMatch = _hiDurationPattern.firstMatch(source);
      if (hiDurationMatch != null) {
        durationDays = _durationDays(
          hiDurationMatch.group(1)!,
          hiDurationMatch.group(2)!,
        );
        spans.add(_ParsedSpan(hiDurationMatch.start, hiDurationMatch.end));
      }
    }

    final selectedSpans = _nonOverlapping(spans);
    if (selectedSpans.isEmpty) {
      return DictatedOrderParseResult(
        drugQuery: '',
        dose: '',
        route: null,
        doseTimes: const [],
        foodTiming: null,
        prn: false,
        durationDays: null,
        notes: source,
      );
    }

    final first = selectedSpans.first;
    final drugQuery = first.start > 0
        ? _cleanDrugQuery(source.substring(0, first.start))
        : '';
    final notes = _leftoverNotes(source, selectedSpans);

    return DictatedOrderParseResult(
      drugQuery: drugQuery,
      dose: dose,
      route: route,
      doseTimes: _sortDoseTimes(doseTimes),
      foodTiming: foodTiming,
      prn: prn,
      durationDays: durationDays,
      notes: notes,
    );
  }

  static DictatedCatalogDecision chooseCatalogMatch(
    String query,
    List<DictatedCatalogCandidate> candidates, {
    double threshold = 0.88,
  }) {
    final q = _normalize(query);
    final scored =
        candidates
            .map(
              (candidate) => _ScoredCandidate(candidate, _score(q, candidate)),
            )
            .where((candidate) => candidate.score > 0)
            .toList()
          ..sort((a, b) => b.score.compareTo(a.score));
    final top = scored.take(5).map((s) => s.candidate).toList(growable: false);
    if (scored.isEmpty) {
      return const DictatedCatalogDecision(autoSelected: null, candidates: []);
    }
    final best = scored.first;
    final second = scored.length > 1 ? scored[1].score : 0.0;
    final auto = best.score >= threshold && best.score - second >= 0.08
        ? best.candidate
        : null;
    return DictatedCatalogDecision(autoSelected: auto, candidates: top);
  }

  static double _score(String normalizedQuery, DictatedCatalogCandidate row) {
    if (normalizedQuery.isEmpty) return 0;
    final label = _normalize(row.label);
    if (label == normalizedQuery) return 1;
    final queryTokens = normalizedQuery.split(' ').where((v) => v.isNotEmpty);
    final labelTokens = label.split(' ').where((v) => v.isNotEmpty).toSet();
    if (queryTokens.every(labelTokens.contains)) return 0.92;
    if (label.startsWith(normalizedQuery)) return 0.86;
    return _similarity(normalizedQuery, label);
  }

  static double _similarity(String a, String b) {
    if (a.isEmpty || b.isEmpty) return 0;
    final distance = _levenshtein(a, b);
    final maxLength = a.length > b.length ? a.length : b.length;
    return 1 - (distance / maxLength);
  }

  static int _levenshtein(String a, String b) {
    final previous = List<int>.generate(b.length + 1, (index) => index);
    final current = List<int>.filled(b.length + 1, 0);
    for (var i = 1; i <= a.length; i++) {
      current[0] = i;
      for (var j = 1; j <= b.length; j++) {
        final cost = a.codeUnitAt(i - 1) == b.codeUnitAt(j - 1) ? 0 : 1;
        current[j] = [
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + cost,
        ].reduce((value, element) => value < element ? value : element);
      }
      previous.setAll(0, current);
    }
    return previous[b.length];
  }

  static String _normalizeDose(String amount, String unit) {
    final normalizedAmount = '${_wordNumber(amount) ?? amount}';
    final normalizedUnit = switch (unit.toLowerCase()) {
      'milligram' || 'milligrams' => 'mg',
      'gram' || 'grams' => 'g',
      'microgram' || 'micrograms' => 'mcg',
      'milliliter' || 'milliliters' => 'mL',
      'tablet' || 'tablets' || 'tab' || 'tabs' => 'tablet',
      'capsule' || 'capsules' || 'cap' || 'caps' => 'capsule',
      'drop' || 'drops' => 'drops',
      'unit' || 'units' => 'units',
      _ => unit,
    };
    return '$normalizedAmount $normalizedUnit';
  }

  static int? _durationDays(String amount, String unit) {
    final count = _wordNumber(amount) ?? _hiWordNumber(amount);
    if (count == null) return int.tryParse(amount);
    final lowerUnit = unit.toLowerCase();
    if (lowerUnit == 'week' ||
        lowerUnit == 'weeks' ||
        unit == 'हफ्ते' ||
        unit == 'सप्ताह') {
      return count * 7;
    }
    return count;
  }

  static int? _wordNumber(String value) {
    return _numberWords[value.toLowerCase()] ?? int.tryParse(value);
  }

  static int? _hiWordNumber(String value) {
    return _hiNumberWords[value] ?? int.tryParse(value);
  }

  static _PhraseMatch<T>? _firstPhrase<T>(
    String source,
    List<_PhraseValue<T>> phrases,
  ) {
    final matches = _allPhrases(source, phrases);
    return matches.isEmpty ? null : matches.first;
  }

  static List<_PhraseMatch<T>> _allPhrases<T>(
    String source,
    List<_PhraseValue<T>> phrases,
  ) {
    final lower = source.toLowerCase();
    final matches = <_PhraseMatch<T>>[];
    for (final phrase in phrases) {
      var start = 0;
      final needle = phrase.phrase.toLowerCase();
      while (true) {
        final index = lower.indexOf(needle, start);
        if (index < 0) break;
        final end = index + needle.length;
        if (_isBoundary(source, index - 1) && _isBoundary(source, end)) {
          matches.add(_PhraseMatch(index, end, phrase.value));
        }
        start = index + 1;
      }
    }
    matches.sort((a, b) {
      final byStart = a.start.compareTo(b.start);
      if (byStart != 0) return byStart;
      return (b.end - b.start).compareTo(a.end - a.start);
    });
    return matches;
  }

  static _ParsedSpan? _firstRawPhrase(String source, List<String> phrases) {
    final lower = source.toLowerCase();
    final matches = <_ParsedSpan>[];
    for (final phrase in phrases) {
      final needle = phrase.toLowerCase();
      final index = lower.indexOf(needle);
      if (index < 0) continue;
      final end = index + needle.length;
      if (_isBoundary(source, index - 1) && _isBoundary(source, end)) {
        matches.add(_ParsedSpan(index, end));
      }
    }
    matches.sort((a, b) => a.start.compareTo(b.start));
    return matches.isEmpty ? null : matches.first;
  }

  static List<_ParsedSpan> _nonOverlapping(List<_ParsedSpan> spans) {
    spans.sort((a, b) {
      final byStart = a.start.compareTo(b.start);
      if (byStart != 0) return byStart;
      return (b.end - b.start).compareTo(a.end - a.start);
    });
    final selected = <_ParsedSpan>[];
    for (final span in spans) {
      if (selected.isNotEmpty && span.start < selected.last.end) continue;
      selected.add(span);
    }
    return selected;
  }

  static String _leftoverNotes(String source, List<_ParsedSpan> spans) {
    final parts = <String>[];
    var cursor = 0;
    for (var i = 0; i < spans.length; i++) {
      final span = spans[i];
      if (!(i == 0 && span.start > 0)) {
        parts.add(source.substring(cursor, span.start));
      }
      cursor = span.end;
    }
    parts.add(source.substring(cursor));
    return parts.map(_cleanSegment).where((part) => part.isNotEmpty).join(' ');
  }

  static String _cleanDrugQuery(String value) {
    return _cleanSegment(
      value.replaceFirst(
        RegExp(
          r'^(start|give|order|add|tablet|tab|capsule|cap)\s+',
          caseSensitive: false,
        ),
        '',
      ),
    );
  }

  static String _cleanSegment(String value) {
    return value
        .trim()
        .replaceFirst(
          RegExp(r'^(and|with|for|की|के|का)\s+', caseSensitive: false),
          '',
        )
        .replaceFirst(RegExp(r'[:;\-,.]+$'), '')
        .trim();
  }

  static List<String> _sortDoseTimes(Set<String> times) {
    const order = [morning, afternoon, evening, night];
    return order.where(times.contains).toList(growable: false);
  }

  static bool _isBoundary(String value, int index) {
    if (index < 0 || index >= value.length) return true;
    final codeUnit = value.codeUnitAt(index);
    final isAsciiLetter =
        (codeUnit >= 0x41 && codeUnit <= 0x5A) ||
        (codeUnit >= 0x61 && codeUnit <= 0x7A);
    final isAsciiDigit = codeUnit >= 0x30 && codeUnit <= 0x39;
    final isDevanagari = codeUnit >= 0x0900 && codeUnit <= 0x097F;
    return !(isAsciiLetter || isAsciiDigit || isDevanagari || codeUnit == 0x5F);
  }

  static String _normalize(String value) {
    return value
        .toLowerCase()
        .replaceAll(RegExp(r'[^a-z0-9]+'), ' ')
        .trim()
        .replaceAll(RegExp(r'\s+'), ' ');
  }
}

class _PhraseValue<T> {
  const _PhraseValue(this.phrase, this.value);

  final String phrase;
  final T value;
}

class _PhraseMatch<T> {
  const _PhraseMatch(this.start, this.end, this.value);

  final int start;
  final int end;
  final T value;
}

class _ParsedSpan {
  const _ParsedSpan(this.start, this.end);

  final int start;
  final int end;
}

class _ScoredCandidate {
  const _ScoredCandidate(this.candidate, this.score);

  final DictatedCatalogCandidate candidate;
  final double score;
}
