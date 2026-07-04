// lib/features/portal/screens/lab_results_screen.dart
//
// Patient-facing lab results. The backend only returns released, signed-off
// results on this portal surface; trend reads use the same release rules.

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/widgets/health_charts.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/features/portal/models/lab_result.dart';
import 'package:vhhealth/features/portal/services/lab_results_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class LabResultsScreen extends StatelessWidget {
  const LabResultsScreen({
    super.key,
    this.repository = const ApiLabResultsRepository(),
  });

  final LabResultsRepository repository;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: l10n.labResultsTitle,
      icon: Icons.biotech,
      color: colors.secondary,
      child: LabResultsList(repository: repository),
    );
  }
}

class LabResultsList extends StatefulWidget {
  const LabResultsList({
    super.key,
    this.repository = const ApiLabResultsRepository(),
  });

  final LabResultsRepository repository;

  @override
  State<LabResultsList> createState() => _LabResultsListState();
}

class _LabResultsListState extends State<LabResultsList> {
  bool _loading = true;
  String? _error;
  String? _staleLabel;
  List<LabResult> _results = const [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _fetch();
    });
  }

  Future<void> _fetch() async {
    if (!mounted) return;
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
          .catchError((Object e) {
            debugPrint('Lab results background refresh failed: $e');
          });
    } catch (e) {
      debugPrint('Lab results fetch failed: $e');
      if (!mounted) return;
      setState(() {
        _error = l10n.labResultsLoadFailed;
        _loading = false;
      });
    }
  }

  Future<void> _openResult(LabResult result) async {
    await context.push(
      '/portal/lab-results/${result.id}',
      extra: LabResultDetailRouteArgs(
        initialResult: result,
        repository: widget.repository,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Column(
      children: [
        OfflineBanner(staleLabel: _staleLabel),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _fetch,
            child: DataStateBuilder<LabResult>(
              isLoading: _loading,
              error: _error,
              data: _results,
              onRetry: _fetch,
              emptyIcon: Icons.science_outlined,
              emptyTitle: l10n.labResultsEmptyTitle,
              emptySubtitle: l10n.labResultsEmptySubtitle,
              builder: (context, results) => ListView.separated(
                padding: const EdgeInsets.all(16),
                physics: const AlwaysScrollableScrollPhysics(),
                itemCount: results.length,
                separatorBuilder: (_, _) => const SizedBox(height: 8),
                itemBuilder: (_, i) => _LabResultCard(
                  result: results[i],
                  onTap: () => _openResult(results[i]),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _LabResultCard extends StatelessWidget {
  const _LabResultCard({required this.result, required this.onTap});

  final LabResult result;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;
    final value = result.displayValue.isEmpty
        ? l10n.notAvailable
        : result.displayValue;

    return Card(
      child: ListTile(
        key: ValueKey('lab-result-${result.id}'),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        title: Row(
          children: [
            Expanded(
              child: Text(
                result.testName.isEmpty
                    ? l10n.labResultDetailsTitle
                    : result.testName,
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            if (result.isAbnormal && (result.abnormalFlag ?? '').isNotEmpty)
              _AbnormalFlag(flag: result.abnormalFlag!),
          ],
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _ValueLine(value: value, unit: result.unit, result: result),
              if ((result.referenceRange ?? '').isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(
                  '${l10n.labResultReference}: ${result.referenceRange}',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
              if (result.observationTime != null) ...[
                const SizedBox(height: 4),
                Text(
                  _formatDateTime(context, result.observationTime),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ],
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

class LabResultDetailRouteArgs {
  const LabResultDetailRouteArgs({this.initialResult, this.repository});

  final LabResult? initialResult;
  final LabResultsRepository? repository;
}

class LabResultDetailScreen extends StatefulWidget {
  const LabResultDetailScreen({
    super.key,
    required this.resultId,
    this.initialResult,
    this.repository = const ApiLabResultsRepository(),
  });

  final int resultId;
  final LabResult? initialResult;
  final LabResultsRepository repository;

  @override
  State<LabResultDetailScreen> createState() => _LabResultDetailScreenState();
}

class _LabResultDetailScreenState extends State<LabResultDetailScreen> {
  LabResult? _result;
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
    if (!mounted) return;
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
    } catch (e) {
      debugPrint('Lab result detail fetch failed: $e');
      if (!mounted) return;
      setState(() {
        _error = l10n.labResultDetailLoadFailed;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    final current = _result ?? widget.initialResult;
    final title = (current?.testName ?? '').isNotEmpty
        ? current!.testName
        : l10n.labResultDetailsTitle;

    return FeatureScreenScaffold(
      title: title,
      icon: Icons.biotech,
      color: colors.secondary,
      child: DataStateBuilder<LabResult>(
        isLoading: _loading,
        error: _error,
        data: _result == null ? const [] : [_result!],
        onRetry: _fetch,
        emptyIcon: Icons.science_outlined,
        emptyTitle: l10n.labResultDetailsTitle,
        emptySubtitle: l10n.labResultDetailLoadFailed,
        builder: (context, results) => _LabResultDetail(
          result: results.first,
          repository: widget.repository,
        ),
      ),
    );
  }
}

class _LabResultDetail extends StatelessWidget {
  const _LabResultDetail({required this.result, required this.repository});

  final LabResult result;
  final LabResultsRepository repository;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final value = result.displayValue.isEmpty
        ? l10n.notAvailable
        : result.displayValue;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        result.testName.isEmpty
                            ? l10n.labResultDetailsTitle
                            : result.testName,
                        style: theme.textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    if (result.isAbnormal &&
                        (result.abnormalFlag ?? '').isNotEmpty)
                      _AbnormalFlag(flag: result.abnormalFlag!),
                  ],
                ),
                const SizedBox(height: 12),
                _MetadataLine(
                  label: l10n.labResultValue,
                  value: result.unit == null ? value : '$value ${result.unit}',
                ),
                if ((result.referenceRange ?? '').isNotEmpty)
                  _MetadataLine(
                    label: l10n.labResultReference,
                    value: result.referenceRange!,
                  ),
                if (result.observationTime != null)
                  _MetadataLine(
                    label: l10n.labResultObserved,
                    value: _formatDateTime(context, result.observationTime),
                  ),
                if ((result.testCode ?? '').isNotEmpty)
                  _MetadataLine(
                    label: l10n.labResultCode,
                    value: result.testCode!,
                  ),
                if ((result.loincCode ?? '').isNotEmpty)
                  _MetadataLine(
                    label: l10n.labResultLoincCode,
                    value: result.loincCode!,
                  ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        _LabResultTrendSection(result: result, repository: repository),
      ],
    );
  }
}

class _LabResultTrendSection extends StatefulWidget {
  const _LabResultTrendSection({
    required this.result,
    required this.repository,
  });

  final LabResult result;
  final LabResultsRepository repository;

  @override
  State<_LabResultTrendSection> createState() => _LabResultTrendSectionState();
}

class _LabResultTrendSectionState extends State<_LabResultTrendSection> {
  static const _monthOptions = [6, 12, 24, 36];

  int _months = 24;
  bool _loading = true;
  String? _error;
  LabResultTrend? _trend;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _fetch();
    });
  }

  @override
  void didUpdateWidget(covariant _LabResultTrendSection oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.result.id != widget.result.id ||
        oldWidget.result.trendQueryValue != widget.result.trendQueryValue) {
      _fetch();
    }
  }

  Future<void> _fetch() async {
    if (!mounted || !widget.result.hasTrendCode) return;
    setState(() {
      _loading = true;
      _error = null;
    });

    final l10n = AppLocalizations.of(context)!;
    try {
      final trend = await widget.repository.getTrend(
        widget.result,
        months: _months,
      );
      if (!mounted) return;
      setState(() {
        _trend = trend;
        _loading = false;
      });
    } catch (e) {
      debugPrint('Lab result trend fetch failed: $e');
      if (!mounted) return;
      setState(() {
        _error = l10n.labResultTrendLoadFailed;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);

    if (!widget.result.hasTrendCode) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                l10n.labResultTrendTitle,
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                l10n.labResultTrendUnavailable,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      );
    }

    final displayTrend = _trend != null && _trend!.values.length >= 2
        ? _trend
        : null;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    l10n.labResultTrendTitle,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                DropdownButtonHideUnderline(
                  child: DropdownButton<int>(
                    value: _months,
                    isDense: true,
                    items: _monthOptions
                        .map(
                          (months) => DropdownMenuItem<int>(
                            value: months,
                            child: Text('$months ${l10n.labResultTrendMonths}'),
                          ),
                        )
                        .toList(),
                    onChanged: (value) {
                      if (value == null || value == _months) return;
                      setState(() {
                        _months = value;
                      });
                      _fetch();
                    },
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            DataStateBuilder<LabResultTrend>(
              isLoading: _loading,
              error: _error,
              data: displayTrend == null ? const [] : [displayTrend],
              onRetry: _fetch,
              emptyIcon: Icons.show_chart,
              emptyTitle: l10n.labResultTrendEmptyTitle,
              emptySubtitle: l10n.labResultTrendEmptySubtitle,
              builder: (context, trends) =>
                  _TrendChart(trend: trends.first, months: _months),
            ),
          ],
        ),
      ),
    );
  }
}

class _TrendChart extends StatelessWidget {
  const _TrendChart({required this.trend, required this.months});

  final LabResultTrend trend;
  final int months;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;
    final values = trend.values;
    final color = theme.colorScheme.primary;
    final firstDate = trend.points.first.at;
    final lastDate = trend.points.last.at;
    final latest = values.last;
    final unit = trend.unit;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '${l10n.labResultTrendLast} $months ${l10n.labResultTrendMonths}',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 10),
        SizedBox(
          height: 112,
          width: double.infinity,
          child: CustomPaint(
            painter: SparklinePainter(
              values: values,
              color: color,
              fillColor: color.withValues(alpha: 0.10),
              strokeWidth: 3,
            ),
          ),
        ),
        const SizedBox(height: 6),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              _formatShortDate(context, firstDate),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            Text(
              _formatShortDate(context, lastDate),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            _TrendMetric(
              label: l10n.labResultTrendLatest,
              value: _withUnit(formatLabNumber(latest), unit),
            ),
            _TrendMetric(
              label: l10n.labResultTrendRange,
              value: _rangeLabel(trend, unit, l10n),
            ),
            _TrendMetric(
              label: l10n.labResultTrendPoints,
              value: '${trend.count} ${l10n.labResultTrendResultsLabel}',
            ),
          ],
        ),
      ],
    );
  }
}

class _TrendMetric extends StatelessWidget {
  const _TrendMetric({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            value,
            style: theme.textTheme.bodyMedium?.copyWith(
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

class _ValueLine extends StatelessWidget {
  const _ValueLine({
    required this.value,
    required this.unit,
    required this.result,
  });

  final String value;
  final String? unit;
  final LabResult result;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: [
        Flexible(
          child: Text(
            value,
            style: theme.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.w600,
              color: result.isAbnormal
                  ? theme.colorScheme.error
                  : theme.colorScheme.onSurface,
            ),
          ),
        ),
        if ((unit ?? '').isNotEmpty) ...[
          const SizedBox(width: 4),
          Text(
            unit!,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ],
    );
  }
}

class _AbnormalFlag extends StatelessWidget {
  const _AbnormalFlag({required this.flag});

  final String flag;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        flag,
        style: theme.textTheme.bodySmall?.copyWith(
          color: theme.colorScheme.onErrorContainer,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _MetadataLine extends StatelessWidget {
  const _MetadataLine({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 118,
            child: Text(
              label,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Expanded(child: Text(value, style: theme.textTheme.bodyMedium)),
        ],
      ),
    );
  }
}

String _withUnit(String value, String? unit) {
  if ((unit ?? '').isEmpty) return value;
  return '$value $unit';
}

String _rangeLabel(LabResultTrend trend, String? unit, AppLocalizations l10n) {
  if (trend.min == null || trend.max == null) return l10n.notAvailable;
  return _withUnit(
    '${formatLabNumber(trend.min!)} - ${formatLabNumber(trend.max!)}',
    unit,
  );
}

String _formatDateTime(BuildContext context, DateTime? value) {
  if (value == null) return AppLocalizations.of(context)!.notAvailable;
  return DateFormat.yMMMd(
    Localizations.localeOf(context).toString(),
  ).add_jm().format(value);
}

String _formatShortDate(BuildContext context, DateTime? value) {
  if (value == null) return AppLocalizations.of(context)!.notAvailable;
  return DateFormat.MMMd(
    Localizations.localeOf(context).toString(),
  ).format(value);
}
