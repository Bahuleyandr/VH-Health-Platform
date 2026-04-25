// Widget test for FontScaler — verifies the font sizing math.
//
// Pure Flutter widget test (no network / plugin deps).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/utils/font_scaler.dart';

void main() {
  testWidgets(
    'FontScaler.scale sizes the bodyLarge baseline to the given value',
    (tester) async {
      late TextTheme scaled;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (ctx) {
              scaled = FontScaler.scale(ctx, 16);
              return const Scaffold(body: SizedBox());
            },
          ),
        ),
      );
      expect(scaled.bodyLarge?.fontSize, 16.0);
      expect(scaled.bodyMedium?.fontSize, 14.0);
      expect(scaled.bodySmall?.fontSize, 12.0);
      expect(scaled.titleLarge?.fontSize, 20.0);
      expect(scaled.displayLarge?.fontSize, 30.0);
    },
  );

  testWidgets('FontScaler.scale preserves relative ordering across sizes', (
    tester,
  ) async {
    late TextTheme small;
    late TextTheme large;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (ctx) {
            small = FontScaler.scale(ctx, 12);
            large = FontScaler.scale(ctx, 20);
            return const Scaffold(body: SizedBox());
          },
        ),
      ),
    );
    expect(large.bodyLarge!.fontSize! > small.bodyLarge!.fontSize!, isTrue);
    expect(large.displayLarge!.fontSize! > large.titleLarge!.fontSize!, isTrue);
    expect(small.bodySmall!.fontSize! < small.bodyLarge!.fontSize!, isTrue);
  });
}
