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
import 'package:vhhealth/features/dashboard/screens/dashboard_screen.dart';
import 'package:vhhealth/features/your_health/screens/your_health_screen.dart';
import 'package:vhhealth/features/notifications/screens/notifications_screen.dart';
import 'package:vhhealth/features/settings/screens/settings_screen.dart';
import 'package:vhhealth/features/appointments/screens/appointments_screen.dart';
import 'package:vhhealth/features/pharmacy/screens/pharmacy_screen.dart';
import 'package:vhhealth/features/investigations/screens/investigations_screen.dart';
import 'package:vhhealth/features/feedback/screens/ask_a_doubt_screen.dart';
import 'package:vhhealth/features/trivia/screens/trivia_screen.dart';
import 'package:vhhealth/features/departments/screens/departments_screen.dart';
import 'package:vhhealth/features/about/screens/about_us_screen.dart';
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
  
  static final router = GoRouter(
    navigatorKey: _rootNavigatorKey,
    initialLocation: '/',
    debugLogDiagnostics: true,
    
    // Handle auth redirects
    redirect: (context, state) async {
      final isLoggedIn = FirebaseAuth.instance.currentUser != null;
      final isAuthRoute = state.matchedLocation == '/login' || 
                         state.matchedLocation == '/terms' ||
                         state.matchedLocation == '/';
      
      // If not logged in and not on auth route, redirect to login
      if (!isLoggedIn && !isAuthRoute) {
        return '/login';
      }
      
      // If logged in and on login, redirect to dashboard
      if (isLoggedIn && state.matchedLocation == '/login') {
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
        builder: (context, state) => const TermsDisclaimerScreen(),
      ),
      GoRoute(
        path: '/profile-setup',
        builder: (context, state) {
          final phone = state.extra as String? ?? '';
          return ProfileSetupScreen(phone: phone);
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
        builder: (context, state) => AppointmentsScreen(
          phone: _userPhone ?? '',
        ),
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
        path: '/ask-a-doubt',
        builder: (context, state) => AskADoubtScreen(
          phone: _userPhone ?? '',
        ),
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