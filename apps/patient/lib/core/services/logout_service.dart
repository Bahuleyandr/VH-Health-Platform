import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/api_client.dart';
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

  @visibleForTesting
  static void debugSetDependencies(LogoutServiceDependencies dependencies) {
    _dependencies = dependencies;
  }

  @visibleForTesting
  static void debugResetDependencies() {
    _dependencies = LogoutServiceDependencies.defaults();
  }

  /// Full logout: clears credentials, disconnects services, wipes caches.
  ///
  /// Local teardown ALWAYS completes, even when the server call below fails.
  /// That is a deliberate trade: refusing to log out because the network is
  /// down would strand a user in a signed-in session on a device they are
  /// trying to hand back, which is worse than a stale server-side token. The
  /// returned [LogoutOutcome] reports whether the server-side revocation
  /// actually happened so the caller can say so instead of implying it did.
  static Future<LogoutOutcome> logout() async {
    BiometricGate.clearUnlockState();

    // 0. Revoke the VH JWT server-side. This MUST run before step 3 wipes
    //    secure storage, because the request is authenticated with the very
    //    token being revoked. Without this the patient app's logout was purely
    //    local: the JWT stayed valid until its own expiry, and its sibling
    //    refresh token — which is stateless, with no session row to delete —
    //    could still be traded for fresh access tokens (audit follow-up P12).
    var serverSessionRevoked = false;
    try {
      serverSessionRevoked = await Future<bool>.sync(
        _dependencies.revokeServerSession,
      );
    } catch (e) {
      debugPrint('LogoutService: server session revoke failed: $e');
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

    // 2. Cancel all local notifications
    try {
      await Future<void>.sync(_dependencies.clearPushSignedInUser);
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

    // 8. Clear in-memory user identity. UserProvider is the single source
    //    of truth; its backing storage keys were wiped in step 3 above.
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

    return LogoutOutcome(serverSessionRevoked: serverSessionRevoked);
  }

  /// Ends the VH session server-side. Returns false — never throws — when the
  /// call could not be delivered or the backend refused it, including when the
  /// patient outage gate blocks the mutation before it is sent.
  static Future<bool> _revokeServerSession() async {
    try {
      final response = await ApiClient.post('/auth/logout', body: const {});
      return response.isSuccess;
    } catch (e) {
      debugPrint('LogoutService: /auth/logout failed: $e');
      return false;
    }
  }
}

/// What a logout actually achieved. Local state is always cleared; the server
/// side is best-effort and reported truthfully.
class LogoutOutcome {
  const LogoutOutcome({required this.serverSessionRevoked});

  /// True only when the backend confirmed it revoked this identity's tokens.
  final bool serverSessionRevoked;
}

typedef LogoutStep = FutureOr<void> Function();
typedef LogoutRevokeStep = FutureOr<bool> Function();

@visibleForTesting
class LogoutServiceDependencies {
  const LogoutServiceDependencies({
    required this.revokeServerSession,
    required this.disconnectWebSocket,
    required this.disconnectRealtime,
    required this.clearPushSignedInUser,
    required this.cancelNotifications,
    required this.clearSecureStorage,
    required this.clearApiCache,
    required this.clearDownloadedFileCache,
    required this.purgeDocumentStaging,
    required this.clearCycleTracker,
    required this.clearUserProvider,
    required this.signOutFirebase,
  });

  factory LogoutServiceDependencies.defaults() {
    return LogoutServiceDependencies(
      revokeServerSession: LogoutService._revokeServerSession,
      disconnectWebSocket: WebSocketService.instance.disconnect,
      disconnectRealtime: RealtimeClient.instance.disconnect,
      clearPushSignedInUser: PushNotificationService.clearSignedInUser,
      cancelNotifications: NotificationScheduler.cancelAll,
      clearSecureStorage: LogoutService._storage.deleteAll,
      clearApiCache: ApiCacheManager.clearAll,
      clearDownloadedFileCache: CacheFileUtils.clearCache,
      purgeDocumentStaging: DocStaging.purge,
      clearCycleTracker: CycleTrackerStore.clearAll,
      clearUserProvider: () async {
        final provider = UserProvider.instance;
        if (provider != null) await provider.clear();
      },
      // Closure (not a tear-off) so FirebaseAuth.instance is only touched
      // when logout actually runs — pure-Dart tests construct these defaults
      // without a Firebase app.
      signOutFirebase: () => FirebaseAuth.instance.signOut(),
    );
  }

  final LogoutRevokeStep revokeServerSession;
  final LogoutStep disconnectWebSocket;
  final LogoutStep disconnectRealtime;
  final LogoutStep clearPushSignedInUser;
  final LogoutStep cancelNotifications;
  final LogoutStep clearSecureStorage;
  final LogoutStep clearApiCache;
  final LogoutStep clearDownloadedFileCache;
  final LogoutStep purgeDocumentStaging;
  final LogoutStep clearCycleTracker;
  final LogoutStep clearUserProvider;
  final LogoutStep signOutFirebase;
}
