import 'dart:collection';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

import '../../../core/models/composition_alternatives.dart';
import '../../../core/services/pharmacy_api_service.dart';
import '../models/pharmacy_funding_recovery.dart';
import 'composition_alternatives_panel.dart';

typedef DispensableContextLoader = Future<Map<String, dynamic>> Function(
  int orderId,
);
typedef DispensableBatchLoader = Future<List<Map<String, dynamic>>> Function(
  int catalogId,
);
typedef SubstitutionDispenser = Future<void> Function({
  required int orderId,
  required int prescriptionId,
  required int orderLineIndex,
  required int prescriptionLineIndex,
  required String patientUid,
  int? encounterId,
  required int inventoryItemId,
  required int inventoryBatchId,
  required num quantity,
  required int originalCatalogId,
  required int finalCatalogId,
  String? reason,
  String? witnessApprovalId,
  required String paymentMode,
  required num amountCollected,
  String? tpaReference,
  required String idempotencyKey,
});
typedef SubstitutionWitnessApprovalRequester =
    Future<Map<String, dynamic>> Function({
      required Map<String, dynamic> substitution,
      required String idempotencyKey,
    });
typedef SubstitutionWitnessApprovalApprover =
    Future<Map<String, dynamic>> Function({
      required String approvalId,
      required Map<String, dynamic> substitution,
      required String employeeId,
      required String password,
      required String idempotencyKey,
    });
dynamic _canonicalJsonValue(dynamic value) {
  if (value is Map) {
    final sorted = SplayTreeMap<String, dynamic>();
    for (final entry in value.entries) {
      sorted[entry.key.toString()] = _canonicalJsonValue(entry.value);
    }
    return sorted;
  }
  if (value is List) return value.map(_canonicalJsonValue).toList();
  return value;
}

String _substitutionFingerprint(Map<String, dynamic> substitution) =>
    jsonEncode(_canonicalJsonValue(substitution));

class _WitnessCredentials {
  const _WitnessCredentials(this.employeeId, this.password);

  final String employeeId;
  final String password;
}

/// Bottom sheet where a pharmacist dispenses an in-stock, same-formulation alternative
/// for a prescribed brand on a pharmacy order.
///
/// Flow: load the order's patient + prescribed catalog-id lines → mount the existing
/// [CompositionAlternativesPanel] for the selected line → on swap, load that alternative's
/// in-stock batches (FEFO) and collect a batch + quantity → POST dispense-substitution.
/// All equivalence + stock checks are enforced server-side; this is a data-collection UI.
class DispenseSubstitutionSheet extends StatefulWidget {
  const DispenseSubstitutionSheet({
    super.key,
    required this.orderId,
    this.onDispensed,
    this.contextLoader,
    this.batchLoader,
    this.dispenser,
    this.alternativesLoader,
    this.requestWitnessApproval,
    this.approveWitnessApproval,
    this.canOpenBillingDesk = false,
  });

  final int orderId;
  final VoidCallback? onDispensed;

  // Injectable seams (default to PharmacyApiService / the panel's own fetch) — for tests.
  final DispensableContextLoader? contextLoader;
  final DispensableBatchLoader? batchLoader;
  final SubstitutionDispenser? dispenser;
  final CompositionAlternativesLoader? alternativesLoader;
  final SubstitutionWitnessApprovalRequester? requestWitnessApproval;
  final SubstitutionWitnessApprovalApprover? approveWitnessApproval;
  final bool canOpenBillingDesk;

  static Future<void> show(
    BuildContext context, {
    required int orderId,
    bool canOpenBillingDesk = false,
    VoidCallback? onDispensed,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: DispenseSubstitutionSheet(
          orderId: orderId,
          canOpenBillingDesk: canOpenBillingDesk,
          onDispensed: onDispensed,
        ),
      ),
    );
  }

  @override
  State<DispenseSubstitutionSheet> createState() =>
      _DispenseSubstitutionSheetState();
}

class _DispenseSubstitutionSheetState extends State<DispenseSubstitutionSheet> {
  static const String _kSubstitutionReason =
      'Prescribed brand unavailable; same-formulation substitute';

  bool _loading = true;
  bool _loadingBatches = false;
  bool _dispensing = false;
  bool _witnessBusy = false;
  String? _error;
  bool _tpaRecoveryRequired = false;
  PharmacyFundingRecovery? _fundingRecovery;

  String? _patientUid;
  List<Map<String, dynamic>> _lines = const [];
  Map<String, dynamic>? _selectedLine;
  CompositionAlternativeItem? _chosen;
  List<Map<String, dynamic>> _batches = const [];
  Map<String, dynamic>? _selectedBatch;
  final TextEditingController _qtyCtrl = TextEditingController();
  final TextEditingController _amountCollectedCtrl = TextEditingController();
  final TextEditingController _tpaReferenceCtrl = TextEditingController();
  String _paymentMode = '';

  // Schedule X / narcotic witness approval state — mirrors the counter-sale
  // two-person flow: the approval is bound server-side to the EXACT
  // substitution payload, so any local change invalidates it.
  String? _witnessApprovalId;
  String? _witnessApprovalFingerprint;
  String? _approvedWitnessName;
  bool _witnessApproved = false;
  final _witnessRequestAttempt = IdempotencyAttempt(
    'substitution-witness-request',
  );
  final _witnessApprovalAttempt = IdempotencyAttempt(
    'substitution-witness-approval',
  );
  final _dispenseAttempt = IdempotencyAttempt('dispense-substitution');

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _qtyCtrl.dispose();
    _amountCollectedCtrl.dispose();
    _tpaReferenceCtrl.dispose();
    super.dispose();
  }

  int? get _originalCatalogId =>
      (_selectedLine?['catalog_id'] as num?)?.toInt();

  int? get _prescriptionId =>
      (_selectedLine?['prescription_id'] as num?)?.toInt();

  int? get _orderLineIndex =>
      (_selectedLine?['order_line_index'] as num?)?.toInt();

  int? get _prescriptionLineIndex =>
      (_selectedLine?['prescription_line_index'] as num?)?.toInt();

  String get _selectedLabel =>
      (_selectedLine?['name'] as String?) ?? 'Prescribed brand';

  /// The dispensable-batches endpoint returns the item's controlled-substance
  /// flags; Schedule X / narcotic substitutes need the independent witness.
  bool get _needsWitness =>
      _selectedBatch?['schedule_class']?.toString() == 'X' ||
      _selectedBatch?['is_narcotic'] == true;

  Map<String, dynamic>? _currentSubstitutionPayload() {
    final patient = _patientUid;
    final orig = _originalCatalogId;
    final prescriptionId = _prescriptionId;
    final orderLineIndex = _orderLineIndex;
    final prescriptionLineIndex = _prescriptionLineIndex;
    final chosen = _chosen;
    final batch = _selectedBatch;
    final qty = num.tryParse(_qtyCtrl.text.trim());
    final amountCollected = num.tryParse(_amountCollectedCtrl.text.trim());
    final tpaReference = _tpaReferenceCtrl.text.trim();
    final tpaMode = const {'insurance', 'corporate_tpa'}.contains(_paymentMode);
    if (patient == null ||
        orig == null ||
        prescriptionId == null ||
        orderLineIndex == null ||
        prescriptionLineIndex == null ||
        chosen == null ||
        batch == null ||
        _paymentMode.isEmpty ||
        qty == null ||
        !qty.isFinite ||
        qty <= 0 ||
        amountCollected == null ||
        !amountCollected.isFinite ||
        amountCollected < 0 ||
        (tpaMode && tpaReference.isEmpty)) {
      return null;
    }
    // Must stay byte-identical to the eventual dispense body (minus
    // witness_approval_id) — the server fingerprints these exact fields.
    return {
      'order_id': widget.orderId,
      'prescription_id': prescriptionId,
      'order_line_index': orderLineIndex,
      'prescription_line_index': prescriptionLineIndex,
      'patient_uid': patient,
      'inventory_item_id': (batch['inventory_item_id'] as num).toInt(),
      'inventory_batch_id': (batch['inventory_batch_id'] as num).toInt(),
      'quantity': qty,
      'original_catalog_id': orig,
      'final_catalog_id': chosen.catalogId,
      'reason': _kSubstitutionReason,
      'payment_mode': _paymentMode,
      'amount_collected': amountCollected,
      if (tpaReference.isNotEmpty) 'tpa_reference': tpaReference,
    };
  }

  bool get _hasCurrentWitnessApproval {
    if (!_witnessApproved || _witnessApprovalId == null) return false;
    final payload = _currentSubstitutionPayload();
    return payload != null &&
        _witnessApprovalFingerprint == _substitutionFingerprint(payload);
  }

  void _clearWitnessApprovalState() {
    _witnessApprovalId = null;
    _witnessApprovalFingerprint = null;
    _approvedWitnessName = null;
    _witnessApproved = false;
    _witnessRequestAttempt.reset();
    _witnessApprovalAttempt.reset();
  }

  bool _isCorrectableClientError(PharmacyApiException error) =>
      error.statusCode >= 400 && error.statusCode < 500;

  String _paymentModeLabel(AppStrings strings, String mode) =>
      strings.lookup('med03.pharmacy.payment_mode.$mode');

  String _recoveryActionLabel(AppStrings strings, Object? rawAction) =>
      switch (rawAction?.toString()) {
        'select_exact_tpa_claim_allocation' => strings.lookup(
          'med03.pharmacy.recovery.select_exact_tpa_claim_allocation',
        ),
        'materialize_pharmacy_funding' => strings.lookup(
          'med03.pharmacy.recovery.materialize_pharmacy_funding',
        ),
        'open_exact_pharmacy_funding_task' => strings.lookup(
          'med03.pharmacy.recovery.open_exact_pharmacy_funding_task',
        ),
        'complete_manual_allergy_review' => strings.lookup(
          'med03.pharmacy.recovery.complete_manual_allergy_review',
        ),
        _ => strings.lookup('med03.pharmacy.recovery.contact_owner'),
      };

  bool _witnessApprovalCannotBeReused(PharmacyApiException error) => const {
    'CONTROLLED_DISPENSE_WITNESS_APPROVAL_INVALID',
    'CONTROLLED_DISPENSE_WITNESS_APPROVAL_NOT_FOUND',
    'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH',
    'CONTROLLED_DISPENSE_WITNESS_APPROVAL_EXPIRED',
    'CONTROLLED_DISPENSE_WITNESS_APPROVAL_CONSUMED',
    'CONTROLLED_DISPENSE_WITNESS_APPROVAL_REQUESTER_MISMATCH',
  }.contains(error.code);

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _tpaRecoveryRequired = false;
      _fundingRecovery = null;
    });
    try {
      final ctx =
          await (widget.contextLoader ??
              PharmacyApiService.getOrderDispensable)(widget.orderId);
      final lines = ((ctx['lines'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .where((l) => l['catalog_id'] != null)
          .toList();
      setState(() {
        _patientUid = ctx['patient_uid'] as String?;
        _paymentMode =
            const {
              'cash',
              'card',
              'upi',
              'wallet',
              'insurance',
              'corporate_tpa',
            }.contains(ctx['payment_mode']?.toString())
            ? ctx['payment_mode'].toString()
            : '';
        _amountCollectedCtrl.text =
            (ctx['amount_collected'] as num? ?? 0).toString();
        _tpaReferenceCtrl.text = ctx['tpa_reference']?.toString() ?? '';
        _lines = lines;
        _selectedLine = lines.isNotEmpty ? lines.first : null;
        _chosen = null;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  void _onSelectLine(Map<String, dynamic>? line) {
    setState(() {
      _selectedLine = line;
      _chosen = null;
      _batches = const [];
      _selectedBatch = null;
      _clearWitnessApprovalState();
    });
  }

  Future<void> _onSwap(CompositionAlternativeItem item) async {
    setState(() {
      _chosen = item;
      _batches = const [];
      _selectedBatch = null;
      _loadingBatches = true;
      _error = null;
      _tpaRecoveryRequired = false;
      _fundingRecovery = null;
      _clearWitnessApprovalState();
    });
    try {
      final batches =
          await (widget.batchLoader ??
              PharmacyApiService.getCatalogDispensableBatches)(item.catalogId);
      final defaultQty = (_selectedLine?['quantity'] as num?);
      setState(() {
        _batches = batches;
        _selectedBatch = batches.isNotEmpty ? batches.first : null;
        _qtyCtrl.text = (defaultQty != null && defaultQty > 0 ? defaultQty : 1)
            .toString();
        _loadingBatches = false;
      });
    } catch (e) {
      setState(() {
        _loadingBatches = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _dispense() async {
    final s = AppStrings.of(context);
    final chosen = _chosen;
    final payload = _currentSubstitutionPayload();
    if (chosen == null || payload == null) {
      setState(
        () => _error = s.lookup(
          's4.lib.pharmacy.select_substitute_batch_quantity',
        ),
      );
      return;
    }
    if (_needsWitness && !_hasCurrentWitnessApproval) {
      // Fail closed client-side too: Schedule X / narcotic substitutes need
      // the approved second-staff witness before the dispense is attempted.
      setState(
        () =>
            _error = s.lookup('s4.lib.pharmacy.substitution_witness_required'),
      );
      return;
    }
    setState(() {
      _dispensing = true;
      _error = null;
      _tpaRecoveryRequired = false;
      _fundingRecovery = null;
    });
    try {
      final SubstitutionDispenser dispenser =
          widget.dispenser ?? PharmacyApiService.dispenseSubstitution;
      await dispenser(
        orderId: payload['order_id'] as int,
        prescriptionId: payload['prescription_id'] as int,
        orderLineIndex: payload['order_line_index'] as int,
        prescriptionLineIndex: payload['prescription_line_index'] as int,
        patientUid: payload['patient_uid'] as String,
        inventoryItemId: payload['inventory_item_id'] as int,
        inventoryBatchId: payload['inventory_batch_id'] as int,
        quantity: payload['quantity'] as num,
        originalCatalogId: payload['original_catalog_id'] as int,
        finalCatalogId: payload['final_catalog_id'] as int,
        reason: _kSubstitutionReason,
        witnessApprovalId: _needsWitness ? _witnessApprovalId : null,
        paymentMode: payload['payment_mode'] as String,
        amountCollected: payload['amount_collected'] as num,
        tpaReference: payload['tpa_reference'] as String?,
        idempotencyKey: _dispenseAttempt.keyFor({
          ...payload,
          'witness_approval_id': _needsWitness ? _witnessApprovalId : null,
        }),
      );
      _dispenseAttempt.reset();
      if (!mounted) return;
      widget.onDispensed?.call();
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            s.format('s4.dynamic.pharmacy.dispensed_as_substitute', {
              'name': chosen.displayName,
            }),
          ),
        ),
      );
    } on PharmacyApiException catch (error) {
      if (_isCorrectableClientError(error)) {
        _dispenseAttempt.reset();
      }
      final nextAction = error.details?['next_action']?.toString();
      final fundingRecovery = PharmacyFundingRecovery.from(
        error.details?['funding_recovery'],
      );
      if (!mounted) return;
      setState(() {
        _dispensing = false;
        if (_needsWitness && _witnessApprovalCannotBeReused(error)) {
          _clearWitnessApprovalState();
        }
        _tpaRecoveryRequired =
            error.code == 'PHARMACY_TPA_FUNDING_REQUIRED' ||
            error.code == 'COUNTER_FUNDING_POSTED_AUTHORITY_REQUIRED' ||
            nextAction == 'select_exact_tpa_claim_allocation' ||
            nextAction == 'materialize_pharmacy_funding' ||
            nextAction == 'open_exact_pharmacy_funding_task';
        _fundingRecovery = fundingRecovery;
        _error = [
          error.toString(),
          if (nextAction != null) _recoveryActionLabel(s, nextAction),
        ].join(' · ');
      });
    } catch (error) {
      setState(() {
        _dispensing = false;
        _error = error.toString();
      });
    }
  }

  Future<_WitnessCredentials?> _collectWitnessCredentials(AppStrings s) async {
    var employeeId = '';
    var password = '';
    final chosen = _chosen;
    final qty = _qtyCtrl.text.trim();
    return showDialog<_WitnessCredentials>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: Text(s.lookup('s4.lib.counter_sale.witness_auth_title')),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(s.lookup('s4.lib.counter_sale.witness_review_hint')),
              const SizedBox(height: 8),
              if (chosen != null) Text('${chosen.displayName} × $qty'),
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('substitution-witness-employee-id'),
                autofocus: true,
                textCapitalization: TextCapitalization.characters,
                onChanged: (value) => employeeId = value,
                decoration: InputDecoration(
                  labelText: s.lookup(
                    's4.lib.counter_sale.witness_employee_id',
                  ),
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                key: const ValueKey('substitution-witness-password'),
                obscureText: true,
                enableSuggestions: false,
                autocorrect: false,
                onChanged: (value) => password = value,
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.counter_sale.witness_password'),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            key: const ValueKey('substitution-witness-approve-submit'),
            onPressed: () {
              final normalizedEmployeeId = employeeId.trim().toUpperCase();
              if (normalizedEmployeeId.isEmpty || password.isEmpty) return;
              Navigator.pop(
                ctx,
                _WitnessCredentials(normalizedEmployeeId, password),
              );
            },
            child: Text(s.lookup('s4.lib.counter_sale.witness_approve')),
          ),
        ],
      ),
    );
  }

  Future<void> _requestOrApproveWitness() async {
    final s = AppStrings.of(context);
    if (_witnessBusy || !_needsWitness) return;
    final substitution = _currentSubstitutionPayload();
    if (substitution == null) {
      setState(
        () => _error = s.lookup(
          's4.lib.pharmacy.select_substitute_batch_quantity',
        ),
      );
      return;
    }
    final fingerprint = _substitutionFingerprint(substitution);
    setState(() {
      _witnessBusy = true;
      _error = null;
    });
    try {
      var approvalId = _witnessApprovalFingerprint == fingerprint
          ? _witnessApprovalId
          : null;
      if (approvalId == null) {
        final requester =
            widget.requestWitnessApproval ??
            PharmacyApiService.requestSubstitutionWitnessApproval;
        late final Map<String, dynamic> pending;
        try {
          pending = await requester(
            substitution: substitution,
            idempotencyKey: _witnessRequestAttempt.keyFor(substitution),
          );
        } on PharmacyApiException catch (error) {
          if (_isCorrectableClientError(error)) {
            _witnessRequestAttempt.reset();
          }
          rethrow;
        }
        final returnedApprovalId = pending['id']?.toString().trim() ?? '';
        if (!RegExp(r'^[1-9][0-9]*$').hasMatch(returnedApprovalId)) {
          throw StateError('Witness approval id missing');
        }
        approvalId = returnedApprovalId;
        if (!mounted) return;
        _witnessRequestAttempt.reset();
        setState(() {
          _witnessApprovalId = approvalId;
          _witnessApprovalFingerprint = fingerprint;
          _witnessApproved = false;
          _approvedWitnessName = null;
        });
      }

      final credentials = await _collectWitnessCredentials(s);
      if (credentials == null || !mounted) return;
      final approver =
          widget.approveWitnessApproval ??
          PharmacyApiService.approveSubstitutionWitnessApproval;
      late final Map<String, dynamic> approved;
      try {
        approved = await approver(
          approvalId: approvalId,
          substitution: substitution,
          employeeId: credentials.employeeId,
          password: credentials.password,
          idempotencyKey: _witnessApprovalAttempt.keyFor({
            'approvalId': approvalId,
            'substitution': substitution,
            'employeeId': credentials.employeeId,
          }),
        );
      } on PharmacyApiException catch (error) {
        if (_isCorrectableClientError(error)) {
          _witnessApprovalAttempt.reset();
        }
        rethrow;
      }
      if (!mounted) return;
      _witnessApprovalAttempt.reset();
      final witness = approved['witness'];
      final witnessName = witness is Map ? witness['name']?.toString() : null;
      setState(() {
        _witnessApprovalId = approvalId;
        _witnessApprovalFingerprint = fingerprint;
        _witnessApproved = true;
        _approvedWitnessName = witnessName;
      });
    } on PharmacyApiException catch (error) {
      if (!mounted) return;
      setState(() {
        if (_witnessApprovalCannotBeReused(error)) {
          _clearWitnessApprovalState();
        } else {
          _witnessApproved = false;
          _approvedWitnessName = null;
        }
        _error = s.lookup('s4.lib.counter_sale.witness_auth_failed');
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _witnessApproved = false;
        _approvedWitnessName = null;
        _error = s.lookup('s4.lib.counter_sale.witness_auth_failed');
      });
    } finally {
      if (mounted) setState(() => _witnessBusy = false);
    }
  }

  String _batchLabel(AppStrings s, Map<String, dynamic> b) {
    final n = b['batch_number'] ?? '—';
    final left = b['remaining_quantity'];
    final exp = (b['expiry_date'] ?? '').toString();
    final expShort = exp.length >= 10 ? exp.substring(0, 10) : exp;
    return s.format('s4.dynamic.pharmacy.substitute_batch_label', {
      'number': n,
      'left': left,
      'expiry': expShort,
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.85,
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.swap_horiz),
                  const SizedBox(width: 8),
                  Text(
                    s.lookup('s4.lib.pharmacy.dispense_substitute'),
                    style: theme.textTheme.titleLarge,
                  ),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 32),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (_lines.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 24),
                  child: Text(
                    s.lookup('s4.lib.pharmacy.no_prescribed_catalog_lines'),
                    style: theme.textTheme.bodyMedium,
                  ),
                )
              else ...[
                DropdownButtonFormField<Map<String, dynamic>>(
                  initialValue: _selectedLine,
                  isExpanded: true,
                  decoration: InputDecoration(
                    labelText: s.lookup('s4.lib.pharmacy.prescribed_medicine'),
                    border: const OutlineInputBorder(),
                  ),
                  items: _lines
                      .map(
                        (l) => DropdownMenuItem(
                          value: l,
                          child: Text(
                            (l['name'] as String?) ??
                                s.format('s4.dynamic.pharmacy.item_fallback', {
                                  'id': l['catalog_id'],
                                }),
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: _onSelectLine,
                ),
                const SizedBox(height: 12),
                CompositionAlternativesPanel(
                  key: ValueKey(_originalCatalogId),
                  catalogId: _originalCatalogId,
                  visible: true,
                  doNotSubstitute: false,
                  selectedLabel: _selectedLabel,
                  onSwap: _onSwap,
                  loader: widget.alternativesLoader,
                ),
                if (_chosen != null) ...[
                  const Divider(height: 24),
                  Text(
                    s.format('s4.dynamic.pharmacy.substitute_named', {
                      'name': _chosen!.displayName,
                    }),
                    style: theme.textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  if (_loadingBatches)
                    const Padding(
                      padding: EdgeInsets.all(8),
                      child: LinearProgressIndicator(),
                    )
                  else if (_batches.isEmpty)
                    Text(
                      s.format('s4.dynamic.pharmacy.no_in_stock_batches_for', {
                        'name': _chosen!.displayName,
                      }),
                      style: theme.textTheme.bodyMedium,
                    )
                  else ...[
                    DropdownButtonFormField<Map<String, dynamic>>(
                      initialValue: _selectedBatch,
                      isExpanded: true,
                      decoration: InputDecoration(
                        labelText: s.lookup(
                          's4.lib.pharmacy.batch_earliest_expiry_first',
                        ),
                        border: const OutlineInputBorder(),
                      ),
                      items: _batches
                          .map(
                            (b) => DropdownMenuItem(
                              value: b,
                              child: Text(_batchLabel(s, b)),
                            ),
                          )
                          .toList(),
                      onChanged: (b) => setState(() {
                        _selectedBatch = b;
                        _clearWitnessApprovalState();
                      }),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _qtyCtrl,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      decoration: InputDecoration(
                        labelText: s.lookup('s4.lib.pharmacy.quantity'),
                        border: const OutlineInputBorder(),
                      ),
                      // Approval is fingerprint-bound to the exact quantity —
                      // rebuild so the witness status chip tracks edits.
                      onChanged: (_) => setState(() {}),
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      key: const ValueKey('substitution-payment-mode'),
                      initialValue: _paymentMode.isEmpty ? null : _paymentMode,
                      decoration: InputDecoration(
                        labelText: s.lookup('s4.lib.counter_sale.payment_mode'),
                        border: const OutlineInputBorder(),
                      ),
                      items:
                          const [
                                'cash',
                                'card',
                                'upi',
                                'wallet',
                                'insurance',
                                'corporate_tpa',
                              ]
                              .map(
                                (mode) => DropdownMenuItem(
                                  value: mode,
                                  child: Text(_paymentModeLabel(s, mode)),
                                ),
                              )
                              .toList(),
                      onChanged: null,
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      key: const ValueKey('substitution-amount-collected'),
                      controller: _amountCollectedCtrl,
                      readOnly: true,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      decoration: InputDecoration(
                        labelText: s.lookup('med03.pharmacy.amount_collected'),
                        helperText: s.lookup(
                          'med03.pharmacy.authoritative_total_rechecked',
                        ),
                        border: const OutlineInputBorder(),
                      ),
                    ),
                    if (const {
                      'insurance',
                      'corporate_tpa',
                    }.contains(_paymentMode)) ...[
                      const SizedBox(height: 12),
                      TextField(
                        key: const ValueKey('substitution-tpa-reference'),
                      controller: _tpaReferenceCtrl,
                      readOnly: true,
                        maxLength: 160,
                        decoration: InputDecoration(
                          labelText: s.lookup('med03.pharmacy.tpa_reference'),
                          helperText: s.lookup(
                            'med03.pharmacy.tpa_reference_exact_help',
                          ),
                          border: const OutlineInputBorder(),
                        ),
                        onChanged: (_) => setState(() {
                          _clearWitnessApprovalState();
                        }),
                      ),
                    ],
                    if (_needsWitness) ...[
                      const SizedBox(height: 12),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          border: Border.all(
                            color: theme.colorScheme.outlineVariant,
                          ),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              s.lookup('s4.lib.counter_sale.witness_section'),
                              style: theme.textTheme.titleSmall,
                            ),
                            const SizedBox(height: 4),
                            Text(
                              s.lookup(
                                's4.lib.counter_sale.witness_two_person_hint',
                              ),
                              style: theme.textTheme.bodySmall,
                            ),
                            const SizedBox(height: 8),
                            Text(
                              _hasCurrentWitnessApproval
                                  ? (_approvedWitnessName != null
                                        ? s.format(
                                            's4.lib.counter_sale.witness_approved_by',
                                            {'name': _approvedWitnessName},
                                          )
                                        : s.lookup(
                                            's4.lib.counter_sale.witness_approved',
                                          ))
                                  : (_witnessApprovalId != null &&
                                            !_witnessApproved
                                        ? s.lookup(
                                            's4.lib.counter_sale.witness_pending',
                                          )
                                        : s.lookup(
                                            's4.lib.counter_sale.witness_not_requested',
                                          )),
                              style: theme.textTheme.bodyMedium,
                            ),
                            const SizedBox(height: 8),
                            OutlinedButton.icon(
                              key: const ValueKey(
                                'substitution-witness-request',
                              ),
                              icon: _witnessBusy
                                  ? const SizedBox(
                                      width: 16,
                                      height: 16,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : const Icon(Icons.verified_user_outlined),
                              label: Text(
                                _hasCurrentWitnessApproval
                                    ? s.lookup(
                                        's4.lib.counter_sale.witness_approved',
                                      )
                                    : s.lookup(
                                        's4.lib.counter_sale.witness_request',
                                      ),
                              ),
                              onPressed:
                                  (_witnessBusy || _hasCurrentWitnessApproval)
                                  ? null
                                  : _requestOrApproveWitness,
                            ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ],
              ],
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
                if (_fundingRecovery != null) ...[
                  const SizedBox(height: 4),
                  Text(_fundingRecovery!.summary(s)),
                ],
                if (_tpaRecoveryRequired)
                  if (_fundingRecovery?.deepLink != null &&
                      widget.canOpenBillingDesk)
                    TextButton.icon(
                      key: const ValueKey('substitution-open-billing-desk'),
                      onPressed: () =>
                          context.push(_fundingRecovery!.deepLink!.toString()),
                      icon: const Icon(Icons.account_balance_outlined),
                      label: Text(
                        s.lookup('med03.pharmacy.recovery.open_billing_desk'),
                      ),
                    ),
              ],
              const SizedBox(height: 16),
              FilledButton.icon(
                icon: _dispensing
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.check),
                label: Text(s.lookup('s4.lib.pharmacy.dispense_substitute')),
                onPressed:
                    (_dispensing ||
                        _chosen == null ||
                        _selectedBatch == null ||
                        (_needsWitness && !_hasCurrentWitnessApproval))
                    ? null
                    : _dispense,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
