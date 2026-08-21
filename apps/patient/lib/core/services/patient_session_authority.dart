import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/services/secure_storage.dart';

typedef PatientSessionClock = DateTime Function();
typedef PatientSessionStorageRead = Future<String?> Function(String key);
typedef PatientSessionStorageWrite = Future<void> Function(
  String key,
  String value,
);

/// Local authority for protected Patient routes and decrypted device caches.
///
/// A current JWT is accepted only when its bounded Patient claims are
/// parseable and unexpired. Once it expires, cached PHI remains available only
/// while a token-bound lease created from a successful authenticated readiness
/// response is still current. The lease never authorizes a network mutation;
/// the outage controller continues to refuse all hospital writes.
class PatientSessionAuthority {
  PatientSessionAuthority._production()
    : _read = ((key) => VHSecureStorage.instance.read(key: key)),
      _write = ((key, value) =>
          VHSecureStorage.instance.write(key: key, value: value)),
      _clock = DateTime.now;

  @visibleForTesting
  PatientSessionAuthority.forTesting({
    required PatientSessionStorageRead read,
    required PatientSessionStorageWrite write,
    PatientSessionClock clock = DateTime.now,
  }) : _read = read,
       _write = write,
       _clock = clock;

  static const offlineLeaseDuration = Duration(hours: 24);
  static const _maxClockSkew = Duration(minutes: 5);
  static const _storageKey = 'patient.offline_session_lease.v1';
  static const _leaseKeys = <String>{
    'version',
    'tenantId',
    'subject',
    'tokenId',
    'tokenSha256',
    'confirmedAt',
    'expiresAt',
  };

  static PatientSessionAuthority _active =
      PatientSessionAuthority._production();

  static PatientSessionAuthority get instance => _active;

  @visibleForTesting
  static void setForTesting(PatientSessionAuthority authority) {
    _active = authority;
  }

  @visibleForTesting
  static void resetAfterTesting() {
    _active = PatientSessionAuthority._production();
  }

  final PatientSessionStorageRead _read;
  final PatientSessionStorageWrite _write;
  final PatientSessionClock _clock;

  Future<bool> currentSessionAllowsProtectedAccess() async {
    final jwt = await _read('jwt');
    return allowsProtectedAccess(jwt);
  }

  Future<bool> allowsProtectedAccess(String? jwt) async {
    final claims = _PatientJwtClaims.tryParse(jwt);
    if (claims == null) return false;

    final now = _clock().toUtc();
    final lease = await _matchingLease(jwt!, claims);
    if (claims.isCurrentAt(now)) {
      return lease == null ||
          !now.isBefore(lease.confirmedAt.subtract(_maxClockSkew));
    }
    if (!claims.isExpiredAt(now)) return false;
    if (lease == null) return false;
    if (now.isBefore(lease.confirmedAt.subtract(_maxClockSkew))) return false;
    return now.isBefore(lease.expiresAt);
  }

  Future<_PatientOfflineLease?> _matchingLease(
    String jwt,
    _PatientJwtClaims claims,
  ) async {
    final rawLease = await _read(_storageKey);
    if (rawLease == null) return null;
    try {
      final decoded = jsonDecode(rawLease);
      if (decoded is! Map) return null;
      final lease = Map<String, dynamic>.from(decoded);
      if (!setEquals(lease.keys.toSet(), _leaseKeys) ||
          lease['version'] != 1 ||
          lease['tenantId'] != TenantConfig.id ||
          lease['subject'] != claims.subject ||
          lease['tokenId'] != claims.tokenId ||
          lease['tokenSha256'] != await _sha256(jwt)) {
        return null;
      }

      final confirmedAt = _utcTimestamp(lease['confirmedAt']);
      final expiresAt = _utcTimestamp(lease['expiresAt']);
      if (confirmedAt == null || expiresAt == null) return null;
      if (expiresAt.difference(confirmedAt) != offlineLeaseDuration) {
        return null;
      }
      return _PatientOfflineLease(
        confirmedAt: confirmedAt,
        expiresAt: expiresAt,
      );
    } catch (_) {
      return null;
    }
  }

  Future<bool> confirmServerSession({
    required String jwt,
    required String tenantId,
    required DateTime confirmedAt,
  }) async {
    final claims = _PatientJwtClaims.tryParse(jwt);
    final trustedTime = confirmedAt.toUtc();
    if (claims == null ||
        tenantId != TenantConfig.id ||
        !claims.isCurrentAt(trustedTime)) {
      return false;
    }

    final lease = <String, Object>{
      'version': 1,
      'tenantId': tenantId,
      'subject': claims.subject,
      'tokenId': claims.tokenId,
      'tokenSha256': await _sha256(jwt),
      'confirmedAt': trustedTime.toIso8601String(),
      'expiresAt': trustedTime.add(offlineLeaseDuration).toIso8601String(),
    };
    await _write(_storageKey, jsonEncode(lease));
    return true;
  }

  static Future<String> _sha256(String value) async {
    final digest = await Sha256().hash(utf8.encode(value));
    return base64UrlEncode(digest.bytes).replaceAll('=', '');
  }

  static DateTime? _utcTimestamp(Object? value) {
    if (value is! String) return null;
    final parsed = DateTime.tryParse(value);
    return parsed != null && parsed.isUtc ? parsed : null;
  }
}

class _PatientOfflineLease {
  const _PatientOfflineLease({
    required this.confirmedAt,
    required this.expiresAt,
  });

  final DateTime confirmedAt;
  final DateTime expiresAt;
}

class _PatientJwtClaims {
  const _PatientJwtClaims({
    required this.subject,
    required this.tokenId,
    required this.expiresAt,
    required this.notBefore,
  });

  final String subject;
  final String tokenId;
  final DateTime expiresAt;
  final DateTime? notBefore;

  bool isCurrentAt(DateTime now) =>
      now.isBefore(expiresAt) &&
      (notBefore == null || !now.isBefore(notBefore!));

  bool isExpiredAt(DateTime now) => !now.isBefore(expiresAt);

  static _PatientJwtClaims? tryParse(String? jwt) {
    if (jwt == null || jwt.isEmpty) return null;
    final parts = jwt.split('.');
    if (parts.length != 3 || parts.any((part) => part.isEmpty)) return null;

    try {
      final decoded = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
      );
      if (decoded is! Map) return null;
      final payload = Map<String, dynamic>.from(decoded);
      final subject = payload['sub'];
      final tokenId = payload['jti'];
      final role = payload['role'];
      final exp = payload['exp'];
      final nbf = payload['nbf'];
      if (subject is! String ||
          subject.isEmpty ||
          tokenId is! String ||
          tokenId.isEmpty ||
          role is! String ||
          role.toUpperCase() != 'PATIENT' ||
          exp is! int ||
          exp <= 0 ||
          exp > 253402300799 ||
          (nbf != null && (nbf is! int || nbf < 0 || nbf > 253402300799))) {
        return null;
      }
      return _PatientJwtClaims(
        subject: subject,
        tokenId: tokenId,
        expiresAt: DateTime.fromMillisecondsSinceEpoch(
          exp * Duration.millisecondsPerSecond,
          isUtc: true,
        ),
        notBefore: nbf == null
            ? null
            : DateTime.fromMillisecondsSinceEpoch(
                nbf * Duration.millisecondsPerSecond,
                isUtc: true,
              ),
      );
    } catch (_) {
      return null;
    }
  }
}
