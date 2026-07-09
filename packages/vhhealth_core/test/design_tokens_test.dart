import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/theme/design_tokens.dart';

void main() {
  group('VhDesignTokens contract', () {
    test('matches the shared NL11-S04 token contract', () {
      final contract = _readContract();
      final colors = contract['colors'] as Map<String, dynamic>;
      final brand = colors['brand'] as Map<String, dynamic>;
      final clinical = colors['clinical'] as Map<String, dynamic>;
      final status = colors['status'] as Map<String, dynamic>;

      expect(_hex(VhDesignTokens.brandPrimary), brand['primary']);
      expect(_hex(VhDesignTokens.brandOnPrimary), brand['onPrimary']);
      expect(_hex(VhDesignTokens.brandPrimaryDark), brand['primaryDark']);
      expect(_hex(VhDesignTokens.clinicalPrimary), clinical['primary']);
      expect(_hex(VhDesignTokens.clinicalPrimaryDark), clinical['primaryDark']);
      expect(
        _hex(VhDesignTokens.warningOnSurfaceLight),
        status['warningOnSurfaceLight'],
      );
    });

    test('primary and warning text tokens meet contrast gates', () {
      expect(
        _contrast(VhDesignTokens.brandPrimary, VhDesignTokens.brandOnPrimary),
        greaterThanOrEqualTo(VhDesignTokens.minimumTextContrast),
      );
      expect(
        _contrast(
          VhDesignTokens.clinicalPrimary,
          VhDesignTokens.clinicalOnPrimary,
        ),
        greaterThanOrEqualTo(VhDesignTokens.minimumTextContrast),
      );
      expect(
        _contrast(
          VhDesignTokens.warningOnSurfaceLight,
          VhDesignTokens.surfaceLight,
        ),
        greaterThanOrEqualTo(VhDesignTokens.minimumTextContrast),
      );
      expect(
        _contrast(VhDesignTokens.warningOnSurfaceDark, VhDesignTokens.cardDark),
        greaterThanOrEqualTo(VhDesignTokens.minimumTextContrast),
      );
    });

    test('theme extensions expose color and shape adapters', () {
      final light = ThemeData(
        extensions: const <ThemeExtension<dynamic>>[
          VhDesignTokens.coreLight,
          VhDesignTokens.shape,
        ],
      );

      expect(light.vhColors.primary, VhDesignTokens.brandPrimary);
      expect(light.vhShape.cardRadius, 12);
      expect(light.vhShape.focusRingWidth, 2);
    });
  });
}

Map<String, dynamic> _readContract() {
  final candidates = [
    File('../../docs/superpowers/design-system/vhhealth-design-tokens.json'),
    File('docs/superpowers/design-system/vhhealth-design-tokens.json'),
  ];
  final file = candidates.firstWhere((candidate) => candidate.existsSync());
  return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
}

String _hex(Color color) {
  final rgb = color.toARGB32() & 0x00FFFFFF;
  return '#${rgb.toRadixString(16).padLeft(6, '0').toUpperCase()}';
}

double _contrast(Color a, Color b) {
  final first = _relativeLuminance(a);
  final second = _relativeLuminance(b);
  final lighter = first > second ? first : second;
  final darker = first > second ? second : first;
  return (lighter + 0.05) / (darker + 0.05);
}

double _relativeLuminance(Color color) {
  final argb = color.toARGB32();
  final red = (argb >> 16) & 0xff;
  final green = (argb >> 8) & 0xff;
  final blue = argb & 0xff;
  return 0.2126 * _linear(red) +
      0.7152 * _linear(green) +
      0.0722 * _linear(blue);
}

double _linear(int channel) {
  final value = channel / 255;
  if (value <= 0.03928) return value / 12.92;
  return math.pow((value + 0.055) / 1.055, 2.4).toDouble();
}
