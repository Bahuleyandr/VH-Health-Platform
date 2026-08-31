import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/services/idempotency_attempt_registry.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/online_only_action_state.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';
import '../services/cath_lab_api_service.dart';

typedef CathInventoryReconciliationRoleLoader = Future<String> Function();
typedef CathInventoryReconciliationLoader =
    Future<CathInventoryReconciliation> Function(String caseId, String usageId);
typedef CathInventoryReconciler =
    Future<CathInventoryReconciliationResult> Function(
      String caseId,
      String usageId, {
      required String idempotencyKey,
    });

final IdempotencyAttemptRegistry _sharedCathInventoryAttempts =
    IdempotencyAttemptRegistry();

@visibleForTesting
const cathInventoryReconciliationRoles = <String>{
  'PHARMACIST',
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
  'ADMIN',
  'SUPER_ADMIN',
};

bool cathInventoryReconciliationCanOpen(String role) =>
    cathInventoryReconciliationRoles.contains(role.trim().toUpperCase());

@visibleForTesting
const cathInventoryReconciliationOperatorRoles = <String>{
  'PHARMACIST',
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
};

bool cathInventoryReconciliationCanReconcile(String role) =>
    cathInventoryReconciliationOperatorRoles.contains(
      role.trim().toUpperCase(),
    );

@visibleForTesting
String localizedCathInventoryStatus(AppStrings strings, Object? value) {
  final code = value?.toString().trim().toLowerCase() ?? '';
  const supported = {'insufficient_stock', 'decremented'};
  return strings.lookup(
    supported.contains(code)
        ? 'med03.cath_inventory.status.$code'
        : 'med03.cath_inventory.status.unknown',
  );
}

@visibleForTesting
String localizedCathInventoryTaskStatus(AppStrings strings, Object? value) {
  final code = value?.toString().trim().toLowerCase() ?? '';
  const supported = {'open', 'in_progress', 'overdue', 'completed'};
  return strings.lookup(
    supported.contains(code)
        ? 'med03.cath_inventory.task_status.$code'
        : 'med03.cath_inventory.task_status.unknown',
  );
}

@visibleForTesting
String localizedCathInventorySlaStatus(AppStrings strings, Object? value) {
  final code = value?.toString().trim().toLowerCase() ?? '';
  const supported = {
    'active',
    'breached',
    'escalated',
    'completed',
    'cancelled',
  };
  return strings.lookup(
    supported.contains(code)
        ? 'med03.cath_inventory.sla_status.$code'
        : 'med03.cath_inventory.sla_status.unknown',
  );
}

@visibleForTesting
String localizedCathInventoryWarning(AppStrings strings, Object? value) {
  final warning = value?.toString().trim() ?? '';
  final lower = warning.toLowerCase();
  late final String code;
  if (RegExp(
        r'^insufficient stock: documented [0-9]+(?:\.[0-9]+)?, decremented [0-9]+(?:\.[0-9]+)?$',
      ).hasMatch(lower) ||
      RegExp(
        r'^insufficient stock in exact batch: requested [0-9]+(?:\.[0-9]+)?, available [0-9]+(?:\.[0-9]+)?; inventory reconciliation will be materialized after the clinical record commits$',
      ).hasMatch(lower)) {
    code = 'insufficient_stock';
  } else if (lower ==
      'exact inventory batch is expired; clinical usage was saved without a stock decrement') {
    code = 'batch_expired';
  } else if (lower ==
      'exact inventory batch quantity is invalid; clinical usage was saved without a stock decrement') {
    code = 'quantity_invalid';
  } else if (const {
    'documented batch/lot/expiry does not match the selected inventory batch; clinical usage was saved without a stock decrement',
    'inventory batch lineage changed before decrement; clinical usage was saved without a stock decrement',
  }.contains(lower)) {
    code = 'lineage_mismatch';
  } else if (lower ==
      'documented inventory lineage is incomplete; clinical usage was saved without a stock decrement') {
    code = 'lineage_incomplete';
  } else if (lower ==
      'controlled stock requires the statutory dispensing workflow; no cath inventory movement was recorded') {
    code = 'controlled_stock';
  } else if (const {
    'catalog item is not linked to inventory; clinical usage was saved without a stock decrement',
    'catalog item is not linked to inventory; selected batch was recorded as manual lineage without a stock decrement',
  }.contains(lower)) {
    code = 'inventory_not_linked';
  } else if (const {
        'selected inventory batch is outside this tenant or catalog item; clinical usage was saved without a stock decrement',
        'documented batch/lot/expiry matches multiple inventory batches; clinical usage was saved without a stock decrement',
        'documented batch/lot/expiry was not found in inventory; clinical usage was saved without a stock decrement',
        'exact inventory batch could not be resolved; clinical usage was saved without a stock decrement',
        'exact inventory batch is unavailable; clinical usage was saved without a stock decrement',
      }.contains(lower) ||
      RegExp(
        r'^exact inventory batch is [a-z0-9_-]+; clinical usage was saved without a stock decrement$',
      ).hasMatch(lower)) {
    code = 'batch_unavailable';
  } else {
    code = 'unknown';
  }
  return strings.lookup('med03.cath_inventory.warning.$code');
}

class CathInventoryReconciliationScreen extends StatefulWidget {
  const CathInventoryReconciliationScreen({
    super.key,
    required this.caseId,
    required this.consumableUsageId,
    this.loadRole,
    this.loadReconciliation,
    this.reconcileInventory,
    this.attempts,
  });

  final String caseId;
  final String consumableUsageId;
  final CathInventoryReconciliationRoleLoader? loadRole;
  final CathInventoryReconciliationLoader? loadReconciliation;
  final CathInventoryReconciler? reconcileInventory;
  final IdempotencyAttemptRegistry? attempts;

  @override
  State<CathInventoryReconciliationScreen> createState() =>
      _CathInventoryReconciliationScreenState();
}

class _CathInventoryReconciliationScreenState
    extends State<CathInventoryReconciliationScreen> {
  late final IdempotencyAttemptRegistry _attempts;
  CathInventoryReconciliation? _reconciliation;
  bool _loading = true;
  bool _submitting = false;
  bool _ambiguousOutcome = false;
  bool _authorized = false;
  bool _canReconcile = false;
  String? _errorKey;
  String? _noticeKey;

  String get _attemptScope =>
      'cath-inventory-reconcile:${widget.caseId}:${widget.consumableUsageId}';

  String? get _caseId => _positiveInteger(widget.caseId);
  String? get _usageId => _positiveInteger(widget.consumableUsageId);

  CathInventoryReconciliationLoader get _loadReconciliation =>
      widget.loadReconciliation ??
      CathLabApiService.fetchInventoryReconciliation;

  CathInventoryReconciler get _reconcileInventory =>
      widget.reconcileInventory ??
      CathLabApiService.reconcileConsumableInventory;

  @override
  void initState() {
    super.initState();
    _attempts = widget.attempts ?? _sharedCathInventoryAttempts;
    _ambiguousOutcome = _attempts.current(_attemptScope) != null;
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    final caseId = _caseId;
    final usageId = _usageId;
    if (caseId == null || usageId == null) {
      if (mounted) {
        setState(() {
          _loading = false;
          _errorKey = 'med03.cath_inventory.invalid_target';
        });
      }
      return;
    }
    try {
      final role = await (widget.loadRole?.call() ?? AuthService.getRole());
      final authorized = cathInventoryReconciliationCanOpen(role);
      final canReconcile = cathInventoryReconciliationCanReconcile(role);
      if (!mounted) return;
      if (!authorized) {
        setState(() {
          _authorized = false;
          _canReconcile = false;
          _loading = false;
          _errorKey = 'med03.cath_inventory.access_denied';
        });
        return;
      }
      _authorized = true;
      _canReconcile = canReconcile;
      await _refreshAuthoritative(showLoading: false);
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _errorKey = 'med03.cath_inventory.load_failed';
      });
    }
  }

  Future<void> _refreshAuthoritative({bool showLoading = true}) async {
    final caseId = _caseId;
    final usageId = _usageId;
    if (!_authorized || caseId == null || usageId == null) return;
    if (showLoading) {
      setState(() {
        _loading = true;
        _errorKey = null;
      });
    }
    try {
      final reconciliation = await _loadReconciliation(caseId, usageId);
      if (!reconciliation.matchesTarget(caseId: caseId, usageId: usageId)) {
        throw const _CathTargetMismatch();
      }
      if (!mounted) return;
      if (reconciliation.isCompleted) {
        _attempts.complete(_attemptScope);
        _ambiguousOutcome = false;
      }
      setState(() {
        _reconciliation = reconciliation;
        _loading = false;
        _errorKey = null;
      });
    } on _CathTargetMismatch {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _errorKey = 'med03.cath_inventory.target_mismatch';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _errorKey = 'med03.cath_inventory.load_failed';
      });
    }
  }

  Future<void> _confirmAndReconcile() async {
    final reconciliation = _reconciliation;
    if (_submitting ||
        !_canReconcile ||
        reconciliation == null ||
        reconciliation.isCompleted ||
        !reconciliation.actionable ||
        !OnlineOnlyActionGuard.require(context)) {
      return;
    }
    final strings = AppStrings.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(strings.lookup('med03.cath_inventory.confirm_title')),
        content: Text(strings.lookup('med03.cath_inventory.confirm_body')),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(strings.actionCancel),
          ),
          FilledButton(
            key: const ValueKey('cath-inventory-reconcile-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(strings.lookup('med03.cath_inventory.confirm_action')),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await _submitReconciliation();
  }

  Future<void> _submitReconciliation() async {
    final caseId = _caseId;
    final usageId = _usageId;
    if (caseId == null || usageId == null || _submitting || !_canReconcile) {
      return;
    }
    setState(() {
      _submitting = true;
      _errorKey = null;
      _noticeKey = null;
    });
    final idempotencyKey = _attempts.keyFor(_attemptScope, null);
    try {
      final command = await _reconcileInventory(
        caseId,
        usageId,
        idempotencyKey: idempotencyKey,
      );
      if (!command.reconciliation.matchesTarget(
        caseId: caseId,
        usageId: usageId,
      )) {
        throw const _CathTargetMismatch();
      }
      final authoritative = await _loadReconciliation(caseId, usageId);
      if (!authoritative.matchesTarget(caseId: caseId, usageId: usageId)) {
        throw const _CathTargetMismatch();
      }
      if (command.outcome == 'completed' && !authoritative.isCompleted) {
        throw const _CathUnconfirmedOutcome();
      }
      if (!mounted) return;
      _attempts.complete(_attemptScope);
      _ambiguousOutcome = false;
      setState(() {
        _reconciliation = authoritative;
        _submitting = false;
        _noticeKey = authoritative.isCompleted
            ? 'med03.cath_inventory.completed'
            : 'med03.cath_inventory.still_insufficient';
      });
    } on _CathTargetMismatch {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _errorKey = 'med03.cath_inventory.target_mismatch';
      });
    } catch (_) {
      await _recoverAfterAmbiguousCommand(caseId, usageId);
    }
  }

  Future<void> _recoverAfterAmbiguousCommand(
    String caseId,
    String usageId,
  ) async {
    try {
      final authoritative = await _loadReconciliation(caseId, usageId);
      if (!authoritative.matchesTarget(caseId: caseId, usageId: usageId)) {
        throw const _CathTargetMismatch();
      }
      if (!mounted) return;
      if (authoritative.isCompleted) {
        _attempts.complete(_attemptScope);
        setState(() {
          _reconciliation = authoritative;
          _submitting = false;
          _ambiguousOutcome = false;
          _errorKey = null;
          _noticeKey = 'med03.cath_inventory.completed';
        });
        return;
      }
      setState(() {
        _reconciliation = authoritative;
        _submitting = false;
        _ambiguousOutcome = true;
        _errorKey = 'med03.cath_inventory.response_unconfirmed';
      });
    } on _CathTargetMismatch {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _ambiguousOutcome = true;
        _errorKey = 'med03.cath_inventory.target_mismatch';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _ambiguousOutcome = true;
        _errorKey = 'med03.cath_inventory.response_unconfirmed';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return StaffScaffold(
      title: strings.lookup('med03.cath_inventory.title'),
      actions: [
        IconButton(
          key: const ValueKey('cath-inventory-refresh'),
          onPressed: _authorized && !_loading && !_submitting
              ? _refreshAuthoritative
              : null,
          tooltip: strings.lookup('med03.cath_inventory.refresh_action'),
          icon: const Icon(Icons.refresh),
        ),
      ],
      body: ConstrainedContent(maxWidth: 920, child: _buildBody(strings)),
    );
  }

  Widget _buildBody(AppStrings strings) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_errorKey != null && _reconciliation == null) {
      return _CenteredMessage(
        icon: Icons.inventory_2_outlined,
        message: strings.lookup(_errorKey!),
        retry: _authorized ? _refreshAuthoritative : null,
        retryLabel: strings.lookup('med03.cath_inventory.refresh_action'),
      );
    }
    final reconciliation = _reconciliation;
    if (reconciliation == null) {
      return _CenteredMessage(
        icon: Icons.inventory_2_outlined,
        message: strings.lookup('med03.cath_inventory.load_failed'),
        retry: _authorized ? _refreshAuthoritative : null,
        retryLabel: strings.lookup('med03.cath_inventory.refresh_action'),
      );
    }
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(
          strings.lookup('med03.cath_inventory.summary'),
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                _EvidenceRow(
                  label: strings.lookup('med03.cath_inventory.case_id'),
                  value: reconciliation.caseId,
                ),
                _EvidenceRow(
                  label: strings.lookup('med03.cath_inventory.usage_id'),
                  value: reconciliation.usageId,
                ),
                _EvidenceRow(
                  label: strings.lookup('med03.cath_inventory.patient_uid'),
                  value: _valueOrUnknown(strings, reconciliation.patientUid),
                ),
                _EvidenceRow(
                  label: strings.lookup('med03.cath_inventory.item'),
                  value: _valueOrUnknown(strings, reconciliation.itemName),
                ),
                _EvidenceRow(
                  label: strings.lookup(
                    'med03.cath_inventory.inventory_item_id',
                  ),
                  value: _integerOrUnknown(
                    strings,
                    reconciliation.inventoryItemId,
                  ),
                ),
                _EvidenceRow(
                  label: strings.lookup(
                    'med03.cath_inventory.inventory_batch_id',
                  ),
                  value: _integerOrUnknown(
                    strings,
                    reconciliation.inventoryBatchId,
                  ),
                ),
                _EvidenceRow(
                  label: strings.lookup('med03.cath_inventory.batch_number'),
                  value: _valueOrUnknown(strings, reconciliation.batchNumber),
                ),
                _EvidenceRow(
                  label: strings.lookup(
                    'med03.cath_inventory.documented_quantity',
                  ),
                  value: _quantity(reconciliation.documentedQuantity),
                ),
                _EvidenceRow(
                  label: strings.lookup(
                    'med03.cath_inventory.decremented_quantity',
                  ),
                  value: _quantity(reconciliation.decrementedQuantity),
                ),
                _EvidenceRow(
                  label: strings.lookup(
                    'med03.cath_inventory.remaining_quantity',
                  ),
                  value: _quantity(reconciliation.remainingQuantity),
                ),
                _EvidenceRow(
                  label: strings.lookup('med03.cath_inventory.status'),
                  value: localizedCathInventoryStatus(
                    strings,
                    reconciliation.inventoryDecrementStatus,
                  ),
                ),
                _EvidenceRow(
                  label: strings.lookup('med03.cath_inventory.task_status'),
                  value: localizedCathInventoryTaskStatus(
                    strings,
                    reconciliation.taskStatus,
                  ),
                ),
                _EvidenceRow(
                  label: strings.lookup('med03.cath_inventory.sla_status'),
                  value: localizedCathInventorySlaStatus(
                    strings,
                    reconciliation.slaStatus,
                  ),
                ),
                _EvidenceRow(
                  label: strings.lookup('med03.cath_inventory.due_at'),
                  value: reconciliation.dueAt == null
                      ? strings.lookup('med03.cath_inventory.value_unknown')
                      : DateFormat.yMMMd(
                          Localizations.localeOf(context).toLanguageTag(),
                        ).add_jm().format(reconciliation.dueAt!),
                ),
              ],
            ),
          ),
        ),
        if (reconciliation.inventoryWarning.isNotEmpty) ...[
          const SizedBox(height: 12),
          Card(
            color: AppTheme.warningAmber.withValues(alpha: 0.1),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.warning_amber_outlined),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      localizedCathInventoryWarning(
                        strings,
                        reconciliation.inventoryWarning,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
        if (_noticeKey != null) ...[
          const SizedBox(height: 12),
          _StatusBanner(
            message: strings.lookup(_noticeKey!),
            color: reconciliation.isCompleted
                ? AppTheme.successGreen
                : AppTheme.warningAmber,
          ),
        ],
        if (_errorKey != null) ...[
          const SizedBox(height: 12),
          _StatusBanner(
            message: strings.lookup(_errorKey!),
            color: AppTheme.errorRed,
          ),
        ],
        const SizedBox(height: 18),
        if (reconciliation.isCompleted)
          _StatusBanner(
            message: strings.lookup('med03.cath_inventory.completed'),
            color: AppTheme.successGreen,
          )
        else if (!_canReconcile)
          _StatusBanner(
            message: strings.lookup('med03.cath_inventory.coverage_only'),
            color: AppTheme.warningAmber,
          )
        else if (!reconciliation.actionable)
          _StatusBanner(
            message: strings.lookup('med03.cath_inventory.not_actionable'),
            color: AppTheme.warningAmber,
          )
        else
          OnlineOnlyActionState(
            builder: (context, isOnline, offlineMessage) => Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                FilledButton.icon(
                  key: const ValueKey('cath-inventory-reconcile'),
                  onPressed: isOnline && !_submitting
                      ? _confirmAndReconcile
                      : null,
                  icon: _submitting
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.inventory_2_outlined),
                  label: Text(
                    strings.lookup(
                      _submitting
                          ? 'med03.cath_inventory.reconciling'
                          : _ambiguousOutcome
                          ? 'med03.cath_inventory.retry_same_attempt'
                          : 'med03.cath_inventory.reconcile_action',
                    ),
                  ),
                ),
                if (!isOnline) ...[
                  const SizedBox(height: 8),
                  Text(offlineMessage, textAlign: TextAlign.center),
                ],
              ],
            ),
          ),
      ],
    );
  }
}

class _EvidenceRow extends StatelessWidget {
  const _EvidenceRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 230,
            child: Text(
              label,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(child: SelectableText(value)),
        ],
      ),
    );
  }
}

class _StatusBanner extends StatelessWidget {
  const _StatusBanner({required this.message, required this.color});

  final String message;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(message),
    );
  }
}

class _CenteredMessage extends StatelessWidget {
  const _CenteredMessage({
    required this.icon,
    required this.message,
    required this.retry,
    required this.retryLabel,
  });

  final IconData icon;
  final String message;
  final VoidCallback? retry;
  final String retryLabel;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 46),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            if (retry != null) ...[
              const SizedBox(height: 14),
              OutlinedButton.icon(
                onPressed: retry,
                icon: const Icon(Icons.refresh),
                label: Text(retryLabel),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _CathTargetMismatch implements Exception {
  const _CathTargetMismatch();
}

class _CathUnconfirmedOutcome implements Exception {
  const _CathUnconfirmedOutcome();
}

const _maximumSignedBigInt = '9223372036854775807';

String? _positiveInteger(String value) {
  if (!RegExp(r'^[1-9][0-9]*$').hasMatch(value) ||
      value.length > _maximumSignedBigInt.length ||
      (value.length == _maximumSignedBigInt.length &&
          value.compareTo(_maximumSignedBigInt) > 0)) {
    return null;
  }
  return value;
}

String _valueOrUnknown(AppStrings strings, String value) => value.isEmpty
    ? strings.lookup('med03.cath_inventory.value_unknown')
    : value;

String _integerOrUnknown(AppStrings strings, String value) => value.isEmpty
    ? strings.lookup('med03.cath_inventory.value_unknown')
    : value;

String _quantity(double value) => value == value.roundToDouble()
    ? value.toInt().toString()
    : value
          .toStringAsFixed(4)
          .replaceFirst(RegExp(r'0+$'), '')
          .replaceFirst(RegExp(r'\.$'), '');
