import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/clinical_inbox_api_service.dart';

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

  test('sends a durable break-glass record id when one is supplied', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(
          request.url.path,
          endsWith('/clinical-inbox/tasks/71/acknowledge'),
        );
        expect(jsonDecode(request.body), {'break_glass_id': 42});
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'id': '71', 'status': 'in_progress'},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final task = await ClinicalInboxApiService.instance.acknowledgeTask(
      '71',
      breakGlassId: 42,
    );

    expect(task.id, '71');
    expect(task.status, 'in_progress');
  });
}
