import 'package:flutter/material.dart';

import 'dart:async';

import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth_core/services/realtime_client.dart';

import '../../../core/config/role_config.dart';
import '../../../core/providers/notification_provider.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/resus_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';
import '../widgets/resus_event_panel.dart';
import '../widgets/resus_trigger_button.dart';

typedef SafetyNotificationLoader = Future<List<dynamic>> Function();
typedef SafetyMapLoader = Future<Map<String, dynamic>> Function();
typedef SafetyResusLoader = Future<List<Map<String, dynamic>>> Function();
typedef SafetyRoleLoader = Future<String?> Function();

const _safetyTranslatedNotificationTypes = <String>{
  'MAR_MEDICATION_EXCEPTION',
  'MAR_MEDICATION_EXCEPTION_ESCALATION',
  'MAR_MEDICATION_EXCEPTION_ASSIGNMENT_HANDOFF',
  'COUNTER_SALE_VOID_REFUND_REQUIRED',
  'COUNTER_SALE_VOID_REFUND_PAYOUT_REQUIRED',
  'COUNTER_SALE_VOID_REJECTED_REVIEW_REQUIRED',
  'COUNTER_SALE_VOID_REFUND_REJECTED',
  'COUNTER_SALE_VOID_COMPLETED',
  'WARD_INDENT_CREDIT_NOTE_REVIEW',
  'WARD_INDENT_CREDIT_NOTE_REFUND_APPROVAL',
  'WARD_INDENT_CREDIT_NOTE_REFUND_PAYOUT',
  'WARD_INDENT_MAR_SUPPLY_RECONCILIATION',
  'GATEWAY_REFUND_RECONCILIATION',
  'CLINICAL_ALERT_DELIVERY_RECOVERY_OVERDUE',
};

const _safetyLocalizedActionLabelKeys = <String>{
  'clinical_inbox.open_workflow',
  'mar_supply.notification_action',
  'med03.credit_note.notification_action',
  'med03.notification.gateway_refund_reconciliation.action',
  'orders.mar_recovery.action',
  's4.lib.counter_sale.open_finance_workflow',
  's4.lib.counter_sale.open_reconciliation',
};

@visibleForTesting
String safetyOwnerForAlert(NotificationItem item, AppStrings strings) {
  final type = item.normalizedType;
  if (item.isInvestigationAlert) {
    return strings.lookup('safety_center.alert.owner.lab_treating_doctor');
  }
  if (type.contains('APPOINTMENT') || type.contains('QUEUE')) {
    return strings.lookup('safety_center.alert.owner.reception_doctor');
  }
  if (type.contains('ADMISSION') || type.contains('IPD')) {
    return strings.lookup('safety_center.alert.owner.admission_nursing');
  }
  if (type.contains('HOUSEKEEPING') || type.contains('BED')) {
    return strings.lookup('safety_center.alert.owner.housekeeping');
  }
  if (type.contains('PHARMACY') || type.contains('MEDICATION')) {
    return strings.lookup('safety_center.alert.owner.pharmacy');
  }
  return strings.lookup('safety_center.alert.owner.receiving_team');
}

@visibleForTesting
String safetyEscalationLabel(
  NotificationItem item,
  AppStrings strings, {
  DateTime? now,
}) {
  if (item.isRead) {
    return strings.lookup('safety_center.alert.escalation.acknowledged');
  }
  if (!item.isHighPriority) {
    return strings.lookup('safety_center.alert.escalation.monitor');
  }
  final age = (now ?? DateTime.now()).difference(item.timestamp.toLocal());
  if (age.inMinutes >= 15) {
    return strings.lookup('safety_center.alert.escalation.escalated');
  }
  final remaining = 15 - age.inMinutes;
  return strings.format('safety_center.alert.escalation.in_minutes', {
    'minutes': remaining <= 0 ? 1 : remaining,
  });
}

@visibleForTesting
String safetyAlertTypeLabel(NotificationItem item, AppStrings strings) {
  final type = item.normalizedType;
  if (item.isInvestigationAlert) {
    return strings.lookup('safety_center.alert.type.investigation');
  }
  if (item.isAppointmentAlert) {
    return strings.lookup('safety_center.alert.type.appointment');
  }
  if (item.isAdmissionAlert) {
    return strings.lookup('safety_center.alert.type.admission');
  }
  if (item.isHousekeepingAlert) {
    return strings.lookup('safety_center.alert.type.housekeeping');
  }
  if (item.isBedAlert) {
    return strings.lookup('safety_center.alert.type.bed');
  }
  if (type.contains('PHARMACY') || type.contains('MEDICATION')) {
    return strings.lookup('safety_center.alert.type.pharmacy');
  }
  if (type.contains('SOS') || type.contains('EMERGENCY')) {
    return strings.lookup('safety_center.alert.type.emergency');
  }
  if (type.contains('REFERRAL')) {
    return strings.lookup('safety_center.alert.type.referral');
  }
  return strings.lookup('safety_center.alert.type.workflow');
}

@visibleForTesting
String safetyAlertPriorityLabel(NotificationItem item, AppStrings strings) {
  return switch (item.normalizedPriority) {
    'CRITICAL' => strings.lookup('safety_center.alert.priority.critical'),
    'HIGH' => strings.lookup('safety_center.alert.priority.high'),
    _ => strings.lookup('safety_center.alert.priority.attention'),
  };
}

@visibleForTesting
String safetyAlertTitle(NotificationItem item, AppStrings strings) {
  if (_safetyTranslatedNotificationTypes.contains(item.normalizedType)) {
    return item.titleFor(strings);
  }
  return safetyAlertTypeLabel(item, strings);
}

@visibleForTesting
String safetyAlertBody(NotificationItem item, AppStrings strings) {
  if (_safetyTranslatedNotificationTypes.contains(item.normalizedType)) {
    return item.bodyFor(strings);
  }
  return strings.lookup('safety_center.alert.details_hidden');
}

@visibleForTesting
String safetyAlertActionLabel(NotificationItem item, AppStrings strings) {
  final localizedKey = item.data['action_label_key']?.toString().trim();
  if (localizedKey != null &&
      _safetyLocalizedActionLabelKeys.contains(localizedKey)) {
    return strings.lookup(localizedKey);
  }
  final type = item.normalizedType;
  if (type.contains('SOS') || type.contains('EMERGENCY')) {
    return strings.lookup('safety_center.alert.action.open_emergency');
  }
  if (item.isAppointmentAlert) {
    return strings.lookup('safety_center.alert.action.open_appointment');
  }
  if (item.isAdmissionAlert) {
    return strings.lookup('safety_center.alert.action.open_admission');
  }
  if (item.isHousekeepingAlert) {
    return strings.lookup('safety_center.alert.action.open_housekeeping');
  }
  if (item.isBedAlert) {
    return strings.lookup('safety_center.alert.action.open_bed');
  }
  if (item.isInvestigationAlert) {
    return strings.lookup('safety_center.alert.action.open_investigation');
  }
  if (type.contains('REFERRAL')) {
    return strings.lookup('safety_center.alert.action.open_referral');
  }
  if (type.contains('PHARMACY') || type.contains('MEDICATION')) {
    return strings.lookup('safety_center.alert.action.open_pharmacy');
  }
  return strings.lookup('safety_center.alert.action.open_workflow');
}

@visibleForTesting
String safetyOwnerForDischargeBlocker(Map<String, dynamic> blocker) {
  final text = [
    blocker['owner_role'],
    blocker['role'],
    blocker['department'],
    blocker['type'],
    blocker['code'],
    blocker['message'],
  ].whereType<Object>().join(' ').toLowerCase();
  if (text.contains('pharmacy') || text.contains('drug')) return 'Pharmacy';
  if (text.contains('billing') || text.contains('invoice')) return 'Billing';
  if (text.contains('physio')) return 'Physiotherapy';
  if (text.contains('diet')) return 'Dietary';
  if (text.contains('summary') || text.contains('doctor')) return 'Doctor';
  if (text.contains('follow')) return 'Reception';
  return 'Discharge team';
}

@visibleForTesting
String safetyHousekeepingSlaLabel(Map<String, dynamic> task, {DateTime? now}) {
  final due = DateTime.tryParse('${task['sla_due_at'] ?? ''}');
  if (due == null) return 'SLA not set';
  final localDue = due.toLocal();
  final current = now ?? DateTime.now();
  if (localDue.isBefore(current)) {
    final overdue = current.difference(localDue).inMinutes;
    return overdue >= 60
        ? 'Overdue ${overdue ~/ 60}h ${overdue % 60}m'
        : 'Overdue ${overdue <= 0 ? 1 : overdue}m';
  }
  final remaining = localDue.difference(current).inMinutes;
  return remaining >= 60
      ? 'Due in ${remaining ~/ 60}h ${remaining % 60}m'
      : 'Due in ${remaining <= 0 ? 1 : remaining}m';
}

@visibleForTesting
class SafetyCriticalAlertRow extends StatelessWidget {
  const SafetyCriticalAlertRow({
    super.key,
    required this.item,
    required this.strings,
    required this.meta,
    this.onAcknowledge,
    this.onOpen,
  });

  final NotificationItem item;
  final AppStrings strings;
  final String meta;
  final VoidCallback? onAcknowledge;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    return _SafetyRow(
      icon: item.isInvestigationAlert
          ? Icons.science_outlined
          : Icons.notification_important_outlined,
      color: item.isRead ? AppTheme.textSecondary : AppTheme.errorOnSurface,
      title: safetyAlertTitle(item, strings),
      subtitle: [
        safetyAlertBody(item, strings),
        '${strings.safetyCenterOwnerPrefix}: ${safetyOwnerForAlert(item, strings)}',
        safetyEscalationLabel(item, strings),
        safetyAlertPriorityLabel(item, strings),
        safetyAlertTypeLabel(item, strings),
      ].where((part) => part.isNotEmpty).join(' - '),
      meta: meta,
      actions: [
        if (onAcknowledge != null)
          TextButton.icon(
            onPressed: onAcknowledge,
            icon: const Icon(Icons.done_all, size: 16),
            label: Text(strings.safetyCenterAcknowledge),
          ),
        if (onOpen != null)
          FilledButton.tonalIcon(
            onPressed: onOpen,
            icon: const Icon(Icons.open_in_new, size: 16),
            label: Text(safetyAlertActionLabel(item, strings)),
          ),
      ],
    );
  }
}

class SafetyCenterScreen extends StatefulWidget {
  const SafetyCenterScreen({
    super.key,
    this.notificationLoader,
    this.dischargeLoader,
    this.housekeepingLoader,
    this.resusLoader,
    this.roleLoader,
    this.enableRealtime = true,
  });

  final SafetyNotificationLoader? notificationLoader;
  final SafetyMapLoader? dischargeLoader;
  final SafetyMapLoader? housekeepingLoader;
  final SafetyResusLoader? resusLoader;
  final SafetyRoleLoader? roleLoader;
  final bool enableRealtime;

  @override
  State<SafetyCenterScreen> createState() => _SafetyCenterScreenState();
}

class _SafetyCenterScreenState extends State<SafetyCenterScreen> {
  final _dateFmt = DateFormat('dd-MM-yyyy HH:mm');
  bool _loading = true;
  String? _error;
  bool _canRespondSos = false;
  List<NotificationItem> _criticalAlerts = const [];
  List<Map<String, dynamic>> _dischargeItems = const [];
  List<Map<String, dynamic>> _housekeepingTasks = const [];
  List<Map<String, dynamic>> _resusEvents = const [];

  StreamSubscription<dynamic>? _realtimeSub;
  Timer? _realtimeDebounce;

  Future<void> _attachRealtime() async {
    // Live board updates (once-over train F): the backend already broadcasts
    // on staff:incidents — subscribe like the bed board does.
    final rt = RealtimeClient.instance;
    await rt.connect();
    _realtimeSub = rt.events('staff:incidents').listen((_) {
      _realtimeDebounce?.cancel();
      _realtimeDebounce = Timer(const Duration(milliseconds: 400), () {
        if (!mounted) return;
        _load();
      });
    });
  }

  @override
  void initState() {
    super.initState();
    _loadSosEntitlement();
    _load();
    if (widget.enableRealtime) _attachRealtime();
  }

  @override
  void dispose() {
    _realtimeSub?.cancel();
    _realtimeDebounce?.cancel();
    super.dispose();
  }

  /// SOS response is role-gated (generated sos_response contract group —
  /// backend emergencyResponderRoutes RBAC), unlike the all-staff Safety
  /// Center itself, so the entry point only renders for authorized roles.
  Future<void> _loadSosEntitlement() async {
    final role = await (widget.roleLoader ?? AuthService.getRole)();
    final allowed = RoleFeatures.getFeaturesForRawRole(role ?? '')
        .any((feature) => feature.id == 'sos_response');
    if (mounted) setState(() => _canRespondSos = allowed);
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait<Object?>([
        (widget.notificationLoader ?? () => HrApiService.getNotifications())(),
        (widget.dischargeLoader ?? MedicalApiService.listDischargeHubs)()
            .catchError((_) => <String, dynamic>{}),
        (widget.housekeepingLoader ?? HrApiService.getMyHousekeepingRequests)()
            .catchError((_) => <String, dynamic>{}),
        // Persisted code-blue/resus history — the durable rows are the source
        // of truth on (re)load; the live WS banner is notification-only.
        (widget.resusLoader ??
                () => ResusApiService.listRecentEvents(hours: 24, limit: 10))()
            .catchError((_) => <Map<String, dynamic>>[]),
      ]);

      final notifications =
          (results[0] as List)
              .map(NotificationItem.fromApi)
              .where((item) => item.isHighPriority || item.isInvestigationAlert)
              .toList()
            ..sort((a, b) => b.timestamp.compareTo(a.timestamp));

      final dischargeRaw = _asMap(results[1])['admissions'];
      final discharges = _asMapList(dischargeRaw).where((hub) {
        final readiness = _asMap(hub['readiness']);
        final blockers = _asMapList(readiness['blockers']);
        return readiness['ready'] != true || blockers.isNotEmpty;
      }).toList();

      final housekeeping = _asMap(results[2]);
      final assigned =
          _asMapList(housekeeping['assigned'])
              .where((task) => !_isFinishedStatus(task['status']))
              .toList()
            ..sort(_sortHousekeepingBySla);

      if (!mounted) return;
      setState(() {
        _criticalAlerts = notifications;
        _dischargeItems = discharges;
        _housekeepingTasks = assigned;
        _resusEvents = _asMapList(results[3]);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Map<String, dynamic> _asMap(Object? value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    return <String, dynamic>{};
  }

  List<Map<String, dynamic>> _asMapList(Object? value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
  }

  bool _isFinishedStatus(Object? value) {
    final status = _text(value).toLowerCase();
    return status == 'completed' || status == 'verified' || status == 'closed';
  }

  int _sortHousekeepingBySla(Map<String, dynamic> a, Map<String, dynamic> b) {
    final left = DateTime.tryParse(_text(a['sla_due_at']));
    final right = DateTime.tryParse(_text(b['sla_due_at']));
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    return left.compareTo(right);
  }

  String _text(Object? value, [String fallback = '']) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty ? fallback : text;
  }

  String _time(Object? value) {
    final parsed = DateTime.tryParse(_text(value));
    if (parsed == null) return '';
    return _dateFmt.format(parsed.toLocal());
  }

  bool _isOverdue(Object? value) {
    final parsed = DateTime.tryParse(_text(value));
    return parsed != null && parsed.toLocal().isBefore(DateTime.now());
  }

  Future<void> _acknowledge(NotificationItem item) async {
    final id = item.id;
    if (id == null || id.isEmpty) return;
    await HrApiService.acknowledgeNotification(id);
    await _load();
  }

  void _openAlert(NotificationItem item) {
    final route = item.actionRoute;
    if (route == null || route.isEmpty) return;
    context.push(route);
  }

  void _openDischarge(Map<String, dynamic> hub) {
    final admission = _asMap(hub['admission']);
    final id = int.tryParse(_text(admission['id']));
    if (id == null) return;
    final name = Uri.encodeQueryComponent(
      _text(admission['patient_name'], 'Patient'),
    );
    context.push('/emr/discharge-hub/$id?name=$name').then((_) => _load());
  }

  void _openHousekeeping() {
    context.push('/housekeeping-tasks').then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.safetyCenterTitle),
        actions: [
          if (_canRespondSos)
            IconButton(
              tooltip: s.lookup('sos.title'),
              onPressed: () =>
                  context.push('/sos-response').then((_) => _load()),
              icon: const Icon(Icons.sos),
            ),
          IconButton(
            tooltip: s.safetyCenterRefreshTooltip,
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? _ErrorState(
              message: _error!,
              onRetry: _load,
              retryLabel: s.safetyCenterRetry,
            )
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                children: [
                  _buildSummary(s),
                  const SizedBox(height: 14),
                  _buildResusHistory(theme, s),
                  const SizedBox(height: 14),
                  _buildCriticalAlerts(theme, s),
                  const SizedBox(height: 14),
                  _buildDischargeReadiness(theme, s),
                  const SizedBox(height: 14),
                  _buildHousekeepingSla(theme, s),
                ],
              ),
            ),
      // Deliberately-guarded Code Blue / rapid-response trigger: the button
      // opens a details dialog plus a separate confirmation step before the
      // durable event is created (backend emits the realtime alert).
      floatingActionButton: ResusTriggerButton(
        onCreated: (eventId) =>
            context.push('/safety/resus/$eventId').then((_) => _load()),
      ),
    );
  }

  Widget _buildSummary(AppStrings s) {
    final overdueHousekeeping = _housekeepingTasks
        .where((task) => _isOverdue(task['sla_due_at']))
        .length;
    return Row(
      children: [
        Expanded(
          child: _MetricCard(
            label: s.safetyCenterMetricCriticalAlerts,
            value: _criticalAlerts.where((item) => !item.isRead).length,
            icon: Icons.priority_high,
            color: AppTheme.errorOnSurface,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _MetricCard(
            label: s.safetyCenterMetricDischargeBlockers,
            value: _dischargeItems.length,
            icon: Icons.rule_folder,
            color: AppTheme.warningOnSurface,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _MetricCard(
            label: s.safetyCenterMetricCleaningOverdue,
            value: overdueHousekeeping,
            icon: Icons.cleaning_services,
            color: overdueHousekeeping > 0
                ? AppTheme.errorOnSurface
                : AppTheme.successOnSurface,
          ),
        ),
      ],
    );
  }

  Widget _buildResusHistory(ThemeData theme, AppStrings s) {
    final items = _resusEvents.take(8).toList(growable: false);
    return _SafetySection(
      title: s.lookup('resus.history_title'),
      subtitle: s.lookup('resus.history_subtitle'),
      icon: Icons.emergency_outlined,
      empty: s.lookup('resus.history_empty'),
      actionLabel: s.actionRefresh,
      onAction: _load,
      children: items.map((event) {
        final status = _text(event['status']);
        final id = int.tryParse(_text(event['id']));
        return _SafetyRow(
          icon: Icons.monitor_heart_outlined,
          color: status == 'active'
              ? AppTheme.errorOnSurface
              : AppTheme.textSecondary,
          title: [
            resusEnumLabel(s, 'event_kind', _text(event['event_kind'])),
            if (_text(event['ward_snapshot']).isNotEmpty)
              '${s.lookup('resus.ward')} ${_text(event['ward_snapshot'])}',
            if (_text(event['bed_snapshot']).isNotEmpty)
              '${s.lookup('resus.bed')} ${_text(event['bed_snapshot'])}',
          ].join(' · '),
          subtitle: [
            resusEnumLabel(s, 'status', status),
            if (_text(event['outcome']).isNotEmpty)
              resusEnumLabel(s, 'outcome', _text(event['outcome'])),
            if (_text(event['reason']).isNotEmpty) _text(event['reason']),
          ].join(' - '),
          meta: _time(event['started_at']),
          actions: [
            if (id != null)
              FilledButton.tonalIcon(
                onPressed: () =>
                    context.push('/safety/resus/$id').then((_) => _load()),
                icon: const Icon(Icons.open_in_new, size: 16),
                label: Text(s.lookup('resus.open_record')),
              ),
          ],
        );
      }).toList(),
    );
  }

  Widget _buildCriticalAlerts(ThemeData theme, AppStrings s) {
    final items = _criticalAlerts.take(8).toList(growable: false);
    return _SafetySection(
      title: s.safetyCenterCriticalAlertsTitle,
      subtitle: s.safetyCenterCriticalAlertsSubtitle,
      icon: Icons.notifications_active_outlined,
      empty: s.safetyCenterCriticalAlertsEmpty,
      actionLabel: s.safetyCenterCriticalAlertsAction,
      onAction: () => context.push('/notifications'),
      children: items.map((item) {
        final route = item.actionRoute;
        return SafetyCriticalAlertRow(
          item: item,
          strings: s,
          meta: _dateFmt.format(item.timestamp.toLocal()),
          onAcknowledge: !item.isRead && item.id != null
              ? () => _acknowledge(item)
              : null,
          onOpen: route != null ? () => _openAlert(item) : null,
        );
      }).toList(),
    );
  }

  Widget _buildDischargeReadiness(ThemeData theme, AppStrings s) {
    final items = _dischargeItems.take(8).toList(growable: false);
    return _SafetySection(
      title: s.safetyCenterDischargeTile,
      subtitle: s.safetyCenterDischargeSubtitle,
      icon: Icons.rule_folder_outlined,
      empty: s.safetyCenterDischargeEmpty,
      actionLabel: s.safetyCenterDischargeAction,
      onAction: () => context.push('/emr/discharge-hub'),
      children: items.map((hub) {
        final admission = _asMap(hub['admission']);
        final readiness = _asMap(hub['readiness']);
        final blockers = _asMapList(readiness['blockers']);
        final counts = _asMap(hub['work_item_counts']);
        final owners = blockers
            .map(safetyOwnerForDischargeBlocker)
            .toSet()
            .take(2)
            .join(', ');
        final blockerText = blockers
            .take(2)
            .map((item) => _text(item['message'] ?? item['type']))
            .where((item) => item.isNotEmpty)
            .join(' | ');
        return _SafetyRow(
          icon: Icons.pending_actions_outlined,
          color: AppTheme.warningOnSurface,
          title: _text(admission['patient_name'], 'Patient'),
          subtitle: blockerText.isEmpty
              ? '${s.safetyCenterOwnerPrefix}: ${owners.isEmpty ? 'Discharge team' : owners} - Pending work items: ${_text(counts['pending'], '0')}'
              : '${s.safetyCenterOwnerPrefix}: ${owners.isEmpty ? 'Discharge team' : owners} - $blockerText',
          meta: [
            _text(admission['ward']),
            if (_text(admission['bed_number']).isNotEmpty)
              'Bed ${_text(admission['bed_number'])}',
          ].where((part) => part.isNotEmpty).join(' - '),
          actions: [
            FilledButton.tonalIcon(
              onPressed: () => _openDischarge(hub),
              icon: const Icon(Icons.open_in_new, size: 16),
              label: Text(s.safetyCenterDischargeOpenHub),
            ),
          ],
        );
      }).toList(),
    );
  }

  Widget _buildHousekeepingSla(ThemeData theme, AppStrings s) {
    final items = _housekeepingTasks.take(8).toList(growable: false);
    return _SafetySection(
      title: s.safetyCenterHousekeepingTitle,
      subtitle: s.safetyCenterHousekeepingSubtitle,
      icon: Icons.cleaning_services_outlined,
      empty: s.safetyCenterHousekeepingEmpty,
      actionLabel: s.safetyCenterHousekeepingAction,
      onAction: _openHousekeeping,
      children: items.map((task) {
        final overdue = _isOverdue(task['sla_due_at']);
        final location = [
          _text(task['zone_name']),
          _text(task['location_text']),
          _text(task['request_number']),
        ].where((part) => part.isNotEmpty).join(' - ');
        return _SafetyRow(
          icon: overdue ? Icons.timer_off_outlined : Icons.timer_outlined,
          color: overdue ? AppTheme.errorOnSurface : AppTheme.primaryTeal,
          title: location.isEmpty ? 'Cleaning request' : location,
          subtitle: [
            '${s.safetyCenterOwnerPrefix}: Housekeeping',
            safetyHousekeepingSlaLabel(task),
            _text(task['request_type'], 'cleaning').replaceAll('_', ' '),
            _text(task['status'], 'assigned').replaceAll('_', ' '),
            if (_text(task['description']).isNotEmpty)
              _text(task['description']),
          ].join(' - '),
          meta: overdue
              ? 'Overdue since ${_time(task['sla_due_at'])}'
              : 'SLA ${_time(task['sla_due_at'])}',
          actions: [
            FilledButton.tonalIcon(
              onPressed: _openHousekeeping,
              icon: const Icon(Icons.open_in_new, size: 16),
              label: Text(s.safetyCenterHousekeepingOpenTask),
            ),
          ],
        );
      }).toList(),
    );
  }
}

class _MetricCard extends StatelessWidget {
  final String label;
  final int value;
  final IconData icon;
  final Color color;

  const _MetricCard({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      constraints: const BoxConstraints(minHeight: 92),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color),
          const SizedBox(height: 8),
          Text(
            '$value',
            style: theme.textTheme.headlineSmall?.copyWith(
              color: color,
              fontWeight: FontWeight.w800,
            ),
          ),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

class _SafetySection extends StatelessWidget {
  final String title;
  final String subtitle;
  final IconData icon;
  final String empty;
  final String actionLabel;
  final VoidCallback onAction;
  final List<Widget> children;

  const _SafetySection({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.empty,
    required this.actionLabel,
    required this.onAction,
    required this.children,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, color: AppTheme.primaryBlue),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    Text(
                      subtitle,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              TextButton.icon(
                onPressed: onAction,
                icon: const Icon(Icons.open_in_new, size: 16),
                label: Text(actionLabel),
              ),
            ],
          ),
          const SizedBox(height: 10),
          if (children.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 16),
              child: Text(
                empty,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            )
          else
            ...children,
        ],
      ),
    );
  }
}

class _SafetyRow extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;
  final String meta;
  final List<Widget> actions;

  const _SafetyRow({
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
    required this.meta,
    required this.actions,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withValues(
          alpha: 0.30,
        ),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Icon(icon, color: color),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(
                        title,
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    if (meta.isNotEmpty)
                      Text(
                        meta,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                  ],
                ),
                if (subtitle.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    subtitle,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
                if (actions.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Wrap(spacing: 8, runSpacing: 8, children: actions),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  final String? retryLabel;

  const _ErrorState({
    required this.message,
    required this.onRetry,
    this.retryLabel,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final label = retryLabel ?? AppStrings.of(context).safetyCenterRetry;
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
              label: Text(label),
            ),
          ],
        ),
      ),
    );
  }
}
