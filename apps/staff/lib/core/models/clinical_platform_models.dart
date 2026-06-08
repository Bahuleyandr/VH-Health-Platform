class ClinicalEncounter {
  const ClinicalEncounter({
    required this.id,
    required this.patientUid,
    required this.status,
    required this.encounterType,
    this.appointmentId,
    this.admissionId,
    this.primaryDoctorUid,
    this.openedAt,
    this.signedAt,
    this.lockedAt,
    this.metadata = const {},
  });

  final String id;
  final String patientUid;
  final String status;
  final String encounterType;
  final int? appointmentId;
  final int? admissionId;
  final String? primaryDoctorUid;
  final DateTime? openedAt;
  final DateTime? signedAt;
  final DateTime? lockedAt;
  final Map<String, dynamic> metadata;

  factory ClinicalEncounter.fromJson(Map<String, dynamic> json) {
    return ClinicalEncounter(
      id: _string(json['id']),
      patientUid: _string(json['patient_uid'] ?? json['patientUid']),
      status: _string(json['status'], fallback: 'open'),
      encounterType: _string(
        json['encounter_type'] ?? json['encounterType'],
        fallback: 'op',
      ),
      appointmentId: _int(json['appointment_id'] ?? json['appointmentId']),
      admissionId: _int(json['admission_id'] ?? json['admissionId']),
      primaryDoctorUid: _nullableString(
        json['primary_doctor_uid'] ?? json['primaryDoctorUid'],
      ),
      openedAt: _date(json['opened_at'] ?? json['openedAt']),
      signedAt: _date(json['signed_at'] ?? json['signedAt']),
      lockedAt: _date(json['locked_at'] ?? json['lockedAt']),
      metadata: _map(json['metadata']),
    );
  }
}

class ClinicalTimelineEvent {
  const ClinicalTimelineEvent({
    required this.id,
    required this.eventType,
    required this.timestamp,
    this.canonical = false,
    this.eventSubtype,
    this.eventStatus,
    this.sourceTable,
    this.sourceId,
    this.resourceType,
    this.resourceId,
    this.encounterId,
    this.title,
    this.summary,
    this.actorUid,
    this.actorRole,
    this.payload = const {},
    this.tags = const [],
  });

  final String id;
  final bool canonical;
  final String eventType;
  final String? eventSubtype;
  final String? eventStatus;
  final String? sourceTable;
  final String? sourceId;
  final String? resourceType;
  final String? resourceId;
  final String? encounterId;
  final DateTime timestamp;
  final String? title;
  final String? summary;
  final String? actorUid;
  final String? actorRole;
  final Map<String, dynamic> payload;
  final List<String> tags;

  factory ClinicalTimelineEvent.fromJson(Map<String, dynamic> json) {
    final occurredAt =
        json['occurred_at'] ?? json['timestamp'] ?? json['created_at'];
    return ClinicalTimelineEvent(
      id: _string(json['id']),
      canonical: json['canonical'] == true,
      eventType: _string(
        json['event_type'] ?? json['type'],
        fallback: 'clinical.event',
      ),
      eventSubtype: _nullableString(json['event_subtype']),
      eventStatus: _nullableString(json['event_status'] ?? json['status']),
      sourceTable: _nullableString(json['source_table']),
      sourceId: _nullableString(json['source_id']),
      resourceType: _nullableString(json['resource_type']),
      resourceId: _nullableString(json['resource_id']),
      encounterId: _nullableString(json['encounter_id']),
      timestamp: _date(occurredAt) ?? DateTime.fromMillisecondsSinceEpoch(0),
      title: _nullableString(json['title']),
      summary: _nullableString(json['clinical_summary'] ?? json['summary']),
      actorUid: _nullableString(json['actor_uid']),
      actorRole: _nullableString(json['actor_role']),
      payload: _map(json['payload']),
      tags: _stringList(json['tags']),
    );
  }

  Map<String, dynamic> toLegacyMap() {
    final legacy = <String, dynamic>{
      'id': resourceId ?? sourceId ?? id,
      'canonical_id': id,
      'canonical': canonical,
      'type': eventSubtype ?? resourceType ?? eventType,
      'event_type': eventType,
      'status': eventStatus,
      'title': title ?? payload['title'] ?? eventType,
      'summary': summary,
      'timestamp': timestamp.toIso8601String(),
      'occurred_at': timestamp.toIso8601String(),
      'encounter_id': encounterId,
      'actor_uid': actorUid,
      'actor_role': actorRole,
      'tags': tags,
      ...payload,
    };
    legacy.removeWhere((_, value) => value == null);
    return legacy;
  }
}

class CanonicalPatientTimeline {
  const CanonicalPatientTimeline({
    required this.patientUid,
    required this.events,
    this.counts = const {},
    this.generatedAt,
  });

  final String patientUid;
  final List<ClinicalTimelineEvent> events;
  final Map<String, dynamic> counts;
  final DateTime? generatedAt;

  factory CanonicalPatientTimeline.fromJson(Map<String, dynamic> json) {
    final rawEvents = json['events'];
    final events = rawEvents is List
        ? rawEvents
              .whereType<Map>()
              .map(
                (event) => ClinicalTimelineEvent.fromJson(
                  Map<String, dynamic>.from(event),
                ),
              )
              .toList()
        : const <ClinicalTimelineEvent>[];
    return CanonicalPatientTimeline(
      patientUid: _string(json['patient_uid'] ?? json['patientUid']),
      events: events,
      counts: _map(json['counts']),
      generatedAt: _date(json['generated_at'] ?? json['generatedAt']),
    );
  }
}

class ClinicalAuditEvent {
  const ClinicalAuditEvent({
    required this.id,
    required this.action,
    required this.occurredAt,
    this.actionStatus,
    this.patientUid,
    this.actorUid,
    this.actorRole,
    this.resourceType,
    this.resourceId,
    this.metadata = const {},
  });

  final String id;
  final String action;
  final String? actionStatus;
  final DateTime occurredAt;
  final String? patientUid;
  final String? actorUid;
  final String? actorRole;
  final String? resourceType;
  final String? resourceId;
  final Map<String, dynamic> metadata;

  factory ClinicalAuditEvent.fromJson(Map<String, dynamic> json) {
    return ClinicalAuditEvent(
      id: _string(json['id']),
      action: _string(json['action']),
      actionStatus: _nullableString(json['action_status']),
      occurredAt:
          _date(json['occurred_at']) ?? DateTime.fromMillisecondsSinceEpoch(0),
      patientUid: _nullableString(json['patient_uid']),
      actorUid: _nullableString(json['actor_uid']),
      actorRole: _nullableString(json['actor_role']),
      resourceType: _nullableString(json['resource_type']),
      resourceId: _nullableString(json['resource_id']),
      metadata: _map(json['metadata']),
    );
  }
}

class MedicationSafetyReview {
  const MedicationSafetyReview({
    required this.id,
    required this.reviewType,
    required this.severity,
    required this.status,
    required this.message,
    this.medicationName,
    this.overrideRequired = false,
  });

  final String id;
  final String reviewType;
  final String severity;
  final String status;
  final String message;
  final String? medicationName;
  final bool overrideRequired;

  factory MedicationSafetyReview.fromJson(Map<String, dynamic> json) {
    return MedicationSafetyReview(
      id: _string(json['id']),
      reviewType: _string(json['review_type'], fallback: 'overall'),
      severity: _string(json['severity'], fallback: 'info'),
      status: _string(json['status'], fallback: 'warning'),
      message: _string(json['message']),
      medicationName: _nullableString(json['medication_name']),
      overrideRequired: json['override_required'] == true,
    );
  }
}

class MedicationSafetyIssue {
  const MedicationSafetyIssue({
    required this.type,
    required this.message,
    this.severity,
    this.medication,
    this.payload = const {},
  });

  final String type;
  final String message;
  final String? severity;
  final String? medication;
  final Map<String, dynamic> payload;

  factory MedicationSafetyIssue.fromJson(Map<String, dynamic> json) {
    return MedicationSafetyIssue(
      type: _string(json['type'] ?? json['code'], fallback: 'safety'),
      message: _string(json['message'] ?? json['summary']),
      severity: _nullableString(json['severity']),
      medication: _nullableString(
        json['medication'] ?? json['medication_name'] ?? json['drug_name'],
      ),
      payload: json,
    );
  }
}

class MedicationSafetyEvaluation {
  const MedicationSafetyEvaluation({
    required this.safe,
    required this.warnings,
    required this.blockers,
    required this.reviews,
  });

  final bool safe;
  final List<MedicationSafetyIssue> warnings;
  final List<MedicationSafetyIssue> blockers;
  final List<MedicationSafetyReview> reviews;

  factory MedicationSafetyEvaluation.fromJson(Map<String, dynamic> json) {
    return MedicationSafetyEvaluation(
      safe: _bool(json['safe'], fallback: false),
      warnings: _issueList(json['warnings']),
      blockers: _issueList(json['blockers']),
      reviews: _reviewList(json['reviews']),
    );
  }
}

class WorkflowSlaInstance {
  const WorkflowSlaInstance({
    required this.id,
    required this.ruleCode,
    required this.status,
    required this.dueAt,
    this.patientUid,
    this.sourceTable,
    this.sourceId,
    this.priority,
  });

  final String id;
  final String ruleCode;
  final String status;
  final DateTime dueAt;
  final String? patientUid;
  final String? sourceTable;
  final String? sourceId;
  final String? priority;

  factory WorkflowSlaInstance.fromJson(Map<String, dynamic> json) {
    return WorkflowSlaInstance(
      id: _string(json['id']),
      ruleCode: _string(json['rule_code'] ?? json['ruleCode']),
      status: _string(json['status'], fallback: 'active'),
      dueAt:
          _date(json['due_at'] ?? json['dueAt']) ??
          DateTime.fromMillisecondsSinceEpoch(0),
      patientUid: _nullableString(json['patient_uid']),
      sourceTable: _nullableString(json['source_table']),
      sourceId: _nullableString(json['source_id']),
      priority: _nullableString(json['priority']),
    );
  }
}

class ClinicalDocumentationSection {
  const ClinicalDocumentationSection({
    required this.id,
    required this.label,
    this.required = false,
    this.multiline = true,
  });

  final String id;
  final String label;
  final bool required;
  final bool multiline;

  factory ClinicalDocumentationSection.fromJson(Map<String, dynamic> json) {
    return ClinicalDocumentationSection(
      id: _string(json['id']),
      label: _string(json['label']),
      required: _bool(json['required']),
      multiline: _bool(json['multiline'], fallback: true),
    );
  }
}

class ClinicalDocumentationTemplate {
  const ClinicalDocumentationTemplate({
    required this.id,
    required this.title,
    required this.context,
    required this.encounterType,
    required this.version,
    required this.sections,
    this.lockScope,
  });

  final String id;
  final String title;
  final String context;
  final String encounterType;
  final int version;
  final List<ClinicalDocumentationSection> sections;
  final String? lockScope;

  factory ClinicalDocumentationTemplate.fromJson(Map<String, dynamic> json) {
    final sections = json['sections'] is List
        ? (json['sections'] as List)
              .whereType<Map>()
              .map(
                (section) => ClinicalDocumentationSection.fromJson(
                  Map<String, dynamic>.from(section),
                ),
              )
              .toList()
        : const <ClinicalDocumentationSection>[];
    return ClinicalDocumentationTemplate(
      id: _string(json['id']),
      title: _string(json['title']),
      context: _string(json['context']),
      encounterType: _string(
        json['encounter_type'] ?? json['encounterType'],
        fallback: 'op',
      ),
      version: _int(json['version']) ?? 1,
      sections: sections,
      lockScope: _nullableString(json['lock_scope'] ?? json['lockScope']),
    );
  }
}

class ClinicalDowntimePolicy {
  const ClinicalDowntimePolicy({
    required this.policyVersion,
    required this.mode,
    required this.readAllowed,
    required this.queueableWrites,
    required this.localDraftOnly,
    required this.blockedOffline,
    required this.reconciliation,
    this.role,
    this.generatedAt,
  });

  final String policyVersion;
  final String mode;
  final String? role;
  final List<String> readAllowed;
  final List<String> queueableWrites;
  final List<String> localDraftOnly;
  final List<String> blockedOffline;
  final List<String> reconciliation;
  final DateTime? generatedAt;

  factory ClinicalDowntimePolicy.fromJson(Map<String, dynamic> json) {
    return ClinicalDowntimePolicy(
      policyVersion: _string(
        json['policy_version'] ?? json['policyVersion'],
        fallback: 'clinical-downtime-v1',
      ),
      mode: _string(json['mode'], fallback: 'online_first'),
      role: _nullableString(json['role']),
      readAllowed: _stringList(json['read_allowed'] ?? json['readAllowed']),
      queueableWrites: _stringList(
        json['queueable_writes'] ?? json['queueableWrites'],
      ),
      localDraftOnly: _stringList(
        json['local_draft_only'] ?? json['localDraftOnly'],
      ),
      blockedOffline: _stringList(
        json['blocked_offline'] ?? json['blockedOffline'],
      ),
      reconciliation: _stringList(json['reconciliation']),
      generatedAt: _date(json['generated_at'] ?? json['generatedAt']),
    );
  }
}

class RolePolicyFeature {
  const RolePolicyFeature({
    required this.id,
    required this.title,
    this.sidebarLabel,
    this.sidebarOrder,
    this.capabilityGroup,
  });

  final String id;
  final String title;
  final String? sidebarLabel;
  final int? sidebarOrder;
  final String? capabilityGroup;

  factory RolePolicyFeature.fromJson(Map<String, dynamic> json) {
    return RolePolicyFeature(
      id: _string(json['id']),
      title: _string(json['title']),
      sidebarLabel: _nullableString(
        json['sidebar_label'] ?? json['sidebarLabel'],
      ),
      sidebarOrder: _int(json['sidebar_order'] ?? json['sidebarOrder']),
      capabilityGroup: _nullableString(
        json['capability_group'] ?? json['capabilityGroup'],
      ),
    );
  }
}

class RolePolicySnapshot {
  const RolePolicySnapshot({
    required this.policyVersion,
    required this.policyHash,
    required this.features,
    required this.featuresByRole,
    required this.roles,
    this.generatedAt,
  });

  final String policyVersion;
  final String policyHash;
  final List<RolePolicyFeature> features;
  final Map<String, List<String>> featuresByRole;
  final List<Map<String, dynamic>> roles;
  final DateTime? generatedAt;

  factory RolePolicySnapshot.fromJson(Map<String, dynamic> json) {
    final features = json['staff_features'] is List
        ? (json['staff_features'] as List)
              .whereType<Map>()
              .map(
                (feature) => RolePolicyFeature.fromJson(
                  Map<String, dynamic>.from(feature),
                ),
              )
              .toList()
        : const <RolePolicyFeature>[];
    final roles = json['roles'] is List
        ? (json['roles'] as List)
              .whereType<Map>()
              .map((role) => Map<String, dynamic>.from(role))
              .toList()
        : <Map<String, dynamic>>[];
    return RolePolicySnapshot(
      policyVersion: _string(json['policy_version'] ?? json['policyVersion']),
      policyHash: _string(json['policy_hash'] ?? json['policyHash']),
      features: features,
      featuresByRole: _stringListMap(
        json['staff_features_by_role'] ?? json['staffFeaturesByRole'],
      ),
      roles: roles,
      generatedAt: _date(json['generated_at'] ?? json['generatedAt']),
    );
  }

  List<RolePolicyFeature> featuresForRole(String roleCode) {
    final ids = featuresByRole[roleCode.toUpperCase()] ?? const <String>[];
    if (ids.isEmpty) return const <RolePolicyFeature>[];
    final byId = {for (final feature in features) feature.id: feature};
    return ids.map((id) => byId[id]).whereType<RolePolicyFeature>().toList();
  }
}

String _string(dynamic value, {String fallback = ''}) {
  final text = value?.toString().trim();
  return text == null || text.isEmpty ? fallback : text;
}

String? _nullableString(dynamic value) {
  final text = value?.toString().trim();
  return text == null || text.isEmpty ? null : text;
}

int? _int(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}

DateTime? _date(dynamic value) {
  if (value is DateTime) return value;
  final text = value?.toString();
  return text == null || text.isEmpty ? null : DateTime.tryParse(text);
}

bool _bool(dynamic value, {bool fallback = false}) {
  if (value is bool) return value;
  if (value == null) return fallback;
  final text = value.toString().trim().toLowerCase();
  if (text == 'true' || text == '1' || text == 'yes') return true;
  if (text == 'false' || text == '0' || text == 'no') return false;
  return fallback;
}

Map<String, dynamic> _map(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return const {};
}

List<String> _stringList(dynamic value) {
  if (value is List) {
    return value.map((item) => item.toString()).toList();
  }
  return const [];
}

Map<String, List<String>> _stringListMap(dynamic value) {
  if (value is! Map) return const {};
  final out = <String, List<String>>{};
  for (final entry in value.entries) {
    out[entry.key.toString().toUpperCase()] = _stringList(entry.value);
  }
  return out;
}

List<MedicationSafetyIssue> _issueList(dynamic value) {
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map(
        (issue) =>
            MedicationSafetyIssue.fromJson(Map<String, dynamic>.from(issue)),
      )
      .toList();
}

List<MedicationSafetyReview> _reviewList(dynamic value) {
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map(
        (review) =>
            MedicationSafetyReview.fromJson(Map<String, dynamic>.from(review)),
      )
      .toList();
}
