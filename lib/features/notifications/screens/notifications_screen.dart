import 'dart:io';
import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';
import 'package:firebase_auth/firebase_auth.dart';

import 'package:vhhealth/core/config/api_config.dart';
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

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _fetchNotifications();
    });
  }

  Future<String?> _getBearerToken() async {
    final user = FirebaseAuth.instance.currentUser;
    return user != null ? await user.getIdToken() : null;
  }

Future<void> _fetchNotifications() async {
    setState(() => loading = true);
    final loc = AppLocalizations.of(context)!;

    // Check for guest users
    if (widget.phone == 'guest' || widget.phone.isEmpty) {
      setState(() {
        notifications = [];
        loading = false;
      });
      return;
    }

    final token = await _getBearerToken();
    if (token == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(loc.otpInvalidFirebaseToken),
      ));
      setState(() => loading = false);
      return;
    }

    try {
      final uri = Uri.parse(
        '${ApiConfig.baseUrl}/notifications/${widget.phone}',
      );

      final res = await http.get(
        uri,
        headers: {
          ...ApiConfig.authHeaders,
          'Authorization': 'Bearer $token',
        },
      ).timeout(
        const Duration(seconds: 10),
        onTimeout: () {
          throw TimeoutException('Request timeout');
        },
      );

      if (!mounted) return;

      if (res.statusCode == 200) {
        final List<dynamic> data = jsonDecode(res.body.trim());
        setState(() {
          notifications = data;
          loading = false;
        });
      } else {
        debugPrint('Failed to fetch notifications. Status: ${res.statusCode}, Body: ${res.body}');
        setState(() => loading = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(loc.failedToFetchNotifications)),
        );
      }
    } on SocketException {
      if (!mounted) return;
      setState(() => loading = false);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('No internet connection'),
          backgroundColor: Colors.red,
        ),
      );
    } on TimeoutException {
      if (!mounted) return;
      setState(() => loading = false);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Request timed out. Please try again.'),
          backgroundColor: Colors.orange,
        ),
      );
    } catch (e) {
      debugPrint('Error fetching notifications: $e');
      if (!mounted) return;
      setState(() => loading = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(loc.errorFetchingNotifications)),
      );
    }
  }

  Future<void> _markAsRead(int id) async {
    final token = await _getBearerToken();
    if (token == null) return;

    final uri = Uri.parse(
      '${ApiConfig.baseUrl}/notifications/$id/read',
    );

    try {
      await http.patch(uri, headers: {
        ...ApiConfig.authHeaders,
        'Authorization': 'Bearer $token',
      });
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
      child: loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _fetchNotifications,
              child: notifications.isEmpty
                  ? LayoutBuilder(
                      builder: (_, constraints) => SingleChildScrollView(
                        physics: const AlwaysScrollableScrollPhysics(),
                        child: Container(
                          // Fixed: Use a safe minimum height
                          constraints: BoxConstraints(
                            minHeight: constraints.maxHeight.isFinite 
                              ? constraints.maxHeight 
                              : 400, // Fallback height when infinite
                          ),
                          child: Center(
                            child: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Icon(
                                  Icons.notifications_off_outlined,
                                  size: 64,
                                  color: Colors.grey[400],
                                ),
                                const SizedBox(height: 16),
                                Text(
                                  loc.noNotifications,
                                  style: TextStyle(
                                    fontSize: 16,
                                    color: Colors.grey[600],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    )
                  : ListView.separated(
                      padding: const EdgeInsets.all(16),
                      itemCount: notifications.length,
                      separatorBuilder: (_, __) => const Divider(),
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
    );
  }
}