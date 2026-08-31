import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';

import '../../../core/services/idempotency_attempt_registry.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/utils/api_error_messages.dart';
import '../../../core/widgets/online_only_action_state.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

typedef MarSupplyStateLoader = Future<Map<String, dynamic>> Function(int maId);
typedef MarSupplyReconciler = Future<Map<String, dynamic>> Function({
  required int maId,
  required String consumptionId,
  required List<Map<String, dynamic>> allocations,
  required String idempotencyKey,
});

@visibleForTesting
List<Map<String, dynamic>> openMarSupplyConsumptions(
  Map<String, dynamic> state,
) {
  final rows = state['consumptions'];
  if (rows is! List) return const [];
  return rows
      .whereType<Map>()
      .map((row) => Map<String, dynamic>.from(row))
      .where((row) {
        final quantity = _number(row['quantity']);
        final reconciled = _number(row['reconciled_quantity']);
        return row['evidence_status'] == 'unmatched_override' &&
            quantity - reconciled > 1e-9;
      })
      .toList(growable: false);
}

@visibleForTesting
String localizedMarSupplyBatchEligibilityReason(
  AppStrings strings,
  Object? code,
) {
  final normalized = code?.toString().trim().toLowerCase() ?? '';
  const keys = {
    'inventory_item_inactive':
        'mar_supply.batch_ineligible.inventory_item_inactive',
    'batch_reserved': 'mar_supply.batch_ineligible.batch_reserved',
    'batch_depleted': 'mar_supply.batch_ineligible.batch_depleted',
    'batch_expired': 'mar_supply.batch_ineligible.batch_expired',
    'batch_recalled': 'mar_supply.batch_ineligible.batch_recalled',
    'batch_quarantined': 'mar_supply.batch_ineligible.batch_quarantined',
    'batch_disposed': 'mar_supply.batch_ineligible.batch_disposed',
    'batch_status_missing': 'mar_supply.batch_ineligible.batch_status_missing',
    'ward_custody_unavailable':
        'mar_supply.batch_ineligible.ward_custody_unavailable',
    'batch_expiry_missing': 'mar_supply.batch_ineligible.batch_expiry_missing',
  };
  return strings.lookup(
    keys[normalized] ?? 'mar_supply.batch_ineligible.unknown',
  );
}

class MarSupplyReconciliationScreen extends StatefulWidget {
  const MarSupplyReconciliationScreen({
    super.key,
    required this.maId,
    this.loadState,
    this.reconcile,
  });

  final int maId;
  final MarSupplyStateLoader? loadState;
  final MarSupplyReconciler? reconcile;

  @override
  State<MarSupplyReconciliationScreen> createState() =>
      _MarSupplyReconciliationScreenState();
}

class _MarSupplyReconciliationScreenState
    extends State<MarSupplyReconciliationScreen> {
  Map<String, dynamic>? _state;
  final Map<String, TextEditingController> _controllers = {};
  bool _loading = true;
  bool _submitting = false;
  String? _error;
  final IdempotencyAttemptRegistry _attempts = IdempotencyAttemptRegistry();

  MarSupplyStateLoader get _load =>
      widget.loadState ??
      (maId) => MedicalApiService.getMarSupplyState(maId: maId);

  MarSupplyReconciler get _reconcile =>
      widget.reconcile ??
      ({
        required maId,
        required consumptionId,
        required allocations,
        required idempotencyKey,
      }) => MedicalApiService.reconcileMarSupplyOverride(
        maId: maId,
        consumptionId: consumptionId,
        allocations: allocations,
        idempotencyKey: idempotencyKey,
      );

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    _attempts.clear();
    super.dispose();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final state = await _load(widget.maId);
      if (!mounted) return;
      _resetControllers(state);
      setState(() {
        _state = state;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = localizedApiErrorFromRaw(AppStrings.of(context), error);
        _loading = false;
      });
    }
  }

  void _resetControllers(Map<String, dynamic> state) {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    _controllers.clear();
    final rows = state['allocations'];
    if (rows is! List) return;
    for (final row in rows.whereType<Map>()) {
      final id = row['id']?.toString();
      if (id == null || id.isEmpty) continue;
      _controllers[id] = TextEditingController(text: '0');
    }
  }

  Future<void> _submit(Map<String, dynamic> consumption) async {
    final strings = AppStrings.of(context);
    final state = _state;
    if (state == null || _submitting) return;
    if (!OnlineOnlyActionGuard.require(context)) return;
    final outstanding =
        _number(consumption['quantity']) -
        _number(consumption['reconciled_quantity']);
    final allocations = <Map<String, dynamic>>[];
    final allocationRows = state['allocations'];
    if (allocationRows is! List) return;
    var total = 0.0;
    for (final raw in allocationRows.whereType<Map>()) {
      final row = Map<String, dynamic>.from(raw);
      final id = row['id']?.toString();
      if (id == null) continue;
      final quantity = double.tryParse(_controllers[id]?.text.trim() ?? '');
      final available = _number(row['available_quantity']);
      if (quantity == null || quantity < 0 || quantity > available + 1e-9) {
        setState(
          () => _error = strings.format('mar_supply.invalid_quantity', {
            'allocation': id,
          }),
        );
        return;
      }
      if (quantity > 0) {
        allocations.add({'inventory_allocation_id': id, 'quantity': quantity});
        total += quantity;
      }
    }
    if ((total - outstanding).abs() > 1e-9) {
      setState(
        () => _error = strings.format('mar_supply.exact_total_required', {
          'quantity': _quantity(outstanding),
        }),
      );
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    final consumptionId = consumption['id'].toString();
    final attemptScope = 'mar-supply-reconcile:${widget.maId}:$consumptionId';
    final payload = <String, dynamic>{'allocations': allocations};
    final idempotencyKey = _attempts.keyFor(attemptScope, payload);
    try {
      await _reconcile(
        maId: widget.maId,
        consumptionId: consumptionId,
        allocations: allocations,
        idempotencyKey: idempotencyKey,
      );
      _attempts.complete(attemptScope);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(strings.lookup('mar_supply.completed'))),
      );
      await _refresh();
    } catch (error) {
      if (mounted) {
        setState(
          () =>
              _error = localizedApiErrorFromRaw(AppStrings.of(context), error),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return StaffScaffold(
      title: strings.lookup('mar_supply.title'),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (_loading)
              const Center(child: CircularProgressIndicator())
            else if (_error != null && _state == null)
              _ErrorPanel(message: _error!, onRetry: _refresh)
            else
              ..._buildContent(strings),
          ],
        ),
      ),
    );
  }

  List<Widget> _buildContent(AppStrings strings) {
    final isOnline = ConnectivitySyncService.instance.isOnline;
    final state = _state ?? const <String, dynamic>{};
    final consumptions = openMarSupplyConsumptions(state);
    if (consumptions.isEmpty) {
      return [
        const Icon(Icons.verified_outlined, size: 48),
        const SizedBox(height: 12),
        Center(child: Text(strings.lookup('mar_supply.no_open_override'))),
      ];
    }
    final consumption = consumptions.first;
    final outstanding =
        _number(consumption['quantity']) -
        _number(consumption['reconciled_quantity']);
    final rawAllocations = state['allocations'];
    final allocations = rawAllocations is List
        ? rawAllocations
              .whereType<Map>()
              .map((row) => Map<String, dynamic>.from(row))
              .toList(growable: false)
        : const <Map<String, dynamic>>[];
    return [
      Text(
        strings.format('mar_supply.outstanding', {
          'quantity': _quantity(outstanding),
        }),
        style: Theme.of(context).textTheme.titleMedium,
      ),
      const SizedBox(height: 8),
      Text(strings.lookup('mar_supply.help')),
      if (_error != null) ...[
        const SizedBox(height: 12),
        Text(
          _error!,
          style: TextStyle(color: Theme.of(context).colorScheme.error),
        ),
      ],
      const SizedBox(height: 16),
      for (final allocation in allocations) ...[
        Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  allocation['display_name']?.toString() ??
                      allocation['inventory_item_name']?.toString() ??
                      strings.lookup('mar_supply.allocation'),
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
                Text(
                  strings.format('mar_supply.batch_available', {
                    'batch': allocation['batch_number']?.toString() ?? '—',
                    'quantity': _quantity(
                      _number(allocation['available_quantity']),
                    ),
                  }),
                ),
                if (allocation['batch_eligible'] == false) ...[
                  const SizedBox(height: 6),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        Icons.block_outlined,
                        size: 17,
                        color: Theme.of(context).colorScheme.error,
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          localizedMarSupplyBatchEligibilityReason(
                            strings,
                            allocation['batch_eligibility_reason'] ??
                                allocation['batch_unavailable_reason'],
                          ),
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
                const SizedBox(height: 8),
                TextField(
                  key: Key('mar-supply-allocation-${allocation['id']}'),
                  controller: _controllers[allocation['id']?.toString()],
                  enabled:
                      allocation['batch_eligible'] != false &&
                      !_submitting &&
                      isOnline,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: InputDecoration(
                    labelText: strings.lookup('mar_supply.quantity'),
                    border: const OutlineInputBorder(),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 8),
      ],
      OnlineOnlyActionState(
        builder: (context, online, offlineMessage) => FilledButton.icon(
          key: const Key('mar-supply-reconcile-submit'),
          onPressed: _submitting || !online ? null : () => _submit(consumption),
          icon: _submitting
              ? const SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.link),
          label: Text(
            online ? strings.lookup('mar_supply.reconcile') : offlineMessage,
          ),
        ),
      ),
    ];
  }
}

class _ErrorPanel extends StatelessWidget {
  const _ErrorPanel({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(message),
        TextButton(
          onPressed: onRetry,
          child: Text(AppStrings.of(context).actionRefresh),
        ),
      ],
    );
  }
}

double _number(Object? value) {
  if (value is num) return value.toDouble();
  return double.tryParse(value?.toString() ?? '') ?? 0;
}

String _quantity(double value) => value == value.roundToDouble()
    ? value.toInt().toString()
    : value.toStringAsFixed(4).replaceFirst(RegExp(r'0+$'), '');
