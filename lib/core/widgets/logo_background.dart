// lib/core/widgets/logo_background.dart
import 'package:flutter/material.dart';

class LogoBackground extends StatelessWidget {
  final Widget child;
  final double opacity;
  
  const LogoBackground({
    super.key, 
    required this.child,
    this.opacity = 0.1,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDarkMode = theme.brightness == Brightness.dark;
    
    // Calculate opacity based on theme
    final logoOpacity = isDarkMode ? opacity * 0.5 : opacity;
    
    return Container(
      // Use theme's scaffold background color instead of hardcoded white
      color: theme.scaffoldBackgroundColor,
      child: Stack(
        fit: StackFit.expand,
        children: [
          // Watermark logo
          Center(
            child: Opacity(
              opacity: logoOpacity,
              child: FractionallySizedBox(
                widthFactor: 0.7,
                child: Image.asset(
                  'assets/images/hospital_icon.png',
                  fit: BoxFit.contain,
                  // Apply color filter in dark mode for better visibility
                  color: isDarkMode 
                      ? theme.colorScheme.onSurface.withOpacity(0.5)
                      : null,
                  colorBlendMode: isDarkMode ? BlendMode.modulate : null,
                  errorBuilder: (context, error, stackTrace) {
                    // Fallback to a simple icon if image fails to load
                    return Icon(
                      Icons.local_hospital,
                      size: 200,
                      color: theme.colorScheme.onSurface.withOpacity(
                        isDarkMode ? 0.05 : 0.1
                      ),
                    );
                  },
                ),
              ),
            ),
          ),
          // Main content
          Positioned.fill(
            child: child,
          ),
        ],
      ),
    );
  }
}