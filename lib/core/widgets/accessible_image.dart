import 'package:flutter/material.dart';

/// An image with proper semantic description for screen readers.
class AccessibleImage extends StatelessWidget {
  final ImageProvider image;
  final String description;
  final double? width;
  final double? height;
  final BoxFit? fit;

  const AccessibleImage({
    super.key,
    required this.image,
    required this.description,
    this.width,
    this.height,
    this.fit,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: description,
      image: true,
      child: Image(
        image: image,
        width: width,
        height: height,
        fit: fit,
        semanticLabel: description,
      ),
    );
  }
}
