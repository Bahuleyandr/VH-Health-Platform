// lib/core/widgets/logo_background.dart
// lib/core/widgets/logo_background.dart
import 'package:flutter/material.dart';

class LogoBackground extends StatelessWidget {
  final Widget child;

  const LogoBackground({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      child: Stack(
        fit: StackFit.expand,
        children: [
          // Watermark logo
          Center(
            child: Opacity(
              opacity: 0.1,
              child: FractionallySizedBox(
                widthFactor: 0.7,
                child: Image.asset(
                  'assets/images/hospital_icon.png',
                  fit: BoxFit.contain,
                  errorBuilder: (context, error, stackTrace) {
                    return const SizedBox.shrink();
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