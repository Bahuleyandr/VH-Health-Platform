import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/api_client.dart';
import 'package:vhhealth_staff/core/services/idempotency_attempt_registry.dart';
import 'package:vhhealth_staff/features/emr/screens/order_composer_screen.dart';
import 'package:vhhealth_staff/features/ipd/screens/drug_chart_screen.dart';
import 'package:vhhealth_staff/features/productivity/screens/order_sets_screen.dart';

Map<String, dynamic> _snapshot(Map<String, dynamic> body) =>
    jsonDecode(jsonEncode(body)) as Map<String, dynamic>;

void main() {
  test(
    'Drug Chart retries one ambiguous attempt then rotates after success',
    () async {
      final attempts = IdempotencyAttemptRegistry();
      const body = <String, dynamic>{
        'patient_uid': 'patient-1',
        'order_type': 'medication',
        'details': {
          'catalog_id': 11,
          'quantity_requested': 10,
          'unit': 'tablet',
        },
      };
      final requests = <Map<String, dynamic>>[];

      Future<Map<String, dynamic>> send(
        String key,
        Map<String, dynamic> value,
      ) async {
        requests.add({'key': key, 'body': _snapshot(value)});
        if (requests.length == 1) throw TimeoutException('ambiguous response');
        return {
          'order': {'id': requests.length},
        };
      }

      await expectLater(
        submitDrugChartOrderAttempt(
          attempts: attempts,
          scope: 'drug-chart-row',
          body: body,
          send: send,
        ),
        throwsA(isA<TimeoutException>()),
      );
      await submitDrugChartOrderAttempt(
        attempts: attempts,
        scope: 'drug-chart-row',
        body: body,
        send: send,
      );
      await submitDrugChartOrderAttempt(
        attempts: attempts,
        scope: 'drug-chart-row',
        body: body,
        send: send,
      );

      expect(requests[1]['key'], requests[0]['key']);
      expect(requests[1]['body'], requests[0]['body']);
      expect(requests[2]['key'], isNot(requests[1]['key']));
      expect(requests[2]['body'], requests[1]['body']);
    },
  );

  test('composer retains key and body across a retryable 5xx', () async {
    final attempts = IdempotencyAttemptRegistry();
    const body = <String, dynamic>{
      'orders': [
        {'patient_uid': 'patient-2', 'order_type': 'investigation'},
      ],
    };
    final requests = <Map<String, dynamic>>[];

    Future<ApiResponse> send(String key, Map<String, dynamic> value) async {
      requests.add({'key': key, 'body': _snapshot(value)});
      return requests.length == 1
          ? const ApiResponse(statusCode: 503, isSuccess: false)
          : const ApiResponse(statusCode: 201, isSuccess: true);
    }

    final failed = await submitOrderComposerAttempt(
      attempts: attempts,
      scope: 'composer',
      body: body,
      send: send,
    );
    expect(failed.isSuccess, isFalse);
    await submitOrderComposerAttempt(
      attempts: attempts,
      scope: 'composer',
      body: body,
      send: send,
    );
    await submitOrderComposerAttempt(
      attempts: attempts,
      scope: 'composer',
      body: body,
      send: send,
    );

    expect(requests[1], requests[0]);
    expect(requests[2]['key'], isNot(requests[1]['key']));
    expect(requests[2]['body'], requests[1]['body']);
  });

  test(
    'order set retries an ambiguous timeout as the same logical attempt',
    () async {
      final attempts = IdempotencyAttemptRegistry();
      const body = <String, dynamic>{
        'orders': [
          {'patient_uid': 'patient-3', 'order_type': 'nursing'},
        ],
      };
      final requests = <Map<String, dynamic>>[];

      Future<ApiResponse> send(String key, Map<String, dynamic> value) async {
        requests.add({'key': key, 'body': _snapshot(value)});
        if (requests.length == 1) throw TimeoutException('ambiguous response');
        return const ApiResponse(statusCode: 201, isSuccess: true);
      }

      await expectLater(
        submitOrderSetAttempt(
          attempts: attempts,
          scope: 'order-set',
          body: body,
          send: send,
        ),
        throwsA(isA<TimeoutException>()),
      );
      await submitOrderSetAttempt(
        attempts: attempts,
        scope: 'order-set',
        body: body,
        send: send,
      );
      await submitOrderSetAttempt(
        attempts: attempts,
        scope: 'order-set',
        body: body,
        send: send,
      );

      expect(requests[1], requests[0]);
      expect(requests[2]['key'], isNot(requests[1]['key']));
      expect(requests[2]['body'], requests[1]['body']);
    },
  );
}
