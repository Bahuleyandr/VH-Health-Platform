import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:vhhealth/core/config/api_config.dart';

/// Device management API calls.
class DeviceService {
  DeviceService._();

  static const _storage = FlutterSecureStorage();

  /// A simple device ID derived from stored value or generated once.
  static Future<String> _getDeviceId() async {
    var id = await _storage.read(key: 'device_id');
    if (id == null) {
      id = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
      await _storage.write(key: 'device_id', value: id);
    }
    return id;
  }

  static String get _platform {
    if (kIsWeb) return 'web';
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    return 'unknown';
  }

  /// Register or update this device on the backend.
  static Future<bool> registerDevice({
    required String phone,
    required String fcmToken,
  }) async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final deviceId = await _getDeviceId();
      final response = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/devices/register'),
        headers: headers,
        body: jsonEncode({
          'phone': phone,
          'fcmToken': fcmToken,
          'deviceId': deviceId,
          'deviceName': '$_platform-device',
          'platform': _platform,
        }),
      );
      return response.statusCode == 200 || response.statusCode == 201;
    } catch (e) {
      debugPrint('DeviceService.registerDevice error: $e');
      return false;
    }
  }

  /// List user's registered devices.
  static Future<List<dynamic>> getMyDevices() async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final response = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/devices/my-devices'),
        headers: headers,
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        return (data['data']?['devices'] ?? []) as List<dynamic>;
      }
    } catch (_) {}
    return [];
  }

  /// Send a heartbeat/keepalive for this device.
  static Future<bool> heartbeat(String phone) async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final deviceId = await _getDeviceId();
      final response = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/devices/heartbeat'),
        headers: headers,
        body: jsonEncode({
          'phone': phone,
          'deviceId': deviceId,
        }),
      );
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Update FCM token on the backend.
  static Future<bool> updateFcmToken({
    required String phone,
    required String fcmToken,
  }) async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final deviceId = await _getDeviceId();
      final response = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/devices/update-token'),
        headers: headers,
        body: jsonEncode({
          'phone': phone,
          'deviceId': deviceId,
          'fcmToken': fcmToken,
        }),
      );
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Unregister this device (call on logout). Uses DELETE method.
  static Future<bool> unregisterDevice(String phone) async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final deviceId = await _getDeviceId();
      final request = http.Request(
        'DELETE',
        Uri.parse('${ApiConfig.baseUrl}/devices/unregister'),
      );
      request.headers.addAll(headers);
      request.body = jsonEncode({
        'phone': phone,
        'deviceId': deviceId,
      });
      final streamed = await request.send();
      return streamed.statusCode == 200;
    } catch (e) {
      debugPrint('DeviceService.unregisterDevice error: $e');
      return false;
    }
  }
}
