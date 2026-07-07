import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/config/role_config.dart';
import '../../../core/services/biomed_cmms_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';

class BiomedWorkOrdersScreen extends StatefulWidget {
  const BiomedWorkOrdersScreen({super.key});

  @override
  State<BiomedWorkOrdersScreen> createState() => _BiomedWorkOrdersScreenState();
}

class _BiomedWorkOrdersScreenState extends State<BiomedWorkOrdersScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  List<_BiomedWorkOrder> _active = [];
  List<_BiomedWorkOrder> _completed = [];
  bool _loading = true;
  String? _error;
  String? _busyId;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _loadWorkOrders();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  List<_BiomedWorkOrder> get _all => [..._active, ..._completed];

  List<Map<String, dynamic>> _asMapList(dynamic value) {
    if (value is! List) return [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList(growable: false);
  }

  Future<void> _loadWorkOrders({bool showSpinner = true}) async {
    if (mounted) {
      setState(() {
        if (showSpinner) _loading = true;
        _error = null;
      });
    }
    try {
      final data = await BiomedCmmsApiService.getMyWorkOrders();
      if (!mounted) return;
      setState(() {
        _active = _asMapList(
          data['assigned'],
        ).map(_BiomedWorkOrder.fromJson).toList(growable: false);
        _completed = _asMapList(
          data['completed'],
        ).map(_BiomedWorkOrder.fromJson).toList(growable: false);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _startWorkOrder(_BiomedWorkOrder order) async {
    setState(() => _busyId = order.id);
    try {
      await BiomedCmmsApiService.startWorkOrder(workOrderId: order.id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppStrings.of(context).lookup('biomed.work_orders.started'),
          ),
        ),
      );
      await _loadWorkOrders(showSpinner: false);
    } catch (e) {
      _showError(e);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _completeWorkOrder(_BiomedWorkOrder order) async {
    final notes = await _showCompletionDialog();
    if (notes == null) return;
    setState(() => _busyId = order.id);
    try {
      await BiomedCmmsApiService.completeWorkOrder(
        workOrderId: order.id,
        completionNotes: notes,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppStrings.of(context).lookup('biomed.work_orders.completed'),
          ),
          backgroundColor: AppTheme.successGreen,
        ),
      );
      await _loadWorkOrders(showSpinner: false);
    } catch (e) {
      _showError(e);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<String?> _showCompletionDialog() async {
    final controller = TextEditingController();
    try {
      return await showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(
            AppStrings.of(context).lookup('biomed.work_orders.complete_title'),
          ),
          content: TextField(
            controller: controller,
            maxLines: 3,
            decoration: InputDecoration(
              labelText: AppStrings.of(
                context,
              ).lookup('biomed.work_orders.completion_notes'),
              border: const OutlineInputBorder(),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: Text(AppStrings.of(context).actionCancel),
            ),
            FilledButton.icon(
              onPressed: () => Navigator.pop(context, controller.text),
              icon: const Icon(Icons.check_circle_outline),
              label: Text(
                AppStrings.of(context).lookup('biomed.work_orders.action_done'),
              ),
            ),
          ],
        ),
      );
    } finally {
      controller.dispose();
    }
  }

  void _showError(Object error) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(error.toString().replaceFirst('Exception: ', '')),
        backgroundColor: AppTheme.errorRed,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.lookup('biomed.work_orders.title'),
      role: StaffRole.biomedicalStaff,
      actions: [
        IconButton(
          tooltip: s.lookup('action.refresh'),
          onPressed: _loading ? null : () => _loadWorkOrders(),
          icon: const Icon(Icons.refresh),
        ),
      ],
      body: ConstrainedContent(
        child: Column(
          children: [
            if (_error != null)
              Container(
                width: double.infinity,
                color: AppTheme.errorOnSurface.withValues(alpha: 0.12),
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 10,
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.error_outline,
                      color: AppTheme.errorOnSurface,
                      size: 18,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _error!,
                        style: TextStyle(
                          color: AppTheme.errorOnSurface,
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            Material(
              color: AppTheme.cardSurface,
              child: TabBar(
                controller: _tabController,
                labelColor: AppTheme.primaryBlue,
                unselectedLabelColor: AppTheme.textSecondary,
                indicatorColor: AppTheme.primaryBlue,
                dividerColor: AppTheme.divider,
                tabs: [
                  Tab(
                    text:
                        '${s.lookup('biomed.work_orders.tab_all')} (${_all.length})',
                  ),
                  Tab(
                    text:
                        '${s.lookup('biomed.work_orders.tab_active')} (${_active.length})',
                  ),
                  Tab(
                    text:
                        '${s.lookup('biomed.work_orders.tab_done')} (${_completed.length})',
                  ),
                ],
              ),
            ),
            Expanded(
              child: _loading && _all.isEmpty
                  ? const SkeletonList()
                  : _error != null && _all.isEmpty
                  ? ErrorState(message: _error!, onRetry: _loadWorkOrders)
                  : TabBarView(
                      controller: _tabController,
                      children: [
                        _BiomedWorkOrderList(
                          orders: _all,
                          busyId: _busyId,
                          onRefresh: _loadWorkOrders,
                          onStart: _startWorkOrder,
                          onComplete: _completeWorkOrder,
                        ),
                        _BiomedWorkOrderList(
                          orders: _active,
                          busyId: _busyId,
                          onRefresh: _loadWorkOrders,
                          onStart: _startWorkOrder,
                          onComplete: _completeWorkOrder,
                        ),
                        _BiomedWorkOrderList(
                          orders: _completed,
                          busyId: _busyId,
                          onRefresh: _loadWorkOrders,
                          onStart: _startWorkOrder,
                          onComplete: _completeWorkOrder,
                        ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BiomedWorkOrderList extends StatelessWidget {
  final List<_BiomedWorkOrder> orders;
  final String? busyId;
  final Future<void> Function({bool showSpinner}) onRefresh;
  final ValueChanged<_BiomedWorkOrder> onStart;
  final ValueChanged<_BiomedWorkOrder> onComplete;

  const _BiomedWorkOrderList({
    required this.orders,
    required this.busyId,
    required this.onRefresh,
    required this.onStart,
    required this.onComplete,
  });

  @override
  Widget build(BuildContext context) {
    if (orders.isEmpty) {
      return RefreshIndicator(
        onRefresh: () => onRefresh(showSpinner: false),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            SizedBox(
              height: MediaQuery.sizeOf(context).height * 0.5,
              child: EmptyState(
                icon: Icons.build_circle_outlined,
                title: AppStrings.of(
                  context,
                ).lookup('biomed.work_orders.empty'),
              ),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: () => onRefresh(showSpinner: false),
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: orders.length,
        itemBuilder: (_, index) => _BiomedWorkOrderCard(
          order: orders[index],
          busy: busyId == orders[index].id,
          onStart: () => onStart(orders[index]),
          onComplete: () => onComplete(orders[index]),
        ),
      ),
    );
  }
}

class _BiomedWorkOrderCard extends StatelessWidget {
  final _BiomedWorkOrder order;
  final bool busy;
  final VoidCallback onStart;
  final VoidCallback onComplete;

  const _BiomedWorkOrderCard({
    required this.order,
    required this.busy,
    required this.onStart,
    required this.onComplete,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final priorityColor = switch (order.priority) {
      'urgent' => AppTheme.errorOnSurface,
      'high' => AppTheme.warningOnSurface,
      _ => AppTheme.primaryBlue,
    };
    final statusColor = switch (order.status) {
      'completed' || 'verified' => AppTheme.successOnSurface,
      'in_progress' => AppTheme.accentCyan,
      'assigned' => AppTheme.primaryBlue,
      _ => AppTheme.textSecondary,
    };

    return Card(
      color: AppTheme.cardSurface,
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 4,
                  height: 54,
                  decoration: BoxDecoration(
                    color: priorityColor,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              order.title,
                              style: TextStyle(
                                fontWeight: FontWeight.w700,
                                color: order.isFinished
                                    ? AppTheme.textSecondary
                                    : AppTheme.textPrimary,
                              ),
                            ),
                          ),
                          _Pill(label: order.statusLabel, color: statusColor),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Wrap(
                        spacing: 12,
                        runSpacing: 4,
                        children: [
                          _IconText(
                            icon: Icons.precision_manufacturing_outlined,
                            label: order.deviceLabel,
                          ),
                          if (order.slaLabel(s).isNotEmpty)
                            _IconText(
                              icon: Icons.schedule_outlined,
                              label: order.slaLabel(s),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (order.description.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(
                order.description,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
              ),
            ],
            const SizedBox(height: 10),
            Row(
              children: [
                _Pill(label: order.kindLabel, color: AppTheme.primaryBlue),
                const SizedBox(width: 6),
                _Pill(label: order.priorityLabel, color: priorityColor),
                const Spacer(),
                if (busy)
                  const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                else ...[
                  if (order.status == 'assigned' || order.status == 'open') ...[
                    TextButton.icon(
                      onPressed: onStart,
                      icon: const Icon(Icons.play_arrow, size: 18),
                      label: Text(s.lookup('biomed.work_orders.action_start')),
                      style: TextButton.styleFrom(
                        foregroundColor: AppTheme.accentCyan,
                        visualDensity: VisualDensity.compact,
                      ),
                    ),
                    const SizedBox(width: 4),
                  ],
                  if (!order.isFinished)
                    FilledButton.icon(
                      onPressed: onComplete,
                      icon: const Icon(Icons.check_circle_outline, size: 17),
                      label: Text(s.lookup('biomed.work_orders.action_done')),
                      style: FilledButton.styleFrom(
                        backgroundColor: AppTheme.successGreen,
                        foregroundColor: Colors.white,
                        visualDensity: VisualDensity.compact,
                      ),
                    ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  final String label;
  final Color color;

  const _Pill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withValues(alpha: 0.24)),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          color: color,
        ),
      ),
    );
  }
}

class _IconText extends StatelessWidget {
  final IconData icon;
  final String label;

  const _IconText({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 14, color: AppTheme.textSecondary),
        const SizedBox(width: 4),
        Text(
          label,
          style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
        ),
      ],
    );
  }
}

class _BiomedWorkOrder {
  final String id;
  final String number;
  final String deviceCode;
  final String deviceType;
  final String kind;
  final String priority;
  final String status;
  final String description;
  final DateTime? slaDueAt;
  final bool slaBreached;

  const _BiomedWorkOrder({
    required this.id,
    required this.number,
    required this.deviceCode,
    required this.deviceType,
    required this.kind,
    required this.priority,
    required this.status,
    required this.description,
    required this.slaDueAt,
    required this.slaBreached,
  });

  factory _BiomedWorkOrder.fromJson(Map<String, dynamic> json) {
    DateTime? parseDate(dynamic value) {
      if (value == null) return null;
      return DateTime.tryParse(value.toString());
    }

    return _BiomedWorkOrder(
      id: '${json['id'] ?? ''}',
      number: '${json['work_order_number'] ?? ''}',
      deviceCode: '${json['device_code'] ?? ''}',
      deviceType: '${json['device_type'] ?? ''}',
      kind: '${json['kind'] ?? 'corrective'}',
      priority: '${json['priority'] ?? 'normal'}',
      status: '${json['status'] ?? 'open'}',
      description: '${json['description'] ?? ''}',
      slaDueAt: parseDate(json['sla_due_at']),
      slaBreached: json['sla_breached'] == true,
    );
  }

  bool get isFinished =>
      status == 'completed' || status == 'verified' || status == 'cancelled';

  String get title => number.isNotEmpty ? number : deviceCode;

  String get deviceLabel {
    final type = deviceType.replaceAll('_', ' ');
    if (deviceCode.isEmpty) return type;
    return type.isEmpty ? deviceCode : '$deviceCode / $type';
  }

  String get statusLabel => status.replaceAll('_', ' ').toUpperCase();
  String get kindLabel => kind.replaceAll('_', ' ').toUpperCase();
  String get priorityLabel => priority.replaceAll('_', ' ').toUpperCase();

  String slaLabel(AppStrings s) {
    if (slaBreached) return s.lookup('biomed.work_orders.sla_breached');
    if (slaDueAt == null) return '';
    return DateFormat('dd MMM, HH:mm').format(slaDueAt!.toLocal());
  }
}
