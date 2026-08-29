import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/medical_api_service.dart';

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
    'clinical-order verification sends the caller-owned command key',
    () async {
      late http.Request captured;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 42, 'status': 'verified'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final result = await MedicalApiService.verifyOrder(
        42,
        idempotencyKey: 'clinical-order-verify:test-42',
      );

      expect(result['status'], 'verified');
      expect(captured.method, 'PUT');
      expect(captured.url.path, endsWith('/emr/orders/42/verify'));
      expect(
        captured.headers['idempotency-key'],
        'clinical-order-verify:test-42',
      );
      expect(jsonDecode(captured.body), <String, dynamic>{});
    },
  );

  test(
    'clinical-order terminal actions send caller-owned command keys',
    () async {
      final cases = <({
        String path,
        String key,
        Map<String, dynamic> body,
        Future<Map<String, dynamic>> Function() invoke,
      })>[
        (
          path: '/emr/orders/42/discontinue',
          key: 'clinical-order-terminal:discontinue:test-42',
          body: const {'reason': 'Therapy changed'},
          invoke: () => MedicalApiService.discontinueClinicalOrder(
            orderId: 42,
            reason: 'Therapy changed',
            idempotencyKey: 'clinical-order-terminal:discontinue:test-42',
          ),
        ),
        (
          path: '/emr/orders/42/cancel',
          key: 'clinical-order-terminal:cancel:test-42',
          body: const {'reason': 'Entered in error'},
          invoke: () => MedicalApiService.cancelClinicalOrder(
            orderId: 42,
            reason: 'Entered in error',
            idempotencyKey: 'clinical-order-terminal:cancel:test-42',
          ),
        ),
        (
          path: '/emr/orders/42/complete',
          key: 'clinical-order-terminal:complete:test-42',
          body: const {},
          invoke: () => MedicalApiService.completeOrder(
            42,
            idempotencyKey: 'clinical-order-terminal:complete:test-42',
          ),
        ),
      ];

      for (final testCase in cases) {
        late http.Request captured;
        VHHttpClient.setClientForTesting(
          MockClient((request) async {
            captured = request;
            return http.Response(
              jsonEncode({
                'success': true,
                'data': {'id': 42, 'status': 'ok'},
              }),
              200,
              headers: {'content-type': 'application/json'},
            );
          }),
        );

        await testCase.invoke();

        expect(captured.method, 'PUT');
        expect(captured.url.path, endsWith(testCase.path));
        expect(captured.headers['idempotency-key'], testCase.key);
        expect(jsonDecode(captured.body), testCase.body);
      }
    },
  );

  test('terminal UI actions retain and retire caller-owned attempts', () {
    final ordersSource = File(
      'lib/features/emr/screens/orders_screen.dart',
    ).readAsStringSync();
    final drugChartSource = File(
      'lib/features/ipd/screens/drug_chart_screen.dart',
    ).readAsStringSync();

    expect(
      ordersSource,
      contains(
        r"final attemptScope = 'clinical-order-terminal:complete:$id';",
      ),
    );
    expect(
      ordersSource,
      contains(r"final attemptScope = 'clinical-order-terminal:$action:$id';"),
    );
    expect(
      RegExp(r'_terminalOrderAttempts\.complete\(attemptScope\);')
          .allMatches(ordersSource),
      hasLength(2),
    );
    expect(
      drugChartSource,
      contains(
        r"final attemptScope = 'clinical-order-terminal:discontinue:$orderId';",
      ),
    );
    expect(
      RegExp(r'_terminalOrderAttempts\.complete\(attemptScope\);')
          .allMatches(drugChartSource),
      hasLength(1),
    );
    expect(drugChartSource, isNot(contains("_asInt(order['id']) ?? 0")));
  });
}
