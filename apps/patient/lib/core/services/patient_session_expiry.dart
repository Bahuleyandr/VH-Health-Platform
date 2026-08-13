import 'package:flutter/foundation.dart';

import 'package:vhhealth/core/navigation/app_router.dart';
import 'package:vhhealth/core/services/logout_service.dart';

/// The single definition of "this patient's session is definitively dead".
///
/// TWO independent transports discover that fact, and both must run the SAME
/// teardown:
///
///  * `VHHttpClient` / `ApiClient` — a 401 whose single-flight refresh failed.
///    Wired in `main.dart` via `ApiClient.onSessionExpired`.
///  * `RealtimeClient` — a **4001** socket close whose refresh failed.
///    `realtime_client.dart` (`_handleAuthFailureAndMaybeReconnect`) clears the
///    JWT and the refresh token, stops reconnecting, and calls
///    `onSessionExpired`.
///
/// The realtime leg was UNWIRED on the patient app: `main.dart` constructed
/// `RealtimeProvider()` with no callback, so `onSessionExpired?.call()` hit a
/// null and the ONLY thing that happened on a server-side revocation was that
/// the two tokens were dropped from secure storage. Everything else survived on
/// the device — the encrypted API cache, downloaded documents, staged plaintext
/// documents, cycle-tracker PHI, the dependents roster, the Firebase session
/// and the FCM registration — which is precisely the exposure `LogoutService`
/// exists to close on a shared or family handset. The staff app has wired the
/// same callback since `apps/staff/lib/main.dart`.
///
/// Note this is the LAST-RESORT leg, not the only one. When the socket is
/// healthy the backend also pushes a `session:revoked` event, which
/// `SessionRevocationListener` turns into the same `LogoutService.logout()`.
/// The 4001 path covers the case where the socket is closed BEFORE that event
/// can be delivered — exactly what `wsServer.pushSessionRevoked` does on
/// "signed out everywhere", admin revocation, password change and account
/// deletion.
///
/// [redirectToLogin] is injectable for tests only; production callers use the
/// default so there is one navigation contract.
void handlePatientSessionExpired({VoidCallback? redirectToLogin}) {
  // Deliberately delegates rather than re-implementing: LogoutService.
  // handleSessionExpired is single-flight through LogoutService.logout(), so a
  // 4001 close racing the 401 that follows it collapses into ONE wipe instead
  // of two interleaved ones. It is also the guest-safe entry point — a guest
  // session has no server credential to revoke and must not be bounced to
  // /login.
  LogoutService.handleSessionExpired(
    redirectToLogin: redirectToLogin ?? _defaultRedirectToLogin,
  );
}

void _defaultRedirectToLogin() => AppRouter.router.go('/login');
