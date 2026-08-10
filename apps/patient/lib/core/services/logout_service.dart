import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/device_service.dart';
import 'package:vhhealth/core/services/firebase_session_service.dart';
import 'package:vhhealth/core/services/notification_scheduler.dart';
import 'package:vhhealth/core/services/push_notification_service.dart';
import 'package:vhhealth/core/services/websocket_service.dart';
import 'package:vhhealth/core/utils/cache_file_utils.dart';
import 'package:vhhealth/core/utils/doc_staging.dart';
import 'package:vhhealth/core/widgets/biometric_gate.dart';
import 'package:vhhealth/features/period_tracker/models/cycle_tracker.dart';

/// Centralized logout that clears ALL local state.
///
/// Call this from any logout trigger (button, session timeout, 401)
/// instead of clearing storage in individual places.
class LogoutService {
  LogoutService._();

  static final _storage = VHSecureStorage.instance;
  static LogoutServiceDependencies _dependencies =
      LogoutServiceDependencies.defaults();
  static Future<LogoutOutcome>? _logoutInFlight;

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
    BiometricGate.clearUnlockState();

    // 0. Revoke both server sessions before step 3 wipes secure storage. The
    //    Firebase revoke must run first because both calls authenticate with
    //    the current VH token and the VH logout invalidates it. Without these
    //    calls logout was local-only: the VH JWT and both independently
    //    refreshable server credentials could remain usable.
    var firebaseSessionRevoked = false;
    try {
      firebaseSessionRevoked = await Future<bool>.sync(
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
      await Future<void>.sync(_dependencies.unregisterDevice);
    } catch (e) {
      debugPrint('LogoutService: device unregister failed: $e');
    }

    // Revoke Firebase first: both requests authenticate with the current VH
    // token, and /auth/logout invalidates that token. Reversing this order can
    // make the Firebase revocation fail with 401 even when the network is fine.
    // Always attempt the VH revoke even when the Firebase call fails.
    var vhSessionRevoked = false;
    try {
      vhSessionRevoked = await Future<bool>.sync(_dependencies.revokeVhSession);
    } catch (e) {
      debugPrint('LogoutService: VH server session revoke failed: $e');
    }

    // 1. Disconnect real-time services. Both the legacy WebSocketService AND
    //    the shared RealtimeClient (vhhealth_core) must be torn down — the
    //    RealtimeClient singleton otherwise stays authenticated and keeps
    //    receiving PHI events (queue-position, broadcasts) for the prior user
    //    after logout, a real exposure on shared/family devices.
    try {
      await Future<void>.sync(_dependencies.disconnectWebSocket);
    } catch (e) {
      debugPrint('LogoutService: WebSocket disconnect failed: $e');
    }
    try {
      await Future<void>.sync(_dependencies.disconnectRealtime);
    } catch (e) {
      debugPrint('LogoutService: RealtimeClient disconnect failed: $e');
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
    try {
      await Future<void>.sync(_dependencies.deleteFcmToken);
    } catch (e) {
      debugPrint('LogoutService: FCM token delete failed: $e');
    }
    try {
      await Future<void>.sync(_dependencies.cancelNotifications);
    } catch (e) {
      debugPrint('LogoutService: notification cancel failed: $e');
    }

    // 3. Clear all secure storage (JWT, phone, device token, etc.)
    try {
      await Future<void>.sync(_dependencies.clearSecureStorage);
    } catch (e) {
      debugPrint('LogoutService: secure storage clear failed: $e');
    }

    // 4. Clear API cache
    try {
      await Future<void>.sync(_dependencies.clearApiCache);
    } catch (e) {
      debugPrint('LogoutService: cache clear failed: $e');
    }

    // 5. Clear downloaded-file cache (vhhealth_cache) — this holds
    //    PHI bytes (reports, documents) separate from the API cache above.
    //    Encrypted at rest now, but still wiped so the prior user's documents
    //    don't linger on a shared/family device.
    try {
      await Future<void>.sync(_dependencies.clearDownloadedFileCache);
    } catch (e) {
      debugPrint('LogoutService: file cache clear failed: $e');
    }

    // 6. Purge plaintext document staging + the OS temp dir. DocumentOpener
    //    and the cached-file viewer decrypt PHI into a temp staging file so the
    //    system viewer can read it; those plaintext copies must not survive
    //    logout on a shared/family device. Audit §3 (patient).
    try {
      await Future<void>.sync(_dependencies.purgeDocumentStaging);
    } catch (e) {
      debugPrint('LogoutService: temp/staging purge failed: $e');
    }

    // 7. Clear cycle/period/fertility data — PHI now stored encrypted-at-rest
    //    in VHSecureStorage (step 3's deleteAll already wipes it; this is
    //    defense-in-depth AND sweeps up any legacy plaintext SharedPreferences
    //    keys from pre-migration installs). Must not survive for the next user
    //    on a shared device.
    try {
      await Future<void>.sync(_dependencies.clearCycleTracker);
    } catch (e) {
      debugPrint('LogoutService: cycle data clear failed: $e');
    }

    // 8. Clear in-memory per-account state. The dependents roster is PHI and
    //    its active selection feeds the X-Acting-As-Uid header on every
    //    authenticated request — a survivor here shows the prior guardian's
    //    dependents to the next account and 403s the new session with a stale
    //    acting-as uid. UserProvider is the identity source of truth; its
    //    backing storage keys were wiped in step 3 above.
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

    // 9. Sign out of Firebase — LAST. The router treats a live Firebase user
    //    as "logged in" and re-evaluates its redirect on Firebase auth-state
    //    changes (refreshListenable). Signing out after every other session
    //    signal (JWT, UserProvider) is gone means that when the auth-state
    //    event fires, the redirect sees a fully logged-out app and lands the
    //    user on /login instead of stranding them on a dead dashboard.
    //    Previously only the explicit Settings→Logout button did this; the
    //    automatic paths (idle timeout, 401 expiry, session revocation) left
    //    the Firebase session alive.
    //
    //    Note this is the CLIENT-side Firebase sign-out. It is a third,
    //    distinct credential action from step 0's VH-JWT revocation and from
    //    the server-side Firebase session revoke (/auth/firebase/revoke-my-session,
    //    PR #803) — all three are needed, none substitutes for another.
    try {
      await Future<void>.sync(_dependencies.signOutFirebase);
    } catch (e) {
      debugPrint('LogoutService: Firebase sign-out failed: $e');
    }

    return LogoutOutcome(
      firebaseSessionRevoked: firebaseSessionRevoked,
      vhSessionRevoked: vhSessionRevoked,
    );
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
  static Future<bool> _revokeVhSession() async {
    try {
      final response = await ApiClient.post('/auth/logout', body: const {});
      return response.isSuccess;
    } catch (e) {
      debugPrint('LogoutService: /auth/logout failed: $e');
      return false;
    }
  }

  /// Deactivates this device's registration server-side so the backend stops
  /// sending pushes to it. Best-effort by design (see the call site).
  static Future<void> _unregisterDevice() async {
    final phone = await _storage.read(key: 'user_phone') ?? '';
    if (phone.isEmpty || phone == 'guest') return;
    await DeviceService.unregisterDevice(phone);
  }
}

/// What a logout actually achieved. Local state is always cleared; the server
/// side is best-effort and reported truthfully.
class LogoutOutcome {
  const LogoutOutcome({
    required this.firebaseSessionRevoked,
    required this.vhSessionRevoked,
  });

  final bool firebaseSessionRevoked;
  final bool vhSessionRevoked;

  /// True only when the backend confirmed both independently refreshable
  /// server credentials were revoked.
  bool get serverSessionRevoked => firebaseSessionRevoked && vhSessionRevoked;
}

typedef LogoutStep = FutureOr<void> Function();
typedef LogoutRevokeStep = FutureOr<bool> Function();

@visibleForTesting
class LogoutServiceDependencies {
  const LogoutServiceDependencies({
    required this.revokeFirebaseSession,
    required this.unregisterDevice,
    required this.revokeVhSession,
    required this.disconnectWebSocket,
    required this.disconnectRealtime,
    required this.clearPushSignedInUser,
    required this.deleteFcmToken,
    required this.cancelNotifications,
    required this.clearSecureStorage,
    required this.clearApiCache,
    required this.clearDownloadedFileCache,
    required this.purgeDocumentStaging,
    required this.clearCycleTracker,
    required this.clearDependentsProvider,
    required this.clearUserProvider,
    required this.signOutFirebase,
  });

  factory LogoutServiceDependencies.defaults() {
    return LogoutServiceDependencies(
      revokeFirebaseSession: FirebaseSessionService.revokeSession,
      unregisterDevice: LogoutService._unregisterDevice,
      revokeVhSession: LogoutService._revokeVhSession,
      disconnectWebSocket: WebSocketService.instance.disconnect,
      disconnectRealtime: RealtimeClient.instance.disconnect,
      clearPushSignedInUser: PushNotificationService.clearSignedInUser,
      cancelNotifications: NotificationScheduler.cancelAll,
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
  final LogoutStep disconnectWebSocket;
  final LogoutStep disconnectRealtime;
  final LogoutStep clearPushSignedInUser;
  final LogoutStep deleteFcmToken;
  final LogoutStep cancelNotifications;
  final LogoutStep clearSecureStorage;
  final LogoutStep clearApiCache;
  final LogoutStep clearDownloadedFileCache;
  final LogoutStep purgeDocumentStaging;
  final LogoutStep clearCycleTracker;
  final LogoutStep clearDependentsProvider;
  final LogoutStep clearUserProvider;
  final LogoutStep signOutFirebase;
}
