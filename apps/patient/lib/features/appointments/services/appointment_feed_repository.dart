// lib/features/appointments/services/appointment_feed_repository.dart
//
// One owner for the patient appointment feed `/appointments/patient/:id`.
//
// That path is a CACHE KEY as well as a URL: DashboardProvider reads it through
// `ApiClient.cachedGet`, so an encrypted copy of the patient's appointments is
// already on disk. "My Appointments" and the calendar read the same feed, and
// both used to read it with the plain client — so the dashboard listed the
// patient's appointments offline while the two screens they open TO SEE those
// appointments showed a load error over data already on the device.
//
// The path therefore lives in exactly one place ([appointmentFeedPath]); a
// test compares it against `DashboardProvider.debugAppointmentPath`, because
// the moment the two spellings drift the screens stop sharing an entry and the
// offline copy silently disappears again.
//
// The repository deliberately hands back the raw [CachedApiResponse]: every
// caller keeps its own parsing and its own failure wording, so the text a
// screen shows when the read fails is still that screen's own localized
// string. What the switch DID change is the whole point of it — when the
// hospital is unreachable and a copy is on disk, these screens now render
// that copy with its as-of label where they used to render an error.
//
// The localisation half of that holds only because `ApiClient.cachedGet`'s
// offline-and-no-cache branch carries a `code` and no `message`:
// `ApiResponse.failureMessage` prefers `message` over the fallback it is
// handed, so a display string invented down there would out-rank
// `appointmentsLoadFailed` and put untranslated English in front of all five
// locales. `test/core/outage/api_client_outage_test.dart` pins that branch.

import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/services/api_client.dart';

/// The cache key / URL for one patient's appointment feed.
String appointmentFeedPath(String patientId) =>
    '/appointments/patient/$patientId';

abstract class AppointmentFeedRepository {
  /// Cache-first read. `fromCache` / `staleLabel` / `cachedAt` on the result
  /// are what the screens show in their OfflineBanner, so a cached list always
  /// states its as-of time instead of reading as live.
  Future<CachedApiResponse> fetch(String patientId);

  /// Drop the cached copy — used where it is known-superseded (a realtime
  /// appointment event, an explicit pull-to-refresh, a local mutation).
  Future<void> invalidate(String patientId);

  /// When the copy currently on disk was written. Read after a background
  /// refresh lands so the as-of label moves forward with the data.
  Future<DateTime?> cachedAt(String patientId);
}

class ApiAppointmentFeedRepository implements AppointmentFeedRepository {
  const ApiAppointmentFeedRepository();

  @override
  Future<CachedApiResponse> fetch(String patientId) =>
      ApiClient.cachedGet(appointmentFeedPath(patientId));

  @override
  Future<void> invalidate(String patientId) =>
      ApiCacheManager.invalidate(appointmentFeedPath(patientId));

  @override
  Future<DateTime?> cachedAt(String patientId) async =>
      (await ApiCacheManager.load(appointmentFeedPath(patientId)))?.cachedAt;
}
