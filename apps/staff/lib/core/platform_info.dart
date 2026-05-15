import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;

/// True on Flutter desktop builds (Windows / Linux / macOS).
///
/// Flutter's desktop targets ship no `firebase_messaging` or
/// `firebase_crashlytics` platform implementation, so every FCM /
/// Crashlytics call site must gate on this. Desktop staff workstations
/// still get realtime delivery (Code Blue, etc.) over the WebSocket
/// fabric — see `WebSocketService` / `RealtimeProvider`.
///
/// `kIsWeb` short-circuits before `Platform` is touched, so this is safe
/// to evaluate on web too (where it is always false).
bool get isDesktopPlatform =>
    !kIsWeb && (Platform.isWindows || Platform.isLinux || Platform.isMacOS);

/// `deviceType` claim the staff app sends at every login (and that the
/// backend echoes back into the JWT). Drives:
///   * `requireDeviceType('mobile')` on `/staff/attendance` — desktop staff
///     workstations are blocked from marking attendance.
///   * UI gating — the dashboard hides the attendance tile on desktop so
///     users don't get a 403 surprise.
///
/// Values: 'mobile' | 'desktop' | 'web' — matches the backend's
/// `deviceTypeValidator` allow-list.
String get currentDeviceType {
  if (kIsWeb) return 'web';
  if (isDesktopPlatform) return 'desktop';
  return 'mobile';
}
