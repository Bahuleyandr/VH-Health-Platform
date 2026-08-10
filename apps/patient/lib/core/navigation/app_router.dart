// lib/core/navigation/app_router.dart
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_core/services/realtime_provider.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:vhhealth/core/navigation/go_router_refresh_stream.dart';
import 'package:vhhealth/core/providers/session_timeout_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/websocket_service.dart';
import 'package:vhhealth/core/widgets/biometric_gate.dart';

// Import all your screens
import 'package:vhhealth/features/chatbot/screens/symptom_checker_screen.dart';
import 'package:vhhealth/features/splash/screens/splash_screen.dart';
import 'package:vhhealth/features/auth/screens/login_screen.dart';
import 'package:vhhealth/features/auth/screens/terms_disclaimer_screen.dart';
import 'package:vhhealth/features/profile/screens/profile_setup_screen.dart';
import 'package:vhhealth/features/profile/screens/profile_edit_screen.dart';
import 'package:vhhealth/features/profile/screens/add_dependent_screen.dart';
import 'package:vhhealth/features/dashboard/screens/dashboard_screen.dart';
import 'package:vhhealth/features/your_health/screens/your_health_screen.dart';
import 'package:vhhealth/features/notifications/screens/notifications_screen.dart';
import 'package:vhhealth/features/settings/screens/settings_screen.dart';
import 'package:vhhealth/features/settings/screens/record_access_screen.dart';
import 'package:vhhealth/features/appointments/screens/appointments_screen.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_route_args.dart';
import 'package:vhhealth/features/teleconsult/screens/appointment_detail_screen.dart';
import 'package:vhhealth/features/teleconsult/screens/teleconsult_consult_screen.dart';
import 'package:vhhealth/features/teleconsult/screens/teleconsult_lobby_screen.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_device_service.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_repository.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_room_client.dart';
import 'package:vhhealth/features/pharmacy/screens/pharmacy_screen.dart';
import 'package:vhhealth/features/investigations/screens/investigations_screen.dart';
import 'package:vhhealth/features/investigations/screens/book_investigation_screen.dart';
import 'package:vhhealth/features/feedback/screens/ask_a_doubt_screen.dart';
import 'package:vhhealth/features/feedback/screens/feedback_history_screen.dart';
import 'package:vhhealth/features/trivia/screens/trivia_screen.dart';
import 'package:vhhealth/features/departments/screens/departments_screen.dart';
import 'package:vhhealth/features/about/screens/about_us_screen.dart';
import 'package:vhhealth/features/calendar/screens/calendar_screen.dart';
import 'package:vhhealth/features/steps/screens/step_challenge_screen.dart';
import 'package:vhhealth/features/vitals/screens/vitals_screen.dart';
import 'package:vhhealth/features/prescriptions/screens/refill_screen.dart';
import 'package:vhhealth/features/family/screens/family_screen.dart';
import 'package:vhhealth/features/medications/screens/medication_reminders_screen.dart';
import 'package:vhhealth/features/abdm/screens/abdm_screen.dart';
import 'package:vhhealth/features/gamification/screens/health_points_screen.dart';
import 'package:vhhealth/features/period_tracker/screens/period_tracker_screen.dart';
import 'package:vhhealth/features/maternity/screens/anc_timeline_screen.dart';
import 'package:vhhealth/features/portal/screens/bills_screen.dart';
import 'package:vhhealth/features/portal/screens/bill_detail_screen.dart';
import 'package:vhhealth/features/portal/services/discharge_summaries_repository.dart';
import 'package:vhhealth/features/portal/screens/discharge_summaries_screen.dart';
import 'package:vhhealth/features/portal/screens/lab_orders_screen.dart';
import 'package:vhhealth/features/portal/screens/lab_results_screen.dart';
import 'package:vhhealth/features/portal/screens/structured_diagnostic_results_screen.dart';
import 'package:vhhealth/features/portal/screens/patient_referrals_screen.dart';
import 'package:vhhealth/features/portal/screens/messages_screen.dart';
import 'package:vhhealth/features/portal/screens/message_thread_screen.dart';
import 'package:vhhealth/features/portal/screens/tpa_claims_screen.dart';
import 'package:vhhealth/features/your_health/widgets/consultation_notes_tab.dart';
import 'package:vhhealth/features/your_health/widgets/explanations_tab.dart';
import 'package:vhhealth/core/widgets/main_scaffold_go_router.dart';

class AppRouter {
  static final _rootNavigatorKey = GlobalKey<NavigatorState>();
  static final _shellNavigatorKey = GlobalKey<NavigatorState>();

  /// Shape-check a JWT: header.payload.signature, each part non-empty.
  /// Cheaper than verification, but rules out garbage values that an
  /// attacker (or a corrupted storage write) could leave in
  /// `flutter_secure_storage` to bypass the "do we have a session?"
  /// gate. Matches the staff-app hardening.
  static bool _hasValidJwtShape(String? jwt) {
    if (jwt == null || jwt.isEmpty) return false;
    final parts = jwt.split('.');
    return parts.length == 3 && parts.every((part) => part.isNotEmpty);
  }

  /// The realtime fabric is connected at cold start (main.dart) and torn down
  /// by every logout path, but an in-process re-login never re-ran connect —
  /// so the `session:revoked` "logged in elsewhere" kick was dead after the
  /// first logout. Re-arm both realtime clients whenever an authenticated
  /// navigation finds them fully disconnected (idempotent: no-ops while
  /// connected or mid-reconnect, and both clients skip connecting without a
  /// JWT).
  static void _ensureRealtimeConnected(BuildContext context) {
    if (RealtimeClient.instance.connectionState ==
        RealtimeConnectionState.disconnected) {
      try {
        unawaited(context.read<RealtimeProvider>().ensureConnected());
      } catch (_) {
        // Provider not mounted (tests) — fall back to the client directly.
        unawaited(RealtimeClient.instance.connect());
      }
    }
    if (!WebSocketService.instance.isConnected) {
      unawaited(WebSocketService.instance.connect());
    }
  }

  /// Wraps a route's screen in the patient's optional biometric lock
  /// (FL-H1 / PAT-7). No-op when the Settings toggle is off; when on, the
  /// PHI subtree is not built (and its fetches never run) until the OS
  /// biometric prompt grants access. BiometricGate's grace window keeps
  /// hub → detail navigation to a single prompt.
  static Widget _biometricGated(Widget Function(BuildContext) builder) {
    return BiometricGate(builder: builder);
  }

  static String? _safeReturnTo(String? raw) {
    final value = raw?.trim();
    if (value == null || value.isEmpty) return null;
    if (!value.startsWith('/')) return null;
    if (value == '/' ||
        value.startsWith('/login') ||
        value.startsWith('/terms') ||
        value.startsWith('/profile-setup')) {
      return null;
    }
    return value;
  }

  /// Wraps a page in a [CustomTransitionPage] with a short cross-fade.
  /// Used for the splash → login / login → profile-setup transitions so
  /// they don't appear as a hard cut.
  static CustomTransitionPage<T> _fadePage<T>({
    required GoRouterState state,
    required Widget child,
  }) {
    return CustomTransitionPage<T>(
      key: state.pageKey,
      child: child,
      transitionDuration: const Duration(milliseconds: 280),
      reverseTransitionDuration: const Duration(milliseconds: 200),
      transitionsBuilder: (context, animation, secondaryAnimation, child) {
        return FadeTransition(
          opacity: CurvedAnimation(parent: animation, curve: Curves.easeOut),
          child: child,
        );
      },
    );
  }

  static final router = GoRouter(
    navigatorKey: _rootNavigatorKey,
    initialLocation: '/',
    // Re-run the redirect whenever Firebase auth state changes. Every logout
    // path (explicit button, idle timeout, 401 expiry, session revocation)
    // ends with a Firebase signOut in LogoutService, so this is what actually
    // moves an automatically-logged-out user off a dead authenticated screen
    // and onto /login without waiting for their next navigation.
    refreshListenable: GoRouterRefreshStream(
      FirebaseAuth.instance.authStateChanges(),
    ),
    // Only log navigation (which includes patient/invoice IDs in route paths)
    // in debug builds; on Android debugLogDiagnostics output reaches logcat.
    debugLogDiagnostics: kDebugMode,

    // Handle auth redirects
    redirect: (context, state) async {
      SessionTimeoutProvider? sessionProvider;
      UserProvider? userProvider;
      try {
        sessionProvider = context.read<SessionTimeoutProvider>();
      } catch (_) {
        // Provider may not be available during initial build.
      }
      try {
        userProvider = context.read<UserProvider>();
      } catch (_) {
        // Provider may not be available during initial build.
      }

      // The router historically gated on FirebaseAuth.currentUser only,
      // which conflated Firebase OTP state with backend session state. A
      // Firebase signOut (token expiry, debug-only dev login that bypasses
      // Firebase, etc.) would bounce a perfectly authenticated user back
      // to /login. We now consider either signal sufficient: Firebase
      // user OR a JWT in secure storage.
      final currentUser = FirebaseAuth.instance.currentUser;
      bool isLoggedIn = currentUser != null;
      // Fast path: UserProvider is hydrated by the splash screen and the
      // login flows, and cleared by every logout / 401 path, so a non-empty
      // phone is a reliable in-memory "we have a session" signal. It spares
      // the keystore-backed storage read below on every navigation of a
      // dev-login or Firebase-token-expired session (where currentUser is
      // null but the JWT is still valid).
      if (!isLoggedIn && (userProvider?.phone.isNotEmpty ?? false)) {
        isLoggedIn = userProvider?.phone != 'guest';
      }
      // Cold-start / partial-storage backstop: when neither in-memory signal
      // said yes, confirm against the JWT in secure storage.
      if (!isLoggedIn) {
        try {
          final jwt = await VHSecureStorage.instance.read(key: 'jwt');
          // Don't treat any non-empty secure-storage value as an
          // authenticated session — require a JWT-shaped string.
          isLoggedIn = _hasValidJwtShape(jwt);
        } catch (_) {
          // Storage read failure → fall through to Firebase-only signal.
        }
      }
      final location = state.matchedLocation;
      final isGuestSession = userProvider?.phone == 'guest';

      // Skip redirect on splash screen to let it handle navigation
      if (location == '/') {
        return null;
      }

      final isAuthRoute =
          location == '/login' ||
          location == '/terms' ||
          location == '/profile-setup';

      final isGuestAllowedRoute =
          location == '/home' ||
          location == '/settings' ||
          location == '/about-us' ||
          location == '/departments' ||
          location == '/trivia';

      // Session idle timeout — force logout if expired
      if (sessionProvider != null &&
          sessionProvider.isSessionExpired &&
          !isAuthRoute &&
          !(isGuestSession && isGuestAllowedRoute)) {
        return '/login';
      }

      // If not logged in and not on auth route, redirect to login
      if (!isLoggedIn &&
          !isAuthRoute &&
          !(isGuestSession && isGuestAllowedRoute)) {
        final returnTo = _safeReturnTo(state.uri.toString());
        return returnTo == null
            ? '/login'
            : Uri(
                path: '/login',
                queryParameters: {'returnTo': returnTo},
              ).toString();
      }

      // If logged in and on login, ensure identity is hydrated, then go home.
      if (isLoggedIn && location == '/login') {
        // Start idle timer now that we know the user is authenticated
        if (sessionProvider != null) {
          sessionProvider.startTracking();
        }

        // Re-arm realtime for this (possibly in-process re-)login.
        if (!isGuestSession && context.mounted) {
          _ensureRealtimeConnected(context);
        }

        // Hydrate UserProvider from storage in case this route was reached
        // without passing through the splash screen (which normally does it).
        if (userProvider != null && userProvider.phone.isEmpty) {
          await userProvider.loadFromStorage();
        }
        final returnTo = _safeReturnTo(state.uri.queryParameters['returnTo']);
        return returnTo ?? '/home';
      }

      // User is logged in and on a protected page — ensure timer is running
      if (isLoggedIn && !isAuthRoute) {
        if (sessionProvider != null && !sessionProvider.isSessionExpired) {
          sessionProvider.recordActivity();
        }
        // Covers logins that navigate straight to a protected route without
        // a Firebase auth-state change re-running the /login branch above
        // (dev login, profile-setup completion).
        if (!isGuestSession && context.mounted) {
          _ensureRealtimeConnected(context);
        }
      }

      return null;
    },

    routes: [
      // Splash screen — fade to next route instead of a hard cut.
      GoRoute(
        path: '/',
        pageBuilder: (context, state) =>
            _fadePage(state: state, child: const SplashScreen()),
      ),

      // Auth routes
      GoRoute(
        path: '/login',
        pageBuilder: (context, state) {
          final rawExtra = state.extra;
          final extra = rawExtra is Map<String, dynamic> ? rawExtra : null;
          final returnTo = _safeReturnTo(
            extra?['returnTo']?.toString() ??
                state.uri.queryParameters['returnTo'],
          );
          return _fadePage(
            state: state,
            child: LoginScreen(returnTo: returnTo),
          );
        },
      ),
      GoRoute(
        path: '/terms',
        builder: (context, state) {
          final extra = state.extra as Map<String, dynamic>?;
          return TermsDisclaimerScreen(section: extra?['section']);
        },
      ),
      GoRoute(
        path: '/profile-setup',
        pageBuilder: (context, state) {
          final phone = state.extra as String? ?? '';
          return _fadePage(
            state: state,
            child: ProfileSetupScreen(phone: phone),
          );
        },
      ),
      GoRoute(
        path: '/profile-edit',
        builder: (context, state) => const ProfileEditScreen(),
      ),
      GoRoute(
        path: '/settings/record-access',
        builder: (context, state) => const RecordAccessScreen(),
      ),

      // Main app with bottom navigation
      ShellRoute(
        navigatorKey: _shellNavigatorKey,
        builder: (context, state, child) => MainScaffoldGoRouter(child: child),
        routes: [
          GoRoute(
            path: '/home',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: DashboardScreen()),
          ),
          GoRoute(
            path: '/health',
            pageBuilder: (context, state) {
              final extra = state.extra as Map<String, dynamic>?;
              return NoTransitionPage(
                child: YourHealthScreen(initialTab: extra?['tab'] as int? ?? 0),
              );
            },
          ),
          GoRoute(
            path: '/notifications',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: NotificationsScreen()),
          ),
          GoRoute(
            path: '/settings',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: SettingsScreen()),
          ),
        ],
      ),

      // Feature routes (outside shell for full screen)
      GoRoute(
        path: '/appointments',
        builder: (context, state) => const AppointmentsScreen(),
      ),
      GoRoute(
        path: '/appointments/:id',
        redirect: (context, state) {
          final id = int.tryParse(state.pathParameters['id'] ?? '');
          return id == null || state.extra is! TeleconsultRouteArgs
              ? '/appointments'
              : null;
        },
        builder: (context, state) {
          final args = state.extra! as TeleconsultRouteArgs;
          return AppointmentDetailScreen(
            appointment: args.appointment,
            initialTeleconsultState: args.initialState,
            repository: args.repository ?? const TeleconsultRepository(),
          );
        },
      ),
      GoRoute(
        path: '/teleconsult/appointments/:appointmentId/lobby',
        redirect: (context, state) {
          final id = int.tryParse(state.pathParameters['appointmentId'] ?? '');
          return id == null || state.extra is! TeleconsultRouteArgs
              ? '/appointments'
              : null;
        },
        builder: (context, state) {
          final args = state.extra! as TeleconsultRouteArgs;
          return TeleconsultLobbyScreen(
            appointment: args.appointment,
            initialState: args.initialState,
            repository: args.repository ?? const TeleconsultRepository(),
            deviceService:
                args.deviceService ??
                const PermissionHandlerTeleconsultDeviceService(),
            roomClient: args.roomClient ?? const LiveKitTeleconsultRoomClient(),
          );
        },
      ),
      GoRoute(
        path: '/teleconsult/appointments/:appointmentId/consult',
        redirect: (context, state) {
          final id = int.tryParse(state.pathParameters['appointmentId'] ?? '');
          return id == null || state.extra is! TeleconsultConsultArgs
              ? '/appointments'
              : null;
        },
        builder: (context, state) {
          final args = state.extra! as TeleconsultConsultArgs;
          return TeleconsultConsultScreen(
            appointment: args.appointment,
            lobbyState: args.lobbyState,
            readiness: args.readiness,
            repository: args.repository ?? const TeleconsultRepository(),
            roomClient: args.roomClient ?? const LiveKitTeleconsultRoomClient(),
          );
        },
      ),
      GoRoute(
        path: '/pharmacy',
        builder: (context, state) => const PharmacyScreen(),
      ),

      // Patient self-service portal (Sprint 10)
      GoRoute(
        path: '/portal/bills',
        builder: (context, state) =>
            _biometricGated((_) => const BillsScreen()),
      ),
      GoRoute(
        path: '/portal/bills/:id',
        redirect: (context, state) {
          final id = int.tryParse(state.pathParameters['id'] ?? '');
          return id == null ? '/portal/bills' : null;
        },
        builder: (context, state) => _biometricGated(
          (_) => BillDetailScreen(
            invoiceId: int.tryParse(state.pathParameters['id']!)!,
          ),
        ),
      ),
      GoRoute(
        path: '/portal/lab-results',
        builder: (context, state) =>
            _biometricGated((_) => const LabResultsScreen()),
      ),
      GoRoute(
        path: '/portal/lab-results/:id',
        redirect: (context, state) {
          final id = int.tryParse(state.pathParameters['id'] ?? '');
          return id == null ? '/portal/lab-results' : null;
        },
        builder: (context, state) {
          final id = int.tryParse(state.pathParameters['id']!)!;
          final extra = state.extra;
          final args = extra is LabResultDetailRouteArgs ? extra : null;
          final repository = args?.repository;
          if (repository != null) {
            return _biometricGated(
              (_) => LabResultDetailScreen(
                resultId: id,
                initialResult: args?.initialResult,
                repository: repository,
              ),
            );
          }
          return _biometricGated(
            (_) => LabResultDetailScreen(
              resultId: id,
              initialResult: args?.initialResult,
            ),
          );
        },
      ),
      GoRoute(
        path: '/portal/diagnostic-results',
        builder: (context, state) =>
            _biometricGated((_) => const StructuredDiagnosticResultsScreen()),
      ),
      GoRoute(
        path: '/portal/diagnostic-results/:id',
        redirect: (context, state) {
          final id = state.pathParameters['id'] ?? '';
          return RegExp(
                r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
              ).hasMatch(id)
              ? null
              : '/portal/diagnostic-results';
        },
        builder: (context, state) {
          final id = state.pathParameters['id']!;
          final extra = state.extra;
          final args = extra is StructuredDiagnosticResultDetailRouteArgs
              ? extra
              : null;
          final repository = args?.repository;
          if (repository != null) {
            return _biometricGated(
              (_) => StructuredDiagnosticResultDetailScreen(
                resultId: id,
                initialResult: args?.initialResult,
                repository: repository,
              ),
            );
          }
          return _biometricGated(
            (_) => StructuredDiagnosticResultDetailScreen(
              resultId: id,
              initialResult: args?.initialResult,
            ),
          );
        },
      ),
      GoRoute(
        path: '/portal/referrals',
        builder: (context, state) =>
            _biometricGated((_) => const PatientReferralsScreen()),
      ),
      GoRoute(
        path: '/portal/lab-orders',
        builder: (context, state) =>
            _biometricGated((_) => const LabOrdersScreen()),
      ),
      GoRoute(
        path: '/portal/discharge-summaries',
        builder: (context, state) =>
            _biometricGated((_) => const DischargeSummariesScreen()),
      ),
      GoRoute(
        path: '/portal/discharge-summaries/:id',
        redirect: (context, state) {
          final id = int.tryParse(state.pathParameters['id'] ?? '');
          return id == null ? '/portal/discharge-summaries' : null;
        },
        builder: (context, state) {
          final extra = state.extra;
          final args = extra is DischargeSummaryDetailRouteArgs ? extra : null;
          return _biometricGated(
            (_) => DischargeSummaryDetailRouteScreen(
              summaryId: int.tryParse(state.pathParameters['id']!)!,
              initialSummary: args?.initialSummary,
              repository:
                  args?.repository ?? const ApiDischargeSummariesRepository(),
              pdfOpener: args?.pdfOpener ?? openDischargeSummaryPdf,
            ),
          );
        },
      ),
      GoRoute(
        path: '/portal/maternity/timeline',
        builder: (context, state) =>
            _biometricGated((_) => const AncTimelineScreen()),
      ),
      GoRoute(
        path: '/portal/tpa/claims',
        builder: (context, state) =>
            _biometricGated((_) => const TpaClaimsScreen()),
      ),
      GoRoute(
        path: '/portal/tpa/claims/:id',
        redirect: (context, state) {
          final id = int.tryParse(state.pathParameters['id'] ?? '');
          return id == null ? '/portal/tpa/claims' : null;
        },
        builder: (context, state) => _biometricGated(
          (_) => TpaClaimDetailScreen(
            claimId: int.tryParse(state.pathParameters['id']!)!,
          ),
        ),
      ),
      GoRoute(
        path: '/portal/messages',
        builder: (context, state) =>
            _biometricGated((_) => const MessagesScreen()),
      ),
      GoRoute(
        path: '/portal/messages/:id',
        redirect: (context, state) {
          final id = int.tryParse(state.pathParameters['id'] ?? '');
          return id == null ? '/portal/messages' : null;
        },
        builder: (context, state) => _biometricGated(
          (_) => MessageThreadScreen(
            threadId: int.tryParse(state.pathParameters['id']!)!,
          ),
        ),
      ),
      GoRoute(
        path: '/health/explanations/:id',
        redirect: (context, state) {
          final id = int.tryParse(state.pathParameters['id'] ?? '');
          return id == null ? '/health' : null;
        },
        builder: (context, state) {
          final id = int.tryParse(state.pathParameters['id']!)!;
          final extra = state.extra;
          final args = extra is PatientExplainerDetailRouteArgs ? extra : null;
          final repository = args?.repository;
          if (repository != null) {
            return _biometricGated(
              (_) => PatientExplainerDetailScreen(
                reviewId: id,
                initialExplainer: args?.initialExplainer,
                repository: repository,
              ),
            );
          }
          return _biometricGated(
            (_) => PatientExplainerDetailScreen(
              reviewId: id,
              initialExplainer: args?.initialExplainer,
            ),
          );
        },
      ),
      GoRoute(
        path: '/health/consultation-notes/:id',
        redirect: (context, state) {
          final id = int.tryParse(state.pathParameters['id'] ?? '');
          return id == null ? '/health' : null;
        },
        builder: (context, state) {
          final id = int.tryParse(state.pathParameters['id']!)!;
          final extra = state.extra;
          final args = extra is ConsultationNoteDetailRouteArgs ? extra : null;
          final repository = args?.repository;
          if (repository != null) {
            return _biometricGated(
              (_) => ConsultationNoteDetailScreen(
                noteId: id,
                initialNote: args?.initialNote,
                repository: repository,
              ),
            );
          }
          return _biometricGated(
            (_) => ConsultationNoteDetailScreen(
              noteId: id,
              initialNote: args?.initialNote,
            ),
          );
        },
      ),
      GoRoute(
        path: '/investigations',
        builder: (context, state) => const InvestigationsScreen(),
      ),
      GoRoute(
        path: '/book-investigation',
        builder: (context, state) => const BookInvestigationScreen(),
      ),
      GoRoute(
        path: '/ask-a-doubt',
        builder: (context, state) => const AskADoubtScreen(),
      ),
      GoRoute(
        path: '/feedback-history',
        builder: (context, state) => const FeedbackHistoryScreen(),
      ),
      GoRoute(
        path: '/trivia',
        builder: (context, state) => const TriviaScreen(),
      ),
      GoRoute(
        path: '/departments',
        builder: (context, state) => const DepartmentsScreen(),
      ),
      GoRoute(
        path: '/about-us',
        builder: (context, state) => const AboutUsScreen(),
      ),
      GoRoute(
        path: '/chatbot',
        builder: (context, state) => const SymptomCheckerScreen(),
      ),
      GoRoute(
        path: '/calendar',
        builder: (context, state) => const CalendarScreen(),
      ),
      GoRoute(
        path: '/steps',
        builder: (context, state) => const StepChallengeScreen(),
      ),
      GoRoute(
        path: '/vitals',
        builder: (context, state) => const VitalsScreen(),
      ),
      GoRoute(
        path: '/refill',
        builder: (context, state) => const RefillScreen(),
      ),
      GoRoute(
        path: '/family',
        builder: (context, state) => const FamilyScreen(),
      ),
      GoRoute(
        path: '/add-dependent',
        builder: (context, state) => const AddDependentScreen(),
      ),
      GoRoute(
        path: '/reminders',
        builder: (context, state) => const MedicationRemindersScreen(),
      ),
      GoRoute(path: '/abdm', builder: (context, state) => const AbdmScreen()),
      GoRoute(
        path: '/health-points',
        builder: (context, state) => const HealthPointsScreen(),
      ),
      GoRoute(
        path: '/period-tracker',
        redirect: (context, state) {
          final extra = state.extra;
          final allowed =
              extra is Map<String, dynamic> && extra['eligible'] == true;
          return allowed ? null : '/home';
        },
        builder: (context, state) => const PeriodTrackerScreen(),
      ),
      GoRoute(path: '/records', redirect: (_, _) => '/health'),

      // Alternative route names for backward compatibility
      GoRoute(path: '/your-health', redirect: (_, _) => '/health'),
      GoRoute(path: '/dashboard', redirect: (_, _) => '/home'),
    ],

    // Error page
    errorBuilder: (context, state) => Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.error_outline,
              size: 64,
              color: Theme.of(context).colorScheme.error,
            ),
            const SizedBox(height: 16),
            Text('Page not found: ${state.matchedLocation}'),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: () => context.go('/home'),
              child: const Text('Go Home'),
            ),
          ],
        ),
      ),
    ),
  );
}
