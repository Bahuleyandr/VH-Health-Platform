import 'package:flutter/material.dart';

import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';

class HousekeepingRosterBoardScreen extends StatefulWidget {
  final String department;
  final String title;

  const HousekeepingRosterBoardScreen({
    super.key,
    this.department = 'housekeeping',
    this.title = 'Shift Roster',
  });

  @override
  State<HousekeepingRosterBoardScreen> createState() =>
      _HousekeepingRosterBoardScreenState();
}

class _HousekeepingRosterBoardScreenState
    extends State<HousekeepingRosterBoardScreen> {
  bool _loading = true;
  bool _saving = false;
  String? _error;
  DateTime _date = DateTime.now();
  String? _selectedShiftLabel;
  final Map<int, int?> _targetStaff = {};
  String _targetType = 'housekeeping_zone';
  String _departmentLabel = 'Housekeeping';

  List<Map<String, dynamic>> _shifts = [];
  List<Map<String, dynamic>> _staff = [];
  List<Map<String, dynamic>> _targets = [];
  List<Map<String, dynamic>> _boards = [];
  List<Map<String, dynamic>> _coverage = [];
  List<Map<String, dynamic>> _requests = [];
  List<Map<String, dynamic>> _leaveCoverage = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  int? _asInt(dynamic value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }

  String _asText(dynamic value, {String fallback = '-'}) {
    final text = value?.toString().trim();
    return text == null || text.isEmpty ? fallback : text;
  }

  List<Map<String, dynamic>> _asMapList(dynamic value) {
    if (value is! List) return [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
  }

  String _dateText(DateTime date) {
    final y = date.year.toString().padLeft(4, '0');
    final m = date.month.toString().padLeft(2, '0');
    final d = date.day.toString().padLeft(2, '0');
    return '$y-$m-$d';
  }

  Map<String, dynamic>? get _currentShift {
    final label = _selectedShiftLabel;
    if (label == null) return null;
    for (final shift in _shifts) {
      if (_asText(shift['name']) == label) return shift;
    }
    return null;
  }

  Map<String, dynamic>? get _currentBoard {
    final label = _selectedShiftLabel;
    if (label == null) return null;
    for (final board in _boards) {
      if (_asText(board['shift_label']) == label) return board;
    }
    return null;
  }

  Map<String, dynamic>? get _currentCoverage {
    final id = _asInt(_currentBoard?['id']);
    if (id == null) return null;
    for (final row in _coverage) {
      if (_asInt(row['roster_id']) == id) return row;
    }
    return null;
  }

  void _applyBoardSelections() {
    _targetStaff.clear();
    for (final target in _targets) {
      final targetId = _asInt(target['id']);
      if (targetId != null) _targetStaff[targetId] = null;
    }

    final board = _currentBoard;
    final assignments = _asMapList(board?['assignments']);
    for (final assignment in assignments) {
      final targetId = _asInt(
        assignment['assignment_target_id'] ?? assignment['target_id'],
      );
      final staffId = _asInt(assignment['staff_id']);
      if (targetId != null && staffId != null) {
        _targetStaff[targetId] = staffId;
      }
    }
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final data = await HrApiService.getRosterBoard(
        department: widget.department,
        rosterDate: _dateText(_date),
      );
      final shifts = _asMapList(data['shifts']);
      if (!mounted) return;
      setState(() {
        _shifts = shifts;
        _staff = _asMapList(data['staff']);
        _targets = _asMapList(data['targets']);
        _boards = _asMapList(data['boards']);
        _coverage = _asMapList(data['coverage']);
        _requests = _asMapList(data['requests']);
        _leaveCoverage = _asMapList(data['leave_coverage']);
        _targetType = _asText(data['target_type'], fallback: _targetType);
        _departmentLabel = _asText(
          data['department_label'],
          fallback: _departmentLabel,
        );
        _selectedShiftLabel ??= shifts.isNotEmpty
            ? _asText(shifts.first['name'])
            : 'Morning';
        _applyBoardSelections();
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime.now().subtract(const Duration(days: 30)),
      lastDate: DateTime.now().add(const Duration(days: 90)),
    );
    if (picked == null) return;
    setState(() {
      _date = picked;
      _selectedShiftLabel = null;
    });
    await _load();
  }

  List<Map<String, dynamic>> _buildAssignments() {
    final result = <Map<String, dynamic>>[];
    for (final target in _targets) {
      final targetId = _asInt(target['id']);
      if (targetId == null) continue;
      final staffId = _targetStaff[targetId];
      final label = _asText(target['label'] ?? target['name']);
      if (staffId == null) continue;
      result.add({
        'staff_id': staffId,
        'assignment_target_type': _targetType,
        'assignment_target_id': targetId,
        'assignment_target_label': label,
        'floor': target['floor'],
        'building': target['building'],
      });
    }
    return result;
  }

  Future<Map<String, dynamic>?> _saveDraft({bool quiet = false}) async {
    final shift = _currentShift;
    final shiftLabel = _selectedShiftLabel;
    if (shiftLabel == null) return null;
    final assignments = _buildAssignments();
    if (assignments.isEmpty) {
      _showSnack('Assign at least one zone before saving.', AppTheme.errorRed);
      return null;
    }

    setState(() => _saving = true);
    try {
      final saved = await HrApiService.saveRosterBoard(
        department: widget.department,
        rosterDate: _dateText(_date),
        shiftLabel: shiftLabel,
        shiftId: _asInt(shift?['id']),
        notes: '$_departmentLabel shift roster',
        assignments: assignments,
      );
      if (!quiet) _showSnack('Roster draft saved', AppTheme.successGreen);
      await _load();
      return saved;
    } catch (e) {
      _showSnack(
        e.toString().replaceFirst('Exception: ', ''),
        AppTheme.errorRed,
      );
      return null;
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _publish() async {
    var boardId = _asInt(_currentBoard?['id']);
    if (boardId == null) {
      final saved = await _saveDraft(quiet: true);
      boardId = _asInt(saved?['id']);
    }
    if (boardId == null) return;

    setState(() => _saving = true);
    try {
      await HrApiService.publishRosterBoard(
        rosterId: boardId,
        reason: 'Published from $_departmentLabel roster board',
      );
      _showSnack('Roster published for live routing', AppTheme.successGreen);
      await _load();
    } catch (e) {
      _showSnack(
        e.toString().replaceFirst('Exception: ', ''),
        AppTheme.errorRed,
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _copyPrevious() async {
    final shiftLabel = _selectedShiftLabel;
    if (shiftLabel == null) return;
    setState(() => _saving = true);
    try {
      await HrApiService.copyPreviousRosterBoard(
        department: widget.department,
        rosterDate: _dateText(_date),
        shiftLabel: shiftLabel,
      );
      _showSnack('Previous roster copied', AppTheme.successGreen);
      await _load();
    } catch (e) {
      _showSnack(
        e.toString().replaceFirst('Exception: ', ''),
        AppTheme.errorRed,
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _reviewRequest(int requestId, String decision) async {
    setState(() => _saving = true);
    try {
      await HrApiService.reviewRosterPreferenceRequest(
        requestId: requestId,
        decision: decision,
        reviewNotes: 'Reviewed from $_departmentLabel roster board',
      );
      _showSnack('Duty request $decision', AppTheme.successGreen);
      await _load();
    } catch (e) {
      _showSnack(
        e.toString().replaceFirst('Exception: ', ''),
        AppTheme.errorRed,
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _showSnack(String message, Color color) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message), backgroundColor: color));
  }

  @override
  Widget build(BuildContext context) {
    final board = _currentBoard;
    final status = _asText(board?['status'], fallback: 'draft');
    final assigned = _buildAssignments().length;
    final gapCount =
        _asInt(_currentCoverage?['coverage_gap_count']) ??
        (_targets.length - assigned).clamp(0, _targets.length);

    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(widget.title),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: _loading && _targets.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_error != null) _ErrorBanner(error: _error!),
                  _HeaderPanel(
                    dateText: _dateText(_date),
                    departmentLabel: _departmentLabel,
                    status: status,
                    assigned: assigned,
                    gaps: gapCount,
                    saving: _saving,
                    onPickDate: _pickDate,
                    onCopyPrevious: _copyPrevious,
                  ),
                  const SizedBox(height: 12),
                  _ShiftSelector(
                    shifts: _shifts,
                    selected: _selectedShiftLabel,
                    asText: _asText,
                    onChanged: (label) {
                      setState(() {
                        _selectedShiftLabel = label;
                        _applyBoardSelections();
                      });
                    },
                  ),
                  const SizedBox(height: 12),
                  _RosterLegend(
                    staffCount: _staff.length,
                    targetCount: _targets.length,
                  ),
                  const SizedBox(height: 8),
                  _RosterSignals(
                    requests: _requests,
                    leaveCoverage: _leaveCoverage,
                    saving: _saving,
                    asInt: _asInt,
                    asText: _asText,
                    onReview: _reviewRequest,
                  ),
                  const SizedBox(height: 8),
                  if (_targets.isEmpty)
                    _EmptyCard(
                      icon: Icons.map_outlined,
                      text:
                          'No active $_departmentLabel roster targets configured',
                    )
                  else
                    ..._targets.map(
                      (target) => _ZoneAssignmentCard(
                        target: target,
                        staff: _staff,
                        selectedStaffId: _targetStaff[_asInt(target['id'])],
                        saving: _saving,
                        onChanged: (staffId) {
                          final targetId = _asInt(target['id']);
                          if (targetId == null) return;
                          setState(() => _targetStaff[targetId] = staffId);
                        },
                        asInt: _asInt,
                        asText: _asText,
                      ),
                    ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _saving ? null : () => _saveDraft(),
                          icon: const Icon(Icons.save_outlined),
                          label: const Text('Save draft'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: FilledButton.icon(
                          onPressed: _saving ? null : _publish,
                          icon: _saving
                              ? const SizedBox(
                                  height: 18,
                                  width: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.publish_outlined),
                          label: const Text('Publish shift'),
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

class _HeaderPanel extends StatelessWidget {
  final String dateText;
  final String departmentLabel;
  final String status;
  final int assigned;
  final int gaps;
  final bool saving;
  final VoidCallback onPickDate;
  final VoidCallback onCopyPrevious;

  const _HeaderPanel({
    required this.dateText,
    required this.departmentLabel,
    required this.status,
    required this.assigned,
    required this.gaps,
    required this.saving,
    required this.onPickDate,
    required this.onCopyPrevious,
  });

  @override
  Widget build(BuildContext context) {
    final published = status == 'published';
    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.calendar_month, color: AppTheme.primaryBlue),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '$departmentLabel planned duty roster',
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontSize: 18,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                _StatusPill(
                  label: published ? 'Published' : 'Draft',
                  color: published
                      ? AppTheme.successOnSurface
                      : AppTheme.warningOnSurface,
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                ActionChip(
                  avatar: const Icon(Icons.event, size: 18),
                  label: Text(dateText),
                  onPressed: saving ? null : onPickDate,
                ),
                _StatusPill(
                  label: '$assigned assigned',
                  color: AppTheme.primaryBlue,
                ),
                _StatusPill(
                  label: '$gaps gaps',
                  color: gaps == 0
                      ? AppTheme.successOnSurface
                      : AppTheme.errorOnSurface,
                ),
              ],
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: saving ? null : onCopyPrevious,
              icon: const Icon(Icons.content_copy_outlined),
              label: const Text('Copy previous matching shift'),
            ),
          ],
        ),
      ),
    );
  }
}

class _ShiftSelector extends StatelessWidget {
  final List<Map<String, dynamic>> shifts;
  final String? selected;
  final String Function(dynamic value, {String fallback}) asText;
  final ValueChanged<String> onChanged;

  const _ShiftSelector({
    required this.shifts,
    required this.selected,
    required this.asText,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    if (shifts.isEmpty) {
      return const _EmptyCard(
        icon: Icons.schedule_outlined,
        text: 'No active shifts configured',
      );
    }
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: shifts.map((shift) {
        final label = asText(shift['name']);
        final isSelected = label == selected;
        return ChoiceChip(
          label: Text(label),
          selected: isSelected,
          onSelected: (_) => onChanged(label),
          avatar: const Icon(Icons.schedule, size: 18),
          selectedColor: AppTheme.primaryBlue.withValues(alpha: 0.18),
          labelStyle: TextStyle(
            color: isSelected ? AppTheme.primaryBlue : AppTheme.textPrimary,
            fontWeight: FontWeight.w700,
          ),
        );
      }).toList(),
    );
  }
}

class _RosterLegend extends StatelessWidget {
  final int staffCount;
  final int targetCount;

  const _RosterLegend({required this.staffCount, required this.targetCount});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Text(
            'Assign one staff member to each floor or zone for this shift.',
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ),
        _StatusPill(label: '$staffCount staff', color: AppTheme.primaryTeal),
        const SizedBox(width: 8),
        _StatusPill(label: '$targetCount posts', color: AppTheme.primaryBlue),
      ],
    );
  }
}

class _RosterSignals extends StatelessWidget {
  final List<Map<String, dynamic>> requests;
  final List<Map<String, dynamic>> leaveCoverage;
  final bool saving;
  final int? Function(dynamic value) asInt;
  final String Function(dynamic value, {String fallback}) asText;
  final void Function(int requestId, String decision) onReview;

  const _RosterSignals({
    required this.requests,
    required this.leaveCoverage,
    required this.saving,
    required this.asInt,
    required this.asText,
    required this.onReview,
  });

  @override
  Widget build(BuildContext context) {
    if (requests.isEmpty && leaveCoverage.isEmpty) {
      return const SizedBox.shrink();
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (requests.isNotEmpty) ...[
          Text(
            'Duty requests',
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 8),
          ...requests.take(6).map((request) {
            final id = asInt(request['id']);
            final status = asText(request['status'], fallback: 'pending');
            return Card(
              color: AppTheme.cardSurface,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(
                          Icons.how_to_reg_outlined,
                          color: AppTheme.primaryBlue,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            asText(request['staff_name'], fallback: 'Staff'),
                            style: TextStyle(
                              color: AppTheme.textPrimary,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        _StatusPill(
                          label: status,
                          color: status == 'approved'
                              ? AppTheme.successOnSurface
                              : AppTheme.warningOnSurface,
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      [
                        asText(request['shift_label'], fallback: 'Any shift'),
                        asText(
                          request['assignment_target_label'],
                          fallback: 'Any post',
                        ),
                        asText(request['reason'], fallback: ''),
                      ].where((part) => part.isNotEmpty).join(' - '),
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                    if (status == 'pending' && id != null) ...[
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: saving
                                  ? null
                                  : () => onReview(id, 'rejected'),
                              icon: const Icon(Icons.close),
                              label: const Text('Reject'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: FilledButton.icon(
                              onPressed: saving
                                  ? null
                                  : () => onReview(id, 'approved'),
                              icon: const Icon(Icons.check),
                              label: const Text('Approve'),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            );
          }),
          const SizedBox(height: 8),
        ],
        if (leaveCoverage.isNotEmpty) ...[
          Text(
            'Leave and alternate cover',
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 8),
          ...leaveCoverage
              .take(6)
              .map(
                (leave) => Card(
                  color: AppTheme.cardSurface,
                  child: ListTile(
                    leading: Icon(
                      Icons.event_busy_outlined,
                      color: AppTheme.warningOnSurface,
                    ),
                    title: Text(
                      asText(leave['staff_name'], fallback: 'Staff on leave'),
                      style: TextStyle(
                        color: AppTheme.textPrimary,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    subtitle: Text(
                      [
                        asText(leave['leave_type'], fallback: 'Leave'),
                        asText(leave['leave_status'], fallback: ''),
                        asText(
                          leave['replacement_staff_name'],
                          fallback: 'No alternate approved',
                        ),
                      ].where((part) => part.isNotEmpty).join(' - '),
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                  ),
                ),
              ),
        ],
      ],
    );
  }
}

class _ZoneAssignmentCard extends StatelessWidget {
  final Map<String, dynamic> target;
  final List<Map<String, dynamic>> staff;
  final int? selectedStaffId;
  final bool saving;
  final ValueChanged<int?> onChanged;
  final int? Function(dynamic value) asInt;
  final String Function(dynamic value, {String fallback}) asText;

  const _ZoneAssignmentCard({
    required this.target,
    required this.staff,
    required this.selectedStaffId,
    required this.saving,
    required this.onChanged,
    required this.asInt,
    required this.asText,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  height: 40,
                  width: 40,
                  decoration: BoxDecoration(
                    color: AppTheme.primaryTeal.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(
                    Icons.location_on_outlined,
                    color: AppTheme.primaryTeal,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        asText(target['label'] ?? target['name']),
                        style: TextStyle(
                          color: AppTheme.textPrimary,
                          fontSize: 16,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${asText(target['building'], fallback: 'Building not set')} - Floor ${asText(target['floor'])}',
                        style: TextStyle(color: AppTheme.textSecondary),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<int?>(
              initialValue: selectedStaffId,
              decoration: const InputDecoration(
                labelText: 'Assigned staff',
                prefixIcon: Icon(Icons.badge_outlined),
              ),
              items: [
                const DropdownMenuItem<int?>(
                  value: null,
                  child: Text('Unassigned'),
                ),
                ...staff.map(
                  (row) => DropdownMenuItem<int?>(
                    value: asInt(row['id']),
                    child: Text(
                      '${asText(row['name'])} - ${asText(row['employee_id'], fallback: 'no ID')}',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ),
              ],
              onChanged: saving ? null : onChanged,
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String label;
  final Color color;

  const _StatusPill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        border: Border.all(color: color.withValues(alpha: 0.35)),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  final String error;

  const _ErrorBanner({required this.error});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.errorOnSurface.withValues(alpha: 0.12),
        border: Border.all(
          color: AppTheme.errorOnSurface.withValues(alpha: 0.4),
        ),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, color: AppTheme.errorOnSurface),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              error,
              style: TextStyle(color: AppTheme.errorOnSurface),
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyCard extends StatelessWidget {
  final IconData icon;
  final String text;

  const _EmptyCard({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Row(
          children: [
            Icon(icon, color: AppTheme.textSecondary),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                text,
                style: TextStyle(color: AppTheme.textSecondary),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
