import 'package:flutter/foundation.dart';

/// Maps push notification data payloads to GoRouter paths for deep linking.
class DeepLinkService {
  DeepLinkService._();

  /// Parse a push notification data payload and return a GoRouter path.
  /// Returns null if the payload doesn't contain a navigable route.
  static String? parseNotificationRoute(Map<String, dynamic> data) {
    // Check for explicit route in payload
    final route = data['route'] as String?;
    if (route != null && route.startsWith('/')) return route;

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
      case 'INVESTIGATION_BOOKING':
        return '/investigations';
      case 'PRESCRIPTION':
      case 'PRESCRIPTION_READY':
        return '/health';
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
