// lib/features/emr/widgets/note_draft_status_indicator.dart
//
// Small inline indicator for clinical-note autosave state. Renders
// "Saving… / Saved 2:14 pm / Offline — will sync / Couldn't save — retrying"
// from a [NoteDraftAutosave.status] notifier. Shared by OP Doctor Workspace
// and nursing notes.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';
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
        final (icon, label, color) = _present(context, value);
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

  (IconData, String?, Color) _present(
    BuildContext context,
    NoteDraftStatus value,
  ) {
    final s = AppStrings.of(context);
    switch (value.kind) {
      case NoteDraftStatusKind.idle:
        return (Icons.cloud_done_outlined, null, AppTheme.textSecondary);
      case NoteDraftStatusKind.dirty:
        return (
          Icons.edit_outlined,
          s.lookup('s4.lib.note_draft_status.unsaved_changes'),
          AppTheme.textSecondary,
        );
      case NoteDraftStatusKind.saving:
        return (
          Icons.cloud_sync_outlined,
          s.lookup('s4.lib.note_draft_status.saving'),
          AppTheme.textSecondary,
        );
      case NoteDraftStatusKind.saved:
        final at = value.savedAt;
        final when = at != null ? _relativeTime(context, at) : '';
        return (
          Icons.cloud_done_outlined,
          when.isEmpty
              ? s.lookup('s4.lib.note_draft_status.draft_saved')
              : s.format('s4.dynamic.note_draft_status.saved_when', {
                  'when': when,
                }),
          AppTheme.successOnSurface,
        );
      case NoteDraftStatusKind.offline:
        return (
          Icons.cloud_off_outlined,
          s.lookup('s4.lib.note_draft_status.offline_will_sync'),
          AppTheme.warningOnSurface,
        );
      case NoteDraftStatusKind.error:
        return (
          Icons.error_outline,
          s.lookup('s4.lib.note_draft_status.save_failed_retrying'),
          AppTheme.warningOnSurface,
        );
    }
  }

  /// Relative "Saved just now / 2m ago / 1h ago" label so a stalled save looks
  /// visibly old (rather than a static clock time that never changes). Quiet
  /// by design — no alarming age threshold; the status flips to error on a
  /// failed PUT, which is the real signal.
  String _relativeTime(BuildContext context, DateTime at) {
    final s = AppStrings.of(context);
    final delta = (now ?? DateTime.now)().difference(at);
    if (delta.isNegative || delta.inSeconds < 45) {
      return s.lookup('s4.lib.note_draft_status.just_now');
    }
    if (delta.inMinutes < 60) {
      return s.format('s4.dynamic.note_draft_status.minutes_ago', {
        'count': delta.inMinutes,
      });
    }
    if (delta.inHours < 24) {
      return s.format('s4.dynamic.note_draft_status.hours_ago', {
        'count': delta.inHours,
      });
    }
    return s.format('s4.dynamic.note_draft_status.days_ago', {
      'count': delta.inDays,
    });
  }
}
