import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/theme/design_tokens.dart';
import 'package:vhhealth_staff/core/theme/app_theme.dart';

void main() {
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
  });

  group('AppTheme desktop polish', () {
    test('keeps scrollbars persistently visible on desktop platforms', () {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;

      final theme = AppTheme.lightTheme;
      final scrollbar = theme.scrollbarTheme;

      expect(scrollbar.thumbVisibility?.resolve({}), isTrue);
      expect(scrollbar.trackVisibility?.resolve({}), isTrue);
      expect(scrollbar.thickness?.resolve({}), 10);
      expect(scrollbar.interactive, isTrue);
    });

    test('leaves mobile scrollbar visibility on platform defaults', () {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;

      final scrollbar = AppTheme.lightTheme.scrollbarTheme;

      expect(scrollbar.thumbVisibility?.resolve({}), isNull);
      expect(scrollbar.trackVisibility?.resolve({}), isNull);
      expect(scrollbar.thickness?.resolve({}), isNull);
      expect(scrollbar.interactive, isFalse);
    });

    test('supplies hover overlays for rows and app-level buttons', () {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;

      final theme = AppTheme.lightTheme;
      const hovered = {WidgetState.hovered};

      expect(theme.hoverColor, isNot(Colors.transparent));
      expect(
        theme.listTileTheme.mouseCursor?.resolve(hovered),
        SystemMouseCursors.click,
      );
      expect(
        theme.elevatedButtonTheme.style?.overlayColor?.resolve(hovered),
        isNotNull,
      );
      expect(
        theme.filledButtonTheme.style?.overlayColor?.resolve(hovered),
        isNotNull,
      );
      expect(
        theme.outlinedButtonTheme.style?.overlayColor?.resolve(hovered),
        isNotNull,
      );
      expect(
        theme.textButtonTheme.style?.overlayColor?.resolve(hovered),
        isNotNull,
      );
      expect(
        theme.iconButtonTheme.style?.overlayColor?.resolve(hovered),
        isNotNull,
      );
    });
  });

  group('AppTheme design tokens', () {
    test('attaches staff color and shape extensions', () {
      final light = AppTheme.lightTheme;
      final colors = light.extension<VhColorTokens>();
      final shape = light.extension<VhShapeTokens>();

      expect(colors, isNotNull);
      expect(colors?.primary, VhDesignTokens.clinicalPrimary);
      expect(colors?.warningOnSurface, VhDesignTokens.warningOnSurfaceLight);
      expect(shape?.cardRadius, 12);
      expect(shape?.focusRingWidth, 2);
    });

    test('uses AA warning-on-surface colors for body text', () {
      AppTheme.brightness = Brightness.light;
      expect(AppTheme.warningOnSurface, VhDesignTokens.warningOnSurfaceLight);

      AppTheme.brightness = Brightness.dark;
      expect(AppTheme.warningOnSurface, VhDesignTokens.warningOnSurfaceDark);
    });
  });
}
