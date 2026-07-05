import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

class LeaveApprovalsScreen extends StatefulWidget {
  const LeaveApprovalsScreen({super.key});

  @override
  State<LeaveApprovalsScreen> createState() => _LeaveApprovalsScreenState();
}

class _LeaveApprovalsScreenState extends State<LeaveApprovalsScreen> {
  static const _statuses = ['pending', 'approved', 'rejected'];

  String _status = 'pending';
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _requests = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  List<Map<String, dynamic>> _asRows(dynamic value) {
    if (value is! List) return [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await HrApiService.getLeaveRequests(status: _status);
      if (!mounted) return;
      setState(() {
        _requests = _asRows(data['leaveRequests'] ?? data['data']);
      });
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _fmtDate(dynamic value) {
    if (value == null) return '-';
    try {
      return DateFormat('d MMM yyyy').format(DateTime.parse(value.toString()));
    } catch (_) {
      return value.toString();
    }
  }

  Future<String?> _reviewNote({
    required BuildContext context,
    required String decision,
  }) async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (_) {
        final s = AppStrings.of(context);
        final decisionLabel = decision == 'approve'
            ? s.lookup('s4.lib.housekeeping_roster_board.approve')
            : s.lookup('clinical_ai.draft.reject_button');
        return AlertDialog(
          title: Text(
            s.format('s4.dynamic.leave_approvals.decision_title', {
              'decision': decisionLabel,
            }),
          ),
          content: TextField(
            controller: controller,
            maxLines: 3,
            decoration: InputDecoration(
              labelText: s.lookup('s4.lib.patient_records.review_note'),
              hintText: s.lookup(
                's4.lib.leave_approvals.optional_note_for_audit',
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const AppText('action.cancel'),
            ),
            FilledButton(
              onPressed: () =>
                  Navigator.of(context).pop(controller.text.trim()),
              child: const AppText('action.confirm'),
            ),
          ],
        );
      },
    );
    controller.dispose();
    return result;
  }

  Future<void> _review(Map<String, dynamic> row, String decision) async {
    final id = int.tryParse(row['id'].toString());
    if (id == null) return;
    final note = await _reviewNote(context: context, decision: decision);
    if (note == null || !mounted) return;

    try {
      await HrApiService.reviewLeaveRequest(
        leaveId: id,
        decision: decision,
        comments: note.isEmpty ? null : note,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: AppText(
            decision == 'approve'
                ? 's4.lib.leave_approvals.leave_approved'
                : 's4.lib.leave_approvals.leave_rejected',
          ),
          backgroundColor: decision == 'approve'
              ? AppTheme.successGreen
              : AppTheme.errorRed,
        ),
      );
      await _load();
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

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.lookup('s4.lib.leave_approvals.title'),
      actions: [
        IconButton(
          tooltip: AppStrings.of(context).lookup('action.refresh'),
          onPressed: _loading ? null : _load,
          icon: const Icon(Icons.refresh),
        ),
      ],
      body: Column(
        children: [
          Container(
            width: double.infinity,
            color: AppTheme.cardSurface,
            padding: const EdgeInsets.all(12),
            child: Wrap(
              spacing: 8,
              children: _statuses
                  .map(
                    (status) => ChoiceChip(
                      label: Text(_leaveStatusLabel(context, status)),
                      selected: _status == status,
                      onSelected: _loading
                          ? null
                          : (_) {
                              setState(() => _status = status);
                              _load();
                            },
                    ),
                  )
                  .toList(),
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                ? _ErrorState(error: _error!, onRetry: _load)
                : _requests.isEmpty
                ? _EmptyState(status: _status)
                : RefreshIndicator(
                    onRefresh: _load,
                    child: ListView.builder(
                      padding: const EdgeInsets.all(12),
                      itemCount: _requests.length,
                      itemBuilder: (_, index) => _LeaveRequestCard(
                        row: _requests[index],
                        status: _status,
                        formatDate: _fmtDate,
                        onApprove: () => _review(_requests[index], 'approve'),
                        onReject: () => _review(_requests[index], 'reject'),
                      ),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _LeaveRequestCard extends StatelessWidget {
  final Map<String, dynamic> row;
  final String status;
  final String Function(dynamic value) formatDate;
  final VoidCallback onApprove;
  final VoidCallback onReject;

  const _LeaveRequestCard({
    required this.row,
    required this.status,
    required this.formatDate,
    required this.onApprove,
    required this.onReject,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final name =
        row['staff_name'] ??
        row['staffName'] ??
        s.lookup('s4.lib.leave_approvals.unknown_staff');
    final employeeId = row['employee_id'] ?? row['employeeId'];
    final department =
        row['department'] ??
        s.lookup('s4.lib.leave_approvals.department_not_set');
    final type = row['leave_type'] ?? s.leaveTitle;
    final days = row['total_days'] ?? row['days_taken'] ?? '-';
    final reason = row['reason']?.toString().trim();

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
                const Icon(
                  Icons.event_busy_outlined,
                  color: AppTheme.primaryBlue,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        employeeId == null
                            ? name.toString()
                            : '$name - $employeeId',
                        style: TextStyle(
                          color: AppTheme.textPrimary,
                          fontSize: 16,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '$department - ${type.toString().replaceAll('_', ' ')}',
                        style: TextStyle(
                          color: AppTheme.textSecondary,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
                _StatusPill(status: status),
              ],
            ),
            const SizedBox(height: 12),
            Text(
              s.format('s4.dynamic.leave_approvals.date_range_days', {
                'start': formatDate(row['start_date']),
                'end': formatDate(row['end_date']),
                'days': days,
              }),
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontWeight: FontWeight.w700,
              ),
            ),
            if (reason != null && reason.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(reason, style: TextStyle(color: AppTheme.textSecondary)),
            ],
            if (status == 'pending') ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: onReject,
                      icon: const Icon(Icons.close),
                      label: const AppText('clinical_ai.draft.reject_button'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: onApprove,
                      icon: const Icon(Icons.check),
                      label: const AppText(
                        's4.lib.housekeeping_roster_board.approve',
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String status;
  const _StatusPill({required this.status});

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      'approved' => AppTheme.successGreen,
      'rejected' => AppTheme.errorRed,
      _ => AppTheme.warningAmber,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.55)),
      ),
      child: Text(
        _leaveStatusLabel(context, status),
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final String status;
  const _EmptyState({required this.status});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.event_available_outlined,
            size: 52,
            color: AppTheme.textSecondary,
          ),
          const SizedBox(height: 12),
          Text(
            s.format('s4.dynamic.leave_approvals.no_status_requests', {
              'status': _leaveStatusLabel(context, status).toLowerCase(),
            }),
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontSize: 16,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }
}

String _leaveStatusLabel(BuildContext context, String status) {
  final key = 's4.lib.leave_approvals.status.${status.toLowerCase()}';
  final label = AppStrings.of(context).lookup(key);
  return label == key ? status.toUpperCase() : label;
}

class _ErrorState extends StatelessWidget {
  final String error;
  final VoidCallback onRetry;
  const _ErrorState({required this.error, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.error_outline, color: AppTheme.errorRed, size: 42),
          const SizedBox(height: 10),
          Text(error, style: TextStyle(color: AppTheme.textSecondary)),
          TextButton(onPressed: onRetry, child: const AppText('action.retry')),
        ],
      ),
    );
  }
}
