// lib/core/navigation/app_router.dart
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

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
import 'package:vhhealth/features/records/screens/records_screen.dart';
import 'package:vhhealth/features/pharmacy/screens/pharmacy_screen.dart';
import 'package:vhhealth/features/investigations/screens/investigations_screen.dart';
import 'package:vhhealth/features/investigations/screens/book_investigation_screen.dart';
import 'package:vhhealth/features/feedback/screens/ask_a_doubt_screen.dart';
import 'package:vhhealth/features/feedback/screens/feedback_history_screen.dart';
import 'package:vhhealth/features/trivia/screens/trivia_screen.dart';
import 'package:vhhealth/features/departments/screens/departments_screen.dart';
import 'package:vhhealth/features/about/screens/about_us_screen.dart';
import 'package:vhhealth/features/calendar/screens/calendar_screen.dart';
import 'package:vhhealth/core/widgets/main_scaffold_go_router.dart';

class AppRouter {
  static final _rootNavigatorKey = GlobalKey<NavigatorState>();
  static final _shellNavigatorKey = GlobalKey<NavigatorState>();
  
  // Store user data
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
      
      // If not logged in and not on auth route, redirect to login
      if (!isLoggedIn && !isAuthRoute) {
        return '/login';
      }
      
      // If logged in and on login, load user data and redirect to home
      if (isLoggedIn && location == '/login') {
        // Load user data from secure storage if not already loaded
        if (_userPhone == null || _userName == null) {
          const storage = FlutterSecureStorage();
          final phone = await storage.read(key: 'user_phone') ?? '';
          final name = await storage.read(key: 'user_name') ?? 'User';
          if (phone.isNotEmpty) {
            setUserData(phone, name);
          }
        }
        return '/home';
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
            phone: extra?['phone'] ?? _userPhone ?? '',
            name: extra?['name'] ?? _userName ?? 'User',
          );
        },
      ),
      
      // Main app with bottom navigation
      ShellRoute(
        navigatorKey: _shellNavigatorKey,
        builder: (context, state, child) {
          return MainScaffoldGoRouter(
            child: child,
            phone: _userPhone ?? '',
            name: _userName ?? 'Guest',
          );
        },
        routes: [
          GoRoute(
            path: '/home',
            pageBuilder: (context, state) => NoTransitionPage(
              child: DashboardScreen(
                phone: _userPhone ?? '',
                name: _userName ?? 'Guest',
              ),
            ),
          ),
          GoRoute(
            path: '/health',
            pageBuilder: (context, state) => NoTransitionPage(
              child: YourHealthScreen(phone: _userPhone ?? ''),
            ),
          ),
          GoRoute(
            path: '/notifications',
            pageBuilder: (context, state) => NoTransitionPage(
              child: NotificationsScreen(phone: _userPhone ?? ''),
            ),
          ),
          GoRoute(
            path: '/settings',
            pageBuilder: (context, state) => NoTransitionPage(
              child: SettingsScreen(
                phone: _userPhone ?? '',
                name: _userName ?? 'Guest',
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
            phone: extra?['phone'] ?? _userPhone ?? '',
          );
        },
      ),
      GoRoute(
        path: '/pharmacy',
        builder: (context, state) => PharmacyScreen(
          phone: _userPhone ?? '',
        ),
      ),
      GoRoute(
        path: '/investigations',
        builder: (context, state) => InvestigationsScreen(
          phone: _userPhone ?? '',
        ),
      ),
      GoRoute(
        path: '/book-investigation',
        builder: (context, state) => const BookInvestigationScreen(),
      ),
      GoRoute(
        path: '/ask-a-doubt',
        builder: (context, state) => AskADoubtScreen(
          phone: _userPhone ?? '',
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
          phone: _userPhone ?? '',
          name: _userName ?? 'Guest',
        ),
      ),
      GoRoute(
        path: '/about-us',
        builder: (context, state) => const AboutUsScreen(),
      ),
      GoRoute(
        path: '/calendar',
        builder: (context, state) => CalendarScreen(
          uid: _userPhone ?? '',
        ),
      ),
      GoRoute(
        path: '/records',
        builder: (context, state) => const RecordsScreen(),
      ),
      
      // Alternative route names for backward compatibility
      GoRoute(
        path: '/your-health',
        redirect: (_, __) => '/health',
      ),
      GoRoute(
        path: '/dashboard',
        redirect: (_, __) => '/home',
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