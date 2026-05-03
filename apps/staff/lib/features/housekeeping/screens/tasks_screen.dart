import 'package:flutter/material.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

/// Housekeeping Tasks screen — General staff view/complete assigned tasks.
/// TODO: Integrate with backend when /staff/housekeeping/tasks endpoint is available.
class HousekeepingTasksScreen extends StatefulWidget {
  const HousekeepingTasksScreen({super.key});

  @override
  State<HousekeepingTasksScreen> createState() =>
      _HousekeepingTasksScreenState();
}

class _HousekeepingTasksScreenState extends State<HousekeepingTasksScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  // ignore: unused_field
  final bool _loading = false;

  // Placeholder tasks — will be replaced by API data
  final List<_Task> _tasks = [
    _Task(
      id: '1',
      title: 'Clean Ward 3A',
      location: 'Ward 3A',
      priority: 'high',
      status: 'pending',
      dueTime: '09:00 AM',
      category: 'Cleaning',
    ),
    _Task(
      id: '2',
      title: 'Restock supplies in OPD',
      location: 'OPD',
      priority: 'normal',
      status: 'pending',
      dueTime: '10:30 AM',
      category: 'Restocking',
    ),
    _Task(
      id: '3',
      title: 'Sanitize ICU entry',
      location: 'ICU',
      priority: 'urgent',
      status: 'in_progress',
      dueTime: '08:00 AM',
      category: 'Sanitation',
    ),
    _Task(
      id: '4',
      title: 'Waste disposal - Lab',
      location: 'Laboratory',
      priority: 'high',
      status: 'completed',
      dueTime: '07:30 AM',
      category: 'Waste Management',
    ),
  ];

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  List<_Task> get _pendingTasks => _tasks
      .where((t) => t.status == 'pending' || t.status == 'in_progress')
      .toList();
  List<_Task> get _completedTasks =>
      _tasks.where((t) => t.status == 'completed').toList();

  void _markComplete(String id) {
    // TODO: Call PATCH /staff/housekeeping/tasks/:id/complete when API available
    setState(() {
      final task = _tasks.firstWhere((t) => t.id == id);
      task.status = 'completed';
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(AppStrings.of(context).housekeepingTaskCompleted),
        backgroundColor: AppTheme.successGreen,
        duration: const Duration(seconds: 2),
      ),
    );
  }

  void _startTask(String id) {
    // TODO: Call PATCH /staff/housekeeping/tasks/:id/start when API available
    setState(() {
      final task = _tasks.firstWhere((t) => t.id == id);
      task.status = 'in_progress';
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(AppStrings.of(context).housekeepingTaskStarted),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.housekeepingTasksTitle,
      body: Column(
        children: [
          // API notice
          Container(
            color: AppTheme.warningAmber.withValues(alpha: 0.08),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              children: [
                const Icon(
                  Icons.info_outline,
                  color: AppTheme.warningAmber,
                  size: 16,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    s.housekeepingSampleNotice,
                    style: const TextStyle(
                      color: AppTheme.warningAmber,
                      fontSize: 11,
                    ),
                  ),
                ),
              ],
            ),
          ),

          // Tabs
          Container(
            color: Colors.white,
            child: TabBar(
              controller: _tabController,
              labelColor: AppTheme.successGreen,
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: AppTheme.successGreen,
              tabs: [
                Tab(text: '${s.housekeepingTabAll} (${_tasks.length})'),
                Tab(text: '${s.housekeepingTabPending} (${_pendingTasks.length})'),
                Tab(text: '${s.housekeepingTabDone} (${_completedTasks.length})'),
              ],
            ),
          ),

          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _TaskList(
                  tasks: _tasks,
                  onComplete: _markComplete,
                  onStart: _startTask,
                ),
                _TaskList(
                  tasks: _pendingTasks,
                  onComplete: _markComplete,
                  onStart: _startTask,
                ),
                _TaskList(
                  tasks: _completedTasks,
                  onComplete: _markComplete,
                  onStart: _startTask,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _TaskList extends StatelessWidget {
  final List<_Task> tasks;
  final Function(String) onComplete;
  final Function(String) onStart;

  const _TaskList({
    required this.tasks,
    required this.onComplete,
    required this.onStart,
  });

  @override
  Widget build(BuildContext context) {
    if (tasks.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.task_alt, size: 56, color: AppTheme.textSecondary),
            const SizedBox(height: 16),
            Text(
              AppStrings.of(context).housekeepingNoTasks,
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.bold,
                color: AppTheme.textPrimary,
              ),
            ),
          ],
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(12),
      itemCount: tasks.length,
      itemBuilder: (_, i) => _TaskCard(
        task: tasks[i],
        onComplete: () => onComplete(tasks[i].id),
        onStart: () => onStart(tasks[i].id),
      ),
    );
  }
}

class _TaskCard extends StatelessWidget {
  final _Task task;
  final VoidCallback onComplete;
  final VoidCallback onStart;

  const _TaskCard({
    required this.task,
    required this.onComplete,
    required this.onStart,
  });

  @override
  Widget build(BuildContext context) {
    final priorityColor = switch (task.priority) {
      'urgent' => AppTheme.errorRed,
      'high' => AppTheme.warningAmber,
      'normal' => AppTheme.primaryBlue,
      _ => AppTheme.textSecondary,
    };

    final statusColor = switch (task.status) {
      'completed' => AppTheme.successGreen,
      'in_progress' => AppTheme.accentCyan,
      _ => AppTheme.textSecondary,
    };

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                // Priority indicator
                Container(
                  width: 4,
                  height: 48,
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
                                fontWeight: FontWeight.bold,
                                color: task.status == 'completed'
                                    ? AppTheme.textSecondary
                                    : AppTheme.textPrimary,
                                decoration: task.status == 'completed'
                                    ? TextDecoration.lineThrough
                                    : null,
                              ),
                            ),
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 2,
                            ),
                            decoration: BoxDecoration(
                              color: statusColor.withValues(alpha: 0.1),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Text(
                              task.status.replaceAll('_', ' ').toUpperCase(),
                              style: TextStyle(
                                fontSize: 9,
                                color: statusColor,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                        ],
                      ),
                      SizedBox(height: 2),
                      Row(
                        children: [
                          Icon(
                            Icons.location_on_outlined,
                            size: 12,
                            color: AppTheme.textSecondary,
                          ),
                          SizedBox(width: 2),
                          Text(
                            task.location,
                            style: TextStyle(
                              fontSize: 12,
                              color: AppTheme.textSecondary,
                            ),
                          ),
                          SizedBox(width: 12),
                          Icon(
                            Icons.schedule_outlined,
                            size: 12,
                            color: AppTheme.textSecondary,
                          ),
                          SizedBox(width: 2),
                          Text(
                            task.dueTime,
                            style: TextStyle(
                              fontSize: 12,
                              color: AppTheme.textSecondary,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),

            // Category chip
            const SizedBox(height: 8),
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: AppTheme.primaryBlue.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    task.category,
                    style: const TextStyle(
                      fontSize: 10,
                      color: AppTheme.primaryBlue,
                    ),
                  ),
                ),
                Container(
                  margin: const EdgeInsets.only(left: 6),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: priorityColor.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    task.priority.toUpperCase(),
                    style: TextStyle(
                      fontSize: 10,
                      color: priorityColor,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                const Spacer(),

                // Action buttons
                if (task.status == 'pending') ...[
                  TextButton(
                    onPressed: onStart,
                    style: TextButton.styleFrom(
                      foregroundColor: AppTheme.accentCyan,
                      visualDensity: VisualDensity.compact,
                    ),
                    child: Text(
                      AppStrings.of(context).housekeepingActionStart,
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
                  const SizedBox(width: 4),
                ],
                if (task.status != 'completed')
                  ElevatedButton(
                    onPressed: onComplete,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppTheme.successGreen,
                      minimumSize: const Size(80, 32),
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                    ),
                    child: Text(
                      AppStrings.of(context).housekeepingActionDone,
                      style: const TextStyle(fontSize: 12, color: Colors.white),
                    ),
                  ),
              ],
            ),
          ],
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
  String status;
  final String dueTime;
  final String category;

  _Task({
    required this.id,
    required this.title,
    required this.location,
    required this.priority,
    required this.status,
    required this.dueTime,
    required this.category,
  });
}
