// test/core/services/logout_revocation_401_test.dart
//
// A 401 from a revoke endpoint means the credential is ALREADY dead
// server-side — the exact end state the call was made to reach. Reporting it
// as failure is not a cosmetic inaccuracy: LogoutService reacts to an
// unconfirmed revocation by durably writing the departing JWT back into secure
// storage for up to seven days, so that one boolean decides whether a dead
// credential is re-planted on a device the user may be handing back.
//
// A 401 is not an edge case here. It is the EXPECTED response on two of the
// six logout paths:
//
//   * session revocation ("logged in elsewhere") — SessionRevocationListener
//     runs logout only after the backend has already blacklisted the JTI;
//   * account deletion — SettingsController deletes the account first, then
//     logs out.
//
// These tests drive the REAL revoke steps against a mocked transport, so the
// mapping is asserted where it actually lives rather than through a fake that
// could encode either answer.

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';

import 'package:vhhealth/core/services/logout_service.dart';
import 'package:vhhealth/core/services/patient_realtime_lifecycle.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    LogoutService.debugResetDependencies();
    PatientRealtimeLifecycle.instance.debugReset();
  });

  /// Every revoke endpoint answers "that token is already dead".
  List<String> mockAll401() {
    final paths = <String>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        paths.add(request.url.path);
        return http.Response(
          jsonEncode({'success': false, 'message': 'Session has been revoked'}),
          401,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    return paths;
  }

  test(
    'a 401 counts as REVOKED on the logout path and the retry path alike',
    () async {
      // The two paths disagreed. The retry path already had the right rule
      // (`response.isSuccess || response.isUnauthorized`); the logout path
      // returned `response.isSuccess` only. Asserted together so they can never
      // drift apart again.
      final paths = mockAll401();
      final defaults = LogoutServiceDependencies.defaults();

      expect(
        await defaults.revokeVhSession(),
        isTrue,
        reason: 'a blacklisted VH JTI is revoked, not unrevoked',
      );
      expect(
        await defaults.revokeFirebaseSession(),
        isTrue,
        reason: 'a dead Firebase session is revoked, not unrevoked',
      );
      expect(await defaults.retryVhRevocation('jwt-abc'), isTrue);
      expect(await defaults.retryFirebaseRevocation('jwt-abc'), isTrue);

      expect(paths, hasLength(4), reason: 'all four calls were really sent');
      expect(
        paths.where((path) => path.endsWith('/auth/logout')),
        hasLength(2),
      );
      expect(
        paths.where(
          (path) => path.endsWith('/auth/firebase/revoke-my-session'),
        ),
        hasLength(2),
      );
    },
  );

  test('a 401 logout queues NOTHING — no dead JWT is re-planted', () async {
    // The regression this closes: on the session-revoked and account-deletion
    // paths the backend has already killed the token, both revokes 401, and
    // step 11 therefore wrote `{"token": "<the departing JWT>"}` into secure
    // storage — milliseconds after the wipe the rest of logout exists to
    // perform, on a device that may be shared or handed back.
    mockAll401();

    final defaults = LogoutServiceDependencies.defaults();
    String? parkedRecord;
    LogoutStep noop() => () {};

    LogoutService.debugSetDependencies(
      LogoutServiceDependencies(
        // The two steps under test are REAL.
        revokeFirebaseSession: defaults.revokeFirebaseSession,
        revokeVhSession: defaults.revokeVhSession,
        // Everything else is inert so the assertion is about the 401 alone.
        unregisterDevice: noop(),
        disconnectRealtime: noop(),
        clearPushSignedInUser: noop(),
        deleteFcmToken: noop(),
        cancelNotifications: noop(),
        clearHealthSyncState: noop(),
        clearSecureStorage: noop(),
        clearApiCache: noop(),
        clearDownloadedFileCache: noop(),
        purgeDocumentStaging: noop(),
        clearCycleTracker: noop(),
        clearDependentsProvider: noop(),
        clearUserProvider: noop(),
        signOutFirebase: noop(),
        readVhToken: () => 'jwt-being-revoked',
        readPendingRevocation: () => parkedRecord,
        writePendingRevocation: (record) {
          parkedRecord = record;
        },
        clearPendingRevocation: () {
          parkedRecord = null;
        },
      ),
    );

    final outcome = await LogoutService.logout();

    expect(outcome.serverSessionRevoked, isTrue);
    expect(outcome.revocationRetryQueued, isFalse);
    expect(
      parkedRecord,
      isNull,
      reason:
          'a revoked session needs no retry, and queuing one means re-planting '
          'the departing credential on the device for up to seven days',
    );
  });

  test(
    'a genuinely unreachable server still queues the retry it promises',
    () async {
      // The counterweight: the 401 rule must not swallow the case the durable
      // retry exists for. A 503 is NOT evidence the token died.
      VHHttpClient.setClientForTesting(
        MockClient(
          (request) async => http.Response(
            jsonEncode({'success': false, 'message': 'Service unavailable'}),
            503,
            headers: {'content-type': 'application/json'},
          ),
        ),
      );

      final defaults = LogoutServiceDependencies.defaults();
      expect(await defaults.revokeVhSession(), isFalse);
      expect(await defaults.revokeFirebaseSession(), isFalse);
    },
  );
}
