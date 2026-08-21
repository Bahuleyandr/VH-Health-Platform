import 'package:flutter/material.dart';

import '../../../core/models/care_pathway_work_models.dart';
import '../../../l10n/app_strings.dart';

class OpInpatientTransferInput {
  const OpInpatientTransferInput({
    required this.recipientUid,
    required this.reason,
  });

  final String recipientUid;
  final String reason;
}

class OpInpatientTransferDialog extends StatefulWidget {
  const OpInpatientTransferDialog({super.key, required this.recipients});

  final List<Map<String, dynamic>> recipients;

  @override
  State<OpInpatientTransferDialog> createState() =>
      _OpInpatientTransferDialogState();
}

class _OpInpatientTransferDialogState extends State<OpInpatientTransferDialog> {
  final _formKey = GlobalKey<FormState>();
  final _reasonController = TextEditingController();
  String? _recipientUid;

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  void _submit() {
    if (_formKey.currentState?.validate() != true) return;
    Navigator.pop(
      context,
      OpInpatientTransferInput(
        recipientUid: _recipientUid!,
        reason: _reasonController.text.trim(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return AlertDialog(
      title: Text(
        s.lookup('s4.lib.op_doctor_workspace.request_inpatient_transfer'),
      ),
      content: SizedBox(
        width: 520,
        child: Form(
          key: _formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                s.lookup(
                  's4.lib.op_doctor_workspace.transfer_current_owner_explanation',
                ),
              ),
              const SizedBox(height: 14),
              DropdownButtonFormField<String>(
                key: const Key('op-transfer-recipient'),
                initialValue: _recipientUid,
                isExpanded: true,
                decoration: InputDecoration(
                  labelText: s.lookup(
                    's4.lib.op_doctor_workspace.inpatient_recipient',
                  ),
                  border: const OutlineInputBorder(),
                ),
                items: widget.recipients
                    .map((recipient) {
                      final uid = _staffText(recipient, const [
                        'uid',
                        'user_uid',
                        'staff_uid',
                      ]);
                      final name = _staffText(recipient, const [
                        'name',
                        'full_name',
                        'fullName',
                      ]);
                      final role = _staffText(recipient, const ['role']);
                      final label = [
                        name.isEmpty ? uid : name,
                        role.replaceAll('_', ' '),
                      ].where((part) => part.isNotEmpty).join(' · ');
                      return DropdownMenuItem(value: uid, child: Text(label));
                    })
                    .toList(growable: false),
                onChanged: (value) => setState(() => _recipientUid = value),
                validator: (value) => value?.isNotEmpty == true
                    ? null
                    : s.lookup(
                        's4.lib.op_doctor_workspace.inpatient_recipient_required',
                      ),
              ),
              const SizedBox(height: 14),
              TextFormField(
                key: const Key('op-transfer-reason'),
                controller: _reasonController,
                minLines: 3,
                maxLines: 5,
                maxLength: 1200,
                decoration: InputDecoration(
                  labelText: s.lookup(
                    's4.lib.op_doctor_workspace.transfer_reason',
                  ),
                  border: const OutlineInputBorder(),
                ),
                validator: (value) => value?.trim().isNotEmpty == true
                    ? null
                    : s.lookup(
                        's4.lib.op_doctor_workspace.transfer_reason_required',
                      ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(s.lookup('action.cancel')),
        ),
        FilledButton(
          key: const Key('op-transfer-submit'),
          onPressed: _submit,
          child: Text(
            s.lookup('s4.lib.op_doctor_workspace.send_transfer_request'),
          ),
        ),
      ],
    );
  }
}

class OpClosureEvidenceDialog extends StatefulWidget {
  const OpClosureEvidenceDialog({super.key, required this.work});

  final AppointmentPathwayWork work;

  @override
  State<OpClosureEvidenceDialog> createState() =>
      _OpClosureEvidenceDialogState();
}

class _OpClosureEvidenceDialogState extends State<OpClosureEvidenceDialog> {
  static const _statuses = [
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
  ];

  final _formKey = GlobalKey<FormState>();
  final _acceptedHandoffController = TextEditingController();
  final List<_PatientNextStepDraft> _steps = [_PatientNextStepDraft()];
  bool _followUpRequired = false;
  int? _followUpPlanId;
  String _closureBasis = 'all_required_work_completed';

  @override
  void initState() {
    super.initState();
    final existing = widget.work.closureEvidence;
    if (existing != null) {
      _followUpRequired = existing.followUpRequired;
      _followUpPlanId = int.tryParse(existing.followUpPlanId ?? '');
      _closureBasis = existing.closureBasis.isEmpty
          ? _closureBasis
          : existing.closureBasis;
      _acceptedHandoffController.text = existing.acceptedHandoffId ?? '';
      if (existing.patientNextSteps.isNotEmpty) {
        _steps.first.dispose();
        _steps
          ..clear()
          ..addAll(
            existing.patientNextSteps.map(_PatientNextStepDraft.fromModel),
          );
      }
    } else if (widget.work.acceptedHandoffIds.isNotEmpty) {
      _acceptedHandoffController.text = widget.work.acceptedHandoffIds.first;
    }
  }

  @override
  void dispose() {
    _acceptedHandoffController.dispose();
    for (final step in _steps) {
      step.dispose();
    }
    super.dispose();
  }

  void _addStep() {
    if (_steps.length >= 32) return;
    setState(() => _steps.add(_PatientNextStepDraft()));
  }

  void _removeStep(int index) {
    if (_steps.length == 1) return;
    final removed = _steps.removeAt(index);
    removed.dispose();
    setState(() {});
  }

  void _submit() {
    if (_formKey.currentState?.validate() != true) return;
    Navigator.pop(
      context,
      OpClosureEvidenceCommand(
        followUpRequired: _followUpRequired,
        followUpPlanId: _followUpRequired ? _followUpPlanId : null,
        patientSafeNextSteps: _steps
            .map((step) => step.toCommand())
            .toList(growable: false),
        closureBasis: _closureBasis,
        acceptedHandoffId: _closureBasis == 'accepted_transfer'
            ? _acceptedHandoffController.text.trim()
            : null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final followUpPlanIds = widget.work.followUpPlanIds;
    return AlertDialog(
      title: Text(
        s.lookup('s4.lib.op_doctor_workspace.closure_evidence_title'),
      ),
      content: SizedBox(
        width: 640,
        child: SingleChildScrollView(
          child: Form(
            key: _formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  s.lookup(
                    's4.lib.op_doctor_workspace.closure_current_owner_explanation',
                  ),
                ),
                const SizedBox(height: 14),
                DropdownButtonFormField<String>(
                  key: const Key('op-closure-basis'),
                  initialValue: _closureBasis,
                  isExpanded: true,
                  decoration: InputDecoration(
                    labelText: s.lookup(
                      's4.lib.op_doctor_workspace.closure_basis',
                    ),
                    border: const OutlineInputBorder(),
                  ),
                  items: [
                    DropdownMenuItem(
                      value: 'all_required_work_completed',
                      child: Text(
                        s.lookup(
                          's4.lib.op_doctor_workspace.closure_basis_completed',
                        ),
                      ),
                    ),
                    DropdownMenuItem(
                      value: 'named_ownership_accepted',
                      child: Text(
                        s.lookup(
                          's4.lib.op_doctor_workspace.closure_basis_named_owner',
                        ),
                      ),
                    ),
                    DropdownMenuItem(
                      value: 'accepted_transfer',
                      child: Text(
                        s.lookup(
                          's4.lib.op_doctor_workspace.closure_basis_transfer',
                        ),
                      ),
                    ),
                  ],
                  onChanged: (value) {
                    if (value == null) return;
                    setState(() => _closureBasis = value);
                  },
                ),
                if (_closureBasis == 'accepted_transfer') ...[
                  const SizedBox(height: 14),
                  TextFormField(
                    key: const Key('op-closure-accepted-handoff'),
                    controller: _acceptedHandoffController,
                    decoration: InputDecoration(
                      labelText: s.lookup(
                        's4.lib.op_doctor_workspace.accepted_handoff_id',
                      ),
                      helperText: s.lookup(
                        's4.lib.op_doctor_workspace.accepted_handoff_helper',
                      ),
                      border: const OutlineInputBorder(),
                    ),
                    validator: (value) => value?.trim().isNotEmpty == true
                        ? null
                        : s.lookup(
                            's4.lib.op_doctor_workspace.accepted_handoff_required',
                          ),
                  ),
                ],
                const SizedBox(height: 6),
                SwitchListTile(
                  key: const Key('op-closure-follow-up-required'),
                  contentPadding: EdgeInsets.zero,
                  title: Text(
                    s.lookup('s4.lib.op_doctor_workspace.follow_up_required'),
                  ),
                  subtitle: Text(
                    s.lookup(
                      's4.lib.op_doctor_workspace.follow_up_link_explanation',
                    ),
                  ),
                  value: _followUpRequired,
                  onChanged: (value) {
                    setState(() {
                      _followUpRequired = value;
                      if (!value) _followUpPlanId = null;
                    });
                  },
                ),
                if (_followUpRequired) ...[
                  const SizedBox(height: 6),
                  DropdownButtonFormField<int>(
                    key: const Key('op-closure-follow-up-plan'),
                    initialValue: followUpPlanIds.contains(_followUpPlanId)
                        ? _followUpPlanId
                        : null,
                    isExpanded: true,
                    decoration: InputDecoration(
                      labelText: s.lookup(
                        's4.lib.op_doctor_workspace.follow_up_plan_link',
                      ),
                      helperText: followUpPlanIds.isEmpty
                          ? s.lookup(
                              's4.lib.op_doctor_workspace.no_follow_up_plan_available',
                            )
                          : null,
                      border: const OutlineInputBorder(),
                    ),
                    items: followUpPlanIds
                        .map(
                          (id) => DropdownMenuItem(
                            value: id,
                            child: Text(
                              s.format(
                                's4.dynamic.op_doctor_workspace.follow_up_plan',
                                {'id': id},
                              ),
                            ),
                          ),
                        )
                        .toList(growable: false),
                    onChanged: (value) =>
                        setState(() => _followUpPlanId = value),
                    validator: (value) => value != null
                        ? null
                        : s.lookup(
                            's4.lib.op_doctor_workspace.follow_up_plan_required',
                          ),
                  ),
                ],
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        s.lookup(
                          's4.lib.op_doctor_workspace.patient_safe_next_steps',
                        ),
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                    ),
                    TextButton.icon(
                      key: const Key('op-closure-add-next-step'),
                      onPressed: _steps.length < 32 ? _addStep : null,
                      icon: const Icon(Icons.add),
                      label: Text(
                        s.lookup('s4.lib.op_doctor_workspace.add_next_step'),
                      ),
                    ),
                  ],
                ),
                ..._steps.asMap().entries.map(
                  (entry) => Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: _PatientNextStepFields(
                      key: ValueKey(entry.value),
                      draft: entry.value,
                      index: entry.key,
                      statuses: _statuses,
                      canRemove: _steps.length > 1,
                      onRemove: () => _removeStep(entry.key),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(s.lookup('action.cancel')),
        ),
        FilledButton(
          key: const Key('op-closure-submit'),
          onPressed: _submit,
          child: Text(
            s.lookup('s4.lib.op_doctor_workspace.record_closure_evidence'),
          ),
        ),
      ],
    );
  }
}

class _PatientNextStepFields extends StatelessWidget {
  const _PatientNextStepFields({
    super.key,
    required this.draft,
    required this.index,
    required this.statuses,
    required this.canRemove,
    required this.onRemove,
  });

  final _PatientNextStepDraft draft;
  final int index;
  final List<String> statuses;
  final bool canRemove;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).dividerColor),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  s.format('s4.dynamic.op_doctor_workspace.next_step', {
                    'number': index + 1,
                  }),
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
              IconButton(
                tooltip: s.lookup(
                  's4.lib.op_doctor_workspace.remove_next_step',
                ),
                onPressed: canRemove ? onRemove : null,
                icon: const Icon(Icons.delete_outline),
              ),
            ],
          ),
          TextFormField(
            key: Key('op-closure-next-step-label-$index'),
            controller: draft.label,
            maxLength: 180,
            decoration: InputDecoration(
              labelText: s.lookup('s4.lib.op_doctor_workspace.next_step_label'),
              border: const OutlineInputBorder(),
            ),
            validator: (value) => value?.trim().isNotEmpty == true
                ? null
                : s.lookup(
                    's4.lib.op_doctor_workspace.next_step_label_required',
                  ),
          ),
          const SizedBox(height: 10),
          TextFormField(
            controller: draft.explanation,
            minLines: 2,
            maxLines: 3,
            maxLength: 1200,
            decoration: InputDecoration(
              labelText: s.lookup(
                's4.lib.op_doctor_workspace.patient_safe_explanation',
              ),
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          TextFormField(
            controller: draft.patientAction,
            minLines: 1,
            maxLines: 2,
            maxLength: 500,
            decoration: InputDecoration(
              labelText: s.lookup('s4.lib.op_doctor_workspace.patient_action'),
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: TextFormField(
                  controller: draft.dueDate,
                  maxLength: 10,
                  decoration: InputDecoration(
                    labelText: s.lookup(
                      's4.lib.op_doctor_workspace.due_date_optional',
                    ),
                    hintText: s.lookup(
                      's4.lib.op_doctor_workspace.due_date_format',
                    ),
                    border: const OutlineInputBorder(),
                  ),
                  validator: (value) {
                    final text = value?.trim() ?? '';
                    if (text.isEmpty) return null;
                    final validShape = RegExp(r'^\d{4}-\d{2}-\d{2}$')
                        .hasMatch(text);
                    final parsed = DateTime.tryParse('${text}T00:00:00Z');
                    return validShape && parsed != null
                        ? null
                        : s.lookup(
                            's4.lib.op_doctor_workspace.due_date_invalid',
                          );
                  },
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: statuses.contains(draft.status)
                      ? draft.status
                      : 'planned',
                  decoration: InputDecoration(
                    labelText: s.lookup(
                      's4.lib.op_doctor_workspace.next_step_status',
                    ),
                    border: const OutlineInputBorder(),
                  ),
                  items: statuses
                      .map(
                        (status) => DropdownMenuItem(
                          value: status,
                          child: Text(status.replaceAll('_', ' ')),
                        ),
                      )
                      .toList(growable: false),
                  onChanged: (value) => draft.status = value ?? 'planned',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _PatientNextStepDraft {
  _PatientNextStepDraft({
    String label = '',
    String explanation = '',
    String dueDate = '',
    this.status = 'planned',
    String patientAction = '',
  }) : label = TextEditingController(text: label),
       explanation = TextEditingController(text: explanation),
       dueDate = TextEditingController(text: dueDate),
       patientAction = TextEditingController(text: patientAction);

  factory _PatientNextStepDraft.fromModel(PatientSafeNextStep step) {
    return _PatientNextStepDraft(
      label: step.label,
      explanation: step.explanation ?? '',
      dueDate: step.dueDate ?? '',
      status: step.status ?? 'planned',
      patientAction: step.patientAction ?? '',
    );
  }

  final TextEditingController label;
  final TextEditingController explanation;
  final TextEditingController dueDate;
  final TextEditingController patientAction;
  String status;

  PatientSafeNextStepCommand toCommand() {
    return PatientSafeNextStepCommand(
      label: label.text,
      explanation: explanation.text,
      dueDate: dueDate.text,
      status: status,
      patientAction: patientAction.text,
    );
  }

  void dispose() {
    label.dispose();
    explanation.dispose();
    dueDate.dispose();
    patientAction.dispose();
  }
}

String _staffText(Map<String, dynamic> row, List<String> keys) {
  for (final key in keys) {
    final value = row[key]?.toString().trim();
    if (value != null && value.isNotEmpty && value != 'null') return value;
  }
  return '';
}
