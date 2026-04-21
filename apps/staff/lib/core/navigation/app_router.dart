import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_staff/core/config/api_config.dart';
import 'package:vhhealth_staff/core/providers/session_timeout_provider.dart';

// Splash & Auth
import '../../features/splash/screens/splash_screen.dart';
import '../../features/auth/screens/login_screen.dart';

// Core screens (inside ShellRoute)
import '../../features/dashboard/screens/dashboard_screen.dart';
import '../../features/attendance/screens/attendance_screen.dart';
import '../../features/leave/screens/leave_screen.dart';
import '../../features/appointments/screens/appointments_screen.dart';
import '../../features/appointments/screens/appointment_queue_screen.dart';
import '../../features/investigations/screens/investigations_screen.dart';
import '../../features/investigations/screens/lab_bookings_screen.dart';
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
import '../../features/nursing/screens/due_meds_screen.dart';
import '../../features/nursing/screens/mar_scan_screen.dart';

// HR
import '../../features/hr/screens/hr_dashboard_screen.dart';
import '../../features/hr/screens/staff_management_screen.dart';
import '../../features/hr/screens/performance_screen.dart';

// Housekeeping
import '../../features/housekeeping/screens/tasks_screen.dart';
import '../../features/housekeeping/screens/housekeeping_hub_screen.dart';

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

// Beds
import '../../features/beds/screens/bed_board_screen.dart';

// Blood Bank
import '../../features/bloodbank/screens/blood_bank_screen.dart';

// Dietary
import '../../features/dietary/screens/dietary_screen.dart';

// Theatre
import '../../features/theatre/screens/theatre_screen.dart';

// Radiology
import '../../features/radiology/screens/radiology_screen.dart';

// EMR
import '../../features/emr/screens/admission_screen.dart';
import '../../features/emr/screens/clinical_notes_screen.dart';
import '../../features/emr/screens/patient_timeline_screen.dart';
import '../../features/emr/screens/orders_screen.dart';
import '../../features/emr/screens/vitals_chart_screen.dart';
import '../../features/emr/screens/discharge_summary_screen.dart';

// Messaging
import '../../features/messaging/screens/messaging_inbox_screen.dart';
import '../../features/messaging/screens/messaging_thread_screen.dart';

// Shell
import '../widgets/main_scaffold.dart';

final _rootNavigatorKey = GlobalKey<NavigatorState>();
final _shellNavigatorKey = GlobalKey<NavigatorState>();

final GoRouter appRouter = GoRouter(
  navigatorKey: _rootNavigatorKey,
  initialLocation: '/',
  redirect: (BuildContext context, GoRouterState state) async {
    final isLoggedIn = await ApiConfig.isLoggedIn();
    if (!context.mounted) return null;

    final isOnLogin = state.matchedLocation == '/login';
    final isOnSplash = state.matchedLocation == '/';

    // Allow splash screen always
    if (isOnSplash) return null;

    // Session idle timeout — force logout if expired
    try {
      final sessionProvider = Provider.of<SessionTimeoutProvider>(
        context,
        listen: false,
      );
      if (sessionProvider.isSessionExpired && !isOnLogin) {
        return '/login';
      }
    } catch (_) {
      // Provider may not be available during initial build
    }

    // Not logged in and not on login page -> redirect to login
    if (!isLoggedIn && !isOnLogin) return '/login';

    // Logged in and on login page -> redirect to dashboard
    if (isLoggedIn && isOnLogin) {
      // Start idle timer now that we know the user is authenticated
      try {
        Provider.of<SessionTimeoutProvider>(context, listen: false)
            .startTracking();
      } catch (_) {}
      return '/dashboard';
    }

    // User is logged in and on a protected page — ensure timer is running
    if (isLoggedIn && !isOnLogin) {
      try {
        final sp = Provider.of<SessionTimeoutProvider>(context, listen: false);
        if (!sp.isSessionExpired) sp.recordActivity();
      } catch (_) {}
    }

    return null;
  },
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
          path: '/lab-bookings',
          name: 'lab-bookings',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: LabBookingsScreen()),
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
        GoRoute(
          path: '/appointment-queue',
          name: 'appointment-queue',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: AppointmentQueueScreen()),
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
        GoRoute(
          path: '/mar/due',
          name: 'mar-due',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: DueMedsScreen()),
        ),
        GoRoute(
          path: '/mar/scan/:maId',
          name: 'mar-scan',
          pageBuilder: (context, state) {
            final maId = int.tryParse(state.pathParameters['maId'] ?? '') ?? 0;
            return NoTransitionPage(child: MarScanScreen(maId: maId));
          },
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
        GoRoute(
          path: '/housekeeping',
          name: 'housekeeping',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: HousekeepingHubScreen()),
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

        // Messaging
        GoRoute(
          path: '/messaging',
          name: 'messaging',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: MessagingInboxScreen()),
        ),
        GoRoute(
          path: '/messaging/thread/:otherStaffUid',
          name: 'messaging-thread',
          pageBuilder: (context, state) {
            final otherStaffUid = state.pathParameters['otherStaffUid']!;
            return NoTransitionPage(
              child: MessagingThreadScreen(otherStaffUid: otherStaffUid),
            );
          },
        ),

        // Beds
        GoRoute(
          path: '/beds',
          name: 'beds',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: BedBoardScreen()),
        ),

        // Blood Bank
        GoRoute(
          path: '/blood-bank',
          name: 'blood-bank',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: BloodBankScreen()),
        ),

        // Dietary
        GoRoute(
          path: '/dietary',
          name: 'dietary',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: DietaryScreen()),
        ),

        // Theatre
        GoRoute(
          path: '/theatre',
          name: 'theatre',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: TheatreScreen()),
        ),

        // Radiology
        GoRoute(
          path: '/radiology',
          name: 'radiology',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: RadiologyScreen()),
        ),

        // EMR
        GoRoute(
          path: '/emr/admissions',
          name: 'emr-admissions',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: AdmissionScreen()),
        ),
        GoRoute(
          path: '/emr/notes/:uid',
          name: 'emr-notes',
          pageBuilder: (context, state) {
            final uid = state.pathParameters['uid']!;
            final name = state.uri.queryParameters['name'];
            return NoTransitionPage(
              child: ClinicalNotesScreen(patientUid: uid, patientName: name),
            );
          },
        ),
        GoRoute(
          path: '/emr/timeline/:uid',
          name: 'emr-timeline',
          pageBuilder: (context, state) {
            final uid = state.pathParameters['uid']!;
            final name = state.uri.queryParameters['name'];
            return NoTransitionPage(
              child: PatientTimelineScreen(patientUid: uid, patientName: name),
            );
          },
        ),
        GoRoute(
          path: '/emr/orders/:uid',
          name: 'emr-orders',
          pageBuilder: (context, state) {
            final uid = state.pathParameters['uid']!;
            final name = state.uri.queryParameters['name'];
            return NoTransitionPage(
              child: OrdersScreen(patientUid: uid, patientName: name),
            );
          },
        ),
        GoRoute(
          path: '/emr/vitals/:uid',
          name: 'emr-vitals',
          pageBuilder: (context, state) {
            final uid = state.pathParameters['uid']!;
            final name = state.uri.queryParameters['name'];
            return NoTransitionPage(
              child: VitalsChartScreen(patientUid: uid, patientName: name),
            );
          },
        ),
        GoRoute(
          path: '/emr/discharge/:id',
          name: 'emr-discharge',
          pageBuilder: (context, state) {
            final id = int.parse(state.pathParameters['id']!);
            final name = state.uri.queryParameters['name'] ?? 'Patient';
            return NoTransitionPage(
              child: DischargeSummaryScreen(admissionId: id, patientName: name),
            );
          },
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
