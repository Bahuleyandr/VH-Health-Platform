import 'package:flutter/material.dart';

import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

class HousekeepingRosterBoardScreen extends StatefulWidget {
  final String department;
  final String title;

  const HousekeepingRosterBoardScreen({
    super.key,
    this.department = 'housekeeping',
    this.title = '',
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
  late DateTime _weekStart = _startOfWeek(DateTime.now());
  int _selectedDayIndex = DateTime.now().weekday - DateTime.monday;
  int _tabIndex = 0;
  String _targetType = 'housekeeping_zone';
  String _departmentLabel = '';
  String _governanceNote = '';
  bool _canEditRoster = true;
  bool _canReviewRosterRequests = true;
  bool _canForecastRoster = true;

  final Map<String, Map<String, Map<int, List<int>>>> _assignmentsByDate = {};

  List<Map<String, dynamic>> _shifts = [];
  List<Map<String, dynamic>> _staff = [];
  List<Map<String, dynamic>> _targets = [];
  final Map<String, List<Map<String, dynamic>>> _boardsByDate = {};
  final Map<String, List<Map<String, dynamic>>> _requestsByDate = {};
  final Map<String, List<Map<String, dynamic>>> _leaveCoverageByDate = {};
  final Map<String, Map<String, dynamic>> _forecastByDate = {};
  final Map<int, Map<String, dynamic>> _staffForecastById = {};
  Map<String, dynamic> _forecastOverlay = {};

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

  String _copy(String key) => AppStrings.of(context).lookup(key);

  String _format(String key, Map<String, Object?> values) =>
      AppStrings.of(context).format(key, values);

  String get _departmentPayloadLabel {
    final rawDepartment = widget.department.trim();
    return rawDepartment.isEmpty ? 'housekeeping' : rawDepartment;
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

  static DateTime _startOfWeek(DateTime date) {
    final clean = DateTime(date.year, date.month, date.day);
    return clean.subtract(Duration(days: clean.weekday - DateTime.monday));
  }

  List<DateTime> get _weekDates =>
      List.generate(7, (index) => _weekStart.add(Duration(days: index)));

  DateTime get _selectedDate =>
      _weekDates[_selectedDayIndex.clamp(0, 6).toInt()];

  String get _selectedDateText => _dateText(_selectedDate);

  String get _weekRangeText => _format('s4.dynamic.housekeeping.week_range', {
    'start': _dateText(_weekStart),
    'end': _dateText(_weekStart.add(const Duration(days: 6))),
  });

  String _dayShortLabel(DateTime date) {
    final labels = [
      _copy('s4.lib.housekeeping_roster_board.day.mon'),
      _copy('s4.lib.housekeeping_roster_board.day.tue'),
      _copy('s4.lib.housekeeping_roster_board.day.wed'),
      _copy('s4.lib.housekeeping_roster_board.day.thu'),
      _copy('s4.lib.housekeeping_roster_board.day.fri'),
      _copy('s4.lib.housekeeping_roster_board.day.sat'),
      _copy('s4.lib.housekeeping_roster_board.day.sun'),
    ];
    final label = labels[date.weekday - DateTime.monday];
    return _format('s4.dynamic.housekeeping_roster_board.day_label', {
      'day': label,
      'date': '${date.day}/${date.month}',
    });
  }

  String _screenTitle() => widget.title.isEmpty
      ? _copy('role.feature.housekeeping_roster')
      : widget.title;

  String _reviewDecisionLabel(String decision) => switch (decision) {
    'accepted' => _copy('s4.lib.housekeeping_roster_board.accepted'),
    'approved' => _copy('s4.lib.leave_approvals.status.approved'),
    'discarded' => _copy('s4.lib.housekeeping_roster_board.discarded'),
    'rejected' => _copy('s4.lib.leave_approvals.status.rejected'),
    _ => decision,
  };

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

    for (final boards in _boardsByDate.values) {
      for (final board in boards) {
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
    }

    return result;
  }

  Map<String, Map<int, List<int>>> get _assignmentsByShift =>
      _assignmentsByDate.putIfAbsent(_selectedDateText, _emptyShiftMap);

  Map<String, Map<int, List<int>>> _emptyShiftMap() {
    final map = <String, Map<int, List<int>>>{};
    for (final shift in _shiftColumns) {
      map[shift.label] = _emptyTargetMap();
    }
    return map;
  }

  void _applyWeekSelections() {
    _assignmentsByDate.clear();
    for (final date in _weekDates) {
      final dateText = _dateText(date);
      final dateAssignments = _assignmentsByDate.putIfAbsent(
        dateText,
        _emptyShiftMap,
      );
      for (final shift in _shiftColumns) {
        dateAssignments.putIfAbsent(shift.label, _emptyTargetMap);
      }
      final boards = _boardsByDate[dateText] ?? [];
      for (final board in boards) {
        final shiftLabel = _asText(board['shift_label']);
        final shiftMap = dateAssignments.putIfAbsent(
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
            final staffIds = shiftMap.putIfAbsent(targetId, () => <int>[]);
            if (!staffIds.contains(staffId)) staffIds.add(staffId);
          }
        }
      }
    }
  }

  Map<int, List<int>> _emptyTargetMap() {
    final map = <int, List<int>>{};
    for (final target in _targets) {
      final id = _asInt(target['id']);
      if (id != null) map[id] = <int>[];
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
      final days = await Future.wait(
        _weekDates.map((date) async {
          final dateText = _dateText(date);
          final data = await HrApiService.getRosterBoard(
            department: widget.department,
            rosterDate: dateText,
          );
          return {'date': dateText, 'data': data};
        }),
      );
      if (!mounted) return;
      setState(() {
        _boardsByDate.clear();
        _requestsByDate.clear();
        _leaveCoverageByDate.clear();
        _forecastByDate.clear();
        _staffForecastById.clear();
        _forecastOverlay = {};

        for (var index = 0; index < days.length; index += 1) {
          final dateText = days[index]['date'] as String;
          final data = Map<String, dynamic>.from(days[index]['data'] as Map);
          final forecast = data['forecast_overlay'] is Map
              ? Map<String, dynamic>.from(data['forecast_overlay'] as Map)
              : <String, dynamic>{};
          if (index == 0) {
            final capabilities = data['capabilities'] is Map
                ? Map<String, dynamic>.from(data['capabilities'] as Map)
                : const <String, dynamic>{};
            _shifts = _asMapList(data['shifts']);
            _staff = _asMapList(data['staff']);
            _targets = _asMapList(data['targets']);
            _targetType = _asText(data['target_type'], fallback: _targetType);
            _departmentLabel = _asText(
              data['department_label'],
              fallback: _copy('role.roster_department.housekeeping'),
            );
            _governanceNote = _asText(data['governance_note'], fallback: '');
            _canEditRoster = capabilities['can_edit'] != false;
            _canReviewRosterRequests =
                capabilities['can_review_requests'] != false;
            _canForecastRoster = capabilities['can_forecast'] != false;
            _forecastOverlay = forecast;
          }
          _boardsByDate[dateText] = _asMapList(data['boards']);
          _requestsByDate[dateText] = _asMapList(data['requests']);
          _leaveCoverageByDate[dateText] = _asMapList(data['leave_coverage']);
          final selectedDateRisk = forecast['selected_date_risk'];
          if (selectedDateRisk is Map) {
            _forecastByDate[dateText] = Map<String, dynamic>.from(
              selectedDateRisk,
            );
          }
          for (final score in _asMapList(forecast['staff_scores'])) {
            final staffId = _asInt(score['staff_id']);
            if (staffId != null) _staffForecastById[staffId] = score;
          }
        }
        _applyWeekSelections();
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickWeek() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _selectedDate,
      firstDate: DateTime.now().subtract(const Duration(days: 30)),
      lastDate: DateTime.now().add(const Duration(days: 180)),
    );
    if (picked == null) return;
    setState(() {
      _weekStart = _startOfWeek(picked);
      _selectedDayIndex = picked.weekday - DateTime.monday;
    });
    await _load();
  }

  List<Map<String, dynamic>> get _selectedRequests =>
      _requestsByDate[_selectedDateText] ?? const [];

  List<Map<String, dynamic>> get _selectedLeaveCoverage =>
      _leaveCoverageByDate[_selectedDateText] ?? const [];

  int _assignedCountForShift(String shiftLabel) {
    return _assignmentsByShift[shiftLabel]?.values.fold<int>(
          0,
          (sum, staffIds) => sum + staffIds.length,
        ) ??
        0;
  }

  int _assignedCountForDate(String dateText) {
    final rows = _assignmentsByDate[dateText];
    if (rows == null) return 0;
    return rows.values.fold<int>(
      0,
      (sum, row) =>
          sum +
          row.values.fold<int>(
            0,
            (cellSum, staffIds) => cellSum + staffIds.length,
          ),
    );
  }

  int _weekAssignedCount() {
    return _weekDates.fold<int>(
      0,
      (sum, date) => sum + _assignedCountForDate(_dateText(date)),
    );
  }

  int _gapCountForDate(String dateText) {
    if (_targets.isEmpty || _shiftColumns.isEmpty) return 0;
    final rows = _assignmentsByDate[dateText] ?? {};
    return _shiftColumns.fold<int>(0, (sum, shift) {
      final assigned =
          rows[shift.label]?.values
              .where((staffIds) => staffIds.isNotEmpty)
              .length ??
          0;
      return sum + (_targets.length - assigned);
    });
  }

  int _weekGapCount() {
    return _weekDates.fold<int>(
      0,
      (sum, date) => sum + _gapCountForDate(_dateText(date)),
    );
  }

  String _statusText() {
    final boards = _boardsByDate.values.expand((rows) => rows).toList();
    if (boards.isEmpty) return 'draft';
    final published = boards.where(
      (row) => _asText(row['status']) == 'published',
    );
    return published.length == boards.length ? 'published' : 'draft';
  }

  bool _isStaffAssignedOutsideCell(
    int staffId,
    String shiftLabel,
    int targetId,
  ) {
    for (final shiftEntry in _assignmentsByShift.entries) {
      for (final targetEntry in shiftEntry.value.entries) {
        final sameCell =
            _shiftKey(shiftEntry.key) == _shiftKey(shiftLabel) &&
            targetEntry.key == targetId;
        if (!sameCell && targetEntry.value.contains(staffId)) return true;
      }
    }
    return false;
  }

  String? _staffAssignedShift(int staffId) {
    for (final entry in _assignmentsByShift.entries) {
      if (entry.value.values.any((staffIds) => staffIds.contains(staffId))) {
        return entry.key;
      }
    }
    return null;
  }

  int? _staffAssignedTarget(int staffId) {
    for (final entry in _assignmentsByShift.entries) {
      for (final targetEntry in entry.value.entries) {
        if (targetEntry.value.contains(staffId)) return targetEntry.key;
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

  Map<String, dynamic>? _approvedLeaveForDate(int staffId, String dateText) {
    final leaveRows = _leaveCoverageByDate[dateText] ?? const [];
    for (final leave in leaveRows) {
      final leaveStaffId = _asInt(leave['staff_id']);
      final status = _asText(leave['leave_status'], fallback: '').toLowerCase();
      if (leaveStaffId == staffId && status == 'approved') {
        return leave;
      }
    }
    return null;
  }

  bool _isStaffOnApprovedLeaveForDate(int staffId, String dateText) =>
      _approvedLeaveForDate(staffId, dateText) != null;

  bool _isStaffOnApprovedLeaveForSelectedDate(int staffId) =>
      _isStaffOnApprovedLeaveForDate(staffId, _selectedDateText);

  String? _approvedLeaveMessageForDate(int staffId, String dateText) {
    final leave = _approvedLeaveForDate(staffId, dateText);
    if (leave == null) return null;
    final staff = _asText(
      leave['staff_name'] ?? _staffById(staffId)?['name'],
      fallback: _copy('s4.lib.housekeeping_roster_board.staff_fallback'),
    );
    final leaveType = _asText(
      leave['leave_type'],
      fallback: _copy('s4.lib.housekeeping_roster_board.leave_fallback'),
    );
    final start = _asText(leave['start_date'], fallback: dateText);
    final end = _asText(leave['end_date'], fallback: dateText);
    final replacement = _asText(leave['replacement_staff_name'], fallback: '');
    if (replacement.isEmpty) {
      return _format('s4.dynamic.housekeeping_roster_board.approved_leave', {
        'staff': staff,
        'leaveType': leaveType,
        'start': start,
        'end': end,
      });
    }
    return _format(
      's4.dynamic.housekeeping_roster_board.approved_leave_with_cover',
      {
        'staff': staff,
        'leaveType': leaveType,
        'start': start,
        'end': end,
        'replacement': replacement,
      },
    );
  }

  String? _approvedLeaveMessageForSelectedDate(int staffId) =>
      _approvedLeaveMessageForDate(staffId, _selectedDateText);

  Map<String, dynamic>? _staffForecast(int staffId) =>
      _staffForecastById[staffId];

  Map<String, dynamic>? _forecastForSelectedDate() =>
      _forecastByDate[_selectedDateText];

  Color _riskColor(dynamic band) {
    switch (_asText(band, fallback: 'low').toLowerCase()) {
      case 'high':
        return AppTheme.errorOnSurface;
      case 'medium':
        return AppTheme.warningOnSurface;
      default:
        return AppTheme.successOnSurface;
    }
  }

  String _forecastStateLabel() {
    final state = _asText(
      _forecastOverlay['governance_state'],
      fallback: 'blocked',
    );
    final review = _asText(_forecastOverlay['review_status'], fallback: '');
    final stateLabel = switch (state) {
      'ai' => _copy('s4.lib.housekeeping_roster_board.forecast_state.ai'),
      'schema-unavailable' => _copy(
        's4.lib.housekeeping_roster_board.forecast_state.schema_unavailable',
      ),
      'blocked' => _copy(
        's4.lib.housekeeping_roster_board.forecast_state.not_generated',
      ),
      _ => state,
    };
    return review.isEmpty
        ? stateLabel
        : _format('s4.dynamic.housekeeping_roster_board.state_review', {
            'state': stateLabel,
            'review': _reviewDecisionLabel(review),
          });
  }

  Color _forecastStateColor() {
    final state = _asText(
      _forecastOverlay['governance_state'],
      fallback: 'blocked',
    );
    if (state == 'ai') return AppTheme.primaryBlue;
    if (state == 'schema-unavailable' || state == 'blocked') {
      return AppTheme.warningOnSurface;
    }
    return AppTheme.primaryTeal;
  }

  bool _showApprovedLeaveBlock(int staffId, {String? dateText}) {
    final targetDate = dateText ?? _selectedDateText;
    final message = _approvedLeaveMessageForDate(staffId, targetDate);
    if (message == null) return false;
    _showSnack(
      _format('s4.dynamic.housekeeping_roster_board.cannot_assign_on_date', {
        'date': targetDate,
        'message': message,
      }),
      AppTheme.errorRed,
    );
    return true;
  }

  Map<String, dynamic>? _targetById(int targetId) {
    for (final target in _targets) {
      if (_asInt(target['id']) == targetId) return target;
    }
    return null;
  }

  List<int> _assignedStaffForCell(String shiftLabel, int targetId) {
    final staffIds = _assignmentsByShift[shiftLabel]?[targetId];
    if (staffIds == null) return const [];
    return List<int>.unmodifiable(staffIds);
  }

  bool _targetOccupiedByOtherStaff({
    required String shiftLabel,
    required int targetId,
    required int staffId,
  }) {
    return false;
  }

  void _addCellAssignment(String shiftLabel, int targetId, int staffId) {
    if (_isStaffAssignedOutsideCell(staffId, shiftLabel, targetId)) {
      final staff = _staffById(staffId);
      final otherShift = _staffAssignedShift(staffId);
      _showSnack(
        _format(
          's4.dynamic.housekeeping_roster_board.already_assigned_on_date',
          {
            'staff': _asText(
              staff?['name'],
              fallback: _copy(
                's4.lib.housekeeping_roster_board.staff_fallback',
              ),
            ),
            'target':
                otherShift ??
                _copy('s4.lib.housekeeping_roster_board.another_floor'),
          },
        ),
        AppTheme.errorRed,
      );
      return;
    }
    if (_showApprovedLeaveBlock(staffId)) {
      return;
    }
    setState(() {
      final shiftMap = _assignmentsByShift.putIfAbsent(
        shiftLabel,
        _emptyTargetMap,
      );
      final staffIds = shiftMap.putIfAbsent(targetId, () => <int>[]);
      if (!staffIds.contains(staffId)) staffIds.add(staffId);
    });
  }

  void _removeCellAssignment(String shiftLabel, int targetId, int staffId) {
    setState(() {
      _assignmentsByShift[shiftLabel]?[targetId]?.remove(staffId);
    });
  }

  void _clearStaffFromAllShifts(int staffId) {
    for (final shiftMap in _assignmentsByShift.values) {
      for (final targetId in shiftMap.keys.toList()) {
        shiftMap[targetId]?.remove(staffId);
      }
    }
  }

  int? _firstAvailableTarget(String shiftLabel, {int? preferredTargetId}) {
    final shiftMap = _assignmentsByShift[shiftLabel] ?? _emptyTargetMap();
    if (preferredTargetId != null && shiftMap.containsKey(preferredTargetId)) {
      return preferredTargetId;
    }
    for (final target in _targets) {
      final targetId = _asInt(target['id']);
      if (targetId != null && shiftMap.containsKey(targetId)) return targetId;
    }
    return null;
  }

  void _setStaffShift(int staffId, String? shiftLabel) {
    if (shiftLabel != null && _showApprovedLeaveBlock(staffId)) {
      return;
    }
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
        final staffIds = shiftMap.putIfAbsent(targetId, () => <int>[]);
        if (!staffIds.contains(staffId)) staffIds.add(staffId);
      }
    });
  }

  void _setStaffTarget(int staffId, int? targetId) {
    final shiftLabel = _staffAssignedShift(staffId);
    if (shiftLabel == null) {
      _showSnack(
        _copy('s4.lib.housekeeping_roster_board.select_shift_before_floor'),
        AppTheme.errorRed,
      );
      return;
    }
    if (targetId == null) {
      setState(() => _clearStaffFromAllShifts(staffId));
      return;
    }
    if (_showApprovedLeaveBlock(staffId)) {
      return;
    }
    setState(() {
      _clearStaffFromAllShifts(staffId);
      final shiftMap = _assignmentsByShift.putIfAbsent(
        shiftLabel,
        _emptyTargetMap,
      );
      final staffIds = shiftMap.putIfAbsent(targetId, () => <int>[]);
      if (!staffIds.contains(staffId)) staffIds.add(staffId);
    });
  }

  List<Map<String, dynamic>> _buildAssignmentsForShift(
    String shiftLabel, {
    String? dateText,
  }) {
    final result = <Map<String, dynamic>>[];
    final rows = dateText == null
        ? _assignmentsByShift
        : _assignmentsByDate[dateText];
    final shiftMap = rows?[shiftLabel] ?? {};
    for (final entry in shiftMap.entries) {
      final targetId = entry.key;
      final staffIds = entry.value;
      if (staffIds.isEmpty) continue;
      final target = _targetById(targetId);
      if (target == null) continue;
      for (final staffId in staffIds) {
        result.add({
          'staff_id': staffId,
          'assignment_target_type': _targetType,
          'assignment_target_id': targetId,
          'assignment_target_label': _asText(target['label'] ?? target['name']),
          'floor': target['floor'],
          'building': target['building'],
        });
      }
    }
    return result;
  }

  String? _firstApprovedLeaveConflictForDate(String dateText) {
    final rows = _assignmentsByDate[dateText] ?? const {};
    for (final shiftEntry in rows.entries) {
      for (final staffIds in shiftEntry.value.values) {
        for (final staffId in staffIds) {
          final message = _approvedLeaveMessageForDate(staffId, dateText);
          if (message != null) {
            return _format(
              's4.dynamic.housekeeping_roster_board.clear_assignment_before_saving',
              {'message': message, 'shift': shiftEntry.key, 'date': dateText},
            );
          }
        }
      }
    }
    return null;
  }

  String? _firstApprovedLeaveConflictForWeek() {
    for (final date in _weekDates) {
      final conflict = _firstApprovedLeaveConflictForDate(_dateText(date));
      if (conflict != null) return conflict;
    }
    return null;
  }

  List<Map<String, dynamic>> _buildDayBoards({String? dateText}) {
    return _shiftColumns
        .map(
          (shift) => {
            'shift_label': shift.label,
            'shift_id': ?shift.shiftId,
            'notes': '$_departmentPayloadLabel ${shift.label} roster',
            'assignments': _buildAssignmentsForShift(
              shift.label,
              dateText: dateText,
            ),
          },
        )
        .toList();
  }

  Future<Map<String, dynamic>?> _saveDraft({bool quiet = false}) async {
    if (!_canEditRoster) {
      _showSnack(
        _copy('s4.lib.housekeeping_roster_board.edit_permission_required'),
        AppTheme.errorRed,
      );
      return null;
    }
    if (_shiftColumns.isEmpty) {
      _showSnack(
        _copy('s4.lib.housekeeping_roster_board.no_roster_shifts_configured'),
        AppTheme.errorRed,
      );
      return null;
    }
    final leaveConflict = _firstApprovedLeaveConflictForWeek();
    if (leaveConflict != null) {
      _showSnack(leaveConflict, AppTheme.errorRed);
      return null;
    }
    setState(() => _saving = true);
    try {
      Map<String, dynamic>? lastSaved;
      for (final date in _weekDates) {
        final dateText = _dateText(date);
        lastSaved = await HrApiService.saveRosterDay(
          department: widget.department,
          rosterDate: dateText,
          boards: _buildDayBoards(dateText: dateText),
          reason: 'Saved from $_departmentPayloadLabel weekly roster grid',
        );
      }
      if (!quiet) {
        _showSnack(
          _copy('s4.lib.housekeeping_roster_board.weekly_draft_saved'),
          AppTheme.successGreen,
        );
      }
      await _load();
      return lastSaved;
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
    if (!_canEditRoster) {
      _showSnack(
        _copy('s4.lib.housekeeping_roster_board.publish_permission_required'),
        AppTheme.errorRed,
      );
      return;
    }
    final leaveConflict = _firstApprovedLeaveConflictForWeek();
    if (leaveConflict != null) {
      _showSnack(leaveConflict, AppTheme.errorRed);
      return;
    }
    setState(() => _saving = true);
    try {
      var publishedCount = 0;
      for (final date in _weekDates) {
        final dateText = _dateText(date);
        final saved = await HrApiService.saveRosterDay(
          department: widget.department,
          rosterDate: dateText,
          boards: _buildDayBoards(dateText: dateText),
          reason:
              'Saved before publishing $_departmentPayloadLabel weekly roster',
        );
        final boards = _asMapList(saved['boards']);
        for (final board in boards) {
          final boardId = _asInt(board['id']);
          final assignments = _asMapList(board['assignments']);
          if (boardId == null || assignments.isEmpty) continue;
          await HrApiService.publishRosterBoard(
            rosterId: boardId,
            reason:
                'Published from $_departmentPayloadLabel weekly roster grid',
          );
          publishedCount += 1;
        }
      }
      _showSnack(
        publishedCount == 0
            ? _copy(
                's4.lib.housekeeping_roster_board.no_assigned_shifts_to_publish',
              )
            : _format(
                's4.dynamic.housekeeping_roster_board.published_roster_count',
                {'count': publishedCount},
              ),
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
    if (!_canEditRoster) {
      _showSnack(
        _copy('s4.lib.housekeeping_roster_board.copy_permission_required'),
        AppTheme.errorRed,
      );
      return;
    }
    setState(() => _saving = true);
    try {
      var copied = 0;
      var failed = 0;
      for (final shift in _shiftColumns) {
        try {
          await HrApiService.copyPreviousRosterBoard(
            department: widget.department,
            rosterDate: _selectedDateText,
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
            ? _format(
                's4.dynamic.housekeeping_roster_board.copied_previous_rosters',
                {'count': copied},
              )
            : _copy(
                's4.lib.housekeeping_roster_board.no_previous_roster_found',
              ),
        copied > 0 ? AppTheme.successGreen : AppTheme.warningOnSurface,
      );
      if (failed > 0 && copied > 0) {
        _showSnack(
          _format(
            's4.dynamic.housekeeping_roster_board.previous_rosters_missing',
            {'count': failed},
          ),
          AppTheme.warningOnSurface,
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _copySelectedDayToWeek() {
    if (!_canEditRoster) {
      _showSnack(
        _copy('s4.lib.housekeeping_roster_board.edit_permission_required'),
        AppTheme.errorRed,
      );
      return;
    }
    final source = _assignmentsByShift;
    var blocked = 0;
    setState(() {
      for (final date in _weekDates) {
        final dateText = _dateText(date);
        if (dateText == _selectedDateText) continue;
        final target = _assignmentsByDate.putIfAbsent(dateText, _emptyShiftMap);
        target.clear();
        for (final entry in source.entries) {
          final shiftTargetMap = <int, List<int>>{};
          for (final targetEntry in entry.value.entries) {
            final copiedStaffIds = <int>[];
            for (final staffId in targetEntry.value) {
              if (_isStaffOnApprovedLeaveForDate(staffId, dateText)) {
                blocked += 1;
              } else {
                copiedStaffIds.add(staffId);
              }
            }
            shiftTargetMap[targetEntry.key] = copiedStaffIds;
          }
          target[entry.key] = shiftTargetMap;
        }
      }
    });
    _showSnack(
      blocked == 0
          ? _copy('s4.lib.housekeeping_roster_board.copied_day_to_week')
          : _format(
              's4.dynamic.housekeeping_roster_board.copied_day_skipped_leave',
              {'count': blocked},
            ),
      blocked == 0 ? AppTheme.successGreen : AppTheme.warningOnSurface,
    );
  }

  Future<void> _reviewRequest(int requestId, String decision) async {
    if (!_canReviewRosterRequests) {
      _showSnack(
        _copy('s4.lib.housekeeping_roster_board.review_permission_required'),
        AppTheme.errorRed,
      );
      return;
    }
    setState(() => _saving = true);
    try {
      await HrApiService.reviewRosterPreferenceRequest(
        requestId: requestId,
        decision: decision,
        reviewNotes: 'Reviewed from $_departmentPayloadLabel roster board',
      );
      _showSnack(
        _format('s4.dynamic.housekeeping_roster_board.duty_request_reviewed', {
          'decision': _reviewDecisionLabel(decision),
        }),
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

  Future<void> _generateForecast() async {
    if (!_canForecastRoster) {
      _showSnack(
        _copy(
          's4.lib.housekeeping_roster_board.forecast_generate_permission_required',
        ),
        AppTheme.errorRed,
      );
      return;
    }
    setState(() => _saving = true);
    try {
      await HrApiService.generateRosterLeaveForecast(
        department: widget.department,
        startDate: _dateText(_weekStart),
        endDate: _dateText(_weekStart.add(const Duration(days: 83))),
      );
      _showSnack(
        _copy('s4.lib.housekeeping_roster_board.forecast_generated'),
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

  Future<void> _reviewForecast(String decision) async {
    if (!_canForecastRoster) {
      _showSnack(
        _copy(
          's4.lib.housekeeping_roster_board.forecast_review_permission_required',
        ),
        AppTheme.errorRed,
      );
      return;
    }
    final runId = _asInt(_forecastOverlay['run_id']);
    if (runId == null) {
      _showSnack(
        _copy('s4.lib.housekeeping_roster_board.generate_forecast_first'),
        AppTheme.errorRed,
      );
      return;
    }
    setState(() => _saving = true);
    try {
      await HrApiService.reviewRosterLeaveForecast(
        runId: runId,
        decision: decision,
        reviewerNotes: 'Reviewed from $_departmentPayloadLabel roster board',
      );
      _showSnack(
        _format('s4.dynamic.housekeeping_roster_board.forecast_reviewed', {
          'decision': _reviewDecisionLabel(decision),
        }),
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

  Future<void> _addCustomShift() async {
    if (!_canEditRoster) {
      _showSnack(
        _copy(
          's4.lib.housekeeping_roster_board.custom_shift_permission_required',
        ),
        AppTheme.errorRed,
      );
      return;
    }
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
      _showSnack(
        _copy('s4.lib.housekeeping_roster_board.custom_shift_added'),
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

  void _showSnack(String message, Color color) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message), backgroundColor: color));
  }

  @override
  Widget build(BuildContext context) {
    final assigned = _weekAssignedCount();
    final status = _statusText();
    final gaps = _weekGapCount();

    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(_screenTitle()),
        actions: [
          IconButton(
            tooltip: AppStrings.of(context).lookup('action.refresh'),
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: _loading && _targets.isEmpty
          ? const SkeletonList()
          : _error != null && _targets.isEmpty
          ? ErrorState(message: _error!, onRetry: _load)
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_error != null) _ErrorBanner(error: _error!),
                  _HeaderPanel(
                    weekRangeText: _weekRangeText,
                    selectedDateText: _selectedDateText,
                    departmentLabel: _departmentLabel,
                    status: status,
                    assigned: assigned,
                    gaps: gaps,
                    forecastState: _forecastStateLabel(),
                    forecastStateColor: _forecastStateColor(),
                    forecastRisk: _forecastForSelectedDate(),
                    saving: _saving,
                    canEdit: _canEditRoster,
                    canForecast: _canForecastRoster,
                    onPickWeek: _pickWeek,
                    onCopyPrevious: _copyPrevious,
                    onCopySelectedDayToWeek: _copySelectedDayToWeek,
                    onAddCustomShift: _addCustomShift,
                    onGenerateForecast: _generateForecast,
                  ),
                  if (!_canEditRoster)
                    _InfoBanner(
                      text: _governanceNote.isEmpty
                          ? _copy(
                              's4.lib.housekeeping_roster_board.viewing_only_roster_edits',
                            )
                          : _format(
                              's4.dynamic.housekeeping_roster_board.viewing_only_note',
                              {'note': _governanceNote},
                            ),
                    ),
                  const SizedBox(height: 12),
                  _WeekStrip(
                    dates: _weekDates,
                    selectedIndex: _selectedDayIndex,
                    saving: _saving,
                    dateText: _dateText,
                    dayLabel: _dayShortLabel,
                    assignedCountForDate: _assignedCountForDate,
                    gapCountForDate: _gapCountForDate,
                    forecastForDate: (dateText) => _forecastByDate[dateText],
                    riskColor: _riskColor,
                    onChanged: (index) => setState(() {
                      _selectedDayIndex = index;
                    }),
                  ),
                  const SizedBox(height: 12),
                  _RosterLegend(
                    staffCount: _staff.length,
                    targetCount: _targets.length,
                    shiftCount: _shiftColumns.length,
                  ),
                  const SizedBox(height: 8),
                  _RosterSignals(
                    requests: _selectedRequests,
                    leaveCoverage: _selectedLeaveCoverage,
                    forecastOverlay: _forecastOverlay,
                    selectedDateRisk: _forecastForSelectedDate(),
                    saving: _saving || !_canReviewRosterRequests,
                    asInt: _asInt,
                    asText: _asText,
                    riskColor: _riskColor,
                    onReview: _reviewRequest,
                    onForecastReview: _reviewForecast,
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
                      text: _format(
                        's4.dynamic.housekeeping_roster_board.no_active_roster_targets',
                        {'department': _departmentLabel},
                      ),
                    )
                  else if (_tabIndex == 0)
                    _FloorShiftGrid(
                      shifts: _shiftColumns,
                      targets: _targets,
                      staff: _staff,
                      saving: _saving || !_canEditRoster,
                      asInt: _asInt,
                      asText: _asText,
                      shiftWindow: _shiftWindow,
                      assignedStaffForCell: _assignedStaffForCell,
                      isStaffAssignedOutsideCell: _isStaffAssignedOutsideCell,
                      isStaffOnApprovedLeave:
                          _isStaffOnApprovedLeaveForSelectedDate,
                      approvedLeaveMessage:
                          _approvedLeaveMessageForSelectedDate,
                      staffForecast: _staffForecast,
                      riskColor: _riskColor,
                      assignedCountForShift: _assignedCountForShift,
                      onAdd: _addCellAssignment,
                      onRemove: _removeCellAssignment,
                      onAddCustomShift: _addCustomShift,
                    )
                  else
                    _StaffWiseRoster(
                      shifts: _shiftColumns,
                      targets: _targets,
                      staff: _staff,
                      saving: _saving || !_canEditRoster,
                      asInt: _asInt,
                      asText: _asText,
                      staffAssignedShift: _staffAssignedShift,
                      staffAssignedTarget: _staffAssignedTarget,
                      staffAssignedTargetLabel: _staffAssignedTargetLabel,
                      targetOccupiedByOtherStaff: _targetOccupiedByOtherStaff,
                      isStaffOnApprovedLeave:
                          _isStaffOnApprovedLeaveForSelectedDate,
                      approvedLeaveMessage:
                          _approvedLeaveMessageForSelectedDate,
                      staffForecast: _staffForecast,
                      riskColor: _riskColor,
                      onShiftChanged: _setStaffShift,
                      onTargetChanged: _setStaffTarget,
                    ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _saving || !_canEditRoster
                              ? null
                              : () => _saveDraft(),
                          icon: const Icon(Icons.save_outlined),
                          label: const AppText(
                            's4.lib.housekeeping_roster_board.save_draft',
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: FilledButton.icon(
                          onPressed: _saving || !_canEditRoster
                              ? null
                              : _publish,
                          icon: _saving
                              ? const SizedBox(
                                  height: 18,
                                  width: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.publish_outlined),
                          label: const AppText(
                            's4.lib.housekeeping_roster_board.publish_roster',
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
  final String weekRangeText;
  final String selectedDateText;
  final String departmentLabel;
  final String status;
  final int assigned;
  final int gaps;
  final String forecastState;
  final Color forecastStateColor;
  final Map<String, dynamic>? forecastRisk;
  final bool saving;
  final bool canEdit;
  final bool canForecast;
  final VoidCallback onPickWeek;
  final VoidCallback onCopyPrevious;
  final VoidCallback onCopySelectedDayToWeek;
  final VoidCallback onAddCustomShift;
  final VoidCallback onGenerateForecast;

  const _HeaderPanel({
    required this.weekRangeText,
    required this.selectedDateText,
    required this.departmentLabel,
    required this.status,
    required this.assigned,
    required this.gaps,
    required this.forecastState,
    required this.forecastStateColor,
    required this.forecastRisk,
    required this.saving,
    required this.canEdit,
    required this.canForecast,
    required this.onPickWeek,
    required this.onCopyPrevious,
    required this.onCopySelectedDayToWeek,
    required this.onAddCustomShift,
    required this.onGenerateForecast,
  });

  @override
  Widget build(BuildContext context) {
    final published = status == 'published';
    final s = AppStrings.of(context);
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
                    s.format(
                      's4.dynamic.housekeeping_roster_board.duty_deployment_title',
                      {'department': departmentLabel},
                    ),
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontSize: 18,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                _StatusPill(
                  label: s.lookup(
                    published
                        ? 's4.lib.housekeeping_roster_board.status.published'
                        : 's4.lib.housekeeping_roster_board.status.draft',
                  ),
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
                  label: AppText(
                    's4.dynamic.housekeeping.week_label',
                    values: {'range': weekRangeText},
                  ),
                  onPressed: saving ? null : onPickWeek,
                ),
                _StatusPill(
                  label: s.format(
                    's4.dynamic.housekeeping_roster_board.viewing_date',
                    {'date': selectedDateText},
                  ),
                  color: AppTheme.primaryTeal,
                ),
                _StatusPill(
                  label: s.format(
                    's4.dynamic.housekeeping_roster_board.assignment_count',
                    {'count': assigned},
                  ),
                  color: AppTheme.primaryBlue,
                ),
                _StatusPill(
                  label: s.format(
                    's4.dynamic.housekeeping_roster_board.open_cell_count',
                    {'count': gaps},
                  ),
                  color: gaps == 0
                      ? AppTheme.successOnSurface
                      : AppTheme.errorOnSurface,
                ),
                _StatusPill(
                  label: s.format(
                    's4.dynamic.housekeeping_roster_board.forecast_state',
                    {'state': forecastState},
                  ),
                  color: forecastStateColor,
                ),
                if (forecastRisk != null)
                  _StatusPill(
                    label: s.format(
                      's4.dynamic.housekeeping_roster_board.risk_buffer',
                      {
                        'risk': forecastRisk!['risk_band'] ?? 'low',
                        'buffer':
                            forecastRisk!['recommended_buffer_count'] ?? 0,
                      },
                    ),
                    color:
                        (forecastRisk!['risk_band']?.toString() ?? 'low') ==
                            'high'
                        ? AppTheme.errorOnSurface
                        : (forecastRisk!['risk_band']?.toString() ?? 'low') ==
                              'medium'
                        ? AppTheme.warningOnSurface
                        : AppTheme.successOnSurface,
                  ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                SizedBox(
                  width: 220,
                  child: OutlinedButton.icon(
                    onPressed: saving || !canEdit ? null : onCopyPrevious,
                    icon: const Icon(Icons.content_copy_outlined),
                    label: const AppText(
                      's4.lib.housekeeping_roster_board.copy_previous_day',
                    ),
                  ),
                ),
                SizedBox(
                  width: 250,
                  child: OutlinedButton.icon(
                    onPressed: saving || !canEdit
                        ? null
                        : onCopySelectedDayToWeek,
                    icon: const Icon(Icons.copy_all_outlined),
                    label: const AppText(
                      's4.lib.housekeeping_roster_board.copy_day_to_week',
                    ),
                  ),
                ),
                SizedBox(
                  width: 220,
                  child: OutlinedButton.icon(
                    onPressed: saving || !canEdit ? null : onAddCustomShift,
                    icon: const Icon(Icons.add_alarm_outlined),
                    label: const AppText(
                      's4.lib.housekeeping_roster_board.add_custom_shift',
                    ),
                  ),
                ),
                SizedBox(
                  width: 260,
                  child: FilledButton.icon(
                    onPressed: saving || !canForecast
                        ? null
                        : onGenerateForecast,
                    icon: const Icon(Icons.auto_graph_outlined),
                    label: const AppText(
                      's4.lib.housekeeping_roster_board.generate_12_week_forecast',
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
}

class _WeekStrip extends StatelessWidget {
  final List<DateTime> dates;
  final int selectedIndex;
  final bool saving;
  final String Function(DateTime date) dateText;
  final String Function(DateTime date) dayLabel;
  final int Function(String dateText) assignedCountForDate;
  final int Function(String dateText) gapCountForDate;
  final Map<String, dynamic>? Function(String dateText) forecastForDate;
  final Color Function(dynamic band) riskColor;
  final ValueChanged<int> onChanged;

  const _WeekStrip({
    required this.dates,
    required this.selectedIndex,
    required this.saving,
    required this.dateText,
    required this.dayLabel,
    required this.assignedCountForDate,
    required this.gapCountForDate,
    required this.forecastForDate,
    required this.riskColor,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: List.generate(dates.length, (index) {
              final date = dates[index];
              final text = dateText(date);
              final selected = index == selectedIndex;
              final assigned = assignedCountForDate(text);
              final gaps = gapCountForDate(text);
              final forecast = forecastForDate(text);
              final riskBand = forecast?['risk_band'] ?? 'none';
              return Padding(
                padding: EdgeInsets.only(
                  right: index == dates.length - 1 ? 0 : 8,
                ),
                child: ChoiceChip(
                  selected: selected,
                  avatar: Icon(
                    gaps == 0 && assigned > 0
                        ? Icons.check_circle_outline
                        : Icons.event_note_outlined,
                    size: 18,
                  ),
                  label: ConstrainedBox(
                    constraints: const BoxConstraints(minWidth: 112),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          dayLabel(date),
                          style: const TextStyle(fontWeight: FontWeight.w800),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          s.format(
                            's4.dynamic.housekeeping_roster_board.day_assignment_summary',
                            {'assigned': assigned, 'open': gaps},
                          ),
                          style: TextStyle(
                            color: selected
                                ? AppTheme.primaryBlue
                                : AppTheme.textSecondary,
                            fontSize: 12,
                          ),
                        ),
                        if (forecast != null) ...[
                          const SizedBox(height: 2),
                          Text(
                            s.format(
                              's4.dynamic.housekeeping_roster_board.risk_buffer',
                              {
                                'risk': riskBand,
                                'buffer':
                                    forecast['recommended_buffer_count'] ?? 0,
                              },
                            ),
                            style: TextStyle(
                              color: riskColor(riskBand),
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  onSelected: saving ? null : (_) => onChanged(index),
                ),
              );
            }),
          ),
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
    final s = AppStrings.of(context);
    return Row(
      children: [
        Expanded(
          child: AppText(
            's4.lib.housekeeping_roster_board.assign_each_ward_unit_or_floor_under_morning_eve',
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ),
        _StatusPill(
          label: s.format('s4.dynamic.housekeeping_roster_board.staff_count', {
            'count': staffCount,
          }),
          color: AppTheme.primaryTeal,
        ),
        const SizedBox(width: 8),
        _StatusPill(
          label: s.format('s4.dynamic.housekeeping_roster_board.area_count', {
            'count': targetCount,
          }),
          color: AppTheme.primaryBlue,
        ),
        const SizedBox(width: 8),
        _StatusPill(
          label: s.format('s4.dynamic.housekeeping_roster_board.shift_count', {
            'count': shiftCount,
          }),
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
    final s = AppStrings.of(context);
    return Card(
      color: AppTheme.cardSurface,
      child: Row(
        children: [
          Expanded(
            child: _TabButton(
              icon: Icons.view_week_outlined,
              label: s.lookup('s4.lib.housekeeping_roster_board.tab.by_ward'),
              selected: selectedIndex == 0,
              onPressed: () => onChanged(0),
            ),
          ),
          Expanded(
            child: _TabButton(
              icon: Icons.badge_outlined,
              label: s.lookup('s4.lib.housekeeping_roster_board.tab.by_staff'),
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
  final List<int> Function(String shiftLabel, int targetId)
  assignedStaffForCell;
  final bool Function(int staffId, String shiftLabel, int targetId)
  isStaffAssignedOutsideCell;
  final bool Function(int staffId) isStaffOnApprovedLeave;
  final String? Function(int staffId) approvedLeaveMessage;
  final Map<String, dynamic>? Function(int staffId) staffForecast;
  final Color Function(dynamic band) riskColor;
  final int Function(String shiftLabel) assignedCountForShift;
  final void Function(String shiftLabel, int targetId, int staffId) onAdd;
  final void Function(String shiftLabel, int targetId, int staffId) onRemove;
  final VoidCallback onAddCustomShift;

  const _FloorShiftGrid({
    required this.shifts,
    required this.targets,
    required this.staff,
    required this.saving,
    required this.asInt,
    required this.asText,
    required this.shiftWindow,
    required this.assignedStaffForCell,
    required this.isStaffAssignedOutsideCell,
    required this.isStaffOnApprovedLeave,
    required this.approvedLeaveMessage,
    required this.staffForecast,
    required this.riskColor,
    required this.assignedCountForShift,
    required this.onAdd,
    required this.onRemove,
    required this.onAddCustomShift,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (shifts.isEmpty) {
      return _EmptyCard(
        icon: Icons.schedule_outlined,
        text: s.lookup(
          's4.lib.housekeeping_roster_board.no_active_shifts_configured',
        ),
      );
    }

    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final floorWidth = constraints.maxWidth >= 980 ? 220.0 : 180.0;
            const addWidth = 132.0;
            const minShiftWidth = 220.0;
            final available = constraints.maxWidth - floorWidth - addWidth;
            final shiftWidth = shifts.isEmpty
                ? minShiftWidth
                : (available / shifts.length)
                      .clamp(minShiftWidth, 280.0)
                      .toDouble();
            final tableWidth =
                floorWidth + (shiftWidth * shifts.length) + addWidth;

            return SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SizedBox(
                width: tableWidth,
                child: Column(
                  children: [
                    SizedBox(
                      height: 72,
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          _GridHeaderCell(
                            width: floorWidth,
                            title: s.lookup(
                              's4.lib.housekeeping_roster_board.ward_unit',
                            ),
                            subtitle: s.format(
                              's4.dynamic.housekeeping_roster_board.active_count',
                              {'count': targets.length},
                            ),
                          ),
                          ...shifts.map(
                            (shift) => _GridHeaderCell(
                              width: shiftWidth,
                              title: shift.label,
                              subtitle: s.format(
                                's4.dynamic.housekeeping_roster_board.shift_assigned_summary',
                                {
                                  'window': shiftWindow(shift),
                                  'count': assignedCountForShift(shift.label),
                                },
                              ),
                              highlighted: !shift.isCustom,
                            ),
                          ),
                          _AddShiftColumnHeader(
                            width: addWidth,
                            onPressed: saving ? null : onAddCustomShift,
                          ),
                        ],
                      ),
                    ),
                    const Divider(height: 1),
                    ...targets.map((target) {
                      final targetId = asInt(target['id']);
                      if (targetId == null) return const SizedBox.shrink();
                      return SizedBox(
                        height: 132,
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
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
                                selectedStaffIds: assignedStaffForCell(
                                  shift.label,
                                  targetId,
                                ),
                                saving: saving,
                                asInt: asInt,
                                asText: asText,
                                isStaffAssignedOutsideCell:
                                    isStaffAssignedOutsideCell,
                                isStaffOnApprovedLeave: isStaffOnApprovedLeave,
                                approvedLeaveMessage: approvedLeaveMessage,
                                staffForecast: staffForecast,
                                riskColor: riskColor,
                                onAdd: onAdd,
                                onRemove: onRemove,
                              ),
                            ),
                            Container(
                              width: addWidth,
                              height: 132,
                              decoration: BoxDecoration(
                                border: Border(
                                  left: BorderSide(
                                    color: AppTheme.divider.withValues(
                                      alpha: 0.5,
                                    ),
                                  ),
                                  bottom: BorderSide(
                                    color: AppTheme.divider.withValues(
                                      alpha: 0.5,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                      );
                    }),
                  ],
                ),
              ),
            );
          },
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
      height: 72,
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
    final s = AppStrings.of(context);
    return Container(
      width: width,
      height: 72,
      padding: const EdgeInsets.all(10),
      color: AppTheme.backgroundGrey,
      child: Tooltip(
        message: s.lookup('s4.lib.housekeeping_roster_board.add_custom_shift'),
        child: IconButton.outlined(
          onPressed: onPressed,
          icon: const Icon(Icons.add_alarm_outlined),
        ),
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
    final s = AppStrings.of(context);
    return Container(
      width: width,
      height: 132,
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
                    s.format('s4.dynamic.housekeeping.floor_label', {
                      'floor': asText(target['floor']),
                    }),
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
  final List<int> selectedStaffIds;
  final bool saving;
  final int? Function(dynamic value) asInt;
  final String Function(dynamic value, {String fallback}) asText;
  final bool Function(int staffId, String shiftLabel, int targetId)
  isStaffAssignedOutsideCell;
  final bool Function(int staffId) isStaffOnApprovedLeave;
  final String? Function(int staffId) approvedLeaveMessage;
  final Map<String, dynamic>? Function(int staffId) staffForecast;
  final Color Function(dynamic band) riskColor;
  final void Function(String shiftLabel, int targetId, int staffId) onAdd;
  final void Function(String shiftLabel, int targetId, int staffId) onRemove;

  const _AssignmentDropdownCell({
    required this.width,
    required this.shiftLabel,
    required this.targetId,
    required this.staff,
    required this.selectedStaffIds,
    required this.saving,
    required this.asInt,
    required this.asText,
    required this.isStaffAssignedOutsideCell,
    required this.isStaffOnApprovedLeave,
    required this.approvedLeaveMessage,
    required this.staffForecast,
    required this.riskColor,
    required this.onAdd,
    required this.onRemove,
  });

  Map<String, dynamic>? _staffById(int staffId) {
    for (final row in staff) {
      if (asInt(row['id']) == staffId) return row;
    }
    return null;
  }

  Future<void> _pickStaff(BuildContext context) async {
    final s = AppStrings.of(context);
    final pickedStaffId = await showModalBottomSheet<int>(
      context: context,
      backgroundColor: AppTheme.cardSurface,
      builder: (context) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AppText(
                  's4.lib.housekeeping_roster_board.add_staff',
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontSize: 18,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 10),
                Flexible(
                  child: ListView.separated(
                    shrinkWrap: true,
                    itemCount: staff.length,
                    separatorBuilder: (context, index) =>
                        const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final row = staff[index];
                      final staffId = asInt(row['id']);
                      if (staffId == null) return const SizedBox.shrink();
                      final alreadyInCell = selectedStaffIds.contains(staffId);
                      final assignedElsewhere = isStaffAssignedOutsideCell(
                        staffId,
                        shiftLabel,
                        targetId,
                      );
                      final blockedByLeave = isStaffOnApprovedLeave(staffId);
                      final reason = blockedByLeave
                          ? approvedLeaveMessage(staffId)
                          : assignedElsewhere
                          ? s.lookup(
                              's4.lib.housekeeping_roster_board.already_assigned_elsewhere',
                            )
                          : alreadyInCell
                          ? s.lookup(
                              's4.lib.housekeeping_roster_board.already_added_to_floor',
                            )
                          : null;
                      final disabled =
                          alreadyInCell || assignedElsewhere || blockedByLeave;
                      final forecast = staffForecast(staffId);
                      final riskBand = forecast?['risk_band'];
                      return ListTile(
                        enabled: !disabled,
                        leading: Icon(
                          disabled
                              ? Icons.block_outlined
                              : Icons.person_add_alt_1_outlined,
                          color: disabled
                              ? AppTheme.textSecondary
                              : AppTheme.primaryBlue,
                        ),
                        title: Text(
                          asText(row['name']),
                          style: TextStyle(
                            color: disabled
                                ? AppTheme.textSecondary
                                : AppTheme.textPrimary,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        subtitle: Text(
                          [
                            asText(
                              row['employee_id'],
                              fallback: s.lookup(
                                's4.lib.housekeeping_command.no_id',
                              ),
                            ),
                            if (riskBand != null)
                              s.format(
                                's4.dynamic.housekeeping_roster_board.risk_label',
                                {'risk': riskBand},
                              ),
                            ?reason,
                          ].join(' - '),
                          style: TextStyle(
                            color: blockedByLeave
                                ? AppTheme.errorOnSurface
                                : riskBand != null && !disabled
                                ? riskColor(riskBand)
                                : AppTheme.textSecondary,
                          ),
                        ),
                        onTap: disabled
                            ? null
                            : () => Navigator.of(context).pop(staffId),
                      );
                    },
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
    if (pickedStaffId != null) onAdd(shiftLabel, targetId, pickedStaffId);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Container(
      width: width,
      height: 132,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
      decoration: BoxDecoration(
        border: Border(
          right: BorderSide(color: AppTheme.divider.withValues(alpha: 0.5)),
          bottom: BorderSide(color: AppTheme.divider.withValues(alpha: 0.5)),
        ),
      ),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppTheme.backgroundGrey,
          border: Border.all(color: AppTheme.divider),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Padding(
          padding: const EdgeInsets.all(8),
          child: Column(
            children: [
              Expanded(
                child: selectedStaffIds.isEmpty
                    ? Center(
                        child: AppText(
                          's4.lib.housekeeping_roster_board.unassigned',
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      )
                    : SingleChildScrollView(
                        child: Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: selectedStaffIds.map((staffId) {
                            final row = _staffById(staffId);
                            return InputChip(
                              materialTapTargetSize:
                                  MaterialTapTargetSize.shrinkWrap,
                              avatar: const Icon(Icons.person, size: 16),
                              label: Text(
                                asText(
                                  row?['name'],
                                  fallback: s.lookup(
                                    's4.lib.housekeeping_roster_board.staff_fallback',
                                  ),
                                ),
                                overflow: TextOverflow.ellipsis,
                              ),
                              onDeleted: saving
                                  ? null
                                  : () =>
                                        onRemove(shiftLabel, targetId, staffId),
                            );
                          }).toList(),
                        ),
                      ),
              ),
              const SizedBox(height: 6),
              SizedBox(
                width: double.infinity,
                height: 32,
                child: OutlinedButton.icon(
                  onPressed: saving ? null : () => _pickStaff(context),
                  icon: const Icon(Icons.add, size: 16),
                  label: Text(
                    selectedStaffIds.isEmpty
                        ? s.lookup('s4.lib.housekeeping_roster_board.add_staff')
                        : s.lookup('s4.lib.housekeeping_roster_board.add_more'),
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
  final bool Function(int staffId) isStaffOnApprovedLeave;
  final String? Function(int staffId) approvedLeaveMessage;
  final Map<String, dynamic>? Function(int staffId) staffForecast;
  final Color Function(dynamic band) riskColor;
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
    required this.isStaffOnApprovedLeave,
    required this.approvedLeaveMessage,
    required this.staffForecast,
    required this.riskColor,
    required this.targetOccupiedByOtherStaff,
    required this.onShiftChanged,
    required this.onTargetChanged,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (staff.isEmpty) {
      return _EmptyCard(
        icon: Icons.badge_outlined,
        text: s.lookup(
          's4.lib.housekeeping_roster_board.no_active_staff_found',
        ),
      );
    }

    return Column(
      children: staff.map((row) {
        final staffId = asInt(row['id']);
        if (staffId == null) return const SizedBox.shrink();
        final selectedShift = staffAssignedShift(staffId);
        final selectedTarget = staffAssignedTarget(staffId);
        final blockedByLeave = isStaffOnApprovedLeave(staffId);
        final leaveMessage = approvedLeaveMessage(staffId);
        final forecast = staffForecast(staffId);
        final riskBand = forecast?['risk_band'];
        final topFactors = forecast?['top_factors'] is List
            ? (forecast!['top_factors'] as List)
            : const [];
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
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              asText(row['name']),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: AppTheme.textPrimary,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ),
                          if (blockedByLeave)
                            Tooltip(
                              message:
                                  leaveMessage ??
                                  s.lookup(
                                    's4.lib.housekeeping_roster_board.approved_leave_on_date',
                                  ),
                              child: _StatusPill(
                                label: s.lookup(
                                  's4.lib.housekeeping_roster_board.approved_leave',
                                ),
                                color: AppTheme.errorOnSurface,
                              ),
                            ),
                          if (riskBand != null) ...[
                            const SizedBox(width: 6),
                            Tooltip(
                              message: topFactors
                                  .take(3)
                                  .map((item) {
                                    if (item is Map) {
                                      return item['label']?.toString() ?? '';
                                    }
                                    return '';
                                  })
                                  .where((item) => item.isNotEmpty)
                                  .join(' - '),
                              child: _StatusPill(
                                label: s.format(
                                  's4.dynamic.housekeeping_roster_board.risk_score',
                                  {
                                    'risk': riskBand,
                                    'score': forecast?['score'] ?? '',
                                  },
                                ).trim(),
                                color: riskColor(riskBand),
                              ),
                            ),
                          ],
                        ],
                      ),
                      if (blockedByLeave && leaveMessage != null) ...[
                        const SizedBox(height: 4),
                        Text(
                          leaveMessage,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: AppTheme.errorOnSurface,
                            fontSize: 12,
                          ),
                        ),
                      ],
                      const SizedBox(height: 4),
                      Text(
                        [
                          asText(
                            row['employee_id'],
                            fallback: s.lookup(
                              's4.lib.housekeeping_command.no_id',
                            ),
                          ),
                          asText(row['role'], fallback: ''),
                          staffAssignedTargetLabel(staffId) ??
                              s.lookup(
                                's4.lib.housekeeping_roster_board.unassigned',
                              ),
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
                    decoration: InputDecoration(
                      labelText: AppStrings.of(
                        context,
                      ).lookup('profile.field.shift'),
                      prefixIcon: const Icon(Icons.schedule_outlined),
                    ),
                    items: [
                      const DropdownMenuItem<String?>(
                        value: null,
                        child: AppText(
                          's4.lib.housekeeping_roster_board.off_unassigned',
                        ),
                      ),
                      ...shifts.map((shift) {
                        final disabled =
                            blockedByLeave && shift.label != selectedShift;
                        return DropdownMenuItem<String?>(
                          value: shift.label,
                          enabled: !disabled,
                          child: Text(
                            shift.label,
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
                        : (value) => onShiftChanged(staffId, value),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: DropdownButtonFormField<int?>(
                    key: ValueKey('target-$staffId-$selectedTarget'),
                    initialValue: selectedTarget,
                    isExpanded: true,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(
                        context,
                      ).lookup('s4.lib.housekeeping_roster_board.ward_unit'),
                      prefixIcon: const Icon(Icons.location_on_outlined),
                    ),
                    items: [
                      const DropdownMenuItem<int?>(
                        value: null,
                        child: AppText(
                          's4.lib.housekeeping_roster_board.unassigned',
                        ),
                      ),
                      ...targets.map((target) {
                        final targetId = asInt(target['id']);
                        final occupied =
                            selectedShift != null &&
                            targetId != null &&
                            targetOccupiedByOtherStaff(
                              shiftLabel: selectedShift,
                              targetId: targetId,
                              staffId: staffId,
                            );
                        final disabled =
                            occupied ||
                            (blockedByLeave && targetId != selectedTarget);
                        return DropdownMenuItem<int?>(
                          value: targetId,
                          enabled: !disabled,
                          child: Text(
                            asText(target['label'] ?? target['name']),
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color:
                                  blockedByLeave && targetId != selectedTarget
                                  ? AppTheme.errorOnSurface
                                  : disabled
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
  final Map<String, dynamic> forecastOverlay;
  final Map<String, dynamic>? selectedDateRisk;
  final bool saving;
  final int? Function(dynamic value) asInt;
  final String Function(dynamic value, {String fallback}) asText;
  final Color Function(dynamic band) riskColor;
  final void Function(int requestId, String decision) onReview;
  final void Function(String decision) onForecastReview;

  const _RosterSignals({
    required this.requests,
    required this.leaveCoverage,
    required this.forecastOverlay,
    required this.selectedDateRisk,
    required this.saving,
    required this.asInt,
    required this.asText,
    required this.riskColor,
    required this.onReview,
    required this.onForecastReview,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final hasForecast = forecastOverlay.isNotEmpty;
    if (requests.isEmpty && leaveCoverage.isEmpty && !hasForecast) {
      return const SizedBox.shrink();
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (hasForecast) ...[
          _ForecastSignalCard(
            forecastOverlay: forecastOverlay,
            selectedDateRisk: selectedDateRisk,
            saving: saving,
            asInt: asInt,
            asText: asText,
            riskColor: riskColor,
            onForecastReview: onForecastReview,
          ),
          const SizedBox(height: 8),
        ],
        if (requests.isNotEmpty) ...[
          AppText(
            's4.lib.housekeeping_roster_board.duty_requests',
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
                            asText(
                              request['staff_name'],
                              fallback: s.lookup(
                                's4.lib.housekeeping_roster_board.staff_fallback',
                              ),
                            ),
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
                        asText(
                          request['shift_label'],
                          fallback: s.lookup(
                            's4.lib.housekeeping_roster_board.any_shift',
                          ),
                        ),
                        asText(
                          request['assignment_target_label'],
                          fallback: s.lookup(
                            's4.lib.housekeeping_roster_board.any_post',
                          ),
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
                              label: const AppText(
                                'clinical_ai.draft.reject_button',
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: FilledButton.icon(
                              onPressed: saving
                                  ? null
                                  : () => onReview(id, 'approved'),
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
          }),
          const SizedBox(height: 8),
        ],
        if (leaveCoverage.isNotEmpty) ...[
          AppText(
            's4.lib.housekeeping_roster_board.leave_and_alternate_cover',
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
                      asText(
                        leave['staff_name'],
                        fallback: s.lookup(
                          's4.lib.housekeeping_roster_board.staff_on_leave',
                        ),
                      ),
                      style: TextStyle(
                        color: AppTheme.textPrimary,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    subtitle: Text(
                      [
                        asText(
                          leave['leave_type'],
                          fallback: s.lookup(
                            's4.lib.housekeeping_roster_board.leave_fallback',
                          ),
                        ),
                        asText(leave['leave_status'], fallback: ''),
                        asText(
                          leave['replacement_staff_name'],
                          fallback: s.lookup(
                            's4.lib.housekeeping_roster_board.no_alternate_approved',
                          ),
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

class _ForecastSignalCard extends StatelessWidget {
  final Map<String, dynamic> forecastOverlay;
  final Map<String, dynamic>? selectedDateRisk;
  final bool saving;
  final int? Function(dynamic value) asInt;
  final String Function(dynamic value, {String fallback}) asText;
  final Color Function(dynamic band) riskColor;
  final void Function(String decision) onForecastReview;

  const _ForecastSignalCard({
    required this.forecastOverlay,
    required this.selectedDateRisk,
    required this.saving,
    required this.asInt,
    required this.asText,
    required this.riskColor,
    required this.onForecastReview,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final state = asText(
      forecastOverlay['governance_state'],
      fallback: 'blocked',
    );
    final review = asText(
      forecastOverlay['review_status'],
      fallback: 'pending',
    );
    final summary = forecastOverlay['summary'] is Map
        ? Map<String, dynamic>.from(forecastOverlay['summary'] as Map)
        : <String, dynamic>{};
    final riskBand = selectedDateRisk?['risk_band'] ?? 'low';
    final runId = asInt(forecastOverlay['run_id']);
    final sources = forecastOverlay['source_count'] ?? 0;
    final stateLabel = switch (state) {
      'ai' => s.lookup('s4.lib.housekeeping_roster_board.forecast_state.ai'),
      'schema-unavailable' => s.lookup(
        's4.lib.housekeeping_roster_board.forecast_state.schema_unavailable',
      ),
      'blocked' => s.lookup(
        's4.lib.housekeeping_roster_board.forecast_state.not_generated',
      ),
      _ => state,
    };
    final reviewLabel = switch (review) {
      'accepted' => s.lookup('s4.lib.housekeeping_roster_board.accepted'),
      'discarded' => s.lookup('s4.lib.housekeeping_roster_board.discarded'),
      'approved' => s.lookup('s4.lib.leave_approvals.status.approved'),
      'rejected' => s.lookup('s4.lib.leave_approvals.status.rejected'),
      _ => review,
    };
    final sourceBreakdown = forecastOverlay['source_breakdown'] is Map
        ? Map<String, dynamic>.from(forecastOverlay['source_breakdown'] as Map)
        : <String, dynamic>{};
    final sourceLabels = sourceBreakdown.entries
        .map((entry) {
          final value = entry.value is Map
              ? Map<String, dynamic>.from(entry.value as Map)
              : <String, dynamic>{};
          return s.format('s4.dynamic.housekeeping_roster_board.source_state', {
            'source': entry.key.replaceAll('_', ' '),
            'state':
                value['state'] ??
                s.lookup('s4.lib.housekeeping_roster_board.unknown'),
          });
        })
        .take(6)
        .join(' - ');

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
                  Icons.auto_graph_outlined,
                  color: AppTheme.primaryBlue,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: AppText(
                    's4.lib.housekeeping_roster_board.ai_rules_roster_forecast',
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                _StatusPill(
                  label: stateLabel,
                  color: state == 'ai'
                      ? AppTheme.primaryBlue
                      : state == 'schema-unavailable'
                      ? AppTheme.errorOnSurface
                      : AppTheme.warningOnSurface,
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              asText(
                summary['narrative'],
                fallback: s.lookup(
                  's4.lib.housekeeping_roster_board.forecast_empty_narrative',
                ),
              ),
              style: TextStyle(color: AppTheme.textPrimary),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _StatusPill(
                  label: s.format(
                    's4.dynamic.housekeeping_roster_board.forecast_review_state',
                    {'review': reviewLabel},
                  ),
                  color: AppTheme.primaryTeal,
                ),
                _StatusPill(
                  label: s.format(
                    's4.dynamic.housekeeping_roster_board.forecast_source_count',
                    {'count': sources},
                  ),
                  color: AppTheme.primaryBlue,
                ),
                if (selectedDateRisk != null)
                  _StatusPill(
                    label: s.format(
                      's4.dynamic.housekeeping_roster_board.forecast_today_buffer',
                      {
                        'risk': riskBand,
                        'buffer':
                            selectedDateRisk!['recommended_buffer_count'] ?? 0,
                      },
                    ),
                    color: riskColor(riskBand),
                  ),
              ],
            ),
            if (sourceLabels.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                sourceLabels,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
              ),
            ],
            if (runId != null && review == 'pending') ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: saving
                          ? null
                          : () => onForecastReview('discarded'),
                      icon: const Icon(Icons.close),
                      label: const AppText(
                        's4.lib.housekeeping_roster_board.discard_forecast',
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: saving
                          ? null
                          : () => onForecastReview('accepted'),
                      icon: const Icon(Icons.check),
                      label: const AppText(
                        's4.lib.housekeeping_roster_board.accept_for_planning',
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
        AppStrings.forLocale(
          WidgetsBinding.instance.platformDispatcher.locale,
        ).format(
          's4.dynamic.housekeeping_roster_board.custom_shift_default_name',
          {'hour': TimeOfDay.now().hour.toString().padLeft(2, '0')},
        );
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
    if (!valid) {
      return AppStrings.of(
        context,
      ).lookup('s4.lib.housekeeping_roster_board.time_format_hhmm');
    }
    final parts = text.split(':').map(int.parse).toList();
    if (parts[0] > 23 || parts[1] > 59) {
      return AppStrings.of(
        context,
      ).lookup('s4.lib.housekeeping_roster_board.time_format_hhmm');
    }
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
      title: AppText(
        's4.lib.housekeeping_roster_board.add_custom_shift',
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
                labelText: AppStrings.of(context).format(
                  's4.dynamic.housekeeping.shift_name_label',
                  {'department': widget.departmentLabel},
                ),
                prefixIcon: const Icon(Icons.label_outline),
              ),
              validator: (value) {
                final text = value?.trim() ?? '';
                if (text.isEmpty) {
                  return AppStrings.of(context).lookup(
                    's4.lib.housekeeping_roster_board.shift_name_required',
                  );
                }
                return null;
              },
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextFormField(
                    controller: _startController,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(
                        context,
                      ).lookup('investigations.start_button'),
                      hintText: AppStrings.of(
                        context,
                      ).lookup('s4.lib.housekeeping_roster_board.07_30'),
                      prefixIcon: const Icon(Icons.play_arrow_outlined),
                    ),
                    validator: _validateTime,
                    keyboardType: TextInputType.datetime,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: TextFormField(
                    controller: _endController,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(
                        context,
                      ).lookup('s4.lib.housekeeping_command.end'),
                      hintText: AppStrings.of(
                        context,
                      ).lookup('s4.lib.housekeeping_roster_board.12_30'),
                      prefixIcon: const Icon(Icons.stop_outlined),
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
          child: const AppText('action.cancel'),
        ),
        FilledButton.icon(
          onPressed: _submit,
          icon: const Icon(Icons.add),
          label: const AppText('s4.lib.housekeeping_roster_board.add'),
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

class _InfoBanner extends StatelessWidget {
  final String text;

  const _InfoBanner({required this.text});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.primaryBlue.withValues(alpha: 0.10),
        border: Border.all(color: AppTheme.primaryBlue.withValues(alpha: 0.32)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          const Icon(Icons.info_outline, color: AppTheme.primaryBlue),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: TextStyle(color: AppTheme.textPrimary)),
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
