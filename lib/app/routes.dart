// lib/app/routes.dart - Updated to handle dynamic arguments

import 'package:flutter/material.dart';

// ── Screens ──────────────────────────────────────────────
import 'package:vhhealth/features/splash/screens/splash_screen.dart';
import 'package:vhhealth/features/auth/screens/login_screen.dart';
import 'package:vhhealth/features/auth/screens/terms_disclaimer_screen.dart';
import 'package:vhhealth/features/profile/screens/profile_setup_screen.dart';
import 'package:vhhealth/features/your_health/screens/your_health_screen.dart';
import 'package:vhhealth/features/appointments/screens/appointments_screen.dart';
import 'package:vhhealth/features/pharmacy/screens/pharmacy_screen.dart';
import 'package:vhhealth/features/investigations/screens/investigations_screen.dart';
import 'package:vhhealth/features/feedback/screens/ask_a_doubt_screen.dart';
import 'package:vhhealth/features/trivia/screens/trivia_screen.dart';
import 'package:vhhealth/features/departments/screens/departments_screen.dart';
import 'package:vhhealth/features/about/screens/about_us_screen.dart';

// ── Bottom Navigation ────────────────────────────────────
import 'package:vhhealth/core/widgets/bottom_nav.dart';

/// Central route map for the app.
final Map<String, WidgetBuilder> appRoutes = {
  // ── Entry point ─────────────────────────────────────────
  '/': (_) => const SplashScreen(),

  // ── Auth ────────────────────────────────────────────────
  '/auth/login': (_) => const LoginScreen(),
  '/login': (_) => const LoginScreen(), // ✅ compatibility
  '/auth/terms': (_) => const TermsDisclaimerScreen(),

  // ── Profile ─────────────────────────────────────────────
  '/profile/setup': (context) {
    final args = ModalRoute.of(context)!.settings.arguments as Map<String, String>;
    return ProfileSetupScreen(phone: args['phone']!);
  },

  // ── Dashboard + Tabs ────────────────────────────────────
  '/dashboard': (context) {
    final args = ModalRoute.of(context)!.settings.arguments as Map<String, String>?;
    return BottomTabNavigator(
      phone: args?['phone'] ?? '',
      name: args?['name'] ?? 'Guest',
    );
  },

  // ── Features ────────────────────────────────────────────
  '/your-health': (context) {
    final args = ModalRoute.of(context)!.settings.arguments as Map<String, dynamic>;
    return YourHealthScreen(phone: args['phone'] as String);
  },
  '/appointments': (context) {
    final args = ModalRoute.of(context)!.settings.arguments as Map<String, dynamic>;
    return AppointmentsScreen(phone: args['phone'] as String);
  },
  '/pharmacy': (context) {
    final args = ModalRoute.of(context)!.settings.arguments as Map<String, dynamic>;
    return PharmacyScreen(phone: args['phone'] as String);
  },
  '/investigations': (context) {
    final args = ModalRoute.of(context)!.settings.arguments as Map<String, dynamic>;
    return InvestigationsScreen(phone: args['phone'] as String);
  },
  '/ask-a-doubt': (context) {
    final args = ModalRoute.of(context)!.settings.arguments as Map<String, dynamic>;
    return AskADoubtScreen(phone: args['phone'] as String);
  },
  '/trivia': (_) => const TriviaScreen(),
  '/departments': (context) {
    final args = ModalRoute.of(context)!.settings.arguments as Map<String, dynamic>;
    return DepartmentsScreen(
      phone: args['phone'] as String,
      name: args['name'] as String? ?? 'Guest',
    );
  },

  // ── Info ────────────────────────────────────────────────
  '/about-us': (_) => const AboutUsScreen(),
};