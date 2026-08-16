import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../../core/config/api_config.dart';
import '../../../core/services/attendance_api_service.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class ScheduleScreen extends StatefulWidget {
  const ScheduleScreen({super.key});

  @override
  State<ScheduleScreen> createState() => _ScheduleScreenState();
}

class _ScheduleScreenState extends State<ScheduleScreen> {
  DateTime _weekStart = _getWeekStart(DateTime.now());
  List<Map<String, dynamic>> _records = [];
  List<Map<String, dynamic>> _assignments = [];
  bool _loading = true;
  String? _error;
  String? _rosterError;

  static DateTime _getWeekStart(DateTime date) {
    final diff = date.weekday - DateTime.monday;
    return DateTime(date.year, date.month, date.day - diff);
  }

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() {
      _loading = true;
      _error = null;
      _rosterError = null;
    });
    try {
      final weekEnd = _weekStart.add(const Duration(days: 6));
      final startStr = DateFormat('yyyy-MM-dd').format(_weekStart);
      final endStr = DateFormat('yyyy-MM-dd').format(weekEnd);

      final records = <Map<String, dynamic>>[];
      String? attendanceError;
      try {
        final result = await AttendanceApiService.getAttendanceHistory(
          startDate: startStr,
          endDate: endStr,
          limit: 50,
        );
        if (result['records'] is List) {
          for (final r in result['records']) {
            if (r is Map) records.add(Map<String, dynamic>.from(r));
          }
        } else if (result['attendance'] is List) {
          for (final r in result['attendance']) {
            if (r is Map) records.add(Map<String, dynamic>.from(r));
          }
        }
      } catch (e) {
        try {
          final staffId = await ApiConfig.getStaffId();
          final fallback = await AttendanceApiService.getAttendance(
            staffId ?? '',
            startDate: startStr,
            endDate: endStr,
            limit: 50,
          );
          if (fallback['records'] is List) {
            for (final r in fallback['records']) {
              if (r is Map) records.add(Map<String, dynamic>.from(r));
            }
          } else if (fallback['attendance'] is List) {
            for (final r in fallback['attendance']) {
              if (r is Map) records.add(Map<String, dynamic>.from(r));
            }
          }
        } catch (fallbackError) {
          attendanceError = fallbackError.toString().replaceFirst(
            'Exception: ',
            '',
          );
        }
      }

      final rosterAssignments = <Map<String, dynamic>>[];
      String? rosterError;
      try {
        final rows = await HrApiService.getMyRosterAssignments(
          startDate: startStr,
          endDate: endStr,
        );
        for (final row in rows) {
          if (row is Map) {
            rosterAssignments.add(Map<String, dynamic>.from(row));
          }
        }
      } catch (e) {
        rosterError = e.toString().replaceFirst('Exception: ', '');
      }

      if (mounted) {
        setState(() {
          _records = records;
          _assignments = rosterAssignments;
          _error = attendanceError;
          _rosterError = rosterError;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _changeWeek(int delta) {
    setState(() {
      _weekStart = _weekStart.add(Duration(days: 7 * delta));
    });
    _loadData();
  }

  /// Find attendance record for a given date
  Map<String, dynamic>? _recordForDate(DateTime date) {
    final dateStr = DateFormat('yyyy-MM-dd').format(date);
    for (final r in _records) {
      final rDate = r['date'] ?? r['checkInTime'] ?? r['createdAt'] ?? '';
      if (rDate.toString().startsWith(dateStr)) return r;
    }
    return null;
  }

  List<Map<String, dynamic>> _assignmentsForDate(DateTime date) {
    final dateStr = DateFormat('yyyy-MM-dd').format(date);
    return _assignments
        .where((row) => row['roster_date'].toString().startsWith(dateStr))
        .toList();
  }

  String _asText(dynamic value, {String fallback = '-'}) {
    final text = value?.toString().trim();
    return text == null || text.isEmpty ? fallback : text;
  }

  double get _totalHours {
    double total = 0;
    for (int i = 0; i < 7; i++) {
      final day = _weekStart.add(Duration(days: i));
      final rec = _recordForDate(day);
      if (rec != null) {
        final hours = _hoursForRecord(rec);
        if (hours != null) total += hours;
      }
    }
    return total;
  }

  double? _hoursForRecord(Map<String, dynamic> rec) {
    if (rec['hoursWorked'] != null) {
      return (rec['hoursWorked'] as num).toDouble();
    }
    final checkIn = rec['checkInTime'] ?? rec['checkIn'];
    final checkOut = rec['checkOutTime'] ?? rec['checkOut'];
    if (checkIn != null && checkOut != null) {
      try {
        final inTime = DateTime.parse(checkIn.toString());
        final outTime = DateTime.parse(checkOut.toString());
        return outTime.difference(inTime).inMinutes / 60.0;
      } catch (e) {
        debugPrint('schedule_screen.dart: $e');
      }
    }
    return null;
  }

  String _formatTime(String? isoStr) {
    if (isoStr == null) return '--:--';
    try {
      return DateFormat('HH:mm').format(DateTime.parse(isoStr));
    } catch (e) {
      if (RegExp(r'^\d{2}:\d{2}').hasMatch(isoStr)) {
        return isoStr.substring(0, 5);
      }
      return isoStr.length >= 16 ? isoStr.substring(11, 16) : isoStr;
    }
  }

  bool _isToday(DateTime date) {
    final now = DateTime.now();
    return date.year == now.year &&
        date.month == now.month &&
        date.day == now.day;
  }

  String _weekLabel(AppStrings s) {
    final now = DateTime.now();
    final thisWeekStart = _getWeekStart(now);
    if (_weekStart == thisWeekStart) return s.scheduleWeekThis;
    final diff = _weekStart.difference(thisWeekStart).inDays;
    if (diff == 7) return s.scheduleWeekNext;
    if (diff == -7) return s.scheduleWeekLast;
    return '${DateFormat('d MMM').format(_weekStart)} – ${DateFormat('d MMM').format(_weekStart.add(const Duration(days: 6)))}';
  }

  String _assignmentLocation(AppStrings s, Map<String, dynamic> assignment) {
    final parts = [
      _asText(assignment['assignment_target_label'], fallback: ''),
      _asText(assignment['floor'], fallback: ''),
      _asText(assignment['building'], fallback: ''),
    ].where((part) => part.isNotEmpty).toList();
    return parts.isEmpty
        ? s.lookup('s4.lib.schedule.assigned_duty')
        : parts.join(' - ');
  }

  Widget _buildRosterLine(AppStrings s, Map<String, dynamic> assignment) {
    final shift = _asText(
      assignment['shift_label'],
      fallback: s.lookup('s4.lib.schedule.duty'),
    );
    final start = _formatTime(assignment['shift_start']?.toString());
    final end = _formatTime(assignment['shift_end']?.toString());
    final isLead = assignment['is_lead'] == true;
    final lineKey = isLead
        ? 's4.dynamic.schedule.assignment_line_lead'
        : 's4.dynamic.schedule.assignment_line';
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: AppTheme.primaryBlue.withValues(alpha: 0.10),
        border: Border.all(color: AppTheme.primaryBlue.withValues(alpha: 0.25)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(
            Icons.work_history_outlined,
            size: 18,
            color: AppTheme.primaryBlue,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  s.format(lineKey, {
                    'shift': shift,
                    'start': start,
                    'end': end,
                  }),
                  style: const TextStyle(
                    color: AppTheme.primaryBlue,
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  _assignmentLocation(s, assignment),
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildShiftActions() {
    final s = AppStrings.of(context);
    final actions = [
      _RosterAction(
        icon: Icons.swap_calls_outlined,
        label: s.lookup('role.feature.duty_preference'),
        route: '/duty-preference',
        color: AppTheme.primaryBlue,
      ),
      _RosterAction(
        icon: Icons.swap_horiz,
        label: s.lookup('s4.lib.shift_swap.title'),
        route: '/shift-swaps',
        color: const Color(0xFF00695C),
      ),
      _RosterAction(
        icon: Icons.event_available_outlined,
        label: s.leaveTitle,
        route: '/leave',
        color: const Color(0xFF007A64),
      ),
      _RosterAction(
        icon: Icons.fingerprint,
        label: s.attendanceTitle,
        route: '/attendance',
        color: const Color(0xFF6A1B9A),
      ),
    ];

    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AppText(
              's4.lib.schedule.shift_actions',
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontSize: 16,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 12),
            LayoutBuilder(
              builder: (context, constraints) {
                final isWide = constraints.maxWidth >= 620;
                final width = isWide
                    ? (constraints.maxWidth - 16) / 3
                    : constraints.maxWidth;
                return Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: actions
                      .map(
                        (action) => SizedBox(
                          width: width,
                          height: 56,
                          child: OutlinedButton.icon(
                            onPressed: () => context.push(action.route),
                            icon: Icon(action.icon, color: action.color),
                            label: Text(action.label),
                            style: OutlinedButton.styleFrom(
                              foregroundColor: action.color,
                              alignment: Alignment.centerLeft,
                              textStyle: const TextStyle(
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ),
                        ),
                      )
                      .toList(),
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.scheduleTitle),
        actions: const [LogoutAction()],
      ),
      body: RefreshIndicator(
        onRefresh: _loadData,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            // Week navigator
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                IconButton(
                  icon: const Icon(Icons.chevron_left),
                  tooltip: AppStrings.of(context).lookup('schedule.prev_week'),
                  onPressed: () => _changeWeek(-1),
                ),
                Text(
                  _weekLabel(s),
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.chevron_right),
                  tooltip: AppStrings.of(context).lookup('schedule.next_week'),
                  onPressed: () => _changeWeek(1),
                ),
              ],
            ),
            const SizedBox(height: 8),

            // Published duty roster + attendance summary
            Card(
              color: AppTheme.primaryBlue,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    const Icon(Icons.event_available, color: Colors.white),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            s.format(
                              _assignments.length == 1
                                  ? 's4.dynamic.schedule.rostered_shift_count.one'
                                  : 's4.dynamic.schedule.rostered_shift_count.other',
                              {'count': _assignments.length},
                            ),
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 18,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            s.format('s4.dynamic.schedule.attendance_summary', {
                              'days': _records.length,
                              'hours': _totalHours.toStringAsFixed(1),
                            }),
                            style: const TextStyle(
                              color: Colors.white70,
                              fontSize: 13,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            _buildShiftActions(),
            const SizedBox(height: 12),
            if (_rosterError != null)
              Card(
                color: AppTheme.warningOnSurface.withValues(alpha: 0.12),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Row(
                    children: [
                      Icon(
                        Icons.info_outline,
                        color: AppTheme.warningOnSurface,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          s.format(
                            's4.dynamic.schedule.published_roster_unavailable',
                            {'error': _rosterError},
                          ),
                          style: TextStyle(
                            color: AppTheme.warningOnSurface,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            if (_error != null)
              Card(
                color: AppTheme.warningOnSurface.withValues(alpha: 0.12),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Row(
                    children: [
                      Icon(
                        Icons.info_outline,
                        color: AppTheme.warningOnSurface,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          s.format(
                            's4.dynamic.schedule.attendance_unavailable',
                            {'error': _error},
                          ),
                          style: TextStyle(
                            color: AppTheme.warningOnSurface,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),

            if (_loading)
              const Padding(
                padding: EdgeInsets.all(32),
                child: Center(child: CircularProgressIndicator()),
              )
            else
              // Day-by-day timeline
              ...List.generate(7, (i) {
                final day = _weekStart.add(Duration(days: i));
                final rec = _recordForDate(day);
                final assignments = _assignmentsForDate(day);
                final isToday = _isToday(day);
                final hours = rec != null ? _hoursForRecord(rec) : null;
                final checkIn = rec?['checkInTime'] ?? rec?['checkIn'];
                final checkOut = rec?['checkOutTime'] ?? rec?['checkOut'];

                return Card(
                  elevation: isToday ? 3 : 1,
                  color: isToday
                      ? AppTheme.primaryBlue.withValues(alpha: 0.05)
                      : null,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                    side: isToday
                        ? const BorderSide(
                            color: AppTheme.primaryBlue,
                            width: 2,
                          )
                        : BorderSide.none,
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Row(
                      children: [
                        // Day column
                        SizedBox(
                          width: 48,
                          child: Column(
                            children: [
                              Text(
                                DateFormat('E').format(day),
                                style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w600,
                                  color: isToday
                                      ? AppTheme.primaryBlue
                                      : Colors.grey,
                                ),
                              ),
                              Text(
                                DateFormat('d').format(day),
                                style: TextStyle(
                                  fontSize: 20,
                                  fontWeight: FontWeight.bold,
                                  color: isToday
                                      ? AppTheme.primaryBlue
                                      : AppTheme.textPrimary,
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 12),
                        // Times
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              ...assignments.map(
                                (assignment) => _buildRosterLine(s, assignment),
                              ),
                              if (rec != null)
                                Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      children: [
                                        const Icon(
                                          Icons.login,
                                          size: 16,
                                          color: Colors.green,
                                        ),
                                        const SizedBox(width: 4),
                                        Text(
                                          _formatTime(checkIn?.toString()),
                                          style: const TextStyle(fontSize: 14),
                                        ),
                                        const SizedBox(width: 16),
                                        const Icon(
                                          Icons.logout,
                                          size: 16,
                                          color: Colors.red,
                                        ),
                                        const SizedBox(width: 4),
                                        Text(
                                          _formatTime(checkOut?.toString()),
                                          style: const TextStyle(fontSize: 14),
                                        ),
                                      ],
                                    ),
                                    if (hours != null)
                                      Padding(
                                        padding: const EdgeInsets.only(top: 4),
                                        child: Text(
                                          s.format(
                                            's4.dynamic.schedule.hours_worked',
                                            {'hours': hours.toStringAsFixed(1)},
                                          ),
                                          style: const TextStyle(
                                            fontSize: 12,
                                            color: Colors.grey,
                                          ),
                                        ),
                                      ),
                                  ],
                                )
                              else
                                Text(
                                  assignments.isNotEmpty
                                      ? s.lookup(
                                          's4.lib.schedule.no_attendance_logged_yet',
                                        )
                                      : (day.isAfter(DateTime.now())
                                            ? s.lookup(
                                                's4.lib.schedule.no_published_duty',
                                              )
                                            : s.scheduleNoRecord),
                                  style: const TextStyle(
                                    color: Colors.grey,
                                    fontSize: 13,
                                  ),
                                ),
                            ],
                          ),
                        ),
                        // Status indicator
                        Container(
                          width: 10,
                          height: 10,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: rec != null
                                ? Colors.green
                                : (assignments.isNotEmpty
                                      ? AppTheme.primaryBlue
                                      : day.isAfter(DateTime.now())
                                      ? Colors.grey.shade300
                                      : Colors.orange.shade300),
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              }),
          ],
        ),
      ),
    );
  }
}

class _RosterAction {
  final IconData icon;
  final String label;
  final String route;
  final Color color;

  const _RosterAction({
    required this.icon,
    required this.label,
    required this.route,
    required this.color,
  });
}
