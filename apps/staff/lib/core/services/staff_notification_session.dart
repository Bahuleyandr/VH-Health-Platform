import 'dart:convert';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:vhhealth_core/services/secure_storage.dart';

import '../config/api_config.dart';
import 'api_client.dart';

abstract interface class NotificationSessionPersistence {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class _SecureNotificationSessionPersistence
    implements NotificationSessionPersistence {
  final _storage = VHSecureStorage.instance;

  @override
  Future<void> delete(String key) => _storage.delete(key: key);

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);
}

class StaffNotificationAudience {
  const StaffNotificationAudience({
    required this.version,
    required this.tenantId,
    required this.recipientUid,
    required this.deviceId,
    required this.registrationEpoch,
    required this.sessionEpoch,
    required this.authorizationEpoch,
  });

  final int version;
  final String tenantId;
  final String recipientUid;
  final String deviceId;
  final String registrationEpoch;
  final String sessionEpoch;
  final String authorizationEpoch;

  static StaffNotificationAudience? fromJson(dynamic value) {
    if (value is! Map) return null;
    final map = Map<String, dynamic>.from(value);
    final version = int.tryParse(map['version']?.toString() ?? '');
    final tenantId = map['tenantId']?.toString().trim();
    final recipientUid = map['recipientUid']?.toString().trim();
    final deviceId = map['deviceId']?.toString().trim();
    final registrationEpoch = map['registrationEpoch']?.toString().trim();
    final sessionEpoch = map['sessionEpoch']?.toString().trim();
    final authorizationEpoch = map['authorizationEpoch']?.toString().trim();
    if (version != 1 ||
        tenantId == null ||
        tenantId.isEmpty ||
        recipientUid == null ||
        recipientUid.isEmpty ||
        deviceId == null ||
        deviceId.isEmpty ||
        registrationEpoch == null ||
        registrationEpoch.isEmpty ||
        sessionEpoch == null ||
        sessionEpoch.isEmpty ||
        authorizationEpoch == null ||
        authorizationEpoch.isEmpty) {
      return null;
    }
    return StaffNotificationAudience(
      version: version!,
      tenantId: tenantId,
      recipientUid: recipientUid,
      deviceId: deviceId,
      registrationEpoch: registrationEpoch,
      sessionEpoch: sessionEpoch,
      authorizationEpoch: authorizationEpoch,
    );
  }

  Map<String, dynamic> toJson() => {
    'version': version,
    'tenantId': tenantId,
    'recipientUid': recipientUid,
    'deviceId': deviceId,
    'registrationEpoch': registrationEpoch,
    'sessionEpoch': sessionEpoch,
    'authorizationEpoch': authorizationEpoch,
  };

  bool matches(StaffNotificationAudience other) =>
      version == other.version &&
      tenantId == other.tenantId &&
      recipientUid == other.recipientUid &&
      deviceId == other.deviceId &&
      registrationEpoch == other.registrationEpoch &&
      sessionEpoch == other.sessionEpoch &&
      authorizationEpoch == other.authorizationEpoch;
}

class StaffNotificationEnvelope {
  const StaffNotificationEnvelope({
    required this.audience,
    required this.expiresAt,
  });

  final StaffNotificationAudience audience;
  final DateTime expiresAt;

  static StaffNotificationEnvelope? fromMessage(RemoteMessage message) {
    final data = message.data;
    final audience = StaffNotificationAudience.fromJson({
      'version': data['notification_authority_version'],
      'tenantId': data['notification_tenant_id'],
      'recipientUid': data['notification_recipient_uid'],
      'deviceId': data['notification_device_id'],
      'registrationEpoch': data['notification_registration_epoch'],
      'sessionEpoch': data['notification_session_epoch'],
      'authorizationEpoch': data['notification_authorization_epoch'],
    });
    final expiresAtUnix = int.tryParse(
      data['notification_expires_at']?.toString() ?? '',
    );
    if (audience == null || expiresAtUnix == null) return null;
    return StaffNotificationEnvelope(
      audience: audience,
      expiresAt: DateTime.fromMillisecondsSinceEpoch(
        expiresAtUnix * 1000,
        isUtc: true,
      ),
    );
  }
}

typedef StaffNotificationClaimsLoader = Future<StaffJwtClaims?> Function();
typedef StaffNotificationAuthorityValidator = Future<bool> Function(
  StaffNotificationAudience audience,
);
typedef StaffCodeBlueContentFetcher = Future<Map<String, dynamic>?> Function(
  StaffNotificationAudience audience,
  String reference,
);

class StaffNotificationSessionStore {
  StaffNotificationSessionStore({NotificationSessionPersistence? persistence})
    : _persistence = persistence ?? _SecureNotificationSessionPersistence();

  static final instance = StaffNotificationSessionStore();
  static const _activeKey = 'staff_notification_session_active';

  final NotificationSessionPersistence _persistence;

  Future<void> markActive(StaffNotificationAudience audience) =>
      _persistence.write(_activeKey, jsonEncode(audience.toJson()));

  Future<void> markInactive() => _persistence.delete(_activeKey);

  Future<StaffNotificationAudience?> readActive() async {
    final encoded = await _persistence.read(_activeKey);
    if (encoded == null || encoded.isEmpty) return null;
    try {
      return StaffNotificationAudience.fromJson(jsonDecode(encoded));
    } catch (_) {
      return null;
    }
  }

  Future<bool> isActiveFor(String? staffUid) async {
    final normalized = staffUid?.trim();
    if (normalized == null || normalized.isEmpty) return false;
    return (await readActive())?.recipientUid == normalized;
  }
}

Future<bool> _validateWithServer(StaffNotificationAudience audience) async {
  try {
    final response = await ApiClient.post(
      '/devices/notification-authority/validate',
      body: audience.toJson(),
    );
    return response.isSuccess && response.dataAsMap()['authorized'] == true;
  } catch (_) {
    return false;
  }
}

Future<Map<String, dynamic>?> _fetchCodeBlueContentFromServer(
  StaffNotificationAudience audience,
  String reference,
) async {
  try {
    final response = await ApiClient.post(
      '/devices/notification-authority/code-blue',
      body: {...audience.toJson(), 'codeBlueReference': reference},
    );
    if (!response.isSuccess) return null;
    final data = response.dataAsMap();
    if (data['authorized'] != true || data['content'] is! Map) return null;
    return Map<String, dynamic>.from(data['content'] as Map);
  } catch (_) {
    return null;
  }
}

Future<Map<String, dynamic>?> codeBlueContentForMessage({
  required RemoteMessage message,
  StaffCodeBlueContentFetcher? contentFetcher,
}) async {
  final envelope = StaffNotificationEnvelope.fromMessage(message);
  final reference =
      message.data['code_blue_reference']?.toString().trim() ?? '';
  if (envelope == null ||
      reference.isEmpty ||
      reference.length > 2048 ||
      !RegExp(r'^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
          .hasMatch(reference)) {
    return null;
  }
  return (contentFetcher ?? _fetchCodeBlueContentFromServer)(
    envelope.audience,
    reference,
  );
}

Future<bool> mayPresentStaffPush({
  required RemoteMessage message,
  StaffNotificationSessionStore? sessionStore,
  StaffNotificationClaimsLoader? claimsLoader,
  StaffNotificationAuthorityValidator? authorityValidator,
  DateTime? now,
}) async {
  final envelope = StaffNotificationEnvelope.fromMessage(message);
  final checkedAt = (now ?? DateTime.now()).toUtc();
  if (envelope == null || !envelope.expiresAt.isAfter(checkedAt)) return false;

  final claims = await (claimsLoader ?? ApiConfig.getStaffJwtClaims)();
  if (claims == null || !claims.expiresAt.isAfter(checkedAt)) return false;
  final audience = envelope.audience;
  if (claims.staffUid != audience.recipientUid ||
      claims.tenantId != audience.tenantId ||
      claims.sessionEpoch != audience.sessionEpoch ||
      claims.tokenEpoch != audience.authorizationEpoch) {
    return false;
  }

  final active = await (sessionStore ?? StaffNotificationSessionStore.instance)
      .readActive();
  if (active == null || !active.matches(audience)) return false;
  return (authorityValidator ?? _validateWithServer)(audience);
}
