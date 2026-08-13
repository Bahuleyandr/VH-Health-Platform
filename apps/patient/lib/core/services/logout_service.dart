import 'dart:async';
import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/device_service.dart';
import 'package:vhhealth/core/services/firebase_session_service.dart';
import 'package:vhhealth/core/services/health_sync_service.dart';
import 'package:vhhealth/core/services/notification_scheduler.dart';
import 'package:vhhealth/core/services/patient_realtime_lifecycle.dart';
import 'package:vhhealth/core/services/push_notification_service.dart';
import 'package:vhhealth/core/utils/cache_file_utils.dart';
import 'package:vhhealth/core/utils/doc_staging.dart';
import 'package:vhhealth/core/widgets/biometric_gate.dart';
import 'package:vhhealth/features/period_tracker/models/cycle_tracker.dart';

/// Centralized logout that clears ALL local state.
///
/// Call this from any logout trigger (button, session timeout, 401)
/// instead of clearing storage in individual places.
///
/// ## Worst-case ceiling on [logout]
///
/// The blocking "Signing out…" dialog is held for the duration of this call,
/// so the ceiling is a user-visible contract and must be stated honestly. Every
/// step that can touch the network or a socket is bounded; the arithmetic is
/// the sum of those bounds, and reaching it requires EVERY one of them to wedge
/// in the same logout:
///
/// | Step | Bound |
/// |---|---|
/// | Firebase server-session revoke | [networkStepTimeout] (6s) |
/// | Device unregister | [networkStepTimeout] (6s) |
/// | VH `/auth/logout` revoke | [networkStepTimeout] (6s) |
/// | Step 1 realtime disconnect | `PatientRealtimeLifecycle.stopTimeout` (4s) |
/// | FCM `deleteToken` | [networkStepTimeout] (6s) |
/// | Firebase client sign-out | [networkStepTimeout] (6s) |
/// | Final realtime teardown | `PatientRealtimeLifecycle.stopTimeout` (4s) |
/// | Degradation report (sad path only) | [networkStepTimeout] (6s) |
///
/// **44 seconds**, of which 38s is the path where the teardown does not
/// degrade. An earlier revision of this file claimed "~22s"; that number
/// counted only the three revocations plus the teardown and was false, because
/// the step-1 realtime disconnect, the FCM token delete and the Firebase
/// sign-out were all unbounded network calls at the time.
///
/// The steps deliberately left UNBOUNDED are the local ones, named here so the
/// ceiling above is a closed claim rather than an unexamined one: the secure
/// storage read/write/`deleteAll` (`flutter_secure_storage` platform channel),
/// the local-notification cancel, the API/file/document caches, the cycle
/// store, and the in-memory provider clears. None makes a network round trip,
/// and a platform channel that never returns is a dead app process, not a slow
/// logout.
class LogoutService {
  LogoutService._();

  static final _storage = VHSecureStorage.instance;
  static LogoutServiceDependencies _dependencies =
      LogoutServiceDependencies.defaults();
  static Future<LogoutOutcome>? _logoutInFlight;

  /// Hard per-call ceiling on the three pre-wipe server revocations.
  ///
  /// Logout is a teardown path: it must never hold the user behind the
  /// standard transport policy (15s timeout x 3 attempts per call — up to
  /// ~144s across the three calls). A user who force-kills the app during
  /// that hang skips the local PHI wipe below entirely, which is the worse
  /// outcome — so each revocation gets one short attempt (see
  /// [_networkCallTimeout]) and this outer deadline abandons it regardless
  /// of what the transport is doing. Mutable so tests can shrink it.
  @visibleForTesting
  static Duration networkStepTimeout = const Duration(seconds: 6);

  /// Per-attempt HTTP timeout for logout's own network calls. Paired with
  /// `retryTransientFailures: false` so one dead request fails once, fast.
  static const Duration _networkCallTimeout = Duration(seconds: 4);

  /// Secure-storage key holding a queued server-revocation retry.
  ///
  /// Deliberately NOT `jwt`. `ApiConfig.authenticatedHeaders()` and the splash
  /// screen both treat a `jwt` entry as a live session, so parking the
  /// departing token under that key would resurrect the signed-out user on the
  /// next app start. This record is read by exactly one code path
  /// ([retryPendingRevocation]) and is never an authentication source. It also
  /// survives step 5's `deleteAll` only because it is written afterwards.
  @visibleForTesting
  static const String pendingRevocationKey =
      'patient.pending_session_revocation.v1';

  /// Hard lifetime of a queued revocation retry.
  ///
  /// Patient access tokens live 7 days, and the backend's `blacklistToken`
  /// short-circuits once a token is past its own `exp`, so a record older than
  /// this can no longer revoke anything. Purge rather than retry — and never
  /// keep a departed user's credential on a shared device longer than it could
  /// possibly be useful.
  @visibleForTesting
  static const Duration pendingRevocationMaxAge = Duration(days: 7);

  /// Awaits a server revocation step but never longer than
  /// [networkStepTimeout]. Rethrows so each call site keeps its own
  /// step-specific logging.
  static Future<T> _boundedNetworkStep<T>(FutureOr<T> Function() step) {
    return Future<T>.sync(step).timeout(networkStepTimeout);
  }

  @visibleForTesting
  static void debugSetDependencies(LogoutServiceDependencies dependencies) {
    _dependencies = dependencies;
  }

  @visibleForTesting
  static void debugResetDependencies() {
    _dependencies = LogoutServiceDependencies.defaults();
    _logoutInFlight = null;
  }

  /// Full logout: clears credentials, disconnects services, wipes caches.
  ///
  /// Local teardown ALWAYS completes, even when the server call below fails.
  /// That is a deliberate trade: refusing to log out because the network is
  /// down would strand a user in a signed-in session on a device they are
  /// trying to hand back, which is worse than a stale server-side token. The
  /// returned [LogoutOutcome] reports whether the server-side revocation
  /// actually happened so the caller can say so instead of implying it did.
  static Future<LogoutOutcome> logout() {
    final existing = _logoutInFlight;
    if (existing != null) return existing;

    late final Future<LogoutOutcome> tracked;
    tracked = _performLogout().whenComplete(() {
      if (identical(_logoutInFlight, tracked)) _logoutInFlight = null;
    });
    _logoutInFlight = tracked;
    return tracked;
  }

  static Future<LogoutOutcome> _performLogout() async {
    // Advance the lifecycle generation synchronously. Any online/resume start
    // already queued by the app root is stale before the first disconnect can
    // yield, so it cannot re-bind the departing patient's identity.
    PatientRealtimeLifecycle.instance.beginTeardown();
    BiometricGate.clearUnlockState();

    // Captured BEFORE step 5's deleteAll. If either server revocation below
    // fails, step 11 durably queues a retry — and that retry needs the very
    // credential the wipe is about to remove. Held in memory only until then.
    String? vhToken;
    try {
      vhToken = await _dependencies.readVhToken();
    } catch (e) {
      debugPrint('LogoutService: could not read the session token: $e');
    }

    // 0. Revoke both server sessions before step 4 wipes secure storage. The
    //    Firebase revoke must run first because both calls authenticate with
    //    the current VH token and the VH logout invalidates it. Without these
    //    calls logout was local-only: the VH JWT and both independently
    //    refreshable server credentials could remain usable.
    var firebaseSessionRevoked = false;
    try {
      firebaseSessionRevoked = await _boundedNetworkStep(
        _dependencies.revokeFirebaseSession,
      );
    } catch (e) {
      debugPrint('LogoutService: Firebase server session revoke failed: $e');
    }

    // Unregister this device server-side so the backend stops targeting its
    // FCM token. Must run before the VH revoke below (it authenticates with
    // the same VH token /auth/logout invalidates) and is best-effort: on the
    // session-revocation path the JTI is already blacklisted and this call
    // 401s, which is why the client-side FCM token delete further down is the
    // authoritative kill for pushes.
    try {
      await _boundedNetworkStep(_dependencies.unregisterDevice);
    } catch (e) {
      debugPrint('LogoutService: device unregister failed: $e');
    }

    // Revoke Firebase first: both requests authenticate with the current VH
    // token, and /auth/logout invalidates that token. Reversing this order can
    // make the Firebase revocation fail with 401 even when the network is fine.
    // Always attempt the VH revoke even when the Firebase call fails.
    var vhSessionRevoked = false;
    try {
      vhSessionRevoked = await _boundedNetworkStep(
        _dependencies.revokeVhSession,
      );
    } catch (e) {
      debugPrint('LogoutService: VH server session revoke failed: $e');
    }

    // 1. Disconnect the shared real-time service. The singleton otherwise
    //    stays authenticated and keeps
    //    receiving PHI events (queue-position, broadcasts) for the prior user
    //    after logout, a real exposure on shared/family devices.
    //
    //    BOUNDED, and this bound is the one that matters most. This step runs
    //    BEFORE every local PHI wipe below, and it calls the very same
    //    `RealtimeClient.instance.disconnect()` that wedges on a dead socket.
    //    Left unbounded it meant the motivating case of this whole packet —
    //    a black-holed socket — hung logout HERE, so the teardown bound further
    //    down was never reached AND NOT ONE BYTE OF PHI WAS WIPED: secure
    //    storage, the API cache, cached documents and staged plaintext all
    //    survived on the device. Bounding it is safe for exactly the reason
    //    bounding the teardown is (see PatientRealtimeLifecycle.stopTimeout):
    //    the authoritative severance is the server-side socket close driven by
    //    the revocation above. Same unit as that bound, deliberately — one
    //    socket-shaped ceiling, one knob for tests to shrink.
    try {
      await Future<void>.sync(
        _dependencies.disconnectRealtime,
      ).timeout(PatientRealtimeLifecycle.stopTimeout);
    } catch (e) {
      debugPrint(
        'LogoutService: RealtimeClient disconnect failed or exceeded its '
        '${PatientRealtimeLifecycle.stopTimeout.inMilliseconds}ms bound '
        '(continuing to the PHI wipe regardless): $e',
      );
    }

    // 2. Kill the FCM registration, then cancel all local notifications.
    //    Deleting the token client-side invalidates it with FCM itself, so
    //    pushes stop even when the server-side unregister above could not run
    //    (revoked session, offline). The next login mints a fresh token via
    //    PushNotificationService.syncForSignedInUser.
    try {
      await Future<void>.sync(_dependencies.clearPushSignedInUser);
    } catch (e) {
      debugPrint('LogoutService: push user cleanup failed: $e');
    }
    //    BOUNDED: `FirebaseMessaging.deleteToken()` is a network round trip to
    //    FCM, not a local delete, and it had no ceiling of its own. On a dead
    //    network it could hold the blocking "Signing out…" dialog open past
    //    every deadline this service otherwise enforces.
    try {
      await _boundedNetworkStep(_dependencies.deleteFcmToken);
    } catch (e) {
      debugPrint('LogoutService: FCM token delete failed or timed out: $e');
    }
    try {
      await Future<void>.sync(_dependencies.cancelNotifications);
    } catch (e) {
      debugPrint('LogoutService: notification cancel failed: $e');
    }

    // 3. Stop account-bound health sync before removing the identity used to
    //    validate foreground/background work and persisted checkpoints.
    try {
      await Future<void>.sync(_dependencies.clearHealthSyncState);
    } catch (e) {
      debugPrint('LogoutService: health sync cleanup failed: $e');
    }

    // 4. Retire the session cache generation, destroy its in-memory AES key,
    //    and delete encrypted cache files before the broad storage wipe. This
    //    serializes against any in-flight key creation so it cannot recreate a
    //    prior user's key after logout.
    try {
      await Future<void>.sync(_dependencies.clearApiCache);
    } catch (e) {
      debugPrint('LogoutService: cache clear failed: $e');
    }

    // 5. Clear all remaining secure storage (JWT, phone, device token, etc.)
    try {
      await Future<void>.sync(_dependencies.clearSecureStorage);
    } catch (e) {
      debugPrint('LogoutService: secure storage clear failed: $e');
    }

    // 6. Clear downloaded-file cache (vhhealth_cache) — this holds
    //    PHI bytes (reports, documents) separate from the API cache above.
    //    Encrypted at rest now, but still wiped so the prior user's documents
    //    don't linger on a shared/family device.
    try {
      await Future<void>.sync(_dependencies.clearDownloadedFileCache);
    } catch (e) {
      debugPrint('LogoutService: file cache clear failed: $e');
    }

    // 7. Purge plaintext document staging. DocumentOpener
    //    and the cached-file viewer decrypt PHI into a temp staging file so the
    //    system viewer can read it; those plaintext copies must not survive
    //    logout on a shared/family device. Audit §3 (patient).
    try {
      await Future<void>.sync(_dependencies.purgeDocumentStaging);
    } catch (e) {
      debugPrint('LogoutService: temp/staging purge failed: $e');
    }

    // 8. Clear cycle/period/fertility data — PHI now stored encrypted-at-rest
    //    in VHSecureStorage (step 4's deleteAll already wipes it; this is
    //    defense-in-depth AND sweeps up any legacy plaintext SharedPreferences
    //    keys from pre-migration installs). Must not survive for the next user
    //    on a shared device.
    try {
      await Future<void>.sync(_dependencies.clearCycleTracker);
    } catch (e) {
      debugPrint('LogoutService: cycle data clear failed: $e');
    }

    // 9. Clear in-memory per-account state. The dependents roster is PHI and
    //    its active selection feeds the X-Acting-As-Uid header on every
    //    authenticated request — a survivor here shows the prior guardian's
    //    dependents to the next account and 403s the new session with a stale
    //    acting-as uid. UserProvider is the identity source of truth; its
    //    backing storage keys were wiped in step 4 above.
    try {
      await Future<void>.sync(_dependencies.clearDependentsProvider);
    } catch (e) {
      debugPrint('LogoutService: dependents provider clear failed: $e');
    }
    try {
      await Future<void>.sync(_dependencies.clearUserProvider);
    } catch (e) {
      debugPrint('LogoutService: user provider clear failed: $e');
    }

    // 10. Sign out of Firebase — the last identity-state change. The router
    //    treats a live Firebase user
    //    as "logged in" and re-evaluates its redirect on Firebase auth-state
    //    changes (refreshListenable). Signing out after every other session
    //    signal (JWT, UserProvider) is gone means that when the auth-state
    //    event fires, the redirect sees a fully logged-out app and lands the
    //    user on /login instead of stranding them on a dead dashboard. The
    //    transport-only final realtime fence below follows this state change.
    //    Previously only the explicit Settings→Logout button did this; the
    //    automatic paths (idle timeout, 401 expiry, session revocation) left
    //    the Firebase session alive.
    //
    //    Note this is the CLIENT-side Firebase sign-out. It is a third,
    //    distinct credential action from step 0's VH-JWT revocation and from
    //    the server-side Firebase session revoke (/auth/firebase/revoke-my-session,
    //    PR #803) — all three are needed, none substitutes for another.
    //    BOUNDED for the same reason as the FCM delete: `signOut()` clears the
    //    local credential first but then talks to Firebase, and that call had
    //    no ceiling. Abandoning the AWAIT does not cancel the sign-out — it
    //    finishes in the background — and every consumer of "am I logged in?"
    //    (JWT, UserProvider) is already gone by this point, while each caller
    //    navigates to /login itself rather than waiting on the auth-state
    //    event.
    try {
      await _boundedNetworkStep(_dependencies.signOutFirebase);
    } catch (e) {
      debugPrint('LogoutService: Firebase sign-out failed or timed out: $e');
    }

    // 11. Durably queue a retry when the server never confirmed a revocation.
    //     Local teardown always completes, so without this the departing JWT
    //     simply stays live server-side for the rest of its 7-day life with
    //     nothing left on the device that could ever kill it — and the user
    //     was told "other devices may stay signed in until you retry" with no
    //     retry to speak of. Written AFTER step 5's deleteAll (which would
    //     otherwise erase it) and after every PHI wipe step; this record is a
    //     revocation handle, not PHI.
    var revocationRetryQueued = false;
    if (!(firebaseSessionRevoked && vhSessionRevoked)) {
      revocationRetryQueued = await _queuePendingRevocation(
        token: vhToken,
        firebasePending: !firebaseSessionRevoked,
        vhPending: !vhSessionRevoked,
      );
    }

    // Drain any start that was already in flight, unsubscribe the app-owned
    // personal channels, and disconnect again after credentials are gone. The
    // first disconnect above cannot provide this guarantee because a lifecycle
    // callback may already have passed its pre-await start check.
    //
    // Bounded by PatientRealtimeLifecycle.stopTimeout: the AUTHORITATIVE
    // severance is the server-side socket close driven by the revocation above
    // (wsServer.pushSessionRevoked), so this best-effort local cleanup must
    // never hold the blocking "Signing out…" dialog open indefinitely. The
    // disconnect is still ATTEMPTED on the timeout path — just not waited on.
    // Declared and defaulted OUTSIDE the try. Assigning the flag after the
    // await meant a throwing teardown skipped the assignment entirely and the
    // catch reported a clean logout — the same silent-degradation class this
    // whole block exists to close. `failed` is the honest default: if nothing
    // below reassigns it, the teardown provably did not complete.
    var teardown = PatientRealtimeTeardownResult.failed;
    try {
      teardown = await PatientRealtimeLifecycle.instance.completeTeardown(
        () async {
          try {
            await Future<void>.sync(_dependencies.disconnectRealtime);
          } catch (e) {
            debugPrint('LogoutService: final realtime disconnect failed: $e');
            try {
              await Future<void>.sync(_dependencies.disconnectRealtime);
            } catch (finalError) {
              debugPrint(
                'LogoutService: final realtime disconnect retry failed: '
                '$finalError',
              );
            }
          }
        },
      );
    } catch (e) {
      // completeTeardown is contractually non-throwing; this is belt-and-
      // braces and leaves `teardown` at `failed`.
      debugPrint('LogoutService: final realtime teardown threw: $e');
    }
    final realtimeTeardownTimedOut =
        teardown == PatientRealtimeTeardownResult.timedOut;

    // A bound that expires SILENTLY is the same quiet degradation the unbounded
    // await was: nobody learns that patient devices are wedging on teardown.
    // Never `catch {}` this — log it and report it as a non-fatal so the rate
    // is visible in Crashlytics, and surface it on the outcome below.
    if (teardown != PatientRealtimeTeardownResult.completed) {
      debugPrint(
        'LogoutService: realtime teardown did not complete cleanly '
        '(${teardown.name}, bound '
        '${PatientRealtimeLifecycle.stopTimeout.inMilliseconds}ms); completing '
        'logout anyway (server-side revocation is the authoritative severance)',
      );
      try {
        // Bounded too: the ceiling below is only honest if every awaited step
        // in this method has one, including the telemetry on the sad path.
        await _boundedNetworkStep(
          () => CrashReporter.instance.recordError(
            StateError(
              'Patient realtime teardown did not complete during logout: '
              '${teardown.name}',
            ),
            StackTrace.current,
            context: 'LogoutService.completeTeardown',
            extra: {
              'result': teardown.name,
              'timeout_ms': PatientRealtimeLifecycle.stopTimeout.inMilliseconds,
              'server_session_revoked':
                  firebaseSessionRevoked && vhSessionRevoked,
            },
          ),
        );
      } catch (e) {
        debugPrint('LogoutService: teardown-degradation report failed: $e');
      }
    }

    return LogoutOutcome(
      firebaseSessionRevoked: firebaseSessionRevoked,
      vhSessionRevoked: vhSessionRevoked,
      realtimeTeardownTimedOut: realtimeTeardownTimedOut,
      revocationRetryQueued: revocationRetryQueued,
    );
  }

  /// Persists the retry handle for a server revocation that did not happen.
  ///
  /// Returns whether a retry is actually recoverable. False means the caller
  /// must NOT imply one is pending — with no token there is nothing on this
  /// device that could ever revoke the session, and saying otherwise would be
  /// the same false reassurance this whole path exists to avoid.
  static Future<bool> _queuePendingRevocation({
    required String? token,
    required bool firebasePending,
    required bool vhPending,
    DateTime? queuedAt,
  }) async {
    if (token == null || token.isEmpty) {
      debugPrint(
        'LogoutService: server revocation failed and no session token was '
        'captured — no retry can be queued',
      );
      return false;
    }
    try {
      await _dependencies.writePendingRevocation(
        jsonEncode({
          'version': 1,
          // Preserved across re-queues so a retry on every app start cannot
          // keep resetting the clock and hold the credential past its cap.
          'queuedAt': (queuedAt ?? DateTime.now()).toUtc().toIso8601String(),
          'token': token,
          'firebasePending': firebasePending,
          'vhPending': vhPending,
        }),
      );
      return true;
    } catch (e) {
      debugPrint('LogoutService: queuing the revocation retry failed: $e');
      return false;
    }
  }

  /// Drains a revocation queued by a logout whose server call never landed.
  ///
  /// Call at app start, BEFORE the user can sign in again — see the
  /// [PendingRevocationRetry.deferredLiveSession] rationale. Safe to call when
  /// nothing is queued, and idempotent: the record is deleted once the server
  /// has confirmed, and purged once it is too old to revoke anything.
  static Future<PendingRevocationRetry> retryPendingRevocation() async {
    String? raw;
    try {
      raw = await _dependencies.readPendingRevocation();
    } catch (e) {
      debugPrint('LogoutService: reading the queued revocation failed: $e');
      return PendingRevocationRetry.nothingQueued;
    }
    if (raw == null || raw.isEmpty) {
      return PendingRevocationRetry.nothingQueued;
    }

    // A queued record must never revoke a LIVE session. The backend's
    // /auth/logout bumps the identity's token_epoch (R1), which invalidates
    // every token that identity holds — including one minted by a login that
    // happened after this record was queued. Draining only while signed out is
    // what keeps the retry from signing the user out of a session they just
    // started.
    if (await _liveSessionPresent()) {
      return PendingRevocationRetry.deferredLiveSession;
    }

    Map<String, dynamic> record;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic> || decoded['version'] != 1) {
        throw const FormatException('Unrecognized pending-revocation record');
      }
      record = decoded;
    } catch (e) {
      debugPrint('LogoutService: discarding unreadable revocation record: $e');
      await _clearPendingRevocation();
      return PendingRevocationRetry.expired;
    }

    final token = record['token'];
    final queuedAt = DateTime.tryParse('${record['queuedAt']}');
    if (token is! String ||
        token.isEmpty ||
        queuedAt == null ||
        DateTime.now().toUtc().difference(queuedAt.toUtc()) >
            pendingRevocationMaxAge) {
      debugPrint('LogoutService: queued revocation is stale — purging');
      await _clearPendingRevocation();
      return PendingRevocationRetry.expired;
    }

    // Firebase before VH, for the same reason logout itself uses that order:
    // both authenticate with this token and the VH revoke invalidates it.
    var firebasePending = record['firebasePending'] == true;
    var vhPending = record['vhPending'] == true;
    var deferred = false;

    if (firebasePending) {
      // Re-probe. The single check above is a time-of-check/time-of-use gap:
      // reading and decoding the record are awaits of their own, and a login
      // completing inside that window would be signed straight back out.
      if (await _liveSessionPresent()) {
        deferred = true;
      } else {
        try {
          if (await _dependencies.retryFirebaseRevocation(token)) {
            firebasePending = false;
          }
        } catch (e) {
          debugPrint('LogoutService: Firebase revocation retry failed: $e');
        }
      }
    }
    if (vhPending && !deferred) {
      // The narrowest possible probe before the EPOCH-BUMPING call — the
      // Firebase round trip above may have taken seconds.
      if (await _liveSessionPresent()) {
        deferred = true;
      } else {
        try {
          if (await _dependencies.retryVhRevocation(token)) vhPending = false;
        } catch (e) {
          debugPrint('LogoutService: VH revocation retry failed: $e');
        }
        // Post-call re-probe. The client cannot close the window between the
        // check above and the backend processing the revoke, so DETECT the
        // race rather than pretend it does not exist: a session that appeared
        // while this call was in flight has very likely just been epoch-bumped
        // by it, and the user is about to be signed out for no reason they can
        // see. Reported so the rate is visible instead of invisible.
        if (!vhPending && await _liveSessionPresent()) {
          debugPrint(
            'LogoutService: a session signed in while the queued revocation '
            'was in flight — that session was very likely epoch-bumped by it',
          );
          try {
            await _boundedNetworkStep(
              () => CrashReporter.instance.recordError(
                StateError('Queued session revocation raced a fresh login'),
                StackTrace.current,
                context: 'LogoutService.retryPendingRevocation',
              ),
            );
          } catch (e) {
            debugPrint('LogoutService: revocation-race report failed: $e');
          }
        }
      }
    }

    if (deferred) {
      // Keep the handle, narrowed by whatever the Firebase step did achieve,
      // and preserve the original queuedAt so deferring cannot reset the cap.
      await _queuePendingRevocation(
        token: token,
        firebasePending: firebasePending,
        vhPending: vhPending,
        queuedAt: queuedAt,
      );
      return PendingRevocationRetry.deferredLiveSession;
    }

    if (!firebasePending && !vhPending) {
      await _clearPendingRevocation();
      return PendingRevocationRetry.revoked;
    }

    // Still unconfirmed: keep the handle (with the outstanding steps narrowed)
    // rather than dropping it and silently giving up on the live session.
    await _queuePendingRevocation(
      token: token,
      firebasePending: firebasePending,
      vhPending: vhPending,
      queuedAt: queuedAt,
    );
    return PendingRevocationRetry.stillFailing;
  }

  /// Whether a session is signed in on this device right now.
  ///
  /// A FAILED probe answers true. Guessing wrong in this direction costs one
  /// deferred retry; guessing wrong in the other signs a real user out of a
  /// session they just started.
  static Future<bool> _liveSessionPresent() async {
    try {
      final liveToken = await _dependencies.readVhToken();
      return liveToken != null && liveToken.isNotEmpty;
    } catch (e) {
      debugPrint('LogoutService: live-session probe failed: $e');
      return true;
    }
  }

  static Future<void> _clearPendingRevocation() async {
    try {
      await _dependencies.clearPendingRevocation();
    } catch (e) {
      debugPrint('LogoutService: clearing the revocation record failed: $e');
    }
  }

  /// Shared handler for definitive session death (the 401-after-failed-refresh
  /// logout path). Wired to [ApiClient.onSessionExpired] in main();
  /// [redirectToLogin] is injected so this service stays router-free.
  static void handleSessionExpired({required VoidCallback redirectToLogin}) {
    if (UserProvider.instance?.isGuest ?? false) {
      return;
    }
    // Full teardown on definitive session death (fired only after a refresh
    // attempt fails): disconnect the realtime + WebSocket PHI channels and
    // wipe caches, then redirect. Previously only UserProvider was cleared,
    // leaving the realtime channels live for the prior user.
    unawaited(() async {
      await logout();
      redirectToLogin();
    }());
  }

  /// Ends the VH session server-side. Returns false — never throws — when the
  /// call could not be delivered or the backend refused it, including when the
  /// patient outage gate blocks the mutation before it is sent.
  ///
  /// A 401 counts as REVOKED, not as failure. The token is already dead
  /// server-side, which is precisely the end state this call exists to reach.
  /// Reporting it as failure made step 11 durably re-write the departing JWT
  /// to secure storage for up to seven days — on the two paths where a 401 is
  /// the EXPECTED response, at that: the session-revocation logout (the
  /// backend has already blacklisted the JTI before the listener fires) and
  /// account deletion. A dead credential was being re-planted on a shared or
  /// family device milliseconds after the wipe the rest of this service exists
  /// to perform. [_retryVhRevocation] always had this rule; the two paths
  /// simply disagreed.
  static Future<bool> _revokeVhSession() async {
    try {
      final response = await ApiClient.post(
        '/auth/logout',
        body: const {},
        timeout: _networkCallTimeout,
        retryTransientFailures: false,
        refreshOnUnauthorized: false,
      );
      return response.isSuccess || response.isUnauthorized;
    } catch (e) {
      debugPrint('LogoutService: /auth/logout failed: $e');
      return false;
    }
  }

  /// Deactivates this device's registration server-side so the backend stops
  /// sending pushes to it. Best-effort by design (see the call site).
  static Future<String?> _readVhToken() => _storage.read(key: 'jwt');

  static Future<String?> _readPendingRevocation() =>
      _storage.read(key: pendingRevocationKey);

  static Future<void> _writePendingRevocation(String record) =>
      _storage.write(key: pendingRevocationKey, value: record);

  static Future<void> _clearPendingRevocationRecord() =>
      _storage.delete(key: pendingRevocationKey);

  /// Retries the Firebase server-session revoke with an explicit bearer.
  ///
  /// `bearerOverride` is required because this runs after logout wiped the
  /// session token — there is no ambient credential left for the HTTP client
  /// to attach, and restoring one to secure storage would make the app treat
  /// the departed user as signed in again.
  static Future<bool> _retryFirebaseRevocation(String bearer) async {
    final response = await ApiClient.post(
      '/auth/firebase/revoke-my-session',
      body: const {},
      timeout: _networkCallTimeout,
      retryTransientFailures: false,
      refreshOnUnauthorized: false,
      bearerOverride: bearer,
    );
    // A 401 means the token is already dead server-side, which is exactly the
    // end state this retry exists to reach — treat it as done, not as failure.
    return response.isSuccess || response.isUnauthorized;
  }

  static Future<bool> _retryVhRevocation(String bearer) async {
    final response = await ApiClient.post(
      '/auth/logout',
      body: const {},
      timeout: _networkCallTimeout,
      retryTransientFailures: false,
      refreshOnUnauthorized: false,
      bearerOverride: bearer,
    );
    return response.isSuccess || response.isUnauthorized;
  }

  static Future<void> _unregisterDevice() async {
    final phone = await _storage.read(key: 'user_phone') ?? '';
    if (phone.isEmpty || phone == 'guest') return;
    await DeviceService.unregisterDevice(
      phone,
      timeout: _networkCallTimeout,
      retryTransientFailures: false,
      refreshOnUnauthorized: false,
    );
  }
}

/// What a logout actually achieved. Local state is always cleared; the server
/// side is best-effort and reported truthfully.
class LogoutOutcome {
  const LogoutOutcome({
    required this.firebaseSessionRevoked,
    required this.vhSessionRevoked,
    this.realtimeTeardownTimedOut = false,
    this.revocationRetryQueued = false,
  });

  final bool firebaseSessionRevoked;
  final bool vhSessionRevoked;

  /// The client-side realtime teardown hit its bound and was abandoned.
  ///
  /// NOT a failed logout: the server-side revocation closes the sockets, and
  /// the final disconnect was still STARTED (it is deliberately not awaited on
  /// this path — see `PatientRealtimeLifecycle.completeTeardown`). Reported so
  /// the timeout is observable rather than silent; the Crashlytics non-fatal
  /// recorded alongside it also covers the `failed` case this flag does not.
  final bool realtimeTeardownTimedOut;

  /// A server revocation did not land AND a retry handle was durably stored.
  ///
  /// False alongside a false [serverSessionRevoked] means nothing on this
  /// device can ever revoke the session — the user must be told that, not told
  /// to wait for a retry that does not exist. Enforced, not merely documented:
  /// `LogoutButton.logoutWarningMessage` selects different copy on each branch
  /// and is asserted in `logout_service_test.dart`.
  final bool revocationRetryQueued;

  /// True only when the backend confirmed both independently refreshable
  /// server credentials were revoked.
  bool get serverSessionRevoked => firebaseSessionRevoked && vhSessionRevoked;
}

/// Result of draining a queued server-revocation retry.
enum PendingRevocationRetry {
  /// No logout has left an unconfirmed revocation behind.
  nothingQueued,

  /// A session is currently signed in. Retrying now would bump the identity's
  /// token epoch and sign that live session out too, so the record is kept for
  /// the next signed-out start.
  deferredLiveSession,

  /// The record was unreadable, or older than [LogoutService
  /// .pendingRevocationMaxAge] — the token can no longer revoke anything, so
  /// it was purged rather than retained.
  expired,

  /// The backend confirmed the revocation and the record was deleted.
  revoked,

  /// Still unconfirmed. The record was kept for a later attempt.
  stillFailing,
}

typedef LogoutStep = FutureOr<void> Function();
typedef LogoutRevokeStep = FutureOr<bool> Function();
typedef LogoutTokenRead = FutureOr<String?> Function();
typedef LogoutRecordWrite = FutureOr<void> Function(String record);
typedef LogoutRetryRevokeStep = FutureOr<bool> Function(String bearer);

@visibleForTesting
class LogoutServiceDependencies {
  const LogoutServiceDependencies({
    required this.revokeFirebaseSession,
    required this.unregisterDevice,
    required this.revokeVhSession,
    required this.disconnectRealtime,
    required this.clearPushSignedInUser,
    required this.deleteFcmToken,
    required this.cancelNotifications,
    required this.clearHealthSyncState,
    required this.clearSecureStorage,
    required this.clearApiCache,
    required this.clearDownloadedFileCache,
    required this.purgeDocumentStaging,
    required this.clearCycleTracker,
    required this.clearDependentsProvider,
    required this.clearUserProvider,
    required this.signOutFirebase,
    // Optional with production defaults so existing constructions (including
    // every test fixture) keep compiling; only the pending-revocation suites
    // need to override them.
    this.readVhToken = LogoutService._readVhToken,
    this.readPendingRevocation = LogoutService._readPendingRevocation,
    this.writePendingRevocation = LogoutService._writePendingRevocation,
    this.clearPendingRevocation = LogoutService._clearPendingRevocationRecord,
    this.retryFirebaseRevocation = LogoutService._retryFirebaseRevocation,
    this.retryVhRevocation = LogoutService._retryVhRevocation,
  });

  factory LogoutServiceDependencies.defaults() {
    return LogoutServiceDependencies(
      // Logout-specific transport policy: one short attempt per call (see
      // LogoutService._networkCallTimeout) instead of 15s x 3 retries.
      revokeFirebaseSession: () => FirebaseSessionService.revokeSession(
        timeout: LogoutService._networkCallTimeout,
        retryTransientFailures: false,
        refreshOnUnauthorized: false,
      ),
      unregisterDevice: LogoutService._unregisterDevice,
      revokeVhSession: LogoutService._revokeVhSession,
      disconnectRealtime: RealtimeClient.instance.disconnect,
      clearPushSignedInUser: PushNotificationService.clearSignedInUser,
      cancelNotifications: NotificationScheduler.cancelAll,
      clearHealthSyncState: HealthSyncService.endAccountSession,
      clearSecureStorage: LogoutService._storage.deleteAll,
      clearApiCache: ApiCacheManager.clearAll,
      clearDownloadedFileCache: CacheFileUtils.clearCache,
      purgeDocumentStaging: DocStaging.purge,
      clearCycleTracker: CycleTrackerStore.clearAll,
      clearDependentsProvider: () {
        DependentsProvider.instance?.clear();
      },
      clearUserProvider: () async {
        final provider = UserProvider.instance;
        if (provider != null) await provider.clear();
      },
      // Closures (not tear-offs) so the Firebase singletons are only touched
      // when logout actually runs — pure-Dart tests construct these defaults
      // without a Firebase app.
      deleteFcmToken: () => FirebaseMessaging.instance.deleteToken(),
      signOutFirebase: () => FirebaseAuth.instance.signOut(),
    );
  }

  final LogoutRevokeStep revokeFirebaseSession;
  final LogoutStep unregisterDevice;
  final LogoutRevokeStep revokeVhSession;
  final LogoutStep disconnectRealtime;
  final LogoutStep clearPushSignedInUser;
  final LogoutStep deleteFcmToken;
  final LogoutStep cancelNotifications;
  final LogoutStep clearHealthSyncState;
  final LogoutStep clearSecureStorage;
  final LogoutStep clearApiCache;
  final LogoutStep clearDownloadedFileCache;
  final LogoutStep purgeDocumentStaging;
  final LogoutStep clearCycleTracker;
  final LogoutStep clearDependentsProvider;
  final LogoutStep clearUserProvider;
  final LogoutStep signOutFirebase;
  final LogoutTokenRead readVhToken;
  final LogoutTokenRead readPendingRevocation;
  final LogoutRecordWrite writePendingRevocation;
  final LogoutStep clearPendingRevocation;
  final LogoutRetryRevokeStep retryFirebaseRevocation;
  final LogoutRetryRevokeStep retryVhRevocation;
}
