import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/providers/notification_provider.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/resus_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';
import '../widgets/resus_event_panel.dart';

@visibleForTesting
String safetyOwnerForAlert(NotificationItem item) {
  final type = item.normalizedType;
  if (item.isInvestigationAlert) return 'Lab / treating doctor';
  if (type.contains('APPOINTMENT') || type.contains('QUEUE')) {
    return 'Reception / doctor';
  }
  if (type.contains('ADMISSION') || type.contains('IPD')) {
    return 'Admission desk / nursing';
  }
  if (type.contains('HOUSEKEEPING') || type.contains('BED')) {
    return 'Housekeeping incharge';
  }
  if (type.contains('PHARMACY') || type.contains('MEDICATION')) {
    return 'Pharmacy';
  }
  return 'Receiving team';
}

@visibleForTesting
String safetyEscalationLabel(NotificationItem item, {DateTime? now}) {
  if (item.isRead) return 'Acknowledged';
  if (!item.isHighPriority) return 'Monitor until acknowledged';
  final age = (now ?? DateTime.now()).difference(item.timestamp.toLocal());
  if (age.inMinutes >= 15) return 'Escalated until acknowledged';
  final remaining = 15 - age.inMinutes;
  return 'Escalates in ${remaining <= 0 ? 1 : remaining} min if unread';
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

class SafetyCenterScreen extends StatefulWidget {
  const SafetyCenterScreen({super.key});

  @override
  State<SafetyCenterScreen> createState() => _SafetyCenterScreenState();
}

class _SafetyCenterScreenState extends State<SafetyCenterScreen> {
  final _dateFmt = DateFormat('dd MMM, HH:mm');
  bool _loading = true;
  String? _error;
  List<NotificationItem> _criticalAlerts = const [];
  List<Map<String, dynamic>> _dischargeItems = const [];
  List<Map<String, dynamic>> _housekeepingTasks = const [];
  List<Map<String, dynamic>> _resusEvents = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait<Object?>([
        HrApiService.getNotifications(),
        MedicalApiService.listDischargeHubs().catchError(
          (_) => <String, dynamic>{},
        ),
        HrApiService.getMyHousekeepingRequests().catchError(
          (_) => <String, dynamic>{},
        ),
        // Persisted code-blue/resus history — the durable rows are the source
        // of truth on (re)load; the live WS banner is notification-only.
        ResusApiService.listRecentEvents(hours: 24, limit: 10).catchError(
          (_) => <Map<String, dynamic>>[],
        ),
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
          _asMapList(
              housekeeping['assigned'],
            ).where((task) => !_isFinishedStatus(task['status'])).toList()
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
        return _SafetyRow(
          icon: item.isInvestigationAlert
              ? Icons.science_outlined
              : Icons.notification_important_outlined,
          color: item.isRead ? AppTheme.textSecondary : AppTheme.errorOnSurface,
          title: item.title,
          subtitle: [
            if (item.body.isNotEmpty) item.body,
            '${s.safetyCenterOwnerPrefix}: ${safetyOwnerForAlert(item)}',
            safetyEscalationLabel(item),
            item.normalizedPriority.isNotEmpty
                ? item.normalizedPriority
                : item.normalizedType,
          ].where((part) => part.isNotEmpty).join(' - '),
          meta: _dateFmt.format(item.timestamp.toLocal()),
          actions: [
            if (!item.isRead && item.id != null)
              TextButton.icon(
                onPressed: () => _acknowledge(item),
                icon: const Icon(Icons.done_all, size: 16),
                label: Text(s.safetyCenterAcknowledge),
              ),
            if (route != null)
              FilledButton.tonalIcon(
                onPressed: () => _openAlert(item),
                icon: const Icon(Icons.open_in_new, size: 16),
                label: Text(item.actionLabel),
              ),
          ],
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
