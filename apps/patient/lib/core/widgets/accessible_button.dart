import 'package:flutter/material.dart';

/// An accessible button wrapper that adds proper semantics.
class AccessibleButton extends StatelessWidget {
  final String label;
  final String? hint;
  final VoidCallback onPressed;
  final Widget child;
  final bool excludeSemantics;

  const AccessibleButton({
    super.key,
    required this.label,
    this.hint,
    required this.onPressed,
    required this.child,
    this.excludeSemantics = false,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      hint: hint,
      button: true,
      excludeSemantics: excludeSemantics,
      child: GestureDetector(onTap: onPressed, child: child),
    );
  }
}
