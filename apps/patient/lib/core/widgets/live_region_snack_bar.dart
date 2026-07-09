import 'package:flutter/material.dart';

class LiveRegionSnackBar {
  const LiveRegionSnackBar._();

  static SnackBar build({
    required String message,
    String? announcementPrefix,
    Color? backgroundColor,
    SnackBarBehavior behavior = SnackBarBehavior.fixed,
    Duration? duration,
  }) {
    final semanticLabel = announcementPrefix == null
        ? message
        : '$announcementPrefix: $message';

    return SnackBar(
      content: Semantics(
        liveRegion: true,
        label: semanticLabel,
        child: Text(message),
      ),
      backgroundColor: backgroundColor,
      behavior: behavior,
      duration: duration ?? const Duration(seconds: 4),
    );
  }

  static void show(
    BuildContext context, {
    required String message,
    String? announcementPrefix,
    Color? backgroundColor,
    SnackBarBehavior behavior = SnackBarBehavior.fixed,
    Duration? duration,
  }) {
    ScaffoldMessenger.of(context).showSnackBar(
      build(
        message: message,
        announcementPrefix: announcementPrefix,
        backgroundColor: backgroundColor,
        behavior: behavior,
        duration: duration,
      ),
    );
  }
}
