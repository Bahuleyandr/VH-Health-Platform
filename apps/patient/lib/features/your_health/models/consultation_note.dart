class ConsultationNote {
  const ConsultationNote({
    required this.id,
    required this.noteType,
    required this.title,
    required this.authorRole,
    required this.content,
    this.signedAt,
    this.createdAt,
    this.updatedAt,
  });

  factory ConsultationNote.fromJson(Map<String, dynamic> json) {
    final rawContent = json['content'];
    final content = rawContent is Map
        ? Map<String, dynamic>.from(rawContent)
        : <String, dynamic>{};

    return ConsultationNote(
      id: _asInt(json['id']),
      noteType: json['note_type']?.toString() ?? '',
      title: json['title']?.toString().trim() ?? '',
      authorRole: json['author_role']?.toString().trim() ?? '',
      content: content,
      signedAt: _parseDate(json['signed_at']),
      createdAt: _parseDate(json['created_at']),
      updatedAt: _parseDate(json['updated_at']),
    );
  }

  final int id;
  final String noteType;
  final String title;
  final String authorRole;
  final Map<String, dynamic> content;
  final DateTime? signedAt;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  DateTime? get displayDate => signedAt ?? createdAt ?? updatedAt;
}

int _asInt(dynamic value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

DateTime? _parseDate(dynamic value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString())?.toLocal();
}
