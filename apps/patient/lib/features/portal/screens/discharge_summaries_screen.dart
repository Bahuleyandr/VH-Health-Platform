import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/features/portal/models/discharge_summary.dart';
import 'package:vhhealth/features/portal/services/discharge_summaries_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class DischargeSummariesScreen extends StatelessWidget {
  const DischargeSummariesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: l10n.dischargeSummariesTitle,
      icon: Icons.assignment_returned_outlined,
      color: colors.tertiary,
      child: const DischargeSummariesList(),
    );
  }
}

class DischargeSummaryDetailRouteScreen extends StatelessWidget {
  const DischargeSummaryDetailRouteScreen({super.key, required this.summaryId});

  final int summaryId;

  @override
  Widget build(BuildContext context) {
    return DischargeSummaryDetailScreen(
      summaryId: summaryId,
      initialSummary: null,
    );
  }
}

class DischargeSummariesList extends StatefulWidget {
  const DischargeSummariesList({
    super.key,
    this.repository = const ApiDischargeSummariesRepository(),
    this.pdfOpener = openDischargeSummaryPdf,
  });

  final DischargeSummariesRepository repository;
  final DischargeSummaryPdfOpener pdfOpener;

  @override
  State<DischargeSummariesList> createState() => _DischargeSummariesListState();
}

class _DischargeSummariesListState extends State<DischargeSummariesList> {
  List<DischargeSummary> _summaries = const [];
  bool _isLoading = true;
  String? _error;
  String? _staleLabel;

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
      _isLoading = true;
      _error = null;
    });

    final l10n = AppLocalizations.of(context)!;
    try {
      final page = await widget.repository.listSummaries();
      if (!mounted) return;
      setState(() {
        _summaries = page.summaries;
        _staleLabel = page.staleLabel;
        _isLoading = false;
      });

      page.onFresh
          ?.then((fresh) {
            if (!mounted) return;
            setState(() {
              _summaries = fresh;
              _staleLabel = null;
            });
          })
          .catchError((Object e) {
            debugPrint('Discharge summaries background refresh failed: $e');
          });
    } catch (e) {
      debugPrint('Discharge summaries fetch failed: $e');
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _error = l10n.dischargeSummariesLoadFailed;
      });
    }
  }

  Future<void> _openSummary(DischargeSummary summary) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DischargeSummaryDetailScreen(
          summaryId: summary.id,
          initialSummary: summary,
          repository: widget.repository,
          pdfOpener: widget.pdfOpener,
        ),
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
            child: DataStateBuilder<DischargeSummary>(
              isLoading: _isLoading,
              error: _error,
              data: _summaries,
              onRetry: _fetch,
              emptyIcon: Icons.assignment_returned_outlined,
              emptyTitle: l10n.dischargeSummariesEmptyTitle,
              emptySubtitle: l10n.dischargeSummariesEmptySubtitle,
              builder: (context, summaries) => ListView.separated(
                padding: const EdgeInsets.all(12),
                physics: const AlwaysScrollableScrollPhysics(),
                itemCount: summaries.length,
                separatorBuilder: (_, _) => const SizedBox(height: 8),
                itemBuilder: (_, index) => _DischargeSummaryCard(
                  summary: summaries[index],
                  onTap: () => _openSummary(summaries[index]),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _DischargeSummaryCard extends StatelessWidget {
  const _DischargeSummaryCard({required this.summary, required this.onTap});

  final DischargeSummary summary;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l10n = AppLocalizations.of(context)!;
    final date = _formatDate(context, summary.displayDate);
    final diagnosis = summary.primaryDiagnosis.isEmpty
        ? l10n.dischargeSummaryUntitled
        : summary.primaryDiagnosis;

    return Card(
      child: ListTile(
        key: ValueKey('discharge-summary-${summary.id}'),
        leading: CircleAvatar(
          backgroundColor: Colors.orange.withValues(alpha: 0.16),
          foregroundColor: Colors.orange.shade800,
          child: const Icon(Icons.assignment_returned_outlined),
        ),
        title: Text(
          diagnosis,
          style: theme.textTheme.titleSmall?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('${l10n.dischargeSummaryDischarged}: $date'),
              if ((summary.wardAtDischarge ?? '').isNotEmpty)
                Text(
                  '${l10n.dischargeSummaryWard}: '
                  '${summary.wardAtDischarge}',
                ),
              if ((summary.signedByName ?? '').isNotEmpty)
                Text(
                  '${l10n.dischargeSummarySignedBy}: '
                  '${summary.signedByName}',
                ),
            ],
          ),
        ),
        trailing: Icon(Icons.chevron_right, color: cs.onSurfaceVariant),
        onTap: onTap,
      ),
    );
  }
}

class DischargeSummaryDetailScreen extends StatefulWidget {
  const DischargeSummaryDetailScreen({
    super.key,
    required this.summaryId,
    required this.initialSummary,
    this.repository = const ApiDischargeSummariesRepository(),
    this.pdfOpener = openDischargeSummaryPdf,
  });

  final int summaryId;
  final DischargeSummary? initialSummary;
  final DischargeSummariesRepository repository;
  final DischargeSummaryPdfOpener pdfOpener;

  @override
  State<DischargeSummaryDetailScreen> createState() =>
      _DischargeSummaryDetailScreenState();
}

class _DischargeSummaryDetailScreenState
    extends State<DischargeSummaryDetailScreen> {
  DischargeSummary? _summary;
  bool _isLoading = true;
  bool _isOpeningPdf = false;
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
      _isLoading = true;
      _error = null;
    });

    final l10n = AppLocalizations.of(context)!;
    try {
      final summary = await widget.repository.getSummary(widget.summaryId);
      if (!mounted) return;
      setState(() {
        _summary = summary;
        _isLoading = false;
      });
    } catch (e) {
      debugPrint('Discharge summary detail fetch failed: $e');
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _error = l10n.dischargeSummaryDetailLoadFailed;
      });
    }
  }

  Future<void> _openPdf(DischargeSummary summary) async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _isOpeningPdf = true;
    });
    try {
      await widget.pdfOpener(summary);
    } catch (e) {
      debugPrint('Discharge summary PDF open failed: $e');
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.dischargeSummaryPdfOpenFailed)),
      );
    } finally {
      if (mounted) {
        setState(() {
          _isOpeningPdf = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    final current = _summary ?? widget.initialSummary;
    final title = current?.primaryDiagnosis.isNotEmpty == true
        ? current!.primaryDiagnosis
        : l10n.dischargeSummaryUntitled;

    return FeatureScreenScaffold(
      title: title,
      icon: Icons.assignment_returned_outlined,
      color: colors.tertiary,
      child: DataStateBuilder<DischargeSummary>(
        isLoading: _isLoading,
        error: _error,
        data: _summary == null ? const [] : [_summary!],
        onRetry: _fetch,
        emptyIcon: Icons.assignment_returned_outlined,
        emptyTitle: l10n.dischargeSummaryUntitled,
        emptySubtitle: l10n.dischargeSummaryNoSections,
        builder: (context, summaries) => _DischargeSummaryDetail(
          summary: summaries.first,
          openingPdf: _isOpeningPdf,
          onOpenPdf: () => _openPdf(summaries.first),
        ),
      ),
    );
  }
}

class _DischargeSummaryDetail extends StatelessWidget {
  const _DischargeSummaryDetail({
    required this.summary,
    required this.openingPdf,
    required this.onOpenPdf,
  });

  final DischargeSummary summary;
  final bool openingPdf;
  final VoidCallback onOpenPdf;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;
    final languageCode = Localizations.localeOf(context).languageCode;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _MetadataCard(summary: summary),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: openingPdf ? null : onOpenPdf,
          icon: openingPdf
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.picture_as_pdf_outlined),
          label: Text(
            openingPdf
                ? l10n.dischargeSummaryOpeningPdf
                : l10n.dischargeSummaryOpenPdf,
          ),
        ),
        const SizedBox(height: 18),
        Text(
          l10n.dischargeSummarySectionsTitle,
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 8),
        if (summary.sections.isEmpty)
          Text(
            l10n.dischargeSummaryNoSections,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          )
        else
          ...summary.sections.map(
            (section) => _SectionCard(
              section: section,
              body: section.bodyForLanguage(languageCode),
            ),
          ),
      ],
    );
  }
}

class _MetadataCard extends StatelessWidget {
  const _MetadataCard({required this.summary});

  final DischargeSummary summary;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _MetadataLine(
              label: l10n.dischargeSummaryPrimaryDiagnosis,
              value: summary.primaryDiagnosis.isEmpty
                  ? l10n.dischargeSummaryUntitled
                  : summary.primaryDiagnosis,
            ),
            if ((summary.hospitalNumber ?? '').isNotEmpty)
              _MetadataLine(
                label: l10n.dischargeSummaryHospitalNumber,
                value: summary.hospitalNumber!,
              ),
            _MetadataLine(
              label: l10n.dischargeSummaryAdmitted,
              value: _formatDateTime(context, summary.admittedAt),
            ),
            _MetadataLine(
              label: l10n.dischargeSummaryDischarged,
              value: _formatDateTime(context, summary.dischargedAt),
            ),
            if ((summary.wardAtDischarge ?? '').isNotEmpty)
              _MetadataLine(
                label: l10n.dischargeSummaryWard,
                value: summary.wardAtDischarge!,
              ),
            if ((summary.signedByName ?? '').isNotEmpty)
              _MetadataLine(
                label: l10n.dischargeSummarySignedBy,
                value: summary.signedByName!,
              ),
            _MetadataLine(
              label: l10n.dischargeSummarySignedAt,
              value: _formatDateTime(context, summary.signedAt),
            ),
          ],
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
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 124,
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

class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.section, required this.body});

  final DischargeSummarySection section;
  final String body;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              section.title.isEmpty ? _titleize(section.key) : section.title,
              style: theme.textTheme.titleSmall?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 8),
            Text(body, style: theme.textTheme.bodyMedium),
          ],
        ),
      ),
    );
  }
}

String _formatDate(BuildContext context, DateTime? value) {
  if (value == null) return AppLocalizations.of(context)!.notAvailable;
  return DateFormat.yMMMd(
    Localizations.localeOf(context).toString(),
  ).format(value);
}

String _formatDateTime(BuildContext context, DateTime? value) {
  if (value == null) return AppLocalizations.of(context)!.notAvailable;
  return DateFormat.yMMMd(
    Localizations.localeOf(context).toString(),
  ).add_jm().format(value);
}

String _titleize(String raw) {
  return raw
      .replaceAll('_', ' ')
      .replaceAll('-', ' ')
      .trim()
      .split(RegExp(r'\s+'))
      .where((part) => part.isNotEmpty)
      .map((part) => part[0].toUpperCase() + part.substring(1).toLowerCase())
      .join(' ');
}
