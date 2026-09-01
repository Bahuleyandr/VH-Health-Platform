import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/billing_api_service.dart';

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
    'materializes funding from the exact order and optional server-bound claim',
    () async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(
            request.url.path,
            endsWith('/billing/v2/pharmacy-funding/orders/17/materialize'),
          );
          expect(request.method, 'POST');
          expect(jsonDecode(request.body), {'tpa_claim_id': 23});
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'status': 'blocked',
                'fundingRecovery': {
                  'task_id': '81',
                  'status': 'open',
                  'owner_role': 'INSURANCE_COORDINATOR',
                  'deep_link': '/billing-desk?pharmacy_order_id=17&invoice_item_id=71&tpa_claim_id=23',
                },
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final result =
          await BillingApiService.materializePharmacyFundingAuthority(
            pharmacyOrderId: 17,
            tpaClaimId: 23,
          );
      expect(result['status'], 'blocked');
      expect(
        (result['fundingRecovery'] as Map)['owner_role'],
        'INSURANCE_COORDINATOR',
      );
    },
  );
}
