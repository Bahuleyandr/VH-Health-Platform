import 'api_client.dart';
import 'idempotency_attempt_registry.dart';

final RegExp _positiveBigint = RegExp(r'^[1-9][0-9]*$');

String _requiredId(Object? value, String field) {
  final id = value?.toString().trim() ?? '';
  if (!_positiveBigint.hasMatch(id)) {
    throw FormatException('$field must be a positive integer');
  }
  return id;
}

String _text(Object? value) => value?.toString().trim() ?? '';

DateTime? _date(Object? value) {
  final raw = _text(value);
  return raw.isEmpty ? null : DateTime.tryParse(raw)?.toLocal();
}

int _integer(Object? value) {
  if (value is int) return value;
  return int.tryParse(_text(value)) ?? 0;
}

class ClinicalAlertDeliveryRecoveryCase {
  const ClinicalAlertDeliveryRecoveryCase({
    required this.caseId,
    required this.caseKind,
    required this.status,
    required this.obligationId,
    required this.sourceTable,
    required this.sourceId,
    required this.failureKind,
    required this.obligationStatus,
    required this.taskStatus,
    required this.slaStatus,
    required this.openAgeSeconds,
    required this.overdue,
    required this.escalationAttemptCount,
    required this.dueAt,
    required this.escalatedAt,
    required this.lastErrorCode,
    required this.manualHoldCode,
    required this.manualHoldReason,
    required this.resolutionKind,
  });

  final String caseId;
  final String caseKind;
  final String status;
  final String obligationId;
  final String sourceTable;
  final String sourceId;
  final String failureKind;
  final String obligationStatus;
  final String taskStatus;
  final String slaStatus;
  final int openAgeSeconds;
  final bool overdue;
  final int escalationAttemptCount;
  final DateTime? dueAt;
  final DateTime? escalatedAt;
  final String lastErrorCode;
  final String manualHoldCode;
  final String manualHoldReason;
  final String resolutionKind;

  bool get isOpen => status == 'open';
  bool get canRetry => isOpen && caseKind == 'recipient_coverage';
  bool get canSupersede =>
      isOpen && caseKind == 'manual_hold' && obligationStatus == 'manual_hold';

  factory ClinicalAlertDeliveryRecoveryCase.fromJson(
    Map<String, dynamic> json,
  ) {
    final kind = _text(json['case_kind']).toLowerCase();
    if (kind != 'manual_hold' && kind != 'recipient_coverage') {
      throw const FormatException('Unsupported clinical alert recovery kind');
    }
    final status = _text(json['case_status']).toLowerCase();
    if (status != 'open' && status != 'resolved') {
      throw const FormatException('Unsupported clinical alert recovery status');
    }
    return ClinicalAlertDeliveryRecoveryCase(
      caseId: _requiredId(json['case_id'], 'case_id'),
      caseKind: kind,
      status: status,
      obligationId: _requiredId(json['obligation_id'], 'obligation_id'),
      sourceTable: _text(json['source_table']),
      sourceId: _text(json['source_id']),
      failureKind: _text(json['failure_kind']),
      obligationStatus: _text(json['obligation_status']).toLowerCase(),
      taskStatus: _text(json['task_status']).toLowerCase(),
      slaStatus: _text(json['sla_status']).toLowerCase(),
      openAgeSeconds: _integer(json['open_age_seconds']),
      overdue: json['overdue'] == true,
      escalationAttemptCount: _integer(json['escalation_attempt_count']),
      dueAt: _date(json['due_at']),
      escalatedAt: _date(json['escalated_at']),
      lastErrorCode: _text(json['last_error_code']),
      manualHoldCode: _text(json['manual_hold_code']),
      manualHoldReason: _text(json['manual_hold_reason']),
      resolutionKind: _text(json['resolution_kind']),
    );
  }
}

class ClinicalAlertDeliveryRecoveryAction {
  const ClinicalAlertDeliveryRecoveryAction({
    required this.caseId,
    required this.obligationId,
    required this.actionId,
    required this.outcome,
    required this.replayed,
    required this.replacementObligationId,
  });

  final String caseId;
  final String obligationId;
  final String actionId;
  final String outcome;
  final bool replayed;
  final String replacementObligationId;

  factory ClinicalAlertDeliveryRecoveryAction.fromJson(
    Map<String, dynamic> json,
  ) => ClinicalAlertDeliveryRecoveryAction(
    caseId: _requiredId(json['case_id'], 'case_id'),
    obligationId: _requiredId(json['obligation_id'], 'obligation_id'),
    actionId: _requiredId(json['action_id'], 'action_id'),
    outcome: _text(json['outcome']).toLowerCase(),
    replayed: json['replayed'] == true,
    replacementObligationId: _text(json['replacement_obligation_id']),
  );
}

abstract class ClinicalAlertDeliveryRecoveryApi {
  Future<List<ClinicalAlertDeliveryRecoveryCase>> listOpenCases();

  Future<ClinicalAlertDeliveryRecoveryCase> getCase(String caseId);

  Future<ClinicalAlertDeliveryRecoveryAction> retry({
    required String caseId,
    required String reason,
  });

  Future<ClinicalAlertDeliveryRecoveryAction> supersede({
    required String caseId,
    required String reason,
  });
}

class ClinicalAlertDeliveryRecoveryApiService
    implements ClinicalAlertDeliveryRecoveryApi {
  ClinicalAlertDeliveryRecoveryApiService({
    IdempotencyAttemptRegistry? attempts,
  }) : _attempts = attempts ?? IdempotencyAttemptRegistry();

  static final ClinicalAlertDeliveryRecoveryApiService instance =
      ClinicalAlertDeliveryRecoveryApiService();

  final IdempotencyAttemptRegistry _attempts;

  static const String _base = '/admin/clinical-alert-delivery/recovery-cases';

  @override
  Future<List<ClinicalAlertDeliveryRecoveryCase>> listOpenCases() async {
    final response = await ApiClient.get(
      _base,
      queryParameters: const {'status': 'open', 'limit': '100'},
    );
    if (!response.isSuccess) {
      throw Exception(
        response.failureMessage('Could not load clinical alert recovery cases'),
      );
    }
    final data = response.dataAsMap();
    final rows = data['cases'] is List ? data['cases'] as List : const [];
    return rows
        .whereType<Map>()
        .map(
          (row) => ClinicalAlertDeliveryRecoveryCase.fromJson(
            row.cast<String, dynamic>(),
          ),
        )
        .toList(growable: false);
  }

  @override
  Future<ClinicalAlertDeliveryRecoveryCase> getCase(String caseId) async {
    final id = _requiredId(caseId, 'case_id');
    final response = await ApiClient.get('$_base/$id');
    if (!response.isSuccess) {
      throw Exception(
        response.failureMessage('Could not load clinical alert recovery case'),
      );
    }
    return ClinicalAlertDeliveryRecoveryCase.fromJson(response.dataAsMap());
  }

  @override
  Future<ClinicalAlertDeliveryRecoveryAction> retry({
    required String caseId,
    required String reason,
  }) => _command(caseId: caseId, reason: reason, action: 'retry');

  @override
  Future<ClinicalAlertDeliveryRecoveryAction> supersede({
    required String caseId,
    required String reason,
  }) => _command(caseId: caseId, reason: reason, action: 'supersede');

  Future<ClinicalAlertDeliveryRecoveryAction> _command({
    required String caseId,
    required String reason,
    required String action,
  }) async {
    final id = _requiredId(caseId, 'case_id');
    final cleanReason = reason.trim();
    if (cleanReason.length < 10 || cleanReason.length > 1000) {
      throw const FormatException(
        'Recovery reason must contain between 10 and 1000 characters',
      );
    }
    final body = <String, dynamic>{'reason': cleanReason};
    final scope = 'clinical-alert-recovery-$action-$id';
    final response = await ApiClient.post(
      '$_base/$id/$action',
      body: body,
      idempotencyKey: _attempts.keyFor(scope, body),
    );
    if (!response.isSuccess) {
      throw Exception(
        response.failureMessage('Clinical alert recovery action failed'),
      );
    }
    final result = ClinicalAlertDeliveryRecoveryAction.fromJson(
      response.dataAsMap(),
    );
    _attempts.complete(scope);
    return result;
  }

  void dispose() => _attempts.clear();
}
