import 'package:vhhealth/core/services/api_client.dart';

/// Backend API calls for SOS features.
class SosApiService {
  SosApiService._();

  /// Trigger SOS alert on the backend.
  static Future<Map<String, dynamic>?> triggerAlert({
    required String phone,
    double? latitude,
    double? longitude,
    String emergencyType = 'medical',
    String? severity,
  }) async {
    try {
      final response = await ApiClient.post(
        '/sos/',
        body: {
          'phone': phone,
          if (latitude != null) 'latitude': latitude,
          if (longitude != null) 'longitude': longitude,
          'emergencyType': emergencyType,
          if (severity != null) 'severity': severity,
        },
      );
      if (response.isSuccess) {
        return response.raw as Map<String, dynamic>;
      }
    } catch (_) {}
    return null;
  }

  /// Get the user's emergency contact.
  static Future<Map<String, dynamic>?> getEmergencyContact() async {
    try {
      final response = await ApiClient.get('/sos/emergency-contact');
      if (response.isSuccess) {
        return response.raw as Map<String, dynamic>;
      }
    } catch (_) {}
    return null;
  }

  /// Cancel an active SOS alert.
  static Future<bool> cancelAlert(String alertId) async {
    try {
      final response = await ApiClient.post('/sos/cancel/$alertId');
      return response.isSuccess;
    } catch (_) {
      return false;
    }
  }

  /// Fetch the user's SOS alert history.
  static Future<List<dynamic>> getMyAlerts() async {
    try {
      final response = await ApiClient.get('/sos/my-alerts');
      if (response.isSuccess) {
        return response.dataAsList('alerts');
      }
    } catch (_) {}
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
    } catch (_) {}
    return [];
  }

  /// Get medical info for first responders.
  static Future<Map<String, dynamic>?> getMedicalInfo() async {
    try {
      final response = await ApiClient.get('/sos/medical-info');
      if (response.isSuccess) {
        return response.raw as Map<String, dynamic>;
      }
    } catch (_) {}
    return null;
  }
}
