// lib/core/navigation/app_router.dart
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/session_timeout_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';

// Import all your screens
import 'package:vhhealth/features/splash/screens/splash_screen.dart';
import 'package:vhhealth/features/auth/screens/login_screen.dart';
import 'package:vhhealth/features/auth/screens/terms_disclaimer_screen.dart';
import 'package:vhhealth/features/profile/screens/profile_setup_screen.dart';
import 'package:vhhealth/features/profile/screens/profile_edit_screen.dart';
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
import 'package:vhhealth/features/abdm/screens/abdm_screen.dart';
import 'package:vhhealth/core/widgets/main_scaffold_go_router.dart';

class AppRouter {
  static final _rootNavigatorKey = GlobalKey<NavigatorState>();
  static final _shellNavigatorKey = GlobalKey<NavigatorState>();

  // Legacy static cache — kept for redirect (which has no Provider context).
  // Route builders should prefer context.read<UserProvider>() instead.
  static String? _userPhone;
  static String? _userName;

  static void setUserData(String phone, String name) {
    _userPhone = phone;
    _userName = name;
  }

  static void clearUserData() {
    _userPhone = null;
    _userName = null;
  }

  static String? get userPhone => _userPhone;
  static String? get userName => _userName;

  /// Read user phone from Provider (preferred) with static fallback.
  static String _phone(BuildContext context) {
    try {
      return context.read<UserProvider>().phone;
    } catch (e) {
      debugPrint('AppRouter._phone provider fallback: $e');
      return _userPhone ?? '';
    }
  }

  /// Read user name from Provider (preferred) with static fallback.
  static String _name(BuildContext context) {
    try {
      return context.read<UserProvider>().name;
    } catch (e) {
      debugPrint('AppRouter._name provider fallback: $e');
      return _userName ?? 'Guest';
    }
  }

  static final router = GoRouter(
    navigatorKey: _rootNavigatorKey,
    initialLocation: '/',
    debugLogDiagnostics: true,

    // Handle auth redirects
    redirect: (context, state) async {
      final currentUser = FirebaseAuth.instance.currentUser;
      final isLoggedIn = currentUser != null;
      final location = state.matchedLocation;

      // Skip redirect on splash screen to let it handle navigation
      if (location == '/') {
        return null;
      }

      final isAuthRoute = location == '/login' ||
                         location == '/terms' ||
                         location == '/profile-setup';

      // Session idle timeout — force logout if expired
      try {
        final sessionProvider = Provider.of<SessionTimeoutProvider>(
          context,
          listen: false,
        );
        if (sessionProvider.isSessionExpired && !isAuthRoute) {
          return '/login';
        }
      } catch (_) {
        // Provider may not be available during initial build
      }

      // If not logged in and not on auth route, redirect to login
      if (!isLoggedIn && !isAuthRoute) {
        return '/login';
      }

      // If logged in and on login, load user data and redirect to home
      if (isLoggedIn && location == '/login') {
        // Start idle timer now that we know the user is authenticated
        try {
          Provider.of<SessionTimeoutProvider>(context, listen: false)
              .startTracking();
        } catch (e) { debugPrint('Router: $e'); }

        // Load user data from secure storage if not already loaded
        if (_userPhone == null || _userName == null) {
          const storage = FlutterSecureStorage();
          final phone = await storage.read(key: 'user_phone') ?? '';
          final name = await storage.read(key: 'user_name') ?? 'User';
          if (phone.isNotEmpty) {
            setUserData(phone, name);
            // Sync to UserProvider if available
            try {
              // ignore: use_build_context_synchronously
              context.read<UserProvider>().setUser(phone, name);
            } catch (e) {
              debugPrint('AppRouter sync UserProvider failed: $e');
            }
          }
        }
        return '/home';
      }

      // User is logged in and on a protected page — ensure timer is running
      if (isLoggedIn && !isAuthRoute) {
        try {
          final sp = Provider.of<SessionTimeoutProvider>(context, listen: false);
          if (!sp.isSessionExpired) sp.recordActivity();
        } catch (e) { debugPrint('Router: $e'); }
      }

      return null;
    },

    routes: [
      // Splash screen
      GoRoute(
        path: '/',
        builder: (context, state) => const SplashScreen(),
      ),

      // Auth routes
      GoRoute(
        path: '/login',
        builder: (context, state) => const LoginScreen(),
      ),
      GoRoute(
        path: '/terms',
        builder: (context, state) {
          final extra = state.extra as Map<String, dynamic>?;
          return TermsDisclaimerScreen(
            section: extra?['section'],
          );
        },
      ),
      GoRoute(
        path: '/profile-setup',
        builder: (context, state) {
          final phone = state.extra as String? ?? '';
          return ProfileSetupScreen(phone: phone);
        },
      ),
      GoRoute(
        path: '/profile-edit',
        builder: (context, state) {
          final extra = state.extra as Map<String, dynamic>?;
          return ProfileEditScreen(
            phone: extra?['phone'] ?? _phone(context),
            name: extra?['name'] ?? _name(context),
          );
        },
      ),

      // Main app with bottom navigation
      ShellRoute(
        navigatorKey: _shellNavigatorKey,
        builder: (context, state, child) {
          return MainScaffoldGoRouter(
            phone: _phone(context),
            name: _name(context),
            child: child,
          );
        },
        routes: [
          GoRoute(
            path: '/home',
            pageBuilder: (context, state) => NoTransitionPage(
              child: DashboardScreen(
                phone: _phone(context),
                name: _name(context),
              ),
            ),
          ),
          GoRoute(
            path: '/health',
            pageBuilder: (context, state) {
              final extra = state.extra as Map<String, dynamic>?;
              return NoTransitionPage(
                child: YourHealthScreen(
                  phone: _phone(context),
                  initialTab: extra?['tab'] as int? ?? 0,
                ),
              );
            },
          ),
          GoRoute(
            path: '/notifications',
            pageBuilder: (context, state) => NoTransitionPage(
              child: NotificationsScreen(phone: _phone(context)),
            ),
          ),
          GoRoute(
            path: '/settings',
            pageBuilder: (context, state) => NoTransitionPage(
              child: SettingsScreen(
                phone: _phone(context),
                name: _name(context),
              ),
            ),
          ),
        ],
      ),

      // Feature routes (outside shell for full screen)
      GoRoute(
        path: '/appointments',
        builder: (context, state) {
          final extra = state.extra as Map<String, dynamic>?;
          return AppointmentsScreen(
            phone: extra?['phone'] ?? _phone(context),
          );
        },
      ),
      GoRoute(
        path: '/pharmacy',
        builder: (context, state) => PharmacyScreen(
          phone: _phone(context),
        ),
      ),
      GoRoute(
        path: '/investigations',
        builder: (context, state) => InvestigationsScreen(
          phone: _phone(context),
        ),
      ),
      GoRoute(
        path: '/book-investigation',
        builder: (context, state) => const BookInvestigationScreen(),
      ),
      GoRoute(
        path: '/ask-a-doubt',
        builder: (context, state) => AskADoubtScreen(
          phone: _phone(context),
        ),
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
        builder: (context, state) => DepartmentsScreen(
          phone: _phone(context),
          name: _name(context),
        ),
      ),
      GoRoute(
        path: '/about-us',
        builder: (context, state) => const AboutUsScreen(),
      ),
      GoRoute(
        path: '/calendar',
        builder: (context, state) => CalendarScreen(
          uid: _phone(context),
        ),
      ),
      GoRoute(
        path: '/steps',
        builder: (context, state) => const StepChallengeScreen(),
      ),
      GoRoute(
        path: '/vitals',
        builder: (context, state) => VitalsScreen(
          phone: _phone(context),
        ),
      ),
      GoRoute(
        path: '/refill',
        builder: (context, state) => RefillScreen(
          phone: _phone(context),
        ),
      ),
      GoRoute(
        path: '/family',
        builder: (context, state) => FamilyScreen(
          phone: _phone(context),
        ),
      ),
      GoRoute(
        path: '/abdm',
        builder: (context, state) => const AbdmScreen(),
      ),
      GoRoute(
        path: '/records',
        redirect: (_, _) => '/health',
      ),

      // Alternative route names for backward compatibility
      GoRoute(
        path: '/your-health',
        redirect: (_, _) => '/health',
      ),
      GoRoute(
        path: '/dashboard',
        redirect: (_, _) => '/home',
      ),
    ],

    // Error page
    errorBuilder: (context, state) => Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 64, color: Colors.red),
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
