import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/platform_info.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/services/idempotency_attempt_registry.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/api_error_messages.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';
import '../models/order_draft.dart';
import '../widgets/patient_summary_sheet.dart';

const _nursingOrderVerifyRoles = <String>{
  'NURSING_STAFF',
  'NURSING_INCHARGE',
  'IP_STAFF_NURSE',
  'IP_INCHARGE',
  'ICU_NURSE',
  'ICU_INCHARGE',
};

const _medicationOrderVerifyRoles = <String>{
  ..._nursingOrderVerifyRoles,
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
  'PHARMACIST',
};

@visibleForTesting
bool canVerifyMedicationOrders(String? role) =>
    _medicationOrderVerifyRoles.contains(role?.trim().toUpperCase() ?? '');

@visibleForTesting
bool canRunMedicationOrderVerification(
  String? role,
  AppDeviceMode deviceMode,
) => canVerifyMedicationOrders(role) && deviceMode != AppDeviceMode.mobile;

@visibleForTesting
bool canRunClinicalOrderVerification(
  String? role,
  AppDeviceMode deviceMode,
  String? orderType,
) {
  if (deviceMode == AppDeviceMode.mobile) return false;
  final normalizedRole = role?.trim().toUpperCase() ?? '';
  final normalizedType = orderType?.trim().toLowerCase() ?? '';
  if (normalizedType.isEmpty) return false;
  if (_nursingOrderVerifyRoles.contains(normalizedRole)) return true;
  return normalizedType == 'medication' &&
      _medicationOrderVerifyRoles.contains(normalizedRole);
}

@visibleForTesting
bool canRunMedicationOrderMarRecovery(String? role, AppDeviceMode deviceMode) {
  return canPrescribeMedicationOrders(role) &&
      deviceMode != AppDeviceMode.mobile;
}

class IcuMarReviewBanner extends StatelessWidget {
  const IcuMarReviewBanner({super.key, required this.icuAdmissionId});

  final int icuAdmissionId;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final message = s.ordersIcuMarReviewBanner(icuAdmissionId);
    return Semantics(
      container: true,
      liveRegion: true,
      label: message,
      child: Container(
        key: Key('icu-mar-review-banner-$icuAdmissionId'),
        width: double.infinity,
        margin: const EdgeInsets.fromLTRB(12, 12, 12, 4),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppTheme.warningAmber.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppTheme.warningAmber),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.medication_outlined, color: AppTheme.warningAmber),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                message,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// EMR Orders screen (roadmap E1) — patient order list with full status
/// visibility (ordered → verified → completed / cancelled / discontinued),
/// lifecycle actions with mandatory reasons, and entry into the CPOE order
/// composer. Order CREATION lives in OrderComposerScreen — searchable
/// catalog, order sets, basket, inline CDS — pushed from the FAB.
class OrdersScreen extends StatefulWidget {
  final String patientUid;
  final String? patientName;
  final String? encounterId;
  final int? marRecoveryOrderId;
  final int? icuMarReviewAdmissionId;

  const OrdersScreen({
    super.key,
    required this.patientUid,
    this.patientName,
    this.encounterId,
    this.marRecoveryOrderId,
    this.icuMarReviewAdmissionId,
  });

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
  List<Map<String, dynamic>> _orders = [];
  bool _loading = true;
  String? _error;
  String? _filterStatus;
  String? _role;
  final Set<int> _recoveringMarOrders = <int>{};
  final Set<int> _verifyingOrders = <int>{};
  final IdempotencyAttemptRegistry _marRecoveryAttempts =
      IdempotencyAttemptRegistry();
  final IdempotencyAttemptRegistry _verificationAttempts =
      IdempotencyAttemptRegistry();
  final IdempotencyAttemptRegistry _terminalOrderAttempts =
      IdempotencyAttemptRegistry();

  bool get _prescriberCanRecoverMar => canPrescribeMedicationOrders(_role);

  bool get _deviceCanRecoverMar =>
      appDeviceModeForContext(context) != AppDeviceMode.mobile;

  bool get _canRecoverMar =>
      canRunMedicationOrderMarRecovery(_role, appDeviceModeForContext(context));

  bool _canVerifyOrder(String? orderType) => canRunClinicalOrderVerification(
    _role,
    appDeviceModeForContext(context),
    orderType,
  );

  @override
  void initState() {
    super.initState();
    _loadOrders();
    _loadRole();
  }

  @override
  void dispose() {
    _marRecoveryAttempts.clear();
    _verificationAttempts.clear();
    _terminalOrderAttempts.clear();
    super.dispose();
  }

  Future<void> _loadRole() async {
    try {
      final role = await AuthService.getRole();
      if (mounted) setState(() => _role = role);
    } catch (_) {
      if (mounted) setState(() => _role = null);
    }
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
    final result = _filterStatus == null
        ? List<Map<String, dynamic>>.of(_orders)
        : _orders
              .where(
                (o) => (o['status'] as String?)?.toLowerCase() == _filterStatus,
              )
              .toList();
    final recoveryOrderId = widget.marRecoveryOrderId;
    if (recoveryOrderId != null) {
      result.sort((a, b) {
        final aTarget = a['id'] == recoveryOrderId ? 0 : 1;
        final bTarget = b['id'] == recoveryOrderId ? 0 : 1;
        return aTarget.compareTo(bTarget);
      });
    }
    return result;
  }

  bool get _recoveryTargetPending {
    final target = widget.marRecoveryOrderId;
    if (target == null) return false;
    return _orders.any(
      (order) =>
          order['id'] == target &&
          order['mar_schedule_status'] == 'action_required',
    );
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
    if (placed == true && mounted) unawaited(_loadOrders());
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

  Future<void> _verifyOrder(int id, String? orderType) async {
    if (!_canVerifyOrder(orderType) || _verifyingOrders.contains(id)) return;
    final s = AppStrings.of(context);
    final attemptScope = 'clinical-order-verify:$id';
    final idempotencyKey = _verificationAttempts.keyFor(
      attemptScope,
      const <String, dynamic>{},
    );
    setState(() => _verifyingOrders.add(id));
    try {
      await MedicalApiService.verifyOrder(id, idempotencyKey: idempotencyKey);
      _verificationAttempts.complete(attemptScope);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.ordersVerifiedToast),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        unawaited(_loadOrders());
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
    } finally {
      if (mounted) setState(() => _verifyingOrders.remove(id));
    }
  }

  Future<void> _completeOrder(int id) async {
    final s = AppStrings.of(context);
    final attemptScope = 'clinical-order-terminal:complete:$id';
    final idempotencyKey = _terminalOrderAttempts.keyFor(
      attemptScope,
      const <String, dynamic>{},
    );
    try {
      await MedicalApiService.completeOrder(id, idempotencyKey: idempotencyKey);
      _terminalOrderAttempts.complete(attemptScope);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.ordersCompletedToast),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        unawaited(_loadOrders());
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

  Future<void> _retryMarScheduling(int id) async {
    if (_recoveringMarOrders.contains(id)) return;
    final s = AppStrings.of(context);
    final attemptScope = 'clinical-order-mar-recovery:$id';
    final idempotencyKey = _marRecoveryAttempts.keyFor(
      attemptScope,
      const <String, dynamic>{},
    );
    setState(() => _recoveringMarOrders.add(id));
    try {
      final result = await MedicalApiService.retryMedicationOrderMarScheduling(
        orderId: id,
        idempotencyKey: idempotencyKey,
      );
      _marRecoveryAttempts.complete(attemptScope);
      if (mounted) {
        final count = (result['scheduled_dose_count'] as num?)?.toInt() ?? 0;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.ordersMarRecoverySuccess(count)),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        await _loadOrders();
      }
    } catch (e) {
      if (mounted) {
        final localizedError = localizedApiErrorFromRaw(s, e);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.ordersMarRecoveryFailed(localizedError)),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _recoveringMarOrders.remove(id));
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
    final trimmedReason = reason.trim();
    final action = discontinue ? 'discontinue' : 'cancel';
    final attemptScope = 'clinical-order-terminal:$action:$id';
    final requestBody = <String, dynamic>{'reason': trimmedReason};
    final idempotencyKey = _terminalOrderAttempts.keyFor(
      attemptScope,
      requestBody,
    );
    try {
      if (discontinue) {
        await MedicalApiService.discontinueClinicalOrder(
          orderId: id,
          reason: trimmedReason,
          idempotencyKey: idempotencyKey,
        );
      } else {
        await MedicalApiService.cancelClinicalOrder(
          orderId: id,
          reason: trimmedReason,
          idempotencyKey: idempotencyKey,
        );
      }
      _terminalOrderAttempts.complete(attemptScope);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              discontinue ? s.ordersDiscontinuedToast : s.ordersCancelledToast,
            ),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        unawaited(_loadOrders());
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
                if (widget.icuMarReviewAdmissionId case final admissionId?)
                  IcuMarReviewBanner(icuAdmissionId: admissionId),
                if (_recoveryTargetPending)
                  Container(
                    width: double.infinity,
                    margin: const EdgeInsets.fromLTRB(12, 12, 12, 4),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppTheme.warningAmber.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: AppTheme.warningAmber),
                    ),
                    child: Row(
                      children: [
                        const Icon(
                          Icons.warning_amber_rounded,
                          color: AppTheme.warningAmber,
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(s.ordersMarRecoveryRequired),
                              if (!_deviceCanRecoverMar) ...[
                                const SizedBox(height: 4),
                                Text(
                                  s.lookup('orders.mar_recovery.desktop_only'),
                                  key: const Key(
                                    'mar-recovery-desktop-only-banner',
                                  ),
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
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
    final active = const {
      'ordered',
      'verified',
      'in_progress',
    }.contains(statusLower);
    final discontinue =
        statusLower == 'verified' || statusLower == 'in_progress';
    final marRecoveryRequired =
        type?.toLowerCase() == 'medication' &&
        order['mar_schedule_status'] == 'action_required';
    final recoveringMar =
        orderId is int && _recoveringMarOrders.contains(orderId);
    final verifying = orderId is int && _verifyingOrders.contains(orderId);

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
              if (marRecoveryRequired &&
                  _prescriberCanRecoverMar &&
                  !_deviceCanRecoverMar) ...[
                const SizedBox(height: 8),
                Text(
                  s.lookup('orders.mar_recovery.desktop_only'),
                  key: Key('mar-recovery-desktop-only-$orderId'),
                  style: const TextStyle(
                    color: AppTheme.warningAmber,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
              const SizedBox(height: 10),
              Wrap(
                alignment: WrapAlignment.end,
                spacing: 4,
                children: [
                  if (marRecoveryRequired && _prescriberCanRecoverMar)
                    TextButton.icon(
                      onPressed: recoveringMar || !_canRecoverMar
                          ? null
                          : () => _retryMarScheduling(orderId),
                      icon: recoveringMar
                          ? const SizedBox.square(
                              dimension: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.replay_circle_filled, size: 18),
                      label: Text(s.ordersMarRecoveryAction),
                      style: TextButton.styleFrom(
                        foregroundColor: AppTheme.warningAmber,
                      ),
                    ),
                  TextButton.icon(
                    onPressed: () =>
                        _stopOrder(orderId, discontinue: discontinue),
                    icon: const Icon(Icons.block, size: 18),
                    label: Text(
                      discontinue ? s.ordersDiscontinue : s.ordersCancel,
                    ),
                    style: TextButton.styleFrom(
                      foregroundColor: AppTheme.errorRed,
                    ),
                  ),
                  if (statusLower == 'ordered' && _canVerifyOrder(type))
                    TextButton.icon(
                      onPressed: verifying
                          ? null
                          : () => _verifyOrder(orderId, type),
                      icon: verifying
                          ? const SizedBox.square(
                              dimension: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.check_circle_outline, size: 18),
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
