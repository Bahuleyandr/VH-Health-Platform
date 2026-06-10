import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';
import '../models/order_draft.dart';
import '../widgets/patient_summary_sheet.dart';

/// EMR Orders screen (roadmap E1) — patient order list with full status
/// visibility (ordered → verified → completed / cancelled / discontinued),
/// lifecycle actions with mandatory reasons, and entry into the CPOE order
/// composer. Order CREATION lives in OrderComposerScreen — searchable
/// catalog, order sets, basket, inline CDS — pushed from the FAB.
class OrdersScreen extends StatefulWidget {
  final String patientUid;
  final String? patientName;
  final String? encounterId;

  const OrdersScreen({
    super.key,
    required this.patientUid,
    this.patientName,
    this.encounterId,
  });

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
  List<Map<String, dynamic>> _orders = [];
  bool _loading = true;
  String? _error;
  String? _filterStatus;

  @override
  void initState() {
    super.initState();
    _loadOrders();
  }

  Future<void> _loadOrders() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await MedicalApiService.getPatientOrders(widget.patientUid);
      final list = data['orders'] ?? data['data'];
      setState(() {
        _orders = list is List
            ? list
                  .whereType<Map>()
                  .map((e) => Map<String, dynamic>.from(e))
                  .toList()
            : [];
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  List<Map<String, dynamic>> get _filteredOrders {
    if (_filterStatus == null) return _orders;
    return _orders
        .where((o) => (o['status'] as String?)?.toLowerCase() == _filterStatus)
        .toList();
  }

  Future<void> _openComposer() async {
    final params = <String>[
      if (widget.patientName != null && widget.patientName!.isNotEmpty)
        'name=${Uri.encodeQueryComponent(widget.patientName!)}',
      if (widget.encounterId != null && widget.encounterId!.isNotEmpty)
        'encounter=${Uri.encodeQueryComponent(widget.encounterId!)}',
    ];
    final query = params.isEmpty ? '' : '?${params.join('&')}';
    final placed = await context.push<bool>(
      '/emr/orders/${widget.patientUid}/compose$query',
    );
    if (placed == true && mounted) _loadOrders();
  }

  // ── Status badge ──

  Widget _statusBadge(String? status) {
    final s = AppStrings.of(context);
    Color fg;
    String label;
    switch (status?.toLowerCase()) {
      case 'ordered':
        fg = AppTheme.primaryBlue;
        label = s.ordersFilterOrdered;
      case 'verified':
        fg = AppTheme.accentCyan;
        label = s.ordersFilterVerified;
      case 'completed':
        fg = AppTheme.successGreen;
        label = s.ordersFilterCompleted;
      case 'cancelled':
        fg = AppTheme.errorRed;
        label = s.ordersFilterCancelled;
      case 'discontinued':
        fg = const Color(0xFF7B1FA2);
        label = s.ordersFilterDiscontinued;
      default:
        fg = AppTheme.textSecondary;
        label = (status ?? '—').toUpperCase();
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: fg.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        label.toUpperCase(),
        style: TextStyle(color: fg, fontSize: 10, fontWeight: FontWeight.w600),
      ),
    );
  }

  Widget _priorityChip(String? priority) {
    final s = AppStrings.of(context);
    final p = priority?.toLowerCase();
    if (p == null || p == 'routine') return const SizedBox.shrink();
    final color = p == 'stat' ? AppTheme.errorRed : AppTheme.warningAmber;
    final label = p == 'stat'
        ? s.ordersPriorityStat
        : p == 'urgent'
        ? s.ordersPriorityUrgent
        : p.toUpperCase();
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(
          label.toUpperCase(),
          style: TextStyle(
            color: color,
            fontSize: 10,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }

  // ── Order type icon ──

  IconData _orderTypeIcon(String? type) {
    switch (type?.toLowerCase()) {
      case 'medication':
        return Icons.medication;
      case 'investigation':
      case 'lab':
        return Icons.biotech;
      case 'radiology':
      case 'imaging':
        return Icons.camera_alt;
      case 'ecg':
        return Icons.monitor_heart;
      case 'consultation':
      case 'consult':
        return Icons.people_alt;
      case 'nursing':
        return Icons.medical_services;
      case 'diet':
        return Icons.restaurant;
      case 'procedure':
        return Icons.healing;
      default:
        return Icons.receipt_long;
    }
  }

  Color _orderTypeColor(String? type) {
    switch (type?.toLowerCase()) {
      case 'medication':
        return const Color(0xFFE65100);
      case 'investigation':
      case 'lab':
        return const Color(0xFF558B2F);
      case 'radiology':
      case 'imaging':
      case 'ecg':
        return const Color(0xFF6A1B9A);
      case 'consultation':
      case 'consult':
        return const Color(0xFFC62828);
      case 'nursing':
        return AppTheme.primaryTeal;
      case 'diet':
        return AppTheme.warningAmber;
      case 'procedure':
        return const Color(0xFF7B1FA2);
      default:
        return AppTheme.primaryBlue;
    }
  }

  // ── Lifecycle actions ──

  Future<void> _verifyOrder(int id) async {
    final s = AppStrings.of(context);
    try {
      await MedicalApiService.verifyOrder(id);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.ordersVerifiedToast),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _loadOrders();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.ordersVerifyFailed(e.toString())),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  Future<void> _completeOrder(int id) async {
    final s = AppStrings.of(context);
    try {
      await MedicalApiService.completeOrder(id);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.ordersCompletedToast),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _loadOrders();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.ordersCompleteFailed(e.toString())),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  /// Shared stop flow — cancel (never started) or discontinue (stop an
  /// active order). Both require a documented reason server-side.
  Future<void> _stopOrder(int id, {required bool discontinue}) async {
    final s = AppStrings.of(context);
    final reason = await _askReason(
      title: discontinue ? s.ordersDiscontinueTitle : s.ordersCancelTitle,
      hint: s.ordersStopReasonHint,
    );
    if (reason == null || reason.trim().length < 3 || !mounted) return;
    try {
      if (discontinue) {
        await MedicalApiService.discontinueClinicalOrder(
          orderId: id,
          reason: reason.trim(),
        );
      } else {
        await MedicalApiService.cancelClinicalOrder(
          orderId: id,
          reason: reason.trim(),
        );
      }
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              discontinue ? s.ordersDiscontinuedToast : s.ordersCancelledToast,
            ),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _loadOrders();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.ordersStopFailed(e.toString())),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  Future<String?> _askReason({required String title, required String hint}) {
    final s = AppStrings.of(context);
    final ctrl = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLines: 2,
          decoration: InputDecoration(
            labelText: s.ordersStopReasonLabel,
            hintText: hint,
            border: const OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text),
            child: Text(s.actionConfirm),
          ),
        ],
      ),
    );
  }

  // ── Filter chips ──

  Widget _buildStatusFilters() {
    const statuses = [
      null,
      'ordered',
      'verified',
      'completed',
      'cancelled',
      'discontinued',
    ];
    final s = AppStrings.of(context);
    final labels = [
      s.ordersFilterAll,
      s.ordersFilterOrdered,
      s.ordersFilterVerified,
      s.ordersFilterCompleted,
      s.ordersFilterCancelled,
      s.ordersFilterDiscontinued,
    ];

    return SizedBox(
      height: 44,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        itemCount: statuses.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (ctx, i) {
          final selected = _filterStatus == statuses[i];
          return FilterChip(
            label: Text(labels[i]),
            selected: selected,
            onSelected: (_) {
              setState(() => _filterStatus = statuses[i]);
            },
            selectedColor: AppTheme.primaryBlue.withValues(alpha: 0.15),
            checkmarkColor: AppTheme.primaryBlue,
            labelStyle: TextStyle(
              color: selected ? AppTheme.primaryBlue : AppTheme.textSecondary,
              fontSize: 12,
              fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
            ),
          );
        },
      ),
    );
  }

  // ── Timestamp ──

  String _formatTimestamp(String? ts) {
    if (ts == null) return '-';
    try {
      final dt = DateTime.parse(ts);
      return '${dt.day}/${dt.month} ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return ts;
    }
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _filteredOrders;

    final s = AppStrings.of(context);
    return StaffScaffold(
      title: widget.patientName != null
          ? s.ordersTitleWithName(widget.patientName!)
          : s.ordersTitle,
      actions: [
        IconButton(
          tooltip: s.summaryTooltip,
          icon: const Icon(Icons.assignment_ind_outlined),
          onPressed: () => PatientSummarySheet.show(
            context,
            patientUid: widget.patientUid,
            patientName: widget.patientName,
          ),
        ),
      ],
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _openComposer,
        backgroundColor: AppTheme.primaryBlue,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add_circle_outline),
        label: Text(s.ordersNewOrder),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.error_outline,
                    size: 48,
                    color: AppTheme.errorRed,
                  ),
                  const SizedBox(height: 12),
                  Text(_error!, textAlign: TextAlign.center),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: _loadOrders,
                    child: Text(s.ordersRetry),
                  ),
                ],
              ),
            )
          : Column(
              children: [
                const SizedBox(height: 8),
                _buildStatusFilters(),
                const SizedBox(height: 4),
                Expanded(
                  child: filtered.isEmpty
                      ? Center(
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(
                                Icons.receipt_long,
                                size: 64,
                                color: AppTheme.divider,
                              ),
                              const SizedBox(height: 12),
                              Text(
                                s.ordersNoFound,
                                style: TextStyle(color: AppTheme.textSecondary),
                              ),
                            ],
                          ),
                        )
                      : RefreshIndicator(
                          onRefresh: _loadOrders,
                          child: ListView.builder(
                            padding: const EdgeInsets.all(12),
                            itemCount: filtered.length,
                            itemBuilder: (ctx, i) => _orderCard(s, filtered[i]),
                          ),
                        ),
                ),
              ],
            ),
    );
  }

  Widget _orderCard(AppStrings s, Map<String, dynamic> order) {
    final type = order['order_type'] as String?;
    final status = order['status'] as String?;
    final orderId = order['id'];
    final color = _orderTypeColor(type);
    final display = orderDisplayFields(order);
    final orderNumber = order['order_number']?.toString();
    final statusLower = status?.toLowerCase();
    final active = statusLower == 'ordered' || statusLower == 'verified';

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 18,
                  backgroundColor: color.withValues(alpha: 0.15),
                  child: Icon(_orderTypeIcon(type), color: color, size: 18),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        display.title.isEmpty
                            ? s.ordersFallback
                            : display.title,
                        style: const TextStyle(
                          fontWeight: FontWeight.w600,
                          fontSize: 14,
                        ),
                      ),
                      Text(
                        [
                          (type ?? 'order').toUpperCase(),
                          if (orderNumber != null && orderNumber.isNotEmpty)
                            orderNumber,
                          _formatTimestamp(order['created_at'] as String?),
                        ].join(' - '),
                        style: TextStyle(
                          fontSize: 12,
                          color: AppTheme.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
                _priorityChip(order['priority'] as String?),
                _statusBadge(status),
              ],
            ),
            if (display.subtitle.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                display.subtitle,
                style: TextStyle(fontSize: 13, color: AppTheme.textSecondary),
              ),
            ],
            if (order['ordered_by_name'] != null ||
                order['ordered_by'] != null) ...[
              const SizedBox(height: 4),
              Row(
                children: [
                  Icon(
                    Icons.person_outline,
                    size: 13,
                    color: AppTheme.textSecondary,
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      (order['ordered_by_name'] ?? order['ordered_by'])
                          .toString(),
                      style: TextStyle(
                        fontSize: 12,
                        color: AppTheme.textSecondary,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ],
            if (orderId is int && active) ...[
              const SizedBox(height: 10),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton.icon(
                    onPressed: () => _stopOrder(
                      orderId,
                      discontinue: statusLower == 'verified',
                    ),
                    icon: const Icon(Icons.block, size: 18),
                    label: Text(
                      statusLower == 'verified'
                          ? s.ordersDiscontinue
                          : s.ordersCancel,
                    ),
                    style: TextButton.styleFrom(
                      foregroundColor: AppTheme.errorRed,
                    ),
                  ),
                  if (statusLower == 'ordered')
                    TextButton.icon(
                      onPressed: () => _verifyOrder(orderId),
                      icon: const Icon(Icons.check_circle_outline, size: 18),
                      label: Text(s.ordersVerify),
                      style: TextButton.styleFrom(
                        foregroundColor: AppTheme.accentCyan,
                      ),
                    ),
                  if (statusLower == 'verified')
                    TextButton.icon(
                      onPressed: () => _completeOrder(orderId),
                      icon: const Icon(Icons.done_all, size: 18),
                      label: Text(s.ordersComplete),
                      style: TextButton.styleFrom(
                        foregroundColor: AppTheme.successGreen,
                      ),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
