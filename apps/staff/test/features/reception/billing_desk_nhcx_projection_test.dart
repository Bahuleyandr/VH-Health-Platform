import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/features/reception/screens/billing_desk_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      'staff_role': 'INSURANCE_COORDINATOR',
    });
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  testWidgets('deep link retries only the local accepted NHCX projection', (
    tester,
  ) async {
    final hash = 'a'.padRight(64, 'a');
    var applied = false;
    var postCount = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, contains('/insurance/nhcx/projections/42'));
        if (request.method == 'POST') {
          postCount += 1;
          applied = true;
          expect(request.url.path, endsWith('/retry'));
          expect(request.headers['idempotency-key'], isNotEmpty);
          expect(jsonDecode(request.body), {
            'expected_transport_response_sha256': hash,
          });
        }
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'message_id': 42,
              'cycle': 'claim',
              'claim_id': 88,
              'preauth_id': 77,
              'patient_uid': '11111111-1111-4111-8111-111111111111',
              'admission_id': 7001,
              'status': 'accepted',
              'transport_accepted_at': '2026-08-29T08:00:00.000Z',
              'transport_http_status': 202,
              'transport_response_sha256': hash,
              'transport_gateway_reference': 'GW-42',
              'projection_status': applied
                  ? 'applied'
                  : 'reconciliation_required',
              'projection_error': applied ? null : 'Local projection failed',
              'projection_evidence': <String, dynamic>{},
              'task_id': 71,
              'task_status': applied ? 'completed' : 'open',
              'owner_role': 'INSURANCE_COORDINATOR',
              'deep_link': '/billing-desk?nhcx_projection_message_id=42',
              'next_action': applied
                  ? 'nhcx_projection_complete'
                  : 'retry_accepted_nhcx_projection',
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await tester.binding.setSurfaceSize(const Size(1200, 1800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('en'),
        supportedLocales: AppStrings.supportedLocales,
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: const BillingDeskScreen(prefillNhcxProjectionMessageId: 42),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Accepted NHCX local projection'), findsOneWidget);
    expect(find.textContaining('never resends to NHCX'), findsOneWidget);
    await tester.tap(find.text('Retry local projection'));
    await tester.pumpAndSettle();

    expect(postCount, 1);
    expect(find.text('Local projection completed'), findsOneWidget);
  });
}
