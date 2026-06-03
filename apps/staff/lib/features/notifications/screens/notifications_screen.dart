import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../../core/providers/notification_provider.dart';
import '../../../core/providers/websocket_provider.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';

enum _AlertFilter {
  all,
  unread,
  critical,
  appointments,
  admissions,
  beds,
  housekeeping,
  investigations,
}

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  bool _loading = true;
  String _searchQuery = '';
  _AlertFilter _filter = _AlertFilter.all;
  final Set<String> _locallyReadIds = <String>{};

  @override
  void initState() {
    super.initState();
    _loadNotifications();
  }

  Future<void> _loadNotifications() async {
    setState(() => _loading = true);
    await context.read<NotificationProvider>().fetchNotifications();
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _markAllRead() async {
    final provider = context.read<NotificationProvider>();
    final wsProvider = context.read<WebSocketProvider>();
    final liveIds = wsProvider.notifications
        .map(NotificationItem.fromApi)
        .map((item) => item.id)
        .whereType<String>();
    setState(() {
      _locallyReadIds.addAll(
        provider.notifications.map((n) => n.id).whereType<String>(),
      );
      _locallyReadIds.addAll(liveIds);
    });
    await provider.markAllRead();
  }

  Future<void> _markRead(NotificationItem item) async {
    final id = item.id;
    if (id != null && id.isNotEmpty) {
      setState(() => _locallyReadIds.add(id));
    }
    await context.read<NotificationProvider>().markRead(item);
  }

  Future<void> _acknowledge(NotificationItem item) async {
    final id = item.id;
    if (id != null && id.isNotEmpty) {
      setState(() => _locallyReadIds.add(id));
    }
    await context.read<NotificationProvider>().acknowledge(item);
  }

  Future<void> _openAlert(NotificationItem item) async {
    await _markRead(item);
    if (!mounted) return;
    final route = item.actionRoute;
    if (route != null && route.isNotEmpty) {
      context.push(route);
    }
  }

  bool _isRead(NotificationItem item) {
    final id = item.id;
    return item.isRead || (id != null && _locallyReadIds.contains(id));
  }

  bool _matchesQuery(NotificationItem item) {
    final q = _searchQuery.trim().toLowerCase();
    if (q.isEmpty) return true;
    final haystack = [
      item.title,
      item.body,
      item.type ?? '',
      item.priority ?? '',
      item.relatedId?.toString() ?? '',
      ...item.data.values.map((v) => v?.toString() ?? ''),
    ].join(' ').toLowerCase();
    return haystack.contains(q);
  }

  bool _matchesFilter(NotificationItem item) {
    final read = _isRead(item);
    return switch (_filter) {
      _AlertFilter.all => true,
      _AlertFilter.unread => !read,
      _AlertFilter.critical => item.isHighPriority,
      _AlertFilter.appointments => item.isAppointmentAlert,
      _AlertFilter.admissions => item.isAdmissionAlert,
      _AlertFilter.beds => item.isBedAlert,
      _AlertFilter.housekeeping => item.isHousekeepingAlert,
      _AlertFilter.investigations => item.isInvestigationAlert,
    };
  }

  bool _hasAny(String source, List<String> needles) {
    return needles.any((needle) => source.contains(needle));
  }

  IconData _iconForType(NotificationItem item) {
    final type = item.normalizedType;
    if (_hasAny(type, const ['APPOINTMENT', 'BOOKING', 'QUEUE'])) {
      return Icons.calendar_month;
    }
    if (_hasAny(type, const ['ADMISSION', 'IPD'])) return Icons.local_hospital;
    if (type.contains('HOUSEKEEPING')) return Icons.cleaning_services;
    if (_hasAny(type, const ['BED', 'CLEANING'])) return Icons.bed;
    if (type.contains('HANDOVER')) return Icons.swap_horiz;
    if (_hasAny(type, const ['LAB', 'INVESTIGATION', 'CRITICAL_VALUE'])) {
      return Icons.biotech;
    }
    if (_hasAny(type, const ['PHARMACY', 'MEDICATION'])) {
      return Icons.medication;
    }
    if (type.contains('ATTENDANCE')) return Icons.fingerprint;
    if (type.contains('LEAVE')) return Icons.event_available;
    if (_hasAny(type, const ['ALERT', 'EMERGENCY', 'SOS'])) {
      return Icons.warning_amber;
    }
    return Icons.notifications;
  }

  Color _colorForType(NotificationItem item) {
    final type = item.normalizedType;
    if (item.isHighPriority) return const Color(0xFFC62828);
    if (_hasAny(type, const ['APPOINTMENT', 'BOOKING', 'QUEUE'])) {
      return const Color(0xFF6A1B9A);
    }
    if (_hasAny(type, const ['ADMISSION', 'IPD'])) {
      return const Color(0xFF1565C0);
    }
    if (type.contains('HOUSEKEEPING')) return const Color(0xFF00796B);
    if (_hasAny(type, const ['BED', 'CLEANING'])) return const Color(0xFF00695C);
    if (type.contains('HANDOVER')) return const Color(0xFF00695C);
    if (_hasAny(type, const ['LAB', 'INVESTIGATION', 'CRITICAL_VALUE'])) {
      return const Color(0xFFC62828);
    }
    if (_hasAny(type, const ['PHARMACY', 'MEDICATION'])) {
      return const Color(0xFFE65100);
    }
    if (type.contains('ATTENDANCE')) return const Color(0xFF1565C0);
    if (type.contains('LEAVE')) return const Color(0xFF00796B);
    return AppTheme.primaryBlue;
  }

  String _filterLabel(_AlertFilter filter) {
    return switch (filter) {
      _AlertFilter.all => 'All',
      _AlertFilter.unread => 'Unread',
      _AlertFilter.critical => 'Critical',
      _AlertFilter.appointments => 'Appointments',
      _AlertFilter.admissions => 'Admissions',
      _AlertFilter.beds => 'Beds',
      _AlertFilter.housekeeping => 'Housekeeping',
      _AlertFilter.investigations => 'Investigations',
    };
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final colorScheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.notificationsTitle),
        actions: [
          IconButton(
            tooltip: 'Refresh alerts',
            onPressed: _loadNotifications,
            icon: const Icon(Icons.refresh),
          ),
          Consumer<NotificationProvider>(
            builder: (context, provider, _) {
              if (provider.unreadCount == 0) return const SizedBox.shrink();
              return TextButton(
                onPressed: _markAllRead,
                child: Text(s.notificationsMarkAllRead),
              );
            },
          ),
          const LogoutAction(),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: TextField(
              decoration: InputDecoration(
                hintText: s.notificationsSearchHint,
                prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
                filled: true,
                fillColor: colorScheme.surfaceContainerHighest.withValues(
                  alpha: Theme.of(context).brightness == Brightness.dark
                      ? 0.28
                      : 0.45,
                ),
              ),
              onChanged: (v) => setState(() => _searchQuery = v),
            ),
          ),
          SizedBox(
            height: 44,
            child: ListView.separated(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              scrollDirection: Axis.horizontal,
              itemBuilder: (context, index) {
                final filter = _AlertFilter.values[index];
                return ChoiceChip(
                  label: Text(_filterLabel(filter)),
                  selected: _filter == filter,
                  onSelected: (_) => setState(() => _filter = filter),
                );
              },
              separatorBuilder: (context, index) => const SizedBox(width: 8),
              itemCount: _AlertFilter.values.length,
            ),
          ),
          Expanded(
            child: Consumer2<NotificationProvider, WebSocketProvider>(
              builder: (context, provider, wsProvider, _) {
                if (_loading) return const SkeletonList();

                final persisted = provider.notifications;
                final persistedIds = persisted
                    .map((n) => n.id)
                    .whereType<String>()
                    .toSet();
                final live = wsProvider.notifications
                    .map(NotificationItem.fromApi)
                    .where((n) => n.id == null || !persistedIds.contains(n.id))
                    .toList();

                for (final item in [...persisted, ...live]) {
                  final id = item.id;
                  if (id != null && _locallyReadIds.contains(id)) {
                    item.isRead = true;
                  }
                }

                final rows =
                    <_AlertRow>[
                      ...live.map((item) => _AlertRow(item, isLive: true)),
                      ...persisted.map((item) => _AlertRow(item)),
                    ].where((row) {
                      return _matchesQuery(row.item) &&
                          _matchesFilter(row.item);
                    }).toList();

                if (rows.isEmpty) {
                  if (_searchQuery.trim().isNotEmpty ||
                      _filter != _AlertFilter.all) {
                    return Center(
                      child: Text(
                        s.noMatchesFor(
                          _searchQuery.trim().isEmpty
                              ? _filterLabel(_filter)
                              : _searchQuery,
                        ),
                        style: TextStyle(color: colorScheme.outline),
                      ),
                    );
                  }
                  return EmptyState(
                    icon: Icons.notifications_off_outlined,
                    title: s.notificationsEmpty,
                  );
                }

                return RefreshIndicator(
                  onRefresh: _loadNotifications,
                  child: ListView.builder(
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
                    itemCount: rows.length,
                    itemBuilder: (context, index) =>
                        _buildAlertCard(rows[index]),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildAlertCard(_AlertRow row) {
    final item = row.item;
    final isRead = _isRead(item);
    final color = _colorForType(item);
    final colorScheme = Theme.of(context).colorScheme;
    final route = item.actionRoute;
    final typeLabel = _labelize(item.type ?? item.normalizedType);

    return Card(
      margin: const EdgeInsets.symmetric(vertical: 5),
      elevation: isRead ? 0 : 1,
      color: isRead ? colorScheme.surface : color.withValues(alpha: 0.06),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: BorderSide(
          color: isRead
              ? colorScheme.outlineVariant.withValues(alpha: 0.55)
              : color.withValues(alpha: 0.35),
        ),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: route != null
            ? () => _openAlert(item)
            : isRead
            ? null
            : () => _markRead(item),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              CircleAvatar(
                radius: 22,
                backgroundColor: color.withValues(alpha: 0.14),
                child: Icon(_iconForType(item), color: color, size: 21),
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
                            item.title,
                            style: TextStyle(
                              fontWeight: isRead
                                  ? FontWeight.w500
                                  : FontWeight.w700,
                              fontSize: 15,
                            ),
                          ),
                        ),
                        if (!isRead)
                          Container(
                            width: 9,
                            height: 9,
                            margin: const EdgeInsets.only(top: 4, left: 8),
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: color,
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        if (row.isLive)
                          const _AlertChip(
                            label: 'Live',
                            color: Color(0xFF00796B),
                            icon: Icons.bolt,
                          ),
                        if (item.isHighPriority)
                          const _AlertChip(
                            label: 'High priority',
                            color: Color(0xFFC62828),
                            icon: Icons.priority_high,
                          ),
                        if (typeLabel.isNotEmpty)
                          _AlertChip(label: typeLabel, color: color),
                        if (item.relatedId != null)
                          _AlertChip(
                            label: '#${item.relatedId}',
                            color: colorScheme.outline,
                          ),
                      ],
                    ),
                    if (item.body.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Text(
                        item.body,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 13,
                          height: 1.35,
                          color: colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              Icons.schedule,
                              size: 14,
                              color: colorScheme.outline,
                            ),
                            const SizedBox(width: 4),
                            Text(
                              _formatTimestamp(item.timestamp),
                              style: TextStyle(
                                fontSize: 12,
                                color: colorScheme.outline,
                              ),
                            ),
                          ],
                        ),
                        if (!isRead)
                          TextButton.icon(
                            onPressed: () => _acknowledge(item),
                            icon: const Icon(Icons.done, size: 16),
                            label: const Text('Acknowledge'),
                          ),
                        if (route != null)
                          FilledButton.tonalIcon(
                            onPressed: () => _openAlert(item),
                            icon: const Icon(Icons.open_in_new, size: 16),
                            label: Text(item.actionLabel),
                          ),
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

  String _formatTimestamp(DateTime dt) {
    final s = AppStrings.of(context);
    final now = DateTime.now();
    final diff = now.difference(dt);

    if (diff.inMinutes < 1) return s.timeJustNow;
    if (diff.inMinutes < 60) {
      return '${diff.inMinutes}${s.timeMinutesAgoSuffix}';
    }
    if (diff.inHours < 24) return '${diff.inHours}${s.timeHoursAgoSuffix}';
    if (diff.inDays < 7) return '${diff.inDays}${s.timeDaysAgoSuffix}';
    return DateFormat('dd MMM yyyy').format(dt);
  }

  String _labelize(String raw) {
    final clean = raw
        .replaceAll(RegExp(r'[_-]+'), ' ')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim()
        .toLowerCase();
    if (clean.isEmpty) return '';
    return clean
        .split(' ')
        .map(
          (word) => word.isEmpty
              ? word
              : '${word.substring(0, 1).toUpperCase()}${word.substring(1)}',
        )
        .join(' ');
  }
}

class _AlertRow {
  final NotificationItem item;
  final bool isLive;

  const _AlertRow(this.item, {this.isLive = false});
}

class _AlertChip extends StatelessWidget {
  final String label;
  final Color color;
  final IconData? icon;

  const _AlertChip({required this.label, required this.color, this.icon});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.22)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 12, color: color),
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}
