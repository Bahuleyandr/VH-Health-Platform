import 'package:flutter/material.dart';
import 'package:table_calendar/table_calendar.dart';
import 'package:intl/intl.dart';
import '../../../core/config/api_config.dart';
import '../../../core/services/attendance_api_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/services/location_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/success_toast.dart';
import '../../../l10n/app_strings.dart';
import '../widgets/shift_card.dart';
import '../widgets/break_tracker.dart';
import 'dispute_screen.dart';

class AttendanceScreen extends StatefulWidget {
  const AttendanceScreen({super.key});

  @override
  State<AttendanceScreen> createState() => _AttendanceScreenState();
}

class _AttendanceScreenState extends State<AttendanceScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  bool _checkedIn = false;
  String? _checkInTime;
  Map<String, dynamic>? _locationData;
  bool _gettingLocation = false;
  bool _loading = true;
  bool _actionLoading = false;
  String? _error;

  // Calendar state
  DateTime _focusedDay = DateTime.now();
  DateTime? _selectedDay;
  Map<String, Map<String, dynamic>> _calendarData = {};
  // ignore: unused_field
  bool _calendarLoading = false;

  // History
  List<dynamic> _history = [];

  // Shift and break state
  Map<String, dynamic>? _shift;
  String? _staffId;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _loadTodayStatus();
    _loadCalendar();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadTodayStatus() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      // Get staff ID first
      _staffId = await ApiConfig.getStaffId();

      final status = await AttendanceApiService.getAttendanceStatus();
      _checkedIn =
          status['isCheckedIn'] == true || status['status'] == 'checked-in';
      _checkInTime = status['checkInTime']?.toString();

      // Load shift
      try {
        final shift = await ScheduleApiService.getMyShift();
        _shift = shift;
      } catch (e) {
        _shift = null;
      }

      // Load history
      try {
        final hist = await AttendanceApiService.getAttendanceHistory();
        _history =
            hist['records'] as List? ??
            hist['history'] as List? ??
            hist['attendance'] as List? ??
            [];
      } catch (e) {
        if (_staffId != null) {
          final hist = await AttendanceApiService.getAttendance(_staffId!);
          _history =
              hist['records'] as List? ?? hist['attendance'] as List? ?? [];
        }
      }
    } catch (e) {
      _error = e.toString().replaceFirst('Exception: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadCalendar() async {
    setState(() => _calendarLoading = true);
    try {
      final staffId = await ApiConfig.getStaffId();
      if (staffId == null) return;
      final data = await AttendanceApiService.getAttendanceCalendar(
        staffId: staffId,
        year: _focusedDay.year,
        month: _focusedDay.month,
      );
      final days = data['days'] as List? ?? [];
      final map = <String, Map<String, dynamic>>{};
      for (final day in days) {
        map[day['date'] as String] = Map<String, dynamic>.from(day as Map);
      }
      if (mounted) setState(() => _calendarData = map);
    } catch (e) {
      debugPrint('attendance_screen.dart: $e');
    } finally {
      if (mounted) setState(() => _calendarLoading = false);
    }
  }

  Future<void> _getLocationAndCheckIn() async {
    setState(() => _gettingLocation = true);
    final locationData = await LocationService.getLocationData();
    setState(() {
      _locationData = locationData;
      _gettingLocation = false;
    });

    if (locationData.containsKey('error')) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('📍 ${locationData['error']}'),
            backgroundColor: Colors.red,
          ),
        );
      }
      return;
    }

    final withinCampus = locationData['withinCampus'] as bool? ?? false;
    if (!withinCampus) {
      final distance = locationData['distanceFromCampus'] as int? ?? 0;
      if (mounted) {
        final s = AppStrings.of(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.attendanceOutsideCampusDistance(distance)),
            backgroundColor: Colors.red,
            duration: const Duration(seconds: 4),
          ),
        );
      }
      return;
    }

    await _performCheckIn(locationData);
  }

  Future<void> _performCheckIn(Map<String, dynamic> location) async {
    final staffId = await ApiConfig.getStaffId();
    if (staffId == null) return;

    setState(() => _actionLoading = true);
    try {
      final action = _checkedIn ? 'check-out' : 'check-in';
      await AttendanceApiService.markAttendanceWithLocation(
        staffId: staffId,
        action: action,
        location: location,
      );
      if (mounted) {
        final s = AppStrings.of(context);
        SuccessToast.show(
          context,
          _checkedIn
              ? s.attendanceCheckedOutSuccess
              : s.attendanceCheckedInSuccess,
        );
      }
      await _loadTodayStatus();
      await _loadCalendar();
    } catch (e) {
      if (mounted) {
        ErrorToast.show(
          context,
          e.toString().replaceFirst('Exception: ', ''),
        );
      }
    } finally {
      if (mounted) setState(() => _actionLoading = false);
    }
  }

  Color _getDayColor(String status) {
    switch (status) {
      case 'present':
        return Colors.green.shade400;
      case 'absent':
        return Colors.red.shade400;
      case 'leave':
        return Colors.blue.shade400;
      case 'late':
        return Colors.orange.shade400;
      case 'weekend':
        return Colors.grey.shade300;
      default:
        return Colors.transparent;
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.attendanceTitle,
      showBottomNav: false,
      body: Column(
        children: [
          TabBar(
            controller: _tabController,
            labelColor: AppTheme.primaryBlue,
            indicatorColor: AppTheme.primaryBlue,
            tabs: [
              Tab(text: s.attendanceTabToday),
              Tab(text: s.attendanceTabCalendar),
              Tab(text: s.attendanceTabHistory),
            ],
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _buildTodayTab(),
                _buildCalendarTab(),
                _buildHistoryTab(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTodayTab() {
    final s = AppStrings.of(context);
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(_error!, style: const TextStyle(color: Colors.red)),
            const SizedBox(height: 12),
            ElevatedButton(
              onPressed: _loadTodayStatus,
              child: Text(s.actionRetry),
            ),
          ],
        ),
      );
    }

    final now = DateTime.now();
    final timeStr = DateFormat('HH:mm').format(now);
    final dateStr = DateFormat('EEEE, d MMMM yyyy').format(now);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          // Status card
          Card(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                children: [
                  Text(
                    timeStr,
                    style: const TextStyle(
                      fontSize: 48,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  Text(dateStr, style: TextStyle(color: Colors.grey.shade600)),
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      color: _checkedIn
                          ? Colors.green.shade100
                          : Colors.grey.shade100,
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      _checkedIn
                          ? '${s.attendanceCheckedInBadge}${_checkInTime != null ? ' ${s.attendanceCheckedInAt} ${_checkInTime!.length >= 16 ? _checkInTime!.substring(11, 16) : _checkInTime!}' : ''}'
                          : s.attendanceNotCheckedInBadge,
                      style: TextStyle(
                        color: _checkedIn
                            ? Colors.green.shade700
                            : Colors.grey.shade600,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),

          // Shift card
          ShiftCard(shift: _shift),
          const SizedBox(height: 16),

          // Location status
          if (_locationData != null)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    Icon(
                      (_locationData!['withinCampus'] as bool? ?? false)
                          ? Icons.location_on
                          : Icons.location_off,
                      color: (_locationData!['withinCampus'] as bool? ?? false)
                          ? Colors.green
                          : Colors.red,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        LocationService.getLocationStatusMessage(
                          _locationData!,
                        ),
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                  ],
                ),
              ),
            ),

          const SizedBox(height: 20),

          // Check-in/out button
          SizedBox(
            width: double.infinity,
            height: 56,
            child: ElevatedButton.icon(
              onPressed: (_actionLoading || _gettingLocation)
                  ? null
                  : (_checkedIn
                        ? () => _performCheckIn({})
                        : _getLocationAndCheckIn),
              style: ElevatedButton.styleFrom(
                backgroundColor: _checkedIn
                    ? Colors.red.shade600
                    : AppTheme.primaryBlue,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              icon: (_actionLoading || _gettingLocation)
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        color: Colors.white,
                        strokeWidth: 2,
                      ),
                    )
                  : Icon(
                      _checkedIn ? Icons.logout : Icons.login,
                      color: Colors.white,
                    ),
              label: Text(
                _gettingLocation
                    ? s.attendanceGettingLocation
                    : (_actionLoading
                          ? s.attendanceProcessing
                          : (_checkedIn
                                ? s.attendanceCheckOut
                                : s.attendanceCheckIn)),
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                  color: Colors.white,
                ),
              ),
            ),
          ),

          if (!_checkedIn)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                s.attendanceLocationVerifyHint,
                style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
              ),
            ),

          const SizedBox(height: 16),

          // Break tracker (only when checked in)
          if (_staffId != null && _checkedIn)
            BreakTracker(staffId: _staffId!, checkedIn: _checkedIn),

          const SizedBox(height: 16),

          // Dispute button
          TextButton.icon(
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => const DisputeScreen()),
            ),
            icon: const Icon(Icons.report_problem_outlined),
            label: Text(s.attendanceReportIssue),
          ),
        ],
      ),
    );
  }

  Widget _buildCalendarTab() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(8),
      child: Column(
        children: [
          TableCalendar(
            firstDay: DateTime(2024),
            lastDay: DateTime(2027),
            focusedDay: _focusedDay,
            selectedDayPredicate: (day) => isSameDay(_selectedDay, day),
            onDaySelected: (selected, focused) {
              setState(() {
                _selectedDay = selected;
                _focusedDay = focused;
              });
            },
            onPageChanged: (focused) {
              setState(() => _focusedDay = focused);
              _loadCalendar();
            },
            calendarStyle: const CalendarStyle(
              todayDecoration: BoxDecoration(
                color: Color(0xFF007A64),
                shape: BoxShape.circle,
              ),
              selectedDecoration: BoxDecoration(
                color: Color(0xFF005A48),
                shape: BoxShape.circle,
              ),
            ),
            calendarBuilders: CalendarBuilders(
              defaultBuilder: (ctx, day, _) {
                final dateStr = DateFormat('yyyy-MM-dd').format(day);
                final dayData = _calendarData[dateStr];
                if (dayData == null) return null;
                final status = dayData['status'] as String? ?? '';
                if (status == 'weekend') return null;
                return Container(
                  margin: const EdgeInsets.all(4),
                  decoration: BoxDecoration(
                    color: _getDayColor(status).withValues(alpha: 0.3),
                    shape: BoxShape.circle,
                    border: Border.all(color: _getDayColor(status), width: 1.5),
                  ),
                  child: Center(
                    child: Text(
                      '${day.day}',
                      style: TextStyle(
                        color: _getDayColor(status).withValues(alpha: 1.0),
                        fontWeight: FontWeight.bold,
                        fontSize: 12,
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
          const SizedBox(height: 8),
          // Legend
          Builder(
            builder: (context) {
              final s = AppStrings.of(context);
              return Wrap(
                spacing: 12,
                children: [
                  _legendItem(Colors.green.shade400, s.attendanceLegendPresent),
                  _legendItem(Colors.red.shade400, s.attendanceLegendAbsent),
                  _legendItem(Colors.blue.shade400, s.attendanceLegendLeave),
                  _legendItem(Colors.orange.shade400, s.attendanceLegendLate),
                ],
              );
            },
          ),
          // Selected day detail
          if (_selectedDay != null) ...[
            const SizedBox(height: 12),
            _buildSelectedDayDetail(),
          ],
          // Monthly summary
          if (_calendarData.isNotEmpty) ...[
            const SizedBox(height: 16),
            _buildMonthlySummary(),
          ],
        ],
      ),
    );
  }

  Widget _legendItem(Color color, String label) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 12,
          height: 12,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Text(label, style: const TextStyle(fontSize: 12)),
      ],
    );
  }

  Widget _buildSelectedDayDetail() {
    final s = AppStrings.of(context);
    final dateStr = DateFormat('yyyy-MM-dd').format(_selectedDay!);
    final dayData = _calendarData[dateStr];
    if (dayData == null) return const SizedBox.shrink();
    final status = dayData['status'] as String? ?? 'absent';

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              DateFormat('EEEE, d MMMM').format(_selectedDay!),
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: _getDayColor(status),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  status.toUpperCase(),
                  style: TextStyle(
                    color: _getDayColor(status),
                    fontWeight: FontWeight.w600,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
            if (dayData['checkIn'] != null) ...[
              const SizedBox(height: 4),
              Text(
                '${s.attendanceCheckInLabel}: ${(dayData['checkIn'] as String).length >= 16 ? (dayData['checkIn'] as String).substring(11, 16) : dayData['checkIn']}',
              ),
            ],
            if (dayData['checkOut'] != null) ...[
              Text(
                '${s.attendanceCheckOutLabel}: ${(dayData['checkOut'] as String).length >= 16 ? (dayData['checkOut'] as String).substring(11, 16) : dayData['checkOut']}',
              ),
            ],
            if (dayData['hoursWorked'] != null) ...[
              Text(
                '${s.attendanceHoursLabel}: ${dayData['hoursWorked']}h',
                style: const TextStyle(fontWeight: FontWeight.bold),
              ),
            ],
            if (dayData['isLate'] == true) ...[
              Text(
                s.attendanceLateArrival,
                style: const TextStyle(color: Colors.orange, fontSize: 12),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildMonthlySummary() {
    final s = AppStrings.of(context);
    final present = _calendarData.values
        .where((d) => d['status'] == 'present')
        .length;
    final absent = _calendarData.values
        .where((d) => d['status'] == 'absent')
        .length;
    final leave = _calendarData.values
        .where((d) => d['status'] == 'leave')
        .length;
    final late = _calendarData.values.where((d) => d['isLate'] == true).length;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              DateFormat('MMMM yyyy').format(_focusedDay),
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                _summaryCell('$present', s.attendanceLegendPresent, Colors.green),
                _summaryCell('$absent', s.attendanceLegendAbsent, Colors.red),
                _summaryCell('$leave', s.attendanceLegendLeave, Colors.blue),
                _summaryCell('$late', s.attendanceLegendLate, Colors.orange),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _summaryCell(String count, String label, Color color) {
    return Column(
      children: [
        Text(
          count,
          style: TextStyle(
            fontSize: 24,
            fontWeight: FontWeight.bold,
            color: color,
          ),
        ),
        Text(
          label,
          style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
        ),
      ],
    );
  }

  Widget _buildHistoryTab() {
    final s = AppStrings.of(context);
    if (_history.isEmpty) {
      return Center(
        child: Text(
          s.attendanceNoHistory,
          style: TextStyle(color: Colors.grey.shade600),
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.all(8),
      itemCount: _history.length,
      itemBuilder: (ctx, i) {
        final record = _history[i] as Map<String, dynamic>;
        final checkIn =
            record['check_in_time'] as String? ??
            record['checkIn'] as String? ??
            '';
        final checkOut =
            record['check_out_time'] as String? ??
            record['checkOut'] as String? ??
            '';
        // Date is data, not chrome — leave the fallback as a non-localised
        // sentinel since the row is unusable without a real date anyway.
        final date = checkIn.isNotEmpty ? checkIn.substring(0, 10) : '—';

        return Card(
          child: ListTile(
            leading: Container(
              width: 8,
              color: checkIn.isNotEmpty ? Colors.green : Colors.red,
            ),
            title: Text(date),
            subtitle: checkIn.isNotEmpty
                ? Text(
                    '${s.attendanceHistoryInPrefix} ${checkIn.length >= 16 ? checkIn.substring(11, 16) : checkIn}'
                    '${checkOut.isNotEmpty ? '  ${s.attendanceHistoryOutPrefix} ${checkOut.length >= 16 ? checkOut.substring(11, 16) : checkOut}' : ''}',
                  )
                : Text(s.attendanceHistoryAbsent),
            trailing: (checkIn.isNotEmpty && checkOut.isNotEmpty)
                ? Text(
                    '${_calcHours(checkIn, checkOut)}h',
                    style: const TextStyle(fontWeight: FontWeight.bold),
                  )
                : null,
          ),
        );
      },
    );
  }

  String _calcHours(String checkIn, String checkOut) {
    try {
      final diff = DateTime.parse(checkOut).difference(DateTime.parse(checkIn));
      final h = diff.inHours;
      final m = diff.inMinutes % 60;
      return m == 0 ? '$h' : '$h:${m.toString().padLeft(2, '0')}';
    } catch (e) {
      return '?';
    }
  }
}
