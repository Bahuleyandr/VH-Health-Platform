import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/appointments/services/appointment_deep_link_loader.dart';
import 'package:vhhealth/features/appointments/services/appointment_feed_repository.dart';

void main() {
  test(
    'hydrates the route ID from the guarded appointment detail response',
    () async {
      int? requestedId;
      final loader = ApiAppointmentDeepLinkLoader(
        detailRequest: (id) async {
          requestedId = id;
          return const ApiResponse(
            statusCode: 200,
            isSuccess: true,
            data: {
              'appointment': {
                'id': '42',
                'doctor_name': 'Dr Rao',
                'department': 'Cardiology',
                'appointment_date': '2026-08-27T00:00:00.000Z',
                'appointment_time': '10:30',
                'status': 'CONFIRMED',
                'visit_type': 'TELE',
              },
            },
          );
        },
      );

      final result = await loader.load(42);

      expect(requestedId, 42);
      expect(result, isA<AppointmentHydrated>());
      final hydrated = result as AppointmentHydrated;
      expect(hydrated.fromCache, isFalse);
      expect(hydrated.appointment.id, 42);
      expect(hydrated.appointment.status, 'confirmed');
      expect(hydrated.appointment.isTeleconsult, isTrue);
    },
  );

  test(
    'rejects a response whose resource does not match the path ID',
    () async {
      final loader = ApiAppointmentDeepLinkLoader(
        detailRequest: (_) async => const ApiResponse(
          statusCode: 200,
          isSuccess: true,
          data: {
            'appointment': {'id': 99},
          },
        ),
      );

      final result = await loader.load(42) as AppointmentHydrationFailed;
      expect(result.kind, AppointmentHydrationFailureKind.malformedResponse);
    },
  );

  test('rejects a fractional resource identifier', () async {
    final loader = ApiAppointmentDeepLinkLoader(
      detailRequest: (_) async => const ApiResponse(
        statusCode: 200,
        isSuccess: true,
        data: {
          'appointment': {'id': 42.5},
        },
      ),
    );

    final result = await loader.load(42) as AppointmentHydrationFailed;
    expect(result.kind, AppointmentHydrationFailureKind.malformedResponse);
  });

  for (final entry in <int, AppointmentHydrationFailureKind>{
    401: AppointmentHydrationFailureKind.unauthenticated,
    403: AppointmentHydrationFailureKind.forbidden,
    404: AppointmentHydrationFailureKind.notFound,
  }.entries) {
    test('${entry.key} never falls back to a stale authorized copy', () async {
      final feed = _FeedRepository(_cachedAppointments([_appointmentJson(42)]));
      final loader = ApiAppointmentDeepLinkLoader(
        detailRequest: (_) async =>
            ApiResponse(statusCode: entry.key, isSuccess: false),
        feedRepository: feed,
        patientIdResolver: () async => '7',
      );

      final result = await loader.load(42) as AppointmentHydrationFailed;

      expect(result.kind, entry.value);
      expect(feed.fetchCount, 0);
    });
  }

  test(
    'offline cold start uses the encrypted profile-scoped feed copy',
    () async {
      final feed = _FeedRepository(_cachedAppointments([_appointmentJson(42)]));
      final loader = ApiAppointmentDeepLinkLoader(
        detailRequest: (_) async => const ApiResponse(
          statusCode: 503,
          isSuccess: false,
          code: 'PATIENT_OUTAGE_CACHE_ONLY',
        ),
        feedRepository: feed,
        patientIdResolver: () async => '7',
      );

      final result = await loader.load(42) as AppointmentHydrated;

      expect(result.fromCache, isTrue);
      expect(result.appointment.id, 42);
      expect(result.staleLabel, '2 hours old');
      expect(feed.patientId, '7');
    },
  );

  test(
    'offline cold start fails closed when the ID is absent from cache',
    () async {
      final loader = ApiAppointmentDeepLinkLoader(
        detailRequest: (_) async => const ApiResponse(
          statusCode: 503,
          isSuccess: false,
          code: 'PATIENT_OUTAGE_CACHE_ONLY',
        ),
        feedRepository: _FeedRepository(
          _cachedAppointments([_appointmentJson(41)]),
        ),
        patientIdResolver: () async => '7',
      );

      final result = await loader.load(42) as AppointmentHydrationFailed;
      expect(result.kind, AppointmentHydrationFailureKind.offlineUnavailable);
    },
  );

  test('offline patient identity resolution failure is contained', () async {
    final loader = ApiAppointmentDeepLinkLoader(
      detailRequest: (_) async => const ApiResponse(
        statusCode: 503,
        isSuccess: false,
        code: 'PATIENT_OUTAGE_CACHE_ONLY',
      ),
      patientIdResolver: () async => throw StateError('storage unavailable'),
    );

    final result = await loader.load(42) as AppointmentHydrationFailed;
    expect(result.kind, AppointmentHydrationFailureKind.offlineUnavailable);
  });
}

Map<String, dynamic> _appointmentJson(int id) => {
  'id': id,
  'doctor_name': 'Dr Rao',
  'department': 'Cardiology',
  'appointment_date': '2026-08-27',
  'appointment_time': '10:30',
  'status': 'CONFIRMED',
};

CachedApiResponse _cachedAppointments(List<Map<String, dynamic>> appointments) {
  return CachedApiResponse(
    response: ApiResponse(
      statusCode: 200,
      isSuccess: true,
      data: {'appointments': appointments},
    ),
    fromCache: true,
    staleLabel: '2 hours old',
    cachedAt: DateTime.utc(2026, 8, 26, 10),
  );
}

class _FeedRepository implements AppointmentFeedRepository {
  _FeedRepository(this.result);

  final CachedApiResponse result;
  int fetchCount = 0;
  String? patientId;

  @override
  Future<CachedApiResponse> fetch(String patientId) async {
    fetchCount += 1;
    this.patientId = patientId;
    return result;
  }

  @override
  Future<void> invalidate(String patientId) async {}

  @override
  Future<DateTime?> cachedAt(String patientId) async => result.cachedAt;
}
