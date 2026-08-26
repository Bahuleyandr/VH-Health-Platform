import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/services/api_client.dart';

enum PeriodTrackerEligibilityFailureKind {
  unauthenticated,
  offlineUnavailable,
  unavailable,
}

sealed class PeriodTrackerEligibilityResult {
  const PeriodTrackerEligibilityResult();
}

class PeriodTrackerEligible extends PeriodTrackerEligibilityResult {
  const PeriodTrackerEligible();
}

class PeriodTrackerIneligible extends PeriodTrackerEligibilityResult {
  const PeriodTrackerIneligible();
}

class PeriodTrackerEligibilityFailed extends PeriodTrackerEligibilityResult {
  const PeriodTrackerEligibilityFailed(this.kind);

  final PeriodTrackerEligibilityFailureKind kind;
}

abstract interface class PeriodTrackerEligibilityLoader {
  Future<PeriodTrackerEligibilityResult> load();
}

typedef CommandCenterRequest = Future<ApiResponse> Function();
typedef CachedCommandCenterRequest = Future<CachedApiResponse> Function();

Future<ApiResponse> _requestCommandCenter() => ApiClient.get(
  '/portal/command-center',
  timeout: const Duration(seconds: 10),
);

Future<CachedApiResponse> _requestCachedCommandCenter() =>
    ApiClient.cachedGet('/portal/command-center');

class ApiPeriodTrackerEligibilityLoader
    implements PeriodTrackerEligibilityLoader {
  const ApiPeriodTrackerEligibilityLoader({
    this.commandCenterRequest = _requestCommandCenter,
    this.cachedCommandCenterRequest = _requestCachedCommandCenter,
  });

  final CommandCenterRequest commandCenterRequest;
  final CachedCommandCenterRequest cachedCommandCenterRequest;

  @override
  Future<PeriodTrackerEligibilityResult> load() async {
    ApiResponse response;
    try {
      response = await commandCenterRequest();
    } catch (error) {
      if (kDebugMode) {
        debugPrint('Period-tracker eligibility refresh failed: $error');
      }
      return _loadOfflineCopy();
    }

    if (response.isSuccess) return _fromCommandCenter(response.data);
    if (response.statusCode == 401) {
      return const PeriodTrackerEligibilityFailed(
        PeriodTrackerEligibilityFailureKind.unauthenticated,
      );
    }
    if (response.statusCode == 0 ||
        response.statusCode == 502 ||
        response.statusCode == 503 ||
        response.statusCode == 504 ||
        response.code == 'PATIENT_OUTAGE_CACHE_ONLY') {
      return _loadOfflineCopy();
    }
    return const PeriodTrackerEligibilityFailed(
      PeriodTrackerEligibilityFailureKind.unavailable,
    );
  }

  Future<PeriodTrackerEligibilityResult> _loadOfflineCopy() async {
    try {
      final cached = await cachedCommandCenterRequest();
      if (cached.isSuccess) return _fromCommandCenter(cached.data);
    } catch (error) {
      if (kDebugMode) {
        debugPrint('Period-tracker eligibility cache read failed: $error');
      }
    }
    return const PeriodTrackerEligibilityFailed(
      PeriodTrackerEligibilityFailureKind.offlineUnavailable,
    );
  }

  PeriodTrackerEligibilityResult _fromCommandCenter(Object? data) {
    if (data is! Map) {
      return const PeriodTrackerEligibilityFailed(
        PeriodTrackerEligibilityFailureKind.unavailable,
      );
    }
    final profile = data['profile'];
    if (profile is! Map) {
      return const PeriodTrackerEligibilityFailed(
        PeriodTrackerEligibilityFailureKind.unavailable,
      );
    }
    return isPeriodTrackerEligible(
          gender: profile['gender']?.toString(),
          birthday: profile['birthday']?.toString(),
        )
        ? const PeriodTrackerEligible()
        : const PeriodTrackerIneligible();
  }
}

bool isPeriodTrackerEligible({
  required String? gender,
  required String? birthday,
  DateTime? now,
}) {
  final age = _ageYears(birthday, now: now);
  if (age == null || age < 10 || age > 55) return false;
  final normalizedGender = gender?.trim().toLowerCase();
  return normalizedGender == 'female' || normalizedGender == 'f';
}

int? _ageYears(String? birthday, {DateTime? now}) {
  final raw = birthday?.trim();
  if (raw == null || raw.isEmpty) return null;
  final parsed = DateTime.tryParse(raw);
  if (parsed == null) return null;
  final today = now ?? DateTime.now();
  var age = today.year - parsed.year;
  final hadBirthdayThisYear =
      today.month > parsed.month ||
      (today.month == parsed.month && today.day >= parsed.day);
  if (!hadBirthdayThisYear) age -= 1;
  return age < 0 ? null : age;
}
