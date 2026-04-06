import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class NotificationsScreen extends StatefulWidget {
  final String phone;

  const NotificationsScreen({super.key, required this.phone});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  List<dynamic> notifications = [];
  bool loading = true;
  String? _error;
  String? _staleLabel;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _fetchNotifications();
    });
  }

  Future<void> _fetchNotifications() async {
    setState(() {
      loading = true;
      _error = null;
    });

    // Check for guest users
    if (widget.phone == 'guest' || widget.phone.isEmpty) {
      setState(() {
        notifications = [];
        loading = false;
      });
      return;
    }

    try {
      final result = await ApiClient.cachedGet('/notifications/${widget.phone}');

      if (!mounted) return;
      _staleLabel = result.staleLabel;

      if (result.isSuccess) {
        final data = result.data;
        final List<dynamic> list;
        if (data is List) {
          list = data;
        } else if (data is Map && data['notifications'] is List) {
          list = data['notifications'] as List<dynamic>;
        } else {
          list = result.dataAsList();
        }
        setState(() {
          notifications = list;
          loading = false;
        });
      } else {
        setState(() {
          _error = result.message ?? 'Failed to fetch notifications';
          loading = false;
        });
      }
      // Listen for fresh data from background refresh
      result.onFresh?.then((fresh) {
        if (!mounted) return;
        if (fresh.isSuccess) {
          final data = fresh.data;
          final List<dynamic> list;
          if (data is List) {
            list = data;
          } else if (data is Map && data['notifications'] is List) {
            list = data['notifications'] as List<dynamic>;
          } else {
            list = fresh.dataAsList();
          }
          setState(() {
            _staleLabel = null;
            notifications = list;
          });
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        loading = false;
      });
    }
  }

  void _handleNotificationTap(Map<String, dynamic> notification) {
    // Extract type from top-level or nested data
    final type = notification['type']?.toString() ??
        (notification['data'] is Map
            ? (notification['data'] as Map)['type']?.toString()
            : null) ??
        '';
          // ignore: unused_local_variable
    final data = notification['data'] is Map
        ? notification['data'] as Map<String, dynamic>
        : <String, dynamic>{};

    switch (type) {
      case 'appointment_confirmed':
      case 'appointment_cancelled':
      case 'appointment_reminder':
      case 'appointment_rescheduled':
        context.push('/appointments');
        break;
      case 'investigation_result':
      case 'investigation_result_ready':
      case 'investigation_confirmed':
      case 'investigation_booking':
      case 'collector_dispatched':
        context.push('/investigations');
        break;
      case 'pharmacy_confirmed':
      case 'pharmacy_dispatched':
      case 'pharmacy_delivered':
      case 'pharmacy_order':
        context.push('/pharmacy');
        break;
      case 'document_uploaded':
        context.push('/health', extra: {'tab': 1});
        break;
      case 'feedback_request':
        context.push('/ask-a-doubt');
        break;
      default:
        // No navigation — just mark as read
        break;
    }
  }

  Future<void> _markAsRead(int id) async {
    try {
      await ApiClient.patch('/notifications/$id/read');
    } catch (e) {
      debugPrint('Error marking notification as read: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final loc = AppLocalizations.of(context)!;
    const color = Color(0xFF00695C); // fallback accent color

    return FeatureScreenScaffold(
      title: loc.notifications,
      icon: Icons.notifications_outlined,
      color: color,
      heroTag: 'notifications',
      child: Column(
        children: [
          OfflineBanner(staleLabel: _staleLabel),
          Expanded(
            child: DataStateBuilder<dynamic>(
        isLoading: loading,
        error: _error,
        data: notifications,
        onRetry: _fetchNotifications,
        emptyIcon: Icons.notifications_off_outlined,
        emptyTitle: loc.noNotifications,
        emptySubtitle: '',
        builder: (context, items) => RefreshIndicator(
              onRefresh: _fetchNotifications,
              child: ListView.separated(
                      padding: const EdgeInsets.all(16),
                      itemCount: notifications.length,
                      separatorBuilder: (_, _) => const Divider(),
                      itemBuilder: (_, index) {
                        final notif = notifications[index];
                        final created = DateTime.tryParse(notif['created_at'] ?? '') ?? DateTime.now();
                        final isRead = notif['read'] == true;

                        return Dismissible(
                          key: Key('${notif['id']}'),
                          direction: DismissDirection.endToStart,
                          background: Container(
                            alignment: Alignment.centerRight,
                            padding: const EdgeInsets.symmetric(horizontal: 20),
                            color: Colors.teal,
                            child: const Icon(Icons.done, color: Colors.white),
                          ),
                          onDismissed: (_) async {
                            await _markAsRead(notif['id']);
                            if (!mounted) return;
                            setState(() => notifications.removeAt(index));
                            // ignore: use_build_context_synchronously
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(content: Text(loc.notificationMarkedAsRead)),
                            );
                          },
                          child: ListTile(
                            title: Text(notif['title'] ?? loc.notification),
                            subtitle: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(notif['body'] ?? ''),
                                const SizedBox(height: 4),
                                Text(
                                  DateFormat('dd-MM-yyyy hh:mm a').format(created.toLocal()),
                                  style: const TextStyle(fontSize: 11, color: Colors.grey),
                                ),
                              ],
                            ),
                            trailing: isRead
                                ? null
                                : const Icon(Icons.circle, color: Colors.teal, size: 10),
                            onTap: () async {
                              await _markAsRead(notif['id']);
                              if (!mounted) return;
                              setState(() {
                                notifications[index]['read'] = true;
                              });
                              _handleNotificationTap(notif);
                            },
                            tileColor: isRead ? null : Colors.teal.withAlpha(20),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(8),
                            ),
                          ),
                        );
                      },
                    ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}