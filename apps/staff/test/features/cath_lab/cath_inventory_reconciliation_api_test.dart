import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/features/cath_lab/services/cath_lab_api_service.dart';

Map<String, dynamic> _reconciliation(String status) => {
  'case_id': 7,
  'usage_id': 73,
  'patient_uid': '11111111-1111-4111-8111-111111111111',
  'item_name': 'Drug-eluting stent',
  'catalog_item_id': 17,
  'inventory_item_id': 83,
  'inventory_batch_id': 93,
  'batch_number': 'BATCH-93',
  'documented_quantity': '2.0000',
  'decremented_quantity': status == 'decremented' ? '2.0000' : '0.0000',
  'remaining_quantity': status == 'decremented' ? '3.0000' : '0.0000',
  'inventory_decrement_status': status,
  'inventory_warning': status == 'decremented' ? '' : 'Stock unavailable',
  'task_id': 103,
  'task_status': status == 'decremented' ? 'completed' : 'open',
  'workflow_sla_instance_id': '22222222-2222-4222-8222-222222222222',
  'sla_status': status == 'decremented' ? 'completed' : 'active',
  'due_at': '2026-08-28T12:00:00.000Z',
  'actionable': status != 'decremented',
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

  test('GET loads the exact case and usage reconciliation target', () async {
    late http.Request captured;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'reconciliation': _reconciliation('insufficient_stock')},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final detail = await CathLabApiService.fetchInventoryReconciliation(
      '7',
      '73',
    );

    expect(
      captured.url.path,
      endsWith('/cath-lab/cases/7/consumables/73/inventory-reconcile'),
    );
    expect(captured.method, 'GET');
    expect(detail.matchesTarget(caseId: '7', usageId: '73'), isTrue);
    expect(detail.inventoryItemId, '83');
    expect(detail.actionable, isTrue);
  });

  test(
    'GET preserves canonical signed BIGINT identifiers as strings',
    () async {
      const caseId = '9223372036854775806';
      const usageId = '9223372036854775807';
      late http.Request captured;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured = request;
          final reconciliation = _reconciliation('insufficient_stock')
            ..['case_id'] = caseId
            ..['usage_id'] = usageId;
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'reconciliation': reconciliation},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final detail = await CathLabApiService.fetchInventoryReconciliation(
        caseId,
        usageId,
      );

      expect(
        captured.url.path,
        endsWith(
          '/cath-lab/cases/$caseId/consumables/$usageId/inventory-reconcile',
        ),
      );
      expect(detail.caseId, caseId);
      expect(detail.usageId, usageId);
    },
  );

  test(
    'API rejects identifiers above signed BIGINT before transport',
    () async {
      var requests = 0;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          requests++;
          return http.Response('{}', 500);
        }),
      );

      await expectLater(
        CathLabApiService.fetchInventoryReconciliation(
          '9223372036854775808',
          '73',
        ),
        throwsArgumentError,
      );
      await expectLater(
        CathLabApiService.reconcileConsumableInventory(
          '7',
          '9223372036854775808',
          idempotencyKey: 'must-not-send',
        ),
        throwsArgumentError,
      );
      expect(requests, 0);
    },
  );

  test(
    'POST has no selector body and carries the explicit stable key',
    () async {
      late http.Request captured;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'outcome': 'completed',
                'reconciliation': _reconciliation('decremented'),
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final reconciliationKey = ['cath', 'inventory', '7', '73'].join('-');
      final result = await CathLabApiService.reconcileConsumableInventory(
        '7',
        '73',
        idempotencyKey: reconciliationKey,
      );

      expect(
        captured.url.path,
        endsWith('/cath-lab/cases/7/consumables/73/inventory-reconcile'),
      );
      expect(captured.method, 'POST');
      expect(captured.body, isEmpty);
      expect(captured.headers['Idempotency-Key'], reconciliationKey);
      expect(result.outcome, 'completed');
      expect(result.reconciliation.isCompleted, isTrue);
    },
  );
}
