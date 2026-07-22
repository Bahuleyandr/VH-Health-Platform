import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/features/portal/models/structured_diagnostic_result.dart';
import 'package:vhhealth/features/portal/services/structured_diagnostic_results_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class StructuredDiagnosticResultsScreen extends StatefulWidget {
  const StructuredDiagnosticResultsScreen({
    super.key,
    this.repository = const ApiStructuredDiagnosticResultsRepository(),
  });

  final StructuredDiagnosticResultsRepository repository;

  @override
  State<StructuredDiagnosticResultsScreen> createState() =>
      _StructuredDiagnosticResultsScreenState();
}

class _StructuredDiagnosticResultsScreenState
    extends State<StructuredDiagnosticResultsScreen> {
  bool _loading = true;
  String? _error;
  String? _staleLabel;
  List<StructuredDiagnosticResult> _results = const [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _fetch();
    });
  }

  Future<void> _fetch() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final l10n = AppLocalizations.of(context)!;
    try {
      final page = await widget.repository.listResults();
      if (!mounted) return;
      setState(() {
        _results = page.results;
        _staleLabel = page.staleLabel;
        _loading = false;
      });
      page.onFresh
          ?.then((fresh) {
            if (!mounted) return;
            setState(() {
              _results = fresh;
              _staleLabel = null;
            });
          })
          .catchError((Object error) {
            debugPrint('Diagnostic results background refresh failed: $error');
          });
    } catch (error) {
      debugPrint('Diagnostic results fetch failed: $error');
      if (!mounted) return;
      setState(() {
        _error = l10n.diagnosticResultsLoadFailed;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: l10n.diagnosticResultsTitle,
      icon: Icons.description_outlined,
      color: colors.tertiary,
      child: Column(
        children: [
          OfflineBanner(staleLabel: _staleLabel),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _fetch,
              child: DataStateBuilder<StructuredDiagnosticResult>(
                isLoading: _loading,
                error: _error,
                data: _results,
                onRetry: _fetch,
                emptyIcon: Icons.description_outlined,
                emptyTitle: l10n.diagnosticResultsEmptyTitle,
                emptySubtitle: l10n.diagnosticResultsEmptySubtitle,
                builder: (context, results) => ListView.separated(
                  padding: const EdgeInsets.all(16),
                  physics: const AlwaysScrollableScrollPhysics(),
                  itemCount: results.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (_, index) => _ResultCard(
                    result: results[index],
                    onTap: () => context.push(
                      '/portal/diagnostic-results/${results[index].id}',
                      extra: StructuredDiagnosticResultDetailRouteArgs(
                        initialResult: results[index],
                        repository: widget.repository,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.result, required this.onTap});

  final StructuredDiagnosticResult result;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return Card(
      child: ListTile(
        key: ValueKey('diagnostic-result-${result.id}'),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        leading: Icon(
          result.isRadiology ? Icons.image_outlined : Icons.biotech,
          color: theme.colorScheme.tertiary,
        ),
        title: Text(
          result.title.isEmpty
              ? l10n.diagnosticResultDetailsTitle
              : result.title,
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(
            _resultSubtitle(context, result),
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
        trailing: Icon(
          Icons.chevron_right,
          color: theme.colorScheme.onSurfaceVariant,
        ),
        onTap: onTap,
      ),
    );
  }
}

class StructuredDiagnosticResultDetailRouteArgs {
  const StructuredDiagnosticResultDetailRouteArgs({
    this.initialResult,
    this.repository,
  });

  final StructuredDiagnosticResult? initialResult;
  final StructuredDiagnosticResultsRepository? repository;
}

class StructuredDiagnosticResultDetailScreen extends StatefulWidget {
  const StructuredDiagnosticResultDetailScreen({
    super.key,
    required this.resultId,
    this.initialResult,
    this.repository = const ApiStructuredDiagnosticResultsRepository(),
  });

  final String resultId;
  final StructuredDiagnosticResult? initialResult;
  final StructuredDiagnosticResultsRepository repository;

  @override
  State<StructuredDiagnosticResultDetailScreen> createState() =>
      _StructuredDiagnosticResultDetailScreenState();
}

class _StructuredDiagnosticResultDetailScreenState
    extends State<StructuredDiagnosticResultDetailScreen> {
  StructuredDiagnosticResult? _result;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _fetch();
    });
  }

  Future<void> _fetch() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final l10n = AppLocalizations.of(context)!;
    try {
      final result = await widget.repository.getResult(widget.resultId);
      if (!mounted) return;
      setState(() {
        _result = result;
        _loading = false;
      });
    } catch (error) {
      debugPrint('Diagnostic result detail fetch failed: $error');
      if (!mounted) return;
      setState(() {
        _error = l10n.diagnosticResultDetailLoadFailed;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final current = _result ?? widget.initialResult;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: (current?.title ?? '').isEmpty
          ? l10n.diagnosticResultDetailsTitle
          : current!.title,
      icon: current?.isRadiology == false
          ? Icons.biotech
          : Icons.image_outlined,
      color: colors.tertiary,
      child: DataStateBuilder<StructuredDiagnosticResult>(
        isLoading: _loading,
        error: _error,
        data: _result == null ? const [] : [_result!],
        onRetry: _fetch,
        emptyIcon: Icons.description_outlined,
        emptyTitle: l10n.diagnosticResultDetailsTitle,
        emptySubtitle: l10n.diagnosticResultDetailLoadFailed,
        builder: (context, results) => _ResultDetail(result: results.first),
      ),
    );
  }
}

class _ResultDetail extends StatelessWidget {
  const _ResultDetail({required this.result});

  final StructuredDiagnosticResult result;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  result.title,
                  style: theme.textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  _resultSubtitle(context, result),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                const Divider(height: 28),
                Text(
                  result.reportText ?? l10n.notAvailable,
                  style: theme.textTheme.bodyLarge,
                ),
              ],
            ),
          ),
        ),
        for (final addendum in result.addenda) ...[
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    l10n.diagnosticResultAddendum,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  if (addendum.signedAt != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      _formatDateTime(context, addendum.signedAt),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                  const SizedBox(height: 10),
                  Text(addendum.text, style: theme.textTheme.bodyLarge),
                ],
              ),
            ),
          ),
        ],
        const SizedBox(height: 12),
        Card(
          color: theme.colorScheme.surfaceContainerHighest,
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Text(
              l10n.diagnosticResultAdvice,
              style: theme.textTheme.bodyMedium,
            ),
          ),
        ),
      ],
    );
  }
}

String _resultSubtitle(
  BuildContext context,
  StructuredDiagnosticResult result,
) {
  final l10n = AppLocalizations.of(context)!;
  final type = result.isRadiology
      ? l10n.diagnosticResultRadiology
      : l10n.diagnosticResultPathology;
  final signed = result.signedAt == null
      ? l10n.notAvailable
      : _formatDateTime(context, result.signedAt);
  final amended = result.amended ? ' • ${l10n.diagnosticResultAmended}' : '';
  return '$type • $signed$amended';
}

String _formatDateTime(BuildContext context, DateTime? value) {
  if (value == null) return AppLocalizations.of(context)!.notAvailable;
  return DateFormat.yMMMd(
    Localizations.localeOf(context).toString(),
  ).add_jm().format(value);
}
