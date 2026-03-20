import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../../core/config/api_config.dart';
import '../../../core/services/staff_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/sos_button.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  Map<String, dynamic>? _attendanceStatus;
  String? _staffId;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() => _loading = true);
    try {
      _staffId = await ApiConfig.getStaffId();
      final status = await StaffApiService.getAttendanceStatus();
      if (mounted) setState(() => _attendanceStatus = status);
    } catch (_) {
      // Non-blocking
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String get _greeting {
    final hour = DateTime.now().hour;
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }

  @override
  Widget build(BuildContext context) {
    final today = DateFormat('EEEE, d MMMM yyyy').format(DateTime.now());
    final checkedIn =
        _attendanceStatus?['isCheckedIn'] == true ||
        _attendanceStatus?['status'] == 'checked-in';

    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      body: RefreshIndicator(
        onRefresh: _loadData,
        child: CustomScrollView(
          slivers: [
            // App bar
            SliverAppBar(
              expandedHeight: 160,
              pinned: true,
              backgroundColor: AppTheme.primaryBlue,
              foregroundColor: Colors.white,
              actions: const [SosButton()],
              flexibleSpace: FlexibleSpaceBar(
                background: Container(
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [AppTheme.primaryBlue, AppTheme.accentCyan],
                    ),
                  ),
                  padding: const EdgeInsets.fromLTRB(20, 80, 20, 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      Text(
                        _greeting,
                        style: const TextStyle(
                            color: Colors.white70, fontSize: 14),
                      ),
                      const SizedBox(height: 2),
                      const Text(
                        'Welcome back 👋',
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 22,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        today,
                        style: const TextStyle(
                            color: Colors.white60, fontSize: 12),
                      ),
                    ],
                  ),
                ),
              ),
            ),

            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Attendance status card
                    _AttendanceStatusCard(
                      isCheckedIn: checkedIn,
                      checkInTime: _attendanceStatus?['checkInTime'],
                      onTap: () => context.go('/attendance'),
                    ),
                    const SizedBox(height: 16),

                    // Quick stats
                    const Text(
                      'Quick Overview',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: AppTheme.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: _StatCard(
                            icon: Icons.event_available,
                            label: 'Appointments',
                            value: '—',
                            color: AppTheme.primaryBlue,
                            onTap: () => context.go('/appointments'),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: _StatCard(
                            icon: Icons.medical_services,
                            label: 'Pharmacy Orders',
                            value: '—',
                            color: AppTheme.primaryTeal,
                            onTap: () => context.go('/pharmacy'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),

                    // Feature grid
                    const Text(
                      'Features',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: AppTheme.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 10),
                    GridView.count(
                      crossAxisCount: 3,
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      mainAxisSpacing: 12,
                      crossAxisSpacing: 12,
                      childAspectRatio: 1.0,
                      children: [
                        _FeatureButton(
                          icon: Icons.fingerprint,
                          label: 'Attendance',
                          color: const Color(0xFF1565C0),
                          route: '/attendance',
                        ),
                        _FeatureButton(
                          icon: Icons.event_available,
                          label: 'Leave',
                          color: const Color(0xFF00796B),
                          route: '/leave',
                        ),
                        _FeatureButton(
                          icon: Icons.calendar_month,
                          label: 'Appointments',
                          color: const Color(0xFF6A1B9A),
                          route: '/appointments',
                        ),
                        _FeatureButton(
                          icon: Icons.biotech,
                          label: 'Investigations',
                          color: const Color(0xFF0097A7),
                          route: '/investigations',
                        ),
                        _FeatureButton(
                          icon: Icons.medication,
                          label: 'Pharmacy',
                          color: const Color(0xFFE65100),
                          route: '/pharmacy',
                        ),
                        _FeatureButton(
                          icon: Icons.person,
                          label: 'Profile',
                          color: const Color(0xFF37474F),
                          route: '/profile',
                        ),
                      ],
                    ),
                    const SizedBox(height: 24),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: _buildBottomNav(context),
    );
  }

  Widget _buildBottomNav(BuildContext context) {
    return BottomNavigationBar(
      currentIndex: 0,
      onTap: (i) {
        const routes = [
          '/dashboard',
          '/attendance',
          '/leave',
          '/profile',
          '/settings'
        ];
        if (i < routes.length) context.go(routes[i]);
      },
      items: const [
        BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
            label: 'Home'),
        BottomNavigationBarItem(
            icon: Icon(Icons.fingerprint_outlined),
            activeIcon: Icon(Icons.fingerprint),
            label: 'Attendance'),
        BottomNavigationBarItem(
            icon: Icon(Icons.event_available_outlined),
            activeIcon: Icon(Icons.event_available),
            label: 'Leave'),
        BottomNavigationBarItem(
            icon: Icon(Icons.person_outlined),
            activeIcon: Icon(Icons.person),
            label: 'Profile'),
        BottomNavigationBarItem(
            icon: Icon(Icons.settings_outlined),
            activeIcon: Icon(Icons.settings),
            label: 'Settings'),
      ],
    );
  }
}

class _AttendanceStatusCard extends StatelessWidget {
  final bool isCheckedIn;
  final String? checkInTime;
  final VoidCallback onTap;

  const _AttendanceStatusCard({
    required this.isCheckedIn,
    this.checkInTime,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: isCheckedIn
                ? [AppTheme.successGreen, const Color(0xFF43A047)]
                : [AppTheme.warningAmber, const Color(0xFFFFA000)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(
              color: (isCheckedIn ? AppTheme.successGreen : AppTheme.warningAmber)
                  .withOpacity(0.3),
              blurRadius: 12,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.white.withOpacity(0.2),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(
                isCheckedIn ? Icons.check_circle : Icons.radio_button_unchecked,
                color: Colors.white,
                size: 28,
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    isCheckedIn ? 'Checked In' : 'Not Checked In',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  if (checkInTime != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      'Since $checkInTime',
                      style: const TextStyle(
                          color: Colors.white70, fontSize: 13),
                    ),
                  ] else
                    const Text(
                      'Tap to manage attendance',
                      style: TextStyle(color: Colors.white70, fontSize: 13),
                    ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: Colors.white),
          ],
        ),
      ),
    );
  }
}

class _StatCard extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color color;
  final VoidCallback onTap;

  const _StatCard({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
          boxShadow: [
            BoxShadow(
                color: Colors.black.withOpacity(0.05),
                blurRadius: 8,
                offset: const Offset(0, 2))
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: color, size: 24),
            const SizedBox(height: 8),
            Text(value,
                style: TextStyle(
                    fontSize: 22, fontWeight: FontWeight.bold, color: color)),
            Text(label,
                style: const TextStyle(
                    fontSize: 12, color: AppTheme.textSecondary)),
          ],
        ),
      ),
    );
  }
}

class _FeatureButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final String route;

  const _FeatureButton({
    required this.icon,
    required this.label,
    required this.color,
    required this.route,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => context.go(route),
      child: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(14),
          boxShadow: [
            BoxShadow(
                color: Colors.black.withOpacity(0.06),
                blurRadius: 8,
                offset: const Offset(0, 2))
          ],
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: color.withOpacity(0.1),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, color: color, size: 26),
            ),
            const SizedBox(height: 6),
            Text(
              label,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w600,
                color: color,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
