import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/config/api_config.dart';
import '../../../core/services/attendance_api_service.dart';
import '../../../core/theme/app_theme.dart';

class ScheduleScreen extends StatefulWidget {
  const ScheduleScreen({super.key});

  @override
  State<ScheduleScreen> createState() => _ScheduleScreenState();
}

class _ScheduleScreenState extends State<ScheduleScreen> {
  DateTime _weekStart = _getWeekStart(DateTime.now());
  List<Map<String, dynamic>> _records = [];
  bool _loading = true;
  String? _error;

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
    });
    try {
      final weekEnd = _weekStart.add(const Duration(days: 6));
      final startStr = DateFormat('yyyy-MM-dd').format(_weekStart);
      final endStr = DateFormat('yyyy-MM-dd').format(weekEnd);

      // Try auth attendance history first, fall back to staff attendance
      Map<String, dynamic> result;
      try {
        result = await AttendanceApiService.getAttendanceHistory(
          startDate: startStr,
          endDate: endStr,
          limit: 50,
        );
      } catch (e) {
        final staffId = await ApiConfig.getStaffId();
        result = await AttendanceApiService.getAttendance(
          staffId ?? '',
          startDate: startStr,
          endDate: endStr,
          limit: 50,
        );
      }

      final records = <Map<String, dynamic>>[];
      if (result['records'] is List) {
        for (final r in result['records']) {
          if (r is Map<String, dynamic>) records.add(r);
        }
      } else if (result['attendance'] is List) {
        for (final r in result['attendance']) {
          if (r is Map<String, dynamic>) records.add(r);
        }
      }

      if (mounted) setState(() => _records = records);
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
      return isoStr.length > 5 ? isoStr.substring(11, 16) : isoStr;
    }
  }

  bool _isToday(DateTime date) {
    final now = DateTime.now();
    return date.year == now.year &&
        date.month == now.month &&
        date.day == now.day;
  }

  String get _weekLabel {
    final now = DateTime.now();
    final thisWeekStart = _getWeekStart(now);
    if (_weekStart == thisWeekStart) return 'This Week';
    final diff = _weekStart.difference(thisWeekStart).inDays;
    if (diff == 7) return 'Next Week';
    if (diff == -7) return 'Last Week';
    return '${DateFormat('d MMM').format(_weekStart)} – ${DateFormat('d MMM').format(_weekStart.add(const Duration(days: 6)))}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Shift Schedule')),
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
                  onPressed: () => _changeWeek(-1),
                ),
                Text(
                  _weekLabel,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.chevron_right),
                  onPressed: () => _changeWeek(1),
                ),
              ],
            ),
            const SizedBox(height: 8),

            // Total hours
            Card(
              color: AppTheme.primaryBlue,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    const Icon(Icons.access_time, color: Colors.white),
                    const SizedBox(width: 12),
                    Text(
                      'Total: ${_totalHours.toStringAsFixed(1)}h',
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const Spacer(),
                    Text(
                      '${_records.length} days logged',
                      style: const TextStyle(
                        color: Colors.white70,
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),

            if (_loading)
              const Padding(
                padding: EdgeInsets.all(32),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error != null)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    'Could not load schedule: $_error',
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              )
            else
              // Day-by-day timeline
              ...List.generate(7, (i) {
                final day = _weekStart.add(Duration(days: i));
                final rec = _recordForDate(day);
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
                          child: rec != null
                              ? Column(
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
                                          '${hours.toStringAsFixed(1)}h worked',
                                          style: const TextStyle(
                                            fontSize: 12,
                                            color: Colors.grey,
                                          ),
                                        ),
                                      ),
                                  ],
                                )
                              : Text(
                                  day.isAfter(DateTime.now())
                                      ? 'Upcoming'
                                      : 'No record',
                                  style: const TextStyle(
                                    color: Colors.grey,
                                    fontSize: 13,
                                  ),
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
                                : (day.isAfter(DateTime.now())
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
