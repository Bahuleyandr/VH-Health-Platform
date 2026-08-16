import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:printing/printing.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/config/role_config.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/clinical_print_pdf_action.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../l10n/app_strings.dart';
import '../models/cath_report_models.dart';
import '../services/cath_lab_api_service.dart';
import 'cath_report_editor.dart';

typedef CathReportsLoader = Future<List<CathProcedureReport>> Function(
  int caseId,
);
typedef CathReportTemplatesLoader = Future<List<CathReportTemplate>> Function();
typedef CathReportCreator = Future<CathProcedureReport> Function(
  int caseId,
  CathReportDraft draft,
);
typedef CathReportUpdater = Future<CathProcedureReport> Function(
  int reportId,
  CathReportDraft draft,
);
typedef CathReportTransition = Future<CathProcedureReport> Function(
  int reportId,
);
typedef CathReportAddendumCreator = Future<CathReportAddendum> Function(
  int reportId,
  CathReportAddendumDraft draft,
);
typedef CathViewerLinkLoader = Future<CathViewerLink> Function(int caseId);
typedef CathViewerLauncher = Future<void> Function(Uri uri);
typedef CathReportPdfPrinter = Future<void> Function(
  CathProcedureReport report,
);

class CathReportDependencies {
  const CathReportDependencies({
    this.loadReports,
    this.loadTemplates,
    this.createReport,
    this.updateReport,
    this.markPreliminary,
    this.signReport,
    this.addAddendum,
    this.loadViewerLink,
    this.launchViewer,
    this.printPdf,
  });

  final CathReportsLoader? loadReports;
  final CathReportTemplatesLoader? loadTemplates;
  final CathReportCreator? createReport;
  final CathReportUpdater? updateReport;
  final CathReportTransition? markPreliminary;
  final CathReportTransition? signReport;
  final CathReportAddendumCreator? addAddendum;
  final CathViewerLinkLoader? loadViewerLink;
  final CathViewerLauncher? launchViewer;
  final CathReportPdfPrinter? printPdf;
}

const _doctorRoles = {
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'SENIOR_DOCTOR',
  'RESIDENT',
};

String _normalizedCathRole(String role) {
  final raw = role.trim().toUpperCase();
  if (raw == 'TECHNICIAN') return raw;
  return StaffRole.fromString(raw).value;
}

@visibleForTesting
bool cathReportCanEditForRole(String role) {
  final normalized = _normalizedCathRole(role);
  return _doctorRoles.contains(normalized) ||
      normalized == 'RECEPTIONIST' ||
      normalized == 'CATH_LAB_INCHARGE';
}

@visibleForTesting
bool cathReportCanSignForRole(String role) {
  return _doctorRoles.contains(_normalizedCathRole(role));
}

@visibleForTesting
bool cathImagesCanOpenForRole(String role) {
  final normalized = _normalizedCathRole(role);
  return _doctorRoles.contains(normalized) ||
      const {
        'CATH_LAB_INCHARGE',
        'CATH_LAB_STAFF',
        'CATH_LAB_TECHNICIAN',
        'NURSING_STAFF',
        'TECHNICIAN',
        'ADMIN',
        'SUPER_ADMIN',
      }.contains(normalized);
}

class CathCaseReportsPanel extends StatefulWidget {
  const CathCaseReportsPanel({
    super.key,
    required this.cathCase,
    required this.role,
    this.dependencies = const CathReportDependencies(),
    this.initiallyExpanded = false,
  });

  final CathLabCaseSummary cathCase;
  final String role;
  final CathReportDependencies dependencies;
  final bool initiallyExpanded;

  @override
  State<CathCaseReportsPanel> createState() => _CathCaseReportsPanelState();
}

class _CathCaseReportsPanelState extends State<CathCaseReportsPanel> {
  bool _loaded = false;
  bool _loading = false;
  String? _error;
  String? _busyKey;
  List<CathProcedureReport> _reports = const [];
  List<CathReportTemplate>? _templates;
  CathViewerLink? _viewerLink;

  CathReportsLoader get _loadReports =>
      widget.dependencies.loadReports ?? CathLabApiService.fetchReportsForCase;
  CathReportTemplatesLoader get _loadTemplates =>
      widget.dependencies.loadTemplates ??
      () => CathLabApiService.fetchReportTemplates();
  CathReportCreator get _createReport =>
      widget.dependencies.createReport ?? CathLabApiService.createReport;
  CathReportUpdater get _updateReport =>
      widget.dependencies.updateReport ?? CathLabApiService.updateReport;
  CathReportTransition get _markPreliminary =>
      widget.dependencies.markPreliminary ??
      CathLabApiService.markReportPreliminary;
  CathReportTransition get _signReport =>
      widget.dependencies.signReport ?? CathLabApiService.signReport;
  CathReportAddendumCreator get _addAddendum =>
      widget.dependencies.addAddendum ?? CathLabApiService.addReportAddendum;
  CathViewerLinkLoader get _loadViewerLink =>
      widget.dependencies.loadViewerLink ?? CathLabApiService.fetchViewerLink;
  CathViewerLauncher get _launchViewer =>
      widget.dependencies.launchViewer ?? _launchViewerExternally;
  CathReportPdfPrinter get _printPdf =>
      widget.dependencies.printPdf ?? _printReportPdf;

  @override
  void initState() {
    super.initState();
    if (widget.initiallyExpanded) _load();
  }

  @override
  void didUpdateWidget(CathCaseReportsPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.role != widget.role && _loaded) {
      if (cathImagesCanOpenForRole(widget.role)) {
        _resolveViewerLink();
      } else {
        setState(() => _viewerLink = null);
      }
    }
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final reports = await _loadReports(widget.cathCase.id);
      if (!mounted) return;
      setState(() {
        _reports = reports;
        _loaded = true;
      });
      await _resolveViewerLink();
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = _cleanError(error));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _resolveViewerLink() async {
    if (!cathImagesCanOpenForRole(widget.role)) {
      if (mounted) setState(() => _viewerLink = null);
      return;
    }
    try {
      final link = await _loadViewerLink(widget.cathCase.id);
      if (mounted) setState(() => _viewerLink = link);
    } catch (_) {
      if (mounted) setState(() => _viewerLink = null);
    }
  }

  Future<List<CathReportTemplate>> _ensureTemplates() async {
    if (_templates != null) return _templates!;
    final templates = await _loadTemplates();
    if (mounted) setState(() => _templates = templates);
    return templates;
  }

  Future<void> _openEditor({CathProcedureReport? report}) async {
    final s = AppStrings.of(context);
    setState(() => _busyKey = 'editor');
    try {
      final templates = await _ensureTemplates();
      if (!mounted) return;
      if (templates.isEmpty && report == null) {
        _showError(s.lookup('s4.lib.cath_lab.report.template_unavailable'));
        return;
      }
      final saved = await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        showDragHandle: true,
        builder: (sheetContext) => FractionallySizedBox(
          heightFactor: 0.92,
          child: CathReportEditor(
            templates: templates,
            report: report,
            onSave: (draft) async {
              if (report == null) {
                await _createReport(widget.cathCase.id, draft);
              } else {
                await _updateReport(report.id, draft);
              }
              if (sheetContext.mounted) Navigator.pop(sheetContext, true);
            },
          ),
        ),
      );
      if (saved == true && mounted) {
        _showSuccess(s.lookup('s4.lib.cath_lab.report.draft_saved'));
        await _load();
      }
    } catch (error) {
      if (mounted) {
        _showActionError(s.lookup('s4.lib.cath_lab.report.template'), error);
      }
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  Future<void> _makePreliminary(CathProcedureReport report) async {
    await _runReportAction(
      busyKey: 'preliminary-${report.id}',
      actionLabelKey: 's4.lib.cath_lab.report.mark_preliminary',
      successKey: 's4.lib.cath_lab.report.preliminary_saved',
      action: () => _markPreliminary(report.id),
    );
  }

  Future<void> _confirmAndSign(CathProcedureReport report) async {
    final s = AppStrings.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(s.lookup('s4.lib.cath_lab.report.sign_confirm_title')),
        content: Text(s.lookup('s4.lib.cath_lab.report.sign_confirm_body')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            key: const ValueKey('cath-report-sign-confirm'),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(s.lookup('s4.lib.cath_lab.report.sign')),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await _runReportAction(
      busyKey: 'sign-${report.id}',
      actionLabelKey: 's4.lib.cath_lab.report.sign',
      successKey: 's4.lib.cath_lab.report.signed_success',
      action: () => _signReport(report.id),
    );
  }

  Future<void> _showAddendumDialog(CathProcedureReport report) async {
    final draft = await showDialog<CathReportAddendumDraft>(
      context: context,
      builder: (_) => const _CathReportAddendumDialog(),
    );
    if (draft == null || !mounted) return;
    await _runReportAction(
      busyKey: 'addendum-${report.id}',
      actionLabelKey: 's4.lib.cath_lab.report.add_addendum',
      successKey: 's4.lib.cath_lab.report.addendum_saved',
      action: () => _addAddendum(report.id, draft),
    );
  }

  Future<void> _runReportAction({
    required String busyKey,
    required String actionLabelKey,
    required String successKey,
    required Future<Object?> Function() action,
  }) async {
    if (_busyKey != null) return;
    setState(() => _busyKey = busyKey);
    try {
      await action();
      if (!mounted) return;
      _showSuccess(AppStrings.of(context).lookup(successKey));
      await _load();
    } catch (error) {
      if (mounted) {
        _showActionError(AppStrings.of(context).lookup(actionLabelKey), error);
      }
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  Future<void> _openImages() async {
    final uri = _viewerLink?.url;
    if (uri == null || _busyKey != null) return;
    setState(() => _busyKey = 'viewer');
    try {
      await _launchViewer(uri);
    } catch (error) {
      if (mounted) {
        _showActionError(
          AppStrings.of(context).lookup('s4.lib.cath_lab.report.open_images'),
          error,
        );
      }
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  Future<void> _print(CathProcedureReport report) async {
    if (_busyKey != null) return;
    setState(() => _busyKey = 'pdf-${report.id}');
    try {
      await _printPdf(report);
    } catch (error) {
      if (mounted) {
        _showActionError(
          AppStrings.of(context)
              .lookup('s4.lib.clinical_print_pdf_action.print_share_pdf'),
          error,
        );
      }
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  void _showSuccess(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: AppTheme.successGreen),
    );
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: AppTheme.errorRed),
    );
  }

  void _showActionError(String action, Object error) {
    final s = AppStrings.of(context);
    _showError(
      s.format('s4.dynamic.cath_lab.report.action_failed', {
        'action': action,
        'error': _cleanError(error),
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final canEdit = cathReportCanEditForRole(widget.role);
    final viewerVisible = _viewerLink?.canOpen == true;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      clipBehavior: Clip.antiAlias,
      child: ExpansionTile(
        key: ValueKey('cath-report-expand-${widget.cathCase.id}'),
        initiallyExpanded: widget.initiallyExpanded,
        onExpansionChanged: (expanded) {
          if (expanded && !_loaded) _load();
        },
        leading: const Icon(Icons.description_outlined),
        title: Text(
          widget.cathCase.requestedProcedure.isEmpty
              ? s.lookup('s4.lib.cath_lab.procedure_not_set')
              : widget.cathCase.requestedProcedure,
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
        subtitle: Text(_patientLabel(s, widget.cathCase)),
        trailing: _loaded
            ? _ReportCountBadge(count: _reports.length)
            : const Icon(Icons.expand_more),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  alignment: WrapAlignment.end,
                  children: [
                    if (viewerVisible)
                      OutlinedButton.icon(
                        key: ValueKey(
                          'cath-report-images-${widget.cathCase.id}',
                        ),
                        onPressed: _busyKey == null ? _openImages : null,
                        icon: const Icon(Icons.open_in_new_outlined),
                        label: Text(
                          s.lookup('s4.lib.cath_lab.report.open_images'),
                        ),
                      ),
                    if (canEdit)
                      FilledButton.icon(
                        key: ValueKey(
                          'cath-report-create-${widget.cathCase.id}',
                        ),
                        onPressed: _busyKey == null
                            ? () => _openEditor()
                            : null,
                        icon: const Icon(Icons.add),
                        label: Text(s.lookup('s4.lib.cath_lab.report.create')),
                      ),
                  ],
                ),
                if (_loading) ...[
                  const SizedBox(height: 18),
                  const LinearProgressIndicator(),
                  const SizedBox(height: 10),
                  Text(
                    s.lookup('s4.lib.cath_lab.report.loading'),
                    textAlign: TextAlign.center,
                  ),
                ] else if (_error != null) ...[
                  SizedBox(
                    height: 230,
                    child: ErrorState(message: _error!, onRetry: _load),
                  ),
                ] else if (_loaded && _reports.isEmpty) ...[
                  SizedBox(
                    height: 230,
                    child: EmptyState(
                      icon: Icons.description_outlined,
                      title: s.lookup('s4.lib.cath_lab.report.no_reports'),
                    ),
                  ),
                ] else ...[
                  const SizedBox(height: 12),
                  for (final report in _reports)
                    _buildReportCard(report, canEdit: canEdit),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildReportCard(CathProcedureReport report, {required bool canEdit}) {
    final s = AppStrings.of(context);
    final statusColor = switch (report.status) {
      'signed' => AppTheme.successGreen,
      'preliminary' => AppTheme.primaryBlue,
      _ => AppTheme.warningAmber,
    };
    final summary = _reportSummary(report);
    return Card(
      color: statusColor.withValues(alpha: 0.04),
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    report.templateName.isEmpty
                        ? _humanize(report.reportType)
                        : report.templateName,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
                _StatusChip(
                  label: s.lookup(
                    's4.lib.cath_lab.report.status.${report.status}',
                  ),
                  color: statusColor,
                ),
              ],
            ),
            if ((summary ?? '').isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(summary!, maxLines: 3, overflow: TextOverflow.ellipsis),
            ],
            if (report.isSigned) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 12,
                runSpacing: 6,
                children: [
                  if (report.signedByName.isNotEmpty)
                    _MetaLine(
                      icon: Icons.draw_outlined,
                      text: report.signedByName,
                    ),
                  if (report.signedAt != null)
                    _MetaLine(
                      icon: Icons.schedule_outlined,
                      text: DateFormat('dd MMM yyyy, hh:mm a')
                          .format(report.signedAt!),
                    ),
                  if (report.reportTatMinutes != null)
                    _MetaLine(
                      icon: Icons.timer_outlined,
                      text: s.format('s4.dynamic.cath_lab.report.tat', {
                        'minutes': report.reportTatMinutes,
                      }),
                    ),
                ],
              ),
            ],
            if (report.addenda.isNotEmpty) ...[
              const Divider(height: 24),
              Text(
                s.lookup('s4.lib.cath_lab.report.addenda'),
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: 6),
              for (final addendum in report.addenda)
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.post_add_outlined, size: 20),
                  title: Text(addendum.reason),
                  subtitle: Text(addendum.narrative),
                ),
            ],
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (!report.isSigned && canEdit)
                  OutlinedButton.icon(
                    key: ValueKey('cath-report-edit-${report.id}'),
                    onPressed: _busyKey == null
                        ? () => _openEditor(report: report)
                        : null,
                    icon: const Icon(Icons.edit_outlined, size: 18),
                    label: Text(s.lookup('s4.lib.cath_lab.report.edit')),
                  ),
                if (report.isDraft && canEdit)
                  OutlinedButton.icon(
                    key: ValueKey('cath-report-preliminary-${report.id}'),
                    onPressed: _busyKey == null
                        ? () => _makePreliminary(report)
                        : null,
                    icon: const Icon(Icons.fact_check_outlined, size: 18),
                    label: Text(
                      s.lookup('s4.lib.cath_lab.report.mark_preliminary'),
                    ),
                  ),
                if (report.isPreliminary &&
                    cathReportCanSignForRole(widget.role))
                  FilledButton.icon(
                    key: ValueKey('cath-report-sign-${report.id}'),
                    onPressed: _busyKey == null
                        ? () => _confirmAndSign(report)
                        : null,
                    icon: const Icon(Icons.verified_outlined, size: 18),
                    label: Text(s.lookup('s4.lib.cath_lab.report.sign')),
                  ),
                if (report.isSigned && cathReportCanSignForRole(widget.role))
                  OutlinedButton.icon(
                    key: ValueKey('cath-report-addendum-${report.id}'),
                    onPressed: _busyKey == null
                        ? () => _showAddendumDialog(report)
                        : null,
                    icon: const Icon(Icons.post_add_outlined, size: 18),
                    label: Text(
                      s.lookup('s4.lib.cath_lab.report.add_addendum'),
                    ),
                  ),
                if (report.isSigned)
                  ClinicalPrintPdfAction(
                    visible: true,
                    busy: _busyKey == 'pdf-${report.id}',
                    onPressed: _busyKey == null ? () => _print(report) : null,
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ReportCountBadge extends StatelessWidget {
  const _ReportCountBadge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.primaryContainer,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        AppStrings.of(context)
            .format('s4.dynamic.cath_lab.report.count', {'count': count}),
      ),
    );
  }
}

class _CathReportAddendumDialog extends StatefulWidget {
  const _CathReportAddendumDialog();

  @override
  State<_CathReportAddendumDialog> createState() =>
      _CathReportAddendumDialogState();
}

class _CathReportAddendumDialogState extends State<_CathReportAddendumDialog> {
  final _formKey = GlobalKey<FormState>();
  final _reasonController = TextEditingController();
  final _narrativeController = TextEditingController();

  @override
  void dispose() {
    _reasonController.dispose();
    _narrativeController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return AlertDialog(
      title: Text(s.lookup('s4.lib.cath_lab.report.add_addendum')),
      content: Form(
        key: _formKey,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                key: const ValueKey('cath-report-addendum-reason'),
                controller: _reasonController,
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.cath_lab.report.addendum_reason'),
                  hintText: s.lookup(
                    's4.lib.cath_lab.report.addendum_reason_hint',
                  ),
                ),
                validator: (value) => (value ?? '').trim().isEmpty
                    ? s.lookup('s4.lib.cath_lab.report.addendum_required')
                    : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                key: const ValueKey('cath-report-addendum-narrative'),
                controller: _narrativeController,
                minLines: 4,
                maxLines: 8,
                decoration: InputDecoration(
                  labelText: s.lookup(
                    's4.lib.cath_lab.report.addendum_narrative',
                  ),
                  hintText: s.lookup(
                    's4.lib.cath_lab.report.addendum_narrative_hint',
                  ),
                  alignLabelWithHint: true,
                ),
                validator: (value) => (value ?? '').trim().isEmpty
                    ? s.lookup('s4.lib.cath_lab.report.addendum_required')
                    : null,
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(s.actionCancel),
        ),
        FilledButton(
          key: const ValueKey('cath-report-addendum-submit'),
          onPressed: () {
            if (_formKey.currentState?.validate() != true) return;
            Navigator.pop(
              context,
              CathReportAddendumDraft(
                reason: _reasonController.text.trim(),
                narrative: _narrativeController.text.trim(),
              ),
            );
          },
          child: Text(s.lookup('s4.lib.cath_lab.report.submit_addendum')),
        ),
      ],
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        label,
        style: TextStyle(color: color, fontWeight: FontWeight.w600),
      ),
    );
  }
}

class _MetaLine extends StatelessWidget {
  const _MetaLine({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 16, color: AppTheme.textSecondary),
        const SizedBox(width: 5),
        Text(text, style: TextStyle(color: AppTheme.textSecondary)),
      ],
    );
  }
}

Future<void> _launchViewerExternally(Uri uri) async {
  if (!await canLaunchUrl(uri)) throw Exception('Viewer link is unavailable');
  final launched = await launchUrl(uri, mode: LaunchMode.externalApplication);
  if (!launched) throw Exception('Viewer link could not be opened');
}

Future<void> _printReportPdf(CathProcedureReport report) async {
  final bytes = await CathLabApiService.downloadReportPdf(report.id);
  await Printing.layoutPdf(
    name: 'cath_report_${report.id}.pdf',
    onLayout: (_) async => bytes,
  );
}

String _patientLabel(AppStrings s, CathLabCaseSummary cathCase) {
  final name = cathCase.patientName.trim();
  final uid = cathCase.patientUid.trim();
  if (name.isNotEmpty && uid.isNotEmpty) return '$name - $uid';
  if (name.isNotEmpty) return name;
  if (uid.isNotEmpty) return uid;
  return s.lookup('s4.lib.cath_lab.unknown_patient');
}

String _humanize(String value) {
  final words = value
      .replaceAll(RegExp(r'[_-]+'), ' ')
      .trim()
      .split(RegExp(r'\s+'))
      .where((word) => word.isNotEmpty)
      .map((word) => '${word[0].toUpperCase()}${word.substring(1)}')
      .join(' ');
  return words.isEmpty ? value : words;
}

String _cleanError(Object error) {
  return error.toString().replaceFirst(RegExp(r'^Exception:\s*'), '').trim();
}

String? _reportSummary(CathProcedureReport report) {
  if (report.findingsSummary.trim().isNotEmpty) {
    return report.findingsSummary;
  }
  final preferred =
      report.narrativeSections['findings'] ??
      report.narrativeSections['result'];
  if ((preferred ?? '').trim().isNotEmpty) return preferred;
  for (final value in report.narrativeSections.values) {
    if (value.trim().isNotEmpty) return value;
  }
  return null;
}
