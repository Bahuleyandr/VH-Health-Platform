import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/features/pharmacy/services/ward_indent_gateway.dart';

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
    'proposed-catalog inventory reads carry the exact indent facility',
    () async {
      var call = 0;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          call += 1;
          expect(request.url.queryParameters['facility_id'], '8');
          if (call == 1) {
            expect(request.url.path, endsWith('/pharmacy/inventory/v2/items'));
            expect(request.url.queryParameters['catalog_id'], '102');
            expect(request.url.queryParameters['status'], 'active');
            return http.Response(
              jsonEncode({
                'success': true,
                'data': {
                  'items': [
                    {
                      'id': 501,
                      'catalog_id': 102,
                      'facility_id': 8,
                      'display_name': 'Exact proposed stock',
                    },
                  ],
                },
              }),
              200,
              headers: {'content-type': 'application/json'},
            );
          }

          expect(request.url.path, endsWith('/pharmacy/inventory/v2/batches'));
          expect(request.url.queryParameters['item_id'], '501');
          expect(request.url.queryParameters['status'], 'in_stock');
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'batches': [
                  {
                    'id': 601,
                    'inventory_item_id': 501,
                    'batch_number': 'B-501',
                    'remaining_quantity': 3,
                  },
                ],
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      const gateway = ApiWardIndentGateway();
      final items = await gateway.listInventoryItems(
        facilityId: 8,
        catalogId: 102,
      );
      final batches = await gateway.listInventoryBatches(501, facilityId: 8);

      expect(items.single.facilityId, 8);
      expect(items.single.catalogId, 102);
      expect(batches.single.inventoryItemId, 501);
      expect(call, 2);
    },
  );
}
