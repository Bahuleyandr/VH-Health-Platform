import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:vhhealth/core/config/store_urls.dart';
import 'package:vhhealth/core/outage/patient_outage_config.dart';
import 'package:vhhealth/core/services/minimum_version_policy.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/utils/log_sanitizer.dart';

typedef MinimumVersionConfigRequest =
    Future<ApiResponse> Function(Duration timeout);
typedef MinimumVersionClock = DateTime Function();

enum MinimumVersionGateReason {
  disabled,
  current,
  signedGrace,
  updateRequired,
  bootstrapGrace,
  policyUnavailable,
  clockUncertain,
}

class MinimumVersionGateResult {
  const MinimumVersionGateResult({
    required this.updateRequired,
    required this.currentVersionCode,
    required this.minPatientVersionCode,
    required this.storeUrl,
    required this.reason,
    this.inGracePeriod = false,
    this.graceEndsAt,
  });

  final bool updateRequired;
  final int currentVersionCode;
  final int minPatientVersionCode;
  final String storeUrl;
  final MinimumVersionGateReason reason;
  final bool inGracePeriod;
  final DateTime? graceEndsAt;
}

class MinimumVersionGateService {
  MinimumVersionGateService._();

  static const defaultTimeout = Duration(seconds: 5);
  static const bootstrapGraceDuration = Duration(hours: 24);
  static const _maxClockSkew = Duration(minutes: 5);

  static Future<MinimumVersionGateResult> check({
    MinimumVersionConfigRequest request = _defaultRequest,
    String? currentBuildNumber,
    TargetPlatform? platform,
    Duration timeout = defaultTimeout,
    MinimumVersionClock clock = DateTime.now,
    MinimumVersionPolicyStateStore? stateStore,
    Map<String, PublicKey>? trustedKeys,
  }) async {
    final storeUrl = StoreUrls.forTargetPlatform(
      platform ?? defaultTargetPlatform,
    );
    final currentCode = await _currentCode(currentBuildNumber);
    final now = clock().toUtc();
    final store = stateStore ?? MinimumVersionPolicyStateStore.production();
    final verifier = MinimumVersionPolicyVerifier(
      trustedKeys: trustedKeys ?? MinimumVersionPolicyTrust.fromBuild(),
    );
    final stored = await store.loadPolicy(verifier);
    if (stored.corrupted) {
      return _closed(
        currentCode: currentCode,
        storeUrl: storeUrl,
        reason: MinimumVersionGateReason.policyUnavailable,
      );
    }

    Map<String, dynamic>? data;
    try {
      final response = await request(timeout);
      if (response.isSuccess && response.data is Map) {
        data = Map<String, dynamic>.from(response.data as Map);
        if (data.containsKey('outage_communication')) {
          await PatientOutageConfigStore.instance.accept(
            data['outage_communication'],
          );
        }
      }
    } catch (error) {
      if (kDebugMode) {
        debugPrint(
          'MinimumVersionGateService: config unavailable: '
          '${logSafeError(error)}',
        );
      }
    }

    var active = stored.policy;
    final legacyMinimum = data == null
        ? null
        : _strictConfigInt(data['min_patient_version_code']);
    final hasPolicy = data?.containsKey('minimum_version_policy') ?? false;
    final candidate = hasPolicy
        ? await verifier.verify(data!['minimum_version_policy'])
        : null;

    if (candidate != null && legacyMinimum == candidate.minPatientVersionCode) {
      final previous = active;
      final isSame =
          previous != null &&
          candidate.revision == previous.revision &&
          candidate.sameEnvelopeAs(previous);
      final advances =
          previous == null ||
          (candidate.revision > previous.revision &&
              candidate.minPatientVersionCode >=
                  previous.minPatientVersionCode);
      if (isSame) {
        active = previous;
      } else if (advances) {
        if (!await store.savePolicy(candidate)) {
          return _closed(
            currentCode: currentCode,
            minPatientVersionCode: candidate.minPatientVersionCode,
            storeUrl: storeUrl,
            reason: MinimumVersionGateReason.policyUnavailable,
          );
        }
        active = candidate;
      }
    }

    if (active != null) {
      await store.clearUnavailable();
      return _evaluatePolicy(
        policy: active,
        currentCode: currentCode,
        storeUrl: storeUrl,
        now: now,
      );
    }

    // A clean response with an absent signed envelope and an explicit zero
    // legacy projection is the only unsigned disabled state. Non-zero legacy
    // values and malformed/present-but-invalid envelopes never become local
    // update authority.
    if (data != null && !hasPolicy && legacyMinimum == 0) {
      await store.clearUnavailable();
      return _allow(
        currentCode: currentCode,
        storeUrl: storeUrl,
        reason: MinimumVersionGateReason.disabled,
      );
    }

    return _unavailableDecision(
      store: store,
      currentCode: currentCode,
      storeUrl: storeUrl,
      now: now,
    );
  }

  static Future<MinimumVersionGateResult> _unavailableDecision({
    required MinimumVersionPolicyStateStore store,
    required int currentCode,
    required String storeUrl,
    required DateTime now,
  }) async {
    final unavailable = await store.markUnavailable(now);
    final first = unavailable.firstUnavailableAt;
    if (unavailable.corrupted || first == null) {
      return _closed(
        currentCode: currentCode,
        storeUrl: storeUrl,
        reason: MinimumVersionGateReason.policyUnavailable,
      );
    }
    if (now.isBefore(first.subtract(_maxClockSkew))) {
      return _closed(
        currentCode: currentCode,
        storeUrl: storeUrl,
        reason: MinimumVersionGateReason.clockUncertain,
      );
    }
    final graceEndsAt = first.add(bootstrapGraceDuration);
    if (now.isBefore(graceEndsAt)) {
      return _allow(
        currentCode: currentCode,
        storeUrl: storeUrl,
        reason: MinimumVersionGateReason.bootstrapGrace,
        inGracePeriod: true,
        graceEndsAt: graceEndsAt,
      );
    }
    return _closed(
      currentCode: currentCode,
      storeUrl: storeUrl,
      reason: MinimumVersionGateReason.policyUnavailable,
    );
  }

  static MinimumVersionGateResult _evaluatePolicy({
    required MinimumVersionPolicy policy,
    required int currentCode,
    required String storeUrl,
    required DateTime now,
  }) {
    if (currentCode >= policy.minPatientVersionCode) {
      return _allow(
        currentCode: currentCode,
        minPatientVersionCode: policy.minPatientVersionCode,
        storeUrl: storeUrl,
        reason: MinimumVersionGateReason.current,
      );
    }
    if (now.isBefore(policy.issuedAt.subtract(_maxClockSkew))) {
      return _closed(
        currentCode: currentCode,
        minPatientVersionCode: policy.minPatientVersionCode,
        storeUrl: storeUrl,
        reason: MinimumVersionGateReason.clockUncertain,
      );
    }
    if (now.isBefore(policy.graceUntil)) {
      return _allow(
        currentCode: currentCode,
        minPatientVersionCode: policy.minPatientVersionCode,
        storeUrl: storeUrl,
        reason: MinimumVersionGateReason.signedGrace,
        inGracePeriod: true,
        graceEndsAt: policy.graceUntil,
      );
    }
    return _closed(
      currentCode: currentCode,
      minPatientVersionCode: policy.minPatientVersionCode,
      storeUrl: storeUrl,
      reason: MinimumVersionGateReason.updateRequired,
    );
  }

  static MinimumVersionGateResult _allow({
    required int currentCode,
    int minPatientVersionCode = 0,
    required String storeUrl,
    required MinimumVersionGateReason reason,
    bool inGracePeriod = false,
    DateTime? graceEndsAt,
  }) => MinimumVersionGateResult(
    updateRequired: false,
    currentVersionCode: currentCode,
    minPatientVersionCode: minPatientVersionCode,
    storeUrl: storeUrl,
    reason: reason,
    inGracePeriod: inGracePeriod,
    graceEndsAt: graceEndsAt,
  );

  static MinimumVersionGateResult _closed({
    required int currentCode,
    int minPatientVersionCode = 0,
    required String storeUrl,
    required MinimumVersionGateReason reason,
  }) => MinimumVersionGateResult(
    updateRequired: true,
    currentVersionCode: currentCode,
    minPatientVersionCode: minPatientVersionCode,
    storeUrl: storeUrl,
    reason: reason,
  );

  static Future<int> _currentCode(String? supplied) async {
    try {
      return _parseNonNegativeInt(
        supplied ?? (await PackageInfo.fromPlatform()).buildNumber,
      );
    } catch (_) {
      return 0;
    }
  }

  static int? _strictConfigInt(Object? value) =>
      value is int && value >= 0 && value <= 9007199254740991 ? value : null;

  static int _parseNonNegativeInt(String value) {
    final parsed = int.tryParse(value.trim());
    return parsed != null && parsed >= 0 ? parsed : 0;
  }

  static Future<ApiResponse> _defaultRequest(Duration timeout) =>
      VHHttpClient.get('/config', auth: false, timeout: timeout);
}
