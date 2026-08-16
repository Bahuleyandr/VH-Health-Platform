import 'package:flutter/material.dart';

import '../../../core/services/ed_trauma_api_service.dart';
import '../../../l10n/app_strings.dart';

typedef EdContinuityLoader = Future<Map<String, dynamic>> Function(
  int emergencyVisitId,
);
typedef EdVisitTransitioner = Future<Map<String, dynamic>> Function({
  required int emergencyVisitId,
  required String nextStatus,
  String? disposition,
  String? acceptedHandoffId,
});
typedef EdClosureRecorder = Future<Map<String, dynamic>> Function({
  required int emergencyVisitId,
  required Map<String, dynamic> body,
});
typedef EdRecoveryRecorder = Future<Map<String, dynamic>> Function({
  required int emergencyVisitId,
  required Map<String, dynamic> body,
});

class EdContinuityPanel extends StatefulWidget {
  const EdContinuityPanel({
    super.key,
    this.loadContinuity,
    this.transitionVisit,
    this.recordClosure,
    this.recordRecovery,
  });

  final EdContinuityLoader? loadContinuity;
  final EdVisitTransitioner? transitionVisit;
  final EdClosureRecorder? recordClosure;
  final EdRecoveryRecorder? recordRecovery;

  @override
  State<EdContinuityPanel> createState() => _EdContinuityPanelState();
}

class _EdContinuityPanelState extends State<EdContinuityPanel> {
  final _visitId = TextEditingController();
  final _transitionHandoffId = TextEditingController();
  final _followUpPlanId = TextEditingController();
  final _noFollowUpReason = TextEditingController();
  final _medicationReconciliationId = TextEditingController();
  final _medicationNotApplicableReason = TextEditingController();
  final _riskCode = TextEditingController();
  final _riskSummary = TextEditingController();
  final _acceptedHandoffId = TextEditingController();
  final _receivingFacility = TextEditingController();
  final _receivingFacilityReference = TextEditingController();
  final _receivingConfirmedBy = TextEditingController();
  final _clinicalSummaryType = TextEditingController(text: 'discharge_summary');
  final _clinicalSummaryId = TextEditingController();
  final _ambulanceRequestId = TextEditingController();
  final _transportReference = TextEditingController();
  final _deathRecordId = TextEditingController();
  final _mlcRecordId = TextEditingController();
  final _identityReason = TextEditingController();
  final _mergeRequestId = TextEditingController();
  final _recoveryOutcomeCode = TextEditingController();
  final _recoveryPatientSummary = TextEditingController();
  final _recoveryStaffNotes = TextEditingController();

  final List<_NextStepDraft> _nextSteps = [_NextStepDraft()];

  String _nextStatus = 'in_triage';
  String _disposition = 'discharged_home';
  String _closureKind = 'discharge';
  String _identityStatus = 'verified';
  String _recoveryEventKind = 'attempt';
  String _recoveryChannel = 'phone';
  bool _followUpRequired = true;
  bool _busy = false;
  String? _error;
  String? _message;
  Map<String, dynamic>? _continuityResponse;

  int? get _currentVisitId => int.tryParse(_visitId.text.trim());

  Map<String, dynamic>? get _continuity {
    final value = _continuityResponse?['continuity'];
    return value is Map ? Map<String, dynamic>.from(value) : null;
  }

  List<Map<String, dynamic>> get _closureHistory =>
      _mapList(_continuityResponse?['closure_history']);

  List<Map<String, dynamic>> get _recoveryContacts =>
      _mapList(_continuityResponse?['recovery_contacts']);

  @override
  void dispose() {
    for (final controller in [
      _visitId,
      _transitionHandoffId,
      _followUpPlanId,
      _noFollowUpReason,
      _medicationReconciliationId,
      _medicationNotApplicableReason,
      _riskCode,
      _riskSummary,
      _acceptedHandoffId,
      _receivingFacility,
      _receivingFacilityReference,
      _receivingConfirmedBy,
      _clinicalSummaryType,
      _clinicalSummaryId,
      _ambulanceRequestId,
      _transportReference,
      _deathRecordId,
      _mlcRecordId,
      _identityReason,
      _mergeRequestId,
      _recoveryOutcomeCode,
      _recoveryPatientSummary,
      _recoveryStaffNotes,
    ]) {
      controller.dispose();
    }
    for (final step in _nextSteps) {
      step.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    final id = _requireVisitId();
    if (id == null) return;
    await _run(() async {
      final loader = widget.loadContinuity ?? EdTraumaApiService.getContinuity;
      final result = await loader(id);
      if (!mounted) return;
      setState(() => _continuityResponse = result);
    });
  }

  Future<void> _transition() async {
    final id = _requireVisitId();
    if (id == null) return;
    await _run(() async {
      final transitioner =
          widget.transitionVisit ?? EdTraumaApiService.transitionVisit;
      await transitioner(
        emergencyVisitId: id,
        nextStatus: _nextStatus,
        disposition: _terminalStatus(_nextStatus) ? _disposition : null,
        acceptedHandoffId: _text(_transitionHandoffId),
      );
      if (!mounted) return;
      setState(() {
        _message = AppStrings.of(context)
            .lookup('ed_trauma.continuity.transition_saved');
      });
      await _reloadWithoutBusy(id);
    });
  }

  Future<void> _recordClosure() async {
    final id = _requireVisitId();
    if (id == null) return;
    await _run(() async {
      final recorder =
          widget.recordClosure ?? EdTraumaApiService.recordClosureEvidence;
      final now = DateTime.now().toUtc().toIso8601String();
      final isDeath = _closureKind == 'death';
      final isRecovery =
          _closureKind == 'left_against_medical_advice' ||
          _closureKind == 'lwbs';
      final isExternal = _closureKind == 'external_transfer';
      final body = _stripEmpty({
        'closure_kind': _closureKind,
        'follow_up_required': isDeath ? false : _followUpRequired,
        if (!isDeath && _followUpRequired)
          'follow_up_plan_id': _int(_followUpPlanId),
        if (!isDeath && !_followUpRequired)
          'no_follow_up_reason': _text(_noFollowUpReason),
        'patient_safe_next_steps': isDeath
            ? <Map<String, dynamic>>[]
            : _nextSteps.map((step) => step.toJson()).toList(growable: false),
        if (!isDeath)
          'medication_reconciliation_id': _text(_medicationReconciliationId),
        if (!isDeath)
          'medication_not_applicable_reason': _text(
            _medicationNotApplicableReason,
          ),
        if (isRecovery) 'risk_classification_code': _text(_riskCode),
        if (isRecovery) 'risk_summary': _text(_riskSummary),
        if (isExternal) 'accepted_handoff_id': _text(_acceptedHandoffId),
        if (isExternal) 'receiving_facility_name': _text(_receivingFacility),
        if (isExternal)
          'receiving_facility_reference': _text(_receivingFacilityReference),
        if (isExternal) 'receiving_confirmed_by': _text(_receivingConfirmedBy),
        if (isExternal) 'receiving_confirmed_at': now,
        if (isExternal)
          'clinical_summary_resource_type': _text(_clinicalSummaryType),
        if (isExternal)
          'clinical_summary_resource_id': _text(_clinicalSummaryId),
        if (isExternal) 'clinical_summary_sent_at': now,
        if (isExternal) 'ambulance_request_id': _int(_ambulanceRequestId),
        if (isExternal) 'transport_reference': _text(_transportReference),
        if (isExternal) 'transport_confirmed_at': now,
        if (isDeath) 'death_record_id': _int(_deathRecordId),
        if (isDeath) 'mlc_record_id': _int(_mlcRecordId),
        'identity_resolution_status': _identityStatus,
        if (_identityStatus == 'temporary_identity_retained')
          'identity_resolution_reason': _text(_identityReason),
        if (_identityStatus == 'merge_requested' || _identityStatus == 'merged')
          'patient_merge_request_id': _int(_mergeRequestId),
      });
      await recorder(emergencyVisitId: id, body: body);
      if (!mounted) return;
      setState(() {
        _message = AppStrings.of(context)
            .lookup('ed_trauma.continuity.closure_saved');
      });
      await _reloadWithoutBusy(id);
    });
  }

  Future<void> _recordRecovery() async {
    final id = _requireVisitId();
    if (id == null) return;
    await _run(() async {
      final recorder =
          widget.recordRecovery ?? EdTraumaApiService.recordRecoveryContact;
      await recorder(
        emergencyVisitId: id,
        body: _stripEmpty({
          'event_kind': _recoveryEventKind,
          'contact_channel': _recoveryChannel,
          if (_recoveryEventKind == 'outcome')
            'outcome_code': _text(_recoveryOutcomeCode),
          'patient_safe_summary': _text(_recoveryPatientSummary),
          'staff_notes': _text(_recoveryStaffNotes),
        }),
      );
      if (!mounted) return;
      setState(() {
        _message = AppStrings.of(context)
            .lookup('ed_trauma.continuity.recovery_saved');
      });
      await _reloadWithoutBusy(id);
    });
  }

  Future<void> _reloadWithoutBusy(int id) async {
    final loader = widget.loadContinuity ?? EdTraumaApiService.getContinuity;
    final result = await loader(id);
    if (mounted) setState(() => _continuityResponse = result);
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _message = null;
    });
    try {
      await action();
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = error.toString().replaceFirst('Exception: ', '').trim();
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  int? _requireVisitId() {
    final value = _currentVisitId;
    if (value != null && value > 0) return value;
    setState(() {
      _error = AppStrings.of(context)
          .lookup('ed_trauma.handoff.visit_required');
    });
    return null;
  }

  void _addNextStep() {
    setState(() => _nextSteps.add(_NextStepDraft()));
  }

  void _removeNextStep(int index) {
    if (_nextSteps.length == 1) return;
    final removed = _nextSteps.removeAt(index);
    removed.dispose();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final continuity = _continuity;
    return _ContinuitySection(
      title: strings.lookup('ed_trauma.continuity.title'),
      icon: Icons.route_outlined,
      children: [
        Text(
          strings.lookup('ed_trauma.continuity.intro'),
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 12),
        TextField(
          key: const ValueKey('ed-continuity-visit-id'),
          controller: _visitId,
          keyboardType: TextInputType.number,
          decoration: InputDecoration(
            labelText: strings.lookup('ed_trauma.ed_visit_id'),
            border: const OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 8),
        FilledButton.icon(
          key: const ValueKey('ed-continuity-load'),
          onPressed: _busy ? null : _load,
          icon: _busy
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.search),
          label: Text(strings.lookup('ed_trauma.continuity.load')),
        ),
        if (_error != null) ...[
          const SizedBox(height: 8),
          _StatusMessage(message: _error!, isError: true),
        ],
        if (_message != null) ...[
          const SizedBox(height: 8),
          _StatusMessage(message: _message!, isError: false),
        ],
        if (continuity != null) ...[
          const SizedBox(height: 12),
          _ContinuitySummary(continuity: continuity),
          const SizedBox(height: 12),
          _buildTransition(strings),
          const SizedBox(height: 12),
          _buildClosure(strings),
          if (_closureKind == 'left_against_medical_advice' ||
              _closureKind == 'lwbs') ...[
            const SizedBox(height: 12),
            _buildRecovery(strings),
          ],
          if (_closureHistory.isNotEmpty) ...[
            const SizedBox(height: 12),
            _EvidenceHistory(
              title: strings.lookup('ed_trauma.continuity.closure_history'),
              rows: _closureHistory,
              primaryField: 'closure_kind',
              secondaryField: 'recorded_at',
            ),
          ],
          if (_recoveryContacts.isNotEmpty) ...[
            const SizedBox(height: 12),
            _EvidenceHistory(
              title: strings.lookup('ed_trauma.continuity.recovery_history'),
              rows: _recoveryContacts,
              primaryField: 'event_kind',
              secondaryField: 'occurred_at',
            ),
          ],
        ],
      ],
    );
  }

  Widget _buildTransition(AppStrings strings) {
    return _ActionCard(
      title: strings.lookup('ed_trauma.continuity.transition_title'),
      children: [
        _Dropdown(
          fieldKey: const ValueKey('ed-continuity-next-status'),
          label: strings.lookup('ed_trauma.continuity.next_status'),
          value: _nextStatus,
          values: const [
            'in_triage',
            'awaiting_treatment',
            'in_treatment',
            'awaiting_disposition',
            'admitted',
            'discharged',
            'transferred',
            'left_against_advice',
            'lwbs',
            'expired',
            'archived',
          ],
          onChanged: (value) => setState(() => _nextStatus = value),
        ),
        if (_terminalStatus(_nextStatus)) ...[
          const SizedBox(height: 8),
          _Dropdown(
            label: strings.lookup('ed_trauma.continuity.disposition'),
            value: _disposition,
            values: const [
              'admitted',
              'discharged_home',
              'transferred_out',
              'left_against_medical_advice',
              'lwbs',
              'expired',
              'observation',
              'opd_followup',
              'other',
            ],
            onChanged: (value) => setState(() => _disposition = value),
          ),
        ],
        if (_nextStatus == 'admitted' || _nextStatus == 'transferred') ...[
          const SizedBox(height: 8),
          _Input(
            controller: _transitionHandoffId,
            label: strings.lookup('ed_trauma.continuity.accepted_handoff_id'),
          ),
        ],
        const SizedBox(height: 8),
        FilledButton.icon(
          key: const ValueKey('ed-continuity-transition'),
          onPressed: _busy ? null : _transition,
          icon: const Icon(Icons.skip_next_outlined),
          label: Text(strings.lookup('ed_trauma.continuity.transition')),
        ),
      ],
    );
  }

  Widget _buildClosure(AppStrings strings) {
    final isDeath = _closureKind == 'death';
    final isRecovery =
        _closureKind == 'left_against_medical_advice' || _closureKind == 'lwbs';
    final isExternal = _closureKind == 'external_transfer';
    return _ActionCard(
      title: strings.lookup('ed_trauma.continuity.closure_title'),
      children: [
        _Dropdown(
          fieldKey: const ValueKey('ed-continuity-closure-kind'),
          label: strings.lookup('ed_trauma.continuity.closure_kind'),
          value: _closureKind,
          values: const [
            'discharge',
            'left_against_medical_advice',
            'lwbs',
            'external_transfer',
            'death',
          ],
          onChanged: (value) => setState(() => _closureKind = value),
        ),
        if (!isDeath) ...[
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _followUpRequired,
            onChanged: (value) => setState(() => _followUpRequired = value),
            title: Text(
              strings.lookup('ed_trauma.continuity.follow_up_required'),
            ),
          ),
          _Input(
            controller: _followUpRequired ? _followUpPlanId : _noFollowUpReason,
            label: strings.lookup(
              _followUpRequired
                  ? 'ed_trauma.continuity.follow_up_plan_id'
                  : 'ed_trauma.continuity.no_follow_up_reason',
            ),
            numeric: _followUpRequired,
            maxLines: _followUpRequired ? 1 : 2,
          ),
          const SizedBox(height: 8),
          Text(
            strings.lookup('ed_trauma.continuity.patient_steps'),
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: 8),
          ..._nextSteps.indexed.map(
            (entry) => _NextStepEditor(
              key: ValueKey('ed-next-step-${entry.$1}'),
              index: entry.$1,
              draft: entry.$2,
              canRemove: _nextSteps.length > 1,
              onRemove: () => _removeNextStep(entry.$1),
            ),
          ),
          OutlinedButton.icon(
            key: const ValueKey('ed-continuity-add-step'),
            onPressed: _addNextStep,
            icon: const Icon(Icons.add),
            label: Text(
              strings.lookup('ed_trauma.continuity.add_patient_step'),
            ),
          ),
          const SizedBox(height: 8),
          _Input(
            controller: _medicationReconciliationId,
            label: strings.lookup(
              'ed_trauma.continuity.medication_reconciliation_id',
            ),
          ),
          const SizedBox(height: 8),
          _Input(
            controller: _medicationNotApplicableReason,
            label: strings.lookup(
              'ed_trauma.continuity.medication_not_applicable',
            ),
            maxLines: 2,
          ),
        ],
        if (isRecovery) ...[
          const SizedBox(height: 8),
          _Input(
            controller: _riskCode,
            label: strings.lookup('ed_trauma.continuity.risk_code'),
          ),
          const SizedBox(height: 8),
          _Input(
            controller: _riskSummary,
            label: strings.lookup('ed_trauma.continuity.risk_summary'),
            maxLines: 2,
          ),
        ],
        if (isExternal) ...[
          const SizedBox(height: 8),
          _Input(
            controller: _acceptedHandoffId,
            label: strings.lookup('ed_trauma.continuity.accepted_handoff_id'),
          ),
          const SizedBox(height: 8),
          _Input(
            controller: _receivingFacility,
            label: strings.lookup('ed_trauma.continuity.receiving_facility'),
          ),
          const SizedBox(height: 8),
          _Input(
            controller: _receivingFacilityReference,
            label: strings.lookup('ed_trauma.continuity.receiving_reference'),
          ),
          const SizedBox(height: 8),
          _Input(
            controller: _receivingConfirmedBy,
            label: strings.lookup(
              'ed_trauma.continuity.receiving_confirmed_by',
            ),
          ),
          const SizedBox(height: 8),
          _Input(
            controller: _clinicalSummaryType,
            label: strings.lookup('ed_trauma.continuity.summary_resource_type'),
          ),
          const SizedBox(height: 8),
          _Input(
            controller: _clinicalSummaryId,
            label: strings.lookup('ed_trauma.continuity.summary_resource_id'),
          ),
          const SizedBox(height: 8),
          _Input(
            controller: _ambulanceRequestId,
            label: strings.lookup('ed_trauma.continuity.ambulance_request_id'),
            numeric: true,
          ),
          const SizedBox(height: 8),
          _Input(
            controller: _transportReference,
            label: strings.lookup('ed_trauma.continuity.transport_reference'),
          ),
          const SizedBox(height: 6),
          Text(
            strings.lookup('ed_trauma.continuity.external_attestation'),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
        if (isDeath) ...[
          const SizedBox(height: 8),
          _Input(
            controller: _deathRecordId,
            label: strings.lookup('ed_trauma.continuity.death_record_id'),
            numeric: true,
          ),
          const SizedBox(height: 8),
          _Input(
            controller: _mlcRecordId,
            label: strings.lookup('ed_trauma.mlc_record_id'),
            numeric: true,
          ),
        ],
        const SizedBox(height: 8),
        _Dropdown(
          label: strings.lookup('ed_trauma.continuity.identity_status'),
          value: _identityStatus,
          values: const [
            'verified',
            'temporary_identity_retained',
            'merge_requested',
            'merged',
          ],
          onChanged: (value) => setState(() => _identityStatus = value),
        ),
        if (_identityStatus == 'temporary_identity_retained') ...[
          const SizedBox(height: 8),
          _Input(
            controller: _identityReason,
            label: strings.lookup('ed_trauma.continuity.identity_reason'),
            maxLines: 2,
          ),
        ],
        if (_identityStatus == 'merge_requested' ||
            _identityStatus == 'merged') ...[
          const SizedBox(height: 8),
          _Input(
            controller: _mergeRequestId,
            label: strings.lookup('ed_trauma.continuity.merge_request_id'),
            numeric: true,
          ),
        ],
        const SizedBox(height: 8),
        FilledButton.icon(
          key: const ValueKey('ed-continuity-record-closure'),
          onPressed: _busy ? null : _recordClosure,
          icon: const Icon(Icons.fact_check_outlined),
          label: Text(strings.lookup('ed_trauma.continuity.record_closure')),
        ),
      ],
    );
  }

  Widget _buildRecovery(AppStrings strings) {
    return _ActionCard(
      title: strings.lookup('ed_trauma.continuity.recovery_title'),
      children: [
        _Dropdown(
          fieldKey: const ValueKey('ed-continuity-recovery-kind'),
          label: strings.lookup('ed_trauma.continuity.recovery_kind'),
          value: _recoveryEventKind,
          values: const ['attempt', 'outcome'],
          onChanged: (value) => setState(() => _recoveryEventKind = value),
        ),
        const SizedBox(height: 8),
        _Dropdown(
          label: strings.lookup('ed_trauma.continuity.contact_channel'),
          value: _recoveryChannel,
          values: const [
            'phone',
            'sms',
            'email',
            'patient_portal',
            'in_person',
            'video',
            'other',
          ],
          onChanged: (value) => setState(() => _recoveryChannel = value),
        ),
        if (_recoveryEventKind == 'outcome') ...[
          const SizedBox(height: 8),
          _Input(
            controller: _recoveryOutcomeCode,
            label: strings.lookup('ed_trauma.continuity.outcome_code'),
          ),
        ],
        const SizedBox(height: 8),
        _Input(
          controller: _recoveryPatientSummary,
          label: strings.lookup('ed_trauma.continuity.patient_safe_summary'),
          maxLines: 2,
        ),
        const SizedBox(height: 8),
        _Input(
          controller: _recoveryStaffNotes,
          label: strings.lookup('ed_trauma.continuity.staff_notes'),
          maxLines: 2,
        ),
        const SizedBox(height: 8),
        FilledButton.icon(
          key: const ValueKey('ed-continuity-record-recovery'),
          onPressed: _busy ? null : _recordRecovery,
          icon: const Icon(Icons.contact_phone_outlined),
          label: Text(strings.lookup('ed_trauma.continuity.record_recovery')),
        ),
      ],
    );
  }
}

class _NextStepDraft {
  final label = TextEditingController();
  final explanation = TextEditingController();
  final dueDate = TextEditingController();
  final patientAction = TextEditingController();
  final routeToken = TextEditingController();
  String status = 'planned';

  Map<String, dynamic> toJson() => _stripEmpty({
    'label': _text(label),
    'explanation': _text(explanation),
    'due_date': _text(dueDate),
    'status': status,
    'patient_action': _text(patientAction),
    'route_token': _text(routeToken),
  });

  void dispose() {
    label.dispose();
    explanation.dispose();
    dueDate.dispose();
    patientAction.dispose();
    routeToken.dispose();
  }
}

class _NextStepEditor extends StatefulWidget {
  const _NextStepEditor({
    super.key,
    required this.index,
    required this.draft,
    required this.canRemove,
    required this.onRemove,
  });

  final int index;
  final _NextStepDraft draft;
  final bool canRemove;
  final VoidCallback onRemove;

  @override
  State<_NextStepEditor> createState() => _NextStepEditorState();
}

class _NextStepEditorState extends State<_NextStepEditor> {
  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    strings.format('ed_trauma.continuity.patient_step_number', {
                      'number': widget.index + 1,
                    }),
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
                IconButton(
                  tooltip: strings.actionDelete,
                  onPressed: widget.canRemove ? widget.onRemove : null,
                  icon: const Icon(Icons.delete_outline),
                ),
              ],
            ),
            _Input(
              controller: widget.draft.label,
              label: strings.lookup('ed_trauma.continuity.step_label'),
            ),
            const SizedBox(height: 8),
            _Input(
              controller: widget.draft.explanation,
              label: strings.lookup('ed_trauma.continuity.step_explanation'),
              maxLines: 2,
            ),
            const SizedBox(height: 8),
            _Input(
              controller: widget.draft.dueDate,
              label: strings.lookup('ed_trauma.continuity.step_due_date'),
            ),
            const SizedBox(height: 8),
            _Dropdown(
              label: strings.lookup('ed_trauma.continuity.step_status'),
              value: widget.draft.status,
              values: const [
                'planned',
                'open',
                'scheduled',
                'pending',
                'in_progress',
                'ready',
                'completed',
                'cancelled',
                'on_hold',
                'overdue',
              ],
              onChanged: (value) => setState(() => widget.draft.status = value),
            ),
            const SizedBox(height: 8),
            _Input(
              controller: widget.draft.patientAction,
              label: strings.lookup('ed_trauma.continuity.patient_action'),
              maxLines: 2,
            ),
            const SizedBox(height: 8),
            _Input(
              controller: widget.draft.routeToken,
              label: strings.lookup('ed_trauma.continuity.route_token'),
            ),
          ],
        ),
      ),
    );
  }
}

class _ContinuitySummary extends StatelessWidget {
  const _ContinuitySummary({required this.continuity});

  final Map<String, dynamic> continuity;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final checks = <(String, bool)>[
      (
        strings.lookup('ed_trauma.continuity.branch_complete'),
        continuity['branch_closure_complete'] == true,
      ),
      (
        strings.lookup('ed_trauma.continuity.handoff_accepted'),
        continuity['accepted_handoff_valid'] == true,
      ),
      (
        strings.lookup('ed_trauma.continuity.identity_complete'),
        continuity['identity_resolved_or_attested'] == true,
      ),
      if (continuity['visit_status'] == 'left_against_advice' ||
          continuity['visit_status'] == 'lwbs')
        (
          strings.lookup('ed_trauma.continuity.recovery_complete'),
          continuity['recovery_complete'] == true,
        ),
      if (continuity['visit_status'] == 'expired') ...[
        (
          strings.lookup('ed_trauma.continuity.death_certified'),
          continuity['death_certified'] == true,
        ),
        (
          strings.lookup('ed_trauma.continuity.mortuary_recorded'),
          continuity['mortuary_custody_recorded'] == true,
        ),
        (
          strings.lookup('ed_trauma.continuity.mlc_complete'),
          continuity['mlc_complete'] == true,
        ),
      ],
    ];
    return Card(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              strings.format('ed_trauma.continuity.visit_status', {
                'status': _humanize('${continuity['visit_status'] ?? ''}'),
                'disposition': _humanize('${continuity['disposition'] ?? '-'}'),
              }),
              style: Theme.of(context).textTheme.titleSmall,
            ),
            if (continuity['bed_pending'] == true) ...[
              const SizedBox(height: 6),
              Text(
                strings.lookup('ed_trauma.continuity.bed_pending'),
                style: TextStyle(
                  color: Theme.of(context).colorScheme.error,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: checks
                  .map(
                    (check) => Chip(
                      avatar: Icon(
                        check.$2
                            ? Icons.check_circle_outline
                            : Icons.pending_outlined,
                        size: 18,
                        color: check.$2
                            ? Colors.green
                            : Theme.of(context).colorScheme.error,
                      ),
                      label: Text(check.$1),
                    ),
                  )
                  .toList(growable: false),
            ),
          ],
        ),
      ),
    );
  }
}

class _EvidenceHistory extends StatelessWidget {
  const _EvidenceHistory({
    required this.title,
    required this.rows,
    required this.primaryField,
    required this.secondaryField,
  });

  final String title;
  final List<Map<String, dynamic>> rows;
  final String primaryField;
  final String secondaryField;

  @override
  Widget build(BuildContext context) {
    return _ActionCard(
      title: title,
      children: rows
          .map(
            (row) => ListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              leading: const Icon(Icons.history),
              title: Text(_humanize('${row[primaryField] ?? ''}')),
              subtitle: Text('${row[secondaryField] ?? ''}'),
              trailing: row['evidence_revision'] == null
                  ? null
                  : Text('#${row['evidence_revision']}'),
            ),
          )
          .toList(growable: false),
    );
  }
}

class _ContinuitySection extends StatelessWidget {
  const _ContinuitySection({
    required this.title,
    required this.icon,
    required this.children,
  });

  final String title;
  final IconData icon;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(icon),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    title,
                    style: Theme.of(context).textTheme.titleMedium
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            ...children,
          ],
        ),
      ),
    );
  }
}

class _ActionCard extends StatelessWidget {
  const _ActionCard({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Card.outlined(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              title,
              style: Theme.of(context).textTheme.titleSmall
                  ?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 10),
            ...children,
          ],
        ),
      ),
    );
  }
}

class _Input extends StatelessWidget {
  const _Input({
    required this.controller,
    required this.label,
    this.numeric = false,
    this.maxLines = 1,
  });

  final TextEditingController controller;
  final String label;
  final bool numeric;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      keyboardType: numeric ? TextInputType.number : TextInputType.text,
      maxLines: maxLines,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
    );
  }
}

class _Dropdown extends StatelessWidget {
  const _Dropdown({
    this.fieldKey,
    required this.label,
    required this.value,
    required this.values,
    required this.onChanged,
  });

  final Key? fieldKey;
  final String label;
  final String value;
  final List<String> values;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return DropdownButtonFormField<String>(
      key: fieldKey,
      initialValue: value,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      items: values
          .map(
            (item) =>
                DropdownMenuItem(value: item, child: Text(_humanize(item))),
          )
          .toList(growable: false),
      onChanged: (next) {
        if (next != null) onChanged(next);
      },
    );
  }
}

class _StatusMessage extends StatelessWidget {
  const _StatusMessage({required this.message, required this.isError});

  final String message;
  final bool isError;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: isError ? scheme.errorContainer : scheme.secondaryContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Text(
          message,
          style: TextStyle(
            color: isError
                ? scheme.onErrorContainer
                : scheme.onSecondaryContainer,
          ),
        ),
      ),
    );
  }
}

bool _terminalStatus(String status) => const {
  'admitted',
  'discharged',
  'transferred',
  'left_against_advice',
  'lwbs',
  'expired',
}.contains(status);

String? _text(TextEditingController controller) {
  final value = controller.text.trim();
  return value.isEmpty ? null : value;
}

int? _int(TextEditingController controller) =>
    int.tryParse(controller.text.trim());

Map<String, dynamic> _stripEmpty(Map<String, dynamic> values) =>
    Map<String, dynamic>.fromEntries(
      values.entries.where((entry) {
        final value = entry.value;
        if (value == null) return false;
        if (value is String && value.trim().isEmpty) return false;
        return true;
      }),
    );

List<Map<String, dynamic>> _mapList(Object? value) {
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map((row) => Map<String, dynamic>.from(row))
      .toList(growable: false);
}

String _humanize(String value) {
  if (value.isEmpty) return '-';
  return value
      .split('_')
      .where((part) => part.isNotEmpty)
      .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
      .join(' ');
}
