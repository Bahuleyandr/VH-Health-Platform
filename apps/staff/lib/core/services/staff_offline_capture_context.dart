import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';
import 'package:vhhealth_core/services/offline_command_codec.dart';
import 'package:vhhealth_core/services/secure_storage.dart';

import '../config/api_config.dart';
import '../platform_info.dart';
import 'auth_service.dart';

typedef StaffFacilityIdResolver = Future<int?> Function();

@immutable
class StaffOfflineCaptureContext {
  const StaffOfflineCaptureContext({
    required this.tenantId,
    required this.facilityId,
    required this.deviceId,
    required this.devicePosture,
    required this.captureSessionId,
    required this.captureActorUuid,
    required this.captureRole,
    required this.appVersion,
  });

  final String tenantId;
  final int facilityId;
  final String deviceId;
  final String devicePosture;
  final String captureSessionId;
  final String captureActorUuid;
  final String captureRole;
  final String appVersion;

  /// Resolves only provisioned capture identity.
  ///
  /// No production [facilityIdResolver] exists in C4.1. Therefore this method
  /// fails closed today. Device-to-facility provisioning is a separate
  /// program slice and must never be replaced with tenant, department, host,
  /// or screen-derived guesses.
  static Future<StaffOfflineCaptureContext> resolve({
    required String appVersion,
    StaffFacilityIdResolver? facilityIdResolver,
    Future<String?> Function()? actorUidResolver,
    Future<String> Function()? roleResolver,
    Future<String?> Function()? deviceIdResolver,
    String Function()? devicePostureResolver,
  }) async {
    final facilityId = await facilityIdResolver?.call();
    if (facilityId == null || facilityId <= 0) {
      throw const StaffOfflineCaptureContextUnavailable(
        'facility_context_unavailable',
      );
    }
    final actorUid = (await (actorUidResolver ?? ApiConfig.getStaffUid)())
        ?.trim();
    final role = (await (roleResolver ?? ApiConfig.getRole)()).trim();
    final deviceId = (await (deviceIdResolver ?? AuthService.getDeviceToken)())
        ?.trim();
    final posture = (devicePostureResolver ?? (() => currentDeviceType))()
        .trim()
        .toLowerCase();
    if (actorUid == null ||
        actorUid.isEmpty ||
        role.isEmpty ||
        deviceId == null ||
        deviceId.isEmpty ||
        posture.isEmpty ||
        appVersion.trim().isEmpty) {
      throw const StaffOfflineCaptureContextUnavailable(
        'capture_context_incomplete',
      );
    }
    final captureSessionId = await _captureSessionId(
      tenantId: TenantConfig.id,
      facilityId: facilityId,
      deviceId: deviceId,
      actorUid: actorUid,
    );
    return StaffOfflineCaptureContext(
      tenantId: TenantConfig.id,
      facilityId: facilityId,
      deviceId: deviceId,
      devicePosture: posture,
      captureSessionId: captureSessionId,
      captureActorUuid: actorUid,
      captureRole: role,
      appVersion: appVersion.trim(),
    );
  }

  static Future<String> _captureSessionId({
    required String tenantId,
    required int facilityId,
    required String deviceId,
    required String actorUid,
  }) async {
    final namespace = [tenantId, facilityId, deviceId, actorUid].join('\u0000');
    final namespaceDigest = await OfflineCommandCodec.sha256Hex(
      utf8.encode(namespace),
    );
    final key = 'c4_capture_session_$namespaceDigest';
    final storage = VHSecureStorage.instance;
    final existing = (await storage.read(key: key))?.trim();
    if (existing != null && existing.isNotEmpty) return existing;
    final created = IdempotencyKey.generate();
    await storage.write(key: key, value: created);
    return created;
  }

  static Future<void> rotateCaptureSession({
    required String tenantId,
    required int facilityId,
    required String deviceId,
    required String actorUid,
  }) async {
    final namespace = [tenantId, facilityId, deviceId, actorUid].join('\u0000');
    final namespaceDigest = await OfflineCommandCodec.sha256Hex(
      utf8.encode(namespace),
    );
    await VHSecureStorage.instance.delete(
      key: 'c4_capture_session_$namespaceDigest',
    );
  }
}

class StaffOfflineCaptureContextUnavailable implements Exception {
  const StaffOfflineCaptureContextUnavailable(this.reasonCode);

  final String reasonCode;

  @override
  String toString() => 'StaffOfflineCaptureContextUnavailable($reasonCode)';
}
