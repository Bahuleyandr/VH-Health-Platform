import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/services/attendance_api_service.dart';
import '../../../core/services/hr_api_service.dart';
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
  String? _phone;
  StaffRole _role = StaffRole.general;
  bool _loading = true;

  // Stats
  int _appointmentCount = 0;
  List<Map<String, dynamic>> _upcomingAppointments = [];
  List<dynamic> _recentNotifications = [];

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() => _loading = true);
    try {
      _staffId = await ApiConfig.getStaffId();
      _phone = await ApiConfig.getPhone();
      final roleStr = await AuthService.getRole();
      _role = StaffRole.fromString(roleStr);

      // Load all in parallel
      final futures = <Future>[];

      // Fetch campus geofence config (no-op after first success)
      futures.add(ScheduleApiService.fetchCampusConfig());

      futures.add(AttendanceApiService.getAttendanceStatus().then(
        (s) => _attendanceStatus = s,
        onError: (_) {},
      ));

      // Appointments for clinical roles
      if (_role == StaffRole.doctor ||
          _role == StaffRole.nurse ||
          _role.isAdminTier) {
        final today = DateFormat('yyyy-MM-dd').format(DateTime.now());
        futures.add(
          ScheduleApiService.getAppointments(
            staffId: _staffId,
            date: today,
            status: 'scheduled',
            limit: 5,
          ).then((data) {
            final list = data['appointments'] as List? ?? [];
            _appointmentCount = data['total'] ?? list.length;
            _upcomingAppointments = list
                .take(5)
                .map((a) => a is Map<String, dynamic>
                    ? a
                    : <String, dynamic>{})
                .toList();
          }, onError: (_) {}),
        );
      }

      // Notifications
      if (_phone != null) {
        futures.add(
          HrApiService.getNotifications(_phone!).then(
            (n) => _recentNotifications = n.take(5).toList(),
            onError: (_) {},
          ),
        );
      }

      await Future.wait(futures);
    } catch (e) {
      // Non-blocking
      try {
        final roleStr = await AuthService.getRole();
        if (mounted) _role = StaffRole.fromString(roleStr);
      } catch (e) { debugPrint('dashboard_screen.dart: $e'); }
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
    final features = RoleFeatures.getFeaturesForRole(_role);

    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      body: RefreshIndicator(
        onRefresh: _loadData,
        child: CustomScrollView(
          slivers: [
            // App bar
            SliverAppBar(
              expandedHeight: 180,
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
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          Text(
                            today,
                            style: const TextStyle(
                                color: Colors.white60, fontSize: 12),
                          ),
                          const SizedBox(width: 8),
                          Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 10, vertical: 3),
                            decoration: BoxDecoration(
                              color: Colors.white.withValues(alpha: 0.2),
                              borderRadius: BorderRadius.circular(20),
                              border: Border.all(
                                  color: Colors.white.withValues(alpha: 0.4)),
                            ),
                            child: Text(
                              _role.displayName,
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),

            SliverToBoxAdapter(
              child: _loading
                  ? const Padding(
                      padding: EdgeInsets.symmetric(vertical: 48),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  : Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          // Attendance status card
                          _AttendanceStatusCard(
                            isCheckedIn: checkedIn,
                            checkInTime:
                                _attendanceStatus?['checkInTime'],
                            onTap: () => context.go('/attendance'),
                          ),
                          const SizedBox(height: 16),

                          // Quick stats row
                          _buildQuickStats(),
                          const SizedBox(height: 16),

                          // Quick actions
                          const Text(
                            'Quick Actions',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.bold,
                              color: AppTheme.textPrimary,
                            ),
                          ),
                          const SizedBox(height: 10),
                          _buildQuickActions(),
                          const SizedBox(height: 16),

                          // Upcoming appointments (clinical roles)
                          if (_upcomingAppointments.isNotEmpty) ...[
                            _buildSectionHeader(
                                'Upcoming Appointments', '/appointments'),
                            const SizedBox(height: 8),
                            ..._upcomingAppointments
                                .map(_buildAppointmentCard),
                            const SizedBox(height: 16),
                          ],

                          // Recent activity
                          if (_recentNotifications.isNotEmpty) ...[
                            _buildSectionHeader(
                                'Recent Activity', '/notifications'),
                            const SizedBox(height: 8),
                            ..._recentNotifications
                                .map(_buildActivityItem),
                            const SizedBox(height: 16),
                          ],

                          // Feature grid
                          const Text(
                            'All Features',
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
                            physics:
                                const NeverScrollableScrollPhysics(),
                            mainAxisSpacing: 12,
                            crossAxisSpacing: 12,
                            childAspectRatio: 1.0,
                            children: features.map((f) {
                              return _FeatureButton(
                                icon: f.icon,
                                label: f.title,
                                color: f.color,
                                route: f.route,
                              );
                            }).toList(),
                          ),
                          const SizedBox(height: 24),
                        ],
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildQuickStats() {
    final stats = <_StatItem>[];

    if (_role == StaffRole.doctor ||
        _role == StaffRole.nurse ||
        _role.isAdminTier) {
      stats.add(_StatItem(
        icon: Icons.calendar_today,
        label: 'Appointments',
        value: '$_appointmentCount',
        color: const Color(0xFF6A1B9A),
      ));
    }

    stats.add(_StatItem(
      icon: Icons.notifications_active,
      label: 'Notifications',
      value: '${_recentNotifications.length}',
      color: const Color(0xFFE65100),
    ));

    if (stats.isEmpty) return const SizedBox.shrink();

    return Row(
      children: stats.map((s) {
        return Expanded(
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                children: [
                  Icon(s.icon, color: s.color, size: 24),
                  const SizedBox(height: 6),
                  Text(
                    s.value,
                    style: TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.bold,
                      color: s.color,
                    ),
                  ),
                  Text(
                    s.label,
                    style: const TextStyle(
                      fontSize: 11,
                      color: Colors.grey,
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      }).toList(),
    );
  }

  Widget _buildQuickActions() {
    final actions = <_QuickAction>[];

    // Everyone gets attendance
    actions.add(_QuickAction(
      icon: Icons.fingerprint,
      label: 'Check In/Out',
      route: '/attendance',
      color: const Color(0xFF1565C0),
    ));

    // Schedule for all
    actions.add(_QuickAction(
      icon: Icons.schedule,
      label: 'Shift Schedule',
      route: '/schedule',
      color: const Color(0xFF00838F),
    ));

    // Messages for all
    actions.add(_QuickAction(
      icon: Icons.chat_outlined,
      label: 'Messages',
      route: '/messaging',
      color: const Color(0xFF1565C0),
    ));

    // Role-specific
    if (_role == StaffRole.doctor) {
      actions.add(_QuickAction(
        icon: Icons.medication_liquid,
        label: 'Prescriptions',
        route: '/prescriptions',
        color: const Color(0xFF00838F),
      ));
      actions.add(_QuickAction(
        icon: Icons.biotech,
        label: 'Investigations',
        route: '/investigations',
        color: const Color(0xFF0097A7),
      ));
    } else if (_role == StaffRole.nurse) {
      actions.add(_QuickAction(
        icon: Icons.monitor_heart,
        label: 'Vitals',
        route: '/vitals',
        color: const Color(0xFFC62828),
      ));
      actions.add(_QuickAction(
        icon: Icons.swap_horiz,
        label: 'Handover',
        route: '/handover',
        color: const Color(0xFF00695C),
      ));
    } else if (_role == StaffRole.pharmacy) {
      actions.add(_QuickAction(
        icon: Icons.medication,
        label: 'Pharmacy',
        route: '/pharmacy',
        color: const Color(0xFFE65100),
      ));
    } else if (_role == StaffRole.lab) {
      actions.add(_QuickAction(
        icon: Icons.upload_file,
        label: 'Upload Results',
        route: '/investigations',
        color: const Color(0xFF0097A7),
      ));
    }

    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: actions.map((a) {
        return ActionChip(
          avatar: Icon(a.icon, size: 18, color: a.color),
          label: Text(a.label),
          onPressed: () => context.go(a.route),
          backgroundColor: a.color.withValues(alpha: 0.08),
          side: BorderSide(color: a.color.withValues(alpha: 0.2)),
        );
      }).toList(),
    );
  }

  Widget _buildSectionHeader(String title, String route) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          title,
          style: const TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.bold,
            color: AppTheme.textPrimary,
          ),
        ),
        TextButton(
          onPressed: () => context.go(route),
          child: const Text('See all'),
        ),
      ],
    );
  }

  Widget _buildAppointmentCard(Map<String, dynamic> apt) {
    final patientName = apt['patientName'] ?? apt['patient']?['name'] ?? 'Patient';
    final time = apt['time'] ?? apt['scheduledTime'] ?? '';
    final type = apt['type'] ?? apt['appointmentType'] ?? '';
    String timeStr = '';
    if (time is String && time.isNotEmpty) {
      try {
        timeStr = DateFormat('HH:mm').format(DateTime.parse(time));
      } catch (e) {
        timeStr = time;
      }
    }

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        leading: const CircleAvatar(
          backgroundColor: Color(0xFFE8EAF6),
          child: Icon(Icons.person, color: Color(0xFF3949AB)),
        ),
        title: Text(
          patientName.toString(),
          style: const TextStyle(fontWeight: FontWeight.w600),
        ),
        subtitle: Text(
          [if (timeStr.isNotEmpty) timeStr, if (type.toString().isNotEmpty) type]
              .join(' • '),
        ),
        trailing: const Icon(Icons.chevron_right, color: Colors.grey),
        onTap: () => context.go('/appointments'),
      ),
    );
  }

  Widget _buildActivityItem(dynamic notification) {
    final n = notification is Map<String, dynamic>
        ? notification
        : <String, dynamic>{};
    final title = n['title'] ?? 'Notification';
    final body = n['body'] ?? n['message'] ?? '';
    final ts = n['createdAt'] ?? n['timestamp'] ?? '';
    String timeStr = '';
    if (ts.toString().isNotEmpty) {
      try {
        final dt = DateTime.parse(ts.toString());
        final diff = DateTime.now().difference(dt);
        if (diff.inMinutes < 60) {
          timeStr = '${diff.inMinutes}m ago';
        } else if (diff.inHours < 24) {
          timeStr = '${diff.inHours}h ago';
        } else {
          timeStr = DateFormat('d MMM').format(dt);
        }
      } catch (e) { debugPrint('dashboard_screen.dart: $e'); }
    }

    return Card(
      margin: const EdgeInsets.only(bottom: 6),
      child: ListTile(
        dense: true,
        leading: const Icon(Icons.circle, size: 8, color: AppTheme.primaryBlue),
        title: Text(
          title.toString(),
          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
        ),
        subtitle: body.toString().isNotEmpty
            ? Text(
                body.toString(),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12),
              )
            : null,
        trailing: timeStr.isNotEmpty
            ? Text(
                timeStr,
                style: const TextStyle(fontSize: 11, color: Colors.grey),
              )
            : null,
      ),
    );
  }
}

class _StatItem {
  final IconData icon;
  final String label;
  final String value;
  final Color color;
  const _StatItem({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });
}

class _QuickAction {
  final IconData icon;
  final String label;
  final String route;
  final Color color;
  const _QuickAction({
    required this.icon,
    required this.label,
    required this.route,
    required this.color,
  });
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
              color: (isCheckedIn
                      ? AppTheme.successGreen
                      : AppTheme.warningAmber)
                  .withValues(alpha: 0.3),
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
                color: Colors.white.withValues(alpha: 0.2),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(
                isCheckedIn
                    ? Icons.check_circle
                    : Icons.radio_button_unchecked,
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
                      style:
                          TextStyle(color: Colors.white70, fontSize: 13),
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
                color: Colors.black.withValues(alpha: 0.06),
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
                color: color.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, color: color, size: 26),
            ),
            const SizedBox(height: 6),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Text(
                label,
                textAlign: TextAlign.center,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w600,
                  color: color,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
