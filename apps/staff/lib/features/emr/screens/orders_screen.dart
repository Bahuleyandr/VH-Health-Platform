import 'package:flutter/material.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

/// EMR Orders screen — list, create, verify, and complete patient orders.
class OrdersScreen extends StatefulWidget {
  final String patientUid;
  final String? patientName;

  const OrdersScreen({super.key, required this.patientUid, this.patientName});

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
      final list = data['orders'];
      setState(() {
        _orders = list is List
            ? list.map((e) => Map<String, dynamic>.from(e as Map)).toList()
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

  // ── Status Badge ──

  Widget _statusBadge(String? status) {
    Color bg;
    Color fg;
    switch (status?.toLowerCase()) {
      case 'ordered':
        bg = AppTheme.primaryBlue.withValues(alpha: 0.12);
        fg = AppTheme.primaryBlue;
        break;
      case 'verified':
        bg = AppTheme.accentCyan.withValues(alpha: 0.12);
        fg = AppTheme.accentCyan;
        break;
      case 'completed':
        bg = AppTheme.successGreen.withValues(alpha: 0.12);
        fg = AppTheme.successGreen;
        break;
      case 'cancelled':
        bg = AppTheme.errorRed.withValues(alpha: 0.12);
        fg = AppTheme.errorRed;
        break;
      default:
        bg = AppTheme.textSecondary.withValues(alpha: 0.12);
        fg = AppTheme.textSecondary;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        status?.toUpperCase() ?? 'UNKNOWN',
        style: TextStyle(color: fg, fontSize: 10, fontWeight: FontWeight.w600),
      ),
    );
  }

  // ── Order Type Icon ──

  IconData _orderTypeIcon(String? type) {
    switch (type?.toLowerCase()) {
      case 'medication':
        return Icons.medication;
      case 'investigation':
      case 'lab':
        return Icons.biotech;
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

  // ── Verify / Complete Actions ──

  Future<void> _verifyOrder(int id) async {
    try {
      await MedicalApiService.verifyOrder(id);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context).ordersVerifiedToast),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _loadOrders();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              AppStrings.of(context).ordersVerifyFailed(e.toString()),
            ),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  Future<void> _completeOrder(int id) async {
    try {
      await MedicalApiService.completeOrder(id);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context).ordersCompletedToast),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _loadOrders();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              AppStrings.of(context).ordersCompleteFailed(e.toString()),
            ),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  // ── Create Order ──

  void _showCreateOrderSheet() {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Container(
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: AppTheme.divider,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            SizedBox(height: 16),
            Text(
              AppStrings.of(ctx).ordersNewOrder,
              style: TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.w600,
                color: AppTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 20),
            _orderTypeOption(
              icon: Icons.medication,
              label: AppStrings.of(ctx).ordersTypeMedication,
              color: const Color(0xFFE65100),
              onTap: () {
                Navigator.pop(ctx);
                _showMedicationOrderForm();
              },
            ),
            _orderTypeOption(
              icon: Icons.biotech,
              label: AppStrings.of(ctx).ordersTypeInvestigation,
              color: const Color(0xFF558B2F),
              onTap: () {
                Navigator.pop(ctx);
                _showInvestigationOrderForm();
              },
            ),
            _orderTypeOption(
              icon: Icons.medical_services,
              label: AppStrings.of(ctx).ordersTypeNursing,
              color: AppTheme.primaryTeal,
              onTap: () {
                Navigator.pop(ctx);
                _showNursingOrderForm();
              },
            ),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }

  Widget _orderTypeOption({
    required IconData icon,
    required String label,
    required Color color,
    required VoidCallback onTap,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        tileColor: color.withValues(alpha: 0.06),
        leading: CircleAvatar(
          backgroundColor: color.withValues(alpha: 0.15),
          child: Icon(icon, color: color),
        ),
        title: Text(label, style: const TextStyle(fontWeight: FontWeight.w500)),
        trailing: const Icon(Icons.arrow_forward_ios, size: 16),
        onTap: onTap,
      ),
    );
  }

  void _showMedicationOrderForm() {
    final formKey = GlobalKey<FormState>();
    final medication = TextEditingController();
    final dosage = TextEditingController();
    final frequency = TextEditingController();
    final route = TextEditingController();
    final duration = TextEditingController();
    final instructions = TextEditingController();
    bool stat = false;

    final s = AppStrings.of(context);
    _showOrderFormSheet(
      title: s.ordersTypeMedication,
      formKey: formKey,
      fieldsBuilder: (setSheetState) => [
        TextFormField(
          controller: medication,
          decoration: InputDecoration(
            labelText: s.ordersMedicationName,
            prefixIcon: const ExcludeSemantics(child: Icon(Icons.medication)),
            border: const OutlineInputBorder(),
          ),
          validator: (v) =>
              (v == null || v.isEmpty) ? s.admissionRequired : null,
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: TextFormField(
                controller: dosage,
                decoration: InputDecoration(
                  labelText: s.ordersDosage,
                  border: const OutlineInputBorder(),
                ),
                validator: (v) =>
                    (v == null || v.isEmpty) ? s.admissionRequired : null,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: TextFormField(
                controller: route,
                decoration: InputDecoration(
                  labelText: s.ordersRoute,
                  hintText: s.ordersRouteHint,
                  border: const OutlineInputBorder(),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: TextFormField(
                controller: frequency,
                decoration: InputDecoration(
                  labelText: s.ordersFrequency,
                  hintText: s.ordersFrequencyHint,
                  border: const OutlineInputBorder(),
                ),
                validator: (v) =>
                    (v == null || v.isEmpty) ? s.admissionRequired : null,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: TextFormField(
                controller: duration,
                decoration: InputDecoration(
                  labelText: s.ordersDuration,
                  hintText: s.ordersDurationHint,
                  border: const OutlineInputBorder(),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: instructions,
          decoration: InputDecoration(
            labelText: s.ordersSpecialInstructions,
            border: const OutlineInputBorder(),
          ),
          maxLines: 2,
        ),
        const SizedBox(height: 8),
        SwitchListTile(
          title: Text(s.ordersStatImmediate),
          value: stat,
          onChanged: (v) => setSheetState(() => stat = v),
          contentPadding: EdgeInsets.zero,
        ),
      ],
      onSubmit: () => _submitOrder(
        formKey: formKey,
        data: {
          'patient_uid': widget.patientUid,
          'order_type': 'medication',
          'medication': medication.text,
          'dosage': dosage.text,
          'frequency': frequency.text,
          'route': route.text,
          'duration': duration.text,
          'instructions': instructions.text,
          'stat': stat,
        },
      ),
    );
  }

  void _showInvestigationOrderForm() {
    final formKey = GlobalKey<FormState>();
    final investigation = TextEditingController();
    final reason = TextEditingController();
    String priority = 'routine';
    bool stat = false;

    final s = AppStrings.of(context);
    _showOrderFormSheet(
      title: s.ordersTypeInvestigation,
      formKey: formKey,
      fieldsBuilder: (setSheetState) => [
        TextFormField(
          controller: investigation,
          decoration: InputDecoration(
            labelText: s.ordersInvestigation,
            prefixIcon: const ExcludeSemantics(child: Icon(Icons.biotech)),
            hintText: s.ordersInvestigationHint,
            border: const OutlineInputBorder(),
          ),
          validator: (v) =>
              (v == null || v.isEmpty) ? s.admissionRequired : null,
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: reason,
          decoration: InputDecoration(
            labelText: s.ordersClinicalIndication,
            border: const OutlineInputBorder(),
          ),
          maxLines: 2,
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          initialValue: priority,
          decoration: InputDecoration(
            labelText: s.ordersPriority,
            border: const OutlineInputBorder(),
          ),
          items: [
            DropdownMenuItem(
              value: 'routine',
              child: Text(s.ordersPriorityRoutine),
            ),
            DropdownMenuItem(
              value: 'urgent',
              child: Text(s.ordersPriorityUrgent),
            ),
            DropdownMenuItem(value: 'stat', child: Text(s.ordersPriorityStat)),
          ],
          onChanged: (v) => setSheetState(() => priority = v ?? priority),
        ),
        const SizedBox(height: 8),
        SwitchListTile(
          title: Text(s.ordersFastingRequired),
          value: stat,
          onChanged: (v) => setSheetState(() => stat = v),
          contentPadding: EdgeInsets.zero,
        ),
      ],
      onSubmit: () => _submitOrder(
        formKey: formKey,
        data: {
          'patient_uid': widget.patientUid,
          'order_type': 'investigation',
          'investigation': investigation.text,
          'clinical_indication': reason.text,
          'priority': priority,
          'fasting_required': stat,
        },
      ),
    );
  }

  void _showNursingOrderForm() {
    final formKey = GlobalKey<FormState>();
    final description = TextEditingController();
    final frequency = TextEditingController();
    final instructions = TextEditingController();

    final s = AppStrings.of(context);
    _showOrderFormSheet(
      title: s.ordersTypeNursing,
      formKey: formKey,
      fieldsBuilder: (_) => [
        TextFormField(
          controller: description,
          decoration: InputDecoration(
            labelText: s.ordersDescription,
            prefixIcon: const ExcludeSemantics(
              child: Icon(Icons.medical_services),
            ),
            hintText: s.ordersDescriptionHint,
            border: const OutlineInputBorder(),
          ),
          validator: (v) =>
              (v == null || v.isEmpty) ? s.admissionRequired : null,
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: frequency,
          decoration: InputDecoration(
            labelText: s.ordersFrequency,
            hintText: s.ordersFrequencyHintNursing,
            border: const OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: instructions,
          decoration: InputDecoration(
            labelText: s.ordersSpecialInstructions,
            border: const OutlineInputBorder(),
          ),
          maxLines: 3,
        ),
      ],
      onSubmit: () => _submitOrder(
        formKey: formKey,
        data: {
          'patient_uid': widget.patientUid,
          'order_type': 'nursing',
          'description': description.text,
          'frequency': frequency.text,
          'instructions': instructions.text,
        },
      ),
    );
  }

  void _showOrderFormSheet({
    required String title,
    required GlobalKey<FormState> formKey,
    required List<Widget> Function(StateSetter) fieldsBuilder,
    required VoidCallback onSubmit,
  }) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) => Container(
          padding: EdgeInsets.only(
            bottom: MediaQuery.of(ctx).viewInsets.bottom,
          ),
          decoration: const BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
          ),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Form(
              key: formKey,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Center(
                      child: Container(
                        width: 40,
                        height: 4,
                        decoration: BoxDecoration(
                          color: AppTheme.divider,
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                    ),
                    SizedBox(height: 16),
                    Text(
                      title,
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w600,
                        color: AppTheme.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 20),
                    ...fieldsBuilder(setSheetState),
                    const SizedBox(height: 16),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: onSubmit,
                        icon: const Icon(Icons.send),
                        label: Text(AppStrings.of(ctx).ordersPlaceOrder),
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _submitOrder({
    required GlobalKey<FormState> formKey,
    required Map<String, dynamic> data,
  }) async {
    if (!formKey.currentState!.validate()) return;
    Navigator.of(context).pop();

    try {
      // Run CDS check first
      try {
        final cdsResult = await MedicalApiService.checkOrder(data);
        final alerts = cdsResult['alerts'];
        if (alerts is List && alerts.isNotEmpty && mounted) {
          final proceed = await _showCdsAlerts(alerts);
          if (proceed != true) return;
        }
      } catch (_) {
        // CDS check failed — proceed with order anyway
      }

      await MedicalApiService.createEmrOrder(data);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context).ordersPlacedSuccess),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _loadOrders();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              AppStrings.of(context).ordersPlaceFailed(e.toString()),
            ),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  Future<bool?> _showCdsAlerts(List<dynamic> alerts) {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Row(
          children: [
            const Icon(Icons.warning_amber, color: AppTheme.warningAmber),
            const SizedBox(width: 8),
            Text(AppStrings.of(ctx).ordersClinicalAlerts),
          ],
        ),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final alert in alerts)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        Icons.info_outline,
                        size: 18,
                        color: (alert is Map && alert['severity'] == 'high')
                            ? AppTheme.errorRed
                            : AppTheme.warningAmber,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          alert is Map
                              ? (alert['message'] as String? ?? '$alert')
                              : '$alert',
                          style: const TextStyle(fontSize: 14),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(AppStrings.of(ctx).actionCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(AppStrings.of(ctx).ordersProceedAnyway),
          ),
        ],
      ),
    );
  }

  // ── Filter Chips ──

  Widget _buildStatusFilters() {
    const statuses = [null, 'ordered', 'verified', 'completed', 'cancelled'];
    final s = AppStrings.of(context);
    final labels = [
      s.ordersFilterAll,
      s.ordersFilterOrdered,
      s.ordersFilterVerified,
      s.ordersFilterCompleted,
      s.ordersFilterCancelled,
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
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _showCreateOrderSheet,
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
                SizedBox(height: 4),
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
                              SizedBox(height: 12),
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
                            itemBuilder: (ctx, i) {
                              final order = filtered[i];
                              final type = order['order_type'] as String?;
                              final status = order['status'] as String?;
                              final orderId = order['id'];
                              final color = _orderTypeColor(type);

                              return Card(
                                margin: const EdgeInsets.only(bottom: 10),
                                child: Padding(
                                  padding: const EdgeInsets.all(14),
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Row(
                                        children: [
                                          CircleAvatar(
                                            radius: 18,
                                            backgroundColor: color.withValues(
                                              alpha: 0.15,
                                            ),
                                            child: Icon(
                                              _orderTypeIcon(type),
                                              color: color,
                                              size: 18,
                                            ),
                                          ),
                                          const SizedBox(width: 10),
                                          Expanded(
                                            child: Column(
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.start,
                                              children: [
                                                Text(
                                                  order['title'] as String? ??
                                                      order['medication']
                                                          as String? ??
                                                      order['investigation']
                                                          as String? ??
                                                      order['description']
                                                          as String? ??
                                                      s.ordersFallback,
                                                  style: const TextStyle(
                                                    fontWeight: FontWeight.w600,
                                                    fontSize: 14,
                                                  ),
                                                ),
                                                Text(
                                                  '${(type ?? 'order').toUpperCase()} - ${_formatTimestamp(order['created_at'] as String?)}',
                                                  style: TextStyle(
                                                    fontSize: 12,
                                                    color:
                                                        AppTheme.textSecondary,
                                                  ),
                                                ),
                                              ],
                                            ),
                                          ),
                                          _statusBadge(status),
                                        ],
                                      ),
                                      if (order['dosage'] != null ||
                                          order['frequency'] != null) ...[
                                        const SizedBox(height: 8),
                                        Text(
                                          [
                                            order['dosage'],
                                            order['route'],
                                            order['frequency'],
                                          ].where((e) => e != null).join(' | '),
                                          style: TextStyle(
                                            fontSize: 13,
                                            color: AppTheme.textSecondary,
                                          ),
                                        ),
                                      ],
                                      if (order['ordered_by'] != null) ...[
                                        SizedBox(height: 4),
                                        Row(
                                          children: [
                                            Icon(
                                              Icons.person_outline,
                                              size: 13,
                                              color: AppTheme.textSecondary,
                                            ),
                                            SizedBox(width: 4),
                                            Text(
                                              order['ordered_by'] as String,
                                              style: TextStyle(
                                                fontSize: 12,
                                                color: AppTheme.textSecondary,
                                              ),
                                            ),
                                          ],
                                        ),
                                      ],
                                      // Action buttons
                                      if (orderId is int &&
                                          (status?.toLowerCase() == 'ordered' ||
                                              status?.toLowerCase() ==
                                                  'verified')) ...[
                                        const SizedBox(height: 10),
                                        Row(
                                          mainAxisAlignment:
                                              MainAxisAlignment.end,
                                          children: [
                                            if (status?.toLowerCase() ==
                                                'ordered')
                                              TextButton.icon(
                                                onPressed: () =>
                                                    _verifyOrder(orderId),
                                                icon: const Icon(
                                                  Icons.check_circle_outline,
                                                  size: 18,
                                                ),
                                                label: Text(s.ordersVerify),
                                                style: TextButton.styleFrom(
                                                  foregroundColor:
                                                      AppTheme.accentCyan,
                                                ),
                                              ),
                                            if (status?.toLowerCase() ==
                                                'verified')
                                              TextButton.icon(
                                                onPressed: () =>
                                                    _completeOrder(orderId),
                                                icon: const Icon(
                                                  Icons.done_all,
                                                  size: 18,
                                                ),
                                                label: Text(s.ordersComplete),
                                                style: TextButton.styleFrom(
                                                  foregroundColor:
                                                      AppTheme.successGreen,
                                                ),
                                              ),
                                          ],
                                        ),
                                      ],
                                    ],
                                  ),
                                ),
                              );
                            },
                          ),
                        ),
                ),
              ],
            ),
    );
  }
}
