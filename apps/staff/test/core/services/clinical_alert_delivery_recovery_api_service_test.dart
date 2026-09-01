import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/clinical_alert_delivery_recovery_api_service.dart';

Map<String, dynamic> recoveryCase({
  String id = '9223372036854775806',
  String kind = 'recipient_coverage',
  String status = 'open',
}) => {
  'case_id': id,
  'case_kind': kind,
  'case_status': status,
  'obligation_id': '9223372036854775805',
  'source_table': 'clinical_orders',
  'source_id': '73',
  'failure_kind': 'order_mar_schedule',
  'obligation_status': kind == 'manual_hold' ? 'manual_hold' : 'pending',
  'task_status': 'open',
  'sla_status': 'active',
  'open_age_seconds': 91,
  'overdue': true,
  'escalation_attempt_count': 2,
  'due_at': '2026-08-27T10:00:00Z',
  'escalated_at': '2026-08-27T10:01:00Z',
  'last_error_code': 'no_active_clinical_recipients',
  'manual_hold_code': kind == 'manual_hold' ? 'INTENT_INVALID' : null,
  'manual_hold_reason': kind == 'manual_hold'
      ? 'Immutable evidence held.'
      : null,
  'resolution_kind': null,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  test(
    'lists and reads exact cases without narrowing bigint identities',
    () async {
      final requests = <http.Request>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          requests.add(request);
          final data = request.url.path.endsWith('/9223372036854775806')
              ? recoveryCase()
              : {
                  'cases': [recoveryCase()],
                  'count': 1,
                  'limit': 100,
                };
          return http.Response(
            jsonEncode({'success': true, 'data': data}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );
      final service = ClinicalAlertDeliveryRecoveryApiService();

      final list = await service.listOpenCases();
      final detail = await service.getCase('9223372036854775806');

      expect(list.single.caseId, '9223372036854775806');
      expect(detail.obligationId, '9223372036854775805');
      expect(detail.overdue, isTrue);
      expect(detail.escalationAttemptCount, 2);
      expect(requests[0].url.queryParameters, {
        'status': 'open',
        'limit': '100',
      });
      expect(requests[1].url.queryParameters, isEmpty);
    },
  );

  test(
    'retry sends reason only and reuses its key after an uncertain response',
    () async {
      final requests = <http.Request>[];
      var attempt = 0;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          requests.add(request);
          attempt += 1;
          if (attempt == 1) {
            return http.Response(
              jsonEncode({'success': false, 'message': 'conflict'}),
              409,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'case_id': '42',
                'obligation_id': '73',
                'action_id': '91',
                'outcome': 'awaiting_recipients',
                'replayed': true,
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );
      final service = ClinicalAlertDeliveryRecoveryApiService();
      const reason = 'Roster evidence was checked before this governed retry.';

      await expectLater(
        service.retry(caseId: '42', reason: reason),
        throwsException,
      );
      final replay = await service.retry(caseId: '42', reason: reason);

      expect(replay.replayed, isTrue);
      expect(requests, hasLength(2));
      expect(requests[0].method, 'POST');
      expect(requests[0].url.path, endsWith('/recovery-cases/42/retry'));
      expect(jsonDecode(requests[0].body), {'reason': reason});
      expect(
        requests[1].headers['idempotency-key'],
        requests[0].headers['idempotency-key'],
      );
    },
  );

  test(
    'supersede is separate and rejects invalid ids or short reasons',
    () async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.url.path, endsWith('/recovery-cases/42/supersede'));
          expect(jsonDecode(request.body), {
            'reason':
                'Reviewed the immutable source and approved supersession.',
          });
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'case_id': 42,
                'obligation_id': 73,
                'action_id': 91,
                'outcome': 'superseded',
                'replayed': false,
                'replacement_obligation_id': 74,
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );
      final service = ClinicalAlertDeliveryRecoveryApiService();
      final action = await service.supersede(
        caseId: '42',
        reason: 'Reviewed the immutable source and approved supersession.',
      );

      expect(action.outcome, 'superseded');
      expect(action.replacementObligationId, '74');
      await expectLater(service.getCase('../42'), throwsFormatException);
      await expectLater(
        service.retry(caseId: '42', reason: 'short'),
        throwsFormatException,
      );
    },
  );

  test('case parser rejects unregistered workflow kinds', () {
    expect(
      () => ClinicalAlertDeliveryRecoveryCase.fromJson(
        recoveryCase(kind: 'arbitrary_clinical_intent'),
      ),
      throwsFormatException,
    );
  });
}
