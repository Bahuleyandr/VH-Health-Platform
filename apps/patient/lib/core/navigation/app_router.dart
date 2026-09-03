// lib/core/navigation/app_router.dart
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/navigation/biometric_gate_policy.dart';
import 'package:vhhealth/core/navigation/go_router_refresh_stream.dart';
import 'package:vhhealth/core/providers/session_timeout_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/patient_realtime_lifecycle.dart';
import 'package:vhhealth/core/services/patient_session_authority.dart';
import 'package:vhhealth/core/services/deep_link_service.dart';
import 'package:vhhealth/core/services/startup_gate_service.dart';
import 'package:vhhealth/core/widgets/biometric_gate.dart';
import 'package:vhhealth/generated/app_localizations.dart';

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
import 'package:vhhealth/features/appointments/screens/appointment_deep_link_route.dart';
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
import 'package:vhhealth/features/period_tracker/screens/period_tracker_deep_link_route.dart';
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

  /// The realtime fabric is connected at cold start (main.dart) and torn down
  /// by every logout path, but an in-process re-login never re-ran connect —
  /// so the `session:revoked` "logged in elsewhere" kick was dead after the
  /// first logout. Re-arm both realtime clients whenever an authenticated
  /// navigation finds it fully disconnected. The patient bridge registers its
  /// personal channels before the shared client connects, so authenticated
  /// readiness and subscription acknowledgements cannot race.
  static void _ensureRealtimeConnected() {
    unawaited(
      PatientRealtimeLifecycle.instance.queueStart().catchError((Object error) {
        if (kDebugMode) debugPrint('Realtime login re-arm skipped: $error');
      }),
    );
  }

  /// Wraps a route's screen in the patient's optional biometric lock
  /// (FL-H1 / PAT-7). No-op when the Settings toggle is off; when on, the
  /// PHI subtree is not built (and its fetches never run) until the OS
  /// biometric prompt grants access. BiometricGate's grace window keeps
  /// hub → detail navigation to a single prompt.
  ///
  /// WHICH routes get this wrapper is not a judgement call made here — see
  /// `lib/core/navigation/biometric_gate_policy.dart`. Every declared route
  /// must be classified there, and
  /// `test/core/navigation/biometric_gate_coverage_test.dart` fails if the
  /// router and the policy disagree in either direction.
  static Widget _biometricGated(
    String route,
    Widget Function(BuildContext) builder,
  ) {
    // Debug-only cross-check against the declared policy. `assert` is stripped
    // from profile AND release builds, so this costs a patient handset nothing,
    // but it fires in debug and in every widget test that builds a gated
    // route — which is where a mis-wired route would actually be introduced.
    assert(
      patientBiometricGatedRoutes.contains(route),
      'Route $route is wrapped in the biometric lock but is not declared in '
      'patientBiometricGatedRoutes (core/navigation/biometric_gate_policy.dart).',
    );
    return BiometricGate(builder: builder);
  }

  static String? _safeReturnTo(String? raw) {
    var value = raw?.trim();
    if (value == null || value.isEmpty) return null;
    if (!value.startsWith('/')) {
      value = DeepLinkService.parseExternalRoute(value);
      if (value == null) return null;
    }
    if (value.startsWith('//')) return null;
    if (value == '/' ||
        value.startsWith('/login') ||
        value.startsWith('/terms') ||
        value.startsWith('/profile-setup')) {
      return null;
    }
    return value;
  }

  @visibleForTesting
  static String? customSchemeRedirect(Uri uri) {
    if (uri.scheme != DeepLinkService.customScheme) return null;
    return DeepLinkService.parseExternalRoute(uri.toString()) ?? '/';
  }

  /// Cold-start gate guard: no non-splash route may render until the
  /// device-integrity and minimum-version gates have passed once for this
  /// process (see [StartupGateService]).
  ///
  /// The gates used to live ONLY in the splash tap handler, so a
  /// `vhhealth://app/<route>` deep-link cold start — which normalizes straight
  /// to its target on the first routing pass and never renders the splash —
  /// bypassed both of them. Holding the check here makes the splash path and
  /// every deep-link path share one fail-closed contract: a pass is cached
  /// process-wide (so an ordinary deep link costs nothing extra once the app
  /// has started normally), while a block bounces to the inert splash route,
  /// whose auto-advance re-runs the same evaluation and surfaces the
  /// integrity blocker / update-required screen.
  @visibleForTesting
  static Future<String?> startupGateRedirect(String location) async {
    if (location == '/') return null;
    StartupGateResult gate;
    try {
      gate = await StartupGateService.ensureEvaluated();
    } catch (e) {
      // Fail closed: an unevaluable gate holds the user on the splash, which
      // retries the evaluation, rather than letting the target route render.
      if (kDebugMode) debugPrint('Startup gate evaluation failed: $e');
      return '/';
    }
    return gate.allowed ? null : '/';
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

      final providerPhone = userProvider?.phone ?? '';
      final isGuestSession = providerPhone == 'guest';
      final location = state.matchedLocation;

      // Flutter preserves the incoming custom URI for the first routing pass.
      // Normalize only our exact allowlisted scheme/host contract to an
      // internal path. Malformed custom links go to the inert splash route;
      // HTTPS universal/app links remain unconfigured pending domain proof.
      final externalRedirect = customSchemeRedirect(state.uri);
      if (externalRedirect != null) return externalRedirect;

      // Skip redirect on splash screen to let it handle navigation
      if (location == '/') {
        return null;
      }

      // Cold-start security gates hold on EVERY path into a non-splash route,
      // including deep-link cold starts that never render the splash.
      final gateRedirect = await startupGateRedirect(location);
      if (gateRedirect != null) return gateRedirect;

      // Route authority comes only from a backend JWT. Firebase identity and
      // cached profile fields are inputs to login/hydration, never substitutes
      // for the API session that protects patient data.
      bool hasBackendSession = false;
      if (!isGuestSession) {
        try {
          hasBackendSession = await PatientSessionAuthority.instance
              .currentSessionAllowsProtectedAccess();
        } catch (_) {
          // Storage failure is fail-closed for protected navigation.
        }
      }
      final isLoggedIn = hasBackendSession;

      final isAuthRoute = location == '/login' || location == '/terms';

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

      // If the backend session is live and we're on /login, ensure identity
      // is hydrated, then go home.
      //
      // This branch deliberately gates on hasBackendSession, NOT isLoggedIn
      // (R16 OTP redirect race): Firebase's signInWithCredential succeeds —
      // and fires the refreshListenable — BEFORE the OTP flow's backend
      // login exchange has stored a JWT. Auto-redirecting on the Firebase
      // signal alone unmounted LoginForm mid-exchange, which killed its own
      // post-login navigation (profile-setup for new users, returnTo for
      // existing ones) and landed the user in the app without a backend
      // session. While only Firebase says yes, stay on /login and let the
      // OTP flow finish the exchange and navigate itself.
      if (hasBackendSession && location == '/login') {
        // Start idle timer now that we know the user is authenticated
        if (sessionProvider != null) {
          sessionProvider.startTracking();
        }

        // Re-arm realtime for this (possibly in-process re-)login.
        if (!isGuestSession && context.mounted) {
          _ensureRealtimeConnected();
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
          _ensureRealtimeConnected();
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
            pageBuilder: (context, state) => NoTransitionPage(
              child: _biometricGated(
                '/notifications',
                (_) => const NotificationsScreen(),
              ),
            ),
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
          return id == null || id < 1 ? '/appointments' : null;
        },
        builder: (context, state) {
          final id = int.parse(state.pathParameters['id']!);
          final extra = state.extra;
          if (extra is! TeleconsultRouteArgs || extra.appointment.id != id) {
            return AppointmentDeepLinkRoute(
              appointmentId: id,
              destination: AppointmentDeepLinkDestination.detail,
            );
          }
          final args = extra;
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
          return id == null || id < 1 ? '/appointments' : null;
        },
        builder: (context, state) {
          final id = int.parse(state.pathParameters['appointmentId']!);
          final extra = state.extra;
          if (extra is! TeleconsultRouteArgs || extra.appointment.id != id) {
            return AppointmentDeepLinkRoute(
              appointmentId: id,
              destination: AppointmentDeepLinkDestination.lobby,
            );
          }
          final args = extra;
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
          return id == null || id < 1 ? '/appointments' : null;
        },
        builder: (context, state) {
          final id = int.parse(state.pathParameters['appointmentId']!);
          final extra = state.extra;
          if (extra is! TeleconsultConsultArgs || extra.appointment.id != id) {
            return AppointmentDeepLinkRoute(
              appointmentId: id,
              destination: AppointmentDeepLinkDestination.consult,
            );
          }
          final args = extra;
          return TeleconsultConsultScreen(
            appointment: args.appointment,
            lobbyState: args.lobbyState,
            readiness: args.readiness,
            repository: args.repository ?? const TeleconsultRepository(),
            roomClient: args.roomClient ?? const LiveKitTeleconsultRoomClient(),
          );
        },
      ),
      // Lane L: pharmacy orders list the medicines dispensed against a
      // prescription — the same medication data class as the gated
      // Prescriptions tab, so the order history is gated too.
      GoRoute(
        path: '/pharmacy',
        builder: (context, state) =>
            _biometricGated('/pharmacy', (_) => const PharmacyScreen()),
      ),

      // Patient self-service portal (Sprint 10)
      GoRoute(
        path: '/portal/bills',
        builder: (context, state) =>
            _biometricGated('/portal/bills', (_) => const BillsScreen()),
      ),
      GoRoute(
        path: '/portal/bills/:id',
        redirect: (context, state) {
          final id = int.tryParse(state.pathParameters['id'] ?? '');
          return id == null ? '/portal/bills' : null;
        },
        builder: (context, state) => _biometricGated(
          '/portal/bills/:id',
          (_) => BillDetailScreen(
            invoiceId: int.tryParse(state.pathParameters['id']!)!,
          ),
        ),
      ),
      GoRoute(
        path: '/portal/lab-results',
        builder: (context, state) => _biometricGated(
          '/portal/lab-results',
          (_) => const LabResultsScreen(),
        ),
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
              '/portal/lab-results/:id',
              (_) => LabResultDetailScreen(
                resultId: id,
                initialResult: args?.initialResult,
                repository: repository,
              ),
            );
          }
          return _biometricGated(
            '/portal/lab-results/:id',
            (_) => LabResultDetailScreen(
              resultId: id,
              initialResult: args?.initialResult,
            ),
          );
        },
      ),
      GoRoute(
        path: '/portal/diagnostic-results',
        builder: (context, state) => _biometricGated(
          '/portal/diagnostic-results',
          (_) => const StructuredDiagnosticResultsScreen(),
        ),
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
              '/portal/diagnostic-results/:id',
              (_) => StructuredDiagnosticResultDetailScreen(
                resultId: id,
                initialResult: args?.initialResult,
                repository: repository,
              ),
            );
          }
          return _biometricGated(
            '/portal/diagnostic-results/:id',
            (_) => StructuredDiagnosticResultDetailScreen(
              resultId: id,
              initialResult: args?.initialResult,
            ),
          );
        },
      ),
      GoRoute(
        path: '/portal/referrals',
        builder: (context, state) => _biometricGated(
          '/portal/referrals',
          (_) => const PatientReferralsScreen(),
        ),
      ),
      GoRoute(
        path: '/portal/lab-orders',
        builder: (context, state) => _biometricGated(
          '/portal/lab-orders',
          (_) => const LabOrdersScreen(),
        ),
      ),
      GoRoute(
        path: '/portal/discharge-summaries',
        builder: (context, state) => _biometricGated(
          '/portal/discharge-summaries',
          (_) => const DischargeSummariesScreen(),
        ),
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
            '/portal/discharge-summaries/:id',
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
        builder: (context, state) => _biometricGated(
          '/portal/maternity/timeline',
          (_) => const AncTimelineScreen(),
        ),
      ),
      GoRoute(
        path: '/portal/tpa/claims',
        builder: (context, state) => _biometricGated(
          '/portal/tpa/claims',
          (_) => const TpaClaimsScreen(),
        ),
      ),
      GoRoute(
        path: '/portal/tpa/claims/:id',
        redirect: (context, state) {
          final id = int.tryParse(state.pathParameters['id'] ?? '');
          return id == null ? '/portal/tpa/claims' : null;
        },
        builder: (context, state) => _biometricGated(
          '/portal/tpa/claims/:id',
          (_) => TpaClaimDetailScreen(
            claimId: int.tryParse(state.pathParameters['id']!)!,
          ),
        ),
      ),
      GoRoute(
        path: '/portal/messages',
        builder: (context, state) =>
            _biometricGated('/portal/messages', (_) => const MessagesScreen()),
      ),
      GoRoute(
        path: '/portal/messages/:id',
        redirect: (context, state) {
          final id = int.tryParse(state.pathParameters['id'] ?? '');
          return id == null ? '/portal/messages' : null;
        },
        builder: (context, state) => _biometricGated(
          '/portal/messages/:id',
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
              '/health/explanations/:id',
              (_) => PatientExplainerDetailScreen(
                reviewId: id,
                initialExplainer: args?.initialExplainer,
                repository: repository,
              ),
            );
          }
          return _biometricGated(
            '/health/explanations/:id',
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
              '/health/consultation-notes/:id',
              (_) => ConsultationNoteDetailScreen(
                noteId: id,
                initialNote: args?.initialNote,
                repository: repository,
              ),
            );
          }
          return _biometricGated(
            '/health/consultation-notes/:id',
            (_) => ConsultationNoteDetailScreen(
              noteId: id,
              initialNote: args?.initialNote,
            ),
          );
        },
      ),
      // Lane L: the Results tab renders investigation reports and downloads
      // their files — the same class as the gated /portal/lab-results and
      // /portal/diagnostic-results screens.
      GoRoute(
        path: '/investigations',
        builder: (context, state) => _biometricGated(
          '/investigations',
          (_) => const InvestigationsScreen(),
        ),
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
      // Lane L: the History tab reads /health/patient/:id/vitals — clinical
      // measurements from the same record the gated Health Summary shows.
      GoRoute(
        path: '/vitals',
        builder: (context, state) =>
            _biometricGated('/vitals', (_) => const VitalsScreen()),
      ),
      // Lane L: RefillScreen calls the IDENTICAL endpoint as the gated
      // Prescriptions tab (/prescriptions/patient/my) and renders the full
      // prescription list. This was the plainest hole in the lock.
      GoRoute(
        path: '/refill',
        builder: (context, state) =>
            _biometricGated('/refill', (_) => const RefillScreen()),
      ),
      GoRoute(
        path: '/family',
        builder: (context, state) => const FamilyScreen(),
      ),
      GoRoute(
        path: '/add-dependent',
        builder: (context, state) => const AddDependentScreen(),
      ),
      // Lane L: reminders carry medication name + dosage. Safe to gate: the
      // local notification reschedule that makes reminders actually fire runs
      // at cold start in main.dart, not from this screen, so an un-unlocked
      // gate cannot silence a medication reminder.
      GoRoute(
        path: '/reminders',
        builder: (context, state) => _biometricGated(
          '/reminders',
          (_) => const MedicationRemindersScreen(),
        ),
      ),
      GoRoute(path: '/abdm', builder: (context, state) => const AbdmScreen()),
      GoRoute(
        path: '/health-points',
        builder: (context, state) => const HealthPointsScreen(),
      ),
      GoRoute(
        path: '/period-tracker',
        builder: (context, state) {
          final extra = state.extra;
          final warmEligible =
              extra is Map<String, dynamic> && extra['eligible'] == true;
          return PeriodTrackerDeepLinkRoute(warmEligible: warmEligible);
        },
      ),
      GoRoute(path: '/records', redirect: (_, _) => '/health'),

      // Alternative route names for backward compatibility
      GoRoute(path: '/your-health', redirect: (_, _) => '/health'),
      GoRoute(path: '/dashboard', redirect: (_, _) => '/home'),
    ],

    // Error page
    errorBuilder: (context, state) {
      final l10n = AppLocalizations.of(context)!;
      return Scaffold(
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
              Text(l10n.navigationPageNotFound(state.matchedLocation)),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: () => context.go('/home'),
                child: Text(l10n.navigationGoHome),
              ),
            ],
          ),
        ),
      );
    },
  );
}
