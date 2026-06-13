// lib/core/navigation/app_router.dart
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/session_timeout_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';

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
import 'package:vhhealth/features/appointments/screens/appointments_screen.dart';
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
import 'package:vhhealth/features/portal/screens/lab_orders_screen.dart';
import 'package:vhhealth/features/portal/screens/lab_results_screen.dart';
import 'package:vhhealth/features/portal/screens/messages_screen.dart';
import 'package:vhhealth/features/portal/screens/message_thread_screen.dart';
import 'package:vhhealth/features/portal/screens/tpa_claims_screen.dart';
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
          final jwt = await const FlutterSecureStorage().read(key: 'jwt');
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
        path: '/pharmacy',
        builder: (context, state) => const PharmacyScreen(),
      ),

      // Patient self-service portal (Sprint 10)
      GoRoute(
        path: '/portal/bills',
        builder: (context, state) => const BillsScreen(),
      ),
      GoRoute(
        path: '/portal/bills/:id',
        builder: (context, state) =>
            BillDetailScreen(invoiceId: int.parse(state.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/portal/lab-results',
        builder: (context, state) => const LabResultsScreen(),
      ),
      GoRoute(
        path: '/portal/lab-orders',
        builder: (context, state) => const LabOrdersScreen(),
      ),
      GoRoute(
        path: '/portal/maternity/timeline',
        builder: (context, state) => const AncTimelineScreen(),
      ),
      GoRoute(
        path: '/portal/tpa/claims',
        builder: (context, state) => const TpaClaimsScreen(),
      ),
      GoRoute(
        path: '/portal/tpa/claims/:id',
        builder: (context, state) => TpaClaimDetailScreen(
          claimId: int.parse(state.pathParameters['id']!),
        ),
      ),
      GoRoute(
        path: '/portal/messages',
        builder: (context, state) => const MessagesScreen(),
      ),
      GoRoute(
        path: '/portal/messages/:id',
        builder: (context, state) => MessageThreadScreen(
          threadId: int.parse(state.pathParameters['id']!),
        ),
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
