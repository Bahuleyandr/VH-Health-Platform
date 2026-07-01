// lib/features/emr/widgets/note_draft_status_indicator.dart
//
// Small inline indicator for clinical-note autosave state. Renders
// "Saving… / Saved 2:14 pm / Offline — will sync / Couldn't save — retrying"
// from a [NoteDraftAutosave.status] notifier. Shared by OP Doctor Workspace
// and nursing notes.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../../core/theme/app_theme.dart';
import '../note_draft_autosave.dart';

class NoteDraftStatusIndicator extends StatelessWidget {
  final ValueListenable<NoteDraftStatus> status;

  /// Injectable clock so the relative "Saved 2m ago" label is testable.
  /// Null → uses the wall clock (kept nullable so the widget stays `const`).
  final DateTime Function()? now;

  const NoteDraftStatusIndicator({super.key, required this.status, this.now});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<NoteDraftStatus>(
      valueListenable: status,
      builder: (context, value, _) {
        final (icon, label, color) = _present(value);
        if (label == null) return const SizedBox.shrink();
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (value.kind == NoteDraftStatusKind.saving)
              SizedBox(
                width: 12,
                height: 12,
                child: CircularProgressIndicator(strokeWidth: 2, color: color),
              )
            else
              Icon(icon, size: 14, color: color),
            const SizedBox(width: 6),
            Text(
              label,
              style: TextStyle(
                color: color,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        );
      },
    );
  }

  (IconData, String?, Color) _present(NoteDraftStatus value) {
    switch (value.kind) {
      case NoteDraftStatusKind.idle:
        return (Icons.cloud_done_outlined, null, AppTheme.textSecondary);
      case NoteDraftStatusKind.dirty:
        return (
          Icons.edit_outlined,
          'Unsaved changes…',
          AppTheme.textSecondary,
        );
      case NoteDraftStatusKind.saving:
        return (Icons.cloud_sync_outlined, 'Saving…', AppTheme.textSecondary);
      case NoteDraftStatusKind.saved:
        final at = value.savedAt;
        final when = at != null ? _relativeTime(at) : '';
        return (
          Icons.cloud_done_outlined,
          when.isEmpty ? 'Draft saved' : 'Saved $when',
          AppTheme.successOnSurface,
        );
      case NoteDraftStatusKind.offline:
        return (
          Icons.cloud_off_outlined,
          'Offline — will sync',
          AppTheme.warningOnSurface,
        );
      case NoteDraftStatusKind.error:
        return (
          Icons.error_outline,
          'Couldn\'t save draft — retrying',
          AppTheme.warningOnSurface,
        );
    }
  }

  /// Relative "Saved just now / 2m ago / 1h ago" label so a stalled save looks
  /// visibly old (rather than a static clock time that never changes). Quiet
  /// by design — no alarming age threshold; the status flips to error on a
  /// failed PUT, which is the real signal.
  String _relativeTime(DateTime at) {
    final delta = (now ?? DateTime.now)().difference(at);
    if (delta.isNegative || delta.inSeconds < 45) return 'just now';
    if (delta.inMinutes < 60) return '${delta.inMinutes}m ago';
    if (delta.inHours < 24) return '${delta.inHours}h ago';
    return '${delta.inDays}d ago';
  }
}
