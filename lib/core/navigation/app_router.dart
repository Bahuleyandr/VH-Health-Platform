import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

// Splash & Auth
import '../../features/splash/screens/splash_screen.dart';
import '../../features/auth/screens/login_screen.dart';

// Core screens (inside ShellRoute)
import '../../features/dashboard/screens/dashboard_screen.dart';
import '../../features/attendance/screens/attendance_screen.dart';
import '../../features/leave/screens/leave_screen.dart';
import '../../features/appointments/screens/appointments_screen.dart';
import '../../features/investigations/screens/investigations_screen.dart';
import '../../features/pharmacy/screens/pharmacy_screen.dart';
import '../../features/profile/screens/profile_screen.dart';
import '../../features/settings/screens/settings_screen.dart';

// Doctor
import '../../features/doctor/screens/patient_records_screen.dart';
import '../../features/doctor/screens/prescriptions_screen.dart';
import '../../features/doctor/screens/queue_screen.dart';

// Nursing
import '../../features/nursing/screens/vitals_screen.dart';
import '../../features/nursing/screens/nursing_notes_screen.dart';

// HR
import '../../features/hr/screens/hr_dashboard_screen.dart';
import '../../features/hr/screens/staff_management_screen.dart';
import '../../features/hr/screens/performance_screen.dart';

// Housekeeping
import '../../features/housekeeping/screens/tasks_screen.dart';

// Directory
import '../../features/directory/screens/staff_directory_screen.dart';

// Notifications
import '../../features/notifications/screens/notifications_screen.dart';

// Schedule
import '../../features/schedule/screens/schedule_screen.dart';

// Handover
import '../../features/nursing/screens/handover_screen.dart';

// About
import '../../features/about/screens/about_screen.dart';

// Shell
import '../widgets/main_scaffold.dart';

final _rootNavigatorKey = GlobalKey<NavigatorState>();
final _shellNavigatorKey = GlobalKey<NavigatorState>();

final GoRouter appRouter = GoRouter(
  navigatorKey: _rootNavigatorKey,
  initialLocation: '/',
  routes: [
    // ─── Splash (no bottom nav) ─────────────────────────────────────────
    GoRoute(
      path: '/',
      name: 'splash',
      parentNavigatorKey: _rootNavigatorKey,
      pageBuilder: (context, state) =>
          const NoTransitionPage(child: SplashScreen()),
    ),

    // ─── Login (no bottom nav) ──────────────────────────────────────────
    GoRoute(
      path: '/login',
      name: 'login',
      parentNavigatorKey: _rootNavigatorKey,
      pageBuilder: (context, state) =>
          const NoTransitionPage(child: LoginScreen()),
    ),

    // ─── Shell: persistent bottom navigation ────────────────────────────
    ShellRoute(
      navigatorKey: _shellNavigatorKey,
      builder: (context, state, child) => MainScaffold(child: child),
      routes: [
        // Core
        GoRoute(
          path: '/dashboard',
          name: 'dashboard',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: DashboardScreen()),
        ),
        GoRoute(
          path: '/attendance',
          name: 'attendance',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: AttendanceScreen()),
        ),
        GoRoute(
          path: '/leave',
          name: 'leave',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: LeaveScreen()),
        ),
        GoRoute(
          path: '/appointments',
          name: 'appointments',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: AppointmentsScreen()),
        ),
        GoRoute(
          path: '/investigations',
          name: 'investigations',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: InvestigationsScreen()),
        ),
        GoRoute(
          path: '/pharmacy',
          name: 'pharmacy',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: PharmacyScreen()),
        ),
        GoRoute(
          path: '/profile',
          name: 'profile',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: ProfileScreen()),
        ),
        GoRoute(
          path: '/settings',
          name: 'settings',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: SettingsScreen()),
        ),

        // Doctor
        GoRoute(
          path: '/patient-records',
          name: 'patient-records',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: PatientRecordsScreen()),
        ),
        GoRoute(
          path: '/prescriptions',
          name: 'prescriptions',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: PrescriptionsScreen()),
        ),
        GoRoute(
          path: '/queue',
          name: 'queue',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: QueueScreen()),
        ),

        // Nursing
        GoRoute(
          path: '/vitals',
          name: 'vitals',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: VitalsScreen()),
        ),
        GoRoute(
          path: '/nursing-notes',
          name: 'nursing-notes',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: NursingNotesScreen()),
        ),

        // HR
        GoRoute(
          path: '/hr-dashboard',
          name: 'hr-dashboard',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: HrDashboardScreen()),
        ),
        GoRoute(
          path: '/staff-management',
          name: 'staff-management',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: StaffManagementScreen()),
        ),
        GoRoute(
          path: '/performance',
          name: 'performance',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: PerformanceScreen()),
        ),

        // Housekeeping
        GoRoute(
          path: '/housekeeping-tasks',
          name: 'housekeeping-tasks',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: HousekeepingTasksScreen()),
        ),

        // Directory
        GoRoute(
          path: '/staff-directory',
          name: 'staff-directory',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: StaffDirectoryScreen()),
        ),

        // Schedule
        GoRoute(
          path: '/schedule',
          name: 'schedule',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: ScheduleScreen()),
        ),

        // Handover
        GoRoute(
          path: '/handover',
          name: 'handover',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: HandoverScreen()),
        ),

        // Notifications
        GoRoute(
          path: '/notifications',
          name: 'notifications',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: NotificationsScreen()),
        ),

        // About
        GoRoute(
          path: '/about',
          name: 'about',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: AboutScreen()),
        ),
      ],
    ),
  ],
  errorBuilder: (context, state) => Scaffold(
    body: Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.error_outline, size: 48, color: Colors.red),
          const SizedBox(height: 16),
          Text('Page not found: ${state.matchedLocation}'),
          TextButton(
            onPressed: () => context.go('/dashboard'),
            child: const Text('Go Home'),
          ),
        ],
      ),
    ),
  ),
);
