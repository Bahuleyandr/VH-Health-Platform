import 'dart:async';

import 'package:flutter/material.dart';
import 'package:vhhealth_core/api/vhhealth_api.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

class PaperReconciliationWorkbenchScreen extends StatefulWidget {
  const PaperReconciliationWorkbenchScreen({
    super.key,
    this.client = const ClinicalContinuityReconciliationClient(),
  });

  final ClinicalContinuityReconciliationClient client;

  @override
  State<PaperReconciliationWorkbenchScreen> createState() =>
      _PaperReconciliationWorkbenchScreenState();
}

class _PaperReconciliationWorkbenchScreenState
    extends State<PaperReconciliationWorkbenchScreen> {
  ClinicalContinuityWorkbench? _workbench;
  String? _error;
  bool _loading = true;
  String? _incidentId;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final workbench = await widget.client.loadWorkbench();
      if (!mounted) return;
      final available = workbench.incidents;
      final selectedStillExists = available.any(
        (incident) => incident.id == _incidentId,
      );
      setState(() {
        _workbench = workbench;
        _incidentId = selectedStillExists
            ? _incidentId
            : available
                      .where(
                        (incident) =>
                            incident.lifecycleState !=
                            ClinicalContinuityIncidentState.closed,
                      )
                      .firstOrNull
                      ?.id ??
                  available.firstOrNull?.id;
        _loading = false;
      });
    } on ClinicalContinuityReconciliationException catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = error.code ?? error.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'CONTINUITY_RECONCILIATION_UNAVAILABLE';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return StaffScaffold(
      title: strings.lookup('continuity.reconciliation.title'),
      actions: [
        IconButton(
          tooltip: strings.lookup('continuity.action.refresh'),
          onPressed: _loading ? null : _load,
          icon: const Icon(Icons.refresh),
        ),
      ],
      body: _body(context),
    );
  }

  Widget _body(BuildContext context) {
    final strings = AppStrings.of(context);
    if (_loading) {
      return Center(
        child: Semantics(
          label: strings.lookup('continuity.reconciliation.loading'),
          child: const CircularProgressIndicator(),
        ),
      );
    }
    if (_error != null) {
      return _UnavailablePanel(code: _error!, onRetry: _load);
    }
    final workbench = _workbench;
    if (workbench == null || workbench.incidents.isEmpty) {
      return Center(
        child: Text(strings.lookup('continuity.reconciliation.no_incidents')),
      );
    }
    final incidentId = _incidentId ?? workbench.incidents.first.id;
    final paperItems = workbench.paperItems
        .where((item) => item.incidentId == incidentId)
        .toList(growable: false);
    final queueItems = workbench.reconciliationItems
        .where((item) => item.incidentId == incidentId)
        .toList(growable: false);
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        key: const Key('paper-reconciliation-workbench'),
        padding: const EdgeInsets.all(16),
        children: [
          const _InertGateBanner(),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            key: const Key('continuity-incident-selector'),
            initialValue: incidentId,
            isExpanded: true,
            decoration: InputDecoration(
              labelText: strings.lookup('continuity.reconciliation.incident'),
              border: const OutlineInputBorder(),
            ),
            items: workbench.incidents
                .map(
                  (incident) => DropdownMenuItem(
                    value: incident.id,
                    child: Text(
                      '${incident.id.substring(0, 8)} · '
                      '${_label(incident.lifecycleState.value)} · '
                      'v${incident.version}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                )
                .toList(growable: false),
            onChanged: (value) => setState(() => _incidentId = value),
          ),
          const SizedBox(height: 16),
          _SummaryStrip(
            paperCount: paperItems.length,
            openQueueCount: queueItems
                .where(
                  (item) =>
                      item.disposition ==
                          ClinicalContinuityReconciliationItemDisposition
                              .open ||
                      item.disposition ==
                          ClinicalContinuityReconciliationItemDisposition
                              .inProgress,
                )
                .length,
            safetyCount: queueItems.where((item) => item.safetyCritical).length,
          ),
          const SizedBox(height: 20),
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 12,
            runSpacing: 8,
            children: [
              Text(
                strings.lookup('continuity.reconciliation.paper_section'),
                style: Theme.of(context).textTheme.titleLarge,
              ),
              FilledButton.icon(
                key: const Key('record-paper-fact'),
                onPressed: () => _recordPaperFact(
                  workbench: workbench,
                  incidentId: incidentId,
                ),
                icon: const Icon(Icons.post_add_outlined),
                label: Text(
                  strings.lookup('continuity.reconciliation.record_fact'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (paperItems.isEmpty)
            _EmptyCard(
              message: strings.lookup(
                'continuity.reconciliation.no_paper_items',
              ),
            )
          else
            ...paperItems.map((item) => _PaperItemCard(item: item)),
          const SizedBox(height: 20),
          Text(
            strings.lookup('continuity.reconciliation.queue_section'),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          if (queueItems.isEmpty)
            _EmptyCard(
              message: strings.lookup(
                'continuity.reconciliation.no_queue_items',
              ),
            )
          else
            ...queueItems.map(
              (item) => _QueueItemCard(
                item: item,
                onDecide: _isOpen(item) ? () => _decide(item) : null,
              ),
            ),
        ],
      ),
    );
  }

  bool _isOpen(ClinicalContinuityReconciliationItem item) =>
      item.disposition ==
          ClinicalContinuityReconciliationItemDisposition.open ||
      item.disposition ==
          ClinicalContinuityReconciliationItemDisposition.inProgress;

  Future<void> _recordPaperFact({
    required ClinicalContinuityWorkbench workbench,
    required String incidentId,
  }) async {
    final recorded = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => _PaperFactDialog(
        client: widget.client,
        workbench: workbench,
        incidentId: incidentId,
      ),
    );
    if (recorded == true) await _load();
  }

  Future<void> _decide(ClinicalContinuityReconciliationItem item) async {
    final decided = await showDialog<bool>(
      context: context,
      builder: (context) =>
          _ReconciliationDecisionDialog(client: widget.client, item: item),
    );
    if (decided == true) await _load();
  }
}

class _UnavailablePanel extends StatelessWidget {
  const _UnavailablePanel({required this.code, required this.onRetry});

  final String code;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return Center(
      child: Semantics(
        liveRegion: true,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 620),
          child: Card(
            margin: const EdgeInsets.all(24),
            color: Theme.of(context).colorScheme.errorContainer,
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.lock_clock_outlined, size: 48),
                  const SizedBox(height: 12),
                  Text(
                    strings.lookup('continuity.reconciliation.unavailable'),
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 8),
                  SelectableText(code, textAlign: TextAlign.center),
                  const SizedBox(height: 16),
                  OutlinedButton.icon(
                    onPressed: onRetry,
                    icon: const Icon(Icons.refresh),
                    label: Text(strings.lookup('action.retry')),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _InertGateBanner extends StatelessWidget {
  const _InertGateBanner();

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return Semantics(
      label: strings.lookup('continuity.reconciliation.inert_banner'),
      child: Card(
        color: const Color(0xfffff3cd),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.verified_user_outlined),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  strings.lookup('continuity.reconciliation.inert_banner'),
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SummaryStrip extends StatelessWidget {
  const _SummaryStrip({
    required this.paperCount,
    required this.openQueueCount,
    required this.safetyCount,
  });

  final int paperCount;
  final int openQueueCount;
  final int safetyCount;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return Wrap(
      spacing: 12,
      runSpacing: 12,
      children: [
        _Metric(
          label: strings.lookup('continuity.reconciliation.paper_count'),
          value: paperCount,
        ),
        _Metric(
          label: strings.lookup('continuity.reconciliation.open_count'),
          value: openQueueCount,
        ),
        _Metric(
          label: strings.lookup('continuity.reconciliation.safety_count'),
          value: safetyCount,
        ),
      ],
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) => Semantics(
    label: '$label: $value',
    child: Chip(label: Text('$label: $value')),
  );
}

class _PaperItemCard extends StatelessWidget {
  const _PaperItemCard({required this.item});

  final ClinicalContinuityPaperItem item;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return Card(
      child: ListTile(
        leading: const Icon(Icons.description_outlined),
        title: Text(item.paperItemId),
        subtitle: Text(
          '${_label(item.itemKind.value)} · '
          '${item.actionId ?? strings.lookup('continuity.reconciliation.no_action')} · '
          'v${item.version}',
        ),
        trailing: Chip(
          label: Text(_label(item.reconciliationDisposition.value)),
        ),
      ),
    );
  }
}

class _QueueItemCard extends StatelessWidget {
  const _QueueItemCard({required this.item, this.onDecide});

  final ClinicalContinuityReconciliationItem item;
  final VoidCallback? onDecide;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return Card(
      child: ListTile(
        leading: Icon(
          item.safetyCritical
              ? Icons.health_and_safety_outlined
              : Icons.assignment_outlined,
          color: item.safetyCritical
              ? Theme.of(context).colorScheme.error
              : null,
        ),
        title: Text('${_label(item.queueType.value)} · ${item.reasonCode}'),
        subtitle: Text(
          '${strings.lookup('continuity.reconciliation.owner')}: '
          '${item.assignedToUid ?? item.ownerPrincipal} · '
          '${strings.lookup('continuity.reconciliation.task')}: '
          '${item.taskId ?? '-'} · ${_label(item.disposition.value)}',
        ),
        trailing: onDecide == null
            ? null
            : TextButton(
                key: Key('decide-${item.id}'),
                onPressed: onDecide,
                child: Text(strings.lookup('continuity.reconciliation.decide')),
              ),
      ),
    );
  }
}

class _EmptyCard extends StatelessWidget {
  const _EmptyCard({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Center(child: Text(message)),
    ),
  );
}

enum _PaperAction { medication, specimen, transfusion }

extension on _PaperAction {
  ClinicalContinuityRegisterPaperItemRequestItemKind get itemKind =>
      switch (this) {
        _PaperAction.medication =>
          ClinicalContinuityRegisterPaperItemRequestItemKind
              .medicationAdministration,
        _PaperAction.specimen =>
          ClinicalContinuityRegisterPaperItemRequestItemKind.specimenCollection,
        _PaperAction.transfusion =>
          ClinicalContinuityRegisterPaperItemRequestItemKind
              .transfusionVerification,
      };

  ClinicalContinuityRegisterPaperItemRequestActionId get actionId =>
      switch (this) {
        _PaperAction.medication =>
          ClinicalContinuityRegisterPaperItemRequestActionId
              .marAdministrationBackfill,
        _PaperAction.specimen =>
          ClinicalContinuityRegisterPaperItemRequestActionId
              .labSpecimenCollectionBackfill,
        _PaperAction.transfusion =>
          ClinicalContinuityRegisterPaperItemRequestActionId
              .bloodTransfusionVerificationBackfill,
      };

  String get value => actionId.value!;
}

class _PaperFactDialog extends StatefulWidget {
  const _PaperFactDialog({
    required this.client,
    required this.workbench,
    required this.incidentId,
  });

  final ClinicalContinuityReconciliationClient client;
  final ClinicalContinuityWorkbench workbench;
  final String incidentId;

  @override
  State<_PaperFactDialog> createState() => _PaperFactDialogState();
}

class _PaperFactDialogState extends State<_PaperFactDialog> {
  final _formKey = GlobalKey<FormState>();
  final _paperItem = TextEditingController();
  final _actorUid = TextEditingController();
  final _actorRole = TextEditingController();
  final _patientUid = TextEditingController();
  final _encounterId = TextEditingController();
  final _occurredAt = TextEditingController();
  final _evidenceHash = TextEditingController();
  final _domainId = TextEditingController();
  final _barcode = TextEditingController();
  final _secondDomainId = TextEditingController();
  final _firstVerifier = TextEditingController();
  final _secondVerifier = TextEditingController();
  final _notes = TextEditingController();
  _PaperAction _action = _PaperAction.medication;
  bool _unitMatch = false;
  bool _patientMatch = false;
  bool _groupCompatible = false;
  bool _expiryOk = false;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _occurredAt.text = DateTime.now().toUtc().toIso8601String();
  }

  @override
  void dispose() {
    for (final controller in [
      _paperItem,
      _actorUid,
      _actorRole,
      _patientUid,
      _encounterId,
      _occurredAt,
      _evidenceHash,
      _domainId,
      _barcode,
      _secondDomainId,
      _firstVerifier,
      _secondVerifier,
      _notes,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return AlertDialog(
      title: Text(strings.lookup('continuity.reconciliation.record_fact')),
      content: SizedBox(
        width: 720,
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButtonFormField<_PaperAction>(
                  key: const Key('paper-action'),
                  initialValue: _action,
                  decoration: _decoration(
                    strings.lookup('continuity.reconciliation.action'),
                  ),
                  items: _PaperAction.values
                      .map(
                        (action) => DropdownMenuItem(
                          value: action,
                          child: Text(_label(action.value)),
                        ),
                      )
                      .toList(growable: false),
                  onChanged: (action) => setState(
                    () => _action = action ?? _PaperAction.medication,
                  ),
                ),
                const SizedBox(height: 12),
                _field(
                  _paperItem,
                  strings.lookup('continuity.reconciliation.paper_id'),
                ),
                _field(
                  _patientUid,
                  strings.lookup('continuity.reconciliation.patient_uid'),
                  uuid: true,
                ),
                _field(
                  _encounterId,
                  strings.lookup('continuity.reconciliation.encounter_id'),
                  optional: true,
                  uuid: true,
                ),
                _field(
                  _actorUid,
                  strings.lookup('continuity.reconciliation.original_actor'),
                  uuid: true,
                ),
                _field(
                  _actorRole,
                  strings.lookup('continuity.reconciliation.original_role'),
                ),
                _field(
                  _occurredAt,
                  strings.lookup('continuity.reconciliation.occurred_at'),
                  timestamp: true,
                ),
                _field(
                  _evidenceHash,
                  strings.lookup('continuity.reconciliation.evidence_hash'),
                  hash: true,
                ),
                ..._actionFields(strings),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Semantics(
                      liveRegion: true,
                      child: Text(
                        _error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
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
          onPressed: _saving ? null : () => Navigator.pop(context, false),
          child: Text(strings.lookup('action.cancel')),
        ),
        FilledButton(
          key: const Key('submit-paper-fact'),
          onPressed: _saving ? null : _submit,
          child: _saving
              ? const SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text(strings.lookup('action.submit')),
        ),
      ],
    );
  }

  List<Widget> _actionFields(AppStrings strings) {
    if (_action == _PaperAction.medication) {
      return [
        _field(
          _domainId,
          strings.lookup('continuity.reconciliation.medication_id'),
          integer: true,
        ),
        _field(
          _notes,
          strings.lookup('continuity.reconciliation.notes'),
          optional: true,
        ),
      ];
    }
    if (_action == _PaperAction.specimen) {
      return [
        _field(
          _domainId,
          strings.lookup('continuity.reconciliation.investigation_id'),
          integer: true,
        ),
        _field(
          _barcode,
          strings.lookup('continuity.reconciliation.specimen_barcode'),
        ),
        _field(
          _notes,
          strings.lookup('continuity.reconciliation.notes'),
          optional: true,
        ),
      ];
    }
    return [
      _field(
        _domainId,
        strings.lookup('continuity.reconciliation.blood_request_id'),
        integer: true,
      ),
      _field(
        _secondDomainId,
        strings.lookup('continuity.reconciliation.blood_unit_id'),
        integer: true,
      ),
      _field(
        _barcode,
        strings.lookup('continuity.reconciliation.scanned_unit'),
      ),
      _field(
        _firstVerifier,
        strings.lookup('continuity.reconciliation.first_verifier'),
        uuid: true,
      ),
      _field(
        _secondVerifier,
        strings.lookup('continuity.reconciliation.second_verifier'),
        uuid: true,
      ),
      CheckboxListTile(
        value: _unitMatch,
        onChanged: (value) => setState(() => _unitMatch = value ?? false),
        title: Text(strings.lookup('continuity.reconciliation.unit_match')),
      ),
      CheckboxListTile(
        value: _patientMatch,
        onChanged: (value) => setState(() => _patientMatch = value ?? false),
        title: Text(strings.lookup('continuity.reconciliation.patient_match')),
      ),
      CheckboxListTile(
        value: _groupCompatible,
        onChanged: (value) => setState(() => _groupCompatible = value ?? false),
        title: Text(
          strings.lookup('continuity.reconciliation.group_compatible'),
        ),
      ),
      CheckboxListTile(
        value: _expiryOk,
        onChanged: (value) => setState(() => _expiryOk = value ?? false),
        title: Text(strings.lookup('continuity.reconciliation.expiry_ok')),
      ),
      _field(
        _notes,
        strings.lookup('continuity.reconciliation.override_reason'),
        optional: true,
      ),
    ];
  }

  Widget _field(
    TextEditingController controller,
    String label, {
    bool optional = false,
    bool uuid = false,
    bool hash = false,
    bool integer = false,
    bool timestamp = false,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: TextFormField(
      controller: controller,
      decoration: _decoration(label),
      keyboardType: integer ? TextInputType.number : TextInputType.text,
      validator: (value) {
        final text = value?.trim() ?? '';
        if (text.isEmpty) return optional ? null : '$label is required';
        if (uuid && !_uuid.hasMatch(text)) return '$label is invalid';
        if (hash && !_hash.hasMatch(text)) return '$label is invalid';
        if (integer && (int.tryParse(text) ?? 0) < 1) {
          return '$label is invalid';
        }
        if (timestamp && DateTime.tryParse(text) == null) {
          return '$label is invalid';
        }
        return null;
      },
    ),
  );

  InputDecoration _decoration(String label) =>
      InputDecoration(labelText: label, border: const OutlineInputBorder());

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    if (_action == _PaperAction.transfusion &&
        (!_unitMatch || !_patientMatch || !_groupCompatible || !_expiryOk)) {
      setState(() {
        _error = AppStrings.of(
          context,
        ).lookup('continuity.reconciliation.transfusion_checks_required');
      });
      return;
    }
    if (_action == _PaperAction.transfusion &&
        _firstVerifier.text.trim() == _secondVerifier.text.trim()) {
      setState(() {
        _error = AppStrings.of(
          context,
        ).lookup('continuity.reconciliation.verifiers_distinct');
      });
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final paperId = _paperItem.text.trim().toUpperCase();
      final existing = widget.workbench.paperItems
          .where(
            (item) =>
                item.incidentId == widget.incidentId &&
                item.paperItemId == paperId,
          )
          .firstOrNull;
      var version = existing?.version;
      if (version == null) {
        final registered = await widget.client.registerPaperItem(
          incidentId: widget.incidentId,
          paperItemId: paperId,
          request: ClinicalContinuityRegisterPaperItemRequest(
            expectedVersion: 1,
            itemKind: _action.itemKind,
            actionId: _action.actionId,
            originalActorUid: _actorUid.text.trim(),
            originalActorRole: _actorRole.text.trim(),
            occurredAt: DateTime.parse(_occurredAt.text.trim()).toUtc(),
            patientUid: _patientUid.text.trim(),
            encounterId: _emptyToNull(_encounterId.text),
            evidenceHash: _evidenceHash.text.trim().toLowerCase(),
          ),
        );
        version = registered.paperItem?.version;
        if (version == null ||
            registered.disposition ==
                ClinicalContinuityCommandResultDisposition.needsReview) {
          throw const ClinicalContinuityReconciliationException(
            'Paper item requires reconciliation before a fact can be recorded',
            code: 'CONTINUITY_PAPER_ITEM_NEEDS_REVIEW',
          );
        }
      }
      await _apply(version, paperId);
      if (!mounted) return;
      Navigator.pop(context, true);
    } on ClinicalContinuityReconciliationException catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = error.code == null
            ? error.message
            : '${error.message} (${error.code})';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = AppStrings.of(
          context,
        ).lookup('continuity.reconciliation.save_failed');
      });
    }
  }

  Future<void> _apply(int version, String paperId) async {
    final occurred = DateTime.parse(_occurredAt.text.trim()).toUtc();
    final common = (
      expectedVersion: version,
      occurredAt: occurred,
      originalActorUid: _actorUid.text.trim(),
      originalActorRole: _actorRole.text.trim(),
      patientUid: _patientUid.text.trim(),
      encounterId: _emptyToNull(_encounterId.text),
      evidenceHash: _evidenceHash.text.trim().toLowerCase(),
    );
    final idempotencyKey =
        'cc-paper:${widget.incidentId}:$paperId:${_action.value}';
    switch (_action) {
      case _PaperAction.medication:
        await widget.client.recordMedicationAdministration(
          incidentId: widget.incidentId,
          paperItemId: paperId,
          idempotencyKey: idempotencyKey,
          request: ClinicalContinuityMarBackfillRequest(
            expectedVersion: common.expectedVersion,
            occurredAt: common.occurredAt,
            originalActorUid: common.originalActorUid,
            originalActorRole: common.originalActorRole,
            patientUid: common.patientUid,
            encounterId: common.encounterId,
            evidenceHash: common.evidenceHash,
            medicationAdministrationId: int.parse(_domainId.text.trim()),
            notes: _emptyToNull(_notes.text),
          ),
        );
      case _PaperAction.specimen:
        await widget.client.recordSpecimenCollection(
          incidentId: widget.incidentId,
          paperItemId: paperId,
          idempotencyKey: idempotencyKey,
          request: ClinicalContinuityLabBackfillRequest(
            expectedVersion: common.expectedVersion,
            occurredAt: common.occurredAt,
            originalActorUid: common.originalActorUid,
            originalActorRole: common.originalActorRole,
            patientUid: common.patientUid,
            encounterId: common.encounterId,
            evidenceHash: common.evidenceHash,
            investigationId: int.parse(_domainId.text.trim()),
            specimenBarcode: _barcode.text.trim(),
            collectionNotes: _emptyToNull(_notes.text),
          ),
        );
      case _PaperAction.transfusion:
        await widget.client.recordTransfusionVerification(
          incidentId: widget.incidentId,
          paperItemId: paperId,
          idempotencyKey: idempotencyKey,
          request: ClinicalContinuityTransfusionBackfillRequest(
            expectedVersion: common.expectedVersion,
            occurredAt: common.occurredAt,
            originalActorUid: common.originalActorUid,
            originalActorRole: common.originalActorRole,
            patientUid: common.patientUid,
            encounterId: common.encounterId,
            evidenceHash: common.evidenceHash,
            bloodRequestId: int.parse(_domainId.text.trim()),
            bloodUnitId: int.parse(_secondDomainId.text.trim()),
            firstVerifierUid: _firstVerifier.text.trim(),
            secondVerifierUid: _secondVerifier.text.trim(),
            scannedUnitNumber: _barcode.text.trim(),
            unitMatch: _unitMatch,
            patientMatch: _patientMatch,
            groupCompatible: _groupCompatible,
            expiryOk: _expiryOk,
            overrideReason: _emptyToNull(_notes.text),
          ),
        );
    }
  }
}

class _ReconciliationDecisionDialog extends StatefulWidget {
  const _ReconciliationDecisionDialog({
    required this.client,
    required this.item,
  });

  final ClinicalContinuityReconciliationClient client;
  final ClinicalContinuityReconciliationItem item;

  @override
  State<_ReconciliationDecisionDialog> createState() =>
      _ReconciliationDecisionDialogState();
}

class _ReconciliationDecisionDialogState
    extends State<_ReconciliationDecisionDialog> {
  final _reason = TextEditingController();
  var _decision = ClinicalContinuityDecisionRequestDecision.accept;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return AlertDialog(
      title: Text(strings.lookup('continuity.reconciliation.decide')),
      content: SizedBox(
        width: 480,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            DropdownButtonFormField<ClinicalContinuityDecisionRequestDecision>(
              initialValue: _decision,
              decoration: InputDecoration(
                labelText: strings.lookup('continuity.reconciliation.decision'),
                border: const OutlineInputBorder(),
              ),
              items:
                  const [
                        ClinicalContinuityDecisionRequestDecision.accept,
                        ClinicalContinuityDecisionRequestDecision.exclude,
                        ClinicalContinuityDecisionRequestDecision.handoff,
                        ClinicalContinuityDecisionRequestDecision.reopen,
                      ]
                      .map(
                        (decision) => DropdownMenuItem(
                          value: decision,
                          child: Text(_label(decision.value)),
                        ),
                      )
                      .toList(growable: false),
              onChanged: (decision) =>
                  setState(() => _decision = decision ?? _decision),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _reason,
              decoration: InputDecoration(
                labelText: strings.lookup(
                  'continuity.reconciliation.reason_code',
                ),
                border: const OutlineInputBorder(),
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  _error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.pop(context, false),
          child: Text(strings.lookup('action.cancel')),
        ),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: Text(strings.lookup('action.submit')),
        ),
      ],
    );
  }

  Future<void> _save() async {
    final reason = _reason.text.trim();
    if (reason.isEmpty) {
      setState(() {
        _error = AppStrings.of(
          context,
        ).lookup('continuity.reconciliation.reason_required');
      });
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await widget.client.decideItem(
        itemId: widget.item.id,
        idempotencyKey:
            'cc-reconciliation:${widget.item.id}:${widget.item.version}:${_decision.value}',
        request: ClinicalContinuityDecisionRequest(
          expectedVersion: widget.item.version,
          decision: _decision,
          reasonCode: reason,
        ),
      );
      if (!mounted) return;
      Navigator.pop(context, true);
    } on ClinicalContinuityReconciliationException catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = error.code == null
            ? error.message
            : '${error.message} (${error.code})';
      });
    }
  }
}

final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  caseSensitive: false,
);
final _hash = RegExp(r'^[0-9a-f]{64}$');

String? _emptyToNull(String value) {
  final normalized = value.trim();
  return normalized.isEmpty ? null : normalized;
}

String _label(String? value) => (value ?? 'unknown')
    .split('_')
    .map(
      (part) => part.isEmpty
          ? part
          : '${part.substring(0, 1).toUpperCase()}${part.substring(1)}',
    )
    .join(' ');
