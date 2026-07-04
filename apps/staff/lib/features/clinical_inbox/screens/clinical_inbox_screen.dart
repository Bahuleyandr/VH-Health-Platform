import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../../core/providers/clinical_inbox_provider.dart';
import '../../../core/services/clinical_inbox_api_service.dart';
import '../../../l10n/app_strings.dart';

class ClinicalInboxScreen extends StatefulWidget {
  const ClinicalInboxScreen({super.key});

  @override
  State<ClinicalInboxScreen> createState() => _ClinicalInboxScreenState();
}

class _ClinicalInboxScreenState extends State<ClinicalInboxScreen> {
  Timer? _minuteTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(context.read<ClinicalInboxProvider>().refresh());
    });
    _minuteTimer = Timer.periodic(const Duration(minutes: 1), (_) {
      if (!mounted) return;
      setState(() {});
      unawaited(context.read<ClinicalInboxProvider>().refresh());
    });
  }

  @override
  void dispose() {
    _minuteTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final provider = context.watch<ClinicalInboxProvider>();
    final now = DateTime.now();
    final groups = _groupTasks(provider.tasks, now);

    return Scaffold(
      appBar: AppBar(
        title: Text(strings.clinicalInboxTitle),
        actions: [
          IconButton(
            tooltip: strings.actionRefresh,
            icon: provider.isRefreshing
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh),
            onPressed: provider.isRefreshing
                ? null
                : () => unawaited(provider.refresh()),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: provider.refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          children: [
            if (provider.lastError != null)
              _ErrorBanner(
                message: provider.lastError!,
                onRetry: () => unawaited(provider.refresh()),
              ),
            if (provider.tasks.isEmpty && provider.isRefreshing)
              const Padding(
                padding: EdgeInsets.only(top: 96),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (provider.tasks.isEmpty)
              _EmptyState(message: strings.clinicalInboxEmpty)
            else
              for (final entry in groups.entries) ...[
                _GroupHeader(label: _groupLabel(strings, entry.key)),
                const SizedBox(height: 8),
                for (final task in entry.value)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: _ClinicalInboxTaskCard(
                      task: task,
                      now: now,
                      onOpen: () => _showTaskDetail(context, task),
                      onAcknowledge: () => _acknowledge(context, task),
                    ),
                  ),
              ],
          ],
        ),
      ),
    );
  }

  Future<void> _acknowledge(
    BuildContext context,
    ClinicalInboxTask task,
  ) async {
    final strings = AppStrings.of(context);
    try {
      await context.read<ClinicalInboxProvider>().acknowledge(task.id);
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(strings.clinicalInboxAckFailed('$e'))),
      );
    }
  }

  void _showTaskDetail(BuildContext context, ClinicalInboxTask task) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => _ClinicalInboxTaskDetail(
        task: task,
        onAcknowledge: () => _acknowledge(context, task),
      ),
    );
  }
}

class _ClinicalInboxTaskCard extends StatelessWidget {
  final ClinicalInboxTask task;
  final DateTime now;
  final VoidCallback onOpen;
  final VoidCallback onAcknowledge;

  const _ClinicalInboxTaskCard({
    required this.task,
    required this.now,
    required this.onOpen,
    required this.onAcknowledge,
  });

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final provider = context.watch<ClinicalInboxProvider>();
    final busy = provider.isAcknowledging(task.id);
    final canAck = task.needsAcknowledgement && !busy;
    final color = _priorityColor(context, task, now);

    return Card(
      margin: EdgeInsets.zero,
      child: InkWell(
        onTap: onOpen,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.assignment_late_outlined, color: color),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          task.title,
                          style: Theme.of(context).textTheme.titleMedium
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '${strings.clinicalInboxPatient}: ${task.patientLabel.isEmpty ? strings.clinicalInboxUnknownPatient : task.patientLabel}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        Text(
                          '${strings.clinicalInboxSource}: ${task.sourceLabel}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  _SlaBadge(task: task, now: now),
                ],
              ),
              if (task.description.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(
                  task.description,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton(
                  onPressed: canAck ? onAcknowledge : null,
                  child: busy
                      ? Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                            const SizedBox(width: 8),
                            Text(strings.clinicalInboxAcknowledging),
                          ],
                        )
                      : Text(
                          task.needsAcknowledgement
                              ? strings.clinicalInboxAcknowledge
                              : strings.clinicalInboxAcknowledged,
                        ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ClinicalInboxTaskDetail extends StatelessWidget {
  final ClinicalInboxTask task;
  final VoidCallback onAcknowledge;

  const _ClinicalInboxTaskDetail({
    required this.task,
    required this.onAcknowledge,
  });

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final provider = context.watch<ClinicalInboxProvider>();
    final currentTask = provider.tasks.firstWhere(
      (candidate) => candidate.id == task.id,
      orElse: () => task,
    );
    final busy = provider.isAcknowledging(currentTask.id);
    final escalations = currentTask.escalations;

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                strings.clinicalInboxTaskDetail,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 12),
              Text(
                currentTask.title,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              if (currentTask.description.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(currentTask.description),
              ],
              const SizedBox(height: 16),
              _DetailLine(
                label: strings.clinicalInboxPatient,
                value: currentTask.patientLabel.isEmpty
                    ? strings.clinicalInboxUnknownPatient
                    : currentTask.patientLabel,
              ),
              _DetailLine(
                label: strings.clinicalInboxSourceEvent,
                value: currentTask.sourceLabel,
              ),
              _DetailLine(
                label: strings.clinicalInboxPriority,
                value: currentTask.priority.toUpperCase(),
              ),
              _DetailLine(
                label: strings.clinicalInboxStatus,
                value: currentTask.status.replaceAll('_', ' '),
              ),
              if (currentTask.dueAt != null)
                _DetailLine(
                  label: strings.clinicalInboxDue,
                  value: _formatDateTime(currentTask.dueAt!),
                ),
              const SizedBox(height: 16),
              Text(
                strings.clinicalInboxTierHistory,
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: 8),
              if (escalations.isEmpty)
                Text(strings.clinicalInboxNoTierHistory)
              else
                for (final escalation in escalations)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.escalator_warning_outlined),
                    title: Text(
                      strings.clinicalInboxTierLine(
                        escalation.tier,
                        escalation.action,
                      ),
                    ),
                    subtitle: escalation.at == null
                        ? null
                        : Text(_formatDateTime(escalation.at!)),
                  ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: currentTask.needsAcknowledgement && !busy
                      ? onAcknowledge
                      : null,
                  child: busy
                      ? Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                            const SizedBox(width: 8),
                            Text(strings.clinicalInboxAcknowledging),
                          ],
                        )
                      : Text(
                          currentTask.needsAcknowledgement
                              ? strings.clinicalInboxAcknowledge
                              : strings.clinicalInboxAcknowledged,
                        ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DetailLine extends StatelessWidget {
  final String label;
  final String value;

  const _DetailLine({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              label,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }
}

class _SlaBadge extends StatelessWidget {
  final ClinicalInboxTask task;
  final DateTime now;

  const _SlaBadge({required this.task, required this.now});

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final overdue = task.isOverdue(now);
    final due = task.dueAt;
    final label = overdue
        ? strings.clinicalInboxSlaOverdue
        : due == null
        ? strings.clinicalInboxSlaNoDue
        : _countdownLabel(strings, due.difference(now));
    final color = overdue
        ? Colors.red.shade700
        : task.priority == 'critical'
        ? Colors.deepOrange.shade700
        : Theme.of(context).colorScheme.primary;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        border: Border.all(color: color.withValues(alpha: 0.45)),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _GroupHeader extends StatelessWidget {
  final String label;

  const _GroupHeader({required this.label});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Text(
        label,
        style: Theme.of(context).textTheme.titleSmall?.copyWith(
          fontWeight: FontWeight.w800,
          letterSpacing: 0,
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final String message;

  const _EmptyState({required this.message});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 96),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.assignment_turned_in_outlined,
              size: 48,
              color: Theme.of(context).colorScheme.primary,
            ),
            const SizedBox(height: 12),
            Text(message, style: Theme.of(context).textTheme.titleMedium),
          ],
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorBanner({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return Card(
      color: Theme.of(context).colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Expanded(child: Text(message)),
            TextButton(onPressed: onRetry, child: Text(strings.actionRetry)),
          ],
        ),
      ),
    );
  }
}

Map<_ClinicalInboxGroup, List<ClinicalInboxTask>> _groupTasks(
  List<ClinicalInboxTask> tasks,
  DateTime now,
) {
  final grouped = <_ClinicalInboxGroup, List<ClinicalInboxTask>>{};
  for (final task in tasks) {
    final group = task.isOverdue(now)
        ? _ClinicalInboxGroup.overdue
        : task.status == 'in_progress'
        ? _ClinicalInboxGroup.acknowledged
        : switch (task.priority) {
            'critical' => _ClinicalInboxGroup.critical,
            'high' => _ClinicalInboxGroup.high,
            _ => _ClinicalInboxGroup.normal,
          };
    grouped.putIfAbsent(group, () => []).add(task);
  }
  return grouped;
}

String _groupLabel(AppStrings strings, _ClinicalInboxGroup group) {
  return switch (group) {
    _ClinicalInboxGroup.overdue => strings.clinicalInboxGroupOverdue,
    _ClinicalInboxGroup.critical => strings.clinicalInboxGroupCritical,
    _ClinicalInboxGroup.high => strings.clinicalInboxGroupHigh,
    _ClinicalInboxGroup.normal => strings.clinicalInboxGroupNormal,
    _ClinicalInboxGroup.acknowledged => strings.clinicalInboxGroupAcknowledged,
  };
}

Color _priorityColor(
  BuildContext context,
  ClinicalInboxTask task,
  DateTime now,
) {
  if (task.isOverdue(now)) return Colors.red.shade700;
  return switch (task.priority) {
    'critical' => Colors.deepOrange.shade700,
    'high' => Colors.orange.shade800,
    _ => Theme.of(context).colorScheme.primary,
  };
}

String _countdownLabel(AppStrings strings, Duration remaining) {
  if (remaining.inMinutes <= 0) return strings.clinicalInboxSlaDueNow;
  if (remaining.inMinutes < 60) {
    return strings.clinicalInboxSlaDueMinutes(remaining.inMinutes);
  }
  final hours = remaining.inHours;
  final minutes = remaining.inMinutes.remainder(60);
  return strings.clinicalInboxSlaDueHours(hours, minutes);
}

String _formatDateTime(DateTime value) {
  final local = value.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)} '
      '${two(local.hour)}:${two(local.minute)}';
}

enum _ClinicalInboxGroup { overdue, critical, high, normal, acknowledged }
