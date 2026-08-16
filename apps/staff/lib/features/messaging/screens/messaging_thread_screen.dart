import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';

import '../attachment_saver.dart';
import '../../../core/providers/message_unread_provider.dart';
import '../../../core/services/messaging_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/config/api_config.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class ThreadAttachment {
  final String id;
  final int? messageId;
  final String uploadedByUid;
  final String fileName;
  final String contentType;
  final int fileSize;
  final String scanStatus;
  final DateTime? createdAt;

  const ThreadAttachment({
    required this.id,
    this.messageId,
    required this.uploadedByUid,
    required this.fileName,
    required this.contentType,
    required this.fileSize,
    required this.scanStatus,
    this.createdAt,
  });

  factory ThreadAttachment.fromJson(Map<String, dynamic> json) {
    return ThreadAttachment(
      id: _text(json['id']),
      messageId: _nullableInt(json['message_id']),
      uploadedByUid: _text(json['uploaded_by_uid']),
      fileName: _optionalText(json['file_name']) ?? '',
      contentType:
          _optionalText(json['content_type']) ?? 'application/octet-stream',
      fileSize: _nullableInt(json['file_size']) ?? 0,
      scanStatus: _optionalText(json['scan_status']) ?? 'pending',
      createdAt: _dateValue(json['created_at']),
    );
  }

  String get sizeLabel {
    if (fileSize <= 0) return '';
    if (fileSize < 1024) return '$fileSize B';
    if (fileSize < 1024 * 1024) {
      return '${(fileSize / 1024).toStringAsFixed(1)} KB';
    }
    return '${(fileSize / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  String displayFileName(AppStrings s) {
    return fileName.isEmpty
        ? s.lookup('s4.lib.messaging_thread.attachment')
        : fileName;
  }
}

class ThreadMessage {
  final int id;
  final String? threadId;
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
  final List<ThreadAttachment> attachments;

  const ThreadMessage({
    required this.id,
    this.threadId,
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
    this.attachments = const [],
  });

  factory ThreadMessage.fromJson(Map<String, dynamic> json) {
    final rawAttachments = json['attachments'];
    return ThreadMessage(
      id: json['id'] as int,
      threadId: _optionalText(json['thread_id']),
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
      attachments: rawAttachments is List
          ? rawAttachments
                .whereType<Map>()
                .map(
                  (row) =>
                      ThreadAttachment.fromJson(Map<String, dynamic>.from(row)),
                )
                .where((attachment) => attachment.id.isNotEmpty)
                .toList()
          : const [],
    );
  }

  bool sentBy(String? uid) => senderUid == uid;

  bool shouldShowReceiptFor(String? myUid) {
    if (!sentBy(myUid)) return false;
    return !_isReceiptSuppressedRole(recipientRole);
  }

  ThreadMessage copyWith({bool? isRead}) {
    return ThreadMessage(
      id: id,
      threadId: threadId,
      senderUid: senderUid,
      senderName: senderName,
      senderRole: senderRole,
      recipientUid: recipientUid,
      recipientName: recipientName,
      recipientRole: recipientRole,
      recipientDepartment: recipientDepartment,
      patientUid: patientUid,
      subject: subject,
      body: body,
      priority: priority,
      isRead: isRead ?? this.isRead,
      createdAt: createdAt,
      attachments: attachments,
    );
  }
}

class MessagingThreadScreen extends StatefulWidget {
  final String otherStaffUid;
  final String? otherStaffName;
  final String? otherStaffDepartment;
  final String? threadId;
  final String? patientName;
  final String? patientUid;
  final int? admissionId;

  const MessagingThreadScreen({
    super.key,
    required this.otherStaffUid,
    this.otherStaffName,
    this.otherStaffDepartment,
    this.threadId,
    this.patientName,
    this.patientUid,
    this.admissionId,
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
  // See _ComposeMessageSheetState: `_sending` guards a second tap, this guards
  // a retry of a request whose response never arrived.
  final _sendAttempt = IdempotencyAttempt('staff-message-send');
  bool _uploadingAttachment = false;
  String? _error;
  String? _myUid;
  String? _threadId;
  String? _patientName;
  String? _patientUid;
  int? _admissionId;
  DateTime? _mutedUntil;
  bool _urgentOnly = false;
  String _selectedPriority = 'normal';
  final Set<String> _downloadingAttachmentIds = {};

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
      _myUid = await ApiConfig.getStaffUid() ?? await ApiConfig.getStaffId();
      final List<dynamic> list;
      if ((widget.threadId ?? '').trim().isNotEmpty) {
        final result = await MessagingApiService.threadMessages(
          widget.threadId!.trim(),
        );
        final thread = result['thread'] is Map
            ? Map<String, dynamic>.from(result['thread'] as Map)
            : <String, dynamic>{};
        list =
            result['messages'] as List? ??
            result['data'] as List? ??
            result['items'] as List? ??
            [];
        _threadId = _optionalText(thread['thread_id']) ?? widget.threadId;
        _patientName =
            _optionalText(thread['patient_name']) ?? widget.patientName;
        _patientUid =
            _optionalText(thread['context_patient_uid']) ?? widget.patientUid;
        _admissionId =
            _nullableInt(thread['admission_id']) ?? widget.admissionId;
        _mutedUntil = _dateValue(thread['muted_until']);
        _urgentOnly = thread['urgent_only'] == true;
      } else {
        list = await MessagingApiService.thread(widget.otherStaffUid);
        _threadId = null;
        _patientName = widget.patientName;
        _patientUid = widget.patientUid;
        _admissionId = widget.admissionId;
        _mutedUntil = null;
        _urgentOnly = false;
      }
      final parsed = list
          .map((e) => ThreadMessage.fromJson(e as Map<String, dynamic>))
          .toList();
      if ((_threadId ?? '').isEmpty) {
        for (final message in parsed) {
          if ((message.threadId ?? '').trim().isNotEmpty) {
            _threadId = message.threadId!.trim();
            break;
          }
        }
      }

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

      // Mark unread messages after the thread is visible. Local state changes
      // only for writes the server accepted.
      if (unreadIds.isNotEmpty) {
        unawaited(_markMessagesRead(unreadIds));
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
    final markedIds = <int>[];
    for (final id in ids) {
      try {
        await MessagingApiService.markRead(id);
        markedIds.add(id);
      } catch (_) {
        // Non-critical — silently ignore individual failures
      }
    }
    if (mounted && markedIds.isNotEmpty) {
      final marked = markedIds.toSet();
      setState(() {
        _messages = _messages
            .map(
              (message) => marked.contains(message.id)
                  ? message.copyWith(isRead: true)
                  : message,
            )
            .toList();
      });
      context.read<MessageUnreadProvider>().markMessagesReadLocally(
        markedIds.length,
        refresh: false,
      );
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
        threadId: _threadId,
        patientUid: _patientUid,
        admissionId: _admissionId,
        idempotencyKey: _sendAttempt.keyFor({
          'recipient': widget.otherStaffUid,
          'body': text,
          'priority': _selectedPriority,
          'thread': _threadId,
          'patient': _patientUid,
          'admission': _admissionId,
        }),
      );
      // The attempt ends only on success; the composer is cleared next, so the
      // following message is genuinely a new one.
      _sendAttempt.reset();

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

  Future<void> _attachFile() async {
    if (_uploadingAttachment || _sending) return;
    final threadId = (_threadId ?? '').trim();
    if (threadId.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.messaging_thread.send_a_first_message_before_attaching_a_file',
          ),
          backgroundColor: AppTheme.warningAmber,
        ),
      );
      return;
    }

    final picked = await FilePicker.pickFiles(
      type: FileType.custom,
      allowedExtensions: [
        'pdf',
        'jpg',
        'jpeg',
        'png',
        'gif',
        'webp',
        'txt',
        'csv',
        'doc',
        'docx',
        'xls',
        'xlsx',
      ],
      withData: false,
    );
    final file = picked?.files.single;
    final path = file?.path;
    if (path == null || path.isEmpty) return;

    setState(() => _uploadingAttachment = true);
    try {
      final result = await MessagingApiService.uploadThreadAttachment(
        threadId: threadId,
        filePath: path,
        fileName: file?.name,
        recipientUid: widget.otherStaffUid,
        body: _textController.text.trim(),
        priority: _selectedPriority,
      );
      _textController.clear();
      setState(() => _selectedPriority = 'normal');
      await _loadThread();

      if (!mounted) return;
      final attachment = result['attachment'] is Map
          ? ThreadAttachment.fromJson(
              Map<String, dynamic>.from(result['attachment'] as Map),
            )
          : null;
      final status = attachment?.scanStatus ?? 'pending';
      final s = AppStrings.of(context);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            status == 'clean'
                ? s.lookup('s4.lib.messaging_thread.attachment_sent')
                : s.format('s4.dynamic.messaging.attachment_sent_scan_status', {
                    'status': _scanLabel(s, status),
                  }),
          ),
          backgroundColor: status == 'clean'
              ? AppTheme.successGreen
              : AppTheme.warningAmber,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: AppText(
            's4.dynamic.messaging.attachment_failed',
            values: {'error': e.toString().replaceFirst('Exception: ', '')},
          ),
          backgroundColor: AppTheme.errorRed,
        ),
      );
    } finally {
      if (mounted) setState(() => _uploadingAttachment = false);
    }
  }

  Future<void> _downloadAttachment(ThreadAttachment attachment) async {
    if (attachment.id.isEmpty ||
        _downloadingAttachmentIds.contains(attachment.id)) {
      return;
    }
    setState(() => _downloadingAttachmentIds.add(attachment.id));
    try {
      final bytes = await MessagingApiService.downloadAttachment(attachment.id);
      // Platform-split saver (STF-6): io platforms save + open and return
      // the path; web hands the bytes to the browser as a Blob download
      // (dart:io throws at runtime on staff-web) and returns null.
      final savedPath = await saveAndOpenAttachment(
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        bytes: bytes,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: savedPath != null
              ? AppText(
                  's4.dynamic.messaging.saved_to_path',
                  values: {'path': savedPath},
                )
              : const AppText('s4.lib.messaging.download_started'),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: AppText(
            's4.dynamic.messaging.download_failed',
            values: {'error': e.toString().replaceFirst('Exception: ', '')},
          ),
          backgroundColor: AppTheme.errorRed,
        ),
      );
    } finally {
      if (mounted) {
        setState(() => _downloadingAttachmentIds.remove(attachment.id));
      }
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
          if ((_threadId ?? '').isNotEmpty)
            PopupMenuButton<String>(
              tooltip: AppStrings.of(context)
                  .lookup('s4.lib.messaging_inbox.conversation_actions'),
              onSelected: _handleThreadAction,
              itemBuilder: (_) => [
                const PopupMenuItem(
                  value: 'archive',
                  child: AppText('s4.lib.messaging_inbox.archive'),
                ),
                const PopupMenuItem(
                  value: 'mark-unread',
                  child: AppText('s4.lib.messaging_inbox.mark_unread'),
                ),
                if (_isMuted || _urgentOnly)
                  const PopupMenuItem(
                    value: 'unmute',
                    child: AppText('s4.lib.messaging_inbox.restore_alerts'),
                  )
                else ...[
                  const PopupMenuItem(
                    value: 'mute',
                    child: AppText('s4.lib.messaging_inbox.mute_8h'),
                  ),
                  const PopupMenuItem(
                    value: 'urgent-only',
                    child: AppText('s4.lib.messaging_inbox.urgent_only'),
                  ),
                ],
              ],
            ),
          const LogoutAction(),
        ],
      ),
      body: Column(
        children: [
          if (_contextLabel.isNotEmpty || _isMuted || _urgentOnly)
            _ThreadContextBanner(
              contextLabel: _contextLabel,
              muted: _isMuted,
              urgentOnly: _urgentOnly,
            ),
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

  bool get _isMuted =>
      _mutedUntil != null && _mutedUntil!.isAfter(DateTime.now());

  String get _contextLabel {
    final parts = [
      if ((_patientName ?? '').trim().isNotEmpty) _patientName!.trim(),
      if (_admissionId != null) 'IP #$_admissionId',
    ];
    return parts.join(' - ');
  }

  Future<void> _handleThreadAction(String action) async {
    final threadId = _threadId;
    if (threadId == null || threadId.isEmpty) return;
    try {
      switch (action) {
        case 'archive':
          await MessagingApiService.archiveThread(threadId);
          if (mounted) unawaited(Navigator.of(context).maybePop());
          return;
        case 'mark-unread':
          await MessagingApiService.markThreadUnread(threadId);
          break;
        case 'mute':
          await MessagingApiService.muteThread(threadId);
          break;
        case 'urgent-only':
          await MessagingApiService.urgentOnlyThread(threadId);
          break;
        case 'unmute':
          await MessagingApiService.unmuteThread(threadId);
          break;
      }
      if (mounted) {
        unawaited(context.read<MessageUnreadProvider>().refresh());
        await _loadThread();
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: AppTheme.errorRed,
        ),
      );
    }
  }

  // STF-3: clinical message bodies are PHI. Gate copy behind a confirmation
  // dialog, and schedule a 60 s clipboard clear so the content doesn't
  // linger in the clipboard indefinitely across app boundaries.
  Future<void> _copyMessage(ThreadMessage message) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const AppText('s4.lib.messaging_thread.copy_clinical_message'),
        content: const AppText(
          's4.lib.messaging_thread.copy_clinical_message_body',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const AppText('action.cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const AppText('s4.lib.messaging_thread.copy'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    await Clipboard.setData(ClipboardData(text: message.body));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: AppText(
          's4.lib.messaging_thread.message_copied_clipboard_clears_in_60_s',
        ),
      ),
    );
    // Clear clipboard after 60 s regardless of widget lifecycle.
    Timer(const Duration(seconds: 60), () {
      Clipboard.setData(const ClipboardData(text: ''));
    });
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
                style: Theme.of(context).textTheme.bodySmall
                    ?.copyWith(color: Theme.of(context).colorScheme.outline),
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
              style: Theme.of(context).textTheme.titleMedium
                  ?.copyWith(color: Theme.of(context).colorScheme.outline),
            ),
            const SizedBox(height: 8),
            Text(
              s.messagingThreadEmptyBody,
              style: Theme.of(context).textTheme.bodySmall
                  ?.copyWith(color: Theme.of(context).colorScheme.outline),
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
              onLongPress: () => _copyMessage(msg),
              downloadingAttachmentIds: _downloadingAttachmentIds,
              onAttachmentTap: _downloadAttachment,
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
                          color: _priorityColor(_selectedPriority)
                              .withValues(alpha: 0.1),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                            color: _priorityColor(_selectedPriority)
                                .withValues(alpha: 0.4),
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
                  IconButton(
                    icon: _uploadingAttachment
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.attach_file),
                    tooltip: AppStrings.of(context)
                        .lookup('s4.lib.messaging_thread.attach_file'),
                    onPressed: (_uploadingAttachment || _sending)
                        ? null
                        : _attachFile,
                  ),
                  const SizedBox(width: 2),
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
                        hintText: AppStrings.of(context).lookup(
                          's4.lib.messaging_thread.reply_in_this_conversation',
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(24),
                          borderSide: BorderSide.none,
                        ),
                        filled: true,
                        fillColor: Theme.of(context)
                            .colorScheme
                            .surfaceContainerHighest,
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
  final VoidCallback onLongPress;
  final Set<String> downloadingAttachmentIds;
  final ValueChanged<ThreadAttachment> onAttachmentTap;

  const _MessageBubble({
    required this.message,
    required this.isMine,
    required this.timeLabel,
    required this.priorityColor,
    required this.showReceipt,
    required this.continuesFromPrevious,
    required this.continuesToNext,
    required this.onLongPress,
    required this.downloadingAttachmentIds,
    required this.onAttachmentTap,
  });

  @override
  Widget build(BuildContext context) {
    final defaultAttachmentBody =
        message.attachments.length == 1 &&
        message.body.trim() ==
            'Attachment: ${message.attachments.first.fileName}';
    final showBody = message.body.trim().isNotEmpty && !defaultAttachmentBody;
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

    return GestureDetector(
      onLongPress: onLongPress,
      child: Align(
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
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 10,
                ),
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
                          color: isMine
                              ? Colors.white70
                              : AppTheme.textSecondary,
                        ),
                      ),
                      const SizedBox(height: 4),
                    ],
                    if (showBody)
                      Text(
                        message.body,
                        style: TextStyle(fontSize: 14, color: textColor),
                      ),
                    if (message.attachments.isNotEmpty) ...[
                      if (showBody) const SizedBox(height: 8),
                      ...message.attachments.map(
                        (attachment) => Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: _AttachmentChip(
                            attachment: attachment,
                            isMine: isMine,
                            downloading: downloadingAttachmentIds.contains(
                              attachment.id,
                            ),
                            onTap: () => onAttachmentTap(attachment),
                          ),
                        ),
                      ),
                    ],
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
                      message: AppStrings.of(context).lookup(
                        message.isRead
                            ? 's4.lib.messaging_thread.receipt_read'
                            : 's4.lib.messaging_thread.receipt_delivered',
                      ),
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
      ),
    );
  }
}

class _AttachmentChip extends StatelessWidget {
  final ThreadAttachment attachment;
  final bool isMine;
  final bool downloading;
  final VoidCallback onTap;

  const _AttachmentChip({
    required this.attachment,
    required this.isMine,
    required this.downloading,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final blocked = attachment.scanStatus == 'quarantined';
    final s = AppStrings.of(context);
    final fileName = attachment.displayFileName(s);
    final foreground = isMine ? Colors.white : AppTheme.primaryBlue;
    final background = isMine
        ? Colors.white.withValues(alpha: 0.14)
        : AppTheme.primaryBlue.withValues(alpha: 0.10);
    final borderColor = isMine
        ? Colors.white.withValues(alpha: 0.32)
        : AppTheme.primaryBlue.withValues(alpha: 0.25);
    final statusColor = switch (attachment.scanStatus) {
      'clean' => isMine ? Colors.white70 : AppTheme.successGreen,
      'failed' => isMine ? Colors.white70 : AppTheme.warningAmber,
      'quarantined' => AppTheme.errorRed,
      _ => isMine ? Colors.white70 : Theme.of(context).colorScheme.outline,
    };

    return Material(
      color: background,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: blocked || downloading ? null : onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 48),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: borderColor),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              downloading
                  ? SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: foreground,
                      ),
                    )
                  : Icon(
                      _attachmentIcon(attachment),
                      color: blocked ? AppTheme.errorRed : foreground,
                      size: 20,
                    ),
              const SizedBox(width: 8),
              Flexible(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      fileName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: blocked ? AppTheme.errorRed : foreground,
                        fontWeight: FontWeight.w700,
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      [
                        if (attachment.sizeLabel.isNotEmpty)
                          attachment.sizeLabel,
                        _scanLabel(s, attachment.scanStatus),
                      ].join(' - '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: statusColor,
                        fontSize: 10,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Icon(
                blocked ? Icons.block : Icons.download_outlined,
                color: blocked ? AppTheme.errorRed : foreground,
                size: 16,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ThreadContextBanner extends StatelessWidget {
  final String contextLabel;
  final bool muted;
  final bool urgentOnly;

  const _ThreadContextBanner({
    required this.contextLabel,
    required this.muted,
    required this.urgentOnly,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final chips = [
      if (contextLabel.isNotEmpty)
        _BannerChip(icon: Icons.person_search, label: contextLabel),
      if (urgentOnly)
        _BannerChip(
          icon: Icons.notification_important_outlined,
          label: s.lookup('s4.lib.messaging_thread.urgent_alerts_only'),
        )
      else if (muted)
        _BannerChip(
          icon: Icons.notifications_off_outlined,
          label: s.lookup('s4.lib.messaging_thread.muted'),
        ),
    ];
    return Container(
      width: double.infinity,
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Wrap(spacing: 8, runSpacing: 6, children: chips),
    );
  }
}

class _BannerChip extends StatelessWidget {
  final IconData icon;
  final String label;

  const _BannerChip({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: AppTheme.primaryBlue.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: AppTheme.primaryBlue),
          const SizedBox(width: 5),
          Text(
            label,
            style: const TextStyle(
              fontSize: 12,
              color: AppTheme.primaryBlue,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
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

String _text(Object? value) => value?.toString().trim() ?? '';

String? _optionalText(Object? value) {
  final text = _text(value);
  return text.isEmpty ? null : text;
}

int? _nullableInt(Object? value) {
  if (value == null) return null;
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value.toString());
}

DateTime? _dateValue(Object? value) {
  if (value == null) return null;
  if (value is DateTime) return value;
  return DateTime.tryParse(value.toString());
}

String _scanLabel(AppStrings s, String status) {
  return switch (status) {
    'clean' => s.lookup('s4.lib.messaging_thread.scan_clean'),
    'failed' => s.lookup('s4.lib.messaging_thread.scan_unavailable'),
    'quarantined' => s.lookup('s4.lib.messaging_thread.quarantined'),
    'pending' => s.lookup('s4.lib.messaging_thread.scan_pending'),
    _ => status,
  };
}

IconData _attachmentIcon(ThreadAttachment attachment) {
  final contentType = attachment.contentType.toLowerCase();
  final name = attachment.fileName.toLowerCase();
  if (contentType.contains('pdf') || name.endsWith('.pdf')) {
    return Icons.picture_as_pdf_outlined;
  }
  if (contentType.startsWith('image/') ||
      [
        '.jpg',
        '.jpeg',
        '.png',
        '.gif',
        '.webp',
      ].any((ext) => name.endsWith(ext))) {
    return Icons.image_outlined;
  }
  if (name.endsWith('.xls') || name.endsWith('.xlsx')) {
    return Icons.table_chart_outlined;
  }
  if (name.endsWith('.doc') || name.endsWith('.docx')) {
    return Icons.description_outlined;
  }
  return Icons.attach_file;
}
