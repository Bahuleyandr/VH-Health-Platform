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
    GoRoute(
      path: '/login',
      name: 'login',
      pageBuilder: (context, state) =>
          const NoTransitionPage(child: LoginScreen()),
    ),
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
