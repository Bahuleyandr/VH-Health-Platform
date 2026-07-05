import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';

import '../../../core/config/role_config.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/services/staff_evidence_upload_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

class HousekeepingTasksScreen extends StatefulWidget {
  const HousekeepingTasksScreen({super.key});

  @override
  State<HousekeepingTasksScreen> createState() =>
      _HousekeepingTasksScreenState();
}

class _HousekeepingTasksScreenState extends State<HousekeepingTasksScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  List<_Task> _assignedTasks = [];
  List<_Task> _completedTasks = [];
  bool _loading = true;
  String? _error;
  String? _busyTaskId;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _loadTasks();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  List<_Task> get _pendingTasks =>
      _assignedTasks.where((task) => !task.isFinished).toList(growable: false);

  List<_Task> get _allTasks => [..._pendingTasks, ..._completedTasks];

  List<Map<String, dynamic>> _asMapList(dynamic value) {
    if (value is! List) return [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList(growable: false);
  }

  Future<void> _loadTasks({bool showSpinner = true}) async {
    if (mounted) {
      setState(() {
        if (showSpinner) _loading = true;
        _error = null;
      });
    }

    try {
      final s = AppStrings.of(context);
      final data = await HrApiService.getMyHousekeepingRequests();
      final assigned = _asMapList(
        data['assigned'],
      ).map((row) => _Task.fromJson(row, s));
      final completed = _asMapList(
        data['completed'],
      ).map((row) => _Task.fromJson(row, s));
      if (!mounted) return;
      setState(() {
        _assignedTasks = assigned.toList(growable: false);
        _completedTasks = completed.toList(growable: false);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _startTask(_Task task) async {
    setState(() => _busyTaskId = task.id);
    try {
      await HrApiService.startHousekeepingRequest(requestId: task.id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(AppStrings.of(context).housekeepingTaskStarted)),
      );
      await _loadTasks(showSpinner: false);
    } catch (e) {
      _showError(e);
    } finally {
      if (mounted) setState(() => _busyTaskId = null);
    }
  }

  Future<void> _completeTask(_Task task) async {
    final completion = await _showCompleteDialog();
    if (completion == null) return;

    setState(() => _busyTaskId = task.id);
    try {
      final evidence = completion.photo == null
          ? null
          : await StaffEvidenceUploadService.upload(completion.photo!);
      final notes = completion.notes.trim();
      await HrApiService.completeHousekeepingRequest(
        requestId: task.id,
        completionNotes: notes.isEmpty ? null : notes,
        photoKey: evidence?.storageKey,
        photoUrl: evidence?.storageUrl,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(AppStrings.of(context).housekeepingTaskCompleted),
          backgroundColor: AppTheme.successGreen,
        ),
      );
      await _loadTasks(showSpinner: false);
    } catch (e) {
      _showError(e);
    } finally {
      if (mounted) setState(() => _busyTaskId = null);
    }
  }

  Future<_CompletionEvidence?> _showCompleteDialog() async {
    final controller = TextEditingController();
    File? photo;
    try {
      return await showDialog<_CompletionEvidence>(
        context: context,
        builder: (context) => StatefulBuilder(
          builder: (context, setDialogState) => AlertDialog(
            title: Text(AppStrings.of(context).housekeepingCompleteDialogTitle),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  TextField(
                    controller: controller,
                    maxLines: 3,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(
                        context,
                      ).housekeepingCompletionNotes,
                      border: const OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 12),
                  InkWell(
                    onTap: () async {
                      final picker = ImagePicker();
                      final image = await picker.pickImage(
                        source: ImageSource.camera,
                        imageQuality: 70,
                      );
                      if (image != null) {
                        setDialogState(() => photo = File(image.path));
                      }
                    },
                    child: Container(
                      width: double.infinity,
                      height: photo != null ? 160 : 76,
                      decoration: BoxDecoration(
                        border: Border.all(color: AppTheme.divider),
                        borderRadius: BorderRadius.circular(8),
                        color: AppTheme.backgroundGrey,
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
                                Icon(
                                  Icons.camera_alt_outlined,
                                  color: AppTheme.textSecondary,
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  AppStrings.of(
                                    context,
                                  ).housekeepingAddCompletionPhoto,
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: AppTheme.textSecondary,
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
                onPressed: () => Navigator.pop(context),
                child: Text(AppStrings.of(context).actionCancel),
              ),
              FilledButton.icon(
                onPressed: () => Navigator.pop(
                  context,
                  _CompletionEvidence(notes: controller.text, photo: photo),
                ),
                icon: const Icon(Icons.check_circle_outline),
                label: Text(AppStrings.of(context).housekeepingActionDone),
              ),
            ],
          ),
        ),
      );
    } finally {
      controller.dispose();
    }
  }

  void _showError(Object e) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(e.toString().replaceFirst('Exception: ', '')),
        backgroundColor: AppTheme.errorRed,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.housekeepingTasksTitle,
      role: StaffRole.housekeeping,
      actions: [
        IconButton(
          tooltip: AppStrings.of(context).lookup('action.refresh'),
          onPressed: _loading ? null : () => _loadTasks(),
          icon: const Icon(Icons.refresh),
        ),
      ],
      body: ConstrainedContent(
        child: Column(
          children: [
            if (_error != null)
              Container(
                width: double.infinity,
                color: AppTheme.errorOnSurface.withValues(alpha: 0.12),
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 10,
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.error_outline,
                      color: AppTheme.errorOnSurface,
                      size: 18,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _error!,
                        style: TextStyle(
                          color: AppTheme.errorOnSurface,
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            Material(
              color: AppTheme.cardSurface,
              child: TabBar(
                controller: _tabController,
                labelColor: AppTheme.successOnSurface,
                unselectedLabelColor: AppTheme.textSecondary,
                indicatorColor: AppTheme.successOnSurface,
                dividerColor: AppTheme.divider,
                tabs: [
                  Tab(text: '${s.housekeepingTabAll} (${_allTasks.length})'),
                  Tab(
                    text:
                        '${s.housekeepingTabPending} (${_pendingTasks.length})',
                  ),
                  Tab(
                    text:
                        '${s.housekeepingTabDone} (${_completedTasks.length})',
                  ),
                ],
              ),
            ),
            Expanded(
              child: _loading && _allTasks.isEmpty
                  ? const Center(child: CircularProgressIndicator())
                  : TabBarView(
                      controller: _tabController,
                      children: [
                        _TaskList(
                          tasks: _allTasks,
                          busyTaskId: _busyTaskId,
                          onRefresh: _loadTasks,
                          onStart: _startTask,
                          onComplete: _completeTask,
                        ),
                        _TaskList(
                          tasks: _pendingTasks,
                          busyTaskId: _busyTaskId,
                          onRefresh: _loadTasks,
                          onStart: _startTask,
                          onComplete: _completeTask,
                        ),
                        _TaskList(
                          tasks: _completedTasks,
                          busyTaskId: _busyTaskId,
                          onRefresh: _loadTasks,
                          onStart: _startTask,
                          onComplete: _completeTask,
                        ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CompletionEvidence {
  final String notes;
  final File? photo;

  const _CompletionEvidence({required this.notes, required this.photo});
}

class _TaskList extends StatelessWidget {
  final List<_Task> tasks;
  final String? busyTaskId;
  final Future<void> Function({bool showSpinner}) onRefresh;
  final ValueChanged<_Task> onStart;
  final ValueChanged<_Task> onComplete;

  const _TaskList({
    required this.tasks,
    required this.busyTaskId,
    required this.onRefresh,
    required this.onStart,
    required this.onComplete,
  });

  @override
  Widget build(BuildContext context) {
    if (tasks.isEmpty) {
      return RefreshIndicator(
        onRefresh: () => onRefresh(showSpinner: false),
        child: ListView(
          children: [
            SizedBox(height: MediaQuery.sizeOf(context).height * 0.25),
            Icon(Icons.task_alt, size: 56, color: AppTheme.textSecondary),
            const SizedBox(height: 16),
            Center(
              child: Text(
                AppStrings.of(context).housekeepingNoTasks,
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textPrimary,
                ),
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () => onRefresh(showSpinner: false),
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: tasks.length,
        itemBuilder: (_, i) => _TaskCard(
          task: tasks[i],
          busy: busyTaskId == tasks[i].id,
          onStart: () => onStart(tasks[i]),
          onComplete: () => onComplete(tasks[i]),
        ),
      ),
    );
  }
}

class _TaskCard extends StatelessWidget {
  final _Task task;
  final bool busy;
  final VoidCallback onStart;
  final VoidCallback onComplete;

  const _TaskCard({
    required this.task,
    required this.busy,
    required this.onStart,
    required this.onComplete,
  });

  @override
  Widget build(BuildContext context) {
    final priorityColor = switch (task.priority) {
      'urgent' => AppTheme.errorOnSurface,
      'high' => AppTheme.warningOnSurface,
      'low' => AppTheme.successOnSurface,
      _ => AppTheme.primaryBlue,
    };

    final statusColor = switch (task.status) {
      'completed' || 'verified' || 'closed' => AppTheme.successOnSurface,
      'in_progress' => AppTheme.accentCyan,
      'assigned' => AppTheme.primaryBlue,
      _ => AppTheme.textSecondary,
    };

    return Card(
      color: AppTheme.cardSurface,
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 4,
                  height: 52,
                  decoration: BoxDecoration(
                    color: priorityColor,
                    borderRadius: BorderRadius.circular(2),
                  ),
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
                              task.title,
                              style: TextStyle(
                                fontWeight: FontWeight.w700,
                                color: task.isFinished
                                    ? AppTheme.textSecondary
                                    : AppTheme.textPrimary,
                                decoration: task.isFinished
                                    ? TextDecoration.lineThrough
                                    : null,
                              ),
                            ),
                          ),
                          _Pill(
                            label: task.statusLabel,
                            color: statusColor,
                            filled: false,
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Wrap(
                        spacing: 12,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          _IconText(
                            icon: Icons.location_on_outlined,
                            label: task.location,
                          ),
                          if (task.slaLabel.isNotEmpty)
                            _IconText(
                              icon: Icons.schedule_outlined,
                              label: task.slaLabel,
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (task.description.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(
                task.description,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
              ),
            ],
            const SizedBox(height: 10),
            Row(
              children: [
                _Pill(label: task.category, color: AppTheme.primaryBlue),
                const SizedBox(width: 6),
                _Pill(label: task.priorityLabel, color: priorityColor),
                const Spacer(),
                if (busy)
                  const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                else ...[
                  if (task.status == 'assigned') ...[
                    TextButton.icon(
                      onPressed: onStart,
                      icon: const Icon(Icons.play_arrow, size: 18),
                      label: Text(
                        AppStrings.of(context).housekeepingActionStart,
                      ),
                      style: TextButton.styleFrom(
                        foregroundColor: AppTheme.accentCyan,
                        visualDensity: VisualDensity.compact,
                      ),
                    ),
                    const SizedBox(width: 4),
                  ],
                  if (!task.isFinished)
                    FilledButton.icon(
                      onPressed: onComplete,
                      icon: const Icon(Icons.check_circle_outline, size: 17),
                      label: Text(
                        AppStrings.of(context).housekeepingActionDone,
                      ),
                      style: FilledButton.styleFrom(
                        backgroundColor: AppTheme.successGreen,
                        foregroundColor: Colors.white,
                        visualDensity: VisualDensity.compact,
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

class _IconText extends StatelessWidget {
  final IconData icon;
  final String label;

  const _IconText({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 13, color: AppTheme.textSecondary),
        const SizedBox(width: 3),
        ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: MediaQuery.sizeOf(context).width * 0.62,
          ),
          child: Text(
            label,
            style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}

class _Pill extends StatelessWidget {
  final String label;
  final Color color;
  final bool filled;

  const _Pill({required this.label, required this.color, this.filled = true});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: filled ? 0.12 : 0.08),
        borderRadius: BorderRadius.circular(12),
        border: filled ? null : Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 10,
          color: color,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _Task {
  final String id;
  final String title;
  final String location;
  final String priority;
  final String status;
  final String category;
  final String description;
  final String slaLabel;
  final String priorityLabel;
  final String statusLabel;

  const _Task({
    required this.id,
    required this.title,
    required this.location,
    required this.priority,
    required this.status,
    required this.category,
    required this.description,
    required this.slaLabel,
    required this.priorityLabel,
    required this.statusLabel,
  });

  factory _Task.fromJson(Map<String, dynamic> json, AppStrings s) {
    final requestType = _normalize(json['request_type'] ?? json['task_type']);
    final location = _firstText([
      json['zone_name'],
      json['location_text'],
      json['request_number'],
    ], fallback: s.lookup('s4.lib.housekeeping_task.unspecified'));
    final createdLabel = _formatDate(json['created_at']);
    final slaLabel = _formatDate(json['sla_due_at']);
    final category = _requestTypeLabel(s, requestType);
    final priority = _normalize(json['urgency'], fallback: 'normal');
    final status = _normalize(json['status'], fallback: 'assigned');

    return _Task(
      id: json['id'].toString(),
      title: s.format('s4.dynamic.housekeeping_task.title', {
        'category': category,
        'location': location,
      }),
      location: location,
      priority: priority,
      status: status,
      category: category,
      description: _firstText([
        json['description'],
        json['notes'],
      ], fallback: ''),
      slaLabel: slaLabel.isNotEmpty
          ? s.format('s4.dynamic.housekeeping_task.sla_label', {
              'date': slaLabel,
            })
          : createdLabel,
      priorityLabel: _priorityLabel(s, priority).toUpperCase(),
      statusLabel: _statusLabel(s, status).toUpperCase(),
    );
  }

  bool get isFinished =>
      status == 'completed' || status == 'verified' || status == 'closed';

  static String _normalize(dynamic value, {String fallback = 'cleaning'}) {
    final text = value?.toString().trim().toLowerCase();
    return text == null || text.isEmpty ? fallback : text;
  }

  static String _firstText(List<dynamic> values, {required String fallback}) {
    for (final value in values) {
      final text = value?.toString().trim();
      if (text != null && text.isNotEmpty) return text;
    }
    return fallback;
  }

  static String _formatDate(dynamic value) {
    final text = value?.toString();
    if (text == null || text.isEmpty) return '';
    final parsed = DateTime.tryParse(text);
    if (parsed == null) return '';
    return DateFormat('dd MMM, HH:mm').format(parsed.toLocal());
  }

  static String _priorityLabel(AppStrings s, String value) => switch (value) {
    'urgent' => s.priorityUrgent,
    'high' => s.urgencyHigh,
    'low' => s.urgencyLow,
    _ => s.urgencyNormal,
  };

  static String _requestTypeLabel(AppStrings s, String value) =>
      switch (value) {
        'spillage' => s.housekeepingRequestTypeSpillage,
        'waste' => s.housekeepingRequestTypeWaste,
        'linen' => s.housekeepingRequestTypeLinen,
        'disinfection' => s.housekeepingRequestTypeDisinfection,
        'other' => s.housekeepingRequestTypeOther,
        _ => s.housekeepingRequestTypeCleaning,
      };

  static String _statusLabel(AppStrings s, String value) => switch (value) {
    'completed' => s.lookup('s4.lib.housekeeping_task.status.completed'),
    'verified' => s.lookup('s4.lib.housekeeping_task.status.verified'),
    'closed' => s.lookup('s4.lib.housekeeping_task.status.closed'),
    'in_progress' => s.lookup('s4.lib.housekeeping_task.status.in_progress'),
    _ => s.lookup('s4.lib.housekeeping_task.status.assigned'),
  };
}
