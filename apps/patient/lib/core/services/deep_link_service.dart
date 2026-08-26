import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/utils/log_sanitizer.dart';

/// Maps bounded external inputs to GoRouter paths for deep linking.
class DeepLinkService {
  DeepLinkService._();

  static const customScheme = 'vhhealth';
  static const customHost = 'app';

  /// Allowlist of routes that a push notification payload or a
  /// `vhhealth://app/…` link is permitted to navigate to. Arbitrary paths from
  /// untrusted payloads are rejected (PAT-4).
  ///
  /// ── HOW THIS SET IS DERIVED ──────────────────────────────────────────────
  ///
  /// It is not a hand-picked list of "routes we happen to notify about". It is
  /// a PARTITION of `app_router.dart`'s route table: every `GoRoute` path in
  /// that file is either here (exact or as a parameterised prefix below) or in
  /// [unreachableByLinkRoutes] with the reason it cannot be one. That is
  /// enforced by `deep_link_route_table_test.dart`, which parses the router
  /// source — so a route added to the app can no longer be silently missing
  /// from this file. Two portal routes (`/portal/discharge-summaries` and its
  /// detail) and one detail prefix (`/portal/diagnostic-results/:id`) were
  /// exactly that: real screens a link dead-ended on.
  ///
  /// The inclusion rule is mechanical: a route belongs here when it renders
  /// its intended screen from the URL alone or hydrates its guarded resource
  /// from a stable path identifier. Session-setup routes and redirect aliases
  /// cannot, and are dispositioned in [unreachableByLinkRoutes].
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
    '/add-dependent',
    '/refill',
    '/profile-edit',
    '/settings',
    '/settings/record-access',
    '/portal/bills',
    '/portal/lab-orders',
    '/portal/lab-results',
    '/portal/diagnostic-results',
    '/portal/discharge-summaries',
    '/portal/referrals',
    '/portal/tpa/claims',
    '/portal/messages',
    '/portal/maternity/timeline',
    '/abdm',
    '/health-points',
    '/period-tracker',
    '/chatbot',
    '/departments',
    '/about-us',
    '/trivia',
  };

  /// Parameterised route prefixes whose single path segment after the prefix
  /// must be a non-negative integer (portal/record detail screens).
  static const _numericIdPrefixes = <String>[
    '/portal/bills/',
    '/portal/lab-results/',
    '/portal/discharge-summaries/',
    '/portal/tpa/claims/',
    '/portal/messages/',
    '/health/explanations/',
    '/health/consultation-notes/',
  ];

  /// Parameterised route prefixes whose single path segment after the prefix
  /// must be a canonical v1–v5 UUID. `/portal/diagnostic-results/:id` is keyed
  /// by UUID, not by an integer, so it cannot ride [_numericIdPrefixes]; the
  /// pattern below is the same one `app_router.dart` redirects on.
  static const _uuidIdPrefixes = <String>['/portal/diagnostic-results/'];

  /// Parameterised routes where the positive numeric identifier is not always
  /// the final segment. These routes hydrate their authoritative resource from
  /// the path after authentication; `state.extra` is only a warm in-process
  /// optimization.
  static const _appointmentHydrationRouteTemplates = <String>{
    '/appointments/:id',
    '/teleconsult/appointments/:appointmentId/lobby',
    '/teleconsult/appointments/:appointmentId/consult',
  };

  static final _appointmentHydrationPatterns = <RegExp>[
    RegExp(r'^/appointments/([1-9][0-9]*)$'),
    RegExp(r'^/teleconsult/appointments/([1-9][0-9]*)/(?:lobby|consult)$'),
  ];

  static final RegExp _numericIdPattern = RegExp(r'^[0-9]+$');

  static final RegExp _uuidPattern = RegExp(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}'
    r'-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
  );

  /// Router paths that deliberately are NOT link destinations, each with the
  /// reason. Consumed only by `deep_link_route_table_test.dart`, which asserts
  /// this map plus the allowlist covers the router's table exactly.
  ///
  /// A route listed here is not merely "not notified about" — it is one a link
  /// cannot usefully reach. Two reasons occur:
  ///   * session-setup — driven by the auth state machine, never a
  ///     notification target; `_safeReturnTo` in app_router.dart independently
  ///     refuses to return to them.
  ///   * alias — a bare redirect whose target is already allowlisted.
  @visibleForTesting
  static const unreachableByLinkRoutes = <String, String>{
    '/': 'session-setup — the splash is where the startup gates are surfaced',
    '/login': 'session-setup — auth entry point',
    '/terms': 'session-setup — pre-login disclaimer',
    '/profile-setup': 'session-setup — takes the phone via state.extra',
    '/records': 'alias — redirects to /health',
    '/your-health': 'alias — redirects to /health',
    '/dashboard': 'alias — redirects to /home',
  };

  @visibleForTesting
  static Set<String> get debugAllowedRoutes =>
      Set<String>.unmodifiable(_allowedRoutes);

  @visibleForTesting
  static List<String> get debugNumericIdPrefixes =>
      List<String>.unmodifiable(_numericIdPrefixes);

  @visibleForTesting
  static List<String> get debugUuidIdPrefixes =>
      List<String>.unmodifiable(_uuidIdPrefixes);

  @visibleForTesting
  static Set<String> get debugAppointmentHydrationRouteTemplates =>
      Set<String>.unmodifiable(_appointmentHydrationRouteTemplates);

  /// Returns true if [route] is on the allowlist (exact or parameterised).
  static bool _isAllowed(String route) {
    // Exact match
    if (_allowedRoutes.contains(route)) return true;

    for (final pattern in _appointmentHydrationPatterns) {
      final match = pattern.firstMatch(route);
      if (match != null) {
        return int.tryParse(match.group(1)!) != null;
      }
    }

    // Numeric-ID parameterised routes: /portal/bills/123 etc.
    for (final prefix in _numericIdPrefixes) {
      if (route.startsWith(prefix)) {
        final tail = route.substring(prefix.length);
        // Must be a single non-negative integer segment with no further path.
        return _numericIdPattern.hasMatch(tail) && int.tryParse(tail) != null;
      }
    }

    // UUID-keyed parameterised routes: /portal/diagnostic-results/<uuid>.
    for (final prefix in _uuidIdPrefixes) {
      if (route.startsWith(prefix)) {
        return _uuidPattern.hasMatch(route.substring(prefix.length));
      }
    }

    return false;
  }

  /// Normalizes the only locally-owned mobile deep-link shape:
  /// `vhhealth://app/<allowlisted-route>`.
  ///
  /// Custom schemes do not prove domain ownership, so they never carry
  /// credentials or arbitrary return targets. HTTPS universal/app links stay
  /// disabled until the external association files and domain ownership are
  /// independently approved.
  static String? parseExternalRoute(String? raw) {
    if (raw == null || raw.isEmpty || raw.trim() != raw) return null;
    final uri = Uri.tryParse(raw);
    if (uri == null ||
        uri.scheme != customScheme ||
        uri.authority != customHost ||
        uri.hasQuery ||
        uri.hasFragment ||
        !uri.path.startsWith('/') ||
        uri.path.startsWith('//')) {
      return null;
    }
    return _isAllowed(uri.path) ? uri.path : null;
  }

  /// Parse a push notification data payload and return a GoRouter path.
  /// Returns null if the payload doesn't contain a navigable route.
  static String? parseNotificationRoute(Map<String, dynamic> data) {
    // Check for explicit route in payload — must start with '/' AND be on
    // the allowlist. Arbitrary paths are rejected to prevent open redirect
    // attacks via crafted push notifications (audit finding PAT-4).
    final rawRoute = data['route'];
    final route = rawRoute is String ? rawRoute : null;
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
    final rawType = data['type'];
    final type = rawType is String ? rawType.toUpperCase() : null;
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
      case 'LAB_RESULT_CORRECTED':
      case 'RESULTS_READY':
        return '/portal/lab-results';
      case 'DIAGNOSTIC_RESULT_READY':
        return '/portal/diagnostic-results';
      case 'REFERRAL_RESPONSE_READY':
      case 'REFERRAL_UPDATE':
        return '/portal/referrals';
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
      case 'PATIENT_MESSAGE':
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
        return '/reminders';
      default:
        if (kDebugMode) debugPrint('DeepLinkService: unknown type: $type');
        return null;
    }
  }
}
