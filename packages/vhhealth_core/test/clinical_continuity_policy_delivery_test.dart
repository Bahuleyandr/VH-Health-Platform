import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:vhhealth_core/services/clinical_continuity_policy_delivery.dart';

void main() {
  const policyId = '55555555-5555-4555-8555-555555555555';
  final body = utf8.encode(
    jsonEncode({
      'format': clinicalContinuityPolicyDeliveryFormat,
      'payload': const <String, Object?>{},
      'policyId': policyId,
      'signature': base64Encode(List<int>.filled(64, 7)),
    }),
  );

  test(
    'accepts exact vendor bytes and reuses them only on a bound 304',
    () async {
      final digest = await Sha256().hash(body);
      final digestHex = _hex(digest.bytes);
      final etag = '"pc-${'a' * 64}.rep-$digestHex"';
      var calls = 0;
      final client = ClinicalContinuityPolicyDeliveryClient(
        httpGet: (path, {additionalHeaders}) async {
          calls += 1;
          expect(path, '/clinical-continuity/facilities/41/policy');
          expect(
            additionalHeaders?['X-VH-Continuity-Facility-Context'],
            'signed-context',
          );
          if (calls == 2) {
            expect(additionalHeaders?['If-None-Match'], etag);
            return http.Response(
              '',
              304,
              headers: {
                'etag': etag,
                'x-vh-continuity-trusted-time': '2026-07-31T10:01:00.000Z',
              },
            );
          }
          return http.Response.bytes(
            body,
            200,
            headers: {
              'content-digest': 'sha-256=:${base64Encode(digest.bytes)}:',
              'content-type': clinicalContinuityPolicyDeliveryMediaType,
              'etag': etag,
              'x-vh-continuity-trusted-time': '2026-07-31T10:00:00.000Z',
            },
          );
        },
      );

      final first = await client.fetch(
        facilityId: '41',
        facilityContextHeader: 'signed-context',
      );
      final second = await client.fetch(
        facilityId: '41',
        facilityContextHeader: 'signed-context',
      );

      expect(first.policyId, policyId);
      expect(first.envelopeBytes, body);
      expect(second.envelopeBytes, body);
      expect(
        second.clock.trustedNow,
        DateTime.parse('2026-07-31T10:01:00.000Z'),
      );
    },
  );

  test('rejects a served-byte digest mismatch before verification', () async {
    final client = ClinicalContinuityPolicyDeliveryClient(
      httpGet: (_, {additionalHeaders}) async => http.Response.bytes(
        body,
        200,
        headers: {
          'content-digest':
              'sha-256=:${base64Encode(List<int>.filled(32, 0))}:',
          'content-type': clinicalContinuityPolicyDeliveryMediaType,
          'etag': '"pc-${'a' * 64}.rep-${'b' * 64}"',
          'x-vh-continuity-trusted-time': '2026-07-31T10:00:00.000Z',
        },
      ),
    );

    await expectLater(
      client.fetch(facilityId: '41', facilityContextHeader: 'signed-context'),
      throwsA(
        isA<ClinicalContinuityPolicyDeliveryException>().having(
          (error) => error.reasonCode,
          'reasonCode',
          'policy_delivery_integrity_failed',
        ),
      ),
    );
  });

  test('preserves stable typed backend lifecycle errors', () async {
    final client = ClinicalContinuityPolicyDeliveryClient(
      httpGet: (_, {additionalHeaders}) async => http.Response(
        '{"code":"CONTINUITY_POLICY_REVOKED"}',
        410,
        headers: {
          'retry-after': '900',
          'x-vh-continuity-trusted-time': '2026-07-31T10:00:00.000Z',
        },
      ),
    );

    await expectLater(
      client.fetch(facilityId: '41', facilityContextHeader: 'signed-context'),
      throwsA(
        isA<ClinicalContinuityPolicyDeliveryException>()
            .having((error) => error.statusCode, 'statusCode', 410)
            .having(
              (error) => error.reasonCode,
              'reasonCode',
              'CONTINUITY_POLICY_REVOKED',
            )
            .having(
              (error) => error.retryAfter,
              'retryAfter',
              const Duration(minutes: 5),
            ),
      ),
    );
  });
}

String _hex(List<int> bytes) =>
    bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
