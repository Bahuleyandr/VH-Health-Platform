import 'package:flutter/material.dart';

import 'dart:async';

import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:intl/intl.dart';

import '../../../core/services/auth_service.dart';
import '../../../core/services/location_service.dart';
import '../../../core/services/pharmacy_api_service.dart';
import '../../../core/services/transport_api_service.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';
import '../widgets/transport_request_sheet.dart';

/// Porter / patient-transport worklist. Two tabs: "My tasks" (the
/// authenticated porter's fan-out from `/patient-flow/transport/tasks/my`)
/// and "All open" (tenant board filtered to in-flight + completed-unverified
/// tasks). Actions follow the backend transition table exactly; see
/// [TransportApiService] for the lifecycle contract.

/// Mirror of backend `PATIENT_TRANSPORT_VERIFY_ROUTE_ROLES`
/// (apps/backend/src/config/routeRolePolicy.js): capability groups
/// `ip_flow` + `diagnostics` + `emergency` (rolePolicyGraph.js) plus the
/// explicit RECEPTION_INCHARGE / ADMISSION_OFFICER / MEDICAL_SUPERINTENDENT
/// additions. The verify route is the one transport endpoint with a narrower
/// role list than the mount, so the button is hidden for everyone else.
const Set<String> transportVerifyRoleCodes = {
  // ip_flow capability group
  'SUPER_ADMIN',
  'ADMIN',
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'SENIOR_DOCTOR',
  'JUNIOR_DOCTOR',
  'RESIDENT',
  'NURSING_STAFF',
  'NURSING_INCHARGE',
  'IP_STAFF_NURSE',
  'IP_INCHARGE',
  'ICU_NURSE',
  'ICU_INCHARGE',
  'ICU_STAFF',
  'ADMISSION_OFFICER',
  'IPD_COUNSELLOR',
  // diagnostics capability group
  'LAB_STAFF',
  'RADIOLOGIST',
  'RADIOLOGY_STAFF',
  'PATHOLOGIST',
  'LAB_INCHARGE',
  'BLOOD_BANK_STAFF',
  'BLOOD_BANK_TECHNICIAN',
  // emergency capability group (ICU roles already listed above)
  'ER_STAFF',
  // explicit additions in PATIENT_TRANSPORT_VERIFY_ROUTE_ROLES
  'RECEPTION_INCHARGE',
  'MEDICAL_SUPERINTENDENT',
};

@visibleForTesting
bool canVerifyTransportHandoff(String role) =>
    transportVerifyRoleCodes.contains(role.trim().toUpperCase());

@visibleForTesting
String transportZoneLine(Map<String, dynamic> task) {
  String text(Object? value) => value?.toString().trim() ?? '';
  String side(String labelKey, String locationKey, String zoneKey) {
    final label = text(task[labelKey]);
    if (label.isNotEmpty) return label;
    final location = text(task[locationKey]);
    if (location.isNotEmpty) return location;
    final zoneId = text(task[zoneKey]);
    return zoneId.isEmpty ? '?' : 'Zone #$zoneId';
  }

  final from = side('pickup_label', 'pickup_location_text', 'pickup_zone_id');
  final to = side(
    'destination_label',
    'destination_location_text',
    'destination_zone_id',
  );
  return '$from → $to';
}

class TransportTasksScreen extends StatefulWidget {
  /// Coordinator hook: increment from a realtime transport event
  /// (`transport-task-*` websocket topics) to make any mounted screen
  /// re-fetch both tabs without owning a websocket subscription itself.
  static final ValueNotifier<int> refreshTick = ValueNotifier<int>(0);

  const TransportTasksScreen({super.key});

  @override
  State<TransportTasksScreen> createState() => _TransportTasksScreenState();
}

class _TransportTasksScreenState extends State<TransportTasksScreen>
    with SingleTickerProviderStateMixin {
  final _dateFmt = DateFormat('dd MMM, HH:mm');
  late final TabController _tabController = TabController(
    length: 2,
    vsync: this,
  );

  bool _loading = true;
  String? _error;
  String _role = '';
  List<Map<String, dynamic>> _myTasks = const [];
  List<Map<String, dynamic>> _openTasks = const [];
  List<Map<String, dynamic>> _pharmacyDeliveries = const [];

  StreamSubscription<dynamic>? _transportEventSub;

  Future<void> _attachRealtime() async {
    // The backend broadcasts every task transition on staff:transport
    // (porterTransportService) — live board updates for free.
    final rt = RealtimeClient.instance;
    await rt.connect();
    _transportEventSub = rt
        .events('staff:transport')
        .listen((_) => TransportTasksScreen.refreshTick.value++);
  }

  @override
  void initState() {
    super.initState();
    TransportTasksScreen.refreshTick.addListener(_onRefreshTick);
    _attachRealtime();
    _init();
  }

  @override
  void dispose() {
    _transportEventSub?.cancel();
    TransportTasksScreen.refreshTick.removeListener(_onRefreshTick);
    _tabController.dispose();
    super.dispose();
  }

  void _onRefreshTick() {
    if (mounted && !_loading) _load();
  }

  Future<void> _init() async {
    final role = await AuthService.getRole();
    if (!mounted) return;
    setState(() => _role = role);
    await _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait([
        TransportApiService.listMyTasks(),
        TransportApiService.listOpenBoardTasks(),
        if (_role.trim().toUpperCase() == 'DELIVERY_STAFF')
          PharmacyApiService.getAssignedPharmacyDeliveries()
        else
          Future.value(const <Map<String, dynamic>>[]),
      ]);
      if (!mounted) return;
      setState(() {
        _myTasks = results[0];
        _openTasks = results[1];
        _pharmacyDeliveries = results[2];
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _taskNumber(Map<String, dynamic> task) {
    final number = task['task_number']?.toString().trim() ?? '';
    return number.isNotEmpty ? number : '#${task['id']}';
  }

  int? _taskId(Map<String, dynamic> task) =>
      int.tryParse(task['id']?.toString() ?? '');

  Future<void> _perform(
    Future<Map<String, dynamic>> Function() action,
    String successMessage,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    try {
      await action();
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(successMessage)));
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: theme.colorScheme.error,
        ),
      );
    }
    await _load();
  }

  Future<void> _accept(Map<String, dynamic> task) async {
    final id = _taskId(task);
    if (id == null) return;
    await _perform(
      () => TransportApiService.acceptTask(id),
      'Transport task ${_taskNumber(task)} accepted',
    );
  }

  Future<void> _pickup(Map<String, dynamic> task) async {
    final id = _taskId(task);
    if (id == null) return;
    await _perform(
      () => TransportApiService.pickupTask(id),
      'Patient picked up for ${_taskNumber(task)}',
    );
  }

  Future<void> _complete(Map<String, dynamic> task) async {
    final id = _taskId(task);
    if (id == null) return;
    await _perform(
      () => TransportApiService.completeTask(id),
      'Transport task ${_taskNumber(task)} completed',
    );
  }

  Future<void> _verify(Map<String, dynamic> task) async {
    final id = _taskId(task);
    if (id == null) return;
    await _perform(
      () => TransportApiService.verifyTask(id),
      'Handoff verified for ${_taskNumber(task)}',
    );
  }

  Future<void> _cancel(Map<String, dynamic> task) async {
    final id = _taskId(task);
    if (id == null) return;
    final reason = await showDialog<String>(
      context: context,
      builder: (ctx) => const _CancelReasonDialog(),
    );
    if (reason == null || reason.isEmpty || !mounted) return;
    await _perform(
      () => TransportApiService.cancelTask(id, reason: reason),
      'Transport task ${_taskNumber(task)} cancelled',
    );
  }

  Future<void> _openRequestSheet() async {
    final created = await showTransportRequestSheet(context);
    if (created == true && mounted) await _load();
  }

  int? _pharmacyDeliveryId(Map<String, dynamic> delivery) =>
      int.tryParse(delivery['id']?.toString() ?? '');

  Future<void> _sharePharmacyDeliveryLocation(
    Map<String, dynamic> delivery,
  ) async {
    final id = _pharmacyDeliveryId(delivery);
    if (id == null) return;
    final location = await LocationService.getLocationData();
    final latitude = location['latitude'];
    final longitude = location['longitude'];
    if (latitude is! num || longitude is! num) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(LocationService.getLocationStatusMessage(location))),
      );
      return;
    }
    await _perform(
      () => PharmacyApiService.updatePharmacyDeliveryLocation(
        id,
        latitude: latitude.toDouble(),
        longitude: longitude.toDouble(),
        accuracy: (location['accuracy'] as num?)?.toDouble(),
      ),
      AppStrings.of(context).labBookingsSharingLocation,
    );
  }

  Future<void> _stopPharmacyDeliveryTracking(
    Map<String, dynamic> delivery,
  ) async {
    final id = _pharmacyDeliveryId(delivery);
    if (id == null) return;
    await _perform(
      () => PharmacyApiService.stopPharmacyDeliveryTracking(id),
      AppStrings.of(context).actionClose,
    );
  }

  Future<void> _completePharmacyDelivery(
    Map<String, dynamic> delivery,
  ) async {
    final id = _pharmacyDeliveryId(delivery);
    if (id == null) return;
    final token = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (context) => const _PharmacyHandoffTokenDialog(),
    );
    if (token == null || !mounted) return;
    await _perform(
      () => PharmacyApiService.completePharmacyDelivery(
        id,
        handoffToken: token,
      ),
      AppStrings.of(context).pharmacyOrderDeliveredToast,
    );
  }

  Future<void> _requestPharmacyDeliveryReturn(
    Map<String, dynamic> delivery,
  ) async {
    final id = _pharmacyDeliveryId(delivery);
    if (id == null) return;
    final reason = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (context) => const _PharmacyDeliveryReturnDialog(),
    );
    if (reason == null || !mounted) return;
    await _perform(
      () => PharmacyApiService.requestPharmacyDeliveryReturn(
        id,
        reason: reason,
      ),
      AppStrings.of(context).pharmacyCancellationReason,
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);

    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(AppStrings.of(context).transportTitle),
        actions: [
          IconButton(
            tooltip: s.actionRefresh,
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
        bottom: TabBar(
          controller: _tabController,
          tabs: [
            Tab(text: AppStrings.of(context).transportMyTasks),
            Tab(text: AppStrings.of(context).transportAllOpen),
          ],
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _openRequestSheet,
        icon: const Icon(Icons.add),
        label: Text(AppStrings.of(context).transportNewRequest),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? _ErrorState(message: _error!, onRetry: _load)
          : TabBarView(
              controller: _tabController,
              children: [
                _buildTaskList(
                  _myTasks,
                  'No transport tasks assigned to you.',
                  includePharmacyDeliveries: true,
                ),
                _buildTaskList(_openTasks, 'No open transport tasks.'),
              ],
            ),
    );
  }

  Widget _buildTaskList(
    List<Map<String, dynamic>> tasks,
    String emptyMessage, {
    bool includePharmacyDeliveries = false,
  }) {
    final theme = Theme.of(context);
    final deliveries = includePharmacyDeliveries
        ? _pharmacyDeliveries
        : const <Map<String, dynamic>>[];
    return ConstrainedContent(
      child: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 88),
          children: [
            if (deliveries.isEmpty && tasks.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 48),
                child: Center(
                  child: Text(
                    emptyMessage,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
              )
            else ...[
              ...deliveries.map(
                (delivery) => _PharmacyDeliveryCard(
                  delivery: delivery,
                  onShareLocation: () =>
                      _sharePharmacyDeliveryLocation(delivery),
                  onStopTracking: () =>
                      _stopPharmacyDeliveryTracking(delivery),
                  onComplete: () => _completePharmacyDelivery(delivery),
                  onRequestReturn: () =>
                      _requestPharmacyDeliveryReturn(delivery),
                ),
              ),
              ...tasks.map(
                (task) => _TransportTaskCard(
                  task: task,
                  dateFmt: _dateFmt,
                  canVerify: canVerifyTransportHandoff(_role),
                  onAccept: () => _accept(task),
                  onPickup: () => _pickup(task),
                  onComplete: () => _complete(task),
                  onVerify: () => _verify(task),
                  onCancel: () => _cancel(task),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _PharmacyHandoffTokenDialog extends StatefulWidget {
  const _PharmacyHandoffTokenDialog();

  @override
  State<_PharmacyHandoffTokenDialog> createState() =>
      _PharmacyHandoffTokenDialogState();
}

class _PharmacyHandoffTokenDialogState
    extends State<_PharmacyHandoffTokenDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final token = _controller.text.trim();
    return AlertDialog(
      title: Text(s.transportVerifyHandoff),
      content: TextField(
        key: const ValueKey('courier-pharmacy-handoff-token'),
        controller: _controller,
        autofocus: true,
        obscureText: true,
        enableSuggestions: false,
        autocorrect: false,
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(labelText: s.transportVerifyHandoff),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(s.actionCancel),
        ),
        FilledButton(
          onPressed: token.length >= 20 && token.length <= 200
              ? () => Navigator.pop(context, token)
              : null,
          child: Text(s.pharmacyMarkDeliveredYes),
        ),
      ],
    );
  }
}

class _PharmacyDeliveryReturnDialog extends StatefulWidget {
  const _PharmacyDeliveryReturnDialog();

  @override
  State<_PharmacyDeliveryReturnDialog> createState() =>
      _PharmacyDeliveryReturnDialogState();
}

class _PharmacyDeliveryReturnDialogState
    extends State<_PharmacyDeliveryReturnDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final reason = _controller.text.trim();
    return AlertDialog(
      title: Text(s.pharmacyCancellationReason),
      content: TextField(
        key: const ValueKey('courier-pharmacy-return-reason'),
        controller: _controller,
        autofocus: true,
        minLines: 2,
        maxLines: 4,
        maxLength: 500,
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(
          labelText: s.lookup('med03.pharmacy.verification_override_reason'),
          helperText: s.lookup(
            'med03.pharmacy.verification_override_reason_help',
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(s.actionCancel),
        ),
        FilledButton(
          onPressed: reason.length >= 10 && reason.length <= 500
              ? () => Navigator.pop(context, reason)
              : null,
          child: Text(s.pharmacyCancellationReason),
        ),
      ],
    );
  }
}

class _PharmacyDeliveryCard extends StatelessWidget {
  const _PharmacyDeliveryCard({
    required this.delivery,
    required this.onShareLocation,
    required this.onStopTracking,
    required this.onComplete,
    required this.onRequestReturn,
  });

  final Map<String, dynamic> delivery;
  final VoidCallback onShareLocation;
  final VoidCallback onStopTracking;
  final VoidCallback onComplete;
  final VoidCallback onRequestReturn;

  String _text(Object? value, [String fallback = '']) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty ? fallback : text;
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final custody = _text(
      delivery['delivery_custody_status'],
      'in_transit',
    ).toLowerCase();
    final tracking = delivery['delivery_tracking_active'] == true;
    final orderNumber = _text(
      delivery['order_number'],
      '#${_text(delivery['id'])}',
    );
    final patientName = _text(delivery['patient_name']);
    final destination = _text(delivery['delivery_address']);

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.tertiaryContainer.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  orderNumber,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              _Chip(
                label: custody.replaceAll('_', ' ').toUpperCase(),
                color: custody == 'return_pending'
                    ? scheme.error
                    : scheme.tertiary,
              ),
            ],
          ),
          if (patientName.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(patientName, style: theme.textTheme.bodyMedium),
          ],
          if (destination.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(destination, style: theme.textTheme.bodySmall),
          ],
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (custody == 'in_transit')
                FilledButton.tonalIcon(
                  onPressed: onShareLocation,
                  icon: const Icon(Icons.my_location, size: 16),
                  label: Text(s.labBookingsSharingLocation),
                ),
              if (custody == 'in_transit' && tracking)
                TextButton.icon(
                  onPressed: onStopTracking,
                  icon: const Icon(Icons.location_off_outlined, size: 16),
                  label: Text(s.actionClose),
                ),
              if (custody == 'in_transit')
                FilledButton.icon(
                  onPressed: onComplete,
                  icon: const Icon(Icons.verified_outlined, size: 16),
                  label: Text(s.pharmacyMarkDelivered),
                ),
              if (custody == 'in_transit')
                TextButton.icon(
                  onPressed: onRequestReturn,
                  icon: const Icon(Icons.assignment_return_outlined, size: 16),
                  label: Text(s.pharmacyCancellationReason),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Owns its [TextEditingController] so disposal follows the dialog's own
/// widget lifecycle (same pattern as the SOS prompt dialog).
class _CancelReasonDialog extends StatefulWidget {
  const _CancelReasonDialog();

  @override
  State<_CancelReasonDialog> createState() => _CancelReasonDialogState();
}

class _CancelReasonDialogState extends State<_CancelReasonDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return AlertDialog(
      title: Text(AppStrings.of(context).transportCancelTaskTitle),
      content: TextField(
        controller: _controller,
        autofocus: true,
        maxLines: 3,
        maxLength: 500,
        decoration: InputDecoration(
          hintText: AppStrings.of(context).transportCancelReasonHint,
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(null),
          child: Text(s.actionClose),
        ),
        FilledButton(
          onPressed: () {
            final value = _controller.text.trim();
            if (value.isEmpty) return;
            Navigator.of(context).pop(value);
          },
          child: Text(AppStrings.of(context).transportCancelTask),
        ),
      ],
    );
  }
}

class _TransportTaskCard extends StatelessWidget {
  final Map<String, dynamic> task;
  final DateFormat dateFmt;
  final bool canVerify;
  final VoidCallback onAccept;
  final VoidCallback onPickup;
  final VoidCallback onComplete;
  final VoidCallback onVerify;
  final VoidCallback onCancel;

  const _TransportTaskCard({
    required this.task,
    required this.dateFmt,
    required this.canVerify,
    required this.onAccept,
    required this.onPickup,
    required this.onComplete,
    required this.onVerify,
    required this.onCancel,
  });

  String _text(Object? value, [String fallback = '']) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty ? fallback : text;
  }

  Color _priorityColor(ColorScheme scheme, String priority) =>
      switch (priority) {
        'urgent' || 'high' => scheme.error,
        'low' => scheme.onSurfaceVariant,
        _ => scheme.primary,
      };

  Color _statusColor(ColorScheme scheme, String status) => switch (status) {
    'picked_up' => scheme.tertiary,
    'accepted' || 'completed' => scheme.primary,
    'assigned' => scheme.secondary,
    'cancelled' => scheme.error,
    _ => scheme.onSurfaceVariant,
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final status = _text(task['status'], 'open').toLowerCase();
    final priority = _text(task['priority'], 'medium').toLowerCase();
    final verified = _text(task['verified_by']).isNotEmpty;
    final active = TransportApiService.activeTaskStatuses.contains(status);
    final requested = DateTime.tryParse(_text(task['requested_at']));
    final slaDue = DateTime.tryParse(_text(task['sla_due_at']));

    final taskNumber = _text(task['task_number'], '#${_text(task['id'])}');
    final patientUid = _text(task['patient_uid']);
    final sourceType = _text(task['source_type'], 'manual');
    final contextLine = [
      if (patientUid.isNotEmpty)
        'Patient ${patientUid.length > 8 ? patientUid.substring(0, 8) : patientUid}'
      else
        'No patient linked',
      sourceType.replaceAll('_', ' '),
    ].join(' - ');

    // Transition availability mirrors the backend allowedFrom lists; the
    // backend additionally requires the caller to be a task recipient for
    // accept/pickup/complete and the requester or a coordination role for
    // cancel — those checks need the caller's uid, so they stay server-side
    // and surface as descriptive SnackBar errors.
    final canAccept = status == 'open' || status == 'assigned';
    final canPickup = status == 'assigned' || status == 'accepted';
    final canComplete =
        status == 'assigned' || status == 'accepted' || status == 'picked_up';
    final showVerify = status == 'completed' && !verified && canVerify;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  taskNumber,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              _Chip(
                label: priority.toUpperCase(),
                color: _priorityColor(scheme, priority),
              ),
              const SizedBox(width: 6),
              _Chip(
                label: verified && status == 'completed'
                    ? 'VERIFIED'
                    : status.replaceAll('_', ' ').toUpperCase(),
                color: _statusColor(scheme, status),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(contextLine, style: theme.textTheme.bodySmall),
          const SizedBox(height: 4),
          Text(
            transportZoneLine(task),
            style: theme.textTheme.bodyMedium?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            [
              if (requested != null)
                'Requested ${dateFmt.format(requested.toLocal())}',
              if (slaDue != null && active)
                'Due ${dateFmt.format(slaDue.toLocal())}',
            ].join(' - '),
            style: theme.textTheme.bodySmall?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
          ),
          if (active || showVerify) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (canAccept)
                  FilledButton.icon(
                    onPressed: onAccept,
                    icon: const Icon(Icons.thumb_up_alt_outlined, size: 16),
                    label: Text(AppStrings.of(context).transportAccept),
                  ),
                if (canPickup)
                  FilledButton.tonalIcon(
                    onPressed: onPickup,
                    icon: const Icon(Icons.accessible_forward, size: 16),
                    label: Text(AppStrings.of(context).transportPickedUp),
                  ),
                if (canComplete)
                  FilledButton.tonalIcon(
                    onPressed: onComplete,
                    icon: const Icon(Icons.task_alt, size: 16),
                    label: Text(AppStrings.of(context).transportComplete),
                  ),
                if (showVerify)
                  FilledButton.icon(
                    onPressed: onVerify,
                    icon: const Icon(Icons.verified_outlined, size: 16),
                    label: Text(AppStrings.of(context).transportVerifyHandoff),
                  ),
                if (active)
                  TextButton.icon(
                    onPressed: onCancel,
                    icon: const Icon(Icons.cancel_outlined, size: 16),
                    label: Text(AppStrings.of(context).actionCancel),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  final String label;
  final Color color;

  const _Chip({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: theme.textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorState({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off, size: 48, color: theme.colorScheme.error),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: Text(s.actionRetry),
            ),
          ],
        ),
      ),
    );
  }
}
