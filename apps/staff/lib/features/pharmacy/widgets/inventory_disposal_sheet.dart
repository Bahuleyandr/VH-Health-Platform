import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';

import '../../../core/services/pharmacy_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';

typedef InventoryDisposalBatchLoader =
    Future<List<Map<String, dynamic>>> Function(
      int itemId,
      int facilityId,
      String status,
    );
typedef InventoryDisposalMutation = Future<Map<String, dynamic>> Function({
  required Map<String, dynamic> disposal,
  required String idempotencyKey,
});
typedef InventoryDisposalApproval = Future<Map<String, dynamic>> Function({
  required String approvalId,
  required Map<String, dynamic> disposal,
  required String employeeId,
  required String password,
  required String idempotencyKey,
});

class InventoryDisposalSheet extends StatefulWidget {
  const InventoryDisposalSheet({
    super.key,
    required this.item,
    required this.facilityId,
    this.loadBatches,
    this.requestWitnessApproval,
    this.approveWitnessApproval,
    this.disposeBatch,
  });

  final Map<String, dynamic> item;
  final int facilityId;
  final InventoryDisposalBatchLoader? loadBatches;
  final InventoryDisposalMutation? requestWitnessApproval;
  final InventoryDisposalApproval? approveWitnessApproval;
  final InventoryDisposalMutation? disposeBatch;

  @override
  State<InventoryDisposalSheet> createState() => _InventoryDisposalSheetState();
}

class _InventoryDisposalSheetState extends State<InventoryDisposalSheet> {
  static const _disposableStatuses = [
    'in_stock',
    'expired',
    'recalled',
    'quarantined',
  ];
  static final _quantityPattern = RegExp(
    r'^(0|[1-9][0-9]{0,9})(?:\.[0-9]{1,4})?$',
  );

  final _formKey = GlobalKey<FormState>();
  final _quantityController = TextEditingController();
  final _reasonController = TextEditingController();
  final _dispositionController = TextEditingController();
  // The witness-credentials dialog's fields belong to the STATE, not to the
  // dialog route. showDialog completes its future when the dialog is popped,
  // while the exit transition keeps rebuilding it for a few more frames —
  // disposing them at the await made every one of those frames throw
  // "A TextEditingController was used after being disposed".
  final _witnessEmployeeController = TextEditingController();
  final _witnessPasswordController = TextEditingController();
  final _witnessRequestAttempt = IdempotencyAttempt(
    'inventory-disposal-witness-request',
  );
  final _witnessApprovalAttempt = IdempotencyAttempt(
    'inventory-disposal-witness-approval',
  );
  final _disposalAttempt = IdempotencyAttempt('inventory-disposal');

  List<Map<String, dynamic>> _batches = const [];
  int? _selectedBatchId;
  bool _loading = true;
  bool _busy = false;
  String? _loadError;
  String? _workflowError;
  String? _witnessApprovalId;
  String? _witnessIntentFingerprint;
  String? _approvedWitnessName;
  bool _witnessApproved = false;

  int? get _itemId => _positiveInt(widget.item['id']);

  Map<String, dynamic>? get _selectedBatch {
    final id = _selectedBatchId;
    if (id == null) return null;
    for (final batch in _batches) {
      if (_positiveInt(batch['id'] ?? batch['inventory_batch_id']) == id) {
        return batch;
      }
    }
    return null;
  }

  bool get _requiresWitness {
    final batch = _selectedBatch;
    final schedule = (batch?['schedule_class'] ?? widget.item['schedule_class'])
        ?.toString()
        .trim()
        .toUpperCase();
    return schedule == 'X' ||
        batch?['is_narcotic'] == true ||
        widget.item['is_narcotic'] == true;
  }

  bool get _hasCurrentWitness {
    final intent = _validatedIntent();
    return intent != null &&
        _witnessApproved &&
        _witnessApprovalId != null &&
        _witnessIntentFingerprint == _fingerprint(intent);
  }

  @override
  void initState() {
    super.initState();
    _quantityController.addListener(_invalidateWitnessIfChanged);
    _reasonController.addListener(_invalidateWitnessIfChanged);
    _dispositionController.addListener(_invalidateWitnessIfChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _loadDisposableBatches();
    });
  }

  @override
  void dispose() {
    _quantityController.dispose();
    _reasonController.dispose();
    _dispositionController.dispose();
    _witnessEmployeeController.dispose();
    _witnessPasswordController.dispose();
    _witnessRequestAttempt.reset();
    _witnessApprovalAttempt.reset();
    _disposalAttempt.reset();
    super.dispose();
  }

  static int? _positiveInt(Object? raw) {
    final value = raw is num
        ? raw.toInt()
        : int.tryParse(raw?.toString().trim() ?? '');
    return value != null && value > 0 ? value : null;
  }

  String _fingerprint(Map<String, dynamic> intent) => jsonEncode(intent);

  void _clearWitness() {
    _witnessApprovalId = null;
    _witnessIntentFingerprint = null;
    _approvedWitnessName = null;
    _witnessApproved = false;
    _witnessRequestAttempt.reset();
    _witnessApprovalAttempt.reset();
  }

  void _invalidateWitnessIfChanged() {
    if (_witnessApprovalId == null) return;
    final intent = _validatedIntent();
    if (intent == null || _witnessIntentFingerprint != _fingerprint(intent)) {
      setState(_clearWitness);
    }
  }

  Future<void> _loadDisposableBatches() async {
    final itemId = _itemId;
    if (itemId == null) {
      setState(() {
        _loading = false;
        _loadError = AppStrings.of(context)
            .lookup('pharmacy.disposal.item_authority_missing');
      });
      return;
    }
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final loader =
          widget.loadBatches ??
          (int exactItemId, int facilityId, String status) =>
              PharmacyApiService.getInventoryBatches(
                itemId: exactItemId,
                facilityId: facilityId,
                status: status,
              );
      final pages = await Future.wait(
        _disposableStatuses.map(
          (status) => loader(itemId, widget.facilityId, status),
        ),
      );
      final byId = <int, Map<String, dynamic>>{};
      for (final batch in pages.expand((page) => page)) {
        final id = _positiveInt(batch['id'] ?? batch['inventory_batch_id']);
        if (id != null) byId[id] = batch;
      }
      final batches = byId.values.toList()
        ..sort((left, right) {
          final leftExpiry = left['expiry_date']?.toString() ?? '';
          final rightExpiry = right['expiry_date']?.toString() ?? '';
          final byExpiry = leftExpiry.compareTo(rightExpiry);
          if (byExpiry != 0) return byExpiry;
          return _positiveInt(left['id'])!
              .compareTo(_positiveInt(right['id'])!);
        });
      if (!mounted) return;
      setState(() {
        _batches = batches;
        if (!byId.containsKey(_selectedBatchId)) _selectedBatchId = null;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _loadError = _safeError(error);
      });
    }
  }

  Map<String, dynamic>? _validatedIntent() {
    final itemId = _itemId;
    final batchId = _selectedBatchId;
    final quantityText = _quantityController.text.trim();
    final reason = _reasonController.text.trim();
    final disposition = _dispositionController.text.trim();
    if (itemId == null ||
        batchId == null ||
        !_quantityPattern.hasMatch(quantityText) ||
        double.tryParse(quantityText) == 0 ||
        reason.isEmpty ||
        reason.length > 80 ||
        disposition.isEmpty ||
        disposition.length > 80) {
      return null;
    }
    return {
      'facility_id': widget.facilityId,
      'inventory_item_id': itemId,
      'inventory_batch_id': batchId,
      'quantity': double.parse(quantityText),
      'reason_code': reason,
      'disposition_method': disposition,
    };
  }

  String _safeError(Object error) {
    if (error is PharmacyApiException) {
      final code = error.code?.trim();
      return code == null || code.isEmpty
          ? error.message
          : '${error.message} ($code)';
    }
    return error.toString().replaceFirst('Exception: ', '');
  }

  bool _isDefinitiveWitnessError(Object error) {
    if (error is PharmacyApiException && error.statusCode < 500) return true;
    final message = error.toString().toLowerCase();
    return message.contains('expired') ||
        message.contains('consumed') ||
        message.contains('mismatch') ||
        message.contains('self') ||
        message.contains('credential') ||
        message.contains('role');
  }

  Future<_WitnessCredentials?> _collectWitnessCredentials() async {
    final employeeController = _witnessEmployeeController..clear();
    final passwordController = _witnessPasswordController..clear();
    final result = await showDialog<_WitnessCredentials>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        title: Text(
          AppStrings.of(context).lookup('pharmacy.disposal.witness_title'),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              AppStrings.of(context).lookup('pharmacy.disposal.witness_hint'),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const ValueKey('inventory-disposal-witness-employee-id'),
              controller: employeeController,
              textCapitalization: TextCapitalization.characters,
              decoration: InputDecoration(
                labelText: AppStrings.of(context)
                    .lookup('pharmacy.disposal.witness_employee_id'),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              key: const ValueKey('inventory-disposal-witness-password'),
              controller: passwordController,
              obscureText: true,
              decoration: InputDecoration(
                labelText: AppStrings.of(context)
                    .lookup('pharmacy.disposal.witness_password'),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: Text(AppStrings.of(context).lookup('action.cancel')),
          ),
          FilledButton(
            key: const ValueKey('inventory-disposal-witness-approve'),
            onPressed: () {
              final employeeId = employeeController.text.trim().toUpperCase();
              final password = passwordController.text;
              if (employeeId.isEmpty || password.length < 6) return;
              Navigator.pop(
                dialogContext,
                _WitnessCredentials(employeeId, password),
              );
            },
            child: Text(
              AppStrings.of(context)
                  .lookup('pharmacy.disposal.witness_approve'),
            ),
          ),
        ],
      ),
    );
    // Cleared, never disposed here — see the field declarations.
    employeeController.clear();
    passwordController.clear();
    return result;
  }

  Future<void> _requestOrApproveWitness() async {
    if (_busy || !_requiresWitness || !_formKey.currentState!.validate()) {
      return;
    }
    final intent = _validatedIntent();
    if (intent == null) return;
    final fingerprint = _fingerprint(intent);
    setState(() {
      _busy = true;
      _workflowError = null;
    });
    var approvalStage = false;
    try {
      var approvalId = _witnessIntentFingerprint == fingerprint
          ? _witnessApprovalId
          : null;
      if (approvalId == null) {
        final requester =
            widget.requestWitnessApproval ??
            PharmacyApiService.requestInventoryDisposalWitnessApproval;
        final pending = await requester(
          disposal: intent,
          idempotencyKey: _witnessRequestAttempt.keyFor(intent),
        );
        approvalId = pending['id']?.toString().trim();
        if (approvalId == null ||
            !RegExp(r'^[1-9][0-9]*$').hasMatch(approvalId)) {
          throw StateError('Witness approval id missing');
        }
        if (!mounted ||
            _fingerprint(_validatedIntent() ?? const {}) != fingerprint) {
          throw StateError(
            'Disposal changed while witness approval was pending',
          );
        }
        _witnessRequestAttempt.reset();
        setState(() {
          _witnessApprovalId = approvalId;
          _witnessIntentFingerprint = fingerprint;
          _approvedWitnessName = null;
          _witnessApproved = false;
        });
      }
      final credentials = await _collectWitnessCredentials();
      if (credentials == null || !mounted) return;
      approvalStage = true;
      final approver =
          widget.approveWitnessApproval ??
          PharmacyApiService.approveInventoryDisposalWitnessApproval;
      final approved = await approver(
        approvalId: approvalId,
        disposal: intent,
        employeeId: credentials.employeeId,
        password: credentials.password,
        idempotencyKey: _witnessApprovalAttempt.keyFor({
          'approval_id': approvalId,
          'disposal': intent,
          'employee_id': credentials.employeeId,
        }),
      );
      if (!mounted ||
          _fingerprint(_validatedIntent() ?? const {}) != fingerprint) {
        throw StateError('Disposal changed while witness approval was pending');
      }
      final witness = approved['witness'];
      _witnessApprovalAttempt.reset();
      setState(() {
        _approvedWitnessName = witness is Map
            ? witness['name']?.toString()
            : null;
        _witnessApproved = true;
      });
    } catch (error) {
      if (!mounted) return;
      if (_isDefinitiveWitnessError(error)) {
        if (approvalStage) {
          _witnessApprovalAttempt.reset();
        } else {
          _witnessRequestAttempt.reset();
        }
      }
      final lower = error.toString().toLowerCase();
      setState(() {
        _workflowError = _safeError(error);
        if (lower.contains('expired') ||
            lower.contains('consumed') ||
            lower.contains('mismatch') ||
            lower.contains('changed')) {
          _clearWitness();
        }
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _disposeBatch() async {
    if (_busy || !_formKey.currentState!.validate()) return;
    final intent = _validatedIntent();
    if (intent == null) return;
    if (_requiresWitness && !_hasCurrentWitness) {
      setState(() {
        _workflowError = AppStrings.of(context)
            .lookup('pharmacy.disposal.witness_required');
      });
      return;
    }
    final request = {
      ...intent,
      if (_requiresWitness) 'witness_approval_id': _witnessApprovalId,
    };
    setState(() {
      _busy = true;
      _workflowError = null;
    });
    try {
      final disposer =
          widget.disposeBatch ?? PharmacyApiService.disposeInventoryBatch;
      await disposer(
        disposal: request,
        idempotencyKey: _disposalAttempt.keyFor(request),
      );
      _disposalAttempt.reset();
      if (!mounted) return;
      Navigator.pop(context, true);
    } catch (error) {
      if (!mounted) return;
      if (error is PharmacyApiException && error.statusCode < 500) {
        _disposalAttempt.reset();
      }
      final lower = error.toString().toLowerCase();
      setState(() {
        _workflowError = _safeError(error);
        if (lower.contains('witness') &&
            (lower.contains('expired') ||
                lower.contains('consumed') ||
                lower.contains('mismatch') ||
                lower.contains('changed'))) {
          _clearWitness();
        }
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _batchLabel(Map<String, dynamic> batch) {
    final s = AppStrings.of(context);
    return s.format('pharmacy.disposal.batch_option', {
      'batch': batch['batch_number'] ?? '-',
      'lot': batch['lot_number'] ?? '-',
      'status': batch['status'] ?? '-',
      'quantity': batch['remaining_quantity'] ?? '-',
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final itemName =
        widget.item['display_name']?.toString() ??
        s.lookup('s4.lib.pharmacy.unnamed_item');
    final batch = _selectedBatch;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          top: 20,
          bottom: MediaQuery.of(context).viewInsets.bottom + 20,
        ),
        child: SingleChildScrollView(
          child: Form(
            key: _formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        s.lookup('pharmacy.disposal.title'),
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    IconButton(
                      onPressed: _busy ? null : () => Navigator.pop(context),
                      icon: const Icon(Icons.close),
                      tooltip: s.lookup('action.close'),
                    ),
                  ],
                ),
                Text(
                  itemName,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 6),
                Text(
                  s.lookup('pharmacy.disposal.authority_hint'),
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
                ),
                const SizedBox(height: 16),
                if (_loading)
                  const Center(child: CircularProgressIndicator())
                else if (_loadError != null) ...[
                  Text(
                    _loadError!,
                    style: const TextStyle(color: AppTheme.errorRed),
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    onPressed: _loadDisposableBatches,
                    icon: const Icon(Icons.refresh),
                    label: Text(s.lookup('action.retry')),
                  ),
                ] else if (_batches.isEmpty)
                  Text(s.lookup('pharmacy.disposal.no_eligible_batches'))
                else ...[
                  DropdownButtonFormField<int>(
                    key: const ValueKey('inventory-disposal-batch'),
                    initialValue: _selectedBatchId,
                    isExpanded: true,
                    decoration: InputDecoration(
                      labelText: s.lookup('pharmacy.disposal.batch'),
                    ),
                    items: _batches
                        .map(
                          (entry) => DropdownMenuItem<int>(
                            value: _positiveInt(entry['id']),
                            child: Text(
                              _batchLabel(entry),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        )
                        .toList(growable: false),
                    validator: (value) => value == null
                        ? s.lookup('pharmacy.disposal.batch_required')
                        : null,
                    onChanged: _busy
                        ? null
                        : (value) => setState(() {
                            _selectedBatchId = value;
                            _clearWitness();
                          }),
                  ),
                  if (batch != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      s.format('pharmacy.disposal.batch_constraints', {
                        'supplier': batch['supplier_id'] ?? '-',
                        'status': batch['status'] ?? '-',
                        'expiry': batch['expiry_date'] ?? '-',
                        'quantity': batch['remaining_quantity'] ?? '-',
                      }),
                      style: TextStyle(
                        color: AppTheme.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                  ],
                  const SizedBox(height: 12),
                  TextFormField(
                    key: const ValueKey('inventory-disposal-quantity'),
                    controller: _quantityController,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    decoration: InputDecoration(
                      labelText: s.lookup('pharmacy.disposal.quantity'),
                      helperText: s.lookup('pharmacy.disposal.quantity_hint'),
                    ),
                    validator: (value) {
                      final raw = value?.trim() ?? '';
                      final quantity = double.tryParse(raw);
                      if (!_quantityPattern.hasMatch(raw) || quantity == 0) {
                        return s.lookup('pharmacy.disposal.quantity_invalid');
                      }
                      final remaining = _selectedBatch == null
                          ? null
                          : double.tryParse(
                              '${_selectedBatch!['remaining_quantity']}',
                            );
                      if (remaining != null &&
                          quantity != null &&
                          quantity > remaining) {
                        return s.format(
                          'pharmacy.disposal.quantity_exceeds_stock',
                          {'quantity': remaining},
                        );
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    key: const ValueKey('inventory-disposal-reason'),
                    controller: _reasonController,
                    maxLength: 80,
                    decoration: InputDecoration(
                      labelText: s.lookup('pharmacy.disposal.reason_code'),
                      hintText: s.lookup('pharmacy.disposal.reason_hint'),
                    ),
                    validator: (value) => value == null || value.trim().isEmpty
                        ? s.lookup('pharmacy.disposal.reason_required')
                        : null,
                  ),
                  TextFormField(
                    key: const ValueKey('inventory-disposal-method'),
                    controller: _dispositionController,
                    maxLength: 80,
                    decoration: InputDecoration(
                      labelText: s.lookup('pharmacy.disposal.method'),
                      hintText: s.lookup('pharmacy.disposal.method_hint'),
                    ),
                    validator: (value) => value == null || value.trim().isEmpty
                        ? s.lookup('pharmacy.disposal.method_required')
                        : null,
                  ),
                  if (_requiresWitness) ...[
                    const SizedBox(height: 6),
                    Card(
                      color: AppTheme.warningOnSurface.withValues(alpha: 0.08),
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Text(
                              s.lookup('pharmacy.disposal.controlled_warning'),
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              _hasCurrentWitness
                                  ? s.format(
                                      'pharmacy.disposal.witness_approved_by',
                                      {
                                        'name':
                                            _approvedWitnessName ??
                                            s.lookup(
                                              'pharmacy.disposal.witness_staff',
                                            ),
                                      },
                                    )
                                  : s.lookup(
                                      'pharmacy.disposal.witness_pending',
                                    ),
                            ),
                            const SizedBox(height: 8),
                            OutlinedButton.icon(
                              key: const ValueKey(
                                'inventory-disposal-request-witness',
                              ),
                              onPressed: _busy
                                  ? null
                                  : _requestOrApproveWitness,
                              icon: const Icon(Icons.verified_user_outlined),
                              label: Text(
                                s.lookup(
                                  _hasCurrentWitness
                                      ? 'pharmacy.disposal.witness_replace'
                                      : 'pharmacy.disposal.witness_request',
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                  if (_workflowError != null) ...[
                    const SizedBox(height: 10),
                    Text(
                      _workflowError!,
                      key: const ValueKey('inventory-disposal-error'),
                      style: const TextStyle(color: AppTheme.errorRed),
                    ),
                  ],
                  const SizedBox(height: 16),
                  FilledButton.icon(
                    key: const ValueKey('inventory-disposal-submit'),
                    onPressed:
                        _busy || (_requiresWitness && !_hasCurrentWitness)
                        ? null
                        : _disposeBatch,
                    icon: _busy
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.delete_sweep_outlined),
                    label: Text(s.lookup('pharmacy.disposal.submit')),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _WitnessCredentials {
  const _WitnessCredentials(this.employeeId, this.password);

  final String employeeId;
  final String password;
}
