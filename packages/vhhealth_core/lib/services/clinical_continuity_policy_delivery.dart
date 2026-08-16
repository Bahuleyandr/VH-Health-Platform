import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:http/http.dart' as http;

import '../models/clinical_continuity.dart';
import 'http_client.dart';

const clinicalContinuityPolicyDeliveryFormat =
    'vhhealth_clinical_continuity_policy_delivery/v1';
const clinicalContinuityPolicyDeliveryMediaType =
    'application/vnd.vhhealth.clinical-continuity-policy+json';
const clinicalContinuityPolicyDeliveryMaxBytes = 256 * 1024;

typedef ClinicalContinuityPolicyHttpGet = Future<http.Response> Function(
  String path, {
  Map<String, String>? additionalHeaders,
});

class ClinicalContinuityPolicyDeliveryResult {
  const ClinicalContinuityPolicyDeliveryResult({
    required this.policyId,
    required this.envelopeBytes,
    required this.etag,
    required this.contentDigest,
    required this.clock,
    required this.provenance,
  });

  final String policyId;
  final Uint8List envelopeBytes;
  final String etag;
  final String contentDigest;
  final ClinicalContinuityClockAssessment clock;
  final ClinicalContinuitySourceProvenance provenance;
}

class ClinicalContinuityPolicyDeliveryException implements Exception {
  const ClinicalContinuityPolicyDeliveryException(
    this.reasonCode, {
    this.statusCode,
    this.retryAfter,
  });

  final String reasonCode;
  final int? statusCode;
  final Duration? retryAfter;

  @override
  String toString() =>
      'ClinicalContinuityPolicyDeliveryException($reasonCode, $statusCode)';
}

class ClinicalContinuityPolicyDeliveryClient {
  ClinicalContinuityPolicyDeliveryClient({
    ClinicalContinuityPolicyHttpGet? httpGet,
  }) : _httpGet = httpGet ?? _defaultGet;

  final ClinicalContinuityPolicyHttpGet _httpGet;
  ClinicalContinuityPolicyDeliveryResult? _lastGood;

  static Future<http.Response> _defaultGet(
    String path, {
    Map<String, String>? additionalHeaders,
  }) => VHHttpClient.getBytes(path, additionalHeaders: additionalHeaders);

  Future<ClinicalContinuityPolicyDeliveryResult> fetch({
    required String facilityId,
    required String facilityContextHeader,
  }) async {
    if (!RegExp(r'^[1-9][0-9]{0,9}$').hasMatch(facilityId) ||
        facilityContextHeader.isEmpty ||
        facilityContextHeader.length > 16384) {
      throw const ClinicalContinuityPolicyDeliveryException(
        'policy_delivery_request_invalid',
      );
    }
    final previous = _lastGood;
    final response = await _httpGet(
      '/clinical-continuity/facilities/$facilityId/policy',
      additionalHeaders: {
        'Accept': clinicalContinuityPolicyDeliveryMediaType,
        'X-VH-Continuity-Facility-Context': facilityContextHeader,
        if (previous != null) 'If-None-Match': previous.etag,
      },
    );
    final trustedNow = _trustedServerTime(
      response.headers['x-vh-continuity-trusted-time'],
    );
    if (trustedNow == null) {
      throw const ClinicalContinuityPolicyDeliveryException(
        'policy_delivery_clock_untrusted',
      );
    }
    if (response.statusCode == 304) {
      if (previous == null || response.headers['etag'] != previous.etag) {
        throw const ClinicalContinuityPolicyDeliveryException(
          'policy_delivery_not_modified_without_representation',
          statusCode: 304,
        );
      }
      final refreshed = ClinicalContinuityPolicyDeliveryResult(
        policyId: previous.policyId,
        envelopeBytes: Uint8List.fromList(previous.envelopeBytes),
        etag: previous.etag,
        contentDigest: previous.contentDigest,
        clock: ClinicalContinuityClockAssessment(
          trusted: true,
          trustedNow: trustedNow,
        ),
        provenance: previous.provenance,
      );
      _lastGood = refreshed;
      return refreshed;
    }
    if (response.statusCode != 200) {
      throw ClinicalContinuityPolicyDeliveryException(
        _errorCode(response),
        statusCode: response.statusCode,
        retryAfter: _retryAfter(response.headers['retry-after']),
      );
    }
    final contentType = response.headers['content-type']?.split(';').first;
    final etag = response.headers['etag'];
    final contentDigest = response.headers['content-digest'];
    final bytes = Uint8List.fromList(response.bodyBytes);
    if (contentType != clinicalContinuityPolicyDeliveryMediaType ||
        etag == null ||
        contentDigest == null ||
        bytes.isEmpty ||
        bytes.length > clinicalContinuityPolicyDeliveryMaxBytes) {
      throw const ClinicalContinuityPolicyDeliveryException(
        'policy_delivery_integrity_failed',
        statusCode: 200,
      );
    }
    final digest = await Sha256().hash(bytes);
    final digestHex = _hex(digest.bytes);
    final digestHeader = 'sha-256=:${base64Encode(digest.bytes)}:';
    final etagMatch = RegExp(r'^"pc-([a-f0-9]{64})\.rep-([a-f0-9]{64})"$')
        .firstMatch(etag);
    if (contentDigest != digestHeader ||
        etagMatch == null ||
        etagMatch.group(2) != digestHex) {
      throw const ClinicalContinuityPolicyDeliveryException(
        'policy_delivery_integrity_failed',
        statusCode: 200,
      );
    }
    String policyId;
    try {
      final decoded = jsonDecode(utf8.decode(bytes));
      if (decoded is! Map ||
          decoded.keys.toSet().difference(const {
            'format',
            'payload',
            'policyId',
            'signature',
          }).isNotEmpty ||
          decoded.length != 4 ||
          decoded['format'] != clinicalContinuityPolicyDeliveryFormat ||
          decoded['policyId'] is! String) {
        throw const FormatException();
      }
      policyId = decoded['policyId']! as String;
    } catch (_) {
      throw const ClinicalContinuityPolicyDeliveryException(
        'policy_delivery_integrity_failed',
        statusCode: 200,
      );
    }
    final result = ClinicalContinuityPolicyDeliveryResult(
      policyId: policyId,
      envelopeBytes: bytes,
      etag: etag,
      contentDigest: contentDigest,
      clock: ClinicalContinuityClockAssessment(
        trusted: true,
        trustedNow: trustedNow,
      ),
      provenance: ClinicalContinuitySourceProvenance(
        sourceRevision: etag,
        sourceWatermark: digestHex,
      ),
    );
    _lastGood = result;
    return result;
  }
}

DateTime? _trustedServerTime(String? value) {
  if (value == null) return null;
  return DateTime.tryParse(value)?.toUtc();
}

String _errorCode(http.Response response) {
  try {
    final decoded = jsonDecode(response.body);
    if (decoded is Map && decoded['code'] is String) {
      return decoded['code']! as String;
    }
  } catch (_) {}
  return 'policy_delivery_http_${response.statusCode}';
}

Duration? _retryAfter(String? value) {
  if (value == null) return null;
  const maximum = Duration(minutes: 5);
  final seconds = int.tryParse(value.trim());
  if (seconds != null) {
    if (seconds <= 0) return null;
    final requested = Duration(seconds: seconds);
    return requested > maximum ? maximum : requested;
  }
  final at = DateTime.tryParse(value)?.toUtc();
  if (at == null) return null;
  final requested = at.difference(DateTime.now().toUtc());
  if (requested <= Duration.zero) return null;
  return requested > maximum ? maximum : requested;
}

String _hex(List<int> bytes) =>
    bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
