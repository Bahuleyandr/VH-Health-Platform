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

  Map<String, dynamic> _asMap(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    return {};
  }

  Map<String, dynamic> get _dashboard {
    final raw = _asMap(_data);
    final nested = _asMap(raw['data']);
    return nested.isNotEmpty ? nested : raw;
  }

  String _metric(dynamic value) {
    if (value == null) return '—';
    if (value is num) {
      if (value.isNaN) return '—';
      return value % 1 == 0 ? value.toInt().toString() : value.toString();
    }
    final text = value.toString().trim();
    return text.isEmpty ? '—' : text;
  }

  num? _asNum(dynamic value) {
    if (value is num && !value.isNaN) return value;
    return num.tryParse(value?.toString() ?? '');
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
    final dashboard = _dashboard;
    final overview = _asMap(dashboard['overview']);
    final leaves = _asMap(dashboard['leaves']);
    final totalStaff =
        overview['total_staff'] ??
        overview['totalStaff'] ??
        dashboard['totalStaff'] ??
        _asMap(dashboard['summary'])['totalStaff'] ??
        dashboard['staffCount'];
    final presentToday =
        overview['currently_checked_in'] ??
        overview['currentlyCheckedIn'] ??
        dashboard['presentToday'] ??
        _asMap(dashboard['summary'])['presentToday'] ??
        _asMap(dashboard['attendance'])['presentToday'];
    final onLeave =
        leaves['currently_on_leave'] ??
        leaves['currentlyOnLeave'] ??
        dashboard['onLeave'] ??
        _asMap(dashboard['summary'])['onLeave'];
    final pendingLeave =
        leaves['pending'] ??
        leaves['pendingApproval'] ??
        dashboard['pendingLeave'] ??
        _asMap(dashboard['summary'])['pendingLeaveRequests'];

    final tiles = [
      _StatTile(
        label: s.hrStatTotalStaff,
        value: _metric(totalStaff),
        icon: Icons.people,
        color: AppTheme.primaryBlue,
      ),
      _StatTile(
        label: s.hrStatPresentToday,
        value: _metric(presentToday),
        icon: Icons.check_circle,
        color: AppTheme.successOnSurface,
      ),
      _StatTile(
        label: s.hrStatOnLeave,
        value: _metric(onLeave),
        icon: Icons.beach_access,
        color: AppTheme.warningOnSurface,
      ),
      _StatTile(
        label: s.hrStatPendingLeaves,
        value: _metric(pendingLeave),
        icon: Icons.pending_actions,
        color: AppTheme.errorOnSurface,
      ),
    ];

    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth >= 720) {
          return Row(
            children: [
              for (var i = 0; i < tiles.length; i++) ...[
                Expanded(child: tiles[i]),
                if (i != tiles.length - 1) const SizedBox(width: 12),
              ],
            ],
          );
        }

        return SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (var i = 0; i < tiles.length; i++) ...[
                SizedBox(width: 180, child: tiles[i]),
                if (i != tiles.length - 1) const SizedBox(width: 10),
              ],
            ],
          ),
        );
      },
    );
  }

  Widget _buildAttendanceCard(AppStrings s) {
    final dashboard = _dashboard;
    final attendance = _asMap(dashboard['attendance']);
    final overview = _asMap(dashboard['overview']);
    final leaves = _asMap(dashboard['leaves']);
    final analytics = _asMap(dashboard['attendanceAnalytics']);
    final analyticsSummary = _asMap(analytics['summary']);
    final avgRate =
        attendance['averageAttendanceRate'] ??
        attendance['rate'] ??
        overview['attendance_rate'];
    final lateArrivals =
        attendance['lateArrivals'] ?? analyticsSummary['late_arrivals'];
    final activeStaff = _asNum(overview['active_staff']) ?? 0;
    final checkedIn = _asNum(overview['currently_checked_in']) ?? 0;
    final onLeave = _asNum(leaves['currently_on_leave']) ?? 0;
    final inferredAbsentees = (activeStaff - checkedIn - onLeave).clamp(
      0,
      activeStaff,
    );
    final absentees = attendance['absentees'] ?? inferredAbsentees;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            _DataRow(
              s.hrAvgAttendanceRate,
              avgRate == null ? '—' : '${_metric(avgRate)}%',
            ),
            const Divider(),
            _DataRow(s.hrLateArrivals, _metric(lateArrivals)),
            const Divider(),
            _DataRow(s.hrAbsentees, _metric(absentees)),
          ],
        ),
      ),
    );
  }

  Widget _buildLeaveCard(AppStrings s) {
    final leaves = _asMap(_dashboard['leaves']);
    final total = leaves['total'] ?? leaves['totalApplied'] ?? '—';
    final approved = leaves['approved'] ?? '—';
    final rejected = leaves['rejected'] ?? '—';
    final pending = leaves['pending'] ?? leaves['pendingApproval'] ?? '—';

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            _DataRow(s.hrTotalApplications, _metric(total)),
            const Divider(),
            _DataRow(s.hrApproved, _metric(approved)),
            const Divider(),
            _DataRow(s.hrRejected, _metric(rejected)),
            const Divider(),
            _DataRow(s.hrPendingApproval, _metric(pending)),
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
          subtitle: 'Onboard staff, assign roles, and manage department files',
          color: AppTheme.primaryBlue,
          onTap: () => context.go('/staff-management'),
        ),
        const SizedBox(height: 10),
        _ActionTile(
          icon: Icons.calendar_month_outlined,
          title: 'Staff roster',
          subtitle:
              'Open doctor, nursing, OP, reception, driver, maintenance, pharmacy, or housekeeping boards',
          color: const Color(0xFF1565C0),
          onTap: () => context.go('/staff-rosters'),
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
          icon: Icons.fact_check_outlined,
          title: 'Leave approvals',
          subtitle: 'Review pending leave requests and record HR decisions',
          color: AppTheme.successGreen,
          onTap: () => context.go('/leave-approvals'),
        ),
        const SizedBox(height: 10),
        _ActionTile(
          icon: Icons.schedule_outlined,
          title: 'My roster',
          subtitle: 'View duty roster, leave, attendance, and duty requests',
          color: AppTheme.accentCyan,
          onTap: () => context.go('/schedule'),
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
    final isDark = AppTheme.brightness == Brightness.dark;
    final iconBg = color.withValues(alpha: isDark ? 0.18 : 0.10);
    return Container(
      height: 96,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppTheme.divider),
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
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: iconBg,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: color, size: 22),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.w800,
                    color: AppTheme.textPrimary,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  label,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
                ),
              ],
            ),
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
      padding: const EdgeInsets.symmetric(vertical: 4),
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
          color: AppTheme.cardSurface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppTheme.divider),
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
                color: color.withValues(
                  alpha: AppTheme.brightness == Brightness.dark ? 0.18 : 0.1,
                ),
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
