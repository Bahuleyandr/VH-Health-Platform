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
  int _tabIndex = 0;
  String _targetType = 'housekeeping_zone';
  String _departmentLabel = 'Housekeeping';

  final Map<String, Map<int, int?>> _assignmentsByShift = {};

  List<Map<String, dynamic>> _shifts = [];
  List<Map<String, dynamic>> _staff = [];
  List<Map<String, dynamic>> _targets = [];
  List<Map<String, dynamic>> _boards = [];
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

  String _shiftKey(String value) => value.trim().toLowerCase();

  String _shiftWindow(_ShiftColumn shift) {
    final start = shift.startTime.length >= 5
        ? shift.startTime.substring(0, 5)
        : shift.startTime;
    final end = shift.endTime.length >= 5
        ? shift.endTime.substring(0, 5)
        : shift.endTime;
    return '$start-$end';
  }

  List<_ShiftColumn> get _shiftColumns {
    final result = <_ShiftColumn>[];
    final added = <String>{};

    Map<String, dynamic>? findNamedShift(String name) {
      final wanted = _shiftKey(name);
      for (final shift in _shifts) {
        final label = _asText(shift['name']);
        final key = _shiftKey(label);
        if (key == wanted || key.contains(wanted)) return shift;
      }
      return null;
    }

    void addColumn(_ShiftColumn column) {
      final key = _shiftKey(column.label);
      if (key.isEmpty || added.contains(key)) return;
      added.add(key);
      result.add(column);
    }

    for (final preset in const [
      ['Morning', '08:00:00', '14:00:00'],
      ['Evening', '14:00:00', '20:00:00'],
      ['Night', '20:00:00', '08:00:00'],
    ]) {
      final shift = findNamedShift(preset[0]);
      addColumn(
        _ShiftColumn(
          label: _asText(shift?['name'], fallback: preset[0]),
          shiftId: _asInt(shift?['id']),
          startTime: _asText(shift?['start_time'], fallback: preset[1]),
          endTime: _asText(shift?['end_time'], fallback: preset[2]),
          isCustom: false,
        ),
      );
    }

    for (final shift in _shifts) {
      final label = _asText(shift['name']);
      final key = _shiftKey(label);
      final regular =
          key.contains('morning') ||
          key.contains('evening') ||
          key.contains('night');
      if (regular) continue;
      addColumn(
        _ShiftColumn(
          label: label,
          shiftId: _asInt(shift['id']),
          startTime: _asText(shift['start_time'], fallback: '08:00:00'),
          endTime: _asText(shift['end_time'], fallback: '16:00:00'),
          isCustom: true,
        ),
      );
    }

    for (final board in _boards) {
      final label = _asText(board['shift_label']);
      addColumn(
        _ShiftColumn(
          label: label,
          shiftId: _asInt(board['shift_id']),
          startTime: _asText(board['shift_start'], fallback: '08:00:00'),
          endTime: _asText(board['shift_end'], fallback: '16:00:00'),
          isCustom: ![
            'morning',
            'evening',
            'night',
          ].any((part) => _shiftKey(label).contains(part)),
        ),
      );
    }

    return result;
  }

  void _applyBoardSelections() {
    _assignmentsByShift.clear();
    for (final shift in _shiftColumns) {
      _assignmentsByShift[shift.label] = _emptyTargetMap();
    }

    for (final board in _boards) {
      final shiftLabel = _asText(board['shift_label']);
      final shiftMap = _assignmentsByShift.putIfAbsent(
        shiftLabel,
        _emptyTargetMap,
      );
      final assignments = _asMapList(board['assignments']);
      for (final assignment in assignments) {
        final targetId = _asInt(
          assignment['assignment_target_id'] ?? assignment['target_id'],
        );
        final staffId = _asInt(assignment['staff_id']);
        if (targetId != null && staffId != null) {
          shiftMap[targetId] = staffId;
        }
      }
    }
  }

  Map<int, int?> _emptyTargetMap() {
    final map = <int, int?>{};
    for (final target in _targets) {
      final id = _asInt(target['id']);
      if (id != null) map[id] = null;
    }
    return map;
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
      if (!mounted) return;
      setState(() {
        _shifts = _asMapList(data['shifts']);
        _staff = _asMapList(data['staff']);
        _targets = _asMapList(data['targets']);
        _boards = _asMapList(data['boards']);
        _requests = _asMapList(data['requests']);
        _leaveCoverage = _asMapList(data['leave_coverage']);
        _targetType = _asText(data['target_type'], fallback: _targetType);
        _departmentLabel = _asText(
          data['department_label'],
          fallback: _departmentLabel,
        );
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
    setState(() => _date = picked);
    await _load();
  }

  int _assignedCountForShift(String shiftLabel) {
    return _assignmentsByShift[shiftLabel]?.values
            .where((staffId) => staffId != null)
            .length ??
        0;
  }

  int _totalAssignedCount() {
    return _assignmentsByShift.values.fold<int>(
      0,
      (sum, row) => sum + row.values.where((staffId) => staffId != null).length,
    );
  }

  int _gapCount() {
    if (_targets.isEmpty || _shiftColumns.isEmpty) return 0;
    return _shiftColumns.fold<int>(
      0,
      (sum, shift) =>
          sum + (_targets.length - _assignedCountForShift(shift.label)),
    );
  }

  String _statusText() {
    if (_boards.isEmpty) return 'draft';
    final published = _boards.where(
      (row) => _asText(row['status']) == 'published',
    );
    return published.length == _boards.length ? 'published' : 'draft';
  }

  bool _isStaffAssignedInOtherShift(int staffId, String shiftLabel) {
    for (final entry in _assignmentsByShift.entries) {
      if (_shiftKey(entry.key) == _shiftKey(shiftLabel)) continue;
      if (entry.value.values.contains(staffId)) return true;
    }
    return false;
  }

  String? _staffAssignedShift(int staffId) {
    for (final entry in _assignmentsByShift.entries) {
      if (entry.value.values.contains(staffId)) return entry.key;
    }
    return null;
  }

  int? _staffAssignedTarget(int staffId) {
    for (final entry in _assignmentsByShift.entries) {
      for (final targetEntry in entry.value.entries) {
        if (targetEntry.value == staffId) return targetEntry.key;
      }
    }
    return null;
  }

  String? _staffAssignedTargetLabel(int staffId) {
    final targetId = _staffAssignedTarget(staffId);
    if (targetId == null) return null;
    final target = _targetById(targetId);
    if (target == null) return null;
    return _asText(target['label'] ?? target['name']);
  }

  Map<String, dynamic>? _staffById(int staffId) {
    for (final row in _staff) {
      if (_asInt(row['id']) == staffId) return row;
    }
    return null;
  }

  Map<String, dynamic>? _targetById(int targetId) {
    for (final target in _targets) {
      if (_asInt(target['id']) == targetId) return target;
    }
    return null;
  }

  int? _assignedStaffForCell(String shiftLabel, int targetId) {
    return _assignmentsByShift[shiftLabel]?[targetId];
  }

  bool _targetOccupiedByOtherStaff({
    required String shiftLabel,
    required int targetId,
    required int staffId,
  }) {
    final assigned = _assignedStaffForCell(shiftLabel, targetId);
    return assigned != null && assigned != staffId;
  }

  void _setCellAssignment(String shiftLabel, int targetId, int? staffId) {
    if (staffId != null && _isStaffAssignedInOtherShift(staffId, shiftLabel)) {
      final staff = _staffById(staffId);
      final otherShift = _staffAssignedShift(staffId);
      _showSnack(
        '${_asText(staff?['name'], fallback: 'Staff')} is already assigned to $otherShift on this date.',
        AppTheme.errorRed,
      );
      return;
    }
    setState(() {
      final shiftMap = _assignmentsByShift.putIfAbsent(
        shiftLabel,
        _emptyTargetMap,
      );
      shiftMap[targetId] = staffId;
    });
  }

  void _clearStaffFromAllShifts(int staffId) {
    for (final shiftMap in _assignmentsByShift.values) {
      for (final targetId in shiftMap.keys.toList()) {
        if (shiftMap[targetId] == staffId) shiftMap[targetId] = null;
      }
    }
  }

  int? _firstAvailableTarget(String shiftLabel, {int? preferredTargetId}) {
    final shiftMap = _assignmentsByShift[shiftLabel] ?? _emptyTargetMap();
    if (preferredTargetId != null && shiftMap[preferredTargetId] == null) {
      return preferredTargetId;
    }
    for (final target in _targets) {
      final targetId = _asInt(target['id']);
      if (targetId != null && shiftMap[targetId] == null) return targetId;
    }
    return null;
  }

  void _setStaffShift(int staffId, String? shiftLabel) {
    setState(() {
      final previousTarget = _staffAssignedTarget(staffId);
      _clearStaffFromAllShifts(staffId);
      if (shiftLabel == null) return;
      final targetId = _firstAvailableTarget(
        shiftLabel,
        preferredTargetId: previousTarget,
      );
      if (targetId != null) {
        final shiftMap = _assignmentsByShift.putIfAbsent(
          shiftLabel,
          _emptyTargetMap,
        );
        shiftMap[targetId] = staffId;
      }
    });
  }

  void _setStaffTarget(int staffId, int? targetId) {
    final shiftLabel = _staffAssignedShift(staffId);
    if (shiftLabel == null) {
      _showSnack('Select a shift before selecting a floor.', AppTheme.errorRed);
      return;
    }
    if (targetId == null) {
      setState(() => _clearStaffFromAllShifts(staffId));
      return;
    }
    if (_targetOccupiedByOtherStaff(
      shiftLabel: shiftLabel,
      targetId: targetId,
      staffId: staffId,
    )) {
      _showSnack(
        'That floor already has staff for this shift.',
        AppTheme.errorRed,
      );
      return;
    }
    setState(() {
      _clearStaffFromAllShifts(staffId);
      final shiftMap = _assignmentsByShift.putIfAbsent(
        shiftLabel,
        _emptyTargetMap,
      );
      shiftMap[targetId] = staffId;
    });
  }

  List<Map<String, dynamic>> _buildAssignmentsForShift(String shiftLabel) {
    final result = <Map<String, dynamic>>[];
    final shiftMap = _assignmentsByShift[shiftLabel] ?? {};
    for (final entry in shiftMap.entries) {
      final targetId = entry.key;
      final staffId = entry.value;
      if (staffId == null) continue;
      final target = _targetById(targetId);
      if (target == null) continue;
      result.add({
        'staff_id': staffId,
        'assignment_target_type': _targetType,
        'assignment_target_id': targetId,
        'assignment_target_label': _asText(target['label'] ?? target['name']),
        'floor': target['floor'],
        'building': target['building'],
      });
    }
    return result;
  }

  List<Map<String, dynamic>> _buildDayBoards() {
    return _shiftColumns
        .map(
          (shift) => {
            'shift_label': shift.label,
            'shift_id': ?shift.shiftId,
            'notes': '$_departmentLabel ${shift.label} roster',
            'assignments': _buildAssignmentsForShift(shift.label),
          },
        )
        .toList();
  }

  Future<Map<String, dynamic>?> _saveDraft({bool quiet = false}) async {
    if (_shiftColumns.isEmpty) {
      _showSnack('No roster shifts are configured.', AppTheme.errorRed);
      return null;
    }
    setState(() => _saving = true);
    try {
      final saved = await HrApiService.saveRosterDay(
        department: widget.department,
        rosterDate: _dateText(_date),
        boards: _buildDayBoards(),
        reason: 'Saved from $_departmentLabel roster grid',
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
    setState(() => _saving = true);
    try {
      final saved = await HrApiService.saveRosterDay(
        department: widget.department,
        rosterDate: _dateText(_date),
        boards: _buildDayBoards(),
        reason: 'Saved before publishing $_departmentLabel roster',
      );
      final boards = _asMapList(saved['boards']);
      var publishedCount = 0;
      for (final board in boards) {
        final boardId = _asInt(board['id']);
        final assignments = _asMapList(board['assignments']);
        if (boardId == null || assignments.isEmpty) continue;
        await HrApiService.publishRosterBoard(
          rosterId: boardId,
          reason: 'Published from $_departmentLabel roster grid',
        );
        publishedCount += 1;
      }
      _showSnack(
        publishedCount == 0
            ? 'Saved draft; no assigned shifts to publish.'
            : 'Published $publishedCount shift roster${publishedCount == 1 ? '' : 's'}',
        AppTheme.successGreen,
      );
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
    setState(() => _saving = true);
    try {
      var copied = 0;
      var failed = 0;
      for (final shift in _shiftColumns) {
        try {
          await HrApiService.copyPreviousRosterBoard(
            department: widget.department,
            rosterDate: _dateText(_date),
            shiftLabel: shift.label,
          );
          copied += 1;
        } catch (_) {
          failed += 1;
        }
      }
      await _load();
      _showSnack(
        copied > 0
            ? 'Copied $copied previous shift roster${copied == 1 ? '' : 's'}'
            : 'No previous roster found for these shifts.',
        copied > 0 ? AppTheme.successGreen : AppTheme.warningOnSurface,
      );
      if (failed > 0 && copied > 0) {
        _showSnack(
          '$failed shift${failed == 1 ? '' : 's'} had no previous roster.',
          AppTheme.warningOnSurface,
        );
      }
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

  Future<void> _addCustomShift() async {
    final result = await showDialog<_CustomShiftDraft>(
      context: context,
      builder: (context) =>
          _CustomShiftDialog(departmentLabel: _departmentLabel),
    );
    if (result == null) return;

    setState(() => _saving = true);
    try {
      await HrApiService.createCustomShift(
        name: result.name,
        startTime: result.startTime,
        endTime: result.endTime,
        department: widget.department,
      );
      _showSnack('Custom shift added', AppTheme.successGreen);
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
    final assigned = _totalAssignedCount();
    final status = _statusText();
    final gaps = _gapCount();

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
                    gaps: gaps,
                    saving: _saving,
                    onPickDate: _pickDate,
                    onCopyPrevious: _copyPrevious,
                    onAddCustomShift: _addCustomShift,
                  ),
                  const SizedBox(height: 12),
                  _RosterLegend(
                    staffCount: _staff.length,
                    targetCount: _targets.length,
                    shiftCount: _shiftColumns.length,
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
                  const SizedBox(height: 12),
                  _RosterTabs(
                    selectedIndex: _tabIndex,
                    onChanged: (index) => setState(() => _tabIndex = index),
                  ),
                  const SizedBox(height: 12),
                  if (_targets.isEmpty)
                    _EmptyCard(
                      icon: Icons.map_outlined,
                      text:
                          'No active $_departmentLabel roster targets configured',
                    )
                  else if (_tabIndex == 0)
                    _FloorShiftGrid(
                      shifts: _shiftColumns,
                      targets: _targets,
                      staff: _staff,
                      saving: _saving,
                      asInt: _asInt,
                      asText: _asText,
                      shiftWindow: _shiftWindow,
                      selectedStaffForCell: _assignedStaffForCell,
                      isStaffAssignedInOtherShift: _isStaffAssignedInOtherShift,
                      assignedCountForShift: _assignedCountForShift,
                      onChanged: _setCellAssignment,
                      onAddCustomShift: _addCustomShift,
                    )
                  else
                    _StaffWiseRoster(
                      shifts: _shiftColumns,
                      targets: _targets,
                      staff: _staff,
                      saving: _saving,
                      asInt: _asInt,
                      asText: _asText,
                      staffAssignedShift: _staffAssignedShift,
                      staffAssignedTarget: _staffAssignedTarget,
                      staffAssignedTargetLabel: _staffAssignedTargetLabel,
                      targetOccupiedByOtherStaff: _targetOccupiedByOtherStaff,
                      onShiftChanged: _setStaffShift,
                      onTargetChanged: _setStaffTarget,
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
                          label: const Text('Publish roster'),
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

class _ShiftColumn {
  final String label;
  final int? shiftId;
  final String startTime;
  final String endTime;
  final bool isCustom;

  const _ShiftColumn({
    required this.label,
    required this.shiftId,
    required this.startTime,
    required this.endTime,
    required this.isCustom,
  });
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
  final VoidCallback onAddCustomShift;

  const _HeaderPanel({
    required this.dateText,
    required this.departmentLabel,
    required this.status,
    required this.assigned,
    required this.gaps,
    required this.saving,
    required this.onPickDate,
    required this.onCopyPrevious,
    required this.onAddCustomShift,
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
                    '$departmentLabel duty deployment',
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
                  label: '$assigned assignments',
                  color: AppTheme.primaryBlue,
                ),
                _StatusPill(
                  label: '$gaps open cells',
                  color: gaps == 0
                      ? AppTheme.successOnSurface
                      : AppTheme.errorOnSurface,
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: saving ? null : onCopyPrevious,
                  icon: const Icon(Icons.content_copy_outlined),
                  label: const Text('Copy previous'),
                ),
                OutlinedButton.icon(
                  onPressed: saving ? null : onAddCustomShift,
                  icon: const Icon(Icons.add_alarm_outlined),
                  label: const Text('Add custom shift'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _RosterLegend extends StatelessWidget {
  final int staffCount;
  final int targetCount;
  final int shiftCount;

  const _RosterLegend({
    required this.staffCount,
    required this.targetCount,
    required this.shiftCount,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Text(
            'Assign each floor or zone under Morning, Evening, Night, or a custom shift.',
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ),
        _StatusPill(label: '$staffCount staff', color: AppTheme.primaryTeal),
        const SizedBox(width: 8),
        _StatusPill(label: '$targetCount floors', color: AppTheme.primaryBlue),
        const SizedBox(width: 8),
        _StatusPill(
          label: '$shiftCount shifts',
          color: AppTheme.warningOnSurface,
        ),
      ],
    );
  }
}

class _RosterTabs extends StatelessWidget {
  final int selectedIndex;
  final ValueChanged<int> onChanged;

  const _RosterTabs({required this.selectedIndex, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Card(
      color: AppTheme.cardSurface,
      child: Row(
        children: [
          Expanded(
            child: _TabButton(
              icon: Icons.view_week_outlined,
              label: 'By floor',
              selected: selectedIndex == 0,
              onPressed: () => onChanged(0),
            ),
          ),
          Expanded(
            child: _TabButton(
              icon: Icons.badge_outlined,
              label: 'By staff',
              selected: selectedIndex == 1,
              onPressed: () => onChanged(1),
            ),
          ),
        ],
      ),
    );
  }
}

class _TabButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onPressed;

  const _TabButton({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onPressed,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        height: 48,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          border: Border(
            bottom: BorderSide(
              color: selected ? AppTheme.primaryBlue : Colors.transparent,
              width: 3,
            ),
          ),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              icon,
              size: 18,
              color: selected ? AppTheme.primaryBlue : AppTheme.textSecondary,
            ),
            const SizedBox(width: 6),
            Text(
              label,
              style: TextStyle(
                color: selected ? AppTheme.primaryBlue : AppTheme.textSecondary,
                fontWeight: FontWeight.w800,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _FloorShiftGrid extends StatelessWidget {
  final List<_ShiftColumn> shifts;
  final List<Map<String, dynamic>> targets;
  final List<Map<String, dynamic>> staff;
  final bool saving;
  final int? Function(dynamic value) asInt;
  final String Function(dynamic value, {String fallback}) asText;
  final String Function(_ShiftColumn shift) shiftWindow;
  final int? Function(String shiftLabel, int targetId) selectedStaffForCell;
  final bool Function(int staffId, String shiftLabel)
  isStaffAssignedInOtherShift;
  final int Function(String shiftLabel) assignedCountForShift;
  final void Function(String shiftLabel, int targetId, int? staffId) onChanged;
  final VoidCallback onAddCustomShift;

  const _FloorShiftGrid({
    required this.shifts,
    required this.targets,
    required this.staff,
    required this.saving,
    required this.asInt,
    required this.asText,
    required this.shiftWindow,
    required this.selectedStaffForCell,
    required this.isStaffAssignedInOtherShift,
    required this.assignedCountForShift,
    required this.onChanged,
    required this.onAddCustomShift,
  });

  @override
  Widget build(BuildContext context) {
    if (shifts.isEmpty) {
      return const _EmptyCard(
        icon: Icons.schedule_outlined,
        text: 'No active shifts configured',
      );
    }

    const floorWidth = 190.0;
    const shiftWidth = 240.0;
    const addWidth = 150.0;

    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: SizedBox(
            width: floorWidth + (shiftWidth * shifts.length) + addWidth,
            child: Column(
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _GridHeaderCell(
                      width: floorWidth,
                      title: 'Floor / Zone',
                      subtitle: '${targets.length} active',
                    ),
                    ...shifts.map(
                      (shift) => _GridHeaderCell(
                        width: shiftWidth,
                        title: shift.label,
                        subtitle:
                            '${shiftWindow(shift)} - ${assignedCountForShift(shift.label)} assigned',
                        highlighted: !shift.isCustom,
                      ),
                    ),
                    _AddShiftColumnHeader(
                      width: addWidth,
                      onPressed: saving ? null : onAddCustomShift,
                    ),
                  ],
                ),
                const Divider(height: 1),
                ...targets.map((target) {
                  final targetId = asInt(target['id']);
                  if (targetId == null) return const SizedBox.shrink();
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _TargetCell(
                        width: floorWidth,
                        target: target,
                        asText: asText,
                      ),
                      ...shifts.map(
                        (shift) => _AssignmentDropdownCell(
                          width: shiftWidth,
                          shiftLabel: shift.label,
                          targetId: targetId,
                          staff: staff,
                          selectedStaffId: selectedStaffForCell(
                            shift.label,
                            targetId,
                          ),
                          saving: saving,
                          asInt: asInt,
                          asText: asText,
                          isStaffAssignedInOtherShift:
                              isStaffAssignedInOtherShift,
                          onChanged: onChanged,
                        ),
                      ),
                      Container(
                        width: addWidth,
                        constraints: const BoxConstraints(minHeight: 76),
                        decoration: BoxDecoration(
                          border: Border(
                            left: BorderSide(
                              color: AppTheme.divider.withValues(alpha: 0.5),
                            ),
                            bottom: BorderSide(
                              color: AppTheme.divider.withValues(alpha: 0.5),
                            ),
                          ),
                        ),
                      ),
                    ],
                  );
                }),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _GridHeaderCell extends StatelessWidget {
  final double width;
  final String title;
  final String subtitle;
  final bool highlighted;

  const _GridHeaderCell({
    required this.width,
    required this.title,
    required this.subtitle,
    this.highlighted = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      constraints: const BoxConstraints(minHeight: 70),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: highlighted
            ? AppTheme.primaryBlue.withValues(alpha: 0.08)
            : AppTheme.backgroundGrey,
        border: Border(
          right: BorderSide(color: AppTheme.divider.withValues(alpha: 0.5)),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            subtitle,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
          ),
        ],
      ),
    );
  }
}

class _AddShiftColumnHeader extends StatelessWidget {
  final double width;
  final VoidCallback? onPressed;

  const _AddShiftColumnHeader({required this.width, required this.onPressed});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      constraints: const BoxConstraints(minHeight: 70),
      padding: const EdgeInsets.all(10),
      color: AppTheme.backgroundGrey,
      child: OutlinedButton.icon(
        onPressed: onPressed,
        icon: const Icon(Icons.add_alarm_outlined, size: 18),
        label: const Text('Custom'),
      ),
    );
  }
}

class _TargetCell extends StatelessWidget {
  final double width;
  final Map<String, dynamic> target;
  final String Function(dynamic value, {String fallback}) asText;

  const _TargetCell({
    required this.width,
    required this.target,
    required this.asText,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      constraints: const BoxConstraints(minHeight: 76),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        border: Border(
          right: BorderSide(color: AppTheme.divider.withValues(alpha: 0.5)),
          bottom: BorderSide(color: AppTheme.divider.withValues(alpha: 0.5)),
        ),
      ),
      child: Row(
        children: [
          Container(
            height: 34,
            width: 34,
            decoration: BoxDecoration(
              color: AppTheme.primaryTeal.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Icon(
              Icons.location_on_outlined,
              color: AppTheme.primaryTeal,
              size: 18,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  asText(target['label'] ?? target['name']),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  [
                    asText(target['building'], fallback: ''),
                    'Floor ${asText(target['floor'])}',
                  ].where((part) => part.trim().isNotEmpty).join(' - '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _AssignmentDropdownCell extends StatelessWidget {
  final double width;
  final String shiftLabel;
  final int targetId;
  final List<Map<String, dynamic>> staff;
  final int? selectedStaffId;
  final bool saving;
  final int? Function(dynamic value) asInt;
  final String Function(dynamic value, {String fallback}) asText;
  final bool Function(int staffId, String shiftLabel)
  isStaffAssignedInOtherShift;
  final void Function(String shiftLabel, int targetId, int? staffId) onChanged;

  const _AssignmentDropdownCell({
    required this.width,
    required this.shiftLabel,
    required this.targetId,
    required this.staff,
    required this.selectedStaffId,
    required this.saving,
    required this.asInt,
    required this.asText,
    required this.isStaffAssignedInOtherShift,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      constraints: const BoxConstraints(minHeight: 76),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
      decoration: BoxDecoration(
        border: Border(
          right: BorderSide(color: AppTheme.divider.withValues(alpha: 0.5)),
          bottom: BorderSide(color: AppTheme.divider.withValues(alpha: 0.5)),
        ),
      ),
      child: DropdownButtonFormField<int?>(
        key: ValueKey('$shiftLabel-$targetId-$selectedStaffId'),
        initialValue: selectedStaffId,
        isExpanded: true,
        decoration: const InputDecoration(
          labelText: 'Staff',
          prefixIcon: Icon(Icons.badge_outlined),
        ),
        items: [
          const DropdownMenuItem<int?>(value: null, child: Text('Unassigned')),
          ...staff.map((row) {
            final staffId = asInt(row['id']);
            final disabled =
                staffId != null &&
                staffId != selectedStaffId &&
                isStaffAssignedInOtherShift(staffId, shiftLabel);
            return DropdownMenuItem<int?>(
              value: staffId,
              enabled: !disabled,
              child: Text(
                '${asText(row['name'])} - ${asText(row['employee_id'], fallback: 'no ID')}',
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: disabled
                      ? AppTheme.textSecondary
                      : AppTheme.textPrimary,
                ),
              ),
            );
          }),
        ],
        onChanged: saving
            ? null
            : (staffId) => onChanged(shiftLabel, targetId, staffId),
      ),
    );
  }
}

class _StaffWiseRoster extends StatelessWidget {
  final List<_ShiftColumn> shifts;
  final List<Map<String, dynamic>> targets;
  final List<Map<String, dynamic>> staff;
  final bool saving;
  final int? Function(dynamic value) asInt;
  final String Function(dynamic value, {String fallback}) asText;
  final String? Function(int staffId) staffAssignedShift;
  final int? Function(int staffId) staffAssignedTarget;
  final String? Function(int staffId) staffAssignedTargetLabel;
  final bool Function({
    required String shiftLabel,
    required int targetId,
    required int staffId,
  })
  targetOccupiedByOtherStaff;
  final void Function(int staffId, String? shiftLabel) onShiftChanged;
  final void Function(int staffId, int? targetId) onTargetChanged;

  const _StaffWiseRoster({
    required this.shifts,
    required this.targets,
    required this.staff,
    required this.saving,
    required this.asInt,
    required this.asText,
    required this.staffAssignedShift,
    required this.staffAssignedTarget,
    required this.staffAssignedTargetLabel,
    required this.targetOccupiedByOtherStaff,
    required this.onShiftChanged,
    required this.onTargetChanged,
  });

  @override
  Widget build(BuildContext context) {
    if (staff.isEmpty) {
      return const _EmptyCard(
        icon: Icons.badge_outlined,
        text: 'No active staff found for this department',
      );
    }

    return Column(
      children: staff.map((row) {
        final staffId = asInt(row['id']);
        if (staffId == null) return const SizedBox.shrink();
        final selectedShift = staffAssignedShift(staffId);
        final selectedTarget = staffAssignedTarget(staffId);
        return Card(
          color: AppTheme.cardSurface,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  height: 42,
                  width: 42,
                  decoration: BoxDecoration(
                    color: AppTheme.primaryBlue.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(
                    Icons.person_outline,
                    color: AppTheme.primaryBlue,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  flex: 2,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        asText(row['name']),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: AppTheme.textPrimary,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        [
                          asText(row['employee_id'], fallback: 'No ID'),
                          asText(row['role'], fallback: ''),
                          staffAssignedTargetLabel(staffId) ?? 'Unassigned',
                        ].where((part) => part.trim().isNotEmpty).join(' - '),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: AppTheme.textSecondary),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: DropdownButtonFormField<String?>(
                    key: ValueKey('shift-$staffId-$selectedShift'),
                    initialValue: selectedShift,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: 'Shift',
                      prefixIcon: Icon(Icons.schedule_outlined),
                    ),
                    items: [
                      const DropdownMenuItem<String?>(
                        value: null,
                        child: Text('Off / Unassigned'),
                      ),
                      ...shifts.map(
                        (shift) => DropdownMenuItem<String?>(
                          value: shift.label,
                          child: Text(
                            shift.label,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ),
                    ],
                    onChanged: saving
                        ? null
                        : (value) => onShiftChanged(staffId, value),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: DropdownButtonFormField<int?>(
                    key: ValueKey('target-$staffId-$selectedTarget'),
                    initialValue: selectedTarget,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: 'Floor / Zone',
                      prefixIcon: Icon(Icons.location_on_outlined),
                    ),
                    items: [
                      const DropdownMenuItem<int?>(
                        value: null,
                        child: Text('Unassigned'),
                      ),
                      ...targets.map((target) {
                        final targetId = asInt(target['id']);
                        final disabled =
                            selectedShift != null &&
                            targetId != null &&
                            targetOccupiedByOtherStaff(
                              shiftLabel: selectedShift,
                              targetId: targetId,
                              staffId: staffId,
                            );
                        return DropdownMenuItem<int?>(
                          value: targetId,
                          enabled: !disabled,
                          child: Text(
                            asText(target['label'] ?? target['name']),
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: disabled
                                  ? AppTheme.textSecondary
                                  : AppTheme.textPrimary,
                            ),
                          ),
                        );
                      }),
                    ],
                    onChanged: saving
                        ? null
                        : (value) => onTargetChanged(staffId, value),
                  ),
                ),
              ],
            ),
          ),
        );
      }).toList(),
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

class _CustomShiftDraft {
  final String name;
  final String startTime;
  final String endTime;

  const _CustomShiftDraft({
    required this.name,
    required this.startTime,
    required this.endTime,
  });
}

class _CustomShiftDialog extends StatefulWidget {
  final String departmentLabel;

  const _CustomShiftDialog({required this.departmentLabel});

  @override
  State<_CustomShiftDialog> createState() => _CustomShiftDialogState();
}

class _CustomShiftDialogState extends State<_CustomShiftDialog> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _startController = TextEditingController();
  final _endController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _nameController.text =
        'Custom ${TimeOfDay.now().hour.toString().padLeft(2, '0')}';
  }

  @override
  void dispose() {
    _nameController.dispose();
    _startController.dispose();
    _endController.dispose();
    super.dispose();
  }

  String? _validateTime(String? value) {
    final text = value?.trim() ?? '';
    final valid = RegExp(r'^\d{2}:\d{2}$').hasMatch(text);
    if (!valid) return 'Use HH:MM';
    final parts = text.split(':').map(int.parse).toList();
    if (parts[0] > 23 || parts[1] > 59) return 'Use HH:MM';
    return null;
  }

  void _submit() {
    if (!_formKey.currentState!.validate()) return;
    Navigator.of(context).pop(
      _CustomShiftDraft(
        name: _nameController.text.trim(),
        startTime: _startController.text.trim(),
        endTime: _endController.text.trim(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppTheme.cardSurface,
      title: Text(
        'Add custom shift',
        style: TextStyle(color: AppTheme.textPrimary),
      ),
      content: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextFormField(
              controller: _nameController,
              decoration: InputDecoration(
                labelText: '${widget.departmentLabel} shift name',
                prefixIcon: const Icon(Icons.label_outline),
              ),
              validator: (value) {
                final text = value?.trim() ?? '';
                if (text.isEmpty) return 'Shift name is required';
                return null;
              },
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextFormField(
                    controller: _startController,
                    decoration: const InputDecoration(
                      labelText: 'Start',
                      hintText: '07:30',
                      prefixIcon: Icon(Icons.play_arrow_outlined),
                    ),
                    validator: _validateTime,
                    keyboardType: TextInputType.datetime,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: TextFormField(
                    controller: _endController,
                    decoration: const InputDecoration(
                      labelText: 'End',
                      hintText: '12:30',
                      prefixIcon: Icon(Icons.stop_outlined),
                    ),
                    validator: _validateTime,
                    keyboardType: TextInputType.datetime,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton.icon(
          onPressed: _submit,
          icon: const Icon(Icons.add),
          label: const Text('Add'),
        ),
      ],
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
