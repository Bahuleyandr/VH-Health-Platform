class AppointmentPathwayWork {
  const AppointmentPathwayWork({
    required this.mode,
    required this.visitCompletion,
    required this.pathwayClosure,
    required this.items,
    required this.priorAdmissionPendingResults,
    this.closureEvidence,
  });

  final String mode;
  final CarePathwayGate visitCompletion;
  final CarePathwayGate pathwayClosure;
  final List<CarePathwayWorkItem> items;
  final List<OpFollowUpPendingResult> priorAdmissionPendingResults;
  final OpVisitClosureEvidence? closureEvidence;

  bool get isActive => mode.toLowerCase() == 'active';

  List<CarePathwayWorkItem> get unresolvedItems =>
      items.where((item) => !item.isResolved).toList(growable: false);

  List<int> get followUpPlanIds => items
      .where((item) => item.resourceType == 'follow_up_plan')
      .map((item) => int.tryParse(item.resourceId))
      .whereType<int>()
      .where((id) => id > 0)
      .toSet()
      .toList(growable: false);

  List<String> get acceptedHandoffIds => items
      .where(
        (item) =>
            item.evidenceState == 'ownership_accepted' &&
            item.handoffId?.isNotEmpty == true,
      )
      .map((item) => item.handoffId!)
      .toSet()
      .toList(growable: false);

  factory AppointmentPathwayWork.fromJson(Map<String, dynamic> json) {
    final closureEvidence = _map(json['closure_evidence']);
    return AppointmentPathwayWork(
      mode: _text(json['mode'], 'off'),
      visitCompletion: CarePathwayGate.fromJson(_map(json['visit_completion'])),
      pathwayClosure: CarePathwayGate.fromJson(_map(json['pathway_closure'])),
      items: _mapList(json['items'])
          .map(CarePathwayWorkItem.fromJson)
          .toList(growable: false),
      priorAdmissionPendingResults: _mapList(
        json['prior_admission_pending_results'],
      ).map(OpFollowUpPendingResult.fromJson).toList(growable: false),
      closureEvidence: closureEvidence.isEmpty
          ? null
          : OpVisitClosureEvidence.fromJson(closureEvidence),
    );
  }
}

class OpFollowUpPendingResult {
  const OpFollowUpPendingResult({
    required this.admissionId,
    required this.handoffId,
    required this.sourceType,
    required this.patientSafeLabel,
    required this.resultStatus,
    required this.handoffState,
    required this.requiresAction,
    required this.canCrossSign,
    required this.ownerUid,
    required this.ownerName,
    required this.ownerRole,
    required this.generationId,
    required this.generationSnapshotSha256,
    required this.diagnosticClassification,
    required this.diagnosticActionId,
    required this.diagnosticActionKind,
    required this.diagnosticDisposition,
    required this.diagnosticActionOccurredAt,
    required this.resolutionActionId,
    required this.resolvedAt,
    required this.resolvedByUid,
    required this.route,
    this.taskId,
    this.taskStatus,
    this.actionTaskId,
    this.actionTaskStatus,
    this.trackingTaskId,
    this.trackingTaskStatus,
  });

  final int? admissionId;
  final String handoffId;
  final String sourceType;
  final String patientSafeLabel;
  final String resultStatus;
  final String handoffState;
  final bool requiresAction;
  final bool canCrossSign;
  final String ownerUid;
  final String ownerName;
  final String ownerRole;
  final String generationId;
  final String generationSnapshotSha256;
  final String diagnosticClassification;
  final String diagnosticActionId;
  final String diagnosticActionKind;
  final String diagnosticDisposition;
  final DateTime? diagnosticActionOccurredAt;
  final String resolutionActionId;
  final DateTime? resolvedAt;
  final String resolvedByUid;
  final String? route;
  final int? taskId;
  final String? taskStatus;
  final int? actionTaskId;
  final String? actionTaskStatus;
  final int? trackingTaskId;
  final String? trackingTaskStatus;

  bool get hasExactCrossSignBinding =>
      admissionId != null &&
      handoffId.isNotEmpty &&
      generationId.isNotEmpty &&
      generationSnapshotSha256.isNotEmpty &&
      diagnosticActionId.isNotEmpty &&
      actionTaskId != null;

  bool get needsCrossSign =>
      canCrossSign &&
      requiresAction &&
      hasExactCrossSignBinding &&
      handoffState == 'result_available' &&
      resolutionActionId.isEmpty &&
      diagnosticActionKind == 'doctor_disposition' &&
      diagnosticDisposition.isNotEmpty;

  factory OpFollowUpPendingResult.fromJson(Map<String, dynamic> json) {
    final owner = _map(json['named_owner']);
    final task = _map(json['task']);
    final actionTask = _map(json['action_task']);
    final trackingTask = _map(json['tracking_task']);
    return OpFollowUpPendingResult(
      admissionId: _int(json['admission_id']),
      handoffId: _text(json['handoff_id']),
      sourceType: _text(json['source_type'], 'result'),
      patientSafeLabel: _text(json['patient_safe_label']),
      resultStatus: _text(json['result_status'], 'pending'),
      handoffState: _text(json['handoff_state'], 'pending'),
      requiresAction: _bool(json['requires_action']),
      canCrossSign: _bool(json['can_cross_sign']),
      ownerUid: _text(owner['uid']),
      ownerName: _text(owner['display_name']),
      ownerRole: _text(owner['role']),
      generationId: _text(json['generation_id']),
      generationSnapshotSha256: _text(json['generation_snapshot_sha256'])
          .toLowerCase(),
      diagnosticClassification: _text(json['diagnostic_classification'])
          .toLowerCase(),
      diagnosticActionId: _text(json['diagnostic_action_id']),
      diagnosticActionKind: _text(json['diagnostic_action_kind']).toLowerCase(),
      diagnosticDisposition: _text(json['diagnostic_disposition'])
          .toLowerCase(),
      diagnosticActionOccurredAt: _date(json['diagnostic_action_occurred_at']),
      resolutionActionId: _text(json['resolution_action_id']),
      resolvedAt: _date(json['resolved_at']),
      resolvedByUid: _text(json['resolved_by_uid']),
      route: _nullableText(json['route']),
      taskId: _int(task['id']),
      taskStatus: _nullableText(task['status']),
      actionTaskId: _int(actionTask['id']),
      actionTaskStatus: _nullableText(actionTask['status']),
      trackingTaskId: _int(trackingTask['id']),
      trackingTaskStatus: _nullableText(trackingTask['status']),
    );
  }
}

class CarePathwayGate {
  const CarePathwayGate({required this.allowed, required this.blockers});

  final bool allowed;
  final List<CarePathwayBlocker> blockers;

  factory CarePathwayGate.fromJson(Map<String, dynamic> json) {
    return CarePathwayGate(
      allowed: _bool(json['allowed'], fallback: true),
      blockers: _mapList(json['blockers'])
          .map(CarePathwayBlocker.fromJson)
          .toList(growable: false),
    );
  }
}

class CarePathwayBlocker {
  const CarePathwayBlocker({required this.code, required this.message});

  final String code;
  final String message;

  factory CarePathwayBlocker.fromJson(Map<String, dynamic> json) {
    return CarePathwayBlocker(
      code: _text(json['code'] ?? json['type']),
      message: _text(json['message'] ?? json['label']),
    );
  }
}

class CarePathwayWorkItem {
  const CarePathwayWorkItem({
    required this.resourceType,
    required this.resourceId,
    required this.relationshipKind,
    required this.evidenceState,
    required this.blocking,
    this.ownerUid,
    this.ownerName,
    this.ownerRole,
    this.route,
    this.taskId,
    this.handoffId,
  });

  final String resourceType;
  final String resourceId;
  final String relationshipKind;
  final String evidenceState;
  final bool blocking;
  final String? ownerUid;
  final String? ownerName;
  final String? ownerRole;
  final String? route;
  final int? taskId;
  final String? handoffId;

  bool get isResolved {
    final state = evidenceState.toLowerCase();
    if (state == 'completed' || state == 'superseded') return true;
    if (state != 'ownership_accepted') return false;
    return ownerUid != null || handoffId != null;
  }

  bool get hasNamedOwner => ownerName != null && ownerName!.trim().isNotEmpty;

  factory CarePathwayWorkItem.fromJson(Map<String, dynamic> json) {
    return CarePathwayWorkItem(
      resourceType: _text(json['resource_type'], 'work_item'),
      resourceId: _text(json['id'] ?? json['resource_id']),
      relationshipKind: _text(
        json['relationship_kind'] ?? json['relationship'],
        'child_action',
      ),
      evidenceState: _text(json['evidence_state'] ?? json['state'], 'open'),
      blocking: _bool(json['blocking']),
      ownerUid: _nullableText(json['owner_uid']),
      ownerName: _nullableText(json['owner_name']),
      ownerRole: _nullableText(json['owner_role']),
      route: _nullableText(json['route']),
      taskId: _int(json['task_id']),
      handoffId: _nullableText(json['handoff_id']),
    );
  }
}

class PatientSafeNextStep {
  const PatientSafeNextStep({
    required this.label,
    this.explanation,
    this.dueDate,
    this.status,
    this.patientAction,
    this.responsibleClinicianDisplayName,
    this.responsibleClinicianRole,
    this.safeContact,
    this.routeToken,
  });

  final String label;
  final String? explanation;
  final String? dueDate;
  final String? status;
  final String? patientAction;
  final String? responsibleClinicianDisplayName;
  final String? responsibleClinicianRole;
  final String? safeContact;
  final String? routeToken;

  factory PatientSafeNextStep.fromJson(Map<String, dynamic> json) {
    return PatientSafeNextStep(
      label: _text(json['label']),
      explanation: _nullableText(json['explanation']),
      dueDate: _nullableText(json['due_date']),
      status: _nullableText(json['status']),
      patientAction: _nullableText(json['patient_action']),
      responsibleClinicianDisplayName: _nullableText(
        json['responsible_clinician_display_name'],
      ),
      responsibleClinicianRole: _nullableText(
        json['responsible_clinician_role'],
      ),
      safeContact: _nullableText(json['safe_contact']),
      routeToken: _nullableText(json['route_token']),
    );
  }
}

class PatientSafeNextStepCommand {
  const PatientSafeNextStepCommand({
    required this.label,
    this.explanation,
    this.dueDate,
    this.status = 'planned',
    this.patientAction,
    this.routeToken,
  });

  final String label;
  final String? explanation;
  final String? dueDate;
  final String status;
  final String? patientAction;
  final String? routeToken;

  Map<String, dynamic> toJson() => {
    'label': label.trim(),
    if (explanation?.trim().isNotEmpty == true)
      'explanation': explanation!.trim(),
    if (dueDate?.trim().isNotEmpty == true) 'due_date': dueDate!.trim(),
    'status': status,
    if (patientAction?.trim().isNotEmpty == true)
      'patient_action': patientAction!.trim(),
    if (routeToken?.trim().isNotEmpty == true)
      'route_token': routeToken!.trim(),
  };
}

class OpClosureEvidenceCommand {
  const OpClosureEvidenceCommand({
    required this.followUpRequired,
    required this.patientSafeNextSteps,
    required this.closureBasis,
    this.followUpPlanId,
    this.acceptedHandoffId,
  });

  final bool followUpRequired;
  final int? followUpPlanId;
  final List<PatientSafeNextStepCommand> patientSafeNextSteps;
  final String closureBasis;
  final String? acceptedHandoffId;

  Map<String, dynamic> toJson({required String idempotencyKey}) => {
    'follow_up_required': followUpRequired,
    if (followUpRequired) 'follow_up_plan_id': followUpPlanId,
    'patient_safe_next_steps': patientSafeNextSteps
        .map((step) => step.toJson())
        .toList(growable: false),
    'closure_basis': closureBasis,
    if (closureBasis == 'accepted_transfer')
      'accepted_handoff_id': acceptedHandoffId,
    'idempotency_key': idempotencyKey,
  };
}

class OpVisitClosureEvidence {
  const OpVisitClosureEvidence({
    required this.id,
    required this.revision,
    required this.clinicianUid,
    required this.followUpRequired,
    required this.patientNextSteps,
    required this.closureBasis,
    this.followUpPlanId,
    this.acceptedHandoffId,
    this.sourceStatusHistoryId,
    this.occurredAt,
    this.recordedAt,
  });

  final String id;
  final int revision;
  final String clinicianUid;
  final bool followUpRequired;
  final String? followUpPlanId;
  final List<PatientSafeNextStep> patientNextSteps;
  final String closureBasis;
  final String? acceptedHandoffId;
  final String? sourceStatusHistoryId;
  final DateTime? occurredAt;
  final DateTime? recordedAt;

  factory OpVisitClosureEvidence.fromJson(Map<String, dynamic> json) {
    return OpVisitClosureEvidence(
      id: _text(json['id']),
      revision: _int(json['revision'] ?? json['evidence_revision']) ?? 1,
      clinicianUid: _text(json['clinician_uid']),
      followUpRequired: _bool(json['follow_up_required']),
      followUpPlanId: _nullableText(json['follow_up_plan_id']),
      patientNextSteps: _mapList(
        json['patient_next_steps'] ?? json['patient_safe_next_steps'],
      ).map(PatientSafeNextStep.fromJson).toList(growable: false),
      closureBasis: _text(json['closure_basis']),
      acceptedHandoffId: _nullableText(json['accepted_handoff_id']),
      sourceStatusHistoryId: _nullableText(
        json['source_status_history_id'] ?? json['source_appointment_revision'],
      ),
      occurredAt: _date(json['occurred_at']),
      recordedAt: _date(json['recorded_at']),
    );
  }
}

class OpAdmissionSourceTuple {
  const OpAdmissionSourceTuple({
    required this.appointmentId,
    required this.sourcePathwayInstanceId,
    required this.sourceHandoffId,
    this.acceptedRecipientUid,
  });

  final int appointmentId;
  final String sourcePathwayInstanceId;
  final String sourceHandoffId;
  final String? acceptedRecipientUid;

  bool get isAccepted =>
      appointmentId > 0 &&
      sourcePathwayInstanceId.isNotEmpty &&
      sourceHandoffId.isNotEmpty &&
      acceptedRecipientUid?.isNotEmpty == true;

  factory OpAdmissionSourceTuple.fromJson(Map<String, dynamic> json) {
    return OpAdmissionSourceTuple(
      appointmentId: _int(json['appointment_id']) ?? 0,
      sourcePathwayInstanceId: _text(json['source_pathway_instance_id']),
      sourceHandoffId: _text(json['source_handoff_id']),
      acceptedRecipientUid: _nullableText(json['accepted_recipient_uid']),
    );
  }
}

class OpInpatientTransferReceipt {
  const OpInpatientTransferReceipt({
    required this.handoffId,
    required this.handoffStatus,
    required this.taskId,
    required this.taskKind,
    required this.taskStatus,
    required this.transitionKey,
    required this.admissionSource,
    required this.replayed,
    this.requestedAt,
    this.acceptedAt,
  });

  final String handoffId;
  final String handoffStatus;
  final int taskId;
  final String taskKind;
  final String taskStatus;
  final String transitionKey;
  final OpAdmissionSourceTuple admissionSource;
  final bool replayed;
  final DateTime? requestedAt;
  final DateTime? acceptedAt;

  factory OpInpatientTransferReceipt.fromJson(Map<String, dynamic> json) {
    final handoff = _map(json['handoff']);
    final task = _map(json['task']);
    final transition = _map(json['transition']);
    return OpInpatientTransferReceipt(
      handoffId: _text(handoff['id']),
      handoffStatus: _text(handoff['status']),
      taskId: _int(task['id']) ?? 0,
      taskKind: _text(task['task_kind']),
      taskStatus: _text(task['status']),
      transitionKey: _text(transition['transition_key']),
      admissionSource: OpAdmissionSourceTuple.fromJson(
        _map(json['admission_source']),
      ),
      replayed: _bool(json['replayed']),
      requestedAt: _date(handoff['requested_at']),
      acceptedAt: _date(handoff['accepted_at']),
    );
  }
}

class InpatientPendingResultsWork {
  const InpatientPendingResultsWork({
    required this.mode,
    required this.projectionReady,
    required this.items,
    required this.activeBlockers,
    this.signedSummaryId,
    this.followUpExceptionReason,
  });

  final String mode;
  final bool projectionReady;
  final List<DischargePendingResultHandoff> items;
  final List<CarePathwayBlocker> activeBlockers;
  final int? signedSummaryId;
  final String? followUpExceptionReason;

  bool get isActive => mode.toLowerCase() == 'active';

  factory InpatientPendingResultsWork.fromJson(Map<String, dynamic> json) {
    final pending = _map(json['pending_results']);
    final evidence = _map(json['evidence']);
    final summary = _map(evidence['structured_signed_summary']);
    final exception = _map(evidence['audited_follow_up_exception']);
    return InpatientPendingResultsWork(
      mode: _text(json['mode'], 'off'),
      projectionReady: _bool(pending['projection_ready']),
      items: _mapList(pending['items'])
          .map(DischargePendingResultHandoff.fromJson)
          .toList(growable: false),
      activeBlockers: _mapList(json['active_blockers'])
          .map(CarePathwayBlocker.fromJson)
          .toList(growable: false),
      signedSummaryId: _int(summary['id']),
      followUpExceptionReason: _nullableText(exception['reason']),
    );
  }
}

class DischargePendingResultHandoff {
  const DischargePendingResultHandoff({
    required this.sourceType,
    required this.sourceId,
    required this.safeLabel,
    required this.currentStatus,
    required this.exactLineage,
    required this.summaryIncluded,
    required this.handoffComplete,
    required this.handoffCompleteWarning,
    required this.blocking,
    required this.blockerCodes,
    this.resourceReferenceId,
    this.handoffId,
    this.handoffState,
    this.handoffTaskId,
    this.ownerUid,
    this.ownerName,
    this.ownerRole,
    this.ownerRoute,
  });

  final String sourceType;
  final String sourceId;
  final String safeLabel;
  final String currentStatus;
  final bool exactLineage;
  final bool summaryIncluded;
  final bool handoffComplete;
  final bool handoffCompleteWarning;
  final bool blocking;
  final List<String> blockerCodes;
  final String? resourceReferenceId;
  final String? handoffId;
  final String? handoffState;
  final int? handoffTaskId;
  final String? ownerUid;
  final String? ownerName;
  final String? ownerRole;
  final String? ownerRoute;

  bool get hasNamedOwner => ownerName != null && ownerName!.trim().isNotEmpty;

  bool get supportsStaffHandoffAction => const {
    'lab_result',
    'radiology_order',
    'anatomical_pathology_case',
  }.contains(sourceType);

  bool get canCreateNamedOwnerHandoff =>
      supportsStaffHandoffAction &&
      resourceReferenceId?.isNotEmpty == true &&
      handoffId == null;

  bool get canBindSignedSummary =>
      supportsStaffHandoffAction &&
      handoffId?.isNotEmpty == true &&
      !summaryIncluded;

  factory DischargePendingResultHandoff.fromJson(Map<String, dynamic> json) {
    final namedOwner = _map(json['named_owner'] ?? json['owner']);
    final handoff = _map(json['handoff']);
    final rawBlockers = json['blocker_codes'] ?? json['blockers'];
    return DischargePendingResultHandoff(
      sourceType: _text(json['source_type'] ?? json['resource_type'], 'result'),
      sourceId: _text(json['source_id'] ?? json['resource_id'] ?? json['id']),
      safeLabel: _text(
        json['safe_label'] ?? json['patient_safe_label'] ?? json['label'],
      ),
      currentStatus: _text(json['current_status'] ?? json['status'], 'pending'),
      exactLineage: _bool(json['exact_lineage'] ?? json['lineage_complete']),
      summaryIncluded: _bool(
        json['summary_included'] ??
            json['signed_summary_included'] ??
            (handoff['summary_included_at'] != null),
      ),
      handoffComplete: _bool(
        json['handoff_complete'] ?? json['ownership_accepted'],
      ),
      handoffCompleteWarning: _bool(json['handoff_complete_warning']),
      blocking: _bool(json['blocking'] ?? json['is_blocking']),
      blockerCodes: _textList(rawBlockers),
      resourceReferenceId: _nullableText(json['resource_reference_id']),
      handoffId: _nullableText(handoff['id']),
      handoffState: _nullableText(handoff['state'] ?? handoff['handoff_state']),
      handoffTaskId: _int(handoff['task_id']),
      ownerUid: _nullableText(
        json['owner_uid'] ??
            namedOwner['uid'] ??
            handoff['named_physician_uid'],
      ),
      ownerName: _nullableText(
        json['owner_name'] ??
            namedOwner['display_name'] ??
            namedOwner['name'] ??
            handoff['named_physician_name'],
      ),
      ownerRole: _nullableText(json['owner_role'] ?? namedOwner['role']),
      ownerRoute: _nullableText(json['owner_route'] ?? namedOwner['route']),
    );
  }
}

class CarePathwayTaskItem {
  const CarePathwayTaskItem({
    required this.label,
    required this.kind,
    required this.status,
    required this.priority,
    required this.relationship,
    required this.blockingState,
    this.ownerUid,
    this.ownerName,
    this.ownerRole,
    this.ownerRoute,
  });

  final String label;
  final String kind;
  final String status;
  final String priority;
  final String relationship;
  final String blockingState;
  final String? ownerUid;
  final String? ownerName;
  final String? ownerRole;
  final String? ownerRoute;

  bool get isBlocking {
    final state = blockingState.toLowerCase();
    return state == 'blocking' || state == 'blocked' || state == 'true';
  }

  factory CarePathwayTaskItem.fromJson(Map<String, dynamic> json) {
    final owner = _map(json['named_owner'] ?? json['owner']);
    final rawBlocking = json['blocking_state'] ?? json['blocking'];
    return CarePathwayTaskItem(
      label: _text(json['label']),
      kind: _text(json['kind']),
      status: _text(json['status']),
      priority: _text(json['priority']),
      relationship: _text(json['relationship'] ?? json['relationship_kind']),
      blockingState: rawBlocking is bool
          ? (rawBlocking ? 'blocking' : 'non_blocking')
          : _text(rawBlocking),
      ownerUid: _nullableText(
        json['owner_uid'] ?? owner['uid'] ?? json['assigned_to_uid'],
      ),
      ownerName: _nullableText(
        json['owner_name'] ?? owner['display_name'] ?? owner['name'],
      ),
      ownerRole: _nullableText(json['owner_role'] ?? owner['role']),
      ownerRoute: _nullableText(
        json['owner_route'] ?? owner['route'] ?? json['route'],
      ),
    );
  }
}

Map<String, dynamic> _map(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return const {};
}

List<Map<String, dynamic>> _mapList(dynamic value) {
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map((item) => Map<String, dynamic>.from(item))
      .toList(growable: false);
}

String _text(dynamic value, [String fallback = '']) {
  final text = value?.toString().trim();
  return text == null || text.isEmpty ? fallback : text;
}

String? _nullableText(dynamic value) {
  final text = value?.toString().trim();
  return text == null || text.isEmpty ? null : text;
}

bool _bool(dynamic value, {bool fallback = false}) {
  if (value is bool) return value;
  if (value is num) return value != 0;
  final text = value?.toString().trim().toLowerCase();
  if (text == 'true' || text == 'yes' || text == '1') return true;
  if (text == 'false' || text == 'no' || text == '0') return false;
  return fallback;
}

int? _int(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}

DateTime? _date(dynamic value) {
  if (value is DateTime) return value;
  return DateTime.tryParse(value?.toString() ?? '');
}

List<String> _textList(dynamic value) {
  if (value is! List) return const [];
  return value
      .map((item) {
        if (item is Map) {
          return _text(item['code'] ?? item['type']);
        }
        return _text(item);
      })
      .where((item) => item.isNotEmpty)
      .toList(growable: false);
}
