import 'package:flutter/material.dart';

class ConstrainedContent extends StatelessWidget {
  static const double defaultMaxWidth = 1280;

  final Widget child;
  final double maxWidth;
  final AlignmentGeometry alignment;

  const ConstrainedContent({
    super.key,
    required this.child,
    this.maxWidth = defaultMaxWidth,
    this.alignment = Alignment.topCenter,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final effectiveWidth =
            constraints.hasBoundedWidth && constraints.maxWidth < maxWidth
            ? constraints.maxWidth
            : maxWidth;
        final sizedChild = constraints.hasBoundedHeight
            ? SizedBox(
                width: effectiveWidth,
                height: constraints.maxHeight,
                child: child,
              )
            : SizedBox(width: effectiveWidth, child: child);
        return Align(alignment: alignment, child: sizedChild);
      },
    );
  }
}
