import 'dart:ui' show Size;

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/platform_info.dart';

void main() {
  group('deviceModeFromSignals', () {
    test('web and desktop take precedence over screen size', () {
      expect(
        deviceModeFromSignals(
          isWeb: true,
          isDesktop: false,
          logicalSize: const Size(390, 844),
        ),
        AppDeviceMode.web,
      );
      expect(
        deviceModeFromSignals(
          isWeb: false,
          isDesktop: true,
          logicalSize: const Size(390, 844),
        ),
        AppDeviceMode.desktop,
      );
    });

    test('mobile-class devices become tablet at 600dp shortest side', () {
      expect(
        deviceModeFromSignals(
          isWeb: false,
          isDesktop: false,
          logicalSize: const Size(390, 844),
        ),
        AppDeviceMode.mobile,
      );
      expect(
        deviceModeFromSignals(
          isWeb: false,
          isDesktop: false,
          logicalSize: const Size(600, 960),
        ),
        AppDeviceMode.tablet,
      );
    });

    test('only mobile mode can mark attendance', () {
      expect(AppDeviceMode.mobile.canMarkAttendance, isTrue);
      expect(AppDeviceMode.tablet.canMarkAttendance, isFalse);
      expect(AppDeviceMode.desktop.canMarkAttendance, isFalse);
      expect(AppDeviceMode.web.canMarkAttendance, isFalse);
    });
  });
}
