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
