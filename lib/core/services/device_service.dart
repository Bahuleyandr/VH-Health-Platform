import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:vhhealth/core/services/api_client.dart';

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
      final deviceId = await _getDeviceId();
      final response = await ApiClient.post(
        '/devices/register',
        body: {
          'phone': phone,
          'fcmToken': fcmToken,
          'deviceId': deviceId,
          'deviceName': '$_platform-device',
          'platform': _platform,
        },
      );
      return response.isSuccess;
    } catch (e) {
      debugPrint('DeviceService.registerDevice error: $e');
      return false;
    }
  }

  /// List user's registered devices.
  static Future<List<dynamic>> getMyDevices() async {
    try {
      final response = await ApiClient.get('/devices/my-devices');
      if (response.isSuccess) {
        return response.dataAsList('devices');
      }
    } catch (_) {}
    return [];
  }

  /// Send a heartbeat/keepalive for this device.
  static Future<bool> heartbeat(String phone) async {
    try {
      final deviceId = await _getDeviceId();
      final response = await ApiClient.post(
        '/devices/heartbeat',
        body: {
          'phone': phone,
          'deviceId': deviceId,
        },
      );
      return response.isSuccess;
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
      final deviceId = await _getDeviceId();
      final response = await ApiClient.post(
        '/devices/update-token',
        body: {
          'phone': phone,
          'deviceId': deviceId,
          'fcmToken': fcmToken,
        },
      );
      return response.isSuccess;
    } catch (_) {
      return false;
    }
  }

  /// Unregister this device (call on logout). Uses DELETE method.
  static Future<bool> unregisterDevice(String phone) async {
    try {
      final response = await ApiClient.delete('/devices/unregister');
      return response.isSuccess;
    } catch (e) {
      debugPrint('DeviceService.unregisterDevice error: $e');
      return false;
    }
  }
}
