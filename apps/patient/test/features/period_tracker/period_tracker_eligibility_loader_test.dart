import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/period_tracker/services/period_tracker_eligibility_loader.dart';

void main() {
  group('period tracker eligibility policy', () {
    final now = DateTime(2026, 8, 26);

    test('accepts the governed age boundaries for a female profile', () {
      expect(
        isPeriodTrackerEligible(
          gender: 'FEMALE',
          birthday: '2016-08-26',
          now: now,
        ),
        isTrue,
      );
      expect(
        isPeriodTrackerEligible(gender: 'f', birthday: '1971-08-26', now: now),
        isTrue,
      );
    });

    test('rejects out-of-range, malformed, and other profiles', () {
      for (final profile in <(String?, String?)>[
        ('FEMALE', '2017-08-26'),
        ('FEMALE', '1970-08-26'),
        ('MALE', '2000-01-01'),
        (null, '2000-01-01'),
        ('FEMALE', 'not-a-date'),
      ]) {
        expect(
          isPeriodTrackerEligible(
            gender: profile.$1,
            birthday: profile.$2,
            now: now,
          ),
          isFalse,
          reason: '$profile',
        );
      }
    });
  });

  test('cold link rechecks the authenticated command-center profile', () async {
    final loader = ApiPeriodTrackerEligibilityLoader(
      commandCenterRequest: () async =>
          _commandCenter(gender: 'FEMALE', birthday: '2000-01-01'),
    );

    expect(await loader.load(), isA<PeriodTrackerEligible>());
  });

  test('a successful but ineligible profile remains fail closed', () async {
    final loader = ApiPeriodTrackerEligibilityLoader(
      commandCenterRequest: () async =>
          _commandCenter(gender: 'MALE', birthday: '2000-01-01'),
    );

    expect(await loader.load(), isA<PeriodTrackerIneligible>());
  });

  test('expired session is typed and never consults an offline copy', () async {
    var cacheCalled = false;
    final loader = ApiPeriodTrackerEligibilityLoader(
      commandCenterRequest: () async =>
          const ApiResponse(statusCode: 401, isSuccess: false),
      cachedCommandCenterRequest: () async {
        cacheCalled = true;
        return _cachedCommandCenter();
      },
    );

    final result = await loader.load() as PeriodTrackerEligibilityFailed;
    expect(result.kind, PeriodTrackerEligibilityFailureKind.unauthenticated);
    expect(cacheCalled, isFalse);
  });

  test(
    'offline cold start rechecks the profile from encrypted cache',
    () async {
      final loader = ApiPeriodTrackerEligibilityLoader(
        commandCenterRequest: () async => const ApiResponse(
          statusCode: 503,
          isSuccess: false,
          code: 'PATIENT_OUTAGE_CACHE_ONLY',
        ),
        cachedCommandCenterRequest: () async => _cachedCommandCenter(),
      );

      expect(await loader.load(), isA<PeriodTrackerEligible>());
    },
  );
}

ApiResponse _commandCenter({required String gender, required String birthday}) {
  return ApiResponse(
    statusCode: 200,
    isSuccess: true,
    data: {
      'profile': {'gender': gender, 'birthday': birthday},
    },
  );
}

CachedApiResponse _cachedCommandCenter() {
  return CachedApiResponse(
    response: _commandCenter(gender: 'FEMALE', birthday: '2000-01-01'),
    fromCache: true,
    staleLabel: '2 hours old',
  );
}
