// lib/features/emr/widgets/note_draft_status_indicator.dart
//
// Small inline indicator for clinical-note autosave state. Renders
// "Saving… / Saved 2:14 pm / Offline — will sync / Couldn't save — retrying"
// from a [NoteDraftAutosave.status] notifier. Shared by OP Doctor Workspace
// and nursing notes.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/theme/app_theme.dart';
import '../note_draft_autosave.dart';

class NoteDraftStatusIndicator extends StatelessWidget {
  final ValueListenable<NoteDraftStatus> status;

  const NoteDraftStatusIndicator({super.key, required this.status});

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
      case NoteDraftStatusKind.saving:
        return (Icons.cloud_sync_outlined, 'Saving…', AppTheme.textSecondary);
      case NoteDraftStatusKind.saved:
        final at = value.savedAt;
        final when = at != null
            ? DateFormat('h:mm a').format(at.toLocal())
            : '';
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
}
