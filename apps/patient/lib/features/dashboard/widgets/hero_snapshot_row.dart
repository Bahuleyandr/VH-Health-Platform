import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

/// Small horizontal strip rendered just under the greeting in the
/// dashboard header. Surfaces 2-3 "about you right now" facts so the
/// top of the screen tells the user something specific instead of
/// being purely a greeting.
///
/// All fields are nullable — the row collapses entries that have no
/// data so it never looks empty.
class HeroSnapshotRow extends StatelessWidget {
  final int? unreadNotifications;
  final String? nextAppointmentLabel; // e.g. "Tomorrow", "in 5 days"
  final String? lastVitalsLabel;      // e.g. "12h ago", "Log now"

  const HeroSnapshotRow({
    super.key,
    this.unreadNotifications,
    this.nextAppointmentLabel,
    this.lastVitalsLabel,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    final entries = <_SnapshotEntry>[];
    if (nextAppointmentLabel != null && nextAppointmentLabel!.isNotEmpty) {
      entries.add(_SnapshotEntry(
        icon: LucideIcons.calendarCheck,
        text: nextAppointmentLabel!,
        tint: cs.primary,
      ));
    }
    if (unreadNotifications != null && unreadNotifications! > 0) {
      entries.add(_SnapshotEntry(
        icon: LucideIcons.bell,
        text: '$unreadNotifications unread',
        tint: Colors.amber,
      ));
    }
    if (lastVitalsLabel != null && lastVitalsLabel!.isNotEmpty) {
      entries.add(_SnapshotEntry(
        icon: LucideIcons.heartPulse,
        text: lastVitalsLabel!,
        tint: Colors.pinkAccent,
      ));
    }

    if (entries.isEmpty) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (var i = 0; i < entries.length; i++) ...[
              if (i > 0) const SizedBox(width: 8),
              _SnapshotChip(entry: entries[i]),
            ],
          ],
        ),
      ),
    );
  }
}

class _SnapshotEntry {
  final IconData icon;
  final String text;
  final Color tint;
  _SnapshotEntry({required this.icon, required this.text, required this.tint});
}

class _SnapshotChip extends StatelessWidget {
  final _SnapshotEntry entry;
  const _SnapshotChip({required this.entry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: entry.tint.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: entry.tint.withValues(alpha: 0.35)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(entry.icon, size: 14, color: entry.tint),
          const SizedBox(width: 6),
          Text(
            entry.text,
            style: theme.textTheme.labelSmall?.copyWith(
              fontWeight: FontWeight.w600,
              color: entry.tint,
            ),
          ),
        ],
      ),
    );
  }
}
