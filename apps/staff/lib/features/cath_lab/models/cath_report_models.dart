class CathReportSectionDefinition {
  const CathReportSectionDefinition({
    required this.key,
    required this.title,
    required this.order,
    this.required = false,
    this.multiline = true,
  });

  final String key;
  final String title;
  final int order;
  final bool required;
  final bool multiline;

  factory CathReportSectionDefinition.fromJson(Object? value, int index) {
    if (value is String) {
      final key = _slug(value, fallback: 'section_${index + 1}');
      return CathReportSectionDefinition(
        key: key,
        title: value.trim().isEmpty ? _humanize(key) : value.trim(),
        order: index + 1,
      );
    }
    final json = _map(value);
    final key = _text(
      json['key'] ?? json['id'] ?? json['code'] ?? json['name'],
      fallback: 'section_${index + 1}',
    );
    return CathReportSectionDefinition(
      key: key,
      title: _text(
        json['title'] ?? json['label'] ?? json['name'],
        fallback: _humanize(key),
      ),
      order: _asInt(json['order']) ?? index + 1,
      required: json['required'] == true,
      multiline: json['multiline'] != false,
    );
  }
}

class CathReportFieldDefinition {
  const CathReportFieldDefinition({
    required this.key,
    required this.title,
    required this.type,
    required this.order,
    this.required = false,
    this.description = '',
    this.unit = '',
    this.itemType = '',
    this.options = const [],
  });

  final String key;
  final String title;
  final String type;
  final int order;
  final bool required;
  final String description;
  final String unit;
  final String itemType;
  final List<String> options;

  bool get isBoolean => type == 'boolean';
  bool get isNumber => type == 'number' || type == 'integer';
  bool get isInteger => type == 'integer';
  bool get isArray => type == 'array';
  bool get isObject => type == 'object';
  bool get isArrayOfObjects => isArray && itemType == 'object';

  factory CathReportFieldDefinition.fromSchema(
    String key,
    Object? value,
    int index, {
    required Set<String> requiredKeys,
  }) {
    final schema = _map(value);
    final itemSchema = _map(schema['items']);
    final rawOptions = schema['enum'] is List
        ? schema['enum'] as List
        : itemSchema['enum'] is List
        ? itemSchema['enum'] as List
        : const [];
    return CathReportFieldDefinition(
      key: key,
      title: _text(
        schema['title'] ?? schema['label'],
        fallback: _humanize(key),
      ),
      type: _text(schema['type'], fallback: 'string').toLowerCase(),
      order: _asInt(schema['order']) ?? index + 1,
      required: schema['required'] == true || requiredKeys.contains(key),
      description: _text(schema['description']),
      unit: _text(schema['unit']),
      itemType: _text(itemSchema['type']).toLowerCase(),
      options: rawOptions
          .map((option) => _text(option))
          .where((option) => option.isNotEmpty)
          .toList(growable: false),
    );
  }
}

class CathReportTemplate {
  const CathReportTemplate({
    required this.id,
    required this.templateCode,
    required this.name,
    required this.reportType,
    required this.version,
    required this.sections,
    required this.codedFields,
    this.isActive = true,
    this.isStarter = false,
  });

  final int id;
  final String templateCode;
  final String name;
  final String reportType;
  final int version;
  final List<CathReportSectionDefinition> sections;
  final List<CathReportFieldDefinition> codedFields;
  final bool isActive;
  final bool isStarter;

  factory CathReportTemplate.fromJson(Map<String, dynamic> json) {
    final sections =
        (json['sections'] is List ? json['sections'] as List : const []).indexed
            .map(
              (entry) =>
                  CathReportSectionDefinition.fromJson(entry.$2, entry.$1),
            )
            .toList(growable: false)
          ..sort((left, right) => left.order.compareTo(right.order));
    final schema = _map(
      json['coded_fields_schema'] ?? json['codedFieldsSchema'],
    );
    final requiredKeys =
        (schema['required'] is List ? schema['required'] as List : const [])
            .map(_text)
            .where((key) => key.isNotEmpty)
            .toSet();
    final properties = _map(schema['properties']);
    final codedFields =
        properties.entries.indexed
            .map(
              (entry) => CathReportFieldDefinition.fromSchema(
                entry.$2.key,
                entry.$2.value,
                entry.$1,
                requiredKeys: requiredKeys,
              ),
            )
            .toList(growable: false)
          ..sort((left, right) => left.order.compareTo(right.order));
    final metadata = _map(json['metadata']);
    return CathReportTemplate(
      id: _asInt(json['id']) ?? 0,
      templateCode: _text(json['template_code'] ?? json['templateCode']),
      name: _text(json['name'], fallback: _text(json['template_code'])),
      reportType: _text(
        json['report_type'] ?? json['reportType'],
        fallback: 'other',
      ),
      version: _asInt(json['version']) ?? 1,
      sections: sections,
      codedFields: codedFields,
      isActive: json['is_active'] != false && json['isActive'] != false,
      isStarter: metadata['starter'] == true || json['starter'] == true,
    );
  }

  factory CathReportTemplate.forReport(CathProcedureReport report) {
    final sections = report.narrativeSections.keys.indexed
        .map(
          (entry) => CathReportSectionDefinition(
            key: entry.$2,
            title: _humanize(entry.$2),
            order: entry.$1 + 1,
          ),
        )
        .toList(growable: false);
    final fields = report.codedFields.entries.indexed
        .map(
          (entry) => CathReportFieldDefinition(
            key: entry.$2.key,
            title: _humanize(entry.$2.key),
            type: switch (entry.$2.value) {
              bool _ => 'boolean',
              int _ => 'integer',
              num _ => 'number',
              List _ => 'array',
              Map _ => 'object',
              _ => 'string',
            },
            order: entry.$1 + 1,
            itemType:
                entry.$2.value is List &&
                    (entry.$2.value as List).any((item) => item is Map)
                ? 'object'
                : '',
          ),
        )
        .toList(growable: false);
    return CathReportTemplate(
      id: report.templateId ?? 0,
      templateCode: '',
      name: _humanize(report.reportType),
      reportType: report.reportType,
      version: report.templateVersion ?? 1,
      sections: sections,
      codedFields: fields,
    );
  }
}

class CathReportAddendum {
  const CathReportAddendum({
    required this.id,
    required this.reason,
    required this.narrative,
    this.authorName = '',
    this.authorRole = '',
    this.createdAt,
  });

  final int id;
  final String reason;
  final String narrative;
  final String authorName;
  final String authorRole;
  final DateTime? createdAt;

  factory CathReportAddendum.fromJson(Map<String, dynamic> json) {
    return CathReportAddendum(
      id: _asInt(json['id']) ?? 0,
      reason: _text(json['reason']),
      narrative: _text(json['narrative'] ?? json['content']),
      authorName: _text(
        json['author_name'] ?? json['created_by_name'] ?? json['authorName'],
      ),
      authorRole: _text(json['author_role'] ?? json['authorRole']),
      createdAt: _date(json['created_at'] ?? json['createdAt']),
    );
  }
}

class CathProcedureReport {
  const CathProcedureReport({
    required this.id,
    required this.caseId,
    required this.patientUid,
    required this.reportType,
    required this.status,
    required this.narrativeSections,
    required this.codedFields,
    this.procedureLogId,
    this.templateId,
    this.templateVersion,
    this.signedByName = '',
    this.signedByRole = '',
    this.signedAt,
    this.createdAt,
    this.updatedAt,
    this.reportTatMinutes,
    this.templateName = '',
    this.findingsSummary = '',
    this.addenda = const [],
  });

  final int id;
  final int caseId;
  final int? procedureLogId;
  final String patientUid;
  final String reportType;
  final String status;
  final int? templateId;
  final int? templateVersion;
  final Map<String, String> narrativeSections;
  final Map<String, dynamic> codedFields;
  final String signedByName;
  final String signedByRole;
  final DateTime? signedAt;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final int? reportTatMinutes;
  final String templateName;
  final String findingsSummary;
  final List<CathReportAddendum> addenda;

  bool get isDraft => status.toLowerCase() == 'draft';
  bool get isPreliminary => status.toLowerCase() == 'preliminary';
  bool get isSigned => status.toLowerCase() == 'signed';

  factory CathProcedureReport.fromJson(Map<String, dynamic> json) {
    final narrative = _narrativeMap(
      json['narrative_sections'] ?? json['narrativeSections'],
    );
    final rawAddenda = json['addenda'] is List
        ? json['addenda'] as List
        : const [];
    return CathProcedureReport(
      id: _asInt(json['id']) ?? 0,
      caseId: _asInt(json['case_id'] ?? json['caseId']) ?? 0,
      procedureLogId: _asInt(
        json['procedure_log_id'] ?? json['procedureLogId'],
      ),
      patientUid: _text(json['patient_uid'] ?? json['patientUid']),
      reportType: _text(
        json['report_type'] ?? json['reportType'],
        fallback: 'other',
      ),
      status: _text(json['status'], fallback: 'draft').toLowerCase(),
      templateId: _asInt(json['template_id'] ?? json['templateId']),
      templateVersion: _asInt(
        json['template_version'] ?? json['templateVersion'],
      ),
      narrativeSections: narrative,
      codedFields: _map(json['coded_fields'] ?? json['codedFields']),
      signedByName: _text(json['signed_by_name'] ?? json['signedByName']),
      signedByRole: _text(json['signed_by_role'] ?? json['signedByRole']),
      signedAt: _date(json['signed_at'] ?? json['signedAt']),
      createdAt: _date(json['created_at'] ?? json['createdAt']),
      updatedAt: _date(json['updated_at'] ?? json['updatedAt']),
      reportTatMinutes: _asInt(
        json['report_tat_minutes'] ??
            json['reportTatMinutes'] ??
            json['current_elapsed_minutes'],
      ),
      templateName: _text(json['template_name'] ?? json['templateName']),
      findingsSummary: _text(
        json['findings_summary'] ?? json['findingsSummary'],
      ),
      addenda: rawAddenda
          .whereType<Map>()
          .map(
            (addendum) => CathReportAddendum.fromJson(
              Map<String, dynamic>.from(addendum),
            ),
          )
          .toList(growable: false),
    );
  }
}

class CathReportDraft {
  const CathReportDraft({
    required this.templateId,
    required this.reportType,
    required this.narrativeSections,
    required this.codedFields,
    this.narrativeSectionTitles = const {},
    this.procedureLogId,
    this.viewerStudyAccession,
  });

  final int templateId;
  final int? procedureLogId;
  final String reportType;
  final Map<String, String> narrativeSections;
  final Map<String, String> narrativeSectionTitles;
  final Map<String, dynamic> codedFields;
  final String? viewerStudyAccession;

  Map<String, dynamic> toJson() {
    return {
      'template_id': templateId,
      'report_type': reportType,
      'narrative_sections': [
        for (final section in narrativeSections.entries)
          {
            'key': section.key,
            'title':
                narrativeSectionTitles[section.key] ?? _humanize(section.key),
            'text': section.value,
          },
      ],
      'coded_fields': codedFields,
      if (procedureLogId != null) 'procedure_log_id': procedureLogId,
      if (viewerStudyAccession != null && viewerStudyAccession!.isNotEmpty)
        'viewer_study_accession': viewerStudyAccession,
    };
  }
}

class CathReportAddendumDraft {
  const CathReportAddendumDraft({
    required this.reason,
    required this.narrative,
  });

  final String reason;
  final String narrative;

  Map<String, dynamic> toJson() => {'reason': reason, 'narrative': narrative};
}

class CathViewerLink {
  const CathViewerLink({required this.status, this.url});

  final String status;
  final Uri? url;

  bool get isPacsConfigured => status != 'pacs_not_configured';
  bool get canOpen => isPacsConfigured && url != null;

  factory CathViewerLink.fromJson(Map<String, dynamic> json) {
    final rawUrl = _text(json['viewer_url'] ?? json['viewerUrl']);
    return CathViewerLink(
      status: _text(
        json['viewer_status'] ?? json['viewerStatus'],
        fallback: rawUrl.isEmpty ? 'unavailable' : 'available',
      ).toLowerCase(),
      url: rawUrl.isEmpty ? null : Uri.tryParse(rawUrl),
    );
  }
}

Map<String, dynamic> _map(Object? value) {
  if (value is Map<String, dynamic>) return Map<String, dynamic>.from(value);
  if (value is Map) return Map<String, dynamic>.from(value);
  return <String, dynamic>{};
}

Map<String, String> _narrativeMap(Object? value) {
  if (value is Map) {
    return Map<String, dynamic>.from(value)
        .map((key, sectionValue) => MapEntry(key, _text(sectionValue)));
  }
  if (value is! List) return <String, String>{};
  final sections = <String, String>{};
  for (var index = 0; index < value.length; index += 1) {
    final section = _map(value[index]);
    final key = _text(
      section['key'] ?? section['section_key'] ?? section['title'],
      fallback: 'section_${index + 1}',
    );
    sections[key] = _text(
      section['text'] ??
          section['value'] ??
          section['content'] ??
          section['narrative'],
    );
  }
  return sections;
}

String _text(Object? value, {String fallback = ''}) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty || text.toLowerCase() == 'null' ? fallback : text;
}

int? _asInt(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(_text(value));
}

DateTime? _date(Object? value) {
  final text = _text(value);
  return text.isEmpty ? null : DateTime.tryParse(text)?.toLocal();
}

String _slug(String value, {required String fallback}) {
  final slug = value
      .trim()
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9]+'), '_')
      .replaceAll(RegExp(r'^_+|_+$'), '');
  return slug.isEmpty ? fallback : slug;
}

String _humanize(String value) {
  final words = value
      .replaceAll(RegExp(r'[_-]+'), ' ')
      .trim()
      .split(RegExp(r'\s+'))
      .where((word) => word.isNotEmpty)
      .map((word) => '${word[0].toUpperCase()}${word.substring(1)}')
      .join(' ');
  return words.isEmpty ? value : words;
}
