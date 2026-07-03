import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/features/your_health/models/whats_next_item.dart';
import 'package:vhhealth/features/your_health/services/whats_next_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class WhatsNextSection extends StatefulWidget {
  const WhatsNextSection({
    super.key,
    this.repository = const ApiWhatsNextRepository(),
  });

  final WhatsNextRepository repository;

  @override
  State<WhatsNextSection> createState() => _WhatsNextSectionState();
}

class _WhatsNextSectionState extends State<WhatsNextSection> {
  late Future<WhatsNextBundle> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.repository.getWhatsNext();
  }

  void _retry() {
    setState(() {
      _future = widget.repository.getWhatsNext();
    });
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<WhatsNextBundle>(
      future: _future,
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting &&
            !snapshot.hasData) {
          return const _WhatsNextShell(
            child: Padding(
              padding: EdgeInsets.symmetric(vertical: 18),
              child: Center(child: CircularProgressIndicator()),
            ),
          );
        }

        if (snapshot.hasError && !snapshot.hasData) {
          return _WhatsNextShell(child: _WhatsNextError(onRetry: _retry));
        }

        final bundle =
            snapshot.data ?? const WhatsNextBundle(goals: [], followUps: []);
        if (bundle.isEmpty) return const SizedBox.shrink();

        return _WhatsNextShell(child: _WhatsNextContent(bundle: bundle));
      },
    );
  }
}

class _WhatsNextShell extends StatelessWidget {
  const _WhatsNextShell({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest.withAlpha(128),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: theme.colorScheme.outlineVariant),
        ),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.route_outlined, color: theme.colorScheme.primary),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      l10n.yourHealthWhatsNextTitle,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                l10n.yourHealthWhatsNextSubtitle,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 12),
              child,
            ],
          ),
        ),
      ),
    );
  }
}

class _WhatsNextContent extends StatelessWidget {
  const _WhatsNextContent({required this.bundle});

  final WhatsNextBundle bundle;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (bundle.goals.isNotEmpty) ...[
          _SectionHeading(
            icon: Icons.flag_outlined,
            title: l10n.yourHealthWhatsNextGoals,
          ),
          const SizedBox(height: 6),
          ...bundle.goals.take(3).map((goal) => _GoalRow(goal: goal)),
        ],
        if (bundle.followUps.isNotEmpty) ...[
          if (bundle.goals.isNotEmpty) const SizedBox(height: 10),
          _SectionHeading(
            icon: Icons.event_available_outlined,
            title: l10n.yourHealthWhatsNextFollowUps,
          ),
          const SizedBox(height: 6),
          ...bundle.followUps
              .take(3)
              .map((followUp) => _FollowUpRow(followUp: followUp)),
        ],
      ],
    );
  }
}

class _SectionHeading extends StatelessWidget {
  const _SectionHeading({required this.icon, required this.title});

  final IconData icon;
  final String title;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Icon(icon, size: 18, color: theme.colorScheme.primary),
        const SizedBox(width: 6),
        Text(
          title,
          style: theme.textTheme.titleSmall?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
      ],
    );
  }
}

class _GoalRow extends StatelessWidget {
  const _GoalRow({required this.goal});

  final WhatsNextGoal goal;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final parts = <String>[
      if (goal.carePlanName.isNotEmpty)
        '${l10n.yourHealthWhatsNextPlan}: ${goal.carePlanName}',
      if (goal.targetValue != null)
        '${l10n.yourHealthWhatsNextTarget}: ${goal.targetValue}',
      if (goal.currentValue != null)
        '${l10n.yourHealthWhatsNextCurrent}: ${goal.currentValue}',
      if (goal.targetDueDate != null)
        '${l10n.yourHealthWhatsNextDue}: ${_formatDate(context, goal.targetDueDate!)}',
    ];
    return _ItemRow(
      icon: Icons.check_circle_outline,
      title: goal.description,
      meta: parts.join(' - '),
    );
  }
}

class _FollowUpRow extends StatelessWidget {
  const _FollowUpRow({required this.followUp});

  final WhatsNextFollowUp followUp;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final status = followUp.appointmentStatus ?? followUp.status;
    final parts = <String>[
      if (followUp.carePlanName.isNotEmpty)
        '${l10n.yourHealthWhatsNextPlan}: ${followUp.carePlanName}',
      if (followUp.dueAt != null)
        '${l10n.yourHealthWhatsNextDue}: ${_formatDate(context, followUp.dueAt!)}',
      if (status.isNotEmpty) status.replaceAll('_', ' '),
    ];
    return _ItemRow(
      icon: Icons.calendar_month_outlined,
      title: followUp.reason.isEmpty
          ? l10n.yourHealthWhatsNextFollowUps
          : followUp.reason,
      meta: parts.join(' - '),
    );
  }
}

class _ItemRow extends StatelessWidget {
  const _ItemRow({required this.icon, required this.title, required this.meta});

  final IconData icon;
  final String title;
  final String meta;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (meta.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    meta,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _WhatsNextError extends StatelessWidget {
  const _WhatsNextError({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return Row(
      children: [
        Icon(Icons.info_outline, color: theme.colorScheme.error),
        const SizedBox(width: 8),
        Expanded(child: Text(l10n.yourHealthWhatsNextLoadFailed)),
        TextButton(
          onPressed: onRetry,
          child: Text(l10n.yourHealthWhatsNextRetry),
        ),
      ],
    );
  }
}

String _formatDate(BuildContext context, DateTime date) {
  return DateFormat.yMMMd(
    Localizations.localeOf(context).toString(),
  ).format(date);
}
