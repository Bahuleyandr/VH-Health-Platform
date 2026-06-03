import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/providers/message_unread_provider.dart';
import '../../../core/services/messaging_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';

class StaffMessage {
  final int id;
  final String senderUid;
  final String? senderName;
  final String? senderRole;
  final String? senderDepartment;
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

  const StaffMessage({
    required this.id,
    required this.senderUid,
    this.senderName,
    this.senderRole,
    this.senderDepartment,
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

  factory StaffMessage.fromJson(Map<String, dynamic> json) {
    return StaffMessage(
      id: _intValue(json['id']),
      senderUid: _text(json['sender_uid']),
      senderName: _optionalText(json['sender_name']),
      senderRole: _optionalText(json['sender_role']),
      senderDepartment: _optionalText(json['sender_department']),
      recipientUid: _text(json['recipient_uid']),
      recipientName: _optionalText(json['recipient_name']),
      recipientRole: _optionalText(json['recipient_role']),
      recipientDepartment: _optionalText(json['recipient_department']),
      patientUid: _optionalText(json['patient_uid']),
      subject: _optionalText(json['subject']),
      body: _text(json['body']),
      priority: _optionalText(json['priority']) ?? 'normal',
      isRead: json['is_read'] as bool? ?? false,
      createdAt: DateTime.tryParse(_text(json['created_at'])) ?? DateTime.now(),
    );
  }

  bool sentBy(String? uid) => senderUid == uid;

  String partnerUid(String? myUid) => sentBy(myUid) ? recipientUid : senderUid;

  String partnerName(String? myUid) {
    final name = sentBy(myUid) ? recipientName : senderName;
    return (name == null || name.isEmpty) ? partnerUid(myUid) : name;
  }

  String partnerDepartment(String? myUid) {
    final department = sentBy(myUid) ? recipientDepartment : senderDepartment;
    return department ?? '';
  }

  bool shouldShowReceiptFor(String? myUid) {
    if (!sentBy(myUid)) return false;
    return !_isReceiptSuppressedRole(recipientRole);
  }
}

class MessageTarget {
  final String uid;
  final String name;
  final String role;
  final String department;
  final String employeeId;
  final String position;

  const MessageTarget({
    required this.uid,
    required this.name,
    required this.role,
    required this.department,
    required this.employeeId,
    required this.position,
  });

  factory MessageTarget.fromJson(Map<String, dynamic> json) {
    return MessageTarget(
      uid: _text(json['uid']),
      name: _optionalText(json['name']) ?? 'Unnamed staff',
      role: _optionalText(json['role']) ?? 'GENERAL_STAFF',
      department: _optionalText(json['department']) ?? 'Unassigned',
      employeeId: _optionalText(json['employee_id']) ?? '',
      position: _optionalText(json['position']) ?? '',
    );
  }

  String get subtitle {
    final parts = [
      role.replaceAll('_', ' '),
      if (department.isNotEmpty) department,
      if (employeeId.isNotEmpty) employeeId,
    ];
    return parts.join(' - ');
  }
}

class StaffMessageThread {
  final String threadId;
  final String threadType;
  final String partnerUid;
  final String partnerName;
  final String partnerRole;
  final String partnerDepartment;
  final String? patientUid;
  final String? patientName;
  final int? admissionId;
  final String? subject;
  final String body;
  final String priority;
  final int unreadCount;
  final bool archived;
  final bool urgentOnly;
  final DateTime? mutedUntil;
  final DateTime lastMessageAt;
  final StaffMessage latestMessage;

  const StaffMessageThread({
    required this.threadId,
    required this.threadType,
    required this.partnerUid,
    required this.partnerName,
    required this.partnerRole,
    required this.partnerDepartment,
    this.patientUid,
    this.patientName,
    this.admissionId,
    this.subject,
    required this.body,
    required this.priority,
    required this.unreadCount,
    required this.archived,
    required this.urgentOnly,
    required this.mutedUntil,
    required this.lastMessageAt,
    required this.latestMessage,
  });

  factory StaffMessageThread.fromJson(Map<String, dynamic> json) {
    final latest = StaffMessage.fromJson(json);
    final threadSubject =
        _optionalText(json['thread_subject']) ?? _optionalText(json['subject']);
    final contextPatientUid =
        _optionalText(json['context_patient_uid']) ??
        _optionalText(json['patient_uid']);
    final lastMessageAt =
        _dateValue(json['last_message_at']) ??
        _dateValue(json['created_at']) ??
        DateTime.now();
    final partnerUid =
        _optionalText(json['partner_uid']) ?? latest.partnerUid(null);
    final partnerName =
        _optionalText(json['partner_name']) ?? latest.partnerName(null);
    return StaffMessageThread(
      threadId: _text(json['thread_id']),
      threadType: _optionalText(json['thread_type']) ?? 'direct',
      partnerUid: partnerUid,
      partnerName: partnerName.isEmpty ? 'Staff conversation' : partnerName,
      partnerRole: _optionalText(json['partner_role']) ?? '',
      partnerDepartment:
          _optionalText(json['partner_department']) ??
          latest.partnerDepartment(null),
      patientUid: contextPatientUid,
      patientName: _optionalText(json['patient_name']),
      admissionId: _nullableInt(json['admission_id']),
      subject: threadSubject,
      body: _optionalText(json['body']) ?? '',
      priority:
          _optionalText(json['priority']) ??
          _optionalText(json['thread_priority']) ??
          'normal',
      unreadCount: _intValue(json['unread_count']),
      archived: json['archived_at'] != null,
      urgentOnly: json['urgent_only'] == true,
      mutedUntil: _dateValue(json['muted_until']),
      lastMessageAt: lastMessageAt,
      latestMessage: latest,
    );
  }

  bool get hasUnread => unreadCount > 0;
  bool get isMuted => mutedUntil != null && mutedUntil!.isAfter(DateTime.now());

  String get contextLabel {
    final parts = [
      if (patientName != null && patientName!.isNotEmpty) patientName,
      if (admissionId != null) 'IP #$admissionId',
    ];
    return parts.join(' - ');
  }
}

class MessagingInboxScreen extends StatefulWidget {
  const MessagingInboxScreen({super.key});

  @override
  State<MessagingInboxScreen> createState() => _MessagingInboxScreenState();
}

class _MessagingInboxScreenState extends State<MessagingInboxScreen> {
  final _searchController = TextEditingController();
  List<StaffMessageThread> _threads = [];
  List<StaffMessage> _adminMessages = [];
  bool _loading = true;
  bool _adminLoading = false;
  String? _error;
  String? _adminError;
  String? _myUid;
  StaffRole _role = StaffRole.general;
  int _unreadCount = 0;
  String _threadStatus = 'active';
  String _threadPriority = '';
  String _threadSearch = '';

  bool get _canViewAdminLog => _role.isAdminTier;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _loadData() async {
    setState(() {
      _loading = true;
      _error = null;
      _adminError = null;
    });
    try {
      final roleValue = await ApiConfig.getRole();
      final staffUid =
          await ApiConfig.getStaffUid() ?? await ApiConfig.getStaffId();
      final threadsFuture = MessagingApiService.threads(
        limit: 100,
        status: _threadStatus,
        priority: _threadPriority.isEmpty ? null : _threadPriority,
        search: _threadSearch.isEmpty ? null : _threadSearch,
      );
      final countFuture = MessagingApiService.unreadCount();

      final threads = await threadsFuture;
      final count = await countFuture;
      final parsedThreads = threads
          .whereType<Map>()
          .map((e) => StaffMessageThread.fromJson(Map<String, dynamic>.from(e)))
          .toList();

      final role = StaffRole.fromString(roleValue);
      final adminMessages = role.isAdminTier
          ? await _loadAdminMessages()
          : <StaffMessage>[];

      if (mounted) {
        final unread = _intValue(count['unread_count'] ?? count['count']);
        context.read<MessageUnreadProvider>().setUnreadCountFromServer(unread);
        setState(() {
          _role = role;
          _myUid = staffUid;
          _threads = parsedThreads;
          _adminMessages = adminMessages;
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

  Future<List<StaffMessage>> _loadAdminMessages() async {
    setState(() => _adminLoading = true);
    try {
      final raw = await MessagingApiService.adminLog(limit: 100);
      final list =
          raw['data'] as List? ??
          raw['messages'] as List? ??
          raw['items'] as List? ??
          [];
      final parsed = list
          .whereType<Map>()
          .map((e) => StaffMessage.fromJson(Map<String, dynamic>.from(e)))
          .toList();
      if (mounted) {
        setState(() {
          _adminLoading = false;
          _adminError = null;
        });
      }
      return parsed;
    } catch (e) {
      if (mounted) {
        setState(() {
          _adminLoading = false;
          _adminError = e.toString();
        });
      }
      return [];
    }
  }

  Color _priorityColor(String priority) {
    return switch (priority.toLowerCase()) {
      'critical' => AppTheme.errorRed,
      'urgent' => AppTheme.warningAmber,
      _ => AppTheme.primaryBlue,
    };
  }

  String _formatTime(DateTime dt) {
    final s = AppStrings.of(context);
    final now = DateTime.now();
    final diff = now.difference(dt);
    if (diff.inMinutes < 1) return s.timeJustNow;
    if (diff.inMinutes < 60) {
      return '${diff.inMinutes}${s.timeMinutesAgoSuffix}';
    }
    if (diff.inHours < 24) return '${diff.inHours}${s.timeHoursAgoSuffix}';
    if (diff.inDays == 1) return s.timeYesterday;
    if (diff.inDays < 7) return DateFormat('EEE').format(dt);
    return DateFormat('dd MMM').format(dt);
  }

  Future<void> _openComposeSheet() async {
    final sent = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => const _ComposeMessageSheet(),
    );
    if (sent == true && mounted) {
      await _loadData();
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final body = _canViewAdminLog
        ? DefaultTabController(
            length: 2,
            child: Column(
              children: [
                TabBar(
                  tabs: [
                    Tab(text: s.messagingInboxTitle),
                    const Tab(text: 'Admin log'),
                  ],
                ),
                Expanded(
                  child: TabBarView(children: [_buildBody(), _buildAdminLog()]),
                ),
              ],
            ),
          )
        : _buildBody();

    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Row(
          children: [
            Text(s.messagingInboxTitle),
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
            tooltip: s.actionRefresh,
          ),
          const LogoutAction(),
        ],
      ),
      body: body,
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _openComposeSheet,
        icon: const Icon(Icons.edit),
        label: Text(s.messagingNewMessage),
        backgroundColor: AppTheme.primaryBlue,
        foregroundColor: Colors.white,
      ),
    );
  }

  Widget _buildBody() {
    final s = AppStrings.of(context);
    if (_loading) return const SkeletonList();

    if (_error != null) {
      return ErrorState(
        message: _error!.replaceFirst('Exception: ', ''),
        onRetry: _loadData,
      );
    }

    final threads = _threads;
    return RefreshIndicator(
      onRefresh: _loadData,
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: threads.isEmpty ? 2 : threads.length + 1,
        separatorBuilder: (_, _) => const Divider(height: 1, indent: 72),
        itemBuilder: (context, index) {
          if (index == 0) return _buildThreadFilters();
          if (threads.isEmpty) {
            return SizedBox(
              height: 320,
              child: EmptyState(
                icon: Icons.forum_outlined,
                title: s.messagingEmpty,
                body:
                    'Start a direct staff message or use a team announcement.',
              ),
            );
          }
          return _buildThreadTile(threads[index - 1]);
        },
      ),
    );
  }

  Widget _buildThreadFilters() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
      child: Column(
        children: [
          TextField(
            controller: _searchController,
            decoration: InputDecoration(
              labelText: 'Search conversations',
              prefixIcon: const Icon(Icons.search),
              suffixIcon: _threadSearch.isEmpty
                  ? null
                  : IconButton(
                      icon: const Icon(Icons.close),
                      onPressed: () {
                        _searchController.clear();
                        setState(() => _threadSearch = '');
                        _loadData();
                      },
                    ),
            ),
            onSubmitted: (value) {
              setState(() => _threadSearch = value.trim());
              _loadData();
            },
          ),
          const SizedBox(height: 8),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _FilterPill(
                  label: 'Active',
                  selected: _threadStatus == 'active',
                  onTap: () => _setStatusFilter('active'),
                ),
                _FilterPill(
                  label: 'Archived',
                  selected: _threadStatus == 'archived',
                  onTap: () => _setStatusFilter('archived'),
                ),
                _FilterPill(
                  label: 'All',
                  selected: _threadStatus == 'all',
                  onTap: () => _setStatusFilter('all'),
                ),
                const SizedBox(width: 8),
                _FilterPill(
                  label: 'Any priority',
                  selected: _threadPriority.isEmpty,
                  onTap: () => _setPriorityFilter(''),
                ),
                _FilterPill(
                  label: 'Urgent',
                  selected: _threadPriority == 'urgent',
                  onTap: () => _setPriorityFilter('urgent'),
                ),
                _FilterPill(
                  label: 'Critical',
                  selected: _threadPriority == 'critical',
                  onTap: () => _setPriorityFilter('critical'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  void _setStatusFilter(String value) {
    setState(() => _threadStatus = value);
    _loadData();
  }

  void _setPriorityFilter(String value) {
    setState(() => _threadPriority = value);
    _loadData();
  }

  Widget _buildThreadTile(StaffMessageThread thread) {
    final msg = thread.latestMessage;
    final hasUnread = thread.hasUnread;
    final priorityColor = _priorityColor(thread.priority);
    final sentByMe = msg.sentBy(_myUid);

    return InkWell(
      onTap: () {
        context.push(
          '/messaging/thread/${thread.partnerUid}',
          extra: {
            'threadId': thread.threadId,
            'otherStaffName': thread.partnerName,
            'otherStaffDepartment': thread.partnerDepartment,
            'patientName': thread.patientName,
            'patientUid': thread.patientUid,
            'admissionId': thread.admissionId?.toString(),
          },
        );
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Stack(
              children: [
                CircleAvatar(
                  radius: 24,
                  backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.1),
                  child: Text(
                    thread.partnerName.isNotEmpty
                        ? thread.partnerName[0].toUpperCase()
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
                          thread.unreadCount > 9
                              ? '9+'
                              : '${thread.unreadCount}',
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
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          thread.partnerName,
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
                      if (thread.isMuted || thread.urgentOnly) ...[
                        Icon(
                          thread.urgentOnly
                              ? Icons.notification_important_outlined
                              : Icons.notifications_off_outlined,
                          size: 14,
                          color: Theme.of(context).colorScheme.outline,
                        ),
                        const SizedBox(width: 4),
                      ],
                      Text(
                        _formatTime(thread.lastMessageAt),
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
                      if (msg.shouldShowReceiptFor(_myUid)) ...[
                        const SizedBox(width: 4),
                        _MessageReceiptIcon(message: msg),
                      ],
                    ],
                  ),
                  if (thread.partnerDepartment.isNotEmpty)
                    Text(
                      thread.partnerDepartment,
                      style: TextStyle(
                        fontSize: 11,
                        color: Theme.of(context).colorScheme.outline,
                      ),
                    ),
                  if (thread.contextLabel.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: _ContextChip(label: thread.contextLabel),
                    ),
                  if (thread.subject != null && thread.subject!.isNotEmpty)
                    Text(
                      thread.subject!,
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
                      if (sentByMe) ...[
                        Icon(
                          Icons.call_made,
                          size: 13,
                          color: Theme.of(context).colorScheme.outline,
                        ),
                        const SizedBox(width: 4),
                      ],
                      if (thread.priority != 'normal') ...[
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 1,
                          ),
                          decoration: BoxDecoration(
                            color: priorityColor.withValues(alpha: 0.1),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(
                            thread.priority.toUpperCase(),
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
                          thread.body.isEmpty ? 'No message text' : thread.body,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 13,
                            color: hasUnread
                                ? Theme.of(context).colorScheme.onSurface
                                : Theme.of(
                                    context,
                                  ).colorScheme.onSurfaceVariant,
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
            PopupMenuButton<String>(
              tooltip: 'Conversation actions',
              onSelected: (action) => _handleThreadAction(thread, action),
              itemBuilder: (_) => [
                if (thread.archived)
                  const PopupMenuItem(
                    value: 'unarchive',
                    child: Text('Restore'),
                  )
                else
                  const PopupMenuItem(value: 'archive', child: Text('Archive')),
                const PopupMenuItem(
                  value: 'mark-unread',
                  child: Text('Mark unread'),
                ),
                if (thread.isMuted || thread.urgentOnly)
                  const PopupMenuItem(
                    value: 'unmute',
                    child: Text('Restore alerts'),
                  )
                else ...[
                  const PopupMenuItem(value: 'mute', child: Text('Mute 8h')),
                  const PopupMenuItem(
                    value: 'urgent-only',
                    child: Text('Urgent only'),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _handleThreadAction(
    StaffMessageThread thread,
    String action,
  ) async {
    try {
      switch (action) {
        case 'archive':
          await MessagingApiService.archiveThread(thread.threadId);
          break;
        case 'unarchive':
          await MessagingApiService.unarchiveThread(thread.threadId);
          break;
        case 'mark-unread':
          await MessagingApiService.markThreadUnread(thread.threadId);
          break;
        case 'mute':
          await MessagingApiService.muteThread(thread.threadId);
          break;
        case 'urgent-only':
          await MessagingApiService.urgentOnlyThread(thread.threadId);
          break;
        case 'unmute':
          await MessagingApiService.unmuteThread(thread.threadId);
          break;
      }
      if (mounted) {
        await context.read<MessageUnreadProvider>().refresh();
        await _loadData();
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

  Widget _buildAdminLog() {
    if (_adminLoading) return const SkeletonList();
    if (_adminError != null) {
      return ErrorState(
        message: _adminError!.replaceFirst('Exception: ', ''),
        onRetry: () async {
          final rows = await _loadAdminMessages();
          if (mounted) setState(() => _adminMessages = rows);
        },
      );
    }
    if (_adminMessages.isEmpty) {
      return const EmptyState(
        icon: Icons.manage_search_outlined,
        title: 'No staff messages logged',
        body:
            'All staff messages will appear here for Admin/SuperAdmin review.',
      );
    }
    return RefreshIndicator(
      onRefresh: () async {
        final rows = await _loadAdminMessages();
        if (mounted) setState(() => _adminMessages = rows);
      },
      child: ListView.separated(
        padding: const EdgeInsets.all(12),
        itemCount: _adminMessages.length,
        separatorBuilder: (_, _) => const SizedBox(height: 8),
        itemBuilder: (context, index) {
          final msg = _adminMessages[index];
          return Card(
            child: ListTile(
              leading: Icon(
                Icons.forum_outlined,
                color: _priorityColor(msg.priority),
              ),
              title: Text(
                '${msg.senderName ?? msg.senderUid} -> ${msg.recipientName ?? msg.recipientUid}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (msg.subject != null && msg.subject!.isNotEmpty)
                    Text(
                      msg.subject!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  Text(msg.body, maxLines: 2, overflow: TextOverflow.ellipsis),
                  Text(
                    '${DateFormat('dd/MM HH:mm').format(msg.createdAt)} - ${msg.priority.toUpperCase()}',
                    style: TextStyle(
                      fontSize: 11,
                      color: Theme.of(context).colorScheme.outline,
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

class _ComposeMessageSheet extends StatefulWidget {
  const _ComposeMessageSheet();

  @override
  State<_ComposeMessageSheet> createState() => _ComposeMessageSheetState();
}

class _ComposeMessageSheetState extends State<_ComposeMessageSheet> {
  final _subjectController = TextEditingController();
  final _bodyController = TextEditingController();
  final _searchController = TextEditingController();
  List<MessageTarget> _targets = [];
  List<String> _departments = [];
  Map<String, dynamic> _viewer = {};
  Set<String> _selected = {};
  String _mode = 'direct';
  String _priority = 'normal';
  String? _department;
  bool _loading = true;
  bool _sending = false;
  String? _error;
  String _search = '';

  @override
  void initState() {
    super.initState();
    _loadTargets();
  }

  @override
  void dispose() {
    _subjectController.dispose();
    _bodyController.dispose();
    _searchController.dispose();
    super.dispose();
  }

  bool get _canAll => _viewer['can_send_all'] == true;
  bool get _canSelected => _viewer['can_send_selected'] == true;
  bool get _canDepartment => _viewer['can_send_department'] == true;
  String get _viewerDepartment => _optionalText(_viewer['department']) ?? '';

  Future<void> _loadTargets() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await MessagingApiService.targets();
      final staff = result['staff'] as List? ?? [];
      final departments = result['departments'] as List? ?? [];
      final viewer = result['viewer'] as Map? ?? {};
      final parsed = staff
          .whereType<Map>()
          .map((e) => MessageTarget.fromJson(Map<String, dynamic>.from(e)))
          .where((target) => target.uid.isNotEmpty)
          .toList();
      if (mounted) {
        setState(() {
          _targets = parsed;
          _departments = departments.map((e) => e.toString()).toList();
          _viewer = Map<String, dynamic>.from(viewer);
          _department = _viewerDepartment.isNotEmpty
              ? _viewerDepartment
              : (_departments.isNotEmpty ? _departments.first : null);
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString().replaceFirst('Exception: ', '');
          _loading = false;
        });
      }
    }
  }

  List<MessageTarget> get _filteredTargets {
    final q = _search.toLowerCase();
    if (q.isEmpty) return _targets;
    return _targets.where((target) {
      return [
        target.name,
        target.role,
        target.department,
        target.employeeId,
        target.position,
      ].join(' ').toLowerCase().contains(q);
    }).toList();
  }

  void _toggleTarget(String uid) {
    setState(() {
      if (_mode == 'direct') {
        _selected = {uid};
        return;
      }
      if (_selected.contains(uid)) {
        _selected.remove(uid);
      } else {
        _selected.add(uid);
      }
    });
  }

  Future<void> _send() async {
    final body = _bodyController.text.trim();
    final subject = _subjectController.text.trim();
    if (body.isEmpty || _sending) return;

    if (_mode == 'direct' && _selected.length != 1) {
      _showError('Select one staff member.');
      return;
    }
    if (_mode == 'selected' && _selected.isEmpty) {
      _showError('Select at least one staff member.');
      return;
    }
    if (_mode == 'department' &&
        (_department == null || _department!.isEmpty)) {
      _showError('Select a department.');
      return;
    }

    setState(() => _sending = true);
    try {
      if (_mode == 'direct') {
        await MessagingApiService.sendDirect(
          recipientUid: _selected.first,
          body: body,
          subject: subject,
          priority: _priority,
        );
      } else {
        await MessagingApiService.sendBroadcast(
          scope: _mode == 'all' ? 'all' : _mode,
          department: _mode == 'department' ? _department : null,
          recipientUids: _mode == 'selected' ? _selected.toList() : const [],
          body: body,
          subject: subject,
          priority: _priority,
        );
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      _showError(e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: AppTheme.errorRed),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 12,
        bottom: 16 + MediaQuery.of(context).viewInsets.bottom,
      ),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.86,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
            ? ErrorState(message: _error!, onRetry: _loadTargets)
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.edit_note, color: AppTheme.primaryBlue),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          s.messagingNewMessage,
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.close),
                        onPressed: () => Navigator.of(context).pop(false),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _ModeChip(
                        label: 'One staff',
                        selected: _mode == 'direct',
                        onTap: () => setState(() {
                          _mode = 'direct';
                          if (_selected.length > 1) _selected = {};
                        }),
                      ),
                      if (_canSelected)
                        _ModeChip(
                          label: 'Selected team',
                          selected: _mode == 'selected',
                          onTap: () => setState(() => _mode = 'selected'),
                        ),
                      if (_canDepartment)
                        _ModeChip(
                          label: 'Department',
                          selected: _mode == 'department',
                          onTap: () => setState(() => _mode = 'department'),
                        ),
                      if (_canAll)
                        _ModeChip(
                          label: 'All staff',
                          selected: _mode == 'all',
                          onTap: () => setState(() => _mode = 'all'),
                        ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _subjectController,
                          decoration: const InputDecoration(
                            labelText: 'Subject',
                            prefixIcon: Icon(Icons.subject),
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      SizedBox(
                        width: 150,
                        child: DropdownButtonFormField<String>(
                          initialValue: _priority,
                          decoration: const InputDecoration(
                            labelText: 'Priority',
                          ),
                          items: const [
                            DropdownMenuItem(
                              value: 'normal',
                              child: Text('Normal'),
                            ),
                            DropdownMenuItem(
                              value: 'urgent',
                              child: Text('Urgent'),
                            ),
                            DropdownMenuItem(
                              value: 'critical',
                              child: Text('Critical'),
                            ),
                          ],
                          onChanged: (value) =>
                              setState(() => _priority = value ?? 'normal'),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _bodyController,
                    minLines: 3,
                    maxLines: 5,
                    decoration: InputDecoration(
                      labelText: s.messagingTypeHint,
                      alignLabelWithHint: true,
                      prefixIcon: const Padding(
                        padding: EdgeInsets.only(bottom: 58),
                        child: Icon(Icons.message_outlined),
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (_mode == 'department')
                    DropdownButtonFormField<String>(
                      initialValue: _department,
                      decoration: const InputDecoration(
                        labelText: 'Department',
                        prefixIcon: Icon(Icons.groups_outlined),
                      ),
                      items: (_canAll ? _departments : [_viewerDepartment])
                          .where((d) => d.isNotEmpty)
                          .map(
                            (department) => DropdownMenuItem(
                              value: department,
                              child: Text(department),
                            ),
                          )
                          .toList(),
                      onChanged: _canAll
                          ? (value) => setState(() => _department = value)
                          : null,
                    )
                  else if (_mode != 'all') ...[
                    TextField(
                      controller: _searchController,
                      decoration: const InputDecoration(
                        labelText: 'Search staff',
                        prefixIcon: Icon(Icons.search),
                      ),
                      onChanged: (value) => setState(() => _search = value),
                    ),
                    const SizedBox(height: 8),
                    Expanded(
                      child: _filteredTargets.isEmpty
                          ? const Center(child: Text('No matching staff'))
                          : ListView.builder(
                              itemCount: _filteredTargets.length,
                              itemBuilder: (context, index) {
                                final target = _filteredTargets[index];
                                final selected = _selected.contains(target.uid);
                                return CheckboxListTile(
                                  value: selected,
                                  onChanged: (_) => _toggleTarget(target.uid),
                                  title: Text(target.name),
                                  subtitle: Text(target.subtitle),
                                  secondary: CircleAvatar(
                                    child: Text(
                                      target.name.isNotEmpty
                                          ? target.name[0].toUpperCase()
                                          : '?',
                                    ),
                                  ),
                                );
                              },
                            ),
                    ),
                  ] else
                    Expanded(
                      child: Center(
                        child: Text(
                          'This will send one saved message to every active staff member.',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.outline,
                          ),
                        ),
                      ),
                    ),
                  if (_mode == 'department') const Spacer(),
                  FilledButton.icon(
                    onPressed: _sending ? null : _send,
                    icon: _sending
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.send),
                    label: Text(_sending ? 'Sending...' : s.messagingSend),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(48),
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}

class _ModeChip extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _ModeChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return FilterChip(
      selected: selected,
      label: Text(label),
      onSelected: (_) => onTap(),
      selectedColor: AppTheme.primaryBlue.withValues(alpha: 0.18),
      checkmarkColor: AppTheme.primaryBlue,
    );
  }
}

class _FilterPill extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _FilterPill({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: FilterChip(
        selected: selected,
        label: Text(label),
        onSelected: (_) => onTap(),
        selectedColor: AppTheme.primaryBlue.withValues(alpha: 0.18),
        checkmarkColor: AppTheme.primaryBlue,
      ),
    );
  }
}

class _ContextChip extends StatelessWidget {
  final String label;

  const _ContextChip({required this.label});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 2),
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: Colors.teal.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(
          fontSize: 10,
          color: Colors.teal,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

bool _isReceiptSuppressedRole(String? role) {
  final normalized = _text(role).toUpperCase();
  return const {
    'ADMIN',
    'SUPER_ADMIN',
    'CEO',
    'COO',
    'CHIEF_EXECUTIVE',
    'CHIEF_EXECUTIVE_OFFICER',
  }.contains(normalized);
}

class _MessageReceiptIcon extends StatelessWidget {
  final StaffMessage message;

  const _MessageReceiptIcon({required this.message});

  @override
  Widget build(BuildContext context) {
    final read = message.isRead;
    return Tooltip(
      message: read ? 'Read' : 'Delivered',
      child: Icon(
        read ? Icons.done_all : Icons.done,
        size: 14,
        color: read
            ? AppTheme.accentCyan
            : Theme.of(context).colorScheme.outline,
      ),
    );
  }
}

String _text(Object? value) => value?.toString().trim() ?? '';

String? _optionalText(Object? value) {
  final text = _text(value);
  return text.isEmpty ? null : text;
}

int _intValue(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
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
