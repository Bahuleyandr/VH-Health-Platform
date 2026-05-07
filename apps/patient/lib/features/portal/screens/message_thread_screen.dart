// lib/features/portal/screens/message_thread_screen.dart
//
// Single thread view — chat-style with reply composer at the bottom.
// Marks the thread read on view. Auto-refreshes every 30s while open.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

class _Message {
  _Message.fromJson(Map<String, dynamic> j)
    : id = j['id'] as int,
      senderKind = j['sender_kind']?.toString() ?? 'system',
      senderName = j['sender_name']?.toString(),
      body = j['body']?.toString() ?? '',
      createdAt = j['created_at']?.toString() ?? '';

  final int id;
  final String senderKind;
  final String? senderName;
  final String body;
  final String createdAt;

  bool get isFromPatient => senderKind == 'patient';
  bool get isFromStaff => senderKind == 'staff';
}

class _Thread {
  _Thread.fromJson(Map<String, dynamic> j)
    : id = j['id'] as int,
      subject = j['subject']?.toString() ?? '—',
      status = j['status']?.toString() ?? 'open';

  final int id;
  final String subject;
  final String status;
}

class MessageThreadScreen extends StatefulWidget {
  const MessageThreadScreen({super.key, required this.threadId});
  final int threadId;

  @override
  State<MessageThreadScreen> createState() => _MessageThreadScreenState();
}

class _MessageThreadScreenState extends State<MessageThreadScreen> {
  final _replyController = TextEditingController();
  final _scrollController = ScrollController();
  bool _loading = true;
  String? _error;
  _Thread? _thread;
  List<_Message> _messages = const [];
  bool _sending = false;
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    _fetch(initialLoad: true);
    _refreshTimer = Timer.periodic(
      const Duration(seconds: 30),
      (_) => _fetch(initialLoad: false),
    );
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _replyController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _fetch({required bool initialLoad}) async {
    if (initialLoad) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final response = await ApiClient.get(
        '/portal/messages/${widget.threadId}',
      );
      if (!mounted) return;
      if (response.isSuccess) {
        final data = response.dataAsMap();
        setState(() {
          _thread = data['thread'] != null
              ? _Thread.fromJson(data['thread'] as Map<String, dynamic>)
              : null;
          _messages = (data['messages'] as List? ?? [])
              .whereType<Map<String, dynamic>>()
              .map(_Message.fromJson)
              .toList();
          _loading = false;
        });
        if (initialLoad) {
          // Mark read once on open.
          unawaited(
            ApiClient.post('/portal/messages/${widget.threadId}/read'),
          );
        }
        // Scroll to bottom after frame paints.
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_scrollController.hasClients) {
            _scrollController.jumpTo(
              _scrollController.position.maxScrollExtent,
            );
          }
        });
      } else if (initialLoad) {
        setState(() {
          _error = response.message ?? 'Failed to load thread';
          _loading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      if (initialLoad) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _sendReply() async {
    final body = _replyController.text.trim();
    if (body.isEmpty) return;
    setState(() {
      _sending = true;
    });
    try {
      final response = await ApiClient.post(
        '/portal/messages/${widget.threadId}/reply',
        body: {'body': body},
      );
      if (!mounted) return;
      if (response.isSuccess) {
        _replyController.clear();
        setState(() {
          _sending = false;
        });
        await _fetch(initialLoad: false);
      } else {
        setState(() {
          _sending = false;
          _error = response.message ?? 'Send failed';
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _sending = false;
        _error = e.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return FeatureScreenScaffold(
      title: _thread?.subject ?? 'Message',
      icon: Icons.forum,
      color: const Color(0xFFFFE082),
      child: Column(
        children: [
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(
                            _error!,
                            textAlign: TextAlign.center,
                          ),
                        ),
                      )
                    : ListView.builder(
                        controller: _scrollController,
                        padding: const EdgeInsets.all(16),
                        itemCount: _messages.length,
                        itemBuilder: (_, i) =>
                            _MessageBubble(message: _messages[i]),
                      ),
          ),
          if (_thread?.status != 'closed') _buildComposer(),
        ],
      ),
    );
  }

  Widget _buildComposer() {
    final theme = Theme.of(context);
    return Container(
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        border: Border(
          top: BorderSide(color: theme.colorScheme.outlineVariant),
        ),
      ),
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: _replyController,
                decoration: const InputDecoration(
                  hintText: 'Reply…',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
                minLines: 1,
                maxLines: 4,
              ),
            ),
            const SizedBox(width: 8),
            IconButton.filled(
              onPressed: _sending ? null : _sendReply,
              icon: _sending
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send),
            ),
          ],
        ),
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message});
  final _Message message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (message.senderKind == 'system') {
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Text(
            message.body,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline,
              fontStyle: FontStyle.italic,
            ),
          ),
        ),
      );
    }
    final isPatient = message.isFromPatient;
    final colour = isPatient
        ? theme.colorScheme.primaryContainer
        : theme.colorScheme.surfaceContainerHigh;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment:
            isPatient ? MainAxisAlignment.end : MainAxisAlignment.start,
        children: [
          ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.of(context).size.width * 0.78,
            ),
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: colour,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    isPatient
                        ? 'You'
                        : (message.senderName ?? 'Hospital staff'),
                    style: theme.textTheme.labelSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                      color: theme.colorScheme.outline,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(message.body),
                  const SizedBox(height: 4),
                  Text(
                    _fmtTime(message.createdAt),
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.outline,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _fmtTime(String iso) {
    final d = DateTime.tryParse(iso);
    if (d == null) return iso;
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }
}
