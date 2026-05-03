import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';
import '../../reports/screens/reports_hub_screen.dart';
import '../../payroll/screens/payslip_screen.dart';

/// HR Dashboard screen — staff overview and attendance analytics.
class HrDashboardScreen extends StatefulWidget {
  const HrDashboardScreen({super.key});

  @override
  State<HrDashboardScreen> createState() => _HrDashboardScreenState();
}

class _HrDashboardScreenState extends State<HrDashboardScreen> {
  Map<String, dynamic>? _data;
  bool _loading = true;
  String? _error;
  String _timeframe = 'current_month';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await HrApiService.getHRDashboard(timeframe: _timeframe);

      // Merge attendance analytics for richer data
      try {
        final analytics = await HrApiService.getAttendanceAnalytics();
        data['attendanceAnalytics'] = analytics;
      } catch (e) {
        debugPrint('hr_dashboard_screen.dart: $e');
      }

      if (mounted) setState(() => _data = data);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final timeframes = {
      'current_month': s.hrTimeframeThisMonth,
      'last_month': s.hrTimeframeLastMonth,
      'current_quarter': s.hrTimeframeThisQuarter,
      'current_year': s.hrTimeframeThisYear,
    };
    return StaffScaffold(
      title: s.hrDashboardTitle,
      actions: [
        PopupMenuButton<String>(
          icon: const Icon(Icons.tune, color: Colors.white),
          onSelected: (v) {
            setState(() => _timeframe = v);
            _load();
          },
          itemBuilder: (_) => timeframes.entries
              .map((e) => PopupMenuItem(value: e.key, child: Text(e.value)))
              .toList(),
        ),
      ],
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
            ? _ErrorState(error: _error!, onRetry: _load)
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  // Timeframe chip
                  Wrap(
                    children: [
                      Chip(
                        label: Text(timeframes[_timeframe] ?? _timeframe),
                        avatar: const Icon(Icons.date_range, size: 16),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),

                  // Summary stats grid
                  _buildStatsGrid(s),
                  const SizedBox(height: 20),

                  // Attendance overview
                  _SectionTitle(s.hrSectionAttendanceOverview),
                  const SizedBox(height: 10),
                  _buildAttendanceCard(s),
                  const SizedBox(height: 20),

                  // Leave summary
                  _SectionTitle(s.hrSectionLeaveSummary),
                  const SizedBox(height: 10),
                  _buildLeaveCard(s),
                  const SizedBox(height: 20),

                  // Quick actions
                  _SectionTitle(s.hrSectionQuickActions),
                  const SizedBox(height: 10),
                  _buildQuickActions(context, s),
                ],
              ),
      ),
    );
  }

  Widget _buildStatsGrid(AppStrings s) {
    final totalStaff =
        _data?['totalStaff'] ??
        _data?['summary']?['totalStaff'] ??
        _data?['staffCount'] ??
        '—';
    final presentToday =
        _data?['presentToday'] ??
        _data?['summary']?['presentToday'] ??
        _data?['attendance']?['presentToday'] ??
        '—';
    final onLeave =
        _data?['onLeave'] ??
        _data?['summary']?['onLeave'] ??
        _data?['leaves']?['currentlyOnLeave'] ??
        '—';
    final pendingLeave =
        _data?['pendingLeave'] ??
        _data?['summary']?['pendingLeaveRequests'] ??
        _data?['leaves']?['pending'] ??
        '—';

    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 12,
      crossAxisSpacing: 12,
      childAspectRatio: 1.6,
      children: [
        _StatTile(
          label: s.hrStatTotalStaff,
          value: totalStaff.toString(),
          icon: Icons.people,
          color: AppTheme.primaryBlue,
        ),
        _StatTile(
          label: s.hrStatPresentToday,
          value: presentToday.toString(),
          icon: Icons.check_circle,
          color: AppTheme.successGreen,
        ),
        _StatTile(
          label: s.hrStatOnLeave,
          value: onLeave.toString(),
          icon: Icons.beach_access,
          color: AppTheme.warningAmber,
        ),
        _StatTile(
          label: s.hrStatPendingLeaves,
          value: pendingLeave.toString(),
          icon: Icons.pending_actions,
          color: AppTheme.errorRed,
        ),
      ],
    );
  }

  Widget _buildAttendanceCard(AppStrings s) {
    final attendance = _data?['attendance'] as Map<String, dynamic>? ?? {};
    final avgRate =
        attendance['averageAttendanceRate'] ?? attendance['rate'] ?? '—';
    final lateArrivals = attendance['lateArrivals'] ?? '—';
    final absentees = attendance['absentees'] ?? '—';

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            _DataRow(s.hrAvgAttendanceRate, '$avgRate%'),
            const Divider(),
            _DataRow(s.hrLateArrivals, '$lateArrivals'),
            const Divider(),
            _DataRow(s.hrAbsentees, '$absentees'),
          ],
        ),
      ),
    );
  }

  Widget _buildLeaveCard(AppStrings s) {
    final leaves = _data?['leaves'] as Map<String, dynamic>? ?? {};
    final total = leaves['total'] ?? leaves['totalApplied'] ?? '—';
    final approved = leaves['approved'] ?? '—';
    final rejected = leaves['rejected'] ?? '—';
    final pending = leaves['pending'] ?? leaves['pendingApproval'] ?? '—';

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            _DataRow(s.hrTotalApplications, '$total'),
            const Divider(),
            _DataRow(s.hrApproved, '$approved'),
            const Divider(),
            _DataRow(s.hrRejected, '$rejected'),
            const Divider(),
            _DataRow(s.hrPendingApproval, '$pending'),
          ],
        ),
      ),
    );
  }

  Widget _buildQuickActions(BuildContext context, AppStrings s) {
    return Column(
      children: [
        _ActionTile(
          icon: Icons.manage_accounts,
          title: s.hrActionStaffManagement,
          subtitle: s.hrActionStaffManagementSubtitle,
          color: AppTheme.primaryBlue,
          onTap: () => context.go('/staff-management'),
        ),
        const SizedBox(height: 10),
        _ActionTile(
          icon: Icons.star_rate,
          title: s.hrActionPerformance,
          subtitle: s.hrActionPerformanceSubtitle,
          color: const Color(0xFFF57F17),
          onTap: () => context.go('/performance'),
        ),
        const SizedBox(height: 10),
        _ActionTile(
          icon: Icons.people,
          title: s.hrActionStaffDirectory,
          subtitle: s.hrActionStaffDirectorySubtitle,
          color: const Color(0xFF455A64),
          onTap: () => context.go('/staff-directory'),
        ),
        const SizedBox(height: 10),
        _ActionTile(
          icon: Icons.warning_amber_rounded,
          title: s.hrActionReports,
          subtitle: s.hrActionReportsSubtitle,
          color: Colors.orange,
          onTap: () => Navigator.push(
            context,
            MaterialPageRoute(builder: (_) => const ReportsHubScreen()),
          ),
        ),
        const SizedBox(height: 10),
        _ActionTile(
          icon: Icons.receipt_long_outlined,
          title: s.hrActionPayslips,
          subtitle: s.hrActionPayslipsSubtitle,
          color: const Color(0xFF007A64),
          onTap: () => Navigator.push(
            context,
            MaterialPageRoute(builder: (_) => const PayslipScreen()),
          ),
        ),
      ],
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final String title;
  const _SectionTitle(this.title);

  @override
  Widget build(BuildContext context) {
    return Text(
      title,
      style: TextStyle(
        fontSize: 15,
        fontWeight: FontWeight.bold,
        color: AppTheme.textPrimary,
      ),
    );
  }
}

class _StatTile extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;
  final Color color;

  const _StatTile({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.05),
            blurRadius: 6,
            offset: Offset(0, 2),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, color: color, size: 22),
          const SizedBox(height: 6),
          Text(
            value,
            style: TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.bold,
              color: color,
            ),
          ),
          Text(
            label,
            style: TextStyle(fontSize: 11, color: AppTheme.textSecondary),
          ),
        ],
      ),
    );
  }
}

class _DataRow extends StatelessWidget {
  final String label;
  final String value;
  const _DataRow(this.label, this.value);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            label,
            style: TextStyle(color: AppTheme.textSecondary, fontSize: 13),
          ),
          Text(
            value,
            style: TextStyle(
              fontWeight: FontWeight.bold,
              color: AppTheme.textPrimary,
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final Color color;
  final VoidCallback onTap;

  const _ActionTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.05),
              blurRadius: 6,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, color: color, size: 22),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  Text(
                    subtitle,
                    style: TextStyle(
                      fontSize: 12,
                      color: AppTheme.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right, color: AppTheme.textSecondary),
          ],
        ),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String error;
  final VoidCallback onRetry;
  const _ErrorState({required this.error, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.error_outline, color: AppTheme.errorRed, size: 40),
          const SizedBox(height: 8),
          Text(
            error,
            style: TextStyle(color: AppTheme.textSecondary),
            textAlign: TextAlign.center,
          ),
          TextButton(
            onPressed: onRetry,
            child: Text(AppStrings.of(context).actionRetry),
          ),
        ],
      ),
    );
  }
}
