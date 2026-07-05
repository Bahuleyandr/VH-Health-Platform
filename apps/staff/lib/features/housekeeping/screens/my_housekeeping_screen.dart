import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';

import '../../../core/services/hr_api_service.dart';
import '../../../core/services/staff_evidence_upload_service.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';

class MyHousekeepingScreen extends StatefulWidget {
  const MyHousekeepingScreen({super.key});

  @override
  State<MyHousekeepingScreen> createState() => _MyHousekeepingScreenState();
}

class _MyHousekeepingScreenState extends State<MyHousekeepingScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  List<dynamic> _logs = [];
  List<dynamic> _raisedRequests = [];
  List<dynamic> _assignedRequests = [];
  bool _loadingLogs = false;
  bool _loadingRequests = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadLogs();
    _loadRequests();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadLogs() async {
    setState(() => _loadingLogs = true);
    try {
      final logs = await HrApiService.getMyCleaningLogs();
      if (mounted) setState(() => _logs = logs);
    } catch (e) {
      debugPrint('my_housekeeping_screen.dart: $e');
    } finally {
      if (mounted) setState(() => _loadingLogs = false);
    }
  }

  Future<void> _loadRequests() async {
    setState(() => _loadingRequests = true);
    try {
      final data = await HrApiService.getMyHousekeepingRequests();
      if (mounted) {
        setState(() {
          _raisedRequests = data['raised'] as List? ?? [];
          _assignedRequests = data['assigned'] as List? ?? [];
        });
      }
    } catch (e) {
      debugPrint('my_housekeeping_screen.dart: $e');
    } finally {
      if (mounted) setState(() => _loadingRequests = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.housekeepingMyTitle),
        actions: const [LogoutAction()],
        backgroundColor: const Color(0xFF007A64),
        foregroundColor: Colors.white,
        bottom: TabBar(
          controller: _tabController,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white70,
          indicatorColor: Colors.white,
          tabs: [
            Tab(text: '${s.housekeepingMyTabLogs} (${_logs.length})'),
            Tab(
              text:
                  '${s.housekeepingMyTabRequests} (${_raisedRequests.length + _assignedRequests.length})',
            ),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _LogsTab(logs: _logs, loading: _loadingLogs, onRefresh: _loadLogs),
          _RequestsTab(
            raised: _raisedRequests,
            assigned: _assignedRequests,
            loading: _loadingRequests,
            onRefresh: _loadRequests,
            onCompleted: _loadRequests,
          ),
        ],
      ),
    );
  }
}

String _cleaningTypeLabel(AppStrings s, String value) => switch (value) {
  'deep' => s.housekeepingTypeDeep,
  'disinfection' => s.housekeepingTypeDisinfection,
  'spillage' => s.housekeepingTypeSpillage,
  'post_procedure' => s.housekeepingTypePostProcedure,
  _ => s.housekeepingTypeRoutine,
};

String _requestStatusLabel(AppStrings s, String value) => switch (value) {
  'assigned' => s.lookup('s4.lib.housekeeping_task.status.assigned'),
  'completed' => s.lookup('s4.lib.housekeeping_task.status.completed'),
  'verified' => s.lookup('s4.lib.housekeeping_task.status.verified'),
  'closed' => s.lookup('s4.lib.housekeeping_task.status.closed'),
  'in_progress' => s.lookup('s4.lib.housekeeping_task.status.in_progress'),
  _ => s.lookup('s4.lib.housekeeping_task.status.open'),
};

String _urgencyLabel(AppStrings s, String value) => switch (value) {
  'urgent' => s.priorityUrgent,
  'high' => s.urgencyHigh,
  'low' => s.urgencyLow,
  _ => s.urgencyNormal,
};

// ─── Logs Tab ─────────────────────────────────────────────────────────────────

class _LogsTab extends StatelessWidget {
  final List<dynamic> logs;
  final bool loading;
  final VoidCallback onRefresh;

  const _LogsTab({
    required this.logs,
    required this.loading,
    required this.onRefresh,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (loading) {
      return const SkeletonList();
    }
    if (logs.isEmpty) {
      return RefreshIndicator(
        onRefresh: () async => onRefresh(),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            SizedBox(
              height: MediaQuery.sizeOf(context).height * 0.55,
              child: EmptyState(
                icon: Icons.cleaning_services_outlined,
                title: s.housekeepingNoLogs,
              ),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: () async => onRefresh(),
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: logs.length,
        itemBuilder: (_, i) => _LogCard(log: logs[i] as Map<String, dynamic>),
      ),
    );
  }
}

class _LogCard extends StatelessWidget {
  final Map<String, dynamic> log;

  const _LogCard({required this.log});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final status = log['status'] as String? ?? 'submitted';
    final statusStyle = switch (status) {
      'verified' => (color: Colors.green, label: s.housekeepingStatusVerified),
      'flagged' => (color: Colors.red, label: s.housekeepingStatusFlagged),
      _ => (color: Colors.grey, label: s.housekeepingStatusSubmitted),
    };
    final loggedAt = log['logged_at'] != null
        ? DateFormat(
            'dd MMM, HH:mm',
          ).format(DateTime.parse(log['logged_at'] as String).toLocal())
        : '';

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: const Color(0xFF007A64).withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Icon(
                Icons.cleaning_services_outlined,
                color: Color(0xFF007A64),
                size: 22,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        log['log_number'] as String? ?? '',
                        style: const TextStyle(
                          fontWeight: FontWeight.bold,
                          fontSize: 13,
                        ),
                      ),
                      const Spacer(),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 7,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: statusStyle.color.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          statusStyle.label,
                          style: TextStyle(
                            color: statusStyle.color,
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text(
                    log['zone_name'] as String? ??
                        log['location_text'] as String? ??
                        s.housekeepingUnknownLocation,
                    style: const TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      Text(
                        _cleaningTypeLabel(
                          s,
                          log['cleaning_type'] as String? ?? 'routine',
                        ),
                        style: const TextStyle(
                          fontSize: 11,
                          color: Color(0xFF007A64),
                        ),
                      ),
                      const Spacer(),
                      Text(
                        loggedAt,
                        style: const TextStyle(
                          fontSize: 11,
                          color: Colors.grey,
                        ),
                      ),
                    ],
                  ),
                  if (status == 'flagged' && log['flag_reason'] != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      '⚠️ ${log['flag_reason']}',
                      style: const TextStyle(fontSize: 11, color: Colors.red),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ─── Requests Tab ─────────────────────────────────────────────────────────────

class _RequestsTab extends StatefulWidget {
  final List<dynamic> raised;
  final List<dynamic> assigned;
  final bool loading;
  final VoidCallback onRefresh;
  final VoidCallback onCompleted;

  const _RequestsTab({
    required this.raised,
    required this.assigned,
    required this.loading,
    required this.onRefresh,
    required this.onCompleted,
  });

  @override
  State<_RequestsTab> createState() => _RequestsTabState();
}

class _RequestsTabState extends State<_RequestsTab>
    with SingleTickerProviderStateMixin {
  late TabController _subTab;

  @override
  void initState() {
    super.initState();
    _subTab = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _subTab.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (widget.loading) {
      return const SkeletonList();
    }
    return Column(
      children: [
        Container(
          color: Colors.white,
          child: TabBar(
            controller: _subTab,
            labelColor: const Color(0xFF007A64),
            unselectedLabelColor: Colors.grey,
            indicatorColor: const Color(0xFF007A64),
            tabs: [
              Tab(
                text: '${s.housekeepingMyTabRaised} (${widget.raised.length})',
              ),
              Tab(
                text:
                    '${s.housekeepingMyTabAssigned} (${widget.assigned.length})',
              ),
            ],
          ),
        ),
        Expanded(
          child: TabBarView(
            controller: _subTab,
            children: [
              _RequestList(
                requests: widget.raised,
                showComplete: false,
                onRefresh: widget.onRefresh,
                onCompleted: widget.onCompleted,
              ),
              _RequestList(
                requests: widget.assigned,
                showComplete: true,
                onRefresh: widget.onRefresh,
                onCompleted: widget.onCompleted,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _RequestList extends StatelessWidget {
  final List<dynamic> requests;
  final bool showComplete;
  final VoidCallback onRefresh;
  final VoidCallback onCompleted;

  const _RequestList({
    required this.requests,
    required this.showComplete,
    required this.onRefresh,
    required this.onCompleted,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (requests.isEmpty) {
      return RefreshIndicator(
        onRefresh: () async => onRefresh(),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            SizedBox(
              height: MediaQuery.sizeOf(context).height * 0.5,
              child: EmptyState(
                icon: Icons.inbox_outlined,
                title: s.housekeepingNoRequests,
              ),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: () async => onRefresh(),
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: requests.length,
        itemBuilder: (_, i) => _RequestCard(
          req: requests[i] as Map<String, dynamic>,
          showComplete: showComplete,
          onCompleted: onCompleted,
        ),
      ),
    );
  }
}

class _RequestCard extends StatelessWidget {
  final Map<String, dynamic> req;
  final bool showComplete;
  final VoidCallback onCompleted;

  const _RequestCard({
    required this.req,
    required this.showComplete,
    required this.onCompleted,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final urgency = req['urgency'] as String? ?? 'normal';
    final urgencyColor = switch (urgency) {
      'urgent' => Colors.red,
      'high' => Colors.orange,
      'low' => Colors.green,
      _ => Colors.grey,
    };
    final urgencyLabel = _urgencyLabel(s, urgency);
    final status = req['status'] as String? ?? 'open';
    final statusLabel = _requestStatusLabel(s, status);
    final createdAt = req['created_at'] != null
        ? DateFormat(
            'dd MMM, HH:mm',
          ).format(DateTime.parse(req['created_at'] as String).toLocal())
        : '';

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 7,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: urgencyColor.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: urgencyColor.withValues(alpha: 0.3),
                    ),
                  ),
                  child: Text(
                    urgencyLabel.toUpperCase(),
                    style: TextStyle(
                      color: urgencyColor,
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  req['request_number'] as String? ?? '',
                  style: const TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 13,
                  ),
                ),
                const Spacer(),
                Text(
                  createdAt,
                  style: const TextStyle(fontSize: 11, color: Colors.grey),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              req['zone_name'] as String? ??
                  req['location_text'] as String? ??
                  '',
              style: const TextStyle(fontSize: 13),
            ),
            if (req['description'] != null) ...[
              const SizedBox(height: 4),
              Text(
                req['description'] as String,
                style: const TextStyle(fontSize: 12, color: Colors.grey),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ],
            const SizedBox(height: 8),
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 7,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: Colors.blue.shade50,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    statusLabel.toUpperCase(),
                    style: TextStyle(
                      color: Colors.blue.shade700,
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                const Spacer(),
                if (showComplete && status == 'assigned')
                  ElevatedButton(
                    onPressed: () =>
                        _showCompleteDialog(context, req['id'].toString()),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF007A64),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 6,
                      ),
                      minimumSize: Size.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                    child: Text(
                      AppStrings.of(context).housekeepingMarkComplete,
                      style: const TextStyle(
                        fontSize: 12,
                        color: Colors.white,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _showCompleteDialog(BuildContext context, String requestId) {
    final s = AppStrings.of(context);
    final notesCtrl = TextEditingController();
    File? photo;
    bool submitting = false;

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(s.housekeepingCompleteDialogTitle),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                TextField(
                  controller: notesCtrl,
                  decoration: InputDecoration(
                    labelText: s.housekeepingCompletionNotes,
                    border: const OutlineInputBorder(),
                  ),
                  maxLines: 3,
                ),
                const SizedBox(height: 12),
                InkWell(
                  onTap: () async {
                    final picker = ImagePicker();
                    final img = await picker.pickImage(
                      source: ImageSource.camera,
                      imageQuality: 70,
                    );
                    if (img != null) {
                      setDialogState(() => photo = File(img.path));
                    }
                  },
                  child: Container(
                    width: double.infinity,
                    height: photo != null ? 160 : 72,
                    decoration: BoxDecoration(
                      border: Border.all(color: Colors.grey.shade400),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: photo != null
                        ? ClipRRect(
                            borderRadius: BorderRadius.circular(8),
                            child: Image.file(
                              photo!,
                              fit: BoxFit.cover,
                              width: double.infinity,
                            ),
                          )
                        : Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              const Icon(
                                Icons.camera_alt_outlined,
                                color: Colors.grey,
                              ),
                              Text(
                                s.housekeepingAddCompletionPhoto,
                                style: const TextStyle(
                                  fontSize: 12,
                                  color: Colors.grey,
                                ),
                              ),
                            ],
                          ),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text(s.actionCancel),
            ),
            ElevatedButton(
              onPressed: submitting
                  ? null
                  : () async {
                      setDialogState(() => submitting = true);
                      try {
                        final evidence = photo == null
                            ? null
                            : await StaffEvidenceUploadService.upload(photo!);
                        await HrApiService.completeHousekeepingRequest(
                          requestId: requestId,
                          completionNotes: notesCtrl.text.trim().isNotEmpty
                              ? notesCtrl.text.trim()
                              : null,
                          photoKey: evidence?.storageKey,
                          photoUrl: evidence?.storageUrl,
                        );
                        if (ctx.mounted) {
                          Navigator.pop(ctx);
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(s.housekeepingMarkedComplete),
                              backgroundColor: const Color(0xFF007A64),
                            ),
                          );
                          onCompleted();
                        }
                      } catch (e) {
                        if (ctx.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(
                                e.toString().replaceFirst('Exception: ', ''),
                              ),
                              backgroundColor: Colors.red,
                            ),
                          );
                        }
                      } finally {
                        if (ctx.mounted) {
                          setDialogState(() => submitting = false);
                        }
                      }
                    },
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF007A64),
              ),
              child: submitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        color: Colors.white,
                        strokeWidth: 2,
                      ),
                    )
                  : Text(
                      s.actionSubmit,
                      style: const TextStyle(color: Colors.white),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
