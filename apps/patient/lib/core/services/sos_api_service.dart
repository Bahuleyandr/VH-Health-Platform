import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/services/api_client.dart';

/// Backend API calls for SOS features.
///
/// Methods throw on failure so callers can show appropriate error feedback.
/// This is critical — SOS is a life-safety feature and must never fail silently.
class SosApiService {
  SosApiService._();

  /// Trigger SOS alert on the backend.
  /// Returns the response map on success, throws on failure.
  static Future<Map<String, dynamic>> triggerAlert({
    required String phone,
    double? latitude,
    double? longitude,
    String emergencyType = 'medical',
    String? severity,
  }) async {
    final response = await ApiClient.post(
      '/sos/',
      body: {
        'phone': phone,
        'latitude': ?latitude,
        'longitude': ?longitude,
        'emergencyType': emergencyType,
        'severity': ?severity,
      },
    );
    if (response.isSuccess) {
      return response.raw as Map<String, dynamic>;
    }
    throw SosException(
      response.failureMessage(
        'Failed to send SOS alert (${response.statusCode})',
      ),
    );
  }

  /// Get the user's emergency contact.
  /// Returns null if not configured, throws on network/server errors.
  static Future<Map<String, dynamic>?> getEmergencyContact() async {
    try {
      final response = await ApiClient.get('/sos/emergency-contact');
      if (response.isSuccess) {
        return response.raw as Map<String, dynamic>;
      }
      if (response.statusCode == 404) return null;
      throw SosException(
        response.failureMessage('Failed to fetch emergency contact'),
      );
    } catch (e) {
      if (e is SosException) rethrow;
      if (kDebugMode) debugPrint('SOS getEmergencyContact error: $e');
      return null; // Network failures are non-critical for this call
    }
  }

  /// Cancel an active SOS alert. Throws on failure.
  static Future<void> cancelAlert(String alertId) async {
    final response = await ApiClient.post('/sos/cancel/$alertId');
    if (!response.isSuccess) {
      throw SosException(response.failureMessage('Failed to cancel SOS alert'));
    }
  }

  /// Fetch the user's SOS alert history.
  static Future<List<dynamic>> getMyAlerts() async {
    try {
      final response = await ApiClient.get('/sos/my-alerts');
      if (response.isSuccess) {
        return response.dataAsList('alerts');
      }
    } catch (e) {
      if (kDebugMode) debugPrint('SOS getMyAlerts error: $e');
    }
    return [];
  }

  /// Fetch nearby emergency services.
  static Future<List<dynamic>> getNearbyServices({
    double? latitude,
    double? longitude,
  }) async {
    try {
      final params = <String, String>{};
      if (latitude != null) params['latitude'] = latitude.toString();
      if (longitude != null) params['longitude'] = longitude.toString();
      final response = await ApiClient.get(
        '/sos/nearby-services',
        queryParameters: params.isNotEmpty ? params : null,
      );
      if (response.isSuccess) {
        return response.dataAsList('services');
      }
    } catch (e) {
      if (kDebugMode) debugPrint('SOS getNearbyServices error: $e');
    }
    return [];
  }

  /// Get medical info for first responders.
  static Future<Map<String, dynamic>?> getMedicalInfo() async {
    try {
      final response = await ApiClient.get('/sos/medical-info');
      if (response.isSuccess) {
        return response.raw as Map<String, dynamic>;
      }
    } catch (e) {
      if (kDebugMode) debugPrint('SOS getMedicalInfo error: $e');
    }
    return null;
  }
}

/// Exception thrown when a critical SOS operation fails.
class SosException implements Exception {
  final String message;
  const SosException(this.message);
  @override
  String toString() => message;
}
