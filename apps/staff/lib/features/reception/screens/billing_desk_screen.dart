import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/services/billing_api_service.dart';
import '../../../core/services/idempotency_attempt_registry.dart';
import '../../../core/services/patient_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/api_error_messages.dart';
import '../../../core/utils/patient_identity.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../widgets/billing_collect_button.dart';
import '../widgets/billing_document_actions.dart';
import '../widgets/billing_payment_dialog.dart';

import 'package:vhhealth_staff/l10n/app_strings.dart';

class BillingDeskScreen extends StatefulWidget {
  final String? prefillPatientUid;
  final String? prefillPatientName;
  final String? prefillPatientPhone;
  final int? prefillPharmacyOrderId;
  final int? prefillInvoiceItemId;
  final int? prefillTpaClaimId;
  final int? prefillFundingReconciliationCaseId;
  final int? prefillNhcxProjectionMessageId;

  const BillingDeskScreen({
    super.key,
    this.prefillPatientUid,
    this.prefillPatientName,
    this.prefillPatientPhone,
    this.prefillPharmacyOrderId,
    this.prefillInvoiceItemId,
    this.prefillTpaClaimId,
    this.prefillFundingReconciliationCaseId,
    this.prefillNhcxProjectionMessageId,
  });

  @override
  State<BillingDeskScreen> createState() => _BillingDeskScreenState();
}

class _BillingDeskScreenState extends State<BillingDeskScreen> {
  final _searchCtrl = TextEditingController();
  final _approvedCtrl = TextEditingController();
  final _nonPayableCtrl = TextEditingController();
  final _reasonTextCtrl = TextEditingController();
  final _fundingAttempts = IdempotencyAttemptRegistry();
  Timer? _searchDebounce;

  bool _lookupBusy = false;
  bool _invoiceBusy = false;
  bool _actionBusy = false;
  String? _error;
  List<Map<String, dynamic>> _patientMatches = const [];
  Map<String, dynamic>? _selectedPatient;
  List<Map<String, dynamic>> _invoices = const [];
  Map<String, dynamic>? _fundingRecovery;
  Map<String, dynamic>? _fundingReconciliation;
  bool _fundingBusy = false;
  Map<String, dynamic>? _nhcxProjectionRecovery;
  bool _nhcxBusy = false;
  String _reasonCode = 'partial_approval';
  String _reconciliationPath = 'SAFE_DEACTIVATE_DUPLICATES';
  int? _reconciliationKeeperItemId;

  @override
  void initState() {
    super.initState();
    final uid = widget.prefillPatientUid;
    if (uid != null && uid.trim().isNotEmpty) {
      _selectedPatient = {
        'uid': uid,
        if (widget.prefillPatientName != null)
          'name': widget.prefillPatientName,
        if (widget.prefillPatientPhone != null)
          'phone': widget.prefillPatientPhone,
      };
      _searchCtrl.text = _patientLabel(_selectedPatient!);
      _loadInvoices();
    }
    if (_hasNhcxProjectionTarget) {
      scheduleMicrotask(_loadNhcxProjectionRecovery);
    } else if (_hasReconciliationTarget) {
      scheduleMicrotask(_loadFundingReconciliation);
    } else if (_hasFundingTarget) {
      scheduleMicrotask(_loadFundingRecovery);
    }
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _searchCtrl.dispose();
    _approvedCtrl.dispose();
    _nonPayableCtrl.dispose();
    _reasonTextCtrl.dispose();
    _fundingAttempts.clear();
    super.dispose();
  }

  bool get _hasFundingTarget =>
      (widget.prefillPharmacyOrderId ?? 0) > 0 &&
      (widget.prefillInvoiceItemId ?? 0) > 0;

  bool get _hasReconciliationTarget =>
      (widget.prefillFundingReconciliationCaseId ?? 0) > 0;

  bool get _hasNhcxProjectionTarget =>
      (widget.prefillNhcxProjectionMessageId ?? 0) > 0;

  Future<void> _loadNhcxProjectionRecovery() async {
    final messageId = widget.prefillNhcxProjectionMessageId;
    if (messageId == null || messageId <= 0 || _nhcxBusy) return;
    setState(() {
      _nhcxBusy = true;
      _error = null;
    });
    try {
      final recovery =
          await BillingApiService.getAcceptedNhcxProjectionRecovery(messageId);
      if (!mounted) return;
      setState(() {
        _nhcxProjectionRecovery = recovery;
        _nhcxBusy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _nhcxBusy = false;
        _error = localizedApiErrorFromRaw(AppStrings.of(context), e);
      });
    }
  }

  Future<void> _retryNhcxProjection() async {
    final recovery = _nhcxProjectionRecovery;
    final messageId = widget.prefillNhcxProjectionMessageId;
    final transportHash = recovery?['transport_response_sha256']?.toString() ?? '';
    if (messageId == null || messageId <= 0 || transportHash.isEmpty || _nhcxBusy) return;
    const scope = 'nhcx-accepted-projection-retry';
    final payload = {
      'message_id': messageId,
      'expected_transport_response_sha256': transportHash,
    };
    setState(() {
      _nhcxBusy = true;
      _error = null;
    });
    try {
      await BillingApiService.retryAcceptedNhcxProjection(
        messageId: messageId,
        expectedTransportResponseSha256: transportHash,
        idempotencyKey: _fundingAttempts.keyFor(scope, payload),
      );
      _fundingAttempts.complete(scope);
      if (!mounted) return;
      setState(() => _nhcxBusy = false);
      await _loadNhcxProjectionRecovery();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _nhcxBusy = false;
        _error = localizedApiErrorFromRaw(AppStrings.of(context), e);
      });
    }
  }

  void _queuePatientLookup(String value) {
    _searchDebounce?.cancel();
    final query = value.trim();
    final selected = _selectedPatient;
    final selectedChanged =
        selected != null && query != patientSearchLabel(selected);
    setState(() {
      if (selectedChanged) {
        _selectedPatient = null;
        _invoices = const [];
      }
      if (!patientLookupQueryReady(query)) {
        _patientMatches = const [];
        _lookupBusy = false;
        _error = null;
      } else {
        _lookupBusy = true;
        _error = null;
      }
    });
    if (!patientLookupQueryReady(query)) return;
    _searchDebounce = Timer(
      const Duration(milliseconds: 280),
      () => _searchPatients(value),
    );
  }

  Future<void> _searchPatients(String value) async {
    final query = value.trim();
    if (!patientLookupQueryReady(query)) {
      setState(() {
        _patientMatches = const [];
        _lookupBusy = false;
        _error = null;
      });
      return;
    }
    setState(() {
      _lookupBusy = true;
      _error = null;
    });
    try {
      final matches = (await PatientApiService.search(query, limit: 12))
          .where((patient) => patientMatchesLookupQuery(patient, query))
          .toList(growable: false);
      if (!mounted || _searchCtrl.text.trim() != query) return;
      setState(() {
        _patientMatches = matches;
        _lookupBusy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _lookupBusy = false;
        _error = localizedApiErrorFromRaw(AppStrings.of(context), e);
      });
    }
  }

  Future<void> _selectPatient(Map<String, dynamic> patient) async {
    setState(() {
      _selectedPatient = patient;
      _patientMatches = const [];
      _searchCtrl.text = _patientLabel(patient);
    });
    await _loadInvoices();
  }

  Future<void> _loadInvoices() async {
    final uid = _selectedPatient?['uid']?.toString();
    if (uid == null || uid.isEmpty) return;
    setState(() {
      _invoiceBusy = true;
      _error = null;
    });
    try {
      final invoices = await BillingApiService.listInvoices(
        patientUid: uid,
        limit: 30,
      );
      if (!mounted) return;
      setState(() {
        _invoices = invoices;
        _invoiceBusy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _invoiceBusy = false;
        _error = localizedApiErrorFromRaw(AppStrings.of(context), e);
      });
    }
  }

  Future<void> _loadFundingRecovery() async {
    if (!_hasFundingTarget || _fundingBusy) return;
    setState(() {
      _fundingBusy = true;
      _error = null;
    });
    try {
      final recovery = await BillingApiService.getPharmacyFundingRecovery(
        pharmacyOrderId: widget.prefillPharmacyOrderId!,
        invoiceItemId: widget.prefillInvoiceItemId!,
        tpaClaimId: widget.prefillTpaClaimId,
      );
      if (!mounted) return;
      final patientUid = recovery['patient_uid']?.toString().trim();
      setState(() {
        _fundingRecovery = recovery;
        _fundingBusy = false;
        if (patientUid != null && patientUid.isNotEmpty) {
          _selectedPatient = {'uid': patientUid};
          _searchCtrl.text = patientUid;
        }
        final decision = recovery['approved_amount'];
        final nonPayable = recovery['non_payable_amount'];
        if (decision != null) _approvedCtrl.text = decision.toString();
        if (nonPayable != null) _nonPayableCtrl.text = nonPayable.toString();
        final code = recovery['reason_code']?.toString();
        if (_fundingReasonCodes.contains(code)) _reasonCode = code!;
        _reasonTextCtrl.text = recovery['reason_text']?.toString() ?? '';
      });
      if (patientUid != null && patientUid.isNotEmpty) await _loadInvoices();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _fundingBusy = false;
        _error = localizedApiErrorFromRaw(AppStrings.of(context), e);
      });
    }
  }

  Future<void> _loadFundingReconciliation() async {
    final caseId = widget.prefillFundingReconciliationCaseId;
    if (caseId == null || caseId <= 0 || _fundingBusy) return;
    setState(() {
      _fundingBusy = true;
      _error = null;
    });
    try {
      final reconciliation =
          await BillingApiService.getPharmacyFundingReconciliationCase(caseId);
      if (!mounted) return;
      final snapshot = reconciliation['current_snapshot'] is Map
          ? Map<String, dynamic>.from(reconciliation['current_snapshot'] as Map)
          : const <String, dynamic>{};
      final lines = ((snapshot['lines'] as List?) ?? const [])
          .whereType<Map>()
          .map((line) => Map<String, dynamic>.from(line))
          .where((line) => line['source_ref_active'] == true)
          .toList(growable: false);
      final keeperIds = lines
          .map((line) => int.tryParse(line['invoice_item_id']?.toString() ?? ''))
          .whereType<int>()
          .toSet();
      setState(() {
        _fundingReconciliation = reconciliation;
        _fundingBusy = false;
        if (!keeperIds.contains(_reconciliationKeeperItemId)) {
          _reconciliationKeeperItemId = keeperIds.isEmpty ? null : keeperIds.first;
        }
        final existingPath = reconciliation['resolution_path']?.toString();
        if (_reconciliationPaths.contains(existingPath)) {
          _reconciliationPath = existingPath!;
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _fundingBusy = false;
        _error = localizedApiErrorFromRaw(AppStrings.of(context), e);
      });
    }
  }

  static const _reconciliationPaths = <String>[
    'SAFE_DEACTIVATE_DUPLICATES',
    'KEEP_CURRENT_AUTHORITY',
    'CANCEL_ORDER',
    'REBILL',
  ];

  String _reconciliationPathLabel(AppStrings strings, String path) {
    switch (path) {
      case 'SAFE_DEACTIVATE_DUPLICATES':
        return strings.lookup('med03.pharmacy.funding_reconciliation.path.safe');
      case 'KEEP_CURRENT_AUTHORITY':
        return strings.lookup('med03.pharmacy.funding_reconciliation.path.keep');
      case 'CANCEL_ORDER':
        return strings.lookup('med03.pharmacy.funding_reconciliation.path.cancel');
      case 'REBILL':
        return strings.lookup('med03.pharmacy.funding_reconciliation.path.rebill');
    }
    return strings.lookup('med03.pharmacy.funding_reconciliation.status.unknown');
  }

  String _reconciliationStatusLabel(AppStrings strings, String status) {
    switch (status) {
      case 'OPEN':
        return strings.lookup('med03.pharmacy.funding_reconciliation.status.open');
      case 'PENDING_APPROVAL':
        return strings.lookup('med03.pharmacy.funding_reconciliation.status.pending');
      case 'BLOCKED':
        return strings.lookup('med03.pharmacy.funding_reconciliation.status.blocked');
      case 'RESOLVED':
        return strings.lookup('med03.pharmacy.funding_reconciliation.status.resolved');
    }
    return strings.lookup('med03.pharmacy.funding_reconciliation.status.unknown');
  }

  Future<void> _recordFundingReconciliationDecision() async {
    final reconciliation = _fundingReconciliation;
    final caseId = widget.prefillFundingReconciliationCaseId;
    final keeperId = _reconciliationKeeperItemId;
    final snapshotHash =
        reconciliation?['current_snapshot_sha256']?.toString() ?? '';
    if (caseId == null || keeperId == null || snapshotHash.isEmpty || _fundingBusy) {
      return;
    }
    final payload = {
      'case_id': caseId,
      'keeper_invoice_item_id': keeperId,
      'resolution_path': _reconciliationPath,
      'expected_snapshot_sha256': snapshotHash,
    };
    const scope = 'pharmacy-funding-duplicate-line-reconciliation';
    setState(() {
      _fundingBusy = true;
      _error = null;
    });
    try {
      await BillingApiService.recordPharmacyFundingReconciliationDecision(
        caseId: caseId,
        keeperInvoiceItemId: keeperId,
        resolutionPath: _reconciliationPath,
        expectedSnapshotSha256: snapshotHash,
        idempotencyKey: _fundingAttempts.keyFor(scope, payload),
      );
      _fundingAttempts.complete(scope);
      if (!mounted) return;
      setState(() => _fundingBusy = false);
      await _loadFundingReconciliation();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _fundingBusy = false;
        _error = localizedApiErrorFromRaw(AppStrings.of(context), e);
      });
    }
  }

  static const _fundingReasonCodes = <String>[
    'room_upgrade',
    'over_cap_pharmacy',
    'over_cap_consumables',
    'non_listed',
    'partial_approval',
    'co_pay',
    'sub_limit',
    'pre_existing_waiting',
    'other',
  ];

  Future<void> _recordFundingDecision() async {
    final recovery = _fundingRecovery;
    final taskId = int.tryParse(recovery?['task_id']?.toString() ?? '');
    final claimId = int.tryParse(
      recovery?['claim_id']?.toString() ??
          recovery?['metadata']?['tpa_claim_id']?.toString() ??
          widget.prefillTpaClaimId?.toString() ??
          '',
    );
    final version = int.tryParse(
      recovery?['source_authority_version']?.toString() ?? '',
    );
    final hash = recovery?['source_authority_sha256']?.toString() ?? '';
    final approved = num.tryParse(_approvedCtrl.text.trim());
    final nonPayable = num.tryParse(_nonPayableCtrl.text.trim());
    if (taskId == null || claimId == null || version == null || hash.isEmpty ||
        approved == null || approved < 0 || nonPayable == null || nonPayable < 0) {
      setState(() {
        _error = AppStrings.of(context)
            .lookup('med03.pharmacy.funding_desk.invalid_decision');
      });
      return;
    }
    final payload = {
      'task_id': taskId,
      'pharmacy_order_id': widget.prefillPharmacyOrderId,
      'invoice_item_id': widget.prefillInvoiceItemId,
      'tpa_claim_id': claimId,
      'order_version': version,
      'order_items_sha256': hash,
      'approved_amount': approved,
      'non_payable_amount': nonPayable,
      'reason_code': _reasonCode,
      'reason_text': _reasonTextCtrl.text.trim(),
    };
    const scope = 'pharmacy-funding-line-decision';
    setState(() {
      _fundingBusy = true;
      _error = null;
    });
    try {
      await BillingApiService.recordPharmacyFundingLineDecision(
        taskId: taskId,
        pharmacyOrderId: widget.prefillPharmacyOrderId!,
        invoiceItemId: widget.prefillInvoiceItemId!,
        tpaClaimId: claimId,
        orderVersion: version,
        orderItemsSha256: hash,
        approvedAmount: approved,
        nonPayableAmount: nonPayable,
        reasonCode: _reasonCode,
        reasonText: _reasonTextCtrl.text,
        idempotencyKey: _fundingAttempts.keyFor(scope, payload),
      );
      _fundingAttempts.complete(scope);
      if (!mounted) return;
      setState(() => _fundingBusy = false);
      await _loadFundingRecovery();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _fundingBusy = false;
        _error = localizedApiErrorFromRaw(AppStrings.of(context), e);
      });
    }
  }

  Future<void> _retryPostedFunding() async {
    final taskId = int.tryParse(
      _fundingRecovery?['task_id']?.toString() ?? '',
    );
    if (taskId == null || _fundingBusy) return;
    final payload = {
      'task_id': taskId,
      'pharmacy_order_id': widget.prefillPharmacyOrderId,
      'invoice_item_id': widget.prefillInvoiceItemId,
    };
    const scope = 'pharmacy-funding-posted-payment-retry';
    setState(() {
      _fundingBusy = true;
      _error = null;
    });
    try {
      await BillingApiService.retryPharmacyFundingTask(
        taskId: taskId,
        idempotencyKey: _fundingAttempts.keyFor(scope, payload),
      );
      _fundingAttempts.complete(scope);
      if (!mounted) return;
      setState(() => _fundingBusy = false);
      await _loadFundingRecovery();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _fundingBusy = false;
        _error = localizedApiErrorFromRaw(AppStrings.of(context), e);
      });
    }
  }

  Future<void> _createDraftInvoice() async {
    final patient = _selectedPatient;
    final uid = patient?['uid']?.toString();
    if (uid == null || uid.isEmpty) return;
    if (_actionBusy) return;
    setState(() => _actionBusy = true);
    try {
      await BillingApiService.createDraftInvoice(
        patientUid: uid,
        patientName: patient?['name']?.toString(),
        patientPhone: patient?['phone']?.toString(),
        invoiceType: 'OP',
        department: 'Front Office',
        notes: 'Front office draft invoice',
      );
      await _loadInvoices();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText('s4.lib.billing_desk.draft_invoice_created'),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(
        () => _error = localizedApiErrorFromRaw(AppStrings.of(context), e),
      );
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
  }

  Future<void> _issueInvoice(Map<String, dynamic> invoice) async {
    final id = int.tryParse(invoice['id']?.toString() ?? '');
    if (id == null) return;
    if (_actionBusy) return;
    setState(() => _actionBusy = true);
    try {
      await BillingApiService.issueInvoice(id);
      await _loadInvoices();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: AppText('s4.lib.billing_desk.invoice_issued')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(
        () => _error = localizedApiErrorFromRaw(AppStrings.of(context), e),
      );
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
  }

  Future<void> _collectInvoicePayment(Map<String, dynamic> invoice) async {
    if (_actionBusy) return;
    setState(() => _actionBusy = true);
    try {
      final collected = await showBillingPaymentDialog(
        context: context,
        invoice: invoice,
      );
      if (!collected || !mounted) return;
      await _loadInvoices();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText('s4.lib.billing_desk.payment_collected'),
        ),
      );
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
  }

  Future<void> _printInvoiceDocument(
    Map<String, dynamic> invoice,
    BillingDocumentType type,
  ) async {
    if (_actionBusy) return;
    setState(() => _actionBusy = true);
    try {
      await printBillingDocument(
        context: context,
        invoice: invoice,
        type: type,
      );
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
  }

  String _patientLabel(Map<String, dynamic> patient) {
    return patientSearchLabel(patient);
  }

  num _sumDue() => _invoices.fold<num>(
    0,
    (sum, invoice) => sum + billingInvoiceAmountDue(invoice),
  );

  String _money(dynamic value) => billingMoney(value);

  @override
  Widget build(BuildContext context) {
    final selected = _selectedPatient;
    return StaffScaffold(
      title: AppStrings.of(context).lookup('s4.lib.billing_desk.billing_desk'),
      body: RefreshIndicator(
        onRefresh: _hasNhcxProjectionTarget
            ? _loadNhcxProjectionRecovery
            : _loadInvoices,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth >= 940;
            return ListView(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
              children: [
                _buildHeader(),
                const SizedBox(height: 12),
                if (_hasNhcxProjectionTarget ||
                    _hasReconciliationTarget ||
                    _hasFundingTarget) ...[
                  if (_hasNhcxProjectionTarget)
                    _buildNhcxProjectionPanel()
                  else if (_hasReconciliationTarget)
                    _buildFundingReconciliationPanel()
                  else
                    _buildFundingPanel(),
                  const SizedBox(height: 12),
                ],
                if (_error != null) ...[
                  _InlineAlert(message: _error!, color: AppTheme.errorRed),
                  const SizedBox(height: 12),
                ],
                if (wide)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(child: _buildPatientPanel()),
                      const SizedBox(width: 12),
                      Expanded(flex: 2, child: _buildInvoicePanel(selected)),
                    ],
                  )
                else ...[
                  _buildPatientPanel(),
                  const SizedBox(height: 12),
                  _buildInvoicePanel(selected),
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildNhcxProjectionPanel() {
    final strings = AppStrings.of(context);
    final recovery = _nhcxProjectionRecovery;
    if (_nhcxBusy && recovery == null) {
      return const _Surface(child: LinearProgressIndicator(minHeight: 2));
    }
    if (recovery == null) {
      return _Surface(
        child: Row(
          children: [
            const Expanded(
              child: AppText('med03.nhcx.projection.unavailable'),
            ),
            IconButton.filledTonal(
              onPressed: _nhcxBusy ? null : _loadNhcxProjectionRecovery,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
      );
    }
    final applied = recovery['projection_status']?.toString() == 'applied';
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.cloud_done_outlined,
            title: strings.lookup('med03.nhcx.projection.title'),
            trailing: IconButton.filledTonal(
              onPressed: _nhcxBusy ? null : _loadNhcxProjectionRecovery,
              icon: const Icon(Icons.refresh),
            ),
          ),
          const SizedBox(height: 8),
          const AppText('med03.nhcx.projection.help'),
          const SizedBox(height: 10),
          Text(
            strings.format('med03.nhcx.projection.summary', {
              'message': recovery['message_id'],
              'task': recovery['task_id'] ?? '-',
              'status': recovery['projection_status'],
              'owner': recovery['owner_role'] ?? 'INSURANCE_COORDINATOR',
            }),
          ),
          const SizedBox(height: 6),
          SelectableText(
            strings.format('med03.nhcx.projection.receipt', {
              'hash': recovery['transport_response_sha256'],
            }),
          ),
          if ((recovery['projection_error']?.toString() ?? '').isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(recovery['projection_error'].toString()),
          ],
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: _nhcxBusy || applied ? null : _retryNhcxProjection,
            icon: Icon(applied ? Icons.check_circle_outline : Icons.sync),
            label: AppText(
              applied
                  ? 'med03.nhcx.projection.completed'
                  : 'med03.nhcx.projection.retry_local',
            ),
          ),
          if (_nhcxBusy) ...[
            const SizedBox(height: 10),
            const LinearProgressIndicator(minHeight: 2),
          ],
        ],
      ),
    );
  }

  Widget _buildFundingPanel() {
    final recovery = _fundingRecovery;
    if (_fundingBusy && recovery == null) {
      return const _Surface(child: LinearProgressIndicator(minHeight: 2));
    }
    if (recovery == null) {
      return _Surface(
        child: Row(
          children: [
            const Expanded(
              child: AppText('med03.pharmacy.funding_desk.unavailable'),
            ),
            IconButton.filledTonal(
              onPressed: _fundingBusy ? null : _loadFundingRecovery,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
      );
    }
    final taskType = recovery['related_resource_type']?.toString();
    final taskStatus = recovery['task_status']?.toString() ?? 'completed';
    final assignedRole = recovery['assigned_to_role']?.toString() ?? '';
    final metadata = recovery['metadata'] is Map
        ? Map<String, dynamic>.from(recovery['metadata'] as Map)
        : const <String, dynamic>{};
    final outstanding = metadata['amount_outstanding'] ??
        recovery['non_payable_amount'] ??
        recovery['line_total'];
    final isInsurance = taskType == 'pharmacy_tpa_line_decision';
    final isFinance = taskType == 'pharmacy_posted_payment';
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.account_balance_outlined,
            title: AppStrings.of(context)
                .lookup('med03.pharmacy.funding_desk.title'),
            trailing: IconButton.filledTonal(
              onPressed: _fundingBusy ? null : _loadFundingRecovery,
              icon: const Icon(Icons.refresh),
            ),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 12,
            runSpacing: 6,
            children: [
              Text('#${recovery['task_id'] ?? '-'}'),
              Text(taskStatus.toUpperCase()),
              if (assignedRole.isNotEmpty) Text(assignedRole),
              Text(_money(outstanding)),
            ],
          ),
          const SizedBox(height: 10),
          if (isInsurance) ...[
            const AppText('med03.pharmacy.funding_desk.insurance_help'),
            const SizedBox(height: 10),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                SizedBox(
                  width: 190,
                  child: TextField(
                    controller: _approvedCtrl,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    decoration: InputDecoration(
                      labelText: AppStrings.of(context).lookup(
                        'med03.pharmacy.funding_desk.approved_amount',
                      ),
                    ),
                  ),
                ),
                SizedBox(
                  width: 190,
                  child: TextField(
                    controller: _nonPayableCtrl,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    decoration: InputDecoration(
                      labelText: AppStrings.of(context).lookup(
                        'med03.pharmacy.funding_desk.non_payable_amount',
                      ),
                    ),
                  ),
                ),
                SizedBox(
                  width: 230,
                  child: DropdownButtonFormField<String>(
                    initialValue: _reasonCode,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(context).lookup(
                        'med03.pharmacy.funding_desk.reason_code',
                      ),
                    ),
                    items: _fundingReasonCodes
                        .map(
                          (code) => DropdownMenuItem(
                            value: code,
                            child: Text(code.replaceAll('_', ' ')),
                          ),
                        )
                        .toList(growable: false),
                    onChanged: _fundingBusy
                        ? null
                        : (value) => setState(() => _reasonCode = value!),
                  ),
                ),
                SizedBox(
                  width: 260,
                  child: TextField(
                    controller: _reasonTextCtrl,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(context).lookup(
                        'med03.pharmacy.funding_desk.reason_text',
                      ),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            FilledButton.icon(
              onPressed: _fundingBusy ? null : _recordFundingDecision,
              icon: const Icon(Icons.verified_outlined),
              label: const AppText(
                'med03.pharmacy.funding_desk.record_decision',
              ),
            ),
          ] else if (isFinance) ...[
            const AppText('med03.pharmacy.funding_desk.finance_help'),
            const SizedBox(height: 10),
            FilledButton.icon(
              onPressed: _fundingBusy ? null : _retryPostedFunding,
              icon: const Icon(Icons.sync),
              label: const AppText(
                'med03.pharmacy.funding_desk.retry_posted_payment',
              ),
            ),
          ] else
            const AppText('med03.pharmacy.funding_desk.resolved'),
          if (_fundingBusy) ...[
            const SizedBox(height: 10),
            const LinearProgressIndicator(minHeight: 2),
          ],
        ],
      ),
    );
  }

  Widget _buildFundingReconciliationPanel() {
    final strings = AppStrings.of(context);
    final reconciliation = _fundingReconciliation;
    if (_fundingBusy && reconciliation == null) {
      return const _Surface(child: LinearProgressIndicator(minHeight: 2));
    }
    if (reconciliation == null) {
      return _Surface(
        child: Row(
          children: [
            const Expanded(
              child: AppText('med03.pharmacy.funding_reconciliation.unavailable'),
            ),
            IconButton.filledTonal(
              onPressed: _fundingBusy ? null : _loadFundingReconciliation,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
      );
    }
    final snapshot = reconciliation['current_snapshot'] is Map
        ? Map<String, dynamic>.from(reconciliation['current_snapshot'] as Map)
        : const <String, dynamic>{};
    final lines = ((snapshot['lines'] as List?) ?? const [])
        .whereType<Map>()
        .map((line) => Map<String, dynamic>.from(line))
        .where((line) => line['source_ref_active'] == true)
        .toList(growable: false);
    final status = reconciliation['status']?.toString() ?? 'OPEN';
    final pendingApproval = status == 'PENDING_APPROVAL';
    final resolved = status == 'RESOLVED';
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.rule_folder_outlined,
            title: strings.lookup('med03.pharmacy.funding_reconciliation.title'),
            trailing: IconButton.filledTonal(
              onPressed: _fundingBusy ? null : _loadFundingReconciliation,
              icon: const Icon(Icons.refresh),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            strings.format('med03.pharmacy.funding_reconciliation.case_summary', {
              'case': reconciliation['id'],
              'task': reconciliation['task_id'],
              'status': _reconciliationStatusLabel(strings, status),
              'owner': strings.lookup(
                'med03.pharmacy.funding_reconciliation.owner.finance',
              ),
            }),
          ),
          const SizedBox(height: 8),
          const AppText(
            'med03.pharmacy.funding_reconciliation.help',
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<int>(
            key: ValueKey(
              'funding-reconciliation-keeper-${reconciliation['current_snapshot_sha256']}',
            ),
            initialValue: _reconciliationKeeperItemId,
            decoration: InputDecoration(
              labelText: strings.lookup(
                'med03.pharmacy.funding_reconciliation.keeper_label',
              ),
              border: OutlineInputBorder(),
            ),
            items: lines.map((line) {
              final itemId = int.parse(line['invoice_item_id'].toString());
              return DropdownMenuItem(
                value: itemId,
                child: Text(
                  strings.format(
                    'med03.pharmacy.funding_reconciliation.line_option',
                    {
                      'line': itemId,
                      'invoice': line['invoice_id'],
                      'amount': _money(line['line_total']),
                    },
                  ),
                ),
              );
            }).toList(growable: false),
            onChanged: _fundingBusy
                ? null
                : (value) => setState(() => _reconciliationKeeperItemId = value),
          ),
          const SizedBox(height: 10),
          DropdownButtonFormField<String>(
            initialValue: _reconciliationPath,
            decoration: InputDecoration(
              labelText: strings.lookup(
                'med03.pharmacy.funding_reconciliation.path_label',
              ),
              border: OutlineInputBorder(),
            ),
            items: _reconciliationPaths
                .map((path) => DropdownMenuItem(
                      value: path,
                      child: Text(_reconciliationPathLabel(strings, path)),
                    ))
                .toList(growable: false),
            onChanged: _fundingBusy
                ? null
                : (value) => setState(() => _reconciliationPath = value!),
          ),
          if (pendingApproval) ...[
            const SizedBox(height: 10),
            Text(
              strings.format(
                'med03.pharmacy.funding_reconciliation.pending_owner',
                {'owner': reconciliation['proposed_by']},
              ),
            ),
          ],
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: _fundingBusy || resolved || _reconciliationKeeperItemId == null
                ? null
                : _recordFundingReconciliationDecision,
            icon: const Icon(Icons.fact_check_outlined),
            label: Text(
              pendingApproval
                  ? strings.lookup(
                      'med03.pharmacy.funding_reconciliation.action.approve',
                    )
                  : resolved
                      ? strings.lookup(
                          'med03.pharmacy.funding_reconciliation.status.resolved',
                        )
                      : strings.lookup(
                          'med03.pharmacy.funding_reconciliation.action.propose',
                        ),
            ),
          ),
          if (_fundingBusy) ...[
            const SizedBox(height: 10),
            const LinearProgressIndicator(minHeight: 2),
          ],
        ],
      ),
    );
  }

  Widget _buildHeader() {
    return _Surface(
      child: Wrap(
        spacing: 12,
        runSpacing: 12,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: AppTheme.primaryBlue.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(Icons.receipt_long, color: AppTheme.primaryBlue),
          ),
          ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 220, maxWidth: 460),
            child: AppText(
              's4.lib.billing_desk.billing_desk',
              style: Theme.of(context).textTheme.titleLarge
                  ?.copyWith(fontWeight: FontWeight.w800),
            ),
          ),
          _Metric(
            icon: Icons.receipt_long_outlined,
            label: AppStrings.of(context)
                .lookup('s4.lib.billing_desk.invoices'),
            value: '${_invoices.length}',
            color: AppTheme.primaryBlue,
          ),
          _Metric(
            icon: Icons.payments_outlined,
            label: AppStrings.of(context).lookup('s4.lib.billing_desk.due'),
            value: _money(_sumDue()),
            color: AppTheme.warningAmber,
          ),
          IconButton.filledTonal(
            tooltip: AppStrings.of(context).lookup('action.refresh'),
            onPressed: _loadInvoices,
            icon: const Icon(Icons.refresh),
          ),
          OutlinedButton.icon(
            onPressed: () => context.push('/billing/credit-notes'),
            icon: const Icon(Icons.request_quote_outlined),
            label: const AppText('med03.credit_note.open_queue'),
          ),
        ],
      ),
    );
  }

  Widget _buildPatientPanel() {
    final selected = _selectedPatient;
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.manage_search,
            title: AppStrings.of(context).lookup('s4.lib.billing_desk.patient'),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _searchCtrl,
                  onChanged: _queuePatientLookup,
                  onSubmitted: _searchPatients,
                  decoration: InputDecoration(
                    labelText: AppStrings.of(context)
                        .lookup('reception_counter.patient_lookup.hint'),
                    prefixIcon: const Icon(Icons.search),
                    suffixIcon: _lookupBusy
                        ? const Padding(
                            padding: EdgeInsets.all(12),
                            child: SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          )
                        : null,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              IconButton.filledTonal(
                tooltip: AppStrings.of(context).lookup('action.search'),
                onPressed: () => _searchPatients(_searchCtrl.text),
                icon: const Icon(Icons.search),
              ),
            ],
          ),
          if (selected != null) ...[
            const SizedBox(height: 10),
            _PatientCard(patient: selected, selected: true, onTap: () {}),
          ],
          if (_patientMatches.isNotEmpty) ...[
            const SizedBox(height: 10),
            ..._patientMatches.map(
              (patient) => Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _PatientCard(
                  patient: patient,
                  onTap: () => _selectPatient(patient),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildInvoicePanel(Map<String, dynamic>? selected) {
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.receipt,
            title: AppStrings.of(context)
                .lookup('s4.lib.billing_desk.invoices'),
            trailing: selected == null
                ? null
                : FilledButton.icon(
                    onPressed: _actionBusy ? null : _createDraftInvoice,
                    icon: _actionBusy
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.add),
                    label: const AppText('s4.lib.billing_desk.draft_op'),
                  ),
          ),
          const SizedBox(height: 10),
          if (selected == null)
            _EmptyLine(
              icon: Icons.person_search,
              text: AppStrings.of(context)
                  .lookup('s4.lib.billing_desk.select_a_patient'),
            )
          else if (_invoiceBusy)
            const LinearProgressIndicator(minHeight: 2)
          else if (_invoices.isEmpty)
            _EmptyLine(
              icon: Icons.receipt_long,
              text: AppStrings.of(context)
                  .lookup('s4.lib.billing_desk.no_invoices_found'),
            )
          else
            ..._invoices.map(_invoiceTile),
        ],
      ),
    );
  }

  Widget _invoiceTile(Map<String, dynamic> invoice) {
    final id = invoice['invoice_number'] ?? '#${invoice['id']}';
    final status = invoice['status']?.toString().toUpperCase() ?? 'DRAFT';
    final invoiceType = invoice['invoice_type']?.toString() ?? 'OP';
    final isDraft = status == 'DRAFT';
    final due = billingInvoiceAmountDue(invoice);
    final canCollect = billingInvoiceCanCollect(invoice);
    final canPrintTax = billingInvoiceCanPrintTaxInvoice(invoice);
    final canPrintReceipt = billingInvoiceCanPrintReceipt(invoice);
    final actions = <Widget>[
      if (canPrintTax)
        IconButton.filledTonal(
          tooltip: AppStrings.of(context)
              .lookup('s4.lib.billing_desk.print_tax_invoice'),
          onPressed: _actionBusy
              ? null
              : () => _printInvoiceDocument(
                  invoice,
                  BillingDocumentType.taxInvoice,
                ),
          icon: const Icon(Icons.picture_as_pdf_outlined, size: 18),
        ),
      if (canPrintReceipt)
        IconButton.filledTonal(
          tooltip: AppStrings.of(context)
              .lookup('s4.lib.billing_desk.print_receipt'),
          onPressed: _actionBusy
              ? null
              : () =>
                    _printInvoiceDocument(invoice, BillingDocumentType.receipt),
          icon: const Icon(Icons.receipt_outlined, size: 18),
        ),
      if (isDraft)
        SizedBox(
          height: 34,
          child: OutlinedButton.icon(
            onPressed: _actionBusy ? null : () => _issueInvoice(invoice),
            icon: const Icon(Icons.publish_outlined, size: 16),
            label: const AppText('s4.lib.billing_desk.issue'),
          ),
        ),
      if (canCollect)
        BillingCollectButton(
          busy: _actionBusy,
          onPressed: () => _collectInvoicePayment(invoice),
        ),
    ];

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest
            .withValues(alpha: 0.26),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Theme.of(context).dividerColor),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final compact = constraints.maxWidth < 560;
          final details = Row(
            children: [
              CircleAvatar(
                backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.12),
                child: const Icon(Icons.receipt_long_outlined),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      id.toString(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleSmall
                          ?.copyWith(fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 2),
                    Wrap(
                      spacing: 8,
                      runSpacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          '$invoiceType - $status',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                        Text(
                          _money(due),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          );

          if (compact) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                details,
                if (actions.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    alignment: WrapAlignment.end,
                    children: actions,
                  ),
                ],
              ],
            );
          }

          return Row(
            children: [
              Expanded(child: details),
              if (actions.isNotEmpty) ...[
                const SizedBox(width: 12),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 380),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    alignment: WrapAlignment.end,
                    children: actions,
                  ),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _Surface extends StatelessWidget {
  final Widget child;

  const _Surface({required this.child});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: child,
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final IconData icon;
  final String title;
  final Widget? trailing;

  const _SectionTitle({required this.icon, required this.title, this.trailing});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, color: AppTheme.primaryBlue),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            title,
            style: Theme.of(context).textTheme.titleMedium
                ?.copyWith(fontWeight: FontWeight.w800),
          ),
        ),
        ?trailing,
      ],
    );
  }
}

class _Metric extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color color;

  const _Metric({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minWidth: 132),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, color: color),
          const SizedBox(width: 8),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.w800, color: color),
                ),
                Text(label, style: TextStyle(color: AppTheme.textSecondary)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _PatientCard extends StatelessWidget {
  final Map<String, dynamic> patient;
  final bool selected;
  final VoidCallback onTap;

  const _PatientCard({
    required this.patient,
    required this.onTap,
    this.selected = false,
  });

  @override
  Widget build(BuildContext context) {
    final name = patientNameFrom(patient);
    final subtitle = patientSubtitle(patient);
    return Semantics(
      button: true,
      selected: selected,
      label: [name, subtitle].where((part) => part.isNotEmpty).join(', '),
      child: Material(
        color: selected
            ? AppTheme.primaryBlue.withValues(alpha: 0.08)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Row(
              children: [
                CircleAvatar(
                  backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.14),
                  child: const ExcludeSemantics(
                    child: Icon(Icons.person_outline),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                      if (subtitle.isNotEmpty)
                        Text(
                          subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _EmptyLine extends StatelessWidget {
  final IconData icon;
  final String text;

  const _EmptyLine({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Icon(icon, color: AppTheme.textSecondary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: TextStyle(color: AppTheme.textSecondary)),
          ),
        ],
      ),
    );
  }
}

class _InlineAlert extends StatelessWidget {
  final String message;
  final Color color;

  const _InlineAlert({required this.message, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Row(
        children: [
          Icon(Icons.info_outline, color: color),
          const SizedBox(width: 8),
          Expanded(child: Text(message)),
        ],
      ),
    );
  }
}
