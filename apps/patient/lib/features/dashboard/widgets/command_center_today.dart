import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class CommandCenterToday extends StatelessWidget {
  final List<Map<String, dynamic>> cards;
  final bool loading;
  final String? error;
  final VoidCallback onRetry;
  final ValueChanged<Map<String, dynamic>> onOpenCard;

  const CommandCenterToday({
    super.key,
    required this.cards,
    required this.loading,
    required this.error,
    required this.onRetry,
    required this.onOpenCard,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    if (loading && cards.isEmpty) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 18),
        child: Center(child: CircularProgressIndicator()),
      );
    }

    if (error != null && cards.isEmpty) {
      return _CommandCenterNotice(
        icon: LucideIcons.wifiOff,
        title: l10n.dashboardTodayRefreshTitle,
        subtitle: error!,
        actionLabel: l10n.commonRetry,
        onAction: onRetry,
      );
    }

    final visibleCards = cards.take(4).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: _InlineSyncNotice(text: error!),
          ),
        ...visibleCards.map(
          (card) => Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: _TodayActionTile(card: card, onTap: () => onOpenCard(card)),
          ),
        ),
      ],
    );
  }
}

class _TodayActionTile extends StatelessWidget {
  final Map<String, dynamic> card;
  final VoidCallback onTap;

  const _TodayActionTile({required this.card, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final accent = _accentFor(card['type']);
    final title = _text(card['title']) ?? 'Next step';
    final subtitle = _text(card['subtitle']);
    final status = _text(card['status']);
    final cta = _text(card['cta_label']) ?? 'Open';

    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 82),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: cs.surface.withValues(alpha: 0.82),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: accent.withValues(alpha: 0.28)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: accent.withValues(alpha: 0.14),
                shape: BoxShape.circle,
              ),
              child: Icon(_iconFor(card['type']), color: accent, size: 23),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
                      if (status != null) ...[
                        const SizedBox(width: 8),
                        _StatusPill(label: status, color: accent),
                      ],
                    ],
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      subtitle,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 10),
            ConstrainedBox(
              constraints: const BoxConstraints(minWidth: 58, maxWidth: 104),
              child: FilledButton.tonal(
                onPressed: onTap,
                style: FilledButton.styleFrom(
                  minimumSize: const Size(58, 34),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                ),
                child: Text(
                  cta,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String label;
  final Color color;

  const _StatusPill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 112),
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(99),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.labelSmall
            ?.copyWith(color: color, fontWeight: FontWeight.w800),
      ),
    );
  }
}

class _InlineSyncNotice extends StatelessWidget {
  final String text;

  const _InlineSyncNotice({required this.text});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Row(
      children: [
        Icon(LucideIcons.refreshCwOff, color: cs.error, size: 16),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            text,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.bodySmall
                ?.copyWith(color: cs.error),
          ),
        ),
      ],
    );
  }
}

class _CommandCenterNotice extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final String actionLabel;
  final VoidCallback onAction;

  const _CommandCenterNotice({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.actionLabel,
    required this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Icon(icon, color: cs.error, size: 28),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  subtitle,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          TextButton(onPressed: onAction, child: Text(actionLabel)),
        ],
      ),
    );
  }
}

IconData _iconFor(dynamic type) {
  return switch (_text(type) ?? '') {
    'next_appointment' || 'book_appointment' => LucideIcons.calendarCheck,
    'unread_message' || 'contact_hospital' => LucideIcons.messagesSquare,
    'bill_due' => LucideIcons.indianRupee,
    'lab_result_ready' => LucideIcons.fileCheck2,
    'pending_lab_order' => LucideIcons.flaskConical,
    'prescription_ready' => LucideIcons.clipboardList,
    'pharmacy_order' => LucideIcons.packageCheck,
    'claim_update' => LucideIcons.shieldCheck,
    'upload_review' || 'upload_record' => LucideIcons.fileSearch,
    'health_points' => LucideIcons.badgeCheck,
    'departments' => LucideIcons.building2,
    _ => LucideIcons.sparkles,
  };
}

Color _accentFor(dynamic type) {
  return switch (_text(type) ?? '') {
    'next_appointment' || 'book_appointment' => const Color(0xFF3D8BFF),
    'unread_message' || 'contact_hospital' => const Color(0xFF8E5CF7),
    'bill_due' => const Color(0xFFE76F51),
    'lab_result_ready' || 'pending_lab_order' => const Color(0xFF00A7C8),
    'prescription_ready' || 'pharmacy_order' => const Color(0xFF61B15A),
    'claim_update' => const Color(0xFFB7791F),
    'upload_review' || 'upload_record' => const Color(0xFF15B8A6),
    'health_points' => const Color(0xFFE0A106),
    'departments' => const Color(0xFF2F9E44),
    _ => const Color(0xFF607D8B),
  };
}

String? _text(dynamic value, {String? fallback}) {
  final raw = value?.toString().trim();
  if (raw == null || raw.isEmpty || raw == 'null') return fallback;
  return raw;
}
