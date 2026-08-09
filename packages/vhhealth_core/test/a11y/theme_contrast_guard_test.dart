// Accessibility regression guard — WCAG contrast of the shared AppTheme
// ColorSchemes (audit PR 4). Both the patient and staff apps build their
// themes from AppTheme.getLightTheme/getDarkTheme, so a regression here
// fans out to every screen of both apps.
//
// The WCAG math is self-contained (see `_contrastRatio` below) so these
// guards run un-skipped on main; PR #780 adds a shared
// `package:vhhealth_core/utils/color_contrast.dart` with the same formulas.
//
// Skipped groups assert the END STATE required by the a11y audit; they fail
// on today's main only because the fix is sitting in the named unmerged PR.
// Un-skip them (delete the `skip:` argument) as each PR merges.
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/theme/app_theme.dart';

/// PR 1 of the accessibility plan — error-colour + AppBar contrast fixes.
const String kBlockedOnPr780 = 'Blocked on PR #780 — un-skip after merge';

double _linearize(double channel) {
  return channel <= 0.03928
      ? channel / 12.92
      : math.pow((channel + 0.055) / 1.055, 2.4).toDouble();
}

double _luminance(Color color) {
  return 0.2126 * _linearize(color.r) +
      0.7152 * _linearize(color.g) +
      0.0722 * _linearize(color.b);
}

/// WCAG 2.x contrast ratio between two opaque colours, in `[1, 21]`.
double _contrastRatio(Color a, Color b) {
  final double la = _luminance(a);
  final double lb = _luminance(b);
  return (math.max(la, lb) + 0.05) / (math.min(la, lb) + 0.05);
}

void main() {
  final ThemeData light = AppTheme.getLightTheme(16);
  final ThemeData dark = AppTheme.getDarkTheme(16);

  group('active theme-contrast guards (green on main)', () {
    test('light: onPrimary on primary meets 4.5:1', () {
      expect(
        _contrastRatio(light.colorScheme.onPrimary, light.colorScheme.primary),
        greaterThanOrEqualTo(4.5),
      );
    });

    test('dark: onPrimary on primary meets 4.5:1', () {
      expect(
        _contrastRatio(dark.colorScheme.onPrimary, dark.colorScheme.primary),
        greaterThanOrEqualTo(4.5),
      );
    });

    test(
      'light: onSurface on surface and on scaffold background meet 4.5:1',
      () {
        expect(
          _contrastRatio(
            light.colorScheme.onSurface,
            light.colorScheme.surface,
          ),
          greaterThanOrEqualTo(4.5),
        );
        expect(
          _contrastRatio(
            light.colorScheme.onSurface,
            light.scaffoldBackgroundColor,
          ),
          greaterThanOrEqualTo(4.5),
        );
      },
    );

    test(
      'dark: onSurface on surface and on scaffold background meet 4.5:1',
      () {
        expect(
          _contrastRatio(dark.colorScheme.onSurface, dark.colorScheme.surface),
          greaterThanOrEqualTo(4.5),
        );
        expect(
          _contrastRatio(
            dark.colorScheme.onSurface,
            dark.scaffoldBackgroundColor,
          ),
          greaterThanOrEqualTo(4.5),
        );
      },
    );

    test('dark: error text on surface meets 4.5:1', () {
      expect(
        _contrastRatio(dark.colorScheme.error, dark.colorScheme.surface),
        greaterThanOrEqualTo(4.5),
      );
    });

    test('light: AppBar title and icons meet 4.5:1 over the AppBar fill', () {
      final AppBarThemeData appBar = light.appBarTheme;
      final Color fill = appBar.backgroundColor!;
      expect(
        _contrastRatio(appBar.titleTextStyle!.color!, fill),
        greaterThanOrEqualTo(4.5),
      );
      expect(
        _contrastRatio(appBar.iconTheme!.color!, fill),
        // Icons are non-text UI components: WCAG 1.4.11 requires 3:1.
        greaterThanOrEqualTo(3.0),
      );
    });
  });

  group('error-colour guards (fixed by PR #780)', () {
    test('light: error text on surface meets 4.5:1', () {
      // Main still ships the legacy danger red (#FF5252, 3.19:1 on white);
      // #780 swaps the light scheme to the compliant token (#C62828).
      expect(
        _contrastRatio(light.colorScheme.error, light.colorScheme.surface),
        greaterThanOrEqualTo(4.5),
      );
    });

    test('light: onError on error meets 4.5:1', () {
      expect(
        _contrastRatio(light.colorScheme.onError, light.colorScheme.error),
        greaterThanOrEqualTo(4.5),
      );
    });

    test('dark: onError on error meets 4.5:1', () {
      // White on #FF5252 is 3.19:1; #780 flips dark onError to black.
      expect(
        _contrastRatio(dark.colorScheme.onError, dark.colorScheme.error),
        greaterThanOrEqualTo(4.5),
      );
    });
  }, skip: kBlockedOnPr780);

  group('dark AppBar guard (fixed by PR #780)', () {
    test('dark: AppBar title and icons meet contrast over the AppBar fill', () {
      // The audit blocker: hardcoded brand white over the light mint
      // dark-mode primary was 1.70:1 on every dark-mode screen.
      final AppBarThemeData appBar = dark.appBarTheme;
      final Color fill = appBar.backgroundColor!;
      expect(
        _contrastRatio(appBar.titleTextStyle!.color!, fill),
        greaterThanOrEqualTo(4.5),
      );
      expect(
        _contrastRatio(appBar.iconTheme!.color!, fill),
        greaterThanOrEqualTo(3.0),
      );
    });
  }, skip: kBlockedOnPr780);
}
