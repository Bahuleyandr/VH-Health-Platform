import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/features/your_health/models/patient_explainer.dart';
import 'package:vhhealth/features/your_health/services/patient_explainers_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class ExplanationsTab extends StatelessWidget {
  const ExplanationsTab({
    super.key,
    required this.explainers,
    required this.repository,
    required this.onRefresh,
  });

  final List<PatientExplainer> explainers;
  final PatientExplainersRepository repository;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    if (explainers.isEmpty) {
      return ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const SizedBox(height: 96),
          Icon(
            Icons.psychology_alt_outlined,
            size: 48,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
          const SizedBox(height: 12),
          Center(child: Text(l10n.yourHealthExplanationsEmpty)),
        ],
      );
    }

    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView.separated(
        padding: const EdgeInsets.all(12),
        itemCount: explainers.length,
        separatorBuilder: (_, _) => const SizedBox(height: 8),
        itemBuilder: (context, index) {
          return _ExplainerCard(
            explainer: explainers[index],
            repository: repository,
          );
        },
      ),
    );
  }
}

class _ExplainerCard extends StatelessWidget {
  const _ExplainerCard({required this.explainer, required this.repository});

  final PatientExplainer explainer;
  final PatientExplainersRepository repository;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final date = explainer.publishedAt == null
        ? l10n.notAvailable
        : DateFormat.yMMMd(locale).format(explainer.publishedAt!);
    final hasSafetyFlags = explainer.draft.safetyFlags.isNotEmpty;
    final summary = explainer.draft.explanationSummary.isEmpty
        ? l10n.yourHealthExplanationsNoSummary
        : explainer.draft.explanationSummary;

    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () {
          Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => PatientExplainerDetailScreen(
                reviewId: explainer.reviewId,
                initialExplainer: explainer,
                repository: repository,
              ),
            ),
          );
        },
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.psychology_alt_outlined, color: cs.primary),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      explainer.moduleName,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  if (hasSafetyFlags)
                    Icon(
                      Icons.warning_amber_outlined,
                      color: cs.error,
                      size: 20,
                    ),
                  const Icon(Icons.chevron_right),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                '${l10n.yourHealthExplanationsReviewedLabel} $date',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: cs.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                summary,
                style: theme.textTheme.bodyMedium,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class PatientExplainerDetailScreen extends StatefulWidget {
  const PatientExplainerDetailScreen({
    super.key,
    required this.reviewId,
    required this.initialExplainer,
    required this.repository,
  });

  final int reviewId;
  final PatientExplainer initialExplainer;
  final PatientExplainersRepository repository;

  @override
  State<PatientExplainerDetailScreen> createState() =>
      _PatientExplainerDetailScreenState();
}

class _PatientExplainerDetailScreenState
    extends State<PatientExplainerDetailScreen> {
  late Future<PatientExplainer> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.repository.getExplainer(widget.reviewId);
  }

  void _retry() {
    setState(() {
      _future = widget.repository.getExplainer(widget.reviewId);
    });
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.yourHealthExplanationsDetailTitle)),
      body: FutureBuilder<PatientExplainer>(
        future: _future,
        initialData: widget.initialExplainer,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting &&
              !snapshot.hasData) {
            return const Center(child: CircularProgressIndicator());
          }

          if (snapshot.hasError && !snapshot.hasData) {
            return _ErrorState(onRetry: _retry);
          }

          return _ExplainerDetailContent(
            explainer: snapshot.data ?? widget.initialExplainer,
          );
        },
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.info_outline,
              size: 48,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: 12),
            Text(
              l10n.yourHealthExplanationsLoadFailed,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 16),
            FilledButton.tonal(
              onPressed: onRetry,
              child: Text(l10n.yourHealthExplanationsRetry),
            ),
          ],
        ),
      ),
    );
  }
}

class _ExplainerDetailContent extends StatelessWidget {
  const _ExplainerDetailContent({required this.explainer});

  final PatientExplainer explainer;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final date = explainer.publishedAt == null
        ? l10n.notAvailable
        : DateFormat.yMMMMd(locale).format(explainer.publishedAt!);

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          explainer.moduleName,
          style: theme.textTheme.headlineSmall?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          '${l10n.yourHealthExplanationsReviewedLabel} $date',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 16),
        if (explainer.draft.safetyFlags.isNotEmpty) ...[
          _SafetyBanner(flags: explainer.draft.safetyFlags),
          const SizedBox(height: 12),
        ],
        _SectionCard(
          title: l10n.yourHealthExplanationsSummary,
          icon: Icons.summarize_outlined,
          child: Text(
            explainer.draft.explanationSummary.isEmpty
                ? l10n.yourHealthExplanationsNoSummary
                : explainer.draft.explanationSummary,
          ),
        ),
        _SectionCard(
          title: l10n.yourHealthExplanationsKeyPoints,
          icon: Icons.checklist_outlined,
          child: _BulletList(items: explainer.draft.keyPoints),
        ),
        _SectionCard(
          title: l10n.yourHealthExplanationsNextSteps,
          icon: Icons.route_outlined,
          child: _BulletList(items: explainer.draft.nextSteps),
        ),
        _SectionCard(
          title: l10n.yourHealthExplanationsWhenToSeekHelp,
          icon: Icons.health_and_safety_outlined,
          child: _BulletList(items: explainer.draft.whenToSeekHelp),
        ),
      ],
    );
  }
}

class _SafetyBanner extends StatelessWidget {
  const _SafetyBanner({required this.flags});

  final List<PatientExplainerSafetyFlag> flags;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l10n = AppLocalizations.of(context)!;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.errorContainer,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: cs.error.withValues(alpha: 0.35)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.warning_amber_outlined, color: cs.error),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l10n.yourHealthExplanationsSafetyTitle,
                  style: theme.textTheme.titleSmall?.copyWith(
                    color: cs.onErrorContainer,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  l10n.yourHealthExplanationsSafetyBody,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: cs.onErrorContainer,
                  ),
                ),
                const SizedBox(height: 8),
                ...flags.map((flag) {
                  final prefix = flag.code.isEmpty ? '' : '${flag.code}: ';
                  final message = flag.message.isEmpty
                      ? flag.severity
                      : flag.message;
                  return Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      '$prefix$message',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.onErrorContainer,
                      ),
                    ),
                  );
                }),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({
    required this.title,
    required this.icon,
    required this.child,
  });

  final String title;
  final IconData icon;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 20, color: theme.colorScheme.primary),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    title,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            child,
          ],
        ),
      ),
    );
  }
}

class _BulletList extends StatelessWidget {
  const _BulletList({required this.items});

  final List<String> items;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    if (items.isEmpty) {
      return Text(l10n.yourHealthExplanationsNoSummary);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: items.map((item) {
        return Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('- '),
              Expanded(child: Text(item)),
            ],
          ),
        );
      }).toList(),
    );
  }
}
