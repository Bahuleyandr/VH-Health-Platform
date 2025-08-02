// core/widgets/theme_card.dart
import 'package:flutter/material.dart';

class ThemeCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry? padding;
  final EdgeInsetsGeometry? margin;
  final double? elevation;
  
  const ThemeCard({
    super.key,
    required this.child,
    this.padding,
    this.margin,
    this.elevation,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDarkMode = theme.brightness == Brightness.dark;
    
    return Card(
      elevation: elevation ?? (isDarkMode ? 1 : 2),
      margin: margin ?? const EdgeInsets.all(8),
      color: isDarkMode 
          ? theme.colorScheme.surface 
          : Colors.white,
      surfaceTintColor: Colors.transparent,
      child: Padding(
        padding: padding ?? const EdgeInsets.all(16),
        child: child,
      ),
    );
  }
}