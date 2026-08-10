import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

import '../services/messaging_api_service.dart';
import '../services/staff_local_notifications.dart';

typedef MessageUnreadLoader = Future<Map<String, dynamic>> Function();

class StaffMessageAlert {
  final String messageId;
  final String title;
  final String body;
  final String priority;

  const StaffMessageAlert({
    required this.messageId,
    required this.title,
    required this.body,
    required this.priority,
  });

  factory StaffMessageAlert.fromRealtime(Map<String, dynamic> data) {
    final priority = _text(data['priority']).toLowerCase();
    final subject = _text(data['subject']);
    final body = _text(data['body']);
    return StaffMessageAlert(
      messageId: _text(data['messageId'] ?? data['message_id'] ?? data['id']),
      title: switch (priority) {
        'critical' => 'Critical staff message',
        'urgent' => 'Urgent staff message',
        _ => 'New staff message',
      },
      body: subject.isNotEmpty
          ? subject
          : body.isNotEmpty
          ? body
          : 'Open Messages to review.',
      priority: priority.isNotEmpty ? priority : 'normal',
    );
  }
}

class MessageUnreadProvider extends ChangeNotifier {
  MessageUnreadProvider({MessageUnreadLoader? loadUnreadCount})
    : _loadUnreadCount = loadUnreadCount ?? MessagingApiService.unreadCount;

  final MessageUnreadLoader _loadUnreadCount;
  int _unreadCount = 0;
  int _alertSerial = 0;
  bool _started = false;
  bool _refreshing = false;
  bool _refreshPending = false;
  int _sessionGeneration = 0;
  int? _refreshGeneration;
  StaffMessageAlert? _latestAlert;
  StreamSubscription<RealtimeEvent>? _messageSub;
  Timer? _pollTimer;
  final Set<String> _seenMessageKeys = <String>{};

  int get unreadCount => _unreadCount;
  int get alertSerial => _alertSerial;
  StaffMessageAlert? get latestAlert => _latestAlert;

  Future<void> start() async {
    if (_started) return;
    _started = true;
    _sessionGeneration += 1;
    _messageSub = RealtimeClient.instance
        .events('staff:message', broadcastChannel: false)
        .listen(_handleRealtimeMessage);
    _pollTimer = Timer.periodic(const Duration(minutes: 2), (_) {
      unawaited(refresh());
    });
    await refresh();
  }

  /// Tear down on logout (STF-1): cancel the realtime subscription and the
  /// 2-minute unread poll, and clear the cached alert/badge state so the
  /// previous clinician's message subjects cannot surface on the login
  /// screen of a shared ward device. [start] may be called again after the
  /// next login.
  void stop() {
    _sessionGeneration += 1;
    _started = false;
    _messageSub?.cancel();
    _messageSub = null;
    _pollTimer?.cancel();
    _pollTimer = null;
    _seenMessageKeys.clear();
    _refreshing = false;
    _refreshPending = false;
    _refreshGeneration = null;
    _unreadCount = 0;
    _latestAlert = null;
    notifyListeners();
  }

  Future<void> refresh() async {
    final generation = _sessionGeneration;
    if (_refreshing && _refreshGeneration == generation) {
      _refreshPending = true;
      return;
    }

    do {
      if (generation != _sessionGeneration) return;
      _refreshing = true;
      _refreshGeneration = generation;
      _refreshPending = false;
      try {
        final result = await _loadUnreadCount();
        if (generation != _sessionGeneration) return;
        setUnreadCountFromServer(
          _intValue(result['unread_count'] ?? result['count']),
        );
      } catch (e) {
        if (generation != _sessionGeneration) return;
        if (kDebugMode) debugPrint('Message unread refresh failed: $e');
      } finally {
        if (_refreshGeneration == generation) {
          _refreshing = false;
          _refreshGeneration = null;
        }
      }
    } while (_refreshPending && generation == _sessionGeneration);
  }

  void setUnreadCountFromServer(int count) {
    final normalized = count < 0 ? 0 : count;
    if (_unreadCount == normalized) {
      if (normalized == 0 && _latestAlert != null) {
        _latestAlert = null;
        notifyListeners();
      }
      return;
    }
    _unreadCount = normalized;
    if (_unreadCount == 0) _latestAlert = null;
    notifyListeners();
  }

  void markMessagesReadLocally(int count, {bool refresh = true}) {
    if (count <= 0) return;
    final normalized = (_unreadCount - count).clamp(0, 1 << 31).toInt();
    if (_unreadCount != normalized) {
      _unreadCount = normalized;
      if (_unreadCount == 0) _latestAlert = null;
      notifyListeners();
    } else if (normalized == 0 && _latestAlert != null) {
      _latestAlert = null;
      notifyListeners();
    }
    if (refresh) unawaited(this.refresh());
  }

  void _handleRealtimeMessage(RealtimeEvent event) {
    if (!_started) return;
    final alert = StaffMessageAlert.fromRealtime(event.data);
    final key = alert.messageId.isNotEmpty
        ? alert.messageId
        : '${event.channel}:${event.at.microsecondsSinceEpoch}';
    if (!_seenMessageKeys.add(key)) return;

    _unreadCount += 1;
    _latestAlert = alert;
    _alertSerial += 1;
    notifyListeners();
    unawaited(
      StaffLocalNotifications.instance.showStaffMessage(
        messageId: alert.messageId,
        title: alert.title,
        body: alert.body,
        priority: alert.priority,
      ),
    );
    unawaited(refresh());
  }

  @override
  void dispose() {
    _messageSub?.cancel();
    _pollTimer?.cancel();
    super.dispose();
  }
}

class StaffMessageAlertListener extends StatefulWidget {
  final Widget child;

  const StaffMessageAlertListener({super.key, required this.child});

  @override
  State<StaffMessageAlertListener> createState() =>
      _StaffMessageAlertListenerState();
}

class _StaffMessageAlertListenerState extends State<StaffMessageAlertListener> {
  int _lastAlertSerial = 0;

  @override
  Widget build(BuildContext context) {
    return Consumer<MessageUnreadProvider>(
      builder: (context, provider, child) {
        final alert = provider.latestAlert;
        if (alert != null && provider.alertSerial != _lastAlertSerial) {
          _lastAlertSerial = provider.alertSerial;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (!mounted) return;
            final messenger = ScaffoldMessenger.maybeOf(context);
            if (messenger == null) return;
            messenger.showSnackBar(
              SnackBar(
                content: Row(
                  children: [
                    const Icon(Icons.mark_email_unread, color: Colors.white),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            alert.title,
                            style: const TextStyle(fontWeight: FontWeight.w700),
                          ),
                          Text(
                            alert.body,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                backgroundColor: switch (alert.priority) {
                  'critical' => Colors.red.shade700,
                  'urgent' => Colors.orange.shade800,
                  _ => Theme.of(context).colorScheme.inverseSurface,
                },
                behavior: SnackBarBehavior.floating,
                duration: const Duration(seconds: 5),
              ),
            );
          });
        }
        return child ?? widget.child;
      },
      child: widget.child,
    );
  }
}

String _text(Object? value) => value?.toString().trim() ?? '';

int _intValue(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}
