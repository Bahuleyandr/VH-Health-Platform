import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/config/api_config.dart';
import '../../../core/services/staff_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

class AttendanceScreen extends StatefulWidget {
  const AttendanceScreen({super.key});

  @override
  State<AttendanceScreen> createState() => _AttendanceScreenState();
}

class _AttendanceScreenState extends State<AttendanceScreen> {
  bool _checkedIn = false;
  String? _checkInTime;
  List<dynamic> _history = [];
  bool _loading = true;
  bool _actionLoading = false;
  String? _error;

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
      final status = await StaffApiService.getAttendanceStatus();
      _checkedIn = status['isCheckedIn'] == true ||
          status['status'] == 'checked-in';
      _checkInTime = status['checkInTime']?.toString();

      final staffId = await ApiConfig.getStaffId();
      if (staffId != null) {
        final hist = await StaffApiService.getAttendance(staffId);
        _history = hist['records'] as List? ??
            hist['attendance'] as List? ??
            [];
      }
    } catch (e) {
      _error = e.toString().replaceFirst('Exception: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _toggleAttendance() async {
    final staffId = await ApiConfig.getStaffId();
    if (staffId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Staff ID not found. Please re-login.')),
      );
      return;
    }

    setState(() => _actionLoading = true);
    try {
      final action = _checkedIn ? 'check-out' : 'check-in';
      await StaffApiService.markAttendance(
          staffId: staffId, action: action);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
              _checkedIn ? '✅ Checked out successfully' : '✅ Checked in successfully'),
          backgroundColor: AppTheme.successGreen,
        ),
      );
      await _loadData();
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: AppTheme.errorRed,
        ),
      );
    } finally {
      if (mounted) setState(() => _actionLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Attendance',
      currentIndex: 1,
      showBottomNav: true,
      body: RefreshIndicator(
        onRefresh: _loadData,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_error != null)
                    _ErrorBanner(message: _error!),

                  // Check-in/out card
                  _CheckInCard(
                    isCheckedIn: _checkedIn,
                    checkInTime: _checkInTime,
                    loading: _actionLoading,
                    onToggle: _toggleAttendance,
                  ),
                  const SizedBox(height: 24),

                  // History
                  const Text(
                    'Recent Attendance',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (_history.isEmpty)
                    const _EmptyState(
                      icon: Icons.history,
                      message: 'No attendance records found',
                    )
                  else
                    ..._history.take(30).map((r) => _AttendanceRecord(record: r)),
                ],
              ),
      ),
    );
  }
}

class _CheckInCard extends StatelessWidget {
  final bool isCheckedIn;
  final String? checkInTime;
  final bool loading;
  final VoidCallback onToggle;

  const _CheckInCard({
    required this.isCheckedIn,
    this.checkInTime,
    required this.loading,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    final now = DateFormat('hh:mm a').format(DateTime.now());
    final color = isCheckedIn ? AppTheme.successGreen : AppTheme.primaryBlue;

    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
              color: color.withOpacity(0.15),
              blurRadius: 16,
              offset: const Offset(0, 4))
        ],
      ),
      child: Column(
        children: [
          Container(
            width: 100,
            height: 100,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: color.withOpacity(0.1),
              border: Border.all(color: color, width: 3),
            ),
            child: Icon(
              isCheckedIn ? Icons.check_circle : Icons.radio_button_unchecked,
              color: color,
              size: 48,
            ),
          ),
          const SizedBox(height: 16),
          Text(
            isCheckedIn ? 'You are Checked In' : 'Not Checked In',
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.bold,
              color: color,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            isCheckedIn && checkInTime != null
                ? 'Since: $checkInTime'
                : 'Current time: $now',
            style: const TextStyle(color: AppTheme.textSecondary),
          ),
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: loading ? null : onToggle,
              style: ElevatedButton.styleFrom(
                backgroundColor: color,
                minimumSize: const Size(double.infinity, 54),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
              icon: loading
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                          color: Colors.white, strokeWidth: 2))
                  : Icon(
                      isCheckedIn ? Icons.logout : Icons.login,
                      color: Colors.white,
                    ),
              label: Text(
                loading
                    ? 'Processing...'
                    : isCheckedIn
                        ? 'Check Out'
                        : 'Check In',
                style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    color: Colors.white),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AttendanceRecord extends StatelessWidget {
  final dynamic record;

  const _AttendanceRecord({required this.record});

  @override
  Widget build(BuildContext context) {
    final date = record['date']?.toString() ?? record['createdAt']?.toString() ?? '';
    final action = record['action']?.toString() ?? record['type']?.toString() ?? '—';
    final time = record['time']?.toString() ?? record['timestamp']?.toString() ?? '';
    final isCheckIn =
        action.toLowerCase().contains('check-in') || action.toLowerCase().contains('checkin');

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: (isCheckIn ? AppTheme.successGreen : AppTheme.primaryBlue)
                  .withOpacity(0.1),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Icon(
              isCheckIn ? Icons.login : Icons.logout,
              color:
                  isCheckIn ? AppTheme.successGreen : AppTheme.primaryBlue,
              size: 18,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  action.replaceAll('-', ' ').toUpperCase(),
                  style: const TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 13,
                      color: AppTheme.textPrimary),
                ),
                if (date.isNotEmpty)
                  Text(date,
                      style: const TextStyle(
                          fontSize: 12, color: AppTheme.textSecondary)),
              ],
            ),
          ),
          if (time.isNotEmpty)
            Text(time,
                style: const TextStyle(
                    fontSize: 12, color: AppTheme.textSecondary)),
        ],
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  final String message;
  const _ErrorBanner({required this.message});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.errorRed.withOpacity(0.08),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, color: AppTheme.errorRed, size: 18),
          const SizedBox(width: 8),
          Expanded(
              child: Text(message,
                  style:
                      const TextStyle(color: AppTheme.errorRed, fontSize: 13))),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final IconData icon;
  final String message;
  const _EmptyState({required this.icon, required this.message});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        children: [
          Icon(icon, size: 48, color: AppTheme.textSecondary),
          const SizedBox(height: 12),
          Text(message,
              style: const TextStyle(color: AppTheme.textSecondary),
              textAlign: TextAlign.center),
        ],
      ),
    );
  }
}
