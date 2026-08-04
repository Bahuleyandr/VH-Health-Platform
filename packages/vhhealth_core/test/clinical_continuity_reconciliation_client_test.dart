import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/api/vhhealth_api.dart';
import 'package:vhhealth_core/services/clinical_continuity_facility_context.dart';
import 'package:vhhealth_core/services/clinical_continuity_reconciliation_client.dart';
import 'package:vhhealth_core/services/http_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    const channel = MethodChannel(
      'plugins.it_nomads.com/flutter_secure_storage',
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (_) async => null);
  });

  tearDown(VHHttpClient.resetClientForTesting);

  test(
    'releases one exact held message with signed context and stable key',
    () async {
      late http.Request captured;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'disposition': 'applied',
                'receipt_id': '11111111-1111-4111-8111-111111111111',
                'outcome_code': 'held_message_send_authority_rearmed',
                'network_send_performed': false,
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );
      final client = ClinicalContinuityReconciliationClient(
        facilityContextClient: _FakeFacilityContextClient(),
      );

      final result = await client.releaseHeldMessage(
        itemId: '22222222-2222-4222-8222-222222222222',
        idempotencyKey: 'held-i05-47',
        request: ClinicalContinuityHeldMessageReleaseRequest(
          expectedVersion: 4,
          releaseReasonCode: ClinicalContinuityHeldMessageReleaseReason
              .downstreamReadinessConfirmed,
          releaseReasonDetail: 'Downstream evidence was reviewed.',
          expectedSourceStateFingerprint: List.filled(64, 'a').join(),
          safetyAttestationId: '33333333-3333-4333-8333-333333333333',
        ),
      );

      expect(result.disposition?.value, 'applied');
      expect(captured.method, 'POST');
      expect(
        captured.url.path,
        endsWith(
          '/downtime/reconciliation/reconciliation-items/'
          '22222222-2222-4222-8222-222222222222/held-message-release',
        ),
      );
      expect(captured.headers['idempotency-key'], 'held-i05-47');
      expect(captured.headers['x-vh-continuity-facility-id'], '17');
      expect(captured.headers['x-vh-continuity-facility-context'], isNotEmpty);
      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['expected_version'], 4);
      expect(body['safety_attestation_id'], isNotNull);
      expect(body.toString(), isNot(contains('I18')));
    },
  );

  test('rejects a release without a bounded Idempotency-Key', () {
    final client = ClinicalContinuityReconciliationClient(
      facilityContextClient: _FakeFacilityContextClient(),
    );

    expect(
      () => client.releaseHeldMessage(
        itemId: '22222222-2222-4222-8222-222222222222',
        idempotencyKey: ' ',
        request: ClinicalContinuityHeldMessageReleaseRequest(
          expectedVersion: 1,
          releaseReasonCode: ClinicalContinuityHeldMessageReleaseReason
              .ownerRecoveryEvidenceReconciled,
          releaseReasonDetail: 'Owner evidence was reconciled.',
          expectedSourceStateFingerprint: List.filled(64, 'b').join(),
        ),
      ),
      throwsA(
        isA<ClinicalContinuityReconciliationException>().having(
          (error) => error.code,
          'code',
          'CONTINUITY_IDEMPOTENCY_KEY_REQUIRED',
        ),
      ),
    );
  });
}

class _FakeFacilityContextClient
    extends ClinicalContinuityFacilityContextClient {
  @override
  Future<ClinicalContinuityFacilityContext?> current() async =>
      ClinicalContinuityFacilityContext(
        envelope: const {'fixture': 'signed-context'},
        content: const {'facilityId': '17'},
      );
}
