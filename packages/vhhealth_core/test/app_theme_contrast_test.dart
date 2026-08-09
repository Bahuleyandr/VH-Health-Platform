import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/theme/app_theme.dart';
import 'package:vhhealth_core/theme/design_tokens.dart';
import 'package:vhhealth_core/utils/color_contrast.dart';

/// Regression guard for the WCAG AA contrast fixes from the 2026-08
/// accessibility audit: dark-mode AppBar title/icons (was 1.70:1) and the
/// light-theme error colour (was 3.19:1).
void main() {
  group('AppBar contrast', () {
    test('light theme title and icons meet WCAG AA over the AppBar', () {
      final theme = AppTheme.getLightTheme(16);
      final appBar = theme.appBarTheme;
      final background = appBar.backgroundColor!;

      expect(
        contrastRatio(appBar.titleTextStyle!.color!, background),
        greaterThanOrEqualTo(4.5),
      );
      // Icons are non-text UI components — 3:1 minimum (WCAG 1.4.11).
      expect(
        contrastRatio(appBar.iconTheme!.color!, background),
        greaterThanOrEqualTo(3.0),
      );
    });

    test('dark theme title and icons meet WCAG AA over the AppBar', () {
      final theme = AppTheme.getDarkTheme(16);
      final appBar = theme.appBarTheme;
      final background = appBar.backgroundColor!;

      expect(
        contrastRatio(appBar.titleTextStyle!.color!, background),
        greaterThanOrEqualTo(4.5),
      );
      expect(
        contrastRatio(appBar.iconTheme!.color!, background),
        greaterThanOrEqualTo(3.0),
      );
    });
  });

  group('error colour contrast', () {
    test('light colorScheme.error meets 4.5:1 on surface and background', () {
      final scheme = AppTheme.getLightTheme(16).colorScheme;

      expect(
        contrastRatio(scheme.error, scheme.surface),
        greaterThanOrEqualTo(4.5),
      );
      expect(
        contrastRatio(scheme.error, VhDesignTokens.coreBackgroundLight),
        greaterThanOrEqualTo(4.5),
      );
      // onError text over error fills (e.g. filled error buttons).
      expect(
        contrastRatio(scheme.onError, scheme.error),
        greaterThanOrEqualTo(4.5),
      );
    });

    test('dark colorScheme.error meets 4.5:1 on dark surfaces', () {
      final scheme = AppTheme.getDarkTheme(16).colorScheme;

      expect(
        contrastRatio(scheme.error, scheme.surface),
        greaterThanOrEqualTo(4.5),
      );
      expect(
        contrastRatio(scheme.error, VhDesignTokens.coreBackgroundDark),
        greaterThanOrEqualTo(4.5),
      );
    });

    test('coreLight token error matches the compliant on-surface red', () {
      expect(VhDesignTokens.coreLight.error, VhDesignTokens.error);
      expect(
        contrastRatio(
          VhDesignTokens.coreLight.error,
          VhDesignTokens.surfaceLight,
        ),
        greaterThanOrEqualTo(4.5),
      );
    });
  });
}
