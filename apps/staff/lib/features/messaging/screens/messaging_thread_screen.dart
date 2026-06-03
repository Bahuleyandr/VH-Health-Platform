import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../../core/providers/message_unread_provider.dart';
import '../../../core/services/messaging_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/config/api_config.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class ThreadMessage {
  final int id;
  final String senderUid;
  final String? senderName;
  final String? senderRole;
  final String recipientUid;
  final String? recipientName;
  final String? recipientRole;
  final String? recipientDepartment;
  final String? patientUid;
  final String? subject;
  final String body;
  final String priority;
  final bool isRead;
  final DateTime createdAt;

  const ThreadMessage({
    required this.id,
    required this.senderUid,
    this.senderName,
    this.senderRole,
    required this.recipientUid,
    this.recipientName,
    this.recipientRole,
    this.recipientDepartment,
    this.patientUid,
    this.subject,
    required this.body,
    required this.priority,
    required this.isRead,
    required this.createdAt,
  });

  factory ThreadMessage.fromJson(Map<String, dynamic> json) {
    return ThreadMessage(
      id: json['id'] as int,
      senderUid: json['sender_uid'] as String,
      senderName: json['sender_name'] as String?,
      senderRole: json['sender_role'] as String?,
      recipientUid: json['recipient_uid'] as String,
      recipientName: json['recipient_name'] as String?,
      recipientRole: json['recipient_role'] as String?,
      recipientDepartment: json['recipient_department'] as String?,
      patientUid: json['patient_uid'] as String?,
      subject: json['subject'] as String?,
      body: json['body'] as String,
      priority: json['priority'] as String? ?? 'normal',
      isRead: json['is_read'] as bool? ?? false,
      createdAt: DateTime.parse(json['created_at'] as String),
    );
  }

  bool sentBy(String? uid) => senderUid == uid;

  bool shouldShowReceiptFor(String? myUid) {
    if (!sentBy(myUid)) return false;
    return !_isReceiptSuppressedRole(recipientRole);
  }
}

class MessagingThreadScreen extends StatefulWidget {
  final String otherStaffUid;
  final String? otherStaffName;
  final String? otherStaffDepartment;

  const MessagingThreadScreen({
    super.key,
    required this.otherStaffUid,
    this.otherStaffName,
    this.otherStaffDepartment,
  });

  @override
  State<MessagingThreadScreen> createState() => _MessagingThreadScreenState();
}

class _MessagingThreadScreenState extends State<MessagingThreadScreen> {
  final _scrollController = ScrollController();
  final _textController = TextEditingController();
  final _focusNode = FocusNode();

  List<ThreadMessage> _messages = [];
  bool _loading = true;
  bool _sending = false;
  String? _error;
  String? _myUid;
  String _selectedPriority = 'normal';

  @override
  void initState() {
    super.initState();
    _loadThread();
  }

  @override
  void dispose() {
    _scrollController.dispose();
    _textController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  Future<void> _loadThread() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      _myUid = await ApiConfig.getStaffId();
      final List<dynamic> list = await MessagingApiService.thread(
        widget.otherStaffUid,
      );
      final parsed = list
          .map((e) => ThreadMessage.fromJson(e as Map<String, dynamic>))
          .toList();

      // Collect unread IDs (messages sent to me that I haven't read)
      final unreadIds = parsed
          .where((m) => m.recipientUid == _myUid && !m.isRead)
          .map((m) => m.id)
          .toList();

      if (mounted) {
        setState(() {
          _messages = parsed;
          _loading = false;
        });
        _scrollToBottom();
      }

      // Mark unread messages as read (fire and forget, non-blocking)
      if (unreadIds.isNotEmpty) {
        _markMessagesRead(unreadIds);
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

  Future<void> _markMessagesRead(List<int> ids) async {
    for (final id in ids) {
      try {
        await MessagingApiService.markRead(id);
      } catch (_) {
        // Non-critical — silently ignore individual failures
      }
    }
    if (mounted) {
      unawaited(context.read<MessageUnreadProvider>().refresh());
    }
  }

  Future<void> _sendMessage() async {
    final text = _textController.text.trim();
    if (text.isEmpty || _sending) return;

    setState(() => _sending = true);

    try {
      await MessagingApiService.sendDirect(
        recipientUid: widget.otherStaffUid,
        body: text,
        priority: _selectedPriority,
      );

      _textController.clear();
      setState(() => _selectedPriority = 'normal');

      // Reload thread to show the new message with server timestamp
      await _loadThread();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              '${AppStrings.of(context).messagingSendFailedPrefix} ${e.toString()}',
            ),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  bool _isMyMessage(ThreadMessage msg) => msg.senderUid == _myUid;

  Color _priorityColor(String priority) {
    return switch (priority) {
      'critical' => AppTheme.errorRed,
      'urgent' => AppTheme.warningAmber,
      _ => AppTheme.primaryBlue,
    };
  }

  String _formatMessageTime(DateTime dt) {
    final s = AppStrings.of(context);
    final now = DateTime.now();
    final diff = now.difference(dt);
    if (diff.inMinutes < 1) return s.timeJustNow;
    if (diff.inDays == 0) return DateFormat('HH:mm').format(dt);
    if (diff.inDays == 1) {
      return '${s.timeYesterday} ${DateFormat('HH:mm').format(dt)}';
    }
    return DateFormat('dd MMM HH:mm').format(dt);
  }

  bool _showDateSeparator(int index) {
    if (index == 0) return true;
    final prev = _messages[index - 1].createdAt;
    final curr = _messages[index].createdAt;
    return !DateUtils.isSameDay(prev, curr);
  }

  String _dateSeparatorLabel(DateTime dt) {
    final s = AppStrings.of(context);
    final now = DateTime.now();
    if (DateUtils.isSameDay(dt, now)) return s.timeToday;
    if (DateUtils.isSameDay(dt, now.subtract(const Duration(days: 1)))) {
      return s.timeYesterday;
    }
    return DateFormat('EEEE, d MMMM').format(dt);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              _threadTitle,
              style: const TextStyle(fontSize: 16),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            Text(
              _threadSubtitle(s),
              style: const TextStyle(fontSize: 11, color: Colors.white70),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loadThread,
            tooltip: s.actionRefresh,
          ),
          const LogoutAction(),
        ],
      ),
      body: Column(
        children: [
          Expanded(child: _buildMessageList()),
          _buildComposer(),
        ],
      ),
    );
  }

  String get _threadTitle {
    if (widget.otherStaffName != null &&
        widget.otherStaffName!.trim().isNotEmpty) {
      return widget.otherStaffName!.trim();
    }
    for (final msg in _messages) {
      if (msg.senderUid == widget.otherStaffUid &&
          msg.senderName != null &&
          msg.senderName!.trim().isNotEmpty) {
        return msg.senderName!.trim();
      }
      if (msg.recipientUid == widget.otherStaffUid &&
          msg.recipientName != null &&
          msg.recipientName!.trim().isNotEmpty) {
        return msg.recipientName!.trim();
      }
    }
    return widget.otherStaffUid;
  }

  String _threadSubtitle(AppStrings s) {
    if (widget.otherStaffDepartment != null &&
        widget.otherStaffDepartment!.trim().isNotEmpty) {
      return widget.otherStaffDepartment!.trim();
    }
    for (final msg in _messages) {
      if (msg.recipientUid == widget.otherStaffUid &&
          msg.recipientDepartment != null &&
          msg.recipientDepartment!.trim().isNotEmpty) {
        return msg.recipientDepartment!.trim();
      }
    }
    return s.profileFallbackName;
  }

  Widget _buildMessageList() {
    final s = AppStrings.of(context);
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
              const Icon(
                Icons.error_outline,
                size: 48,
                color: AppTheme.errorRed,
              ),
              const SizedBox(height: 16),
              Text(
                s.messagingThreadLoadFailed,
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
                onPressed: _loadThread,
                icon: const Icon(Icons.refresh),
                label: Text(s.actionRetry),
              ),
            ],
          ),
        ),
      );
    }

    if (_messages.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.chat_bubble_outline,
              size: 64,
              color: Theme.of(context).colorScheme.outline,
            ),
            const SizedBox(height: 16),
            Text(
              s.messagingThreadEmptyTitle,
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                color: Theme.of(context).colorScheme.outline,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              s.messagingThreadEmptyBody,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.outline,
              ),
            ),
          ],
        ),
      );
    }

    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      itemCount: _messages.length,
      itemBuilder: (context, index) {
        final msg = _messages[index];
        final isMine = _isMyMessage(msg);
        final showSeparator = _showDateSeparator(index);
        final continuesFromPrevious =
            !showSeparator &&
            index > 0 &&
            _messages[index - 1].senderUid == msg.senderUid;
        final continuesToNext =
            index < _messages.length - 1 &&
            DateUtils.isSameDay(
              msg.createdAt,
              _messages[index + 1].createdAt,
            ) &&
            _messages[index + 1].senderUid == msg.senderUid;

        return Column(
          children: [
            if (showSeparator)
              _DateSeparator(label: _dateSeparatorLabel(msg.createdAt)),
            _MessageBubble(
              message: msg,
              isMine: isMine,
              timeLabel: _formatMessageTime(msg.createdAt),
              priorityColor: _priorityColor(msg.priority),
              showReceipt: msg.shouldShowReceiptFor(_myUid),
              continuesFromPrevious: continuesFromPrevious,
              continuesToNext: continuesToNext,
            ),
          ],
        );
      },
    );
  }

  Widget _buildComposer() {
    final s = AppStrings.of(context);
    return Container(
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.08),
            blurRadius: 8,
            offset: const Offset(0, -2),
          ),
        ],
      ),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Priority selector (shown only when not normal)
              if (_selectedPriority != 'normal')
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: _priorityColor(
                            _selectedPriority,
                          ).withValues(alpha: 0.1),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                            color: _priorityColor(
                              _selectedPriority,
                            ).withValues(alpha: 0.4),
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              _selectedPriority == 'critical'
                                  ? Icons.warning
                                  : Icons.priority_high,
                              size: 14,
                              color: _priorityColor(_selectedPriority),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              _selectedPriority.toUpperCase(),
                              style: TextStyle(
                                fontSize: 11,
                                color: _priorityColor(_selectedPriority),
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                            const SizedBox(width: 4),
                            GestureDetector(
                              onTap: () =>
                                  setState(() => _selectedPriority = 'normal'),
                              child: Icon(
                                Icons.close,
                                size: 14,
                                color: _priorityColor(_selectedPriority),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  // Priority button
                  PopupMenuButton<String>(
                    icon: Icon(
                      Icons.flag_outlined,
                      color: _selectedPriority == 'normal'
                          ? Theme.of(context).colorScheme.outline
                          : _priorityColor(_selectedPriority),
                    ),
                    tooltip: s.messagingSetPriority,
                    onSelected: (value) =>
                        setState(() => _selectedPriority = value),
                    itemBuilder: (_) => [
                      PopupMenuItem(
                        value: 'normal',
                        child: Row(
                          children: [
                            const Icon(Icons.flag_outlined, color: Colors.grey),
                            const SizedBox(width: 8),
                            Text(s.priorityNormal),
                          ],
                        ),
                      ),
                      PopupMenuItem(
                        value: 'urgent',
                        child: Row(
                          children: [
                            const Icon(
                              Icons.priority_high,
                              color: Colors.orange,
                            ),
                            const SizedBox(width: 8),
                            Text(s.priorityUrgent),
                          ],
                        ),
                      ),
                      PopupMenuItem(
                        value: 'critical',
                        child: Row(
                          children: [
                            const Icon(Icons.warning, color: Colors.red),
                            const SizedBox(width: 8),
                            Text(s.priorityCritical),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: TextField(
                      controller: _textController,
                      focusNode: _focusNode,
                      maxLines: 4,
                      minLines: 1,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: InputDecoration(
                        hintText: 'Reply in this conversation',
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(24),
                          borderSide: BorderSide.none,
                        ),
                        filled: true,
                        fillColor: Theme.of(
                          context,
                        ).colorScheme.surfaceContainerHighest,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 10,
                        ),
                        isDense: true,
                      ),
                      onSubmitted: (_) => _sendMessage(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  // Send button
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 200),
                    child: _sending
                        ? const SizedBox(
                            width: 40,
                            height: 40,
                            child: Padding(
                              padding: EdgeInsets.all(8),
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          )
                        : FloatingActionButton.small(
                            key: const ValueKey('send-btn'),
                            onPressed: _sendMessage,
                            backgroundColor: AppTheme.primaryBlue,
                            foregroundColor: Colors.white,
                            tooltip: s.messagingSend,
                            child: const Icon(Icons.send, size: 18),
                          ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  final ThreadMessage message;
  final bool isMine;
  final String timeLabel;
  final Color priorityColor;
  final bool showReceipt;
  final bool continuesFromPrevious;
  final bool continuesToNext;

  const _MessageBubble({
    required this.message,
    required this.isMine,
    required this.timeLabel,
    required this.priorityColor,
    required this.showReceipt,
    required this.continuesFromPrevious,
    required this.continuesToNext,
  });

  @override
  Widget build(BuildContext context) {
    final bubbleColor = isMine
        ? AppTheme.primaryBlue
        : Theme.of(context).colorScheme.surfaceContainerHighest;
    final textColor = isMine
        ? Colors.white
        : Theme.of(context).colorScheme.onSurface;
    final timeColor = isMine
        ? Colors.white70
        : Theme.of(context).colorScheme.outline;
    final topCorner = continuesFromPrevious ? 8.0 : 18.0;
    final bottomCorner = continuesToNext ? 8.0 : 18.0;

    return Align(
      alignment: isMine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: EdgeInsets.only(
          top: continuesFromPrevious ? 1 : 6,
          bottom: continuesToNext ? 1 : 5,
        ),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.75,
        ),
        child: Column(
          crossAxisAlignment: isMine
              ? CrossAxisAlignment.end
              : CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: bubbleColor,
                borderRadius: BorderRadius.only(
                  topLeft: Radius.circular(isMine ? 18 : topCorner),
                  topRight: Radius.circular(isMine ? topCorner : 18),
                  bottomLeft: Radius.circular(isMine ? 18 : bottomCorner),
                  bottomRight: Radius.circular(isMine ? bottomCorner : 18),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (message.priority != 'normal') ...[
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          message.priority == 'critical'
                              ? Icons.warning
                              : Icons.priority_high,
                          size: 12,
                          color: isMine ? Colors.white70 : priorityColor,
                        ),
                        const SizedBox(width: 4),
                        Text(
                          message.priority.toUpperCase(),
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                            color: isMine ? Colors.white70 : priorityColor,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                  ],
                  if (message.subject != null &&
                      message.subject!.isNotEmpty) ...[
                    Text(
                      message.subject!,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                        color: isMine ? Colors.white70 : AppTheme.textSecondary,
                      ),
                    ),
                    const SizedBox(height: 4),
                  ],
                  Text(
                    message.body,
                    style: TextStyle(fontSize: 14, color: textColor),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 2),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  timeLabel,
                  style: TextStyle(fontSize: 10, color: timeColor),
                ),
                if (showReceipt) ...[
                  const SizedBox(width: 4),
                  Tooltip(
                    message: message.isRead ? 'Read' : 'Delivered',
                    child: Icon(
                      message.isRead ? Icons.done_all : Icons.done,
                      size: 12,
                      color: message.isRead
                          ? AppTheme.accentCyan
                          : Theme.of(context).colorScheme.outline,
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

class _DateSeparator extends StatelessWidget {
  final String label;

  const _DateSeparator({required this.label});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(
        children: [
          const Expanded(child: Divider()),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Text(
              label,
              style: TextStyle(
                fontSize: 11,
                color: Theme.of(context).colorScheme.outline,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          const Expanded(child: Divider()),
        ],
      ),
    );
  }
}

bool _isReceiptSuppressedRole(String? role) {
  final normalized = (role ?? '').trim().toUpperCase();
  return const {
    'ADMIN',
    'SUPER_ADMIN',
    'CEO',
    'COO',
    'CHIEF_EXECUTIVE',
    'CHIEF_EXECUTIVE_OFFICER',
  }.contains(normalized);
}
