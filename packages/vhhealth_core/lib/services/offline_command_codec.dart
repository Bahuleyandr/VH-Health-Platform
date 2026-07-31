import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import '../models/offline_command_envelope.dart';

abstract final class OfflineCommandCodec {
  static final Sha256 _sha256 = Sha256();

  static String canonicalize(Object? value) {
    final output = StringBuffer();
    _writeCanonical(output, value);
    return output.toString();
  }

  static Future<String> hashCanonical(Object? value) =>
      sha256Hex(utf8.encode(canonicalize(value)));

  static Future<String> sha256Hex(List<int> bytes) async {
    final digest = await _sha256.hash(bytes);
    return digest.bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
  }

  static String encodeEnvelope(OfflineCommandEnvelope envelope) =>
      canonicalize(envelope.toJson());

  static OfflineCommandEnvelope decodeEnvelope(String encoded) {
    final decoded = jsonDecode(encoded);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Offline command envelope must be an object');
    }
    return OfflineCommandEnvelope.fromJson(decoded);
  }

  static Map<String, Object?> fingerprintProjection(
    OfflineCommandEnvelope envelope,
  ) {
    final projection = Map<String, Object?>.from(envelope.toJson())
      ..remove('client_event_id')
      ..remove('idempotency_key')
      ..remove('command_fingerprint')
      ..remove('queued_at');
    return projection;
  }

  static Future<String> commandFingerprint(OfflineCommandEnvelope envelope) =>
      hashCanonical(fingerprintProjection(envelope));

  static Map<String, String> replayHeaders(OfflineCommandEnvelope envelope) {
    final sourceEntries = envelope.cachedSources.entries.toList()
      ..sort((left, right) => left.key.compareTo(right.key));
    return {
      'X-VH-Continuity-Action-Id': envelope.actionId,
      'X-VH-Continuity-Facility-Id': envelope.facilityId.toString(),
      'X-VH-Continuity-Captured-At': _timestamp(envelope.capturedAt),
      'X-VH-Continuity-Capture-Session-Id': envelope.captureSessionId,
      'X-VH-Continuity-Cached-Sources': sourceEntries
          .map((entry) => '${entry.key}=${_timestamp(entry.value)}')
          .join(','),
      'X-VH-Continuity-Client-App-Version': envelope.appVersion,
      'X-VH-Continuity-Action-Version': envelope.actionVersion.toString(),
      'X-VH-Continuity-Action-Checksum': envelope.actionChecksum,
      'X-VH-Continuity-Action-Schema-Version': envelope.actionSchemaVersion
          .toString(),
      'X-VH-Continuity-Action-Schema-Checksum': envelope.actionSchemaChecksum,
      'X-VH-Continuity-Policy-Id': envelope.policyId,
      'X-VH-Continuity-Policy-Version': envelope.policyVersion,
      'X-VH-Continuity-Policy-Checksum': envelope.policyChecksum,
      'X-VH-Continuity-Policy-Signing-Key-Id': envelope.policySigningKeyId,
      'X-VH-Continuity-Policy-Effective-From': _timestamp(
        envelope.policyEffectiveFrom,
      ),
      'X-VH-Continuity-Policy-Effective-Until': _timestamp(
        envelope.policyEffectiveUntil,
      ),
      'X-VH-Continuity-Policy-Supersedes-Id':
          envelope.policySupersedesId ?? 'none',
      'X-VH-Continuity-Revocation-Epoch': envelope.policyRevocationEpoch,
      'X-VH-Continuity-Registry-Version': envelope.registryVersion,
      'X-VH-Continuity-Registry-Checksum': envelope.registryChecksum,
    };
  }

  static void _writeCanonical(StringBuffer output, Object? value) {
    if (value == null) {
      output.write('null');
      return;
    }
    if (value is bool) {
      output.write(value ? 'true' : 'false');
      return;
    }
    if (value is int) {
      output.write(value);
      return;
    }
    if (value is double) {
      if (!value.isFinite) {
        throw const FormatException(
          'Canonical JSON rejects non-finite numbers',
        );
      }
      if (value == 0) {
        output.write('0');
        return;
      }
      var text = value.toString().toLowerCase();
      if (!text.contains('e') && text.endsWith('.0')) {
        text = text.substring(0, text.length - 2);
      }
      text = text.replaceFirst(RegExp(r'e\+?(-?)0+'), 'e\$1');
      output.write(text);
      return;
    }
    if (value is num) {
      throw const FormatException('Unsupported JSON number');
    }
    if (value is String) {
      output.write(jsonEncode(value));
      return;
    }
    if (value is List) {
      output.write('[');
      for (var index = 0; index < value.length; index++) {
        if (index > 0) output.write(',');
        _writeCanonical(output, value[index]);
      }
      output.write(']');
      return;
    }
    if (value is Map) {
      final entries = <MapEntry<String, Object?>>[];
      for (final entry in value.entries) {
        if (entry.key is! String) {
          throw const FormatException('Canonical JSON object keys are strings');
        }
        entries.add(MapEntry(entry.key as String, entry.value));
      }
      entries.sort((left, right) => left.key.compareTo(right.key));
      output.write('{');
      for (var index = 0; index < entries.length; index++) {
        if (index > 0) output.write(',');
        output.write(jsonEncode(entries[index].key));
        output.write(':');
        _writeCanonical(output, entries[index].value);
      }
      output.write('}');
      return;
    }
    throw FormatException(
      'Unsupported canonical JSON value ${value.runtimeType}',
    );
  }

  static String _timestamp(DateTime value) => value.toUtc().toIso8601String();
}
