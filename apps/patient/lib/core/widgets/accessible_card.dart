import 'package:flutter/material.dart';

/// A card wrapper with proper semantics for screen readers.
class AccessibleCard extends StatelessWidget {
  final String label;
  final String? value;
  final Widget child;
  final VoidCallback? onTap;

  const AccessibleCard({
    super.key,
    required this.label,
    this.value,
    required this.child,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      value: value,
      container: true,
      child: onTap != null ? InkWell(onTap: onTap, child: child) : child,
    );
  }
}
