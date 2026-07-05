import 'package:flutter/material.dart';
import 'package:vhhealth_core/utils/request_reference.dart';
import '../../../l10n/app_strings.dart';
import '../../theme/app_theme.dart';

/// Replaces the 4-second-auto-dismiss [SnackBar] for save actions.
///
/// SnackBars are perfect for transient "X happened" notifications, but
/// for explicit save confirmations (bed notes saved, leave applied,
/// vitals recorded, prescription created) staff often miss the
/// confirmation because they're already tapping into the next screen
/// when the SnackBar fades. This banner sticks until the user does
/// something else (or 12s elapses, whichever first), and includes
/// a check-circle icon so it reads as success at a glance.
///
/// Usage:
/// ```
/// SuccessToast.show(context, 'Bed notes saved');
/// ```
///
/// Optional [action] for an inline "Undo" / "View" button.
class SuccessToast {
  const SuccessToast._();

  static void show(
    BuildContext context,
    String message, {
    SnackBarAction? action,
    Duration duration = const Duration(seconds: 12),
  }) {
    final strings = AppStrings.of(context);
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(
          // `liveRegion: true` tells assistive tech to announce the
          // message immediately when the SnackBar mounts. Without this
          // a TalkBack/NVDA user gets no audio cue that "Bed notes saved"
          // happened — they just see no visible UI change.
          content: Semantics(
            liveRegion: true,
            label: strings.format('s4.dynamic.success_toast.success_label', {
              'message': message,
            }),
            child: Row(
              children: [
                const Icon(Icons.check_circle, color: Colors.white, size: 20),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    message,
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              ],
            ),
          ),
          backgroundColor: AppTheme.successGreen,
          duration: duration,
          behavior: SnackBarBehavior.floating,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          action: action,
        ),
      );
  }
}

/// Companion to [SuccessToast] for the failure case. Same long duration
/// + dismiss-on-action UX so error messages stay visible long enough
/// to read on a noisy ward floor.
class ErrorToast {
  const ErrorToast._();

  static void show(
    BuildContext context,
    String message, {
    String? requestId,
    SnackBarAction? action,
    Duration duration = const Duration(seconds: 8),
  }) {
    final strings = AppStrings.of(context);
    final displayMessage = formatErrorWithRequestRef(
      message.replaceFirst('Exception: ', ''),
      requestId: requestId,
    );
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(
          // Same liveRegion treatment as SuccessToast — error needs
          // even more reliable assistive-tech announcement than success.
          content: Semantics(
            liveRegion: true,
            label: strings.format('s4.dynamic.error_toast.error_label', {
              'message': displayMessage,
            }),
            child: Row(
              children: [
                const Icon(Icons.error_outline, color: Colors.white, size: 20),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    displayMessage,
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              ],
            ),
          ),
          backgroundColor: AppTheme.errorRed,
          duration: duration,
          behavior: SnackBarBehavior.floating,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          action: action,
        ),
      );
  }
}
