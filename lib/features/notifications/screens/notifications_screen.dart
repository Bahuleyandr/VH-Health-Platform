import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../../core/providers/notification_provider.dart';
import '../../../core/theme/app_theme.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  bool _loading = true;

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

  IconData _iconForType(String type) {
    return switch (type.toLowerCase()) {
      'appointment' || 'booking' => Icons.calendar_month,
      'handover' || 'handover-note' => Icons.swap_horiz,
      'investigation' || 'lab' => Icons.biotech,
      'pharmacy' || 'medication' => Icons.medication,
      'attendance' => Icons.fingerprint,
      'leave' => Icons.event_available,
      'alert' || 'emergency' || 'sos' => Icons.warning_amber,
      _ => Icons.notifications,
    };
  }

  Color _colorForType(String type) {
    return switch (type.toLowerCase()) {
      'appointment' || 'booking' => const Color(0xFF6A1B9A),
      'handover' || 'handover-note' => const Color(0xFF00695C),
      'investigation' || 'lab' => const Color(0xFF0097A7),
      'pharmacy' || 'medication' => const Color(0xFFE65100),
      'attendance' => const Color(0xFF1565C0),
      'leave' => const Color(0xFF00796B),
      'alert' || 'emergency' || 'sos' => Colors.red,
      _ => AppTheme.primaryBlue,
    };
  }

  String? _routeForType(String type) {
    return switch (type.toLowerCase()) {
      'appointment' || 'booking' => '/appointments',
      'handover' || 'handover-note' => '/handover',
      'investigation' || 'lab' => '/investigations',
      'pharmacy' || 'medication' => '/pharmacy',
      'attendance' => '/attendance',
      'leave' => '/leave',
      _ => null,
    };
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications'),
        actions: [
          Consumer<NotificationProvider>(
            builder: (context, provider, _) {
              if (provider.unreadCount == 0) return const SizedBox.shrink();
              return TextButton(
                onPressed: () => provider.markAllRead(),
                child: const Text('Mark all read'),
              );
            },
          ),
        ],
      ),
      body: Consumer<NotificationProvider>(
        builder: (context, provider, _) {
          if (_loading) {
            return const Center(child: CircularProgressIndicator());
          }

          if (provider.notifications.isEmpty) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.notifications_none,
                    size: 64,
                    color: Theme.of(context).colorScheme.outline,
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'No notifications',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          color: Theme.of(context).colorScheme.outline,
                        ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'You\'re all caught up!',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: Theme.of(context).colorScheme.outline,
                        ),
                  ),
                ],
              ),
            );
          }

          return RefreshIndicator(
            onRefresh: _loadNotifications,
            child: ListView.builder(
              padding: const EdgeInsets.symmetric(vertical: 8),
              itemCount: provider.notifications.length,
              itemBuilder: (context, index) {
                final item = provider.notifications[index];
                final type = item.type ?? '';
                final icon = _iconForType(type);
                final color = _colorForType(type);
                final route = _routeForType(type);

                return Card(
                  margin:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  elevation: item.isRead ? 0 : 1,
                  color: item.isRead ? null : color.withValues(alpha: 0.04),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                    side: item.isRead
                        ? BorderSide.none
                        : BorderSide(color: color.withValues(alpha: 0.2)),
                  ),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: route != null ? () => context.go(route) : null,
                    child: Padding(
                      padding: const EdgeInsets.all(14),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          // Icon
                          CircleAvatar(
                            radius: 20,
                            backgroundColor: color.withValues(alpha: 0.1),
                            child: Icon(icon, color: color, size: 20),
                          ),
                          const SizedBox(width: 12),
                          // Content
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        item.title,
                                        style: TextStyle(
                                          fontWeight: item.isRead
                                              ? FontWeight.normal
                                              : FontWeight.w600,
                                          fontSize: 14,
                                        ),
                                      ),
                                    ),
                                    if (!item.isRead)
                                      Container(
                                        width: 8,
                                        height: 8,
                                        decoration: BoxDecoration(
                                          shape: BoxShape.circle,
                                          color: color,
                                        ),
                                      ),
                                  ],
                                ),
                                if (item.body.isNotEmpty) ...[
                                  const SizedBox(height: 4),
                                  Text(
                                    item.body,
                                    maxLines: 3,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontSize: 13,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurfaceVariant,
                                    ),
                                  ),
                                ],
                                const SizedBox(height: 6),
                                Row(
                                  children: [
                                    Text(
                                      _formatTimestamp(item.timestamp),
                                      style: TextStyle(
                                        fontSize: 11,
                                        color: Theme.of(context)
                                            .colorScheme
                                            .outline,
                                      ),
                                    ),
                                    if (type.isNotEmpty) ...[
                                      const SizedBox(width: 8),
                                      Container(
                                        padding: const EdgeInsets.symmetric(
                                            horizontal: 8, vertical: 2),
                                        decoration: BoxDecoration(
                                          color: color.withValues(alpha: 0.1),
                                          borderRadius:
                                              BorderRadius.circular(10),
                                        ),
                                        child: Text(
                                          type.replaceAll('-', ' '),
                                          style: TextStyle(
                                            fontSize: 10,
                                            color: color,
                                            fontWeight: FontWeight.w500,
                                          ),
                                        ),
                                      ),
                                    ],
                                    const Spacer(),
                                    if (route != null)
                                      Icon(
                                        Icons.chevron_right,
                                        size: 16,
                                        color: Theme.of(context)
                                            .colorScheme
                                            .outline,
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
              },
            ),
          );
        },
      ),
    );
  }

  String _formatTimestamp(DateTime dt) {
    final now = DateTime.now();
    final diff = now.difference(dt);

    if (diff.inMinutes < 1) return 'Just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    if (diff.inDays < 7) return '${diff.inDays}d ago';
    return DateFormat('dd MMM yyyy').format(dt);
  }
}
