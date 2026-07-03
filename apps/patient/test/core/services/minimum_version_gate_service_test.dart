import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth/core/config/store_urls.dart';
import 'package:vhhealth/core/services/minimum_version_gate_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('MinimumVersionGateService', () {
    test('blocks when current build number is below backend minimum', () async {
      final result = await MinimumVersionGateService.check(
        client: MockClient(
          (_) async => http.Response(
            jsonEncode({
              'data': {'min_patient_version_code': 3},
            }),
            200,
          ),
        ),
        currentBuildNumber: '2',
        platform: TargetPlatform.android,
      );

      expect(result.updateRequired, isTrue);
      expect(result.currentVersionCode, 2);
      expect(result.minPatientVersionCode, 3);
      expect(result.storeUrl, StoreUrls.androidStoreUrl);
    });

    test(
      'allows when gate is disabled or current build satisfies minimum',
      () async {
        final disabled = await MinimumVersionGateService.check(
          client: MockClient(
            (_) async => http.Response(
              jsonEncode({
                'data': {'min_patient_version_code': 0},
              }),
              200,
            ),
          ),
          currentBuildNumber: '1',
          platform: TargetPlatform.iOS,
        );
        final currentEnough = await MinimumVersionGateService.check(
          client: MockClient(
            (_) async => http.Response(
              jsonEncode({
                'data': {'min_patient_version_code': 2},
              }),
              200,
            ),
          ),
          currentBuildNumber: '2',
          platform: TargetPlatform.android,
        );

        expect(disabled.updateRequired, isFalse);
        expect(disabled.storeUrl, StoreUrls.iosStoreUrl);
        expect(currentEnough.updateRequired, isFalse);
        expect(currentEnough.minPatientVersionCode, 2);
      },
    );

    test('accepts camelCase or string payload fields', () async {
      final result = await MinimumVersionGateService.check(
        client: MockClient(
          (_) async => http.Response(
            jsonEncode({
              'data': {'minPatientVersionCode': '9'},
            }),
            200,
          ),
        ),
        currentBuildNumber: '8',
        platform: TargetPlatform.android,
      );

      expect(result.updateRequired, isTrue);
      expect(result.minPatientVersionCode, 9);
    });

    test('fails open on backend or network errors', () async {
      final backendError = await MinimumVersionGateService.check(
        client: MockClient((_) async => http.Response('unavailable', 503)),
        currentBuildNumber: '1',
        platform: TargetPlatform.android,
      );
      final networkError = await MinimumVersionGateService.check(
        client: MockClient((_) async => throw Exception('offline')),
        currentBuildNumber: '1',
        platform: TargetPlatform.android,
      );

      expect(backendError.updateRequired, isFalse);
      expect(networkError.updateRequired, isFalse);
    });
  });
}
