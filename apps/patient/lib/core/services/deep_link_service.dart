import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/utils/log_sanitizer.dart';

/// Maps push notification data payloads to GoRouter paths for deep linking.
class DeepLinkService {
  DeepLinkService._();

  /// Allowlist of route prefixes that a push notification payload is permitted
  /// to navigate to. Derived from app_router.dart routes. Arbitrary paths from
  /// untrusted notification payloads are rejected (PAT-4).
  ///
  /// Rules:
  /// - Only exact matches and known parameterised prefixes are listed.
  /// - Dynamic path segments (e.g. `/portal/bills/:id`) are validated by
  ///   [parseNotificationRoute] before the route is returned.
  static const _allowedRoutes = <String>{
    '/home',
    '/appointments',
    '/pharmacy',
    '/investigations',
    '/book-investigation',
    '/health',
    '/notifications',
    '/vitals',
    '/steps',
    '/feedback-history',
    '/ask-a-doubt',
    '/calendar',
    '/reminders',
    '/family',
    '/refill',
    '/portal/bills',
    '/portal/lab-orders',
    '/portal/lab-results',
    '/portal/diagnostic-results',
    '/portal/tpa/claims',
    '/portal/messages',
    '/portal/maternity/timeline',
    '/abdm',
    '/health-points',
    '/chatbot',
    '/departments',
    '/about-us',
    '/trivia',
    '/settings',
  };

  /// Parameterised route prefixes whose first path segment after the prefix
  /// must be a non-negative integer (portal detail screens).
  static const _numericIdPrefixes = <String>[
    '/portal/bills/',
    '/portal/lab-results/',
    '/portal/tpa/claims/',
    '/portal/messages/',
    '/health/explanations/',
    '/health/consultation-notes/',
  ];

  @visibleForTesting
  static Set<String> get debugAllowedRoutes =>
      Set<String>.unmodifiable(_allowedRoutes);

  @visibleForTesting
  static List<String> get debugNumericIdPrefixes =>
      List<String>.unmodifiable(_numericIdPrefixes);

  /// Returns true if [route] is on the allowlist (exact or parameterised).
  static bool _isAllowed(String route) {
    // Exact match
    if (_allowedRoutes.contains(route)) return true;

    // Numeric-ID parameterised routes: /portal/bills/123 etc.
    for (final prefix in _numericIdPrefixes) {
      if (route.startsWith(prefix)) {
        final tail = route.substring(prefix.length);
        // Must be a single non-negative integer segment with no further path.
        final id = int.tryParse(tail);
        return id != null && id >= 0 && !tail.contains('/');
      }
    }

    return false;
  }

  /// Parse a push notification data payload and return a GoRouter path.
  /// Returns null if the payload doesn't contain a navigable route.
  static String? parseNotificationRoute(Map<String, dynamic> data) {
    // Check for explicit route in payload — must start with '/' AND be on
    // the allowlist. Arbitrary paths are rejected to prevent open redirect
    // attacks via crafted push notifications (audit finding PAT-4).
    final route = data['route'] as String?;
    if (route != null && route.startsWith('/')) {
      if (_isAllowed(route)) return route;
      if (kDebugMode) {
        debugPrint(
          'DeepLinkService: rejected non-allowlisted route: ${logSafePath(route)}',
        );
      }
      return null;
    }

    // Infer route from notification type
    final type = (data['type'] as String?)?.toUpperCase();
    switch (type) {
      case 'APPOINTMENT':
      case 'APPOINTMENT_REMINDER':
      case 'APPOINTMENT_CONFIRMED':
      case 'APPOINTMENT_CANCELLED':
        return '/appointments';
      case 'PHARMACY_ORDER':
      case 'PHARMACY_ORDER_UPDATE':
      case 'ORDER_DISPATCHED':
      case 'ORDER_DELIVERED':
        return '/pharmacy';
      case 'INVESTIGATION':
      case 'INVESTIGATION_RESULT':
      case 'INVESTIGATION_RESULT_READY':
      case 'INVESTIGATION_BOOKING':
      case 'COLLECTOR_DISPATCHED':
        return '/investigations';
      case 'LAB_RESULT_READY':
      case 'RESULTS_READY':
        return '/portal/lab-results';
      case 'DIAGNOSTIC_RESULT_READY':
        return '/portal/diagnostic-results';
      case 'PRESCRIPTION':
      case 'PRESCRIPTION_READY':
      case 'DOCUMENT_UPLOADED':
        return '/health';
      case 'BILLING':
      case 'BILL_READY':
      case 'PAYMENT_LINK':
        return '/portal/bills';
      case 'SECURE_MESSAGE':
      case 'MESSAGE':
      case 'PORTAL_MESSAGE':
        return '/portal/messages';
      case 'SOS':
      case 'SOS_ALERT':
        return '/home';
      case 'FEEDBACK':
      case 'FEEDBACK_REPLY':
        return '/feedback-history';
      case 'STEP_REWARD':
      case 'STEP_BADGE':
        return '/steps';
      case 'MEDICATION_REMINDER':
        return '/home';
      default:
        if (kDebugMode) debugPrint('DeepLinkService: unknown type: $type');
        return null;
    }
  }
}
