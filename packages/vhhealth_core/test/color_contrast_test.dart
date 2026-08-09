import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/utils/color_contrast.dart';

void main() {
  group('contrastRatio', () {
    test('black on white is 21:1 and order-independent', () {
      expect(contrastRatio(Colors.black, Colors.white), closeTo(21, 0.01));
      expect(contrastRatio(Colors.white, Colors.black), closeTo(21, 0.01));
    });

    test('identical colours are 1:1', () {
      const c = Color(0xFF5EDBBC);
      expect(contrastRatio(c, c), closeTo(1, 0.001));
    });

    test('reproduces the audited failure ratios', () {
      // White over the mint dark-mode primary (audit blocker: 1.70:1).
      expect(
        contrastRatio(Colors.white, const Color(0xFF5EDBBC)),
        closeTo(1.70, 0.01),
      );
      // Legacy danger red on white (audit high: 3.19:1).
      expect(
        contrastRatio(const Color(0xFFFF5252), Colors.white),
        closeTo(3.19, 0.01),
      );
    });
  });

  group('ensureTextContrast', () {
    const lightBackground = Color(0xFFE0F5F6);
    const darkBackground = Color(0xFF121212);

    test('returns the colour unchanged when it already passes', () {
      const pastel = Color(0xFFA8E6CF);
      expect(ensureTextContrast(pastel, darkBackground), pastel);
      expect(ensureTextContrast(Colors.black, lightBackground), Colors.black);
    });

    test('darkens pastels on light backgrounds until 4.5:1', () {
      const pastels = [
        Color(0xFFA8E6CF),
        Color(0xFFB3E5FC),
        Color(0xFFD1C4E9),
        Color(0xFF80DEEA),
        Color(0xFFFFE082),
        Color(0xFF9FA8DA),
        Color(0xFFC5E1A5),
        Color(0xFFFFCCBC),
      ];
      for (final pastel in pastels) {
        final adjusted = ensureTextContrast(pastel, lightBackground);
        expect(
          contrastRatio(adjusted, lightBackground),
          greaterThanOrEqualTo(4.5),
          reason: 'pastel $pastel should be adjusted to meet 4.5:1',
        );
        // Hue is preserved (same-family colour, not a generic grey).
        expect(
          (HSLColor.fromColor(adjusted).hue - HSLColor.fromColor(pastel).hue)
              .abs(),
          lessThan(2),
        );
      }
    });

    test('lightens dark colours on dark backgrounds until 4.5:1', () {
      const navy = Color(0xFF1A237E);
      final adjusted = ensureTextContrast(navy, darkBackground);
      expect(
        contrastRatio(adjusted, darkBackground),
        greaterThanOrEqualTo(4.5),
      );
    });

    test('chooses the passing direction on a mid-tone background', () {
      const midToneBackground = Color(0xFFAAAAAA);
      const foreground = Color(0xFF888888);

      final adjusted = ensureTextContrast(foreground, midToneBackground);

      expect(
        contrastRatio(adjusted, midToneBackground),
        greaterThanOrEqualTo(4.5),
      );
      expect(
        adjusted.computeLuminance(),
        lessThan(foreground.computeLuminance()),
      );
    });

    test('honours a custom minimum ratio', () {
      const pastel = Color(0xFFA8E6CF);
      final adjusted = ensureTextContrast(
        pastel,
        lightBackground,
        minRatio: 3.0,
      );
      expect(contrastRatio(adjusted, lightBackground), greaterThanOrEqualTo(3));
    });

    test('rejects impossible or non-finite minimum ratios', () {
      for (final ratio in [0.9, 21.1, double.nan, double.infinity]) {
        expect(
          () => ensureTextContrast(Colors.black, Colors.white, minRatio: ratio),
          throwsArgumentError,
        );
      }

      expect(
        () => ensureTextContrast(
          const Color(0xFF888888),
          const Color(0xFF888888),
          minRatio: 21,
        ),
        throwsArgumentError,
      );
    });
  });
}
