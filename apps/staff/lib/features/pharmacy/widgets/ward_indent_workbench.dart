import 'package:flutter/material.dart';

import '../../../core/config/role_config.dart';
import '../../../core/config/ward_indent_role_contract.dart';
import '../../../core/models/composition_alternatives.dart';
import '../../../core/services/idempotency_attempt_registry.dart';
import '../../../core/widgets/online_only_action_state.dart';
import '../../../l10n/app_strings.dart';
import '../models/ward_indent_models.dart';
import '../services/ward_indent_gateway.dart';
import '../services/ward_indent_role_policy.dart';

enum WardIndentWorklistFilter { open, terminal, owned, overdue }

final IdempotencyAttemptRegistry _sharedWardIndentAttempts =
    IdempotencyAttemptRegistry();

class WardIndentWorkbench extends StatefulWidget {
  const WardIndentWorkbench({
    super.key,
    required this.rawRole,
    required this.role,
    this.initialIndentId,
    this.gateway = const ApiWardIndentGateway(),
    this.attempts,
  });

  final String rawRole;
  final StaffRole role;
  final int? initialIndentId;
  final WardIndentGateway gateway;
  final IdempotencyAttemptRegistry? attempts;

  @override
  State<WardIndentWorkbench> createState() => _WardIndentWorkbenchState();
}

class _WardIndentWorkbenchState extends State<WardIndentWorkbench> {
  static const _pageSize = 100;
  static const _reconciliationDispositions = [
    'transit_shortage',
    'ward_count_variance',
    'damaged_in_transit',
    'documented_exception',
  ];

  List<WardIndent> _indents = const [];
  WardIndent? _selected;
  WardIndentWorklistFilter _filter = WardIndentWorklistFilter.open;
  bool _loading = true;
  bool _loadingMore = false;
  bool _hasMore = false;
  bool _detailLoading = false;
  bool _mutating = false;
  bool _showNarrowDetail = false;
  String? _loadError;
  String? _actionError;
  DateTime? _nextBeforeRequestedAt;
  int? _nextBeforeId;
  int _loadGeneration = 0;
  late final IdempotencyAttemptRegistry _attempts;

  @override
  void initState() {
    super.initState();
    _attempts = widget.attempts ?? _sharedWardIndentAttempts;
    _loadWorkbench();
  }

  @override
  void didUpdateWidget(covariant WardIndentWorkbench oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.initialIndentId != widget.initialIndentId ||
        oldWidget.rawRole != widget.rawRole) {
      _loadWorkbench();
    }
  }

  List<WardIndent> get _filteredIndents {
    final roleCode = WardIndentRoleContract.canonicalRoleCode(
      widget.rawRole,
      widget.role,
    );
    return _indents
        .where((indent) {
          return switch (_filter) {
            WardIndentWorklistFilter.open => !indent.isTerminal,
            WardIndentWorklistFilter.terminal => indent.isTerminal,
            WardIndentWorklistFilter.owned =>
              !indent.isTerminal && indent.ownerRoleCodes.contains(roleCode),
            WardIndentWorklistFilter.overdue =>
              !indent.isTerminal && indent.isOverdue,
          };
        })
        .toList(growable: false);
  }

  Future<void> _loadWorkbench() async {
    final generation = ++_loadGeneration;
    final requestedFilter = _filter;
    if (mounted) {
      setState(() {
        _loading = true;
        _loadingMore = false;
        _loadError = null;
      });
    }
    try {
      final page = await widget.gateway.listIndents(
        worklist: requestedFilter.name,
        limit: _pageSize,
      );
      final targetId = widget.initialIndentId ?? _selected?.id;
      WardIndent? detail;
      if (targetId != null && targetId > 0) {
        detail = await widget.gateway.getIndent(targetId);
      }
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        _indents = _replaceOrAdd(page.items, detail);
        _selected = detail;
        _showNarrowDetail = detail != null && widget.initialIndentId != null;
        _hasMore = page.hasMore;
        _nextBeforeRequestedAt = page.nextBeforeRequestedAt;
        _nextBeforeId = page.nextBeforeId;
        _loading = false;
      });
    } catch (error) {
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        _loadError = _errorText(error);
        _loading = false;
      });
    }
  }

  void _selectFilter(WardIndentWorklistFilter filter) {
    if (_filter == filter) return;
    setState(() {
      _filter = filter;
      _indents = const [];
      _hasMore = false;
      _nextBeforeRequestedAt = null;
      _nextBeforeId = null;
      _showNarrowDetail = false;
    });
    _loadWorkbench();
  }

  Future<void> _loadMore() async {
    final beforeRequestedAt = _nextBeforeRequestedAt;
    final beforeId = _nextBeforeId;
    if (!_hasMore ||
        _loadingMore ||
        beforeRequestedAt == null ||
        beforeId == null) {
      return;
    }
    final generation = _loadGeneration;
    final requestedFilter = _filter;
    setState(() {
      _loadingMore = true;
      _loadError = null;
    });
    try {
      final page = await widget.gateway.listIndents(
        worklist: requestedFilter.name,
        beforeRequestedAt: beforeRequestedAt,
        beforeId: beforeId,
        limit: _pageSize,
      );
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        _indents = _appendUnique(_indents, page.items);
        _hasMore = page.hasMore;
        _nextBeforeRequestedAt = page.nextBeforeRequestedAt;
        _nextBeforeId = page.nextBeforeId;
        _loadingMore = false;
      });
    } catch (error) {
      if (!mounted || generation != _loadGeneration) return;
      setState(() {
        _loadError = _errorText(error);
        _loadingMore = false;
      });
    }
  }

  Future<void> _openIndent(WardIndent indent) async {
    setState(() {
      _detailLoading = true;
      _actionError = null;
    });
    try {
      final detail = await widget.gateway.getIndent(indent.id);
      if (!mounted) return;
      setState(() {
        _selected = detail;
        _indents = _replaceOrAdd(_indents, detail);
        _showNarrowDetail = true;
        _detailLoading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _actionError = _errorText(error);
        _detailLoading = false;
      });
    }
  }

  Future<WardIndent?> _refreshSelected() async {
    final selected = _selected;
    if (selected == null) return null;
    final fresh = await widget.gateway.getIndent(selected.id);
    if (mounted) {
      setState(() {
        _selected = fresh;
        _indents = _replaceOrAdd(_indents, fresh);
      });
    }
    return fresh;
  }

  void _acceptMutation(WardIndent result) {
    setState(() {
      _selected = result;
      _indents = _replaceOrAdd(_indents, result);
      _actionError = null;
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          AppStrings.of(context).format('ward_indent.action.completed', {
            'number': result.indentNumber,
          }),
        ),
      ),
    );
  }

  Future<void> _mutate(
    WardIndentAction action,
    Map<String, dynamic> payload,
  ) async {
    final indent = _selected;
    if (indent == null || _mutating) return;
    if (!OnlineOnlyActionGuard.require(context)) return;
    final attemptScope = _attemptScope(indent.id, action.apiPath);
    final attemptPayload = {
      ...payload,
      'expected_version': indent.stateVersion,
    };
    final intentKey = _attempts.keyFor(attemptScope, attemptPayload);
    setState(() {
      _mutating = true;
      _actionError = null;
    });
    try {
      final result = await widget.gateway.mutateIndent(
        indent,
        action,
        payload: payload,
        idempotencyKey: intentKey,
      );
      _attempts.complete(attemptScope);
      if (!mounted) return;
      _acceptMutation(result);
    } catch (error) {
      var message = _errorText(error);
      try {
        final fresh = await widget.gateway.getIndent(indent.id);
        if (mounted) {
          setState(() {
            _selected = fresh;
            _indents = _replaceOrAdd(_indents, fresh);
          });
          message = AppStrings.of(context).format(
            'ward_indent.error.refreshed_after_failure',
            {'error': message, 'version': fresh.stateVersion},
          );
        }
      } catch (_) {
        // Preserve the mutation error when the authoritative refresh also
        // fails. The user can retry the visible refresh action.
      }
      if (mounted) setState(() => _actionError = message);
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
  }

  Future<void> _handleAction(WardIndentAction action) async {
    final indent = _selected;
    if (indent == null || _mutating) return;
    final s = AppStrings.of(context);
    final actionLabel = _actionLabel(s, action);

    switch (action) {
      case WardIndentAction.reserve:
      case WardIndentAction.approve:
      case WardIndentAction.issue:
        if (!await _confirm(actionLabel)) return;
        if (action == WardIndentAction.reserve) {
          final selections = await _collectInventorySelections({
            for (final item in indent.items) item.id: item.quantityRequested,
          });
          if (selections == null) return;
          await _mutate(action, {'inventory_selections': selections});
        } else {
          await _mutate(action, const {});
        }
        return;
      case WardIndentAction.approveSubstitution:
        if (!await _confirm(actionLabel)) return;
        final substitutionTargets = {
          for (final item in indent.items)
            if (item.substitutionStatus == 'pending')
              item.id: item.proposedQuantity ?? item.quantityRequested,
        };
        final substitutionSelections = await _collectInventorySelections(
          substitutionTargets,
          useProposedCatalog: true,
        );
        if (substitutionSelections == null) return;
        await _mutate(action, {'inventory_selections': substitutionSelections});
        return;
      case WardIndentAction.shortSupply:
        final reason = await _askReason(actionLabel);
        if (reason == null) return;
        final quantities = await _askQuantities(
          title: s.lookup('ward_indent.quantity.available'),
          fieldName: 'quantity_available',
          initial: (item) => item.quantityReserved,
          minimum: (_) => 0,
          maximum: (item) => item.quantityRequested,
        );
        if (quantities == null) return;
        final hasShortfall = indent.items.any((item) {
          final row = quantities.firstWhere(
            (entry) => entry['item_id'] == item.id,
          );
          return (row['quantity_available'] as num).toDouble() <
              item.quantityRequested;
        });
        if (!hasShortfall) {
          _setActionError(s.lookup('ward_indent.error.shortfall_required'));
          return;
        }
        final selections = await _collectInventorySelections({
          for (final row in quantities)
            row['item_id'] as int: (row['quantity_available'] as num)
                .toDouble(),
        });
        if (selections == null) return;
        await _mutate(action, {
          'reason': reason,
          'item_quantities_available': quantities,
          'inventory_selections': selections,
        });
        return;
      case WardIndentAction.proposeSubstitution:
        final payload = await _buildSubstitutionPayload();
        if (payload != null) await _mutate(action, payload);
        return;
      case WardIndentAction.rejectSubstitution:
      case WardIndentAction.reject:
      case WardIndentAction.discrepancy:
      case WardIndentAction.cancel:
      case WardIndentAction.close:
        final reason = await _askReason(actionLabel);
        if (reason != null) await _mutate(action, {'reason': reason});
        return;
      case WardIndentAction.controlledHandoff:
        await _completeControlledHandoff();
        return;
      case WardIndentAction.receive:
        final quantities = await _askQuantities(
          title: s.lookup('ward_indent.quantity.received'),
          fieldName: 'quantity_received',
          initial: (item) => item.quantityIssued,
          minimum: (item) => item.quantityReceived,
          maximum: (item) => item.quantityIssued,
        );
        if (quantities == null) return;
        final progressed = indent.items.any((item) {
          final row = quantities.firstWhere(
            (entry) => entry['item_id'] == item.id,
          );
          return (row['quantity_received'] as num).toDouble() >
              item.quantityReceived;
        });
        if (!progressed) {
          _setActionError(s.lookup('ward_indent.error.progress_required'));
          return;
        }
        final acknowledgements = indent.items
            .where((item) {
              if (!item.needsSubstitutionAcknowledgement) return false;
              final row = quantities.firstWhere(
                (entry) => entry['item_id'] == item.id,
              );
              return (row['quantity_received'] as num).toDouble() >
                  item.quantityReceived;
            })
            .toList(growable: false);
        if (acknowledgements.isNotEmpty &&
            !await _confirmSubstitutionAcknowledgements(acknowledgements)) {
          return;
        }
        await _mutate(action, {
          'item_quantities_received': quantities,
          'substitution_acknowledgements': [
            for (final item in acknowledgements) {'item_id': item.id},
          ],
        });
        return;
      case WardIndentAction.requestReturn:
        final reason = await _askReason(actionLabel);
        if (reason == null) return;
        final quantities = await _askQuantities(
          title: s.lookup('ward_indent.quantity.returned'),
          fieldName: 'quantity_returned',
          initial: indent.returnCeilingForItem,
          minimum: (item) => item.quantityReturned,
          maximum: indent.returnCeilingForItem,
        );
        if (quantities == null) return;
        final progressed = indent.items.any((item) {
          final row = quantities.firstWhere(
            (entry) => entry['item_id'] == item.id,
          );
          return (row['quantity_returned'] as num).toDouble() >
              item.quantityReturned;
        });
        if (!progressed) {
          _setActionError(s.lookup('ward_indent.error.return_required'));
          return;
        }
        await _mutate(action, {
          'reason': reason,
          'item_quantities_returned': quantities,
        });
        return;
      case WardIndentAction.reconcile:
        final payload = await _buildReconciliationPayload();
        if (payload != null) await _mutate(action, payload);
        return;
    }
  }

  Future<List<Map<String, dynamic>>?> _collectInventorySelections(
    Map<int, double> targetQuantities, {
    bool useProposedCatalog = false,
  }) async {
    final indent = _selected;
    if (indent == null) return null;
    final strings = AppStrings.of(context);
    final selections = <Map<String, dynamic>>[];
    setState(() => _mutating = true);
    try {
      for (final line in indent.items) {
        final target = targetQuantities[line.id] ?? 0;
        if (target <= 0) continue;
        List<WardIndentInventoryItem> candidates;
        if (useProposedCatalog && line.substitutionStatus == 'pending') {
          final proposedCatalogId = line.proposedCatalogId;
          if (proposedCatalogId == null) {
            throw StateError(
              strings.format('ward_indent.inventory.none', {
                'item': line.proposedName ?? line.name,
              }),
            );
          }
          candidates =
              (await widget.gateway.listInventoryItems(
                    catalogId: proposedCatalogId,
                  ))
                  .where((candidate) {
                    return candidate.catalogId == proposedCatalogId &&
                        (candidate.facilityId == null ||
                            indent.facilityId == null ||
                            candidate.facilityId == indent.facilityId);
                  })
                  .toList(growable: false);
        } else {
          candidates = await widget.gateway.listInventoryCandidates(
            indent.id,
            line.id,
          );
        }
        if (!useProposedCatalog || line.substitutionStatus != 'pending') {
          candidates = candidates
              .where(
                (candidate) =>
                    candidate.unreservedQuantity > 0 ||
                    candidate.batches.any(
                      (batch) => batch.unreservedQuantity > 0,
                    ),
              )
              .toList(growable: false);
        }
        if (candidates.isEmpty) {
          throw StateError(
            strings.format('ward_indent.inventory.none', {
              'item': useProposedCatalog
                  ? line.proposedName ?? line.name
                  : line.name,
            }),
          );
        }
        final selected = candidates.length == 1
            ? candidates.single
            : await _choose<WardIndentInventoryItem>(
                strings.format('ward_indent.inventory.select', {
                  'item': useProposedCatalog
                      ? line.proposedName ?? line.name
                      : line.name,
                }),
                candidates,
                (candidate) =>
                    '${candidate.displayName} — '
                    '${_quantity(candidate.unreservedQuantity)} '
                    '${candidate.unitLabel ?? ''}',
              );
        if (selected == null) return null;
        selections.add({'item_id': line.id, 'inventory_item_id': selected.id});
      }
      return selections;
    } catch (error) {
      if (mounted) _setActionError(_errorText(error));
      return null;
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
  }

  Future<bool> _confirmSubstitutionAcknowledgements(
    List<WardIndentItem> items,
  ) async {
    final strings = AppStrings.of(context);
    return await showDialog<bool>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: Text(
              strings.lookup('ward_indent.substitution.acknowledge_title'),
            ),
            content: Text(
              strings.format('ward_indent.substitution.acknowledge_body', {
                'items': items
                    .map((item) => item.proposedName ?? item.name)
                    .join(', '),
              }),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: Text(strings.actionCancel),
              ),
              FilledButton(
                key: const Key('ward-indent-substitution-acknowledge'),
                onPressed: () => Navigator.pop(dialogContext, true),
                child: Text(strings.actionConfirm),
              ),
            ],
          ),
        ) ??
        false;
  }

  Future<Map<String, dynamic>?> _buildSubstitutionPayload() async {
    final indent = _selected;
    if (indent == null) return null;
    final strings = AppStrings.of(context);
    final shortItems = indent.items
        .where((item) => item.quantityReserved < item.quantityRequested)
        .toList(growable: false);
    if (shortItems.isEmpty) return null;
    final line = await _choose<WardIndentItem>(
      strings.lookup('ward_indent.substitution.select_line'),
      shortItems,
      (item) =>
          '${item.name} (${_quantity(item.quantityReserved)}/'
          '${_quantity(item.quantityRequested)})',
    );
    if (line == null || line.catalogId == null) return null;

    setState(() => _mutating = true);
    CompositionAlternativesResult alternatives;
    try {
      alternatives = await widget.gateway.getCatalogAlternatives(
        line.catalogId!,
      );
    } catch (error) {
      if (mounted) _setActionError(_errorText(error));
      return null;
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
    if (!mounted) return null;
    final candidates = alternatives.alternatives
        .where(
          (item) =>
              item.catalogId != line.catalogId &&
              item.substitutable &&
              item.inStock,
        )
        .toList(growable: false);
    if (candidates.isEmpty) {
      _setActionError(strings.lookup('ward_indent.substitution.none_safe'));
      return null;
    }
    final substitute = await _choose<CompositionAlternativeItem>(
      strings.lookup('ward_indent.substitution.select_alternative'),
      candidates,
      (item) => '${item.displayName} - ${item.stockLabel}',
    );
    if (substitute == null) return null;
    final reason = await _askReason(
      strings.lookup('ward_indent.action.propose_substitution'),
    );
    if (reason == null) return null;
    return {
      'substitutions': [
        {
          'item_id': line.id,
          'substitute_catalog_id': substitute.catalogId,
          'quantity': line.quantityRequested,
          'reason': reason,
        },
      ],
    };
  }

  Future<Map<String, dynamic>?> _buildReconciliationPayload() async {
    final indent = _selected;
    if (indent == null) return null;
    final reason = await _askReason(
      AppStrings.of(context).lookup('ward_indent.action.reconcile'),
    );
    if (reason == null) return null;

    final varianceItems = indent.items
        .where((item) => item.unresolvedVariance > 0)
        .toList(growable: false);
    final reconciliations = await _askVarianceReconciliations(
      varianceItems,
      reason,
    );
    if (reconciliations == null) return null;
    final allocationReturns = _buildAllocationReturns(indent);
    if (allocationReturns == null) return null;
    final evidence = await _recordControlledReturnEvidence(
      indent,
      allocationReturns,
    );
    if (evidence == null) return null;
    return {
      'reason': reason,
      'controlled_return_evidence': evidence,
      'allocation_returns': [
        for (final entry in allocationReturns)
          {'allocation_id': entry.allocation.id, 'quantity': entry.quantity},
      ],
      'item_reconciliations': reconciliations,
    };
  }

  List<_AllocationReturnPlan>? _buildAllocationReturns(WardIndent indent) {
    final strings = AppStrings.of(context);
    final result = <_AllocationReturnPlan>[];
    for (final item in indent.items.where(
      (candidate) => candidate.outstandingReturn > 0,
    )) {
      var remaining = item.outstandingReturn;
      final available = indent.medicationClosure
          .allocationsForItem(item.id)
          .where((allocation) => allocation.hasCustodyQuantity)
          .toList(growable: false);
      if (item.isControlled && available.length != 1) {
        _setActionError(
          strings.format('ward_indent.reconcile.exact_allocation_required', {
            'item': item.name,
          }),
        );
        return null;
      }
      for (final allocation in available) {
        if (remaining <= 0) break;
        final quantity = allocation.custodyAvailableQuantity < remaining
            ? allocation.custodyAvailableQuantity
            : remaining;
        if (quantity <= 0) continue;
        result.add(
          _AllocationReturnPlan(
            item: item,
            allocation: allocation,
            quantity: quantity,
          ),
        );
        remaining = (remaining - quantity).clamp(0, double.infinity);
      }
      if (remaining > 1e-9) {
        _setActionError(
          strings.format('ward_indent.reconcile.return_exceeds_custody', {
            'item': item.name,
          }),
        );
        return null;
      }
    }
    return result;
  }

  Future<List<Map<String, dynamic>>?> _recordControlledReturnEvidence(
    WardIndent indent,
    List<_AllocationReturnPlan> allocationReturns,
  ) async {
    final controlled = allocationReturns
        .where((entry) => entry.item.isControlled)
        .toList(growable: false);
    if (controlled.isEmpty) return const [];
    if (!OnlineOnlyActionGuard.require(context)) return null;
    final strings = AppStrings.of(context);
    final result = <Map<String, dynamic>>[];
    setState(() => _mutating = true);
    try {
      for (final entry in controlled) {
        final referenceId = entry.item.controlledReferenceId;
        if (referenceId == null || referenceId.isEmpty) {
          throw StateError(
            strings.format('ward_indent.controlled.reference_missing', {
              'item': entry.item.name,
            }),
          );
        }
        final allocation = entry.allocation;
        final movementPayload = <String, dynamic>{
          'inventory_item_id': allocation.inventoryItemId,
          'inventory_batch_id': allocation.inventoryBatchId,
          if (entry.item.catalogId != null) 'catalog_id': entry.item.catalogId,
          'movement_kind': 'return',
          'quantity': entry.quantity,
          'reference_type': 'ward_indent_return',
          'reference_id': referenceId,
          if (indent.patientUid != null) 'patient_uid': indent.patientUid,
          if (allocation.batchNumber != null)
            'expected_batch_number': allocation.batchNumber,
          if (allocation.lotNumber != null)
            'expected_lot_number': allocation.lotNumber,
          if (allocation.expiryDate != null)
            'expected_expiry_date': allocation.expiryDate!
                .toIso8601String()
                .substring(0, 10),
          'notes':
              'Ward indent ${indent.indentNumber} return allocation '
              '${allocation.id}',
        };
        final attemptScope = _attemptScope(
          indent.id,
          'controlled-return:${allocation.id}',
        );
        final response = await widget.gateway.recordInventoryMovement(
          movement: movementPayload,
          idempotencyKey: _attempts.keyFor(attemptScope, movementPayload),
        );
        final movementRecord = response['movement'];
        final register = response['register_entry'];
        final movementId = movementRecord is Map
            ? int.tryParse('${movementRecord['id']}')
            : null;
        final registerId = register is Map
            ? int.tryParse('${register['id']}')
            : null;
        if (movementId == null || registerId == null) {
          throw StateError(
            strings.lookup('ward_indent.reconcile.return_evidence_missing'),
          );
        }
        _attempts.complete(attemptScope);
        result.add({
          'item_id': entry.item.id,
          'movement_id': movementId,
          'register_id': registerId,
        });
      }
      return result;
    } catch (error) {
      if (mounted) _setActionError(_errorText(error));
      return null;
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
  }

  Future<List<Map<String, dynamic>>?> _askVarianceReconciliations(
    List<WardIndentItem> items,
    String note,
  ) async {
    if (items.isEmpty) return const [];
    final selections = <int, String?>{for (final item in items) item.id: null};
    return showDialog<List<Map<String, dynamic>>>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text(
            AppStrings.of(context)
                .lookup('ward_indent.reconcile.variance_title'),
          ),
          content: SizedBox(
            width: 520,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    AppStrings.of(context)
                        .lookup('ward_indent.reconcile.variance_help'),
                  ),
                  const SizedBox(height: 12),
                  for (final item in items) ...[
                    Text(
                      '${item.name} — ${_quantity(item.unresolvedVariance)}',
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String>(
                      key: Key('ward-indent-disposition-${item.id}'),
                      initialValue: selections[item.id],
                      isExpanded: true,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(context)
                            .lookup('ward_indent.reconcile.disposition'),
                        border: const OutlineInputBorder(),
                      ),
                      items: _reconciliationDispositions
                          .map(
                            (value) => DropdownMenuItem(
                              value: value,
                              child: Text(
                                AppStrings.of(context).lookup(
                                  'ward_indent.reconcile.disposition.$value',
                                ),
                              ),
                            ),
                          )
                          .toList(growable: false),
                      onChanged: (value) =>
                          setDialogState(() => selections[item.id] = value),
                    ),
                    const SizedBox(height: 12),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: Text(AppStrings.of(context).actionCancel),
            ),
            FilledButton(
              key: const Key('ward-indent-disposition-confirm'),
              onPressed: selections.values.any((value) => value == null)
                  ? null
                  : () => Navigator.pop(dialogContext, [
                      for (final item in items)
                        {
                          'item_id': item.id,
                          'quantity_variance_resolved': item.unresolvedVariance,
                          'disposition': selections[item.id],
                          'note': note,
                        },
                    ]),
              child: Text(AppStrings.of(context).actionConfirm),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _completeControlledHandoff() async {
    final initial = _selected;
    if (initial == null || _mutating) return;
    if (!OnlineOnlyActionGuard.require(context)) return;
    final strings = AppStrings.of(context);
    if (!await _confirm(
      _actionLabel(strings, WardIndentAction.controlledHandoff),
    )) {
      return;
    }

    setState(() {
      _mutating = true;
      _actionError = null;
    });
    try {
      var current = initial;
      _throwOnAmbiguousRecovery(current);
      for (final line in current.items.where((item) => item.isControlled)) {
        final existing = _recoveryFor(current, line.id);
        if (existing?.isRecoverable == true) continue;

        final allocation = exactControlledIssueAllocation(current, line);
        if (allocation == null) {
          throw StateError(
            strings.format('ward_indent.controlled.exact_allocation_required', {
              'item': line.name,
            }),
          );
        }
        final candidates = await widget.gateway.listInventoryCandidates(
          current.id,
          line.id,
        );
        final exactInventory = candidates
            .where((candidate) => candidate.id == allocation.inventoryItemId)
            .toList(growable: false);
        if (exactInventory.length != 1 || !exactInventory.single.isControlled) {
          throw StateError(
            strings.format('ward_indent.controlled.no_inventory_link', {
              'item': line.name,
            }),
          );
        }
        final inventoryItem = exactInventory.single;
        final exactBatch = inventoryItem.batches
            .where((batch) => batch.id == allocation.inventoryBatchId)
            .toList(growable: false);
        if (exactBatch.length != 1) {
          throw StateError(
            strings.format('ward_indent.controlled.no_usable_batch', {
              'item': line.name,
            }),
          );
        }
        final dispense = <String, dynamic>{
          'inventory_item_id': allocation.inventoryItemId,
          'inventory_batch_id': allocation.inventoryBatchId,
          'quantity': allocation.issueAvailableQuantity,
          if (current.patientUid != null) 'patient_uid': current.patientUid,
          'prescription_number': current.indentNumber,
          'reference_id': line.controlledReferenceId,
          'notes':
              'Ward indent ${current.indentNumber} allocation ${allocation.id}',
        };
        if (inventoryItem.requiresWitness) {
          final witnessRequestScope = _attemptScope(
            current.id,
            'controlled-witness-request:${line.id}',
          );
          final requested = await widget.gateway
              .requestControlledDispenseWitnessApproval(
                dispense: dispense,
                idempotencyKey: _attempts.keyFor(witnessRequestScope, dispense),
              );
          final approvalId =
              requested['id']?.toString() ??
              requested['approval_id']?.toString();
          if (approvalId == null || approvalId.trim().isEmpty) {
            throw StateError(
              strings.lookup('ward_indent.controlled.witness_id_missing'),
            );
          }
          _attempts.complete(witnessRequestScope);
          final credentials = await _askWitnessCredentials(line.name);
          if (credentials == null) return;
          final witnessApprovalScope = _attemptScope(
            current.id,
            'controlled-witness-approve:$approvalId',
          );
          final witnessApprovalPayload = <String, dynamic>{
            'dispense': dispense,
            'employeeId': credentials.employeeId.trim().toUpperCase(),
            'password': credentials.password,
          };
          await widget.gateway.approveControlledDispenseWitnessApproval(
            approvalId: approvalId,
            dispense: dispense,
            employeeId: witnessApprovalPayload['employeeId'] as String,
            password: witnessApprovalPayload['password'] as String,
            idempotencyKey: _attempts.keyFor(
              witnessApprovalScope,
              witnessApprovalPayload,
            ),
          );
          _attempts.complete(witnessApprovalScope);
          dispense['witness_approval_id'] = approvalId;
        }
        final controlledDispenseScope = _attemptScope(
          current.id,
          'controlled-dispense:${allocation.id}',
        );
        await widget.gateway.dispenseControlledInventory(
          dispense: dispense,
          idempotencyKey: _attempts.keyFor(controlledDispenseScope, dispense),
        );
        _attempts.complete(controlledDispenseScope);
        current = await widget.gateway.getIndent(current.id);
        if (mounted) {
          setState(() {
            _selected = current;
            _indents = _replaceOrAdd(_indents, current);
          });
        }
        _throwOnAmbiguousRecovery(current);
      }

      current = await widget.gateway.getIndent(current.id);
      _throwOnAmbiguousRecovery(current);
      final evidence = <Map<String, dynamic>>[];
      for (final line in current.items.where((item) => item.isControlled)) {
        final recovery = _recoveryFor(current, line.id);
        if (recovery == null || !recovery.isRecoverable) {
          throw StateError(
            strings.format('ward_indent.controlled.recovery_pending', {
              'item': line.name,
            }),
          );
        }
        evidence.add({
          'item_id': line.id,
          'movement_id': recovery.movementId,
          'register_id': recovery.registerId,
        });
      }
      final handoffPayload = {'item_evidence': evidence};
      final handoffScope = _attemptScope(
        current.id,
        WardIndentAction.controlledHandoff.apiPath,
      );
      final result = await widget.gateway.mutateIndent(
        current,
        WardIndentAction.controlledHandoff,
        payload: handoffPayload,
        idempotencyKey: _attempts.keyFor(handoffScope, {
          ...handoffPayload,
          'expected_version': current.stateVersion,
        }),
      );
      _attempts.complete(handoffScope);
      if (!mounted) return;
      _acceptMutation(result);
    } catch (error) {
      var message = _errorText(error);
      try {
        final fresh = await widget.gateway.getIndent(initial.id);
        if (mounted) {
          setState(() {
            _selected = fresh;
            _indents = _replaceOrAdd(_indents, fresh);
          });
          message = strings.format(
            'ward_indent.error.refreshed_after_failure',
            {'error': message, 'version': fresh.stateVersion},
          );
        }
      } catch (_) {}
      if (mounted) setState(() => _actionError = message);
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
  }

  void _throwOnAmbiguousRecovery(WardIndent indent) {
    final ambiguous = indent.controlledRecovery.where(
      (recovery) => recovery.status == 'ambiguous',
    );
    if (ambiguous.isNotEmpty) {
      throw StateError(
        AppStrings.of(context)
            .lookup('ward_indent.controlled.ambiguous_recovery'),
      );
    }
  }

  ControlledHandoffRecovery? _recoveryFor(WardIndent indent, int itemId) {
    for (final recovery in indent.controlledRecovery) {
      if (recovery.itemId == itemId) return recovery;
    }
    return null;
  }

  Future<_WitnessCredentials?> _askWitnessCredentials(String itemName) async {
    var employeeId = '';
    var password = '';
    return showDialog<_WitnessCredentials>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(
          AppStrings.of(context).lookup('ward_indent.controlled.witness_title'),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(itemName),
            const SizedBox(height: 12),
            TextField(
              key: const Key('ward-indent-witness-employee-id'),
              textCapitalization: TextCapitalization.characters,
              onChanged: (value) => employeeId = value,
              decoration: InputDecoration(
                labelText: AppStrings.of(context)
                    .lookup('ward_indent.controlled.witness_employee_id'),
              ),
            ),
            TextField(
              key: const Key('ward-indent-witness-password'),
              obscureText: true,
              onChanged: (value) => password = value,
              decoration: InputDecoration(
                labelText: AppStrings.of(context)
                    .lookup('ward_indent.controlled.witness_password'),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: Text(AppStrings.of(context).actionCancel),
          ),
          FilledButton(
            key: const Key('ward-indent-witness-confirm'),
            onPressed: () {
              final normalizedEmployeeId = employeeId.trim().toUpperCase();
              if (normalizedEmployeeId.isEmpty || password.isEmpty) return;
              Navigator.pop(
                dialogContext,
                _WitnessCredentials(normalizedEmployeeId, password),
              );
            },
            child: Text(AppStrings.of(context).actionConfirm),
          ),
        ],
      ),
    );
  }

  Future<bool> _confirm(String actionLabel) async {
    return await showDialog<bool>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: Text(actionLabel),
            content: Text(
              AppStrings.of(context).lookup('ward_indent.confirm.default'),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: Text(AppStrings.of(context).actionCancel),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(dialogContext, true),
                child: Text(AppStrings.of(context).actionConfirm),
              ),
            ],
          ),
        ) ??
        false;
  }

  Future<String?> _askReason(String title) async {
    var value = '';
    return showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: TextField(
          key: const Key('ward-indent-reason'),
          onChanged: (text) => value = text,
          maxLines: 3,
          decoration: InputDecoration(
            labelText: AppStrings.of(context)
                .lookup('ward_indent.reason.label'),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: Text(AppStrings.of(context).actionCancel),
          ),
          FilledButton(
            onPressed: () {
              final reason = value.trim();
              if (reason.isNotEmpty) Navigator.pop(dialogContext, reason);
            },
            child: Text(AppStrings.of(context).actionConfirm),
          ),
        ],
      ),
    );
  }

  Future<List<Map<String, dynamic>>?> _askQuantities({
    required String title,
    required String fieldName,
    required double Function(WardIndentItem item) initial,
    required double Function(WardIndentItem item) minimum,
    required double Function(WardIndentItem item) maximum,
  }) async {
    final indent = _selected;
    if (indent == null) return null;
    final values = {
      for (final item in indent.items) item.id: _quantity(initial(item)),
    };
    return showDialog<List<Map<String, dynamic>>>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: SizedBox(
          width: 520,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final item in indent.items)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: TextFormField(
                      key: Key('ward-indent-quantity-${item.id}'),
                      initialValue: values[item.id],
                      onChanged: (value) => values[item.id] = value,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      decoration: InputDecoration(
                        labelText: item.name,
                        helperText:
                            '${_quantity(minimum(item))} - '
                            '${_quantity(maximum(item))}',
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: Text(AppStrings.of(context).actionCancel),
          ),
          FilledButton(
            onPressed: () {
              final rows = <Map<String, dynamic>>[];
              for (final item in indent.items) {
                final value = double.tryParse(values[item.id]!.trim());
                if (value == null ||
                    value < minimum(item) ||
                    value > maximum(item)) {
                  return;
                }
                rows.add({'item_id': item.id, fieldName: value});
              }
              Navigator.pop(dialogContext, rows);
            },
            child: Text(AppStrings.of(context).actionConfirm),
          ),
        ],
      ),
    );
  }

  Future<T?> _choose<T>(
    String title,
    List<T> values,
    String Function(T value) label,
  ) {
    return showDialog<T>(
      context: context,
      builder: (dialogContext) => SimpleDialog(
        title: Text(title),
        children: [
          for (final value in values)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(dialogContext, value),
              child: Text(label(value)),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_loadError != null && _indents.isEmpty) {
      return _WorkbenchError(message: _loadError!, onRetry: _loadWorkbench);
    }

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 6),
          child: Row(
            children: [
              Expanded(
                child: Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  children: WardIndentWorklistFilter.values
                      .map(
                        (filter) => ChoiceChip(
                          key: Key('ward-indent-filter-${filter.name}'),
                          label: Text(
                            s.lookup('ward_indent.filter.${filter.name}'),
                          ),
                          selected: _filter == filter,
                          onSelected: (_) => _selectFilter(filter),
                        ),
                      )
                      .toList(growable: false),
                ),
              ),
              IconButton(
                key: const Key('ward-indent-refresh'),
                tooltip: s.actionRefresh,
                onPressed: _mutating || _loadingMore ? null : _loadWorkbench,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
        ),
        if (_loadError != null)
          _InlineError(message: _loadError!, onRetry: _loadWorkbench),
        if (_actionError != null)
          _InlineError(
            key: const Key('ward-indent-action-error'),
            message: _actionError!,
            onRetry: _refreshSelected,
          ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final narrow = constraints.maxWidth < 760;
              if (narrow) {
                if (_showNarrowDetail && _selected != null) {
                  return _buildDetail(narrow: true);
                }
                return _buildList();
              }
              return Row(
                children: [
                  SizedBox(width: 360, child: _buildList()),
                  const VerticalDivider(width: 1),
                  Expanded(child: _buildDetail()),
                ],
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _buildList() {
    final rows = _filteredIndents;
    final s = AppStrings.of(context);
    final emptyOffset = rows.isEmpty ? 1 : 0;
    final itemCount = rows.length + emptyOffset + (_hasMore ? 1 : 0);
    return RefreshIndicator(
      onRefresh: _loadWorkbench,
      child: ListView.separated(
        padding: const EdgeInsets.all(12),
        physics: const AlwaysScrollableScrollPhysics(),
        itemCount: itemCount,
        separatorBuilder: (_, _) => const SizedBox(height: 8),
        itemBuilder: (context, index) {
          if (rows.isEmpty && index == 0) {
            return SizedBox(
              height: 180,
              child: Center(child: Text(s.lookup('ward_indent.empty'))),
            );
          }
          final rowIndex = index - emptyOffset;
          if (rowIndex == rows.length) {
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: OutlinedButton.icon(
                key: const Key('ward-indent-load-more'),
                onPressed: _loadingMore || _mutating ? null : _loadMore,
                icon: _loadingMore
                    ? const SizedBox.square(
                        dimension: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.expand_more),
                label: Text(s.lookup('ward_indent.pagination.load_more')),
              ),
            );
          }
          final indent = rows[rowIndex];
          final selected = _selected?.id == indent.id;
          return Card(
            key: Key('ward-indent-row-${indent.id}'),
            color: selected
                ? Theme.of(context).colorScheme.primaryContainer
                : null,
            child: ListTile(
              onTap: _detailLoading ? null : () => _openIndent(indent),
              title: Text(
                indent.indentNumber,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_statusLabel(s, indent.status)),
                  Text(
                    indent.wardName ??
                        s.format('ward_indent.patient_uid', {
                          'uid': indent.patientUid ?? '-',
                        }),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (indent.ownerRoleCodes.isNotEmpty)
                    Text(
                      s.format('ward_indent.owner', {
                        'owner': indent.ownerRoleCodes.join(', '),
                      }),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                ],
              ),
              trailing: indent.isOverdue
                  ? Tooltip(
                      message: s.lookup('ward_indent.overdue'),
                      child: const Icon(Icons.timer_off, color: Colors.red),
                    )
                  : const Icon(Icons.chevron_right),
            ),
          );
        },
      ),
    );
  }

  Widget _buildDetail({bool narrow = false}) {
    final indent = _selected;
    final s = AppStrings.of(context);
    if (_detailLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (indent == null) {
      return Center(child: Text(s.lookup('ward_indent.select_prompt')));
    }
    final actions = WardIndentRolePolicy.actionsFor(
      indent,
      rawRole: widget.rawRole,
      role: widget.role,
    ).toList()..sort((a, b) => a.index.compareTo(b.index));

    return RefreshIndicator(
      onRefresh: () async {
        await _refreshSelected();
      },
      child: ListView(
        key: Key('ward-indent-detail-${indent.id}'),
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              if (narrow)
                IconButton(
                  key: const Key('ward-indent-back'),
                  onPressed: () => setState(() => _showNarrowDetail = false),
                  icon: const Icon(Icons.arrow_back),
                ),
              Expanded(
                child: Text(
                  indent.indentNumber,
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
              ),
              Chip(label: Text(_statusLabel(s, indent.status))),
              const SizedBox(width: 8),
              Text('v${indent.stateVersion}'),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 16,
            runSpacing: 8,
            children: [
              _Fact(
                label: s.lookup('ward_indent.field.ward'),
                value: indent.wardName ?? '${indent.wardId ?? '-'}',
              ),
              _Fact(
                label: s.lookup('ward_indent.field.patient'),
                value: indent.patientUid ?? '-',
              ),
              _Fact(
                label: s.lookup('ward_indent.field.admission'),
                value: '${indent.admissionId ?? '-'}',
              ),
              _Fact(
                label: s.lookup('ward_indent.field.owner'),
                value: indent.ownerRoleCodes.isEmpty
                    ? '-'
                    : indent.ownerRoleCodes.join(', '),
              ),
            ],
          ),
          if (indent.activeSlas.isNotEmpty) ...[
            const SizedBox(height: 12),
            Card(
              color: indent.isOverdue
                  ? Theme.of(context).colorScheme.errorContainer
                  : null,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      s.lookup('ward_indent.sla.title'),
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                    for (final sla in indent.activeSlas)
                      Text(
                        '${localizedWardIndentCode(s, WardIndentCodeKind.slaRule, sla.ruleCode)}: '
                        '${localizedWardIndentCode(s, WardIndentCodeKind.slaStatus, sla.status)}'
                        '${sla.dueAt == null ? '' : ' - ${_date(sla.dueAt!)}'}',
                      ),
                  ],
                ),
              ),
            ),
          ],
          if (indent.shortSupplyReason != null ||
              indent.reconciliationReason != null ||
              indent.notes != null) ...[
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Text(
                  indent.reconciliationReason ??
                      indent.shortSupplyReason ??
                      indent.notes!,
                ),
              ),
            ),
          ],
          const SizedBox(height: 16),
          Text(
            s.lookup('ward_indent.items.title'),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          for (final item in indent.items) _buildItemCard(item),
          if (indent.controlledRecovery.isNotEmpty) ...[
            const SizedBox(height: 8),
            Card(
              color: Theme.of(context).colorScheme.tertiaryContainer,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      s.lookup('ward_indent.controlled.recovery_title'),
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                    for (final recovery in indent.controlledRecovery)
                      Text(
                        s.format('ward_indent.controlled.recovery_row', {
                          'item': recovery.itemId,
                          'status': localizedWardIndentCode(
                            s,
                            WardIndentCodeKind.recovery,
                            recovery.status,
                          ),
                          'count': recovery.candidateCount,
                        }),
                      ),
                  ],
                ),
              ),
            ),
          ],
          const SizedBox(height: 16),
          if (actions.isEmpty)
            Text(s.lookup('ward_indent.actions.none'))
          else
            OnlineOnlyActionState(
              builder: (context, isOnline, offlineMessage) => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.lookup('ward_indent.actions.title'),
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  if (!isOnline)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        offlineMessage,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: actions
                        .map(
                          (action) => FilledButton.tonal(
                            key: Key('ward-indent-action-${action.name}'),
                            onPressed: isOnline && !_mutating
                                ? () => _handleAction(action)
                                : null,
                            child: Text(_actionLabel(s, action)),
                          ),
                        )
                        .toList(growable: false),
                  ),
                ],
              ),
            ),
          if (_mutating) ...[
            const SizedBox(height: 12),
            const LinearProgressIndicator(),
          ],
          const SizedBox(height: 16),
          ExpansionTile(
            initiallyExpanded: false,
            title: Text(
              s.format('ward_indent.events.title', {
                'count': indent.events.length,
              }),
            ),
            children: indent.events
                .map(
                  (event) => ListTile(
                    dense: true,
                    title: Text(
                      localizedWardIndentCode(
                        s,
                        WardIndentCodeKind.event,
                        event.action,
                      ),
                    ),
                    subtitle: Text(
                      '${event.fromStatus == null ? '-' : localizedWardIndentCode(s, WardIndentCodeKind.status, event.fromStatus)} - '
                      '${localizedWardIndentCode(s, WardIndentCodeKind.status, event.toStatus)}'
                      '${event.reason == null ? '' : '\n${event.reason}'}',
                    ),
                    trailing: Text('v${event.stateVersion}'),
                  ),
                )
                .toList(growable: false),
          ),
          const SizedBox(height: 64),
        ],
      ),
    );
  }

  Widget _buildItemCard(WardIndentItem item) {
    final s = AppStrings.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    item.name,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
                if (item.isControlled)
                  Chip(
                    avatar: const Icon(Icons.verified_user, size: 16),
                    label: Text(s.lookup('ward_indent.controlled.label')),
                  ),
              ],
            ),
            Wrap(
              spacing: 12,
              runSpacing: 4,
              children: [
                Text(
                  s.format('ward_indent.item.requested', {
                    'quantity': _quantity(item.quantityRequested),
                  }),
                ),
                Text(
                  s.format('ward_indent.item.reserved', {
                    'quantity': _quantity(item.quantityReserved),
                  }),
                ),
                Text(
                  s.format('ward_indent.item.issued', {
                    'quantity': _quantity(item.quantityIssued),
                  }),
                ),
                Text(
                  s.format('ward_indent.item.received', {
                    'quantity': _quantity(item.quantityReceived),
                  }),
                ),
                if (item.quantityReturnRequested > 0)
                  Text(
                    s.format('ward_indent.item.returned', {
                      'returned': _quantity(item.quantityReturned),
                      'requested': _quantity(item.quantityReturnRequested),
                    }),
                  ),
              ],
            ),
            if (item.proposedName != null)
              Text(
                s.format('ward_indent.item.substitution', {
                  'name': item.proposedName!,
                  'status': localizedWardIndentCode(
                    s,
                    WardIndentCodeKind.substitution,
                    item.substitutionStatus,
                  ),
                }),
              ),
            if (item.fulfilmentStatus != null)
              Text(
                s.format('ward_indent.item.fulfilment', {
                  'status': localizedWardIndentCode(
                    s,
                    WardIndentCodeKind.fulfilment,
                    item.fulfilmentStatus,
                  ),
                }),
              ),
          ],
        ),
      ),
    );
  }

  void _setActionError(String message) {
    if (mounted) setState(() => _actionError = message);
  }

  String _attemptScope(int indentId, String action) =>
      'ward-indent:$indentId:${action.replaceAll('/', '-')}';
}

class _WitnessCredentials {
  const _WitnessCredentials(this.employeeId, this.password);

  final String employeeId;
  final String password;
}

class _AllocationReturnPlan {
  const _AllocationReturnPlan({
    required this.item,
    required this.allocation,
    required this.quantity,
  });

  final WardIndentItem item;
  final WardIndentInventoryAllocation allocation;
  final double quantity;
}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 220,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: Theme.of(context).textTheme.labelSmall),
          Text(value, maxLines: 2, overflow: TextOverflow.ellipsis),
        ],
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({super.key, required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return MaterialBanner(
      content: Text(message),
      actions: [
        TextButton(
          onPressed: onRetry,
          child: Text(AppStrings.of(context).actionRefresh),
        ),
      ],
    );
  }
}

class _WorkbenchError extends StatelessWidget {
  const _WorkbenchError({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 40),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: onRetry,
              child: Text(AppStrings.of(context).actionRetry),
            ),
          ],
        ),
      ),
    );
  }
}

List<WardIndent> _replaceOrAdd(List<WardIndent> rows, WardIndent? value) {
  if (value == null) return rows;
  final updated = [...rows];
  final index = updated.indexWhere((row) => row.id == value.id);
  if (index >= 0) {
    updated[index] = value;
  } else {
    updated.insert(0, value);
  }
  return updated;
}

List<WardIndent> _appendUnique(
  List<WardIndent> current,
  List<WardIndent> next,
) {
  final ids = current.map((row) => row.id).toSet();
  return [...current, ...next.where((row) => ids.add(row.id))];
}

String _errorText(Object error) {
  final value = error.toString().replaceFirst('Exception: ', '').trim();
  return value.length <= 500 ? value : '${value.substring(0, 500)}...';
}

String _quantity(double value) {
  return value == value.roundToDouble()
      ? value.toInt().toString()
      : value.toStringAsFixed(2).replaceFirst(RegExp(r'0+$'), '');
}

String _date(DateTime value) {
  final local = value.toLocal();
  return '${local.year.toString().padLeft(4, '0')}-'
      '${local.month.toString().padLeft(2, '0')}-'
      '${local.day.toString().padLeft(2, '0')} '
      '${local.hour.toString().padLeft(2, '0')}:'
      '${local.minute.toString().padLeft(2, '0')}';
}

@visibleForTesting
WardIndentInventoryAllocation? exactControlledIssueAllocation(
  WardIndent indent,
  WardIndentItem item,
) {
  final allocations = indent.medicationClosure
      .allocationsForItem(item.id)
      .where((allocation) => allocation.hasIssueQuantity)
      .toList(growable: false);
  return allocations.length == 1 ? allocations.single : null;
}

@visibleForTesting
enum WardIndentCodeKind {
  status,
  slaStatus,
  slaRule,
  recovery,
  event,
  substitution,
  fulfilment,
}

const _wardIndentStatusKeys = <String, String>{
  'requested': 'ward_indent.status.requested',
  'reserved': 'ward_indent.status.reserved',
  'short_supply': 'ward_indent.status.short_supply',
  'substitution_pending': 'ward_indent.status.substitution_pending',
  'controlled_handoff_required':
      'ward_indent.status.controlled_handoff_required',
  'approved': 'ward_indent.status.approved',
  'issued': 'ward_indent.status.issued',
  'partially_received': 'ward_indent.status.partially_received',
  'received': 'ward_indent.status.received',
  'return_pending': 'ward_indent.status.return_pending',
  'reconciliation_required': 'ward_indent.status.reconciliation_required',
  'reconciled': 'ward_indent.status.reconciled',
  'rejected': 'ward_indent.status.rejected',
  'cancelled': 'ward_indent.status.cancelled',
  'closed': 'ward_indent.status.closed',
};

const _wardIndentEventKeys = <String, String>{
  'requested': 'ward_indent.status.requested',
  'reserved': 'ward_indent.status.reserved',
  'short_supply_recorded': 'ward_indent.action.short_supply',
  'substitution_proposed': 'ward_indent.action.propose_substitution',
  'substitution_approved': 'ward_indent.action.approve_substitution',
  'substitution_rejected': 'ward_indent.action.reject_substitution',
  'approved': 'ward_indent.status.approved',
  'rejected': 'ward_indent.status.rejected',
  'controlled_handoff_recorded': 'ward_indent.action.controlled_handoff',
  'issued': 'ward_indent.status.issued',
  'receipt_recorded': 'ward_indent.action.receive',
  'return_requested': 'ward_indent.action.request_return',
  'reconciliation_required': 'ward_indent.status.reconciliation_required',
  'reconciled': 'ward_indent.status.reconciled',
  'cancelled': 'ward_indent.status.cancelled',
  'closed': 'ward_indent.status.closed',
};

const _wardIndentSubstitutionKeys = <String, String>{
  'pending': 'ward_indent.status.substitution_pending',
  'approved': 'ward_indent.status.approved',
  'rejected': 'ward_indent.status.rejected',
};

const _wardIndentFulfilmentKeys = <String, String>{
  ..._wardIndentStatusKeys,
  'controlled_handoff_recorded': 'ward_indent.action.controlled_handoff',
};

const _wardIndentSlaStatuses = <String>{'active', 'breached', 'escalated'};
const _wardIndentSlaRules = <String>{
  'ward_indent_pharmacy_response',
  'ward_indent_substitution_authorization',
  'ward_indent_controlled_handoff',
  'ward_indent_pharmacy_issue',
  'ward_indent_ward_receipt',
  'ward_indent_reconciliation',
  'ward_indent_notification_coverage',
  'ward_indent_credit_note_review',
  'ward_indent_mar_supply_reconciliation',
};
const _wardIndentRecoveryStatuses = <String>{
  'available',
  'missing',
  'ambiguous',
};

@visibleForTesting
String localizedWardIndentCode(
  AppStrings strings,
  WardIndentCodeKind kind,
  Object? code,
) {
  final normalized = code?.toString().trim().toLowerCase() ?? '';
  final key = switch (kind) {
    WardIndentCodeKind.status => _wardIndentStatusKeys[normalized],
    WardIndentCodeKind.slaStatus =>
      _wardIndentSlaStatuses.contains(normalized)
          ? 'ward_indent.sla.status.$normalized'
          : null,
    WardIndentCodeKind.slaRule =>
      _wardIndentSlaRules.contains(normalized)
          ? 'ward_indent.sla.rule.$normalized'
          : null,
    WardIndentCodeKind.recovery =>
      _wardIndentRecoveryStatuses.contains(normalized)
          ? 'ward_indent.controlled.recovery_status.$normalized'
          : null,
    WardIndentCodeKind.event => _wardIndentEventKeys[normalized],
    WardIndentCodeKind.substitution => _wardIndentSubstitutionKeys[normalized],
    WardIndentCodeKind.fulfilment => _wardIndentFulfilmentKeys[normalized],
  };
  return strings.lookup(key ?? 'ward_indent.code.unknown');
}

String _statusLabel(AppStrings s, WardIndentStatus status) {
  return s.lookup('ward_indent.status.${status.wireValue}');
}

String _actionLabel(AppStrings s, WardIndentAction action) {
  final key = switch (action) {
    WardIndentAction.shortSupply => 'short_supply',
    WardIndentAction.proposeSubstitution => 'propose_substitution',
    WardIndentAction.approveSubstitution => 'approve_substitution',
    WardIndentAction.rejectSubstitution => 'reject_substitution',
    WardIndentAction.controlledHandoff => 'controlled_handoff',
    WardIndentAction.requestReturn => 'request_return',
    _ => action.name,
  };
  return s.lookup('ward_indent.action.$key');
}
