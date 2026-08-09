// lib/features/portal/screens/messages_screen.dart
//
// Patient secure-messaging inbox — Sprint 10. Hits /portal/messages.
// FAB opens the compose sheet for a new thread.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class _Thread {
  _Thread.fromJson(Map<String, dynamic> j)
    : id = j['id'] as int,
      subject = j['subject']?.toString() ?? '—',
      category = j['category']?.toString() ?? 'general',
      status = j['status']?.toString() ?? 'open',
      priority = j['priority']?.toString() ?? 'normal',
      lastMessageAt = j['last_message_at']?.toString(),
      lastMessageBy = j['last_message_by']?.toString(),
      patientUnread = (j['patient_unread_count'] as num?)?.toInt() ?? 0;

  final int id;
  final String subject;
  final String category;
  final String status;
  final String priority;
  final String? lastMessageAt;
  final String? lastMessageBy;
  final int patientUnread;
}

String _categoryLabel(AppLocalizations l, String category) {
  switch (category) {
    case 'appointment':
      return l.messagesCategoryAppointment;
    case 'prescription':
      return l.messagesCategoryPrescription;
    case 'lab_result':
      return l.messagesCategoryLabResult;
    case 'billing':
      return l.messagesCategoryBilling;
    case 'discharge':
      return l.messagesCategoryDischarge;
    case 'other':
      return l.messagesCategoryOther;
    case 'general':
    default:
      return l.messagesCategoryGeneral;
  }
}

const _composeCategories = <String>[
  'general',
  'appointment',
  'prescription',
  'lab_result',
  'billing',
  'discharge',
  'other',
];

class MessagesScreen extends StatefulWidget {
  const MessagesScreen({super.key});

  @override
  State<MessagesScreen> createState() => _MessagesScreenState();
}

class _MessagesScreenState extends State<MessagesScreen> {
  bool _loading = true;
  String? _error;
  List<_Thread> _threads = [];

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get('/portal/messages');
      if (!mounted) return;
      if (response.isSuccess) {
        final list = response.dataAsList();
        setState(() {
          _threads = list
              .whereType<Map<String, dynamic>>()
              .map(_Thread.fromJson)
              .toList();
          _loading = false;
        });
      } else {
        final l = AppLocalizations.of(context)!;
        setState(() {
          _error = response.failureMessage(l.messagesLoadFailed);
          _loading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _openCompose() async {
    final result = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _ComposeSheet(),
    );
    if (result == true && mounted) {
      unawaited(_fetch());
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: l.messagesTitle,
      icon: Icons.forum,
      color: colors.tertiary,
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _openCompose,
        icon: const Icon(Icons.edit),
        label: Text(l.messagesNewMessage),
      ),
      child: RefreshIndicator(
        onRefresh: _fetch,
        child: DataStateBuilder<_Thread>(
          isLoading: _loading,
          error: _error,
          data: _threads,
          onRetry: _fetch,
          emptyIcon: Icons.forum_outlined,
          emptyTitle: l.messagesEmptyTitle,
          emptySubtitle: l.messagesEmptySubtitle,
          builder: (context, threads) {
            return ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: threads.length,
              separatorBuilder: (_, _) => const SizedBox(height: 8),
              itemBuilder: (_, i) => _ThreadCard(thread: threads[i], l: l),
            );
          },
        ),
      ),
    );
  }
}

class _ThreadCard extends StatelessWidget {
  const _ThreadCard({required this.thread, required this.l});
  final _Thread thread;
  final AppLocalizations l;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final unread = thread.patientUnread > 0;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => context.push('/portal/messages/${thread.id}'),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              if (unread)
                Container(
                  width: 8,
                  height: 8,
                  margin: const EdgeInsets.only(right: 10),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.primary,
                    shape: BoxShape.circle,
                  ),
                ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      thread.subject,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: unread ? FontWeight.w700 : FontWeight.w500,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Text(
                          _categoryLabel(l, thread.category),
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.outline,
                          ),
                        ),
                        Text(
                          ' · ${thread.status}',
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.outline,
                          ),
                        ),
                        if (thread.priority == 'urgent') ...[
                          const SizedBox(width: 6),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 1,
                            ),
                            decoration: BoxDecoration(
                              color: theme.colorScheme.errorContainer,
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              l.messagesUrgent,
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: theme.colorScheme.onErrorContainer,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
              if (thread.lastMessageAt != null)
                Text(
                  _fmtRelative(thread.lastMessageAt!),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.outline,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  String _fmtRelative(String iso) {
    final d = DateTime.tryParse(iso);
    if (d == null) return '';
    final diff = DateTime.now().difference(d);
    if (diff.inMinutes < 1) return 'now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m';
    if (diff.inHours < 24) return '${diff.inHours}h';
    return '${diff.inDays}d';
  }
}

class _ComposeSheet extends StatefulWidget {
  const _ComposeSheet();

  @override
  State<_ComposeSheet> createState() => _ComposeSheetState();
}

class _ComposeSheetState extends State<_ComposeSheet> {
  final _subjectController = TextEditingController();
  final _bodyController = TextEditingController();
  String _category = 'general';
  bool _sending = false;
  String? _error;

  @override
  void dispose() {
    _subjectController.dispose();
    _bodyController.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final l = AppLocalizations.of(context)!;
    if (_subjectController.text.trim().isEmpty ||
        _bodyController.text.trim().isEmpty) {
      setState(() {
        _error = l.messagesSubjectBodyRequired;
      });
      return;
    }
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      final response = await ApiClient.post(
        '/portal/messages',
        body: {
          'subject': _subjectController.text.trim(),
          'category': _category,
          'body': _bodyController.text.trim(),
        },
      );
      if (!mounted) return;
      if (response.isSuccess) {
        Navigator.of(context).pop(true);
      } else {
        setState(() {
          _sending = false;
          _error = response.failureMessage(l.messagesSendFailed);
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _sending = false;
        _error = l.messagesSendFailed;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;
    final inset = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: inset),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.outlineVariant,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Text(l.messagesNewMessage, style: theme.textTheme.titleLarge),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: _category,
                decoration: InputDecoration(
                  labelText: l.messagesCategoryLabel,
                  border: OutlineInputBorder(),
                ),
                items: _composeCategories
                    .map(
                      (category) => DropdownMenuItem(
                        value: category,
                        child: Text(_categoryLabel(l, category)),
                      ),
                    )
                    .toList(),
                onChanged: (v) => setState(() => _category = v ?? 'general'),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _subjectController,
                decoration: InputDecoration(
                  labelText: l.messagesSubjectLabel,
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _bodyController,
                decoration: InputDecoration(
                  labelText: l.messagesBodyLabel,
                  border: OutlineInputBorder(),
                  alignLabelWithHint: true,
                ),
                maxLines: 5,
              ),
              if (_error != null) ...[
                const SizedBox(height: 8),
                Text(
                  _error!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.error,
                  ),
                ),
              ],
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: _sending ? null : _send,
                icon: _sending
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.send),
                label: Text(
                  _sending ? l.messagesSending : l.messagesSendButton,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
