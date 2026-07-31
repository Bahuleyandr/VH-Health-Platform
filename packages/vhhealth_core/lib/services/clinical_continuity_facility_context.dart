import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';

import '../models/api_response.dart';
import '../models/clinical_continuity.dart';
import 'auth_service.dart';
import 'clinical_continuity_canonical_json.dart';
import 'clinical_continuity_trust_store.dart';
import 'http_client.dart';
import 'secure_storage.dart';

const clinicalContinuityFacilityContextFormat =
    'vhhealth_continuity_facility_context/v1';
const clinicalContinuityFacilityProofFormat =
    'vhhealth_continuity_facility_proof/v1';

const _envelopeKeys = {
  'algorithm',
  'content',
  'contentHash',
  'keyId',
  'signature',
};
const _contentKeys = {
  'captureRevision',
  'contextId',
  'contextRevision',
  'deviceId',
  'effectiveFrom',
  'expiresAt',
  'facilityId',
  'format',
  'grantId',
  'grantPurpose',
  'issuedAt',
  'policyChecksum',
  'policyId',
  'policySigningKeyId',
  'policyVersion',
  'revocationEpoch',
  'sessionJtiSha256',
  'staffUid',
  'tenantId',
};
const _capturePurposes = {'capture_fixed_device', 'capture_staff_facility'};
final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
);
final _hash = RegExp(r'^[0-9a-f]{64}$');
final _revision = RegExp(r'^(?:0|[1-9][0-9]{0,18})$');

class ClinicalContinuityFacilityContext {
  const ClinicalContinuityFacilityContext({
    required this.envelope,
    required this.content,
  });

  final Map<String, Object?> envelope;
  final Map<String, Object?> content;

  String get tenantId => content['tenantId']! as String;
  String get facilityId => content['facilityId']! as String;
  String get staffUid => content['staffUid']! as String;
  String get deviceId => content['deviceId']! as String;
  String get contextId => content['contextId']! as String;
  String get contextRevision => content['contextRevision']! as String;
  DateTime get issuedAt => DateTime.parse(content['issuedAt']! as String);
  DateTime get expiresAt => DateTime.parse(content['expiresAt']! as String);

  String get headerValue => base64Url
      .encode(ClinicalContinuityCanonicalJson.canonicalBytes(envelope))
      .replaceAll('=', '');
}

class ClinicalContinuityFacilityContextVerifier {
  const ClinicalContinuityFacilityContextVerifier({
    ClinicalContinuityTrustStore trustStore =
        const ClinicalContinuityTrustStore(),
  }) : _trustStore = trustStore;

  final ClinicalContinuityTrustStore _trustStore;

  Future<ClinicalContinuityFacilityContext?> verify(
    Object? raw, {
    required String tenantId,
    required String facilityId,
    required String staffUid,
    required String deviceId,
    required String sessionJti,
    DateTime? trustedNow,
  }) async {
    try {
      if (raw is! Map) return null;
      final envelope = Map<String, Object?>.from(raw);
      if (!_exactKeys(envelope, _envelopeKeys) ||
          envelope['algorithm'] != 'Ed25519' ||
          envelope['keyId'] is! String ||
          envelope['signature'] is! String ||
          envelope['contentHash'] is! String ||
          envelope['content'] is! Map) {
        return null;
      }
      final content = Map<String, Object?>.from(envelope['content']! as Map);
      if (!_exactKeys(content, _contentKeys) ||
          content['format'] != clinicalContinuityFacilityContextFormat ||
          content['tenantId'] != tenantId ||
          content['facilityId'] != facilityId ||
          content['staffUid'] != staffUid ||
          content['deviceId'] != deviceId ||
          !_capturePurposes.contains(content['grantPurpose']) ||
          !_uuid.hasMatch(content['contextId']?.toString() ?? '') ||
          !_uuid.hasMatch(content['grantId']?.toString() ?? '') ||
          !_uuid.hasMatch(content['policyId']?.toString() ?? '') ||
          !_revision.hasMatch(content['captureRevision']?.toString() ?? '') ||
          !_revision.hasMatch(content['contextRevision']?.toString() ?? '') ||
          !_revision.hasMatch(content['policyVersion']?.toString() ?? '') ||
          !_revision.hasMatch(content['revocationEpoch']?.toString() ?? '') ||
          !_hash.hasMatch(content['policyChecksum']?.toString() ?? '') ||
          content['sessionJtiSha256'] != await _sha256Text(sessionJti)) {
        return null;
      }
      final canonicalContent = ClinicalContinuityCanonicalJson.canonicalBytes(
        content,
      );
      final digest = await Sha256().hash(canonicalContent);
      if (_hex(digest.bytes) != envelope['contentHash']) return null;

      final now = (trustedNow ?? DateTime.now()).toUtc();
      final issuedAt = _utc(content['issuedAt']);
      final effectiveFrom = _utc(content['effectiveFrom']);
      final expiresAt = _utc(content['expiresAt']);
      if (issuedAt == null ||
          effectiveFrom == null ||
          expiresAt == null ||
          issuedAt.isAfter(now) ||
          effectiveFrom.isAfter(now) ||
          issuedAt.isBefore(effectiveFrom) ||
          !expiresAt.isAfter(issuedAt) ||
          !expiresAt.isAfter(now)) {
        return null;
      }

      final trust = await _trustStore.load(
        expectedAudience: ClinicalContinuityAudience(
          tenantId: tenantId,
          facilityId: facilityId,
        ),
      );
      if (trust == null ||
          BigInt.parse(content['policyVersion']! as String) <
              BigInt.parse(trust.minimumPolicyVersion) ||
          BigInt.parse(content['revocationEpoch']! as String) <
              BigInt.parse(trust.revocationEpoch)) {
        return null;
      }
      final keyId = envelope['keyId']! as String;
      final key = trust.packSigningKeys[keyId];
      if (key == null ||
          key.state != ClinicalContinuityKeyState.current ||
          trust.revokedKeyIds.contains(keyId)) {
        return null;
      }
      final encodedSignature = envelope['signature']! as String;
      final signature = base64Decode(encodedSignature);
      if (signature.length != 64 ||
          base64Encode(signature) != encodedSignature) {
        return null;
      }
      final verified = await Ed25519().verify(
        canonicalContent,
        signature: Signature(
          signature,
          publicKey: SimplePublicKey(
            key.rawPublicKey,
            type: KeyPairType.ed25519,
          ),
        ),
      );
      if (!verified) return null;
      final immutableContent = Map<String, Object?>.unmodifiable(content);
      final immutableEnvelope = Map<String, Object?>.unmodifiable({
        ...envelope,
        'content': immutableContent,
      });
      return ClinicalContinuityFacilityContext(
        envelope: immutableEnvelope,
        content: immutableContent,
      );
    } catch (_) {
      return null;
    }
  }
}

class ClinicalContinuityDeviceIdentity {
  ClinicalContinuityDeviceIdentity._();

  static const _privateKey = 'continuityFacilityDevicePrivateKey';
  static const _publicKey = 'continuityFacilityDevicePublicKey';

  static Future<SimpleKeyPairData> _keyPair() async {
    final storage = VHSecureStorage.instance;
    final storedPrivate = await storage.read(key: _privateKey);
    final storedPublic = await storage.read(key: _publicKey);
    if (storedPrivate != null && storedPublic != null) {
      final publicBytes = base64Decode(storedPublic);
      final privateBytes = base64Decode(storedPrivate);
      if (publicBytes.length == 32 && privateBytes.length == 32) {
        return SimpleKeyPairData(
          privateBytes,
          publicKey: SimplePublicKey(publicBytes, type: KeyPairType.ed25519),
          type: KeyPairType.ed25519,
        );
      }
    }
    final pair = await Ed25519().newKeyPair();
    final extracted = await pair.extract();
    await storage.write(
      key: _privateKey,
      value: base64Encode(await extracted.extractPrivateKeyBytes()),
    );
    await storage.write(
      key: _publicKey,
      value: base64Encode(extracted.publicKey.bytes),
    );
    return extracted;
  }

  static Future<String> publicKeyBase64() async {
    final pair = await _keyPair();
    return base64Encode(pair.publicKey.bytes);
  }

  static Future<Map<String, Object?>> proof({
    required int facilityId,
    required String tenantId,
    required String staffUid,
    required String deviceId,
    required String sessionJti,
    DateTime? signedAt,
  }) async {
    final at = (signedAt ?? DateTime.now()).toUtc().toIso8601String();
    final content = <String, Object?>{
      'actorUid': staffUid,
      'deviceId': deviceId,
      'facilityId': facilityId.toString(),
      'format': clinicalContinuityFacilityProofFormat,
      'nonce': _randomUuidV4(),
      'sessionJtiSha256': await _sha256Text(sessionJti),
      'signedAt': at,
      'tenantId': tenantId,
    };
    final signature = await Ed25519().sign(
      ClinicalContinuityCanonicalJson.canonicalBytes(content),
      keyPair: await _keyPair(),
    );
    return {
      'nonce': content['nonce'],
      'signature': base64Encode(signature.bytes),
      'signedAt': at,
    };
  }
}

class ClinicalContinuityFacilityContextStore {
  ClinicalContinuityFacilityContextStore._();

  static const _activeKey = 'clinicalContinuityFacilityContextActiveKey';
  static const _prefix = 'clinicalContinuityFacilityContext:';

  static Future<void> write(ClinicalContinuityFacilityContext context) async {
    final storage = VHSecureStorage.instance;
    final key =
        '$_prefix${context.tenantId}:${context.staffUid}:${context.deviceId}';
    final previous = await storage.read(key: _activeKey);
    if (previous != null && previous != key) {
      await storage.delete(key: previous);
    }
    await storage.write(
      key: key,
      value: ClinicalContinuityCanonicalJson.canonicalize(context.envelope),
    );
    await storage.write(key: _activeKey, value: key);
  }

  static Future<Object?> readRaw() async {
    final storage = VHSecureStorage.instance;
    final key = await storage.read(key: _activeKey);
    if (key == null || !key.startsWith(_prefix)) return null;
    final value = await storage.read(key: key);
    if (value == null) return null;
    return ClinicalContinuityCanonicalJson.parse(
      Uint8List.fromList(utf8.encode(value)),
    );
  }

  static Future<void> clear() async {
    final storage = VHSecureStorage.instance;
    final key = await storage.read(key: _activeKey);
    if (key != null && key.startsWith(_prefix)) {
      await storage.delete(key: key);
    }
    await storage.delete(key: _activeKey);
  }
}

class ClinicalContinuityFacilityContextClient {
  const ClinicalContinuityFacilityContextClient({
    ClinicalContinuityFacilityContextVerifier verifier =
        const ClinicalContinuityFacilityContextVerifier(),
  }) : _verifier = verifier;

  final ClinicalContinuityFacilityContextVerifier _verifier;

  Future<ClinicalContinuityFacilityContext?> issue(int facilityId) async {
    final claims = await _sessionClaims();
    if (claims == null) return null;
    final response = await VHHttpClient.post(
      '/downtime/facility-context',
      body: {
        'facilityId': facilityId,
        'deviceProof': await ClinicalContinuityDeviceIdentity.proof(
          facilityId: facilityId,
          tenantId: claims.tenantId,
          staffUid: claims.staffUid,
          deviceId: claims.deviceId,
          sessionJti: claims.jti,
        ),
      },
    );
    final data = response.data;
    if (!response.isSuccess ||
        data is! Map ||
        data['facilityContext'] is! Map) {
      return null;
    }
    final context = await _verifier.verify(
      data['facilityContext'],
      tenantId: claims.tenantId,
      facilityId: facilityId.toString(),
      staffUid: claims.staffUid,
      deviceId: claims.deviceId,
      sessionJti: claims.jti,
    );
    if (context != null) {
      await ClinicalContinuityFacilityContextStore.write(context);
    }
    return context;
  }

  Future<ApiResponse> readiness(ClinicalContinuityFacilityContext context) {
    return VHHttpClient.post(
      '/health/client-readiness/v2',
      body: {'facilityContext': context.envelope},
    );
  }

  Future<ClinicalContinuityFacilityContext?> current() async {
    final claims = await _sessionClaims();
    final raw = await ClinicalContinuityFacilityContextStore.readRaw();
    if (claims == null || raw == null) return null;
    final rawMap = raw is Map ? Map<String, Object?>.from(raw) : null;
    final content = rawMap?['content'];
    if (content is! Map) return null;
    final facilityId = content['facilityId']?.toString();
    if (facilityId == null) return null;
    return _verifier.verify(
      rawMap,
      tenantId: claims.tenantId,
      facilityId: facilityId,
      staffUid: claims.staffUid,
      deviceId: claims.deviceId,
      sessionJti: claims.jti,
    );
  }

  Future<ClinicalContinuitySessionContext?> currentSession() async {
    final context = await current();
    if (context == null) return null;
    return ClinicalContinuitySessionContext(
      tenantId: context.tenantId,
      facilityId: context.facilityId,
      staffId: context.staffUid,
      role: await AuthService.getUserRole() ?? 'GENERAL_STAFF',
      deviceId: context.deviceId,
      authenticatedAt: context.issuedAt,
    );
  }
}

@immutable
class _SessionClaims {
  const _SessionClaims({
    required this.tenantId,
    required this.staffUid,
    required this.deviceId,
    required this.jti,
  });

  final String tenantId;
  final String staffUid;
  final String deviceId;
  final String jti;
}

Future<_SessionClaims?> _sessionClaims() async {
  try {
    final token = await AuthService.getJwt();
    if (token == null) return null;
    final parts = token.split('.');
    if (parts.length != 3) return null;
    final payload = jsonDecode(
      utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
    );
    if (payload is! Map) return null;
    final tenantId = (payload['tenant_id'] ?? payload['tenantId'])?.toString();
    final staffUid = (payload['uid'] ?? payload['user_uid'])?.toString();
    final deviceId = payload['stableDeviceId']?.toString();
    final jti = payload['jti']?.toString();
    if (tenantId == null ||
        staffUid == null ||
        deviceId == null ||
        jti == null ||
        !_uuid.hasMatch(tenantId) ||
        !_uuid.hasMatch(staffUid) ||
        !_uuid.hasMatch(deviceId) ||
        jti.isEmpty) {
      return null;
    }
    return _SessionClaims(
      tenantId: tenantId,
      staffUid: staffUid,
      deviceId: deviceId,
      jti: jti,
    );
  } catch (_) {
    return null;
  }
}

Future<String> _sha256Text(String value) async {
  final digest = await Sha256().hash(utf8.encode(value));
  return _hex(digest.bytes);
}

String _hex(List<int> bytes) =>
    bytes.map((value) => value.toRadixString(16).padLeft(2, '0')).join();

DateTime? _utc(Object? value) {
  if (value is! String) return null;
  final parsed = DateTime.tryParse(value);
  return parsed == null || !parsed.isUtc ? null : parsed;
}

bool _exactKeys(Map<String, Object?> value, Set<String> expected) =>
    value.keys.toSet().length == expected.length &&
    value.keys.toSet().containsAll(expected);

String _randomUuidV4() {
  final bytes = List<int>.generate(16, (_) => Random.secure().nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes
      .map((value) => value.toRadixString(16).padLeft(2, '0'))
      .join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-'
      '${hex.substring(20)}';
}
