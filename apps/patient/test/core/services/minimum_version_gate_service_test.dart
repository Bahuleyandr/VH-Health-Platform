import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/core/config/store_urls.dart';
import 'package:vhhealth/core/outage/patient_outage_config.dart';
import 'package:vhhealth/core/services/minimum_version_gate_service.dart';
import 'package:vhhealth/core/services/minimum_version_policy.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_core/services/clinical_continuity_canonical_json.dart';
import 'package:vhhealth_core/services/http_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late KeyPair signingKey;
  late PublicKey publicKey;
  late Map<String, String> storage;
  late MinimumVersionPolicyStateStore stateStore;
  late DateTime now;

  setUpAll(() async {
    signingKey = await Ed25519().newKeyPair();
    publicKey = await signingKey.extractPublicKey();
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await PatientOutageConfigStore.instance.resetForTesting();
    storage = <String, String>{};
    stateStore = MinimumVersionPolicyStateStore.forTesting(
      read: (key) async => storage[key],
      write: (key, value) async => storage[key] = value,
      delete: (key) async => storage.remove(key),
    );
    now = DateTime.utc(2026, 8, 13, 12);
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
  });

  group('MinimumVersionGateService signed policy', () {
    test('verifies the backend RFC 8785 and Ed25519 signing vector', () async {
      final verifier = MinimumVersionPolicyVerifier(
        trustedKeys: {
          'node-vector': SimplePublicKey(
            base64Decode('3vx2EFhqPBtAmVWKnT90ZfdeelxuOzv8AbuRkPXwyzo='),
            type: KeyPairType.ed25519,
          ),
        },
      );

      final policy = await verifier.verify({
        'algorithm': 'Ed25519',
        'format': 'vhhealth_patient_minimum_version/v1',
        'key_id': 'node-vector',
        'policy': {
          'audience': 'vhhealth-patient-minimum-version',
          'tenant_id': TenantConfig.id,
          'revision': 11,
          'min_patient_version_code': 77,
          'issued_at': '2026-08-13T00:00:00.000Z',
          'grace_until': '2026-08-14T00:00:00.000Z',
        },
        'signature': 'dEvzHRUpLdcKanrE4nJZ6uTgpUuYU6e59w+vQ0EgfeppKfRS7o5XIUD2Zvxm+AckussaA64OTqFsFx38vojHBQ==',
      });

      expect(policy?.revision, 11);
      expect(policy?.minPatientVersionCode, 77);
    });

    test('blocks an obsolete build after the signed grace deadline', () async {
      final policy = await _signedPolicy(
        signingKey: signingKey,
        revision: 1,
        minimum: 3,
        issuedAt: now.subtract(const Duration(days: 1)),
        graceUntil: now.subtract(const Duration(minutes: 1)),
      );

      final result = await _check(
        stateStore: stateStore,
        publicKey: publicKey,
        now: now,
        currentBuildNumber: '2',
        response: _success(policy, minimum: 3),
      );

      expect(result.updateRequired, isTrue);
      expect(result.reason, MinimumVersionGateReason.updateRequired);
      expect(result.currentVersionCode, 2);
      expect(result.minPatientVersionCode, 3);
      expect(result.storeUrl, StoreUrls.androidStoreUrl);
    });

    test('honors the bounded signed grace and current build floor', () async {
      final policy = await _signedPolicy(
        signingKey: signingKey,
        revision: 1,
        minimum: 3,
        issuedAt: now,
        graceUntil: now.add(const Duration(days: 1)),
      );

      final grace = await _check(
        stateStore: stateStore,
        publicKey: publicKey,
        now: now,
        currentBuildNumber: '2',
        response: _success(policy, minimum: 3),
      );
      final current = await _check(
        stateStore: stateStore,
        publicKey: publicKey,
        now: now,
        currentBuildNumber: '3',
        response: _success(policy, minimum: 3),
      );

      expect(grace.updateRequired, isFalse);
      expect(grace.inGracePeriod, isTrue);
      expect(grace.reason, MinimumVersionGateReason.signedGrace);
      expect(grace.graceEndsAt, now.add(const Duration(days: 1)));
      expect(current.updateRequired, isFalse);
      expect(current.reason, MinimumVersionGateReason.current);
    });

    test('enforces the monotonic last-known floor on rollback', () async {
      final revisionTwo = await _signedPolicy(
        signingKey: signingKey,
        revision: 2,
        minimum: 5,
        issuedAt: now.subtract(const Duration(days: 1)),
        graceUntil: now.subtract(const Duration(minutes: 1)),
      );
      final rollback = await _signedPolicy(
        signingKey: signingKey,
        revision: 1,
        minimum: 0,
        issuedAt: now.subtract(const Duration(days: 1)),
        graceUntil: now.subtract(const Duration(minutes: 1)),
      );
      await _check(
        stateStore: stateStore,
        publicKey: publicKey,
        now: now,
        currentBuildNumber: '6',
        response: _success(revisionTwo, minimum: 5),
      );

      final result = await _check(
        stateStore: stateStore,
        publicKey: publicKey,
        now: now,
        currentBuildNumber: '4',
        response: _success(rollback, minimum: 0),
      );

      expect(result.updateRequired, isTrue);
      expect(result.minPatientVersionCode, 5);
      expect(result.reason, MinimumVersionGateReason.updateRequired);
    });

    test(
      'enforces last-known policy when the backend is unavailable',
      () async {
        final policy = await _signedPolicy(
          signingKey: signingKey,
          revision: 4,
          minimum: 9,
          issuedAt: now.subtract(const Duration(days: 1)),
          graceUntil: now.subtract(const Duration(minutes: 1)),
        );
        await _check(
          stateStore: stateStore,
          publicKey: publicKey,
          now: now,
          currentBuildNumber: '10',
          response: _success(policy, minimum: 9),
        );

        final result = await MinimumVersionGateService.check(
          request: (_) async => throw Exception('offline'),
          currentBuildNumber: '8',
          platform: TargetPlatform.android,
          clock: () => now,
          stateStore: stateStore,
          trustedKeys: {'test-key': publicKey},
        );

        expect(result.updateRequired, isTrue);
        expect(result.minPatientVersionCode, 9);
      },
    );

    test(
      'does not treat an invalid signed field as update authority',
      () async {
        final policy = await _signedPolicy(
          signingKey: signingKey,
          revision: 1,
          minimum: 9,
          issuedAt: now,
          graceUntil: now.add(const Duration(days: 1)),
        );
        policy['signature'] = base64Encode(List<int>.filled(64, 0));

        final result = await _check(
          stateStore: stateStore,
          publicKey: publicKey,
          now: now,
          currentBuildNumber: '1',
          response: _success(policy, minimum: 9),
        );

        expect(result.updateRequired, isFalse);
        expect(result.inGracePeriod, isTrue);
        expect(result.reason, MinimumVersionGateReason.bootstrapGrace);
        expect(result.minPatientVersionCode, 0);
      },
    );

    test('keeps signed activation held without a release trust key', () async {
      final policy = await _signedPolicy(
        signingKey: signingKey,
        revision: 1,
        minimum: 9,
        issuedAt: now,
        graceUntil: now.add(const Duration(days: 1)),
      );

      final result = await MinimumVersionGateService.check(
        request: (_) async => _success(policy, minimum: 9),
        currentBuildNumber: '1',
        platform: TargetPlatform.android,
        clock: () => now,
        stateStore: stateStore,
        trustedKeys: const {},
      );

      expect(result.reason, MinimumVersionGateReason.bootstrapGrace);
      expect(result.inGracePeriod, isTrue);
    });
  });

  group('MinimumVersionGateService unavailable-policy semantics', () {
    test('allows one bounded bootstrap grace then fails closed', () async {
      Future<MinimumVersionGateResult> check() =>
          MinimumVersionGateService.check(
            request: (_) async => throw Exception('offline'),
            currentBuildNumber: '1',
            platform: TargetPlatform.iOS,
            clock: () => now,
            stateStore: stateStore,
            trustedKeys: {'test-key': publicKey},
          );

      final first = await check();
      expect(first.updateRequired, isFalse);
      expect(first.inGracePeriod, isTrue);
      expect(first.reason, MinimumVersionGateReason.bootstrapGrace);
      expect(first.storeUrl, StoreUrls.iosStoreUrl);

      now = now.add(MinimumVersionGateService.bootstrapGraceDuration);
      final expired = await check();
      expect(expired.updateRequired, isTrue);
      expect(expired.reason, MinimumVersionGateReason.policyUnavailable);
    });

    test(
      'rejects clock rollback against the persisted bootstrap marker',
      () async {
        await MinimumVersionGateService.check(
          request: (_) async => throw Exception('offline'),
          currentBuildNumber: '1',
          clock: () => now,
          stateStore: stateStore,
          trustedKeys: {'test-key': publicKey},
        );
        now = now.subtract(const Duration(minutes: 6));

        final result = await MinimumVersionGateService.check(
          request: (_) async => throw Exception('offline'),
          currentBuildNumber: '1',
          clock: () => now,
          stateStore: stateStore,
          trustedKeys: {'test-key': publicKey},
        );

        expect(result.updateRequired, isTrue);
        expect(result.reason, MinimumVersionGateReason.clockUncertain);
      },
    );

    test('allows only the explicit unsigned disabled response', () async {
      final result = await MinimumVersionGateService.check(
        request: (_) async => const ApiResponse(
          statusCode: 200,
          isSuccess: true,
          data: {'min_patient_version_code': 0},
        ),
        currentBuildNumber: '1',
        clock: () => now,
        stateStore: stateStore,
        trustedKeys: {'test-key': publicKey},
      );

      expect(result.updateRequired, isFalse);
      expect(result.reason, MinimumVersionGateReason.disabled);
    });
  });

  // ── The CRIT: an operator who sets MIN_PATIENT_VERSION_CODE without also
  // provisioning PATIENT_MINIMUM_VERSION_POLICY_JSON used to hard-block EVERY
  // install 24h later, including installs already above that code, and
  // including their SOS path. `/config` answers cleanly with the bare legacy
  // projection and no `minimum_version_policy` key, which the gate refused to
  // read as anything but "policy unavailable".
  group('MinimumVersionGateService unsigned legacy contract', () {
    Future<MinimumVersionGateResult> checkLegacy({
      required String currentBuildNumber,
      required Object? minimum,
      Map<String, PublicKey> trustedKeys = const {},
    }) => MinimumVersionGateService.check(
      request: (_) async => ApiResponse(
        statusCode: 200,
        isSuccess: true,
        data: {'min_patient_version_code': minimum},
      ),
      currentBuildNumber: currentBuildNumber,
      platform: TargetPlatform.android,
      clock: () => now,
      stateStore: stateStore,
      trustedKeys: trustedKeys.isEmpty ? {'test-key': publicKey} : trustedKeys,
    );

    test('a non-zero unsigned minimum clears a build at or above it, and never '
        'turns into a block once the bootstrap grace expires', () async {
      final first = await checkLegacy(currentBuildNumber: '50', minimum: 42);
      expect(first.updateRequired, isFalse);
      expect(first.reason, MinimumVersionGateReason.legacyCurrent);
      expect(first.minPatientVersionCode, 42);

      // The defect was a DELAYED brick: the first 24h looked healthy
      // (bootstrapGrace) and every install died afterwards. Walk past the
      // grace twice over and prove the answer does not change.
      now = now.add(MinimumVersionGateService.bootstrapGraceDuration * 2);
      final afterGrace = await checkLegacy(
        currentBuildNumber: '50',
        minimum: 42,
      );
      expect(afterGrace.updateRequired, isFalse);
      expect(afterGrace.reason, MinimumVersionGateReason.legacyCurrent);

      // Exactly at the minimum is "current", not "below".
      final atFloor = await checkLegacy(currentBuildNumber: '42', minimum: 42);
      expect(atFloor.updateRequired, isFalse);
    });

    test('the same unsigned minimum still blocks a build below it', () async {
      final result = await checkLegacy(currentBuildNumber: '1', minimum: 42);

      expect(result.updateRequired, isTrue);
      expect(result.reason, MinimumVersionGateReason.legacyUpdateRequired);
      expect(result.minPatientVersionCode, 42);
      expect(result.storeUrl, StoreUrls.androidStoreUrl);
    });

    test('a malformed unsigned projection reads as no minimum', () async {
      final result = await checkLegacy(
        currentBuildNumber: '1',
        minimum: 'forty-two',
      );

      expect(result.updateRequired, isFalse);
      expect(result.reason, MinimumVersionGateReason.disabled);
    });

    test(
      'an unsigned response never becomes a persisted local floor',
      () async {
        await checkLegacy(currentBuildNumber: '50', minimum: 42);

        // Nothing about an unsigned value may outlive the response that
        // carried it: only a VERIFIED policy reaches savePolicy.
        expect(
          storage.keys.where((key) => key.contains('minimum_version_policy')),
          isEmpty,
        );
      },
    );

    test('a build with no trust anchor cannot verify anything, so an unusable '
        'config never closes the gate', () async {
      Future<MinimumVersionGateResult> check() =>
          MinimumVersionGateService.check(
            request: (_) async => throw Exception('offline'),
            currentBuildNumber: '1',
            platform: TargetPlatform.android,
            clock: () => now,
            stateStore: stateStore,
            trustedKeys: const {},
          );

      final first = await check();
      expect(first.reason, MinimumVersionGateReason.bootstrapGrace);
      expect(first.updateRequired, isFalse);

      now = now.add(MinimumVersionGateService.bootstrapGraceDuration);
      final expired = await check();
      expect(
        expired.updateRequired,
        isFalse,
        reason:
            'MinimumVersionPolicyTrust.fromBuild() returns an empty map for '
            'this artifact, so no envelope can ever verify — closing would '
            'enforce nothing and brick every install',
      );
      expect(expired.reason, MinimumVersionGateReason.policyUnenforceable);
    });
  });

  // ── The related HIGH: a stored snapshot that no longer re-verifies used to
  // return _closed(policyUnavailable) before /config was even consulted.
  group('MinimumVersionGateService stored-policy re-verification', () {
    test(
      'a snapshot stored under a different ApiConfig.baseUrl falls back to the '
      'legacy comparison instead of hard-blocking',
      () async {
        final policy = await _signedPolicy(
          signingKey: signingKey,
          revision: 1,
          minimum: 3,
          issuedAt: now,
          graceUntil: now.add(const Duration(days: 1)),
        );
        // The ordinary QA-build-then-production-build case on one device.
        storage['patient.minimum_version_policy.v1.'
            '${TenantConfig.cacheNamespace}'] = jsonEncode({
          'source': 'https://another-flavour.example/api/v1',
          'envelope': policy,
        });

        final result = await MinimumVersionGateService.check(
          request: (_) async => const ApiResponse(
            statusCode: 200,
            isSuccess: true,
            data: {'min_patient_version_code': 0},
          ),
          currentBuildNumber: '1',
          platform: TargetPlatform.android,
          clock: () => now,
          stateStore: stateStore,
          trustedKeys: {'test-key': publicKey},
        );

        expect(result.updateRequired, isFalse);
        expect(result.reason, MinimumVersionGateReason.disabled);
      },
    );

    test('a snapshot this build has no key for falls back to the legacy '
        'comparison instead of hard-blocking', () async {
      final otherKey = await Ed25519().newKeyPair();
      final otherPublicKey = await otherKey.extractPublicKey();
      final policy = await _signedPolicy(
        signingKey: signingKey,
        revision: 1,
        minimum: 3,
        issuedAt: now,
        graceUntil: now.add(const Duration(days: 1)),
      );
      await _check(
        stateStore: stateStore,
        publicKey: publicKey,
        now: now,
        currentBuildNumber: '9',
        response: _success(policy, minimum: 3),
      );
      expect(
        storage.keys.where((key) => key.contains('minimum_version_policy')),
        isNotEmpty,
      );

      // A rotated / differently-stamped artifact reading the same device.
      final result = await MinimumVersionGateService.check(
        request: (_) async => const ApiResponse(
          statusCode: 200,
          isSuccess: true,
          data: {'min_patient_version_code': 5},
        ),
        currentBuildNumber: '9',
        platform: TargetPlatform.android,
        clock: () => now,
        stateStore: stateStore,
        trustedKeys: {'rotated-key': otherPublicKey},
      );

      expect(result.updateRequired, isFalse);
      expect(result.reason, MinimumVersionGateReason.legacyCurrent);
      expect(result.minPatientVersionCode, 5);
    });

    test(
      'a re-verifiable stored policy still blocks a build genuinely below its '
      'minimum',
      () async {
        final policy = await _signedPolicy(
          signingKey: signingKey,
          revision: 3,
          minimum: 11,
          issuedAt: now.subtract(const Duration(days: 1)),
          graceUntil: now.subtract(const Duration(minutes: 1)),
        );
        await _check(
          stateStore: stateStore,
          publicKey: publicKey,
          now: now,
          currentBuildNumber: '12',
          response: _success(policy, minimum: 11),
        );

        // The unsigned fallback must NOT be reachable while a verified policy
        // is in force — a stripped envelope cannot downgrade a device that has
        // already seen the signed one.
        final result = await MinimumVersionGateService.check(
          request: (_) async => const ApiResponse(
            statusCode: 200,
            isSuccess: true,
            data: {'min_patient_version_code': 0},
          ),
          currentBuildNumber: '4',
          platform: TargetPlatform.android,
          clock: () => now,
          stateStore: stateStore,
          trustedKeys: {'test-key': publicKey},
        );

        expect(result.updateRequired, isTrue);
        expect(result.reason, MinimumVersionGateReason.updateRequired);
        expect(result.minPatientVersionCode, 11);
      },
    );
  });

  test('uses canonical unauthenticated VHHttpClient transport', () async {
    late http.Request captured;
    final policy = await _signedPolicy(
      signingKey: signingKey,
      revision: 1,
      minimum: 0,
      issuedAt: now,
      graceUntil: now,
    );
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'min_patient_version_code': 0,
              'minimum_version_policy': policy,
            },
          }),
          200,
        );
      }),
    );

    final result = await MinimumVersionGateService.check(
      currentBuildNumber: '1',
      platform: TargetPlatform.android,
      clock: () => now,
      stateStore: stateStore,
      trustedKeys: {'test-key': publicKey},
    );

    expect(result.updateRequired, isFalse);
    expect(captured.url.path, endsWith('/api/v1/config'));
    expect(
      captured.headers.keys.map((key) => key.toLowerCase()),
      isNot(contains('authorization')),
    );
  });

  test(
    'accepts bounded outage communication from the same config fetch',
    () async {
      final messages = {
        for (final locale in ['en', 'hi', 'ta', 'te', 'ml'])
          locale: '$locale approved [facility contact number]',
      };

      await MinimumVersionGateService.check(
        request: (_) async => ApiResponse(
          statusCode: 200,
          isSuccess: true,
          data: {
            'min_patient_version_code': 0,
            'outage_communication': {
              'revision': 8,
              'messages': messages,
              'facility_contact_number': '+91 44 4511 4511',
            },
          },
        ),
        currentBuildNumber: '2',
        clock: () => now,
        stateStore: stateStore,
        trustedKeys: {'test-key': publicKey},
      );

      expect(PatientOutageConfigStore.instance.current?.revision, 8);
      expect(PatientOutageConfigStore.instance.current?.messages, messages);
    },
  );
}

Future<MinimumVersionGateResult> _check({
  required MinimumVersionPolicyStateStore stateStore,
  required PublicKey publicKey,
  required DateTime now,
  required String currentBuildNumber,
  required ApiResponse response,
}) => MinimumVersionGateService.check(
  request: (_) async => response,
  currentBuildNumber: currentBuildNumber,
  platform: TargetPlatform.android,
  clock: () => now,
  stateStore: stateStore,
  trustedKeys: {'test-key': publicKey},
);

ApiResponse _success(Map<String, Object?> policy, {required int minimum}) =>
    ApiResponse(
      statusCode: 200,
      isSuccess: true,
      data: {
        'min_patient_version_code': minimum,
        'minimum_version_policy': policy,
      },
    );

Future<Map<String, Object?>> _signedPolicy({
  required KeyPair signingKey,
  required int revision,
  required int minimum,
  required DateTime issuedAt,
  required DateTime graceUntil,
}) async {
  final unsigned = <String, Object?>{
    'algorithm': 'Ed25519',
    'format': MinimumVersionPolicyVerifier.format,
    'key_id': 'test-key',
    'policy': <String, Object?>{
      'audience': MinimumVersionPolicyVerifier.audience,
      'tenant_id': TenantConfig.id,
      'revision': revision,
      'min_patient_version_code': minimum,
      'issued_at': issuedAt.toUtc().toIso8601String(),
      'grace_until': graceUntil.toUtc().toIso8601String(),
    },
  };
  final signature = await Ed25519().sign(
    ClinicalContinuityCanonicalJson.canonicalBytes(unsigned),
    keyPair: signingKey,
  );
  return {...unsigned, 'signature': base64Encode(signature.bytes)};
}
