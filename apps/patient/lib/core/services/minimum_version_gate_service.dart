import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:vhhealth/core/config/store_urls.dart';
import 'package:vhhealth/core/outage/patient_outage_config.dart';
import 'package:vhhealth/core/services/minimum_version_policy.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/utils/log_sanitizer.dart';

typedef MinimumVersionConfigRequest = Future<ApiResponse> Function(
  Duration timeout,
);
typedef MinimumVersionClock = DateTime Function();

enum MinimumVersionGateReason {
  disabled,
  current,
  signedGrace,
  updateRequired,
  bootstrapGrace,
  policyUnavailable,
  clockUncertain,

  /// The backend answered cleanly, offered NO signed envelope at all, and the
  /// unsigned `min_patient_version_code` projection cleared this build.
  ///
  /// Distinct from [current] so telemetry can tell "a signed policy says you
  /// are current" apart from "the legacy contract says you are current".
  legacyCurrent,

  /// Same clean unsigned response, but the build is below the legacy minimum.
  /// This is the pre-signing hard-upgrade contract doing exactly what
  /// `MIN_PATIENT_VERSION_CODE` has always meant.
  legacyUpdateRequired,

  /// The `/config` response is unusable AND closing the gate could not enforce
  /// anything: this artifact carries no `VH_PATIENT_MIN_VERSION_*` trust
  /// anchor, so it can never verify a signed policy envelope no matter how
  /// long it waits. Closing such a build is not a safety measure, it is a
  /// brick — see [MinimumVersionGateService._unavailableDecision].
  policyUnenforceable,
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
    // A stored snapshot that no longer re-verifies is NOT a close.
    //
    // It used to be: `stored.corrupted` returned `_closed(policyUnavailable)`
    // here, before `/config` had even been consulted. That hard-blocked the
    // app on the two ORDINARY causes of a failed re-verification —
    // `ApiConfig.baseUrl` differing between builds/flavours, and a build whose
    // `VH_PATIENT_MIN_VERSION_*` trust anchors differ from the build that
    // wrote the snapshot — neither of which is evidence that the install is
    // below any minimum. An unverifiable blob proves nothing in EITHER
    // direction, so it is carried forward as "no verified policy" and the
    // decision is made from the freshest authority actually available below.
    final stored = await store.loadPolicy(verifier);

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

    // No signed policy governs this install.
    //
    // A CLEAN `/config` response that offers no signed envelope AT ALL is the
    // legacy contract, and must be evaluated as the legacy contract — it is
    // what `MIN_PATIENT_VERSION_CODE` has always meant. The previous revision
    // admitted only `legacyMinimum == 0` here and sent every other clean
    // response down the fail-closed path below, which meant an operator who
    // set `MIN_PATIENT_VERSION_CODE` to any non-zero value WITHOUT also
    // provisioning `PATIENT_MINIMUM_VERSION_POLICY_JSON` hard-blocked every
    // install 24h later — including installs already far above that code, and
    // including their SOS path. See _legacyDecision.
    //
    // A present-but-unverifiable envelope is deliberately NOT routed here: it
    // means the backend IS running the signed scheme and this client cannot
    // verify what it was handed, which is a genuine trust failure and keeps
    // the fail-closed treatment it already had.
    if (data != null && !hasPolicy) {
      await store.clearUnavailable();
      return _legacyDecision(
        currentCode: currentCode,
        legacyMinimum: legacyMinimum,
        storeUrl: storeUrl,
      );
    }

    return _unavailableDecision(
      store: store,
      currentCode: currentCode,
      storeUrl: storeUrl,
      now: now,
      // Closing the gate is only a safety measure for an artifact that could
      // ever verify a signed policy. A build stamped with no
      // `VH_PATIENT_MIN_VERSION_*` trust anchor can never turn any envelope
      // into authority — `MinimumVersionPolicyTrust.fromBuild()` returns an
      // empty map and `verify` fails at the key lookup — so waiting out the
      // bootstrap grace and then closing enforces nothing whatsoever and only
      // bricks the install. Every artifact for which this gate can do its job
      // keeps the unchanged fail-closed behaviour.
      canClose: verifier.trustedKeys.isNotEmpty,
    );
  }

  /// The pre-signing hard-upgrade contract, for the case it always covered: a
  /// clean `/config` response that carries no signed envelope.
  ///
  /// The unsigned projection is authority over THIS comparison only. It is
  /// still never persisted and never becomes a local floor — only a verified
  /// policy reaches [MinimumVersionPolicyStateStore.savePolicy] — so an
  /// unsigned value cannot outlive the response that carried it.
  static MinimumVersionGateResult _legacyDecision({
    required int currentCode,
    required int? legacyMinimum,
    required String storeUrl,
  }) {
    // An absent or malformed projection is not a minimum. The backend coerces
    // the same way (`minPatientVersionCodeFromEnv` maps anything unusable to
    // 0), so reading it as "gate disabled" is the faithful interpretation
    // rather than a relaxation.
    final minimum = legacyMinimum ?? 0;
    if (minimum == 0) {
      return _allow(
        currentCode: currentCode,
        storeUrl: storeUrl,
        reason: MinimumVersionGateReason.disabled,
      );
    }
    if (currentCode >= minimum) {
      return _allow(
        currentCode: currentCode,
        minPatientVersionCode: minimum,
        storeUrl: storeUrl,
        reason: MinimumVersionGateReason.legacyCurrent,
      );
    }
    return _closed(
      currentCode: currentCode,
      minPatientVersionCode: minimum,
      storeUrl: storeUrl,
      reason: MinimumVersionGateReason.legacyUpdateRequired,
    );
  }

  static Future<MinimumVersionGateResult> _unavailableDecision({
    required MinimumVersionPolicyStateStore store,
    required int currentCode,
    required String storeUrl,
    required DateTime now,
    required bool canClose,
  }) async {
    final unavailable = await store.markUnavailable(now);
    final first = unavailable.firstUnavailableAt;
    if (unavailable.corrupted || first == null) {
      return _unavailableOutcome(
        canClose: canClose,
        currentCode: currentCode,
        storeUrl: storeUrl,
        reason: MinimumVersionGateReason.policyUnavailable,
      );
    }
    if (now.isBefore(first.subtract(_maxClockSkew))) {
      return _unavailableOutcome(
        canClose: canClose,
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
    return _unavailableOutcome(
      canClose: canClose,
      currentCode: currentCode,
      storeUrl: storeUrl,
      reason: MinimumVersionGateReason.policyUnavailable,
    );
  }

  static MinimumVersionGateResult _unavailableOutcome({
    required bool canClose,
    required int currentCode,
    required String storeUrl,
    required MinimumVersionGateReason reason,
  }) => canClose
      ? _closed(currentCode: currentCode, storeUrl: storeUrl, reason: reason)
      : _allow(
          currentCode: currentCode,
          storeUrl: storeUrl,
          reason: MinimumVersionGateReason.policyUnenforceable,
        );

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
