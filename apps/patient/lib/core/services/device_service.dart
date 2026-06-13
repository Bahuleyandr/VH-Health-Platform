import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:vhhealth/core/services/api_client.dart';

/// Device management API calls.
class DeviceService {
  DeviceService._();

  static final _storage = VHSecureStorage.instance;
  static const _uuid = Uuid();

  /// A unique device ID stored in secure storage. Uses UUID v4.
  static Future<String> _getDeviceId() async {
    var id = await _storage.read(key: 'device_id');
    if (id == null) {
      id = _uuid.v4();
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
    } catch (e) {
      debugPrint('DeviceService.getMyDevices failed: $e');
    }
    return [];
  }

  /// Send a heartbeat/keepalive for this device.
  static Future<bool> heartbeat(String phone) async {
    try {
      final deviceId = await _getDeviceId();
      final response = await ApiClient.post(
        '/devices/heartbeat',
        body: {'phone': phone, 'deviceId': deviceId},
      );
      return response.isSuccess;
    } catch (e) {
      debugPrint('DeviceService.heartbeat failed: $e');
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
        body: {'phone': phone, 'deviceId': deviceId, 'fcmToken': fcmToken},
      );
      return response.isSuccess;
    } catch (e) {
      debugPrint('DeviceService.updateFcmToken failed: $e');
      return false;
    }
  }

  /// Unregister this device (call on logout).
  static Future<bool> unregisterDevice(String phone) async {
    try {
      final deviceId = await _getDeviceId();
      final response = await ApiClient.post(
        '/devices/unregister',
        body: {'phone': phone, 'deviceId': deviceId},
      );
      return response.isSuccess;
    } catch (e) {
      debugPrint('DeviceService.unregisterDevice error: $e');
      return false;
    }
  }
}
