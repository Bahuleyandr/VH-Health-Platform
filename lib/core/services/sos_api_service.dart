import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:vhhealth/core/config/api_config.dart';

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
      final headers = await ApiConfig.authenticatedHeaders();
      final body = <String, dynamic>{
        'phone': phone,
        if (latitude != null) 'latitude': latitude,
        if (longitude != null) 'longitude': longitude,
        'emergencyType': emergencyType,
        if (severity != null) 'severity': severity,
      };
      final response = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/sos/'),
        headers: headers,
        body: jsonEncode(body),
      );
      if (response.statusCode == 200 || response.statusCode == 201) {
        return jsonDecode(response.body) as Map<String, dynamic>;
      }
    } catch (_) {}
    return null;
  }

  /// Get the user's emergency contact.
  static Future<Map<String, dynamic>?> getEmergencyContact() async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final response = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/sos/emergency-contact'),
        headers: headers,
      );
      if (response.statusCode == 200) {
        return jsonDecode(response.body) as Map<String, dynamic>;
      }
    } catch (_) {}
    return null;
  }

  /// Cancel an active SOS alert.
  static Future<bool> cancelAlert(String alertId) async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final response = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/sos/cancel/$alertId'),
        headers: headers,
      );
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Fetch the user's SOS alert history.
  static Future<List<dynamic>> getMyAlerts() async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final response = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/sos/my-alerts'),
        headers: headers,
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        return (data['data']?['alerts'] ?? []) as List<dynamic>;
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
      final headers = await ApiConfig.authenticatedHeaders();
      final params = <String, String>{};
      if (latitude != null) params['latitude'] = latitude.toString();
      if (longitude != null) params['longitude'] = longitude.toString();
      final uri = Uri.parse('${ApiConfig.baseUrl}/sos/nearby-services')
          .replace(queryParameters: params.isNotEmpty ? params : null);
      final response = await http.get(uri, headers: headers);
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        return (data['data']?['services'] ?? []) as List<dynamic>;
      }
    } catch (_) {}
    return [];
  }

  /// Get medical info for first responders.
  static Future<Map<String, dynamic>?> getMedicalInfo() async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final response = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/sos/medical-info'),
        headers: headers,
      );
      if (response.statusCode == 200) {
        return jsonDecode(response.body) as Map<String, dynamic>;
      }
    } catch (_) {}
    return null;
  }
}
