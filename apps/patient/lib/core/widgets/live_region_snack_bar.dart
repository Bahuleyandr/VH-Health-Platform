import 'package:flutter/material.dart';

/// Accessible snackbar helper.
///
/// Wraps the snackbar content in a `Semantics(liveRegion: true)` node so
/// TalkBack/VoiceOver announce the message when it appears, instead of the
/// transient text silently flashing on screen. All patient-app snackbars
/// should go through this helper rather than constructing a raw [SnackBar] —
/// see the a11y audit (WCAG 4.1.3 status messages).
class LiveRegionSnackBar {
  const LiveRegionSnackBar._();

  static SnackBar build({
    required String message,
    String? announcementPrefix,
    Color? backgroundColor,
    SnackBarBehavior behavior = SnackBarBehavior.fixed,
    Duration? duration,
    EdgeInsetsGeometry? margin,
    ShapeBorder? shape,
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
      margin: margin,
      shape: shape,
    );
  }

  static void show(
    BuildContext context, {
    required String message,
    String? announcementPrefix,
    Color? backgroundColor,
    SnackBarBehavior behavior = SnackBarBehavior.fixed,
    Duration? duration,
    EdgeInsetsGeometry? margin,
    ShapeBorder? shape,
  }) {
    ScaffoldMessenger.of(context).showSnackBar(
      build(
        message: message,
        announcementPrefix: announcementPrefix,
        backgroundColor: backgroundColor,
        behavior: behavior,
        duration: duration,
        margin: margin,
        shape: shape,
      ),
    );
  }
}
