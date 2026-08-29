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

  test('reads and retries only the accepted local NHCX projection', () async {
    final hash = 'a'.padRight(64, 'a');
    final requests = <http.Request>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        requests.add(request);
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'message_id': 42,
              'projection_status': request.method == 'POST'
                  ? 'applied'
                  : 'reconciliation_required',
              'transport_response_sha256': hash,
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final recovery =
        await BillingApiService.getAcceptedNhcxProjectionRecovery(42);
    expect(recovery['projection_status'], 'reconciliation_required');

    final applied = await BillingApiService.retryAcceptedNhcxProjection(
      messageId: 42,
      expectedTransportResponseSha256: 'A'.padRight(64, 'A'),
      idempotencyKey: 'nhcx-projection-42',
    );
    expect(applied['projection_status'], 'applied');
    expect(requests[0].method, 'GET');
    expect(
      requests[0].url.path,
      endsWith('/insurance/nhcx/projections/42'),
    );
    expect(requests[1].method, 'POST');
    expect(
      requests[1].url.path,
      endsWith('/insurance/nhcx/projections/42/retry'),
    );
    expect(requests[1].headers['idempotency-key'], 'nhcx-projection-42');
    expect(jsonDecode(requests[1].body), {
      'expected_transport_response_sha256': hash,
    });
  });
}
