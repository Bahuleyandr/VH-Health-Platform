import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../../core/services/api_client.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/config/api_config.dart';

class StaffMessage {
  final int id;
  final String senderUid;
  final String recipientUid;
  final String? patientUid;
  final String? subject;
  final String body;
  final String priority;
  final bool isRead;
  final DateTime createdAt;

  const StaffMessage({
    required this.id,
    required this.senderUid,
    required this.recipientUid,
    this.patientUid,
    this.subject,
    required this.body,
    required this.priority,
    required this.isRead,
    required this.createdAt,
  });

  factory StaffMessage.fromJson(Map<String, dynamic> json) {
    return StaffMessage(
      id: json['id'] as int,
      senderUid: json['sender_uid'] as String,
      recipientUid: json['recipient_uid'] as String,
      patientUid: json['patient_uid'] as String?,
      subject: json['subject'] as String?,
      body: json['body'] as String,
      priority: json['priority'] as String? ?? 'normal',
      isRead: json['is_read'] as bool? ?? false,
      createdAt: DateTime.parse(json['created_at'] as String),
    );
  }
}

class MessagingInboxScreen extends StatefulWidget {
  const MessagingInboxScreen({super.key});

  @override
  State<MessagingInboxScreen> createState() => _MessagingInboxScreenState();
}

class _MessagingInboxScreenState extends State<MessagingInboxScreen> {
  List<StaffMessage> _messages = [];
  bool _loading = true;
  String? _error;
  String? _myUid;
  int _unreadCount = 0;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      _myUid = await ApiConfig.getStaffId();
      final results = await Future.wait([
        ApiClient.get('/api/v1/messaging/inbox'),
        ApiClient.get('/api/v1/messaging/unread-count'),
      ]);

      final inboxResp = results[0];
      final countResp = results[1];

      if (!inboxResp.isSuccess) {
        throw Exception(inboxResp.message ?? 'Failed to load inbox');
      }

      final rawList = inboxResp.data;
      final List<dynamic> list = rawList is List ? rawList : [];
      final parsed = list
          .map((e) => StaffMessage.fromJson(e as Map<String, dynamic>))
          .toList();

      int unread = 0;
      if (countResp.isSuccess && countResp.data is Map) {
        final data = countResp.data as Map<String, dynamic>;
        unread = data['unread_count'] as int? ?? data['count'] as int? ?? 0;
      }

      if (mounted) {
        setState(() {
          _messages = parsed;
          _unreadCount = unread;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  /// Groups messages by conversation partner (sender_uid for inbox).
  /// Returns one entry per unique sender showing the latest message.
  List<_ConversationSummary> _buildConversations() {
    final Map<String, _ConversationSummary> byPartner = {};
    for (final msg in _messages) {
      final partnerUid = msg.senderUid == _myUid ? msg.recipientUid : msg.senderUid;
      final existing = byPartner[partnerUid];
      if (existing == null || msg.createdAt.isAfter(existing.latestMessage.createdAt)) {
        byPartner[partnerUid] = _ConversationSummary(
          partnerUid: partnerUid,
          latestMessage: msg,
          unreadCount: existing != null
              ? existing.unreadCount + (msg.isRead ? 0 : 1)
              : (msg.isRead ? 0 : 1),
        );
      } else if (!msg.isRead) {
        byPartner[partnerUid] = _ConversationSummary(
          partnerUid: partnerUid,
          latestMessage: existing.latestMessage,
          unreadCount: existing.unreadCount + 1,
        );
      }
    }
    final list = byPartner.values.toList();
    list.sort((a, b) => b.latestMessage.createdAt.compareTo(a.latestMessage.createdAt));
    return list;
  }

  Color _priorityColor(String priority) {
    return switch (priority) {
      'critical' => AppTheme.errorRed,
      'urgent' => AppTheme.warningAmber,
      _ => AppTheme.primaryBlue,
    };
  }

  String _formatTime(DateTime dt) {
    final now = DateTime.now();
    final diff = now.difference(dt);
    if (diff.inMinutes < 1) return 'Just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    if (diff.inDays == 1) return 'Yesterday';
    if (diff.inDays < 7) return DateFormat('EEE').format(dt);
    return DateFormat('dd MMM').format(dt);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            const Text('Messages'),
            if (_unreadCount > 0) ...[
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.25),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  '$_unreadCount',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
              ),
            ],
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loadData,
            tooltip: 'Refresh',
          ),
        ],
      ),
      body: _buildBody(),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.go('/staff-directory'),
        icon: const Icon(Icons.edit),
        label: const Text('New Message'),
        backgroundColor: AppTheme.primaryBlue,
        foregroundColor: Colors.white,
      ),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.error_outline, size: 48, color: AppTheme.errorRed),
              const SizedBox(height: 16),
              Text(
                'Failed to load messages',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.outline,
                    ),
              ),
              const SizedBox(height: 16),
              ElevatedButton.icon(
                onPressed: _loadData,
                icon: const Icon(Icons.refresh),
                label: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    final conversations = _buildConversations();

    if (conversations.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.mark_chat_unread_outlined,
              size: 64,
              color: Theme.of(context).colorScheme.outline,
            ),
            const SizedBox(height: 16),
            Text(
              'No messages yet',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: Theme.of(context).colorScheme.outline,
                  ),
            ),
            const SizedBox(height: 8),
            Text(
              'Tap + New Message to start a conversation',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.outline,
                  ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadData,
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: conversations.length,
        separatorBuilder: (_, __) => const Divider(height: 1, indent: 72),
        itemBuilder: (context, index) {
          final conv = conversations[index];
          final msg = conv.latestMessage;
          final hasUnread = conv.unreadCount > 0;
          final priorityColor = _priorityColor(msg.priority);

          return InkWell(
            onTap: () {
              context.go(
                '/messaging/thread/${conv.partnerUid}',
                extra: {'partnerUid': conv.partnerUid},
              );
            },
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Avatar
                  Stack(
                    children: [
                      CircleAvatar(
                        radius: 24,
                        backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.1),
                        child: Text(
                          conv.partnerUid.isNotEmpty
                              ? conv.partnerUid[0].toUpperCase()
                              : '?',
                          style: const TextStyle(
                            color: AppTheme.primaryBlue,
                            fontWeight: FontWeight.bold,
                            fontSize: 18,
                          ),
                        ),
                      ),
                      if (hasUnread)
                        Positioned(
                          right: 0,
                          top: 0,
                          child: Container(
                            width: 16,
                            height: 16,
                            decoration: BoxDecoration(
                              color: AppTheme.errorRed,
                              shape: BoxShape.circle,
                              border: Border.all(color: Colors.white, width: 2),
                            ),
                            child: Center(
                              child: Text(
                                conv.unreadCount > 9
                                    ? '9+'
                                    : '${conv.unreadCount}',
                                style: const TextStyle(
                                  color: Colors.white,
                                  fontSize: 8,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
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
                                conv.partnerUid,
                                style: TextStyle(
                                  fontWeight: hasUnread
                                      ? FontWeight.bold
                                      : FontWeight.w600,
                                  fontSize: 15,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            const SizedBox(width: 8),
                            Text(
                              _formatTime(msg.createdAt),
                              style: TextStyle(
                                fontSize: 11,
                                color: hasUnread
                                    ? AppTheme.primaryBlue
                                    : Theme.of(context).colorScheme.outline,
                                fontWeight: hasUnread
                                    ? FontWeight.w600
                                    : FontWeight.normal,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 2),
                        if (msg.subject != null && msg.subject!.isNotEmpty)
                          Text(
                            msg.subject!,
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w500,
                              color: priorityColor,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        const SizedBox(height: 2),
                        Row(
                          children: [
                            if (msg.priority != 'normal') ...[
                              Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 6, vertical: 1),
                                decoration: BoxDecoration(
                                  color: priorityColor.withValues(alpha: 0.1),
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: Text(
                                  msg.priority.toUpperCase(),
                                  style: TextStyle(
                                    fontSize: 9,
                                    color: priorityColor,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 6),
                            ],
                            Expanded(
                              child: Text(
                                msg.body,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 13,
                                  color: hasUnread
                                      ? AppTheme.textPrimary
                                      : Theme.of(context)
                                          .colorScheme
                                          .onSurfaceVariant,
                                  fontWeight: hasUnread
                                      ? FontWeight.w500
                                      : FontWeight.normal,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _ConversationSummary {
  final String partnerUid;
  final StaffMessage latestMessage;
  final int unreadCount;

  const _ConversationSummary({
    required this.partnerUid,
    required this.latestMessage,
    required this.unreadCount,
  });
}
