enum DictationSection {
  chiefComplaint,
  history,
  examination,
  diagnosis,
  plan,
  advice,
}

class DictationSectionRoute {
  const DictationSectionRoute(this.sections);

  final Map<DictationSection, String> sections;
}

class DictationSectionRouter {
  const DictationSectionRouter();

  static const List<_SectionKeyword> _keywords = [
    _SectionKeyword(DictationSection.chiefComplaint, 'chief complaints'),
    _SectionKeyword(DictationSection.chiefComplaint, 'chief complaint'),
    _SectionKeyword(DictationSection.chiefComplaint, 'complaints'),
    _SectionKeyword(DictationSection.chiefComplaint, 'complaint'),
    _SectionKeyword(DictationSection.chiefComplaint, 'मुख्य शिकायत'),
    _SectionKeyword(DictationSection.chiefComplaint, 'मुख्य समस्या'),
    _SectionKeyword(DictationSection.chiefComplaint, 'शिकायत'),
    _SectionKeyword(DictationSection.history, 'history of present illness'),
    _SectionKeyword(DictationSection.history, 'past history'),
    _SectionKeyword(DictationSection.history, 'history'),
    _SectionKeyword(DictationSection.history, 'hpi'),
    _SectionKeyword(DictationSection.history, 'बीमारी का इतिहास'),
    _SectionKeyword(DictationSection.history, 'रोग इतिहास'),
    _SectionKeyword(DictationSection.history, 'इतिहास'),
    _SectionKeyword(DictationSection.examination, 'clinical examination'),
    _SectionKeyword(DictationSection.examination, 'on examination'),
    _SectionKeyword(DictationSection.examination, 'examination'),
    _SectionKeyword(DictationSection.examination, 'exam'),
    _SectionKeyword(DictationSection.examination, 'o/e'),
    _SectionKeyword(DictationSection.examination, 'परीक्षण'),
    _SectionKeyword(DictationSection.examination, 'मुआयना'),
    _SectionKeyword(DictationSection.examination, 'जांच'),
    _SectionKeyword(DictationSection.diagnosis, 'differential diagnosis'),
    _SectionKeyword(DictationSection.diagnosis, 'working diagnosis'),
    _SectionKeyword(DictationSection.diagnosis, 'diagnosis'),
    _SectionKeyword(DictationSection.diagnosis, 'assessment'),
    _SectionKeyword(DictationSection.diagnosis, 'dx'),
    _SectionKeyword(DictationSection.diagnosis, 'डायग्नोसिस'),
    _SectionKeyword(DictationSection.diagnosis, 'निदान'),
    _SectionKeyword(DictationSection.plan, 'treatment plan'),
    _SectionKeyword(DictationSection.plan, 'management plan'),
    _SectionKeyword(DictationSection.plan, 'plan'),
    _SectionKeyword(DictationSection.plan, 'rx'),
    _SectionKeyword(DictationSection.plan, 'उपचार योजना'),
    _SectionKeyword(DictationSection.plan, 'योजना'),
    _SectionKeyword(DictationSection.plan, 'प्लान'),
    _SectionKeyword(DictationSection.advice, 'follow up advice'),
    _SectionKeyword(DictationSection.advice, 'advice'),
    _SectionKeyword(DictationSection.advice, 'advise'),
    _SectionKeyword(DictationSection.advice, 'instructions'),
    _SectionKeyword(DictationSection.advice, 'follow up'),
    _SectionKeyword(DictationSection.advice, 'सलाह'),
    _SectionKeyword(DictationSection.advice, 'निर्देश'),
    _SectionKeyword(DictationSection.advice, 'फॉलो अप'),
  ];

  DictationSectionRoute route(
    String transcript, {
    required DictationSection fallbackSection,
  }) {
    final source = transcript.trim();
    if (source.isEmpty) {
      return const DictationSectionRoute(<DictationSection, String>{});
    }

    final matches = _findMatches(source);
    if (matches.isEmpty) {
      return DictationSectionRoute({fallbackSection: source});
    }

    final routed = <DictationSection, String>{};
    var current = fallbackSection;
    var cursor = 0;
    for (final match in matches) {
      _append(routed, current, source.substring(cursor, match.start));
      current = match.section;
      cursor = match.end;
    }
    _append(routed, current, source.substring(cursor));
    return DictationSectionRoute(Map.unmodifiable(routed));
  }

  static List<_SectionMatch> _findMatches(String source) {
    final normalized = source.toLowerCase();
    final candidates = <_SectionMatch>[];
    for (final keyword in _keywords) {
      final phrase = keyword.phrase.toLowerCase();
      var start = 0;
      while (true) {
        final index = normalized.indexOf(phrase, start);
        if (index < 0) break;
        final end = index + phrase.length;
        if (_isBoundary(source, index - 1) && _isBoundary(source, end)) {
          candidates.add(_SectionMatch(keyword.section, index, end));
        }
        start = index + 1;
      }
    }
    candidates.sort((a, b) {
      final byStart = a.start.compareTo(b.start);
      if (byStart != 0) return byStart;
      return b.length.compareTo(a.length);
    });

    final selected = <_SectionMatch>[];
    for (final candidate in candidates) {
      if (selected.isNotEmpty && candidate.start < selected.last.end) {
        continue;
      }
      selected.add(candidate);
    }
    return selected;
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

  static void _append(
    Map<DictationSection, String> routed,
    DictationSection section,
    String rawSegment,
  ) {
    final segment = _cleanSegment(rawSegment);
    if (segment.isEmpty) return;
    final previous = routed[section];
    routed[section] = previous == null ? segment : '$previous\n$segment';
  }

  static String _cleanSegment(String value) {
    return value
        .trim()
        .replaceFirst(RegExp(r'^[:;\-,.]+'), '')
        .replaceFirst(RegExp(r'[:;\-,.]+$'), '')
        .trim();
  }
}

class _SectionKeyword {
  const _SectionKeyword(this.section, this.phrase);

  final DictationSection section;
  final String phrase;
}

class _SectionMatch {
  const _SectionMatch(this.section, this.start, this.end);

  final DictationSection section;
  final int start;
  final int end;

  int get length => end - start;
}
