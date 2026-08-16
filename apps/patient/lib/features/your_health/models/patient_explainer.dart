class PatientExplainer {
  const PatientExplainer({
    required this.reviewId,
    required this.generationId,
    required this.moduleKey,
    required this.moduleName,
    required this.publishedAt,
    required this.draft,
    required this.sourceCitations,
    required this.modelTier,
  });

  factory PatientExplainer.fromJson(Map<String, dynamic> json) {
    final draft = _asStringKeyMap(json['draft']);
    return PatientExplainer(
      reviewId: _asInt(json['review_id'] ?? json['id']),
      generationId: _asInt(json['generation_id']),
      moduleKey: json['module_key']?.toString() ?? '',
      moduleName: json['module_name']?.toString() ?? '',
      publishedAt: _asDate(json['published_at']),
      draft: PatientExplainerDraft.fromJson(draft),
      sourceCitations: _asStringList(json['source_citations']),
      modelTier: json['model_tier']?.toString(),
    );
  }

  final int reviewId;
  final int generationId;
  final String moduleKey;
  final String moduleName;
  final DateTime? publishedAt;
  final PatientExplainerDraft draft;
  final List<String> sourceCitations;
  final String? modelTier;
}

class PatientExplainerDraft {
  const PatientExplainerDraft({
    required this.explanationSummary,
    required this.keyPoints,
    required this.nextSteps,
    required this.whenToSeekHelp,
    required this.safetyFlags,
  });

  factory PatientExplainerDraft.fromJson(Map<String, dynamic> json) {
    return PatientExplainerDraft(
      explanationSummary: (json['explanation_summary'] ?? json['summary'] ?? '')
          .toString()
          .trim(),
      keyPoints: _asStringList(json['key_points']),
      nextSteps: _asStringList(json['next_steps']),
      whenToSeekHelp: _asStringList(json['when_to_seek_help']),
      safetyFlags: _asList(json['safety_flags'] ?? json['safetyFlags'])
          .map(PatientExplainerSafetyFlag.fromValue)
          .where((flag) => flag.message.isNotEmpty || flag.code.isNotEmpty)
          .toList(),
    );
  }

  final String explanationSummary;
  final List<String> keyPoints;
  final List<String> nextSteps;
  final List<String> whenToSeekHelp;
  final List<PatientExplainerSafetyFlag> safetyFlags;
}

class PatientExplainerSafetyFlag {
  const PatientExplainerSafetyFlag({
    required this.severity,
    required this.code,
    required this.message,
  });

  factory PatientExplainerSafetyFlag.fromValue(dynamic value) {
    final map = _asStringKeyMap(value);
    if (map.isEmpty) {
      final text = value?.toString().trim() ?? '';
      return PatientExplainerSafetyFlag(severity: '', code: '', message: text);
    }

    return PatientExplainerSafetyFlag(
      severity: (map['severity'] ?? map['level'] ?? '').toString().trim(),
      code: (map['code'] ?? map['type'] ?? '').toString().trim(),
      message: (map['message'] ?? map['text'] ?? map['description'] ?? '')
          .toString()
          .trim(),
    );
  }

  final String severity;
  final String code;
  final String message;
}

int _asInt(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

DateTime? _asDate(dynamic value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString())?.toLocal();
}

List<dynamic> _asList(dynamic value) {
  if (value is List) return value;
  if (value == null) return const [];
  return [value];
}

List<String> _asStringList(dynamic value) {
  return _asList(value)
      .map(_stringFromListValue)
      .where((value) => value.isNotEmpty)
      .toList();
}

String _stringFromListValue(dynamic value) {
  if (value == null) return '';
  final map = _asStringKeyMap(value);
  if (map.isNotEmpty) {
    return (map['text'] ??
            map['message'] ??
            map['label'] ??
            map['title'] ??
            map['description'] ??
            '')
        .toString()
        .trim();
  }
  return value.toString().trim();
}

Map<String, dynamic> _asStringKeyMap(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return value.cast<String, dynamic>();
  return const {};
}
