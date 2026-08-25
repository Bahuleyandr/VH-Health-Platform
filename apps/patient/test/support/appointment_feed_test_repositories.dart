// Test doubles for [AppointmentFeedRepository].
//
// The production repository reads `/appointments/patient/:id` through
// `ApiClient.cachedGet`, which touches the encrypted on-disk cache. Real file
// I/O never completes inside `testWidgets`' fake async, so a widget test that
// let it run would hang in `pumpAndSettle` rather than fail. Widget tests
// therefore inject one of these — the same way every other cached patient
// screen injects its repository.
//
// What that leaves unproven is pinned separately, in
// `appointments_list_tab_state_test.dart`: that the production default really
// is `ApiAppointmentFeedRepository`, and that it really uses `cachedGet`.

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/appointments/services/appointment_feed_repository.dart';

/// Goes to the network (i.e. the installed MockClient) and never to disk —
/// the shape these screens had before the feed became cache-first.
class LiveOnlyAppointmentFeedRepository implements AppointmentFeedRepository {
  const LiveOnlyAppointmentFeedRepository();

  @override
  Future<CachedApiResponse> fetch(String patientId) async {
    final response = await ApiClient.get(appointmentFeedPath(patientId));
    return CachedApiResponse(
      response: response,
      fromCache: false,
      staleLabel: null,
    );
  }

  @override
  Future<void> invalidate(String patientId) async {}

  @override
  Future<DateTime?> cachedAt(String patientId) async => null;
}

/// Serves canned rows as a CACHED copy, with an as-of timestamp — what
/// `ApiClient.cachedGet` hands back when the hospital is unreachable.
class CachedAppointmentFeedRepository implements AppointmentFeedRepository {
  CachedAppointmentFeedRepository({
    this.rows = const [],
    this.cachedAtValue,
    this.staleLabel,
  });

  final List<Map<String, dynamic>> rows;
  final DateTime? cachedAtValue;
  final String? staleLabel;

  /// Patient ids this repository was asked for, in order.
  final fetchedFor = <String>[];

  @override
  Future<CachedApiResponse> fetch(String patientId) async {
    fetchedFor.add(patientId);
    return CachedApiResponse(
      response: ApiResponse(
        statusCode: 200,
        isSuccess: true,
        data: {'appointments': rows},
        raw: {
          'data': {'appointments': rows},
        },
      ),
      fromCache: cachedAtValue != null,
      staleLabel: staleLabel,
      cachedAt: cachedAtValue,
    );
  }

  @override
  Future<void> invalidate(String patientId) async {}

  @override
  Future<DateTime?> cachedAt(String patientId) async => cachedAtValue;
}
