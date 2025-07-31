import 'package:flutter/material.dart';

class FontScaler {
  static TextTheme scale(BuildContext context, double size) {
    final base = Theme.of(context).textTheme;
    return base.copyWith(
      displayLarge: base.displayLarge?.copyWith(fontSize: size + 14),
      displayMedium: base.displayMedium?.copyWith(fontSize: size + 12),
      displaySmall: base.displaySmall?.copyWith(fontSize: size + 10),
      headlineMedium: base.headlineMedium?.copyWith(fontSize: size + 8),
      headlineSmall: base.headlineSmall?.copyWith(fontSize: size + 6),
      titleLarge: base.titleLarge?.copyWith(fontSize: size + 4),
      bodyLarge: base.bodyLarge?.copyWith(fontSize: size),
      bodyMedium: base.bodyMedium?.copyWith(fontSize: size - 2),
      bodySmall: base.bodySmall?.copyWith(fontSize: size - 4),
    );
  }
}
