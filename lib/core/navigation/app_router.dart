import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../features/auth/screens/login_screen.dart';
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
import '../config/api_config.dart';

final GoRouter appRouter = GoRouter(
  initialLocation: '/login',
  redirect: (context, state) async {
    final loggedIn = await ApiConfig.isLoggedIn();
    final onLogin = state.matchedLocation == '/login';
    if (!loggedIn && !onLogin) return '/login';
    if (loggedIn && onLogin) return '/dashboard';
    return null;
  },
  routes: [
    // ─── Auth ────────────────────────────────────────────────────────────────
    GoRoute(
      path: '/login',
      name: 'login',
      pageBuilder: (context, state) =>
          const NoTransitionPage(child: LoginScreen()),
    ),

    // ─── Core ─────────────────────────────────────────────────────────────────
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

    // ─── Doctor ───────────────────────────────────────────────────────────────
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

    // ─── Nursing ──────────────────────────────────────────────────────────────
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

    // ─── HR ───────────────────────────────────────────────────────────────────
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

    // ─── Housekeeping ─────────────────────────────────────────────────────────
    GoRoute(
      path: '/housekeeping-tasks',
      name: 'housekeeping-tasks',
      pageBuilder: (context, state) =>
          const NoTransitionPage(child: HousekeepingTasksScreen()),
    ),

    // ─── Directory ────────────────────────────────────────────────────────────
    GoRoute(
      path: '/staff-directory',
      name: 'staff-directory',
      pageBuilder: (context, state) =>
          const NoTransitionPage(child: StaffDirectoryScreen()),
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
