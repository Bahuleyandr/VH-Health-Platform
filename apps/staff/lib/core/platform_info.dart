import 'dart:io' show Platform;
import 'dart:ui' show PlatformDispatcher, Size;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/widgets.dart' show BuildContext, MediaQuery;

enum AppDeviceMode {
  mobile('mobile'),
  tablet('tablet'),
  desktop('desktop'),
  web('web');

  final String apiValue;
  const AppDeviceMode(this.apiValue);

  bool get isWorkbench =>
      this == AppDeviceMode.tablet || this == AppDeviceMode.desktop;

  bool get canMarkAttendance => this == AppDeviceMode.mobile;
}

const double tabletShortestSideBreakpoint = 600;

/// True on Flutter desktop builds (Windows / Linux / macOS).
///
/// Flutter's desktop targets ship no `firebase_messaging` or
/// `firebase_crashlytics` platform implementation, so every FCM /
/// Crashlytics call site must gate on this. Desktop staff workstations
/// still get realtime delivery (Code Blue, etc.) over the WebSocket
/// fabric via `RealtimeProvider`.
///
/// `kIsWeb` short-circuits before `Platform` is touched, so this is safe
/// to evaluate on web too (where it is always false).
bool get isDesktopPlatform =>
    !kIsWeb && (Platform.isWindows || Platform.isLinux || Platform.isMacOS);

AppDeviceMode deviceModeFromSignals({
  required bool isWeb,
  required bool isDesktop,
  Size? logicalSize,
}) {
  if (isWeb) return AppDeviceMode.web;
  if (isDesktop) return AppDeviceMode.desktop;
  final shortestSide = logicalSize?.shortestSide ?? 0;
  if (shortestSide >= tabletShortestSideBreakpoint) {
    return AppDeviceMode.tablet;
  }
  return AppDeviceMode.mobile;
}

Size? _primaryLogicalSize() {
  final views = PlatformDispatcher.instance.views;
  if (views.isEmpty) return null;
  final view = views.first;
  if (view.devicePixelRatio <= 0) return null;
  return view.physicalSize / view.devicePixelRatio;
}

AppDeviceMode get currentAppDeviceMode => deviceModeFromSignals(
  isWeb: kIsWeb,
  isDesktop: isDesktopPlatform,
  logicalSize: _primaryLogicalSize(),
);

AppDeviceMode appDeviceModeForContext(BuildContext context) =>
    deviceModeFromSignals(
      isWeb: kIsWeb,
      isDesktop: isDesktopPlatform,
      logicalSize: MediaQuery.sizeOf(context),
    );

/// `deviceType` claim the staff app sends at every login (and that the
/// backend echoes back into the JWT). Drives:
///   * `requireDeviceType('mobile')` on `/staff/attendance` - tablet/desktop
///     staff workstations are blocked from marking attendance.
///   * UI gating - the dashboard disables the attendance tile on non-mobile
///     and explains why users cannot mark attendance there.
///
/// Values: 'mobile' | 'tablet' | 'desktop' | 'web' - matches the backend's
/// `deviceTypeValidator` allow-list.
String get currentDeviceType => currentAppDeviceMode.apiValue;
