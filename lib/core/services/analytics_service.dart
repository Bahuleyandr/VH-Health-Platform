import 'package:firebase_analytics/firebase_analytics.dart';
import 'package:flutter/foundation.dart';

/// Centralized analytics tracking for patient app events.
///
/// Usage: `AnalyticsService.trackAppointmentBooked(department: 'Cardiology');`
class AnalyticsService {
  AnalyticsService._();

  static final _analytics = FirebaseAnalytics.instance;

  /// Get the observer for GoRouter navigation tracking.
  static FirebaseAnalyticsObserver get observer =>
      FirebaseAnalyticsObserver(analytics: _analytics);

  /// Track screen views.
  static Future<void> trackScreenView(String screenName) async {
    try {
      await _analytics.logScreenView(screenName: screenName);
    } catch (e) {
      if (kDebugMode) debugPrint('Analytics: screen view error: $e');
    }
  }

  // ── Patient Feature Events ─────────────────────────────────────────────

  static Future<void> trackAppointmentBooked({String? department}) async {
    await _logEvent('appointment_booked', {'department': department});
  }

  static Future<void> trackAppointmentCancelled() async {
    await _logEvent('appointment_cancelled');
  }

  static Future<void> trackPharmacyOrderPlaced({String? deliveryType}) async {
    await _logEvent('pharmacy_order_placed', {'delivery_type': deliveryType});
  }

  static Future<void> trackInvestigationBooked({String? testName}) async {
    await _logEvent('investigation_booked', {'test_name': testName});
  }

  static Future<void> trackPrescriptionRefillRequested() async {
    await _logEvent('prescription_refill_requested');
  }

  static Future<void> trackVitalsRecorded() async {
    await _logEvent('vitals_recorded');
  }

  static Future<void> trackSosTriggered({String? emergencyType}) async {
    await _logEvent('sos_triggered', {'emergency_type': emergencyType});
  }

  static Future<void> trackFeedbackSubmitted({int? rating}) async {
    await _logEvent('feedback_submitted', {'rating': rating});
  }

  static Future<void> trackStepSessionCompleted({int? steps, double? distanceKm}) async {
    await _logEvent('step_session_completed', {
      'steps': steps,
      'distance_km': distanceKm,
    });
  }

  static Future<void> trackDocumentViewed({String? documentType}) async {
    await _logEvent('document_viewed', {'document_type': documentType});
  }

  static Future<void> trackFeatureAccessed(String featureName) async {
    await _logEvent('feature_accessed', {'feature': featureName});
  }

  // ── Helper ──────────────────────────────────────────────────────────────

  static Future<void> _logEvent(String name, [Map<String, Object?>? params]) async {
    try {
      await _analytics.logEvent(
        name: name,
        parameters: params,
      );
    } catch (e) {
      if (kDebugMode) debugPrint('Analytics: $name error: $e');
    }
  }
}
