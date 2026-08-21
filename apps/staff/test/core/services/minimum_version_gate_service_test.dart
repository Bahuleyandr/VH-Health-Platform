import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/config/release_urls.dart';
import 'package:vhhealth_staff/core/services/minimum_version_gate_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    VHHttpClient.resetClientForTesting();
  });

  Future<MinimumVersionGateResult> check({
    required String currentBuildNumber,
    required Object? minimum,
    TargetPlatform platform = TargetPlatform.android,
  }) => MinimumVersionGateService.check(
    request: (_) async => ApiResponse(
      statusCode: 200,
      isSuccess: true,
      data: {'min_staff_version_code': minimum},
    ),
    currentBuildNumber: currentBuildNumber,
    platform: platform,
  );

  group('MinimumVersionGateService minimum comparison', () {
    test('blocks a build below the minimum', () async {
      final result = await check(currentBuildNumber: '1', minimum: 42);

      expect(result.updateRequired, isTrue);
      expect(result.reason, MinimumVersionGateReason.updateRequired);
      expect(result.currentVersionCode, 1);
      expect(result.minStaffVersionCode, 42);
      expect(result.releaseUrl, ReleaseUrls.androidReleaseUrl);
    });

    test('a build exactly at the minimum is current, not below', () async {
      final result = await check(currentBuildNumber: '42', minimum: 42);

      expect(result.updateRequired, isFalse);
      expect(result.reason, MinimumVersionGateReason.current);
      expect(result.minStaffVersionCode, 42);
    });

    test('a build above the minimum is current', () async {
      final result = await check(currentBuildNumber: '50', minimum: 42);

      expect(result.updateRequired, isFalse);
      expect(result.reason, MinimumVersionGateReason.current);
      expect(result.currentVersionCode, 50);
    });

    test('minimum 0 reads as gate disabled', () async {
      final result = await check(currentBuildNumber: '1', minimum: 0);

      expect(result.updateRequired, isFalse);
      expect(result.reason, MinimumVersionGateReason.disabled);
    });

    test('an absent or malformed minimum reads as no minimum', () async {
      final absent = await MinimumVersionGateService.check(
        request: (_) async => const ApiResponse(
          statusCode: 200,
          isSuccess: true,
          data: <String, Object?>{},
        ),
        currentBuildNumber: '1',
        platform: TargetPlatform.android,
      );
      final malformed = await check(
        currentBuildNumber: '1',
        minimum: 'forty-two',
      );
      final negative = await check(currentBuildNumber: '1', minimum: -1);

      expect(absent.updateRequired, isFalse);
      expect(absent.reason, MinimumVersionGateReason.disabled);
      expect(malformed.updateRequired, isFalse);
      expect(malformed.reason, MinimumVersionGateReason.disabled);
      expect(negative.updateRequired, isFalse);
      expect(negative.reason, MinimumVersionGateReason.disabled);
    });
  });

  group('MinimumVersionGateService failure posture', () {
    // The staff gate FAILS OPEN when `/config` is unreachable or unusable.
    // This mirrors the patient gate's posture for an artifact with no signed
    // -policy trust anchor (`policyUnenforceable`): every staff build is in
    // that posture by design, and hard-blocking clinicians on a network blip
    // would be a patient-safety hazard.
    test('an unreachable backend fails OPEN', () async {
      final result = await MinimumVersionGateService.check(
        request: (_) async => throw Exception('offline'),
        currentBuildNumber: '1',
        platform: TargetPlatform.android,
      );

      expect(result.updateRequired, isFalse);
      expect(result.reason, MinimumVersionGateReason.configUnavailable);
    });

    test('a non-success response fails OPEN', () async {
      final result = await MinimumVersionGateService.check(
        request: (_) async =>
            const ApiResponse(statusCode: 503, isSuccess: false),
        currentBuildNumber: '1',
        platform: TargetPlatform.android,
      );

      expect(result.updateRequired, isFalse);
      expect(result.reason, MinimumVersionGateReason.configUnavailable);
    });

    test('a malformed response body fails OPEN', () async {
      final result = await MinimumVersionGateService.check(
        request: (_) async => const ApiResponse(
          statusCode: 200,
          isSuccess: true,
          data: 'not-a-map',
        ),
        currentBuildNumber: '1',
        platform: TargetPlatform.android,
      );

      expect(result.updateRequired, isFalse);
      expect(result.reason, MinimumVersionGateReason.configUnavailable);
    });
  });

  group('MinimumVersionGateService release links', () {
    test('android resolves the release link, iOS resolves its own', () async {
      final android = await check(currentBuildNumber: '1', minimum: 42);
      final ios = await check(
        currentBuildNumber: '1',
        minimum: 42,
        platform: TargetPlatform.iOS,
      );

      expect(android.releaseUrl, ReleaseUrls.androidReleaseUrl);
      expect(android.hasReleaseUrl, isTrue);
      expect(ios.releaseUrl, ReleaseUrls.iosReleaseUrl);
      // No iOS distribution channel is configured by default; the blocking
      // screen must hide its CTA rather than offer a dead link.
      expect(ios.hasReleaseUrl, isFalse);
    });

    test('desktop platforms resolve the shared release link', () async {
      final windows = await check(
        currentBuildNumber: '1',
        minimum: 42,
        platform: TargetPlatform.windows,
      );

      expect(windows.releaseUrl, ReleaseUrls.androidReleaseUrl);
    });
  });

  test('uses canonical unauthenticated VHHttpClient transport', () async {
    late http.Request captured;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'min_staff_version_code': 7},
          }),
          200,
        );
      }),
    );

    final result = await MinimumVersionGateService.check(
      currentBuildNumber: '3',
      platform: TargetPlatform.android,
    );

    expect(result.updateRequired, isTrue);
    expect(result.minStaffVersionCode, 7);
    expect(captured.url.path, endsWith('/api/v1/config'));
    expect(
      captured.headers.keys.map((key) => key.toLowerCase()),
      isNot(contains('authorization')),
    );
  });
}
