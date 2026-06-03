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
import '../../features/investigations/screens/investigations_screen.dart';
import '../../features/investigations/screens/lab_bookings_screen.dart';
import '../../features/pharmacy/screens/pharmacy_screen.dart';
import '../../features/profile/screens/profile_screen.dart';
import '../../features/settings/screens/settings_screen.dart';
import '../../features/reception/screens/front_office_workbench_screen.dart';
import '../../features/reception/screens/billing_desk_screen.dart';
import '../../features/ward/screens/ward_mode_screen.dart';

// Doctor
import '../../features/doctor/screens/patient_records_screen.dart';
import '../../features/doctor/screens/prescriptions_screen.dart';
import '../../features/doctor/screens/queue_screen.dart';

// Clinical AI (Phase 2 of the rollout — see docs/CLINICAL_AI_ROLLOUT_PLAN.md)
import '../../features/clinical_ai/screens/clinical_ai_review_queue_screen.dart';
import '../../features/clinical_ai/screens/clinical_ai_draft_detail_screen.dart';
import '../../features/clinical_ai/screens/clinical_ai_compose_runs_screen.dart';
import '../../features/clinical_ai/screens/clinical_ai_compose_run_detail_screen.dart';
import '../../features/clinical_ai/screens/clinical_ai_voice_notes_screen.dart';
import '../../features/clinical_ai/screens/op_ai_assist_screen.dart';

// Nursing
import '../../features/nursing/screens/vitals_screen.dart';
import '../../features/nursing/screens/nursing_notes_screen.dart';
import '../../features/nursing/screens/due_meds_screen.dart';
import '../../features/nursing/screens/mar_scan_screen.dart';

// HR
import '../../features/hr/screens/hr_dashboard_screen.dart';
import '../../features/hr/screens/leave_approvals_screen.dart';
import '../../features/hr/screens/organization_hierarchy_screen.dart';
import '../../features/hr/screens/staff_management_screen.dart';
import '../../features/hr/screens/staff_roster_hub_screen.dart';
import '../../features/hr/screens/performance_screen.dart';
import '../../features/reports/screens/reports_admin_queue_screen.dart';
import '../../features/reports/screens/reports_hub_screen.dart';

// Housekeeping
import '../../features/housekeeping/screens/tasks_screen.dart';
import '../../features/housekeeping/screens/housekeeping_hub_screen.dart';
import '../../features/housekeeping/screens/housekeeping_command_screen.dart';
import '../../features/housekeeping/screens/housekeeping_roster_board_screen.dart';

// Directory
import '../../features/directory/screens/staff_directory_screen.dart';

// Notifications
import '../../features/notifications/screens/notifications_screen.dart';

// Schedule
import '../../features/schedule/screens/schedule_screen.dart';
import '../../features/schedule/screens/duty_preference_screen.dart';

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
import '../../features/productivity/screens/calculators_screen.dart';
import '../../features/productivity/screens/order_sets_screen.dart';
import '../../features/maternity/screens/maternity_screen.dart';
import '../../features/maternity/screens/partograph_entry_screen.dart';
import '../../features/maternity/screens/partograph_view_screen.dart';

// Radiology
import '../../features/radiology/screens/radiology_screen.dart';

// EMR
import '../../features/emr/screens/admission_screen.dart';
import '../../features/emr/screens/admission_case_sheet_screen.dart';
import '../../features/emr/screens/patient_command_board_screen.dart';
import '../../features/emr/screens/clinical_notes_screen.dart';
import '../../features/emr/screens/patient_timeline_screen.dart';
import '../../features/emr/screens/orders_screen.dart';
import '../../features/emr/screens/vitals_chart_screen.dart';
import '../../features/emr/screens/discharge_hub_list_screen.dart';
import '../../features/emr/screens/discharge_hub_screen.dart';
import '../../features/emr/screens/discharge_summary_screen.dart';
import '../../features/ipd/screens/drug_chart_screen.dart';

// Messaging
import '../../features/messaging/screens/messaging_inbox_screen.dart';
import '../../features/messaging/screens/messaging_thread_screen.dart';

// Shell
import '../widgets/main_scaffold.dart';

final _rootNavigatorKey = GlobalKey<NavigatorState>();
// Re-exported for the global keyboard-shortcut layer in main.dart so
// Ctrl+K can open the patient picker against the live root navigator
// from outside the widget tree.
GlobalKey<NavigatorState> get rootNavigatorKey => _rootNavigatorKey;
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
        Provider.of<SessionTimeoutProvider>(
          context,
          listen: false,
        ).startTracking();
      } catch (_) {}
      return '/dashboard';
    }

    // User is logged in and on a protected page — ensure timer is running
    if (isLoggedIn && !isOnLogin) {
      try {
        final sp = Provider.of<SessionTimeoutProvider>(context, listen: false);
        if (!sp.isSessionExpired) {
          if (sp.isTracking) {
            sp.recordActivity();
          } else {
            sp.startTracking();
          }
        }
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
          pageBuilder: (context, state) {
            final initialDate = DateTime.tryParse(
              state.uri.queryParameters['date'] ?? '',
            );
            return NoTransitionPage(
              child: AppointmentsScreen(initialDate: initialDate),
            );
          },
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
        GoRoute(
          path: '/reception-counter',
          name: 'reception-counter',
          pageBuilder: (context, state) {
            final q = state.uri.queryParameters;
            return NoTransitionPage(
              child: FrontOfficeWorkbenchScreen(
                initialPatientUid: q['patient_uid'],
                initialPatientId: q['patient_id'],
                initialPatientName: q['name'],
                initialPatientPhone: q['phone'],
                initialHospitalNumber: q['hospital_number'],
              ),
            );
          },
        ),
        GoRoute(
          path: '/front-office',
          name: 'front-office',
          pageBuilder: (context, state) {
            final q = state.uri.queryParameters;
            return NoTransitionPage(
              child: FrontOfficeWorkbenchScreen(
                initialPatientUid: q['patient_uid'],
                initialPatientId: q['patient_id'],
                initialPatientName: q['name'],
                initialPatientPhone: q['phone'],
                initialHospitalNumber: q['hospital_number'],
              ),
            );
          },
        ),
        GoRoute(
          path: '/billing-desk',
          name: 'billing-desk',
          pageBuilder: (context, state) {
            final q = state.uri.queryParameters;
            return NoTransitionPage(
              child: BillingDeskScreen(
                prefillPatientUid: q['patient_uid'],
                prefillPatientName: q['name'],
                prefillPatientPhone: q['phone'],
              ),
            );
          },
        ),
        GoRoute(
          path: '/ward-mode',
          name: 'ward-mode',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: WardModeScreen()),
        ),

        // Doctor
        GoRoute(
          path: '/patient-records',
          name: 'patient-records',
          pageBuilder: (context, state) => NoTransitionPage(
            child: PatientRecordsScreen(
              contextMode: state.uri.queryParameters['context'],
              initialPatientId: state.uri.queryParameters['patient_id'],
              initialPatientPhone: state.uri.queryParameters['phone'],
              initialPatientName: state.uri.queryParameters['name'],
              initialHospitalNumber:
                  state.uri.queryParameters['hospital_number'],
              initialAction: state.uri.queryParameters['action'],
            ),
          ),
        ),
        GoRoute(
          path: '/prescriptions',
          name: 'prescriptions',
          pageBuilder: (context, state) {
            final extra = state.extra;
            final prefilledAppointment = extra is Map<String, dynamic>
                ? extra
                : null;
            return NoTransitionPage(
              child: PrescriptionsScreen(
                prefilledAppointment: prefilledAppointment,
              ),
            );
          },
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
          // Legacy deep links now land on the consolidated OP/reception
          // workbench, which owns queue management alongside patient search,
          // booking, billing, and admission handoff.
          redirect: (context, state) => '/front-office',
        ),

        // Clinical AI — Phase 2 of the rollout. Review queue lists the
        // caller's pending drafts (filtered server-side by reviewerRole +
        // module's reviewRoles[]); detail screen sign / edit / reject.
        GoRoute(
          path: '/clinical-ai/queue',
          name: 'clinical-ai-queue',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: ClinicalAiReviewQueueScreen()),
        ),
        GoRoute(
          path: '/clinical-ai/review/:reviewId',
          name: 'clinical-ai-review',
          pageBuilder: (context, state) {
            final raw = state.pathParameters['reviewId'];
            final id = int.tryParse(raw ?? '') ?? 0;
            final extra = state.extra;
            return NoTransitionPage(
              child: ClinicalAiDraftDetailScreen(
                reviewId: id,
                initialReview: extra is Map<String, dynamic> ? extra : null,
              ),
            );
          },
        ),

        // Phase 5 staff Clinical AI rollout: compose run tree + voice notes.
        GoRoute(
          path: '/clinical-ai/compose',
          name: 'clinical-ai-compose-runs',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: ClinicalAiComposeRunsScreen()),
        ),
        GoRoute(
          path: '/clinical-ai/compose/:runId',
          name: 'clinical-ai-compose-detail',
          pageBuilder: (context, state) {
            final raw = state.pathParameters['runId'];
            final id = int.tryParse(raw ?? '') ?? 0;
            final extra = state.extra;
            return NoTransitionPage(
              child: ClinicalAiComposeRunDetailScreen(
                runId: id,
                initialRun: extra is Map<String, dynamic> ? extra : null,
              ),
            );
          },
        ),
        GoRoute(
          path: '/clinical-ai/voice-notes',
          name: 'clinical-ai-voice-notes',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: ClinicalAiVoiceNotesScreen()),
        ),
        GoRoute(
          path: '/op-ai-assist',
          name: 'op-ai-assist',
          pageBuilder: (context, state) {
            final raw = state.uri.queryParameters['appointment_id'];
            final appointmentId = int.tryParse(raw ?? '');
            return NoTransitionPage(
              child: OpAiAssistScreen(initialAppointmentId: appointmentId),
            );
          },
        ),

        // Nursing
        //
        // /vitals remains available for the legacy/OP nursing flow.
        // IP vitals entry is routed through /emr/vitals/:uid so records
        // share the same chart used by Patient Command Board and Bed Board.
        GoRoute(
          path: '/vitals',
          name: 'vitals',
          pageBuilder: (context, state) {
            final q = state.uri.queryParameters;
            return NoTransitionPage(
              child: VitalsScreen(
                prefillPatientUid: q['patient_uid'],
                prefillPatientId: q['patient_id'],
                prefillPatientName: q['name'],
                prefillPatientPhone: q['phone'],
              ),
            );
          },
        ),
        GoRoute(
          path: '/nursing-notes',
          name: 'nursing-notes',
          pageBuilder: (context, state) {
            final q = state.uri.queryParameters;
            return NoTransitionPage(
              child: NursingNotesScreen(
                prefillPatientUid: q['patient_uid'],
                prefillPatientName: q['name'],
                prefillPatientPhone: q['phone'],
              ),
            );
          },
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
        GoRoute(
          path: '/drug-chart/:admissionId',
          name: 'drug-chart',
          pageBuilder: (context, state) {
            final admissionId =
                int.tryParse(state.pathParameters['admissionId'] ?? '') ?? 0;
            return NoTransitionPage(
              child: DrugChartScreen(
                admissionId: admissionId,
                patientName: state.uri.queryParameters['name'],
              ),
            );
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
          path: '/organization-hierarchy',
          name: 'organization-hierarchy',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: OrganizationHierarchyScreen()),
        ),
        GoRoute(
          path: '/performance',
          name: 'performance',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: PerformanceScreen()),
        ),
        GoRoute(
          path: '/leave-approvals',
          name: 'leave-approvals',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: LeaveApprovalsScreen()),
        ),
        GoRoute(
          path: '/staff-rosters',
          name: 'staff-rosters',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: StaffRosterHubScreen()),
        ),
        GoRoute(
          path: '/reports-grievances',
          name: 'reports-grievances',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: ReportsHubScreen()),
        ),
        GoRoute(
          path: '/reports-grievances/admin',
          name: 'reports-grievances-admin',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: ReportsAdminQueueScreen()),
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
        GoRoute(
          path: '/housekeeping-command',
          name: 'housekeeping-command',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: HousekeepingCommandScreen()),
        ),
        GoRoute(
          path: '/housekeeping-roster',
          name: 'housekeeping-roster',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: HousekeepingRosterBoardScreen()),
        ),
        GoRoute(
          path: '/staff-roster/:department',
          name: 'staff-roster',
          pageBuilder: (context, state) {
            final department =
                state.pathParameters['department'] ?? 'housekeeping';
            final title = switch (department) {
              'nursing' => 'Nursing Roster',
              'op_nursing' => 'OP Nursing Roster',
              'reception' => 'Reception Roster',
              'ambulance' || 'drivers' => 'Driver Roster',
              'maintenance' => 'Maintenance Roster',
              'pharmacy' => 'Pharmacy Roster',
              'medical' => 'Doctor Roster',
              _ => 'Shift Roster',
            };
            return NoTransitionPage(
              child: HousekeepingRosterBoardScreen(
                department: department,
                title: title,
              ),
            );
          },
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
        GoRoute(
          path: '/duty-preference',
          name: 'duty-preference',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: DutyPreferenceScreen()),
        ),

        // Handover — accepts optional `patient_ref` and `phone` query
        // params (passed in from the bed-board sheet's "Handover" quick
        // action so the form's free-text reference field pre-fills with
        // ward + bed + patient name).
        GoRoute(
          path: '/handover',
          name: 'handover',
          pageBuilder: (context, state) {
            final q = state.uri.queryParameters;
            return NoTransitionPage(
              child: HandoverScreen(
                prefillPatientRef: q['patient_ref'],
                prefillPhone: q['phone'],
              ),
            );
          },
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
            final extra = state.extra;
            final extraMap = extra is Map ? extra : const {};
            return NoTransitionPage(
              child: MessagingThreadScreen(
                otherStaffUid: otherStaffUid,
                otherStaffName: extraMap['otherStaffName']?.toString(),
                otherStaffDepartment: extraMap['otherStaffDepartment']
                    ?.toString(),
              ),
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

        // Doctor productivity (Sprint 8)
        GoRoute(
          path: '/calculators',
          name: 'calculators',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: CalculatorsScreen()),
        ),
        GoRoute(
          path: '/order-sets',
          name: 'order-sets',
          pageBuilder: (context, state) {
            final extra = state.extra as Map<String, dynamic>?;
            return NoTransitionPage(
              child: OrderSetsScreen(
                encounterId: extra?['encounter_id'] as int?,
                patientUid: extra?['patient_uid'] as String?,
              ),
            );
          },
        ),

        // Maternity (Sprint 7)
        GoRoute(
          path: '/maternity',
          name: 'maternity',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: MaternityScreen()),
        ),
        GoRoute(
          path: '/maternity/partograph/:laborId',
          name: 'partograph-entry',
          pageBuilder: (context, state) => NoTransitionPage(
            child: PartographEntryScreen(
              laborAdmissionId: int.parse(state.pathParameters['laborId']!),
            ),
          ),
        ),
        GoRoute(
          path: '/maternity/labor/:laborId/chart',
          name: 'partograph-chart',
          pageBuilder: (context, state) => NoTransitionPage(
            child: PartographViewScreen(
              laborAdmissionId: int.parse(state.pathParameters['laborId']!),
            ),
          ),
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
          path: '/patient-command-board',
          name: 'patient-command-board',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: PatientCommandBoardScreen()),
        ),
        GoRoute(
          path: '/emr/admissions',
          name: 'emr-admissions',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: AdmissionScreen()),
        ),
        GoRoute(
          path: '/emr/case-sheet/:id',
          name: 'emr-case-sheet',
          pageBuilder: (context, state) {
            final id = int.parse(state.pathParameters['id']!);
            final name = state.uri.queryParameters['name'] ?? 'Patient';
            final gender = state.uri.queryParameters['gender'] ?? '';
            return NoTransitionPage(
              child: AdmissionCaseSheetScreen(
                admissionId: id,
                patientName: name,
                patientGender: gender,
              ),
            );
          },
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
          path: '/emr/discharge-hub',
          name: 'emr-discharge-hub-list',
          pageBuilder: (context, state) {
            return const NoTransitionPage(child: DischargeHubListScreen());
          },
        ),
        GoRoute(
          path: '/emr/discharge-hub/:id',
          name: 'emr-discharge-hub',
          pageBuilder: (context, state) {
            final id = int.parse(state.pathParameters['id']!);
            final name = state.uri.queryParameters['name'] ?? 'Patient';
            return NoTransitionPage(
              child: DischargeHubScreen(admissionId: id, patientName: name),
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
