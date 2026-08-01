class RecordAccessGrantsPage {
  const RecordAccessGrantsPage({
    required this.grantedByMe,
    required this.heldByMe,
    this.staleLabel,
    this.cachedAt,
    this.onFresh,
  });

  final List<RecordAccessGrant> grantedByMe;
  final List<HeldRecordAccessGrant> heldByMe;
  final String? staleLabel;
  final DateTime? cachedAt;
  final Future<RecordAccessGrantsSnapshot>? onFresh;

  bool get isEmpty => grantedByMe.isEmpty && heldByMe.isEmpty;
}

class RecordAccessGrantsSnapshot {
  const RecordAccessGrantsSnapshot({
    required this.grantedByMe,
    required this.heldByMe,
  });

  final List<RecordAccessGrant> grantedByMe;
  final List<HeldRecordAccessGrant> heldByMe;
}

class RecordAccessGrant {
  const RecordAccessGrant({
    required this.id,
    required this.proxyUid,
    required this.scope,
    required this.status,
    required this.grantedAt,
    this.relationship,
    this.consentMethod,
    this.expiresAt,
    this.revokedAt,
  });

  factory RecordAccessGrant.fromJson(Map<String, dynamic> json) {
    return RecordAccessGrant(
      id: (json['id'] as num?)?.toInt() ?? 0,
      proxyUid: json['proxy_uid']?.toString() ?? '',
      relationship: _clean(json['relationship']),
      scope: _parseScope(json['scope']),
      status: json['status']?.toString() ?? 'unknown',
      consentMethod: _clean(json['consent_method']),
      grantedAt: _parseDate(json['granted_at']),
      expiresAt: _parseDate(json['expires_at']),
      revokedAt: _parseDate(json['revoked_at']),
    );
  }

  final int id;
  final String proxyUid;
  final String? relationship;
  final List<String> scope;
  final String status;
  final String? consentMethod;
  final DateTime? grantedAt;
  final DateTime? expiresAt;
  final DateTime? revokedAt;

  bool get isActive => status.toLowerCase() == 'active';
}

class HeldRecordAccessGrant {
  const HeldRecordAccessGrant({
    required this.id,
    required this.patientUid,
    required this.scope,
    required this.status,
    required this.grantedAt,
    this.relationship,
    this.expiresAt,
  });

  factory HeldRecordAccessGrant.fromJson(Map<String, dynamic> json) {
    return HeldRecordAccessGrant(
      id: (json['id'] as num?)?.toInt() ?? 0,
      patientUid: json['patient_uid']?.toString() ?? '',
      relationship: _clean(json['relationship']),
      scope: _parseScope(json['scope']),
      status: json['status']?.toString() ?? 'unknown',
      grantedAt: _parseDate(json['granted_at']),
      expiresAt: _parseDate(json['expires_at']),
    );
  }

  final int id;
  final String patientUid;
  final String? relationship;
  final List<String> scope;
  final String status;
  final DateTime? grantedAt;
  final DateTime? expiresAt;
}

String? _clean(Object? value) {
  final text = value?.toString().trim();
  return text == null || text.isEmpty ? null : text;
}

DateTime? _parseDate(Object? value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString());
}

List<String> _parseScope(Object? raw) {
  if (raw is List) {
    return raw
        .map((item) => item.toString())
        .where((item) {
          return item.trim().isNotEmpty;
        })
        .toList(growable: false);
  }
  final value = raw?.toString().trim();
  if (value == null || value.isEmpty) return const [];
  return value
      .replaceAll('{', '')
      .replaceAll('}', '')
      .split(',')
      .map((item) => item.trim())
      .where((item) => item.isNotEmpty)
      .toList(growable: false);
}
