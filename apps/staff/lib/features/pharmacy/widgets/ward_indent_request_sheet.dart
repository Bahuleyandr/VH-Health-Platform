import 'package:flutter/material.dart';

import '../../../core/services/idempotency_attempt_registry.dart';
import '../../../core/widgets/online_only_action_state.dart';
import '../../../l10n/app_strings.dart';
import '../models/ward_indent_models.dart';
import '../services/ward_indent_gateway.dart';

class WardIndentRequestSheet extends StatefulWidget {
  const WardIndentRequestSheet({
    super.key,
    required this.gateway,
    this.initialAdmissionId,
    this.attempts,
  });

  final WardIndentRequesterGateway gateway;
  final int? initialAdmissionId;
  final IdempotencyAttemptRegistry? attempts;

  @override
  State<WardIndentRequestSheet> createState() => _WardIndentRequestSheetState();
}

class _WardIndentRequestSheetState extends State<WardIndentRequestSheet> {
  static const _attemptScope = 'ward-indent-order-bound-request';

  late final TextEditingController _admissionController;
  final TextEditingController _notesController = TextEditingController();
  late final IdempotencyAttemptRegistry _attempts;
  WardIndentRecoveryProjection? _projection;
  WardIndentEligibleOrder? _selectedOrder;
  bool _loading = false;
  bool _submitting = false;
  String? _error;
  String? _conflictCode;
  Map<String, dynamic>? _conflictDetails;

  @override
  void initState() {
    super.initState();
    _admissionController = TextEditingController(
      text: widget.initialAdmissionId?.toString() ?? '',
    );
    _attempts = widget.attempts ?? IdempotencyAttemptRegistry();
    if (widget.initialAdmissionId != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _loadProjection());
    }
  }

  @override
  void dispose() {
    _admissionController.dispose();
    _notesController.dispose();
    super.dispose();
  }

  Future<void> _loadProjection({
    String? conflictCode,
    Map<String, dynamic>? conflictDetails,
  }) async {
    if (!OnlineOnlyActionGuard.isOnline) return;
    final admissionId = int.tryParse(_admissionController.text.trim());
    if (admissionId == null || admissionId <= 0) {
      setState(() {
        _error = AppStrings.of(context)
            .lookup('ward_indent.request.admission_invalid');
      });
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
      _conflictCode = conflictCode;
      _conflictDetails = conflictDetails;
      _projection = null;
      _selectedOrder = null;
    });
    try {
      final projection = await widget.gateway.loadOrderBoundProjection(
        admissionId,
      );
      if (!mounted) return;
      setState(() {
        _projection = projection;
        _selectedOrder = null;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = _errorText(error);
        _loading = false;
      });
    }
  }

  Future<void> _submit() async {
    if (!OnlineOnlyActionGuard.isOnline) return;
    final projection = _projection;
    final order = _selectedOrder;
    if (projection == null || order == null || _submitting) return;
    final command = WardIndentOrderBoundCommand(
      admissionId: projection.admission.id,
      order: order,
      notes: _notesController.text,
    );
    final payload = command.toRequestBody();
    final idempotencyKey = _attempts.keyFor(_attemptScope, payload);
    setState(() {
      _submitting = true;
      _error = null;
      _conflictCode = null;
      _conflictDetails = null;
    });
    try {
      final created = await widget.gateway.createOrderBoundRequest(
        command,
        idempotencyKey: idempotencyKey,
      );
      _attempts.complete(_attemptScope);
      if (mounted) Navigator.of(context).pop(created);
    } on WardIndentRequestConflict catch (error) {
      if (!mounted) return;
      _attempts.complete(_attemptScope);
      final winningIndentId = error.winningIndentId;
      if (error.code == 'WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED' &&
          winningIndentId != null) {
        try {
          final winning = await widget.gateway.getIndent(winningIndentId);
          if (mounted) Navigator.of(context).pop(winning);
          return;
        } catch (_) {
          if (!mounted) return;
        }
      }
      setState(() => _submitting = false);
      await _loadProjection(
        conflictCode: error.code,
        conflictDetails: error.details,
      );
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = _errorText(error);
        _submitting = false;
      });
    }
  }

  String _conflictMessage(AppStrings strings) {
    final details = _conflictDetails;
    final expectedCatalog = details?['expected_catalog_id'];
    final expectedQuantity = details?['expected_quantity'];
    final expectedUnit = details?['expected_unit'];
    if (expectedCatalog != null ||
        expectedQuantity != null ||
        expectedUnit != null) {
      return strings.format('ward_indent.request.conflict.canonical_changed', {
        'catalog': expectedCatalog ?? '-',
        'quantity': expectedQuantity ?? '-',
        'unit': expectedUnit ?? '-',
      });
    }
    return switch (_conflictCode) {
      'WARD_INDENT_ADMISSION_INACTIVE' => strings.lookup(
        'ward_indent.request.conflict.admission_inactive',
      ),
      'WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED' => strings.lookup(
        'ward_indent.request.conflict.already_linked',
      ),
      _ => strings.lookup('ward_indent.request.conflict.projection_changed'),
    };
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final projection = _projection;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          20,
          16,
          20,
          20 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                strings.lookup('ward_indent.request.title'),
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 4),
              Text(strings.lookup('ward_indent.request.help')),
              const SizedBox(height: 16),
              OnlineOnlyActionState(
                builder: (context, isOnline, offlineMessage) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: TextField(
                            key: const Key('ward-indent-request-admission-id'),
                            controller: _admissionController,
                            keyboardType: TextInputType.number,
                            enabled: !_loading && !_submitting,
                            decoration: InputDecoration(
                              labelText: strings.lookup(
                                'ward_indent.request.admission_id',
                              ),
                              hintText: strings.lookup(
                                'ward_indent.request.admission_hint',
                              ),
                            ),
                            onChanged: (_) {
                              _attempts.complete(_attemptScope);
                              _notesController.clear();
                              setState(() {
                                _projection = null;
                                _selectedOrder = null;
                                _error = null;
                                _conflictCode = null;
                                _conflictDetails = null;
                              });
                            },
                          ),
                        ),
                        const SizedBox(width: 8),
                        FilledButton.tonal(
                          key: const Key('ward-indent-request-load'),
                          onPressed: isOnline && !_loading && !_submitting
                              ? _loadProjection
                              : null,
                          child: Text(
                            strings.lookup('ward_indent.request.load'),
                          ),
                        ),
                      ],
                    ),
                    if (!isOnline) ...[
                      const SizedBox(height: 8),
                      Text(
                        offlineMessage,
                        key: const Key('ward-indent-request-offline'),
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ],
                    if (_loading) ...[
                      const SizedBox(height: 12),
                      const LinearProgressIndicator(),
                    ],
                    if (_conflictCode != null) ...[
                      const SizedBox(height: 12),
                      Card(
                        key: const Key('ward-indent-request-conflict'),
                        color: Theme.of(context).colorScheme.errorContainer,
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Text(
                            _conflictMessage(strings),
                            style: TextStyle(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onErrorContainer,
                            ),
                          ),
                        ),
                      ),
                    ],
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      Text(
                        _error!,
                        key: const Key('ward-indent-request-error'),
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ],
                    if (projection != null) ...[
                      const SizedBox(height: 16),
                      _AdmissionContextCard(context: projection.admission),
                      const SizedBox(height: 12),
                      if (!projection.hasEligibleOrders)
                        Text(
                          strings.lookup('ward_indent.request.none_eligible'),
                          key: const Key('ward-indent-request-empty'),
                        )
                      else ...[
                        Text(
                          strings.lookup('ward_indent.request.select_order'),
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const SizedBox(height: 8),
                        for (final order in projection.eligibleOrders)
                          Card(
                            key: Key(
                              'ward-indent-request-order-${order.clinicalOrderId}',
                            ),
                            color:
                                _selectedOrder?.clinicalOrderId ==
                                    order.clinicalOrderId
                                ? Theme.of(context).colorScheme.primaryContainer
                                : null,
                            child: ListTile(
                              onTap: _submitting
                                  ? null
                                  : () {
                                      if (_selectedOrder?.clinicalOrderId !=
                                          order.clinicalOrderId) {
                                        _attempts.complete(_attemptScope);
                                        _notesController.clear();
                                      }
                                      setState(() {
                                        _selectedOrder = order;
                                        _error = null;
                                        _conflictCode = null;
                                        _conflictDetails = null;
                                      });
                                    },
                              leading: Icon(
                                _selectedOrder?.clinicalOrderId ==
                                        order.clinicalOrderId
                                    ? Icons.radio_button_checked
                                    : Icons.radio_button_off,
                              ),
                              title: Text(order.itemLabel),
                              subtitle: Text(
                                strings.format(
                                  'ward_indent.request.order_summary',
                                  {
                                    'order':
                                        order.orderNumber ??
                                        '#${order.clinicalOrderId}',
                                    'quantity': _quantity(order.quantity),
                                    'unit': order.unit,
                                    'dose': order.dose ?? '-',
                                    'route': order.route ?? '-',
                                    'schedule': _schedule(order),
                                    'status': order.status,
                                    'priority': order.priority ?? '-',
                                  },
                                ),
                              ),
                            ),
                          ),
                        const SizedBox(height: 8),
                        TextField(
                          key: const Key('ward-indent-request-notes'),
                          controller: _notesController,
                          enabled: !_submitting,
                          minLines: 2,
                          maxLines: 4,
                          decoration: InputDecoration(
                            labelText: strings.lookup(
                              'ward_indent.request.notes',
                            ),
                            hintText: strings.lookup(
                              'ward_indent.request.notes_hint',
                            ),
                          ),
                        ),
                      ],
                    ],
                    const SizedBox(height: 16),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        TextButton(
                          onPressed: _submitting
                              ? null
                              : () => Navigator.of(context).pop(),
                          child: Text(strings.actionCancel),
                        ),
                        if (projection?.hasEligibleOrders == true) ...[
                          const SizedBox(width: 8),
                          FilledButton.icon(
                            key: const Key('ward-indent-request-submit'),
                            onPressed:
                                isOnline &&
                                    !_submitting &&
                                    _selectedOrder != null
                                ? _submit
                                : null,
                            icon: _submitting
                                ? const SizedBox.square(
                                    dimension: 16,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : const Icon(Icons.add_shopping_cart),
                            label: Text(
                              strings.lookup('ward_indent.request.submit'),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AdmissionContextCard extends StatelessWidget {
  const _AdmissionContextCard({required this.context});

  final WardIndentRequestAdmissionContext context;

  @override
  Widget build(BuildContext buildContext) {
    final strings = AppStrings.of(buildContext);
    return Card(
      key: const Key('ward-indent-request-context'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              strings.lookup('ward_indent.request.context'),
              style: Theme.of(buildContext).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(
              strings.format('ward_indent.request.patient_context', {
                'patient': context.patientName ?? '-',
                'hospitalId': context.hospitalId ?? '-',
              }),
            ),
            Text(
              strings.format('ward_indent.request.ward_context', {
                'admission': context.id,
                'ward': context.wardName ?? '-',
              }),
            ),
          ],
        ),
      ),
    );
  }
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

String _schedule(WardIndentEligibleOrder order) {
  final values = [
    if (order.frequency != null) order.frequency!,
    ...order.schedule,
  ];
  return values.isEmpty ? '-' : values.join(' / ');
}
