import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/services/radiology_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class RadiologyScreen extends StatefulWidget {
  const RadiologyScreen({super.key});

  @override
  State<RadiologyScreen> createState() => _RadiologyScreenState();
}

class _RadiologyScreenState extends State<RadiologyScreen> {
  bool _loading = true;
  String? _error;
  List<dynamic> _orders = [];

  String _statusFilter = 'all';
  String _modalityFilter = 'all';

  static const _statusOptions = ['all', 'pending', 'in_progress', 'completed'];
  static const _modalityOptions = [
    'all',
    'X-Ray',
    'CT',
    'MRI',
    'Ultrasound',
    'PET',
  ];
  static const _classificationOptions = [
    'critical',
    'abnormal',
    'normal',
    'indeterminate',
  ];
  static const _significanceOptions = [
    'unchanged',
    'new_finding',
    'worsened',
    'improved',
    'corrected',
  ];

  @override
  void initState() {
    super.initState();
    _fetchWorklist();
  }

  Future<void> _fetchWorklist() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final data = await RadiologyApiService.getWorklist(
        status: _statusFilter == 'all' ? null : _statusFilter,
        modality: _modalityFilter == 'all' ? null : _modalityFilter,
      );
      final list = data['orders'] as List? ?? data['data'] as List? ?? [];
      if (mounted) {
        setState(() {
          _orders = list;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  Color _statusColor(String? status) {
    return switch (status?.toLowerCase()) {
      'pending' => AppTheme.primaryBlue,
      'in_progress' => AppTheme.warningAmber,
      'completed' => AppTheme.successGreen,
      'cancelled' => Colors.grey,
      _ => Colors.grey,
    };
  }

  String _statusLabel(String? status) {
    final s = AppStrings.of(context);
    return switch (status?.toLowerCase()) {
      'pending' => s.radiologyStatusPending,
      'in_progress' => s.radiologyStatusInProgress,
      'completed' => s.radiologyStatusCompleted,
      'cancelled' => s.radiologyStatusCancelled,
      _ => status ?? '—',
    };
  }

  Color _priorityColor(String? priority) {
    return switch (priority?.toLowerCase()) {
      'routine' => Colors.grey,
      'urgent' => AppTheme.warningAmber,
      'stat' => AppTheme.errorRed,
      _ => Colors.grey,
    };
  }

  String _classificationLabel(String? classification) {
    final s = AppStrings.of(context);
    return switch (classification?.toLowerCase()) {
      'critical' => s.radiologyClassificationCritical,
      'abnormal' => s.radiologyClassificationAbnormal,
      'normal' => s.radiologyClassificationNormal,
      'indeterminate' => s.radiologyClassificationIndeterminate,
      _ => classification ?? '—',
    };
  }

  String _significanceLabel(String significance) {
    final s = AppStrings.of(context);
    return switch (significance) {
      'unchanged' => s.radiologySignificanceUnchanged,
      'new_finding' => s.radiologySignificanceNewFinding,
      'worsened' => s.radiologySignificanceWorsened,
      'improved' => s.radiologySignificanceImproved,
      'corrected' => s.radiologySignificanceCorrected,
      _ => significance,
    };
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.radiologyTitle),
        actions: [
          IconButton(
            icon: const Icon(Icons.filter_list),
            onPressed: _showFilterSheet,
            tooltip: s.radiologyFiltersTooltip,
          ),
          const LogoutAction(),
        ],
      ),
      body: Column(
        children: [
          _buildFilterRow(),
          Expanded(child: _buildBody()),
        ],
      ),
    );
  }

  Widget _buildFilterRow() {
    final str = AppStrings.of(context);
    return Container(
      color: AppTheme.cardSurface,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          Expanded(
            child: DropdownButtonFormField<String>(
              initialValue: _statusFilter,
              decoration: InputDecoration(
                labelText: str.radiologyStatusLabel,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                isDense: true,
              ),
              items: _statusOptions.map((s) {
                return DropdownMenuItem(
                  value: s,
                  child: Text(
                    s == 'all' ? str.radiologyStatusAll : _statusLabel(s),
                  ),
                );
              }).toList(),
              onChanged: (v) {
                if (v != null) {
                  _statusFilter = v;
                  _fetchWorklist();
                }
              },
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: DropdownButtonFormField<String>(
              initialValue: _modalityFilter,
              decoration: InputDecoration(
                labelText: str.radiologyModalityLabel,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                isDense: true,
              ),
              items: _modalityOptions.map((m) {
                return DropdownMenuItem(
                  value: m,
                  child: Text(m == 'all' ? str.radiologyStatusAll : m),
                );
              }).toList(),
              onChanged: (v) {
                if (v != null) {
                  _modalityFilter = v;
                  _fetchWorklist();
                }
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildBody() {
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(
                Icons.error_outline,
                size: 48,
                color: AppTheme.errorRed,
              ),
              const SizedBox(height: 16),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: TextStyle(color: AppTheme.textSecondary),
              ),
              const SizedBox(height: 16),
              ElevatedButton.icon(
                onPressed: _fetchWorklist,
                icon: const Icon(Icons.refresh),
                label: Text(AppStrings.of(context).actionRetry),
              ),
            ],
          ),
        ),
      );
    }

    if (_loading) return const Center(child: CircularProgressIndicator());

    return RefreshIndicator(
      onRefresh: _fetchWorklist,
      child: _orders.isEmpty
          ? ListView(
              children: [
                const SizedBox(height: 120),
                Center(
                  child: Column(
                    children: [
                      const Icon(
                        Icons.image_not_supported,
                        size: 64,
                        color: Colors.grey,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        AppStrings.of(context).radiologyNoOrders,
                        style: const TextStyle(
                          color: Colors.grey,
                          fontSize: 16,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            )
          : ListView.builder(
              padding: const EdgeInsets.all(16),
              itemCount: _orders.length,
              itemBuilder: (context, i) {
                final o = _orders[i] as Map<String, dynamic>;
                return _buildOrderCard(o);
              },
            ),
    );
  }

  Widget _buildOrderCard(Map<String, dynamic> o) {
    final status = o['status']?.toString();
    final priority = o['priority']?.toString();
    final patientUid = o['patient_uid']?.toString() ?? '';
    final displayUid = patientUid.length > 8
        ? '${patientUid.substring(0, 8)}...'
        : patientUid;
    final orderedDate =
        o['created_at']?.toString() ?? o['ordered_date']?.toString() ?? '';
    String dateStr = '';
    if (orderedDate.isNotEmpty) {
      try {
        dateStr = DateFormat('dd MMM yyyy').format(DateTime.parse(orderedDate));
      } catch (_) {
        dateStr = orderedDate;
      }
    }

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => _showDetailSheet(o),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      '${o['study_type'] ?? 'Study'} - ${o['modality'] ?? ''}',
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 15,
                        color: AppTheme.textPrimary,
                      ),
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: _priorityColor(priority).withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      (priority ?? 'routine').toUpperCase(),
                      style: TextStyle(
                        color: _priorityColor(priority),
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Icon(Icons.person, size: 14, color: AppTheme.textSecondary),
                  const SizedBox(width: 4),
                  Text(
                    displayUid,
                    style: TextStyle(
                      fontSize: 12,
                      color: AppTheme.textSecondary,
                    ),
                  ),
                  const SizedBox(width: 16),
                  Icon(
                    Icons.accessibility_new,
                    size: 14,
                    color: AppTheme.textSecondary,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    o['body_part']?.toString() ?? '-',
                    style: TextStyle(
                      fontSize: 12,
                      color: AppTheme.textSecondary,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: _statusColor(status).withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      _statusLabel(status),
                      style: TextStyle(
                        color: _statusColor(status),
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const Spacer(),
                  if (dateStr.isNotEmpty)
                    Text(
                      dateStr,
                      style: const TextStyle(fontSize: 11, color: Colors.grey),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showDetailSheet(Map<String, dynamic> o) {
    final status = o['status']?.toString().toLowerCase();
    final id = o['id'] as int?;
    final isSigned = o['report_signed_off_at'] != null;
    final str = AppStrings.of(context);

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.55,
          maxChildSize: 0.85,
          builder: (_, scrollController) {
            return SingleChildScrollView(
              controller: scrollController,
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Center(
                    child: Container(
                      width: 40,
                      height: 4,
                      decoration: BoxDecoration(
                        color: Colors.grey[300],
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                  const SizedBox(height: 20),
                  Text(
                    '${o['study_type'] ?? '—'} - ${o['modality'] ?? ''}',
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 16),
                  _detailRow(
                    str.theatreLabelPatientUid,
                    o['patient_uid']?.toString() ?? '-',
                  ),
                  _detailRow(
                    str.radiologyLabelStudyType,
                    o['study_type']?.toString() ?? '-',
                  ),
                  _detailRow(
                    str.radiologyLabelModality,
                    o['modality']?.toString() ?? '-',
                  ),
                  _detailRow(
                    str.radiologyLabelBodyPart,
                    o['body_part']?.toString() ?? '-',
                  ),
                  _detailRow(
                    str.radiologyLabelPriority,
                    o['priority']?.toString() ?? '-',
                  ),
                  _detailRow(str.theatreLabelStatus, _statusLabel(status)),
                  _detailRow(
                    str.radiologyLabelClinicalIndication,
                    o['clinical_indication']?.toString() ?? '-',
                  ),
                  if (o['notes'] != null)
                    _detailRow(str.radiologyLabelNotes, o['notes'].toString()),
                  if (o['report'] != null)
                    _detailRow(
                      str.radiologyLabelReport,
                      o['report'].toString(),
                    ),
                  if (o['findings'] != null)
                    _detailRow(
                      str.radiologyLabelFindings,
                      o['findings'].toString(),
                    ),
                  if (o['impression'] != null)
                    _detailRow(
                      str.radiologyLabelImpression,
                      o['impression'].toString(),
                    ),
                  if (o['result_classification'] != null)
                    _detailRow(
                      str.radiologyClassification,
                      _classificationLabel(
                        o['result_classification']?.toString(),
                      ),
                    ),
                  if (o['report_generation_version'] != null)
                    _detailRow(
                      str.radiologyGenerationVersion,
                      o['report_generation_version'].toString(),
                    ),
                  const SizedBox(height: 24),
                  if (id != null) ...[
                    if (status == 'pending' || status == 'in_progress')
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton.icon(
                          onPressed: () {
                            Navigator.pop(ctx);
                            _showReportForm(id);
                          },
                          icon: const Icon(Icons.description),
                          label: Text(str.radiologySubmitReport),
                        ),
                      ),
                    if (status == 'completed' && !isSigned) ...[
                      const SizedBox(height: 10),
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton.icon(
                          onPressed: () {
                            Navigator.pop(ctx);
                            _showSignOffForm(id);
                          },
                          icon: const Icon(Icons.verified),
                          label: Text(str.radiologySignOffReport),
                        ),
                      ),
                    ],
                    if (isSigned) ...[
                      const SizedBox(height: 10),
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton.icon(
                          onPressed: () {
                            Navigator.pop(ctx);
                            _showAddendumForm(id);
                          },
                          icon: const Icon(Icons.post_add),
                          label: Text(str.radiologyAddAddendum),
                        ),
                      ),
                    ],
                    if (status != 'completed' && status != 'cancelled') ...[
                      const SizedBox(height: 10),
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton.icon(
                          onPressed: () => _cancelOrder(ctx, id),
                          icon: const Icon(Icons.cancel),
                          label: Text(str.radiologyCancelOrder),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AppTheme.errorRed,
                            side: const BorderSide(color: AppTheme.errorRed),
                          ),
                        ),
                      ),
                    ],
                  ],
                ],
              ),
            );
          },
        );
      },
    );
  }

  Widget _detailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 140,
            child: Text(
              label,
              style: TextStyle(color: AppTheme.textSecondary, fontSize: 13),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }

  void _showReportForm(int id) {
    final findingsCtrl = TextEditingController();
    final impressionCtrl = TextEditingController();
    final s = AppStrings.of(context);

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        final ds = AppStrings.of(ctx);
        return Padding(
          padding: EdgeInsets.only(
            left: 24,
            right: 24,
            top: 24,
            bottom: MediaQuery.of(ctx).viewInsets.bottom + 24,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: Colors.grey[300],
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                ds.radiologySubmitReport,
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: findingsCtrl,
                maxLines: 4,
                decoration: InputDecoration(
                  labelText: ds.radiologyLabelFindings,
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: impressionCtrl,
                maxLines: 3,
                decoration: InputDecoration(
                  labelText: ds.radiologyLabelImpression,
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: () async {
                    final findings = findingsCtrl.text.trim();
                    final impression = impressionCtrl.text.trim();
                    if (findings.isEmpty) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text(s.radiologyFindingsRequired)),
                      );
                      return;
                    }
                    Navigator.pop(ctx);
                    try {
                      await RadiologyApiService.submitReport(id, {
                        'findings': findings,
                        'impression': impression,
                      });
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text(s.radiologyReportSubmitted)),
                        );
                      }
                      _fetchWorklist();
                    } catch (e) {
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                            content: Text('${s.errorSomethingWentWrong}: $e'),
                            backgroundColor: AppTheme.errorRed,
                          ),
                        );
                      }
                    }
                  },
                  child: Text(ds.actionSubmit),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  void _showSignOffForm(int id) {
    String? classification;
    bool submitting = false;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (sheetContext) => StatefulBuilder(
        builder: (ctx, setSheetState) {
          final s = AppStrings.of(ctx);
          return Padding(
            padding: EdgeInsets.only(
              left: 24,
              right: 24,
              top: 24,
              bottom: MediaQuery.of(ctx).viewInsets.bottom + 24,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  s.radiologySignOffReport,
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                    color: AppTheme.textPrimary,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  s.radiologyClassificationAttestation,
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
                const SizedBox(height: 16),
                DropdownButtonFormField<String>(
                  initialValue: classification,
                  decoration: InputDecoration(
                    labelText: s.radiologyClassification,
                  ),
                  items: _classificationOptions
                      .map(
                        (value) => DropdownMenuItem(
                          value: value,
                          child: Text(_classificationLabel(value)),
                        ),
                      )
                      .toList(),
                  onChanged: submitting
                      ? null
                      : (value) => setSheetState(() => classification = value),
                ),
                const SizedBox(height: 20),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: submitting
                        ? null
                        : () async {
                            if (classification == null) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(
                                  content: Text(
                                    s.radiologyClassificationRequired,
                                  ),
                                ),
                              );
                              return;
                            }
                            setSheetState(() => submitting = true);
                            try {
                              await RadiologyApiService.signOffReport(
                                id,
                                resultClassification: classification!,
                              );
                              if (!mounted || !sheetContext.mounted) return;
                              Navigator.pop(sheetContext);
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(
                                  content: Text(s.radiologyReportSignedOff),
                                ),
                              );
                              _fetchWorklist();
                            } catch (e) {
                              if (!mounted || !sheetContext.mounted) return;
                              setSheetState(() => submitting = false);
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(
                                  content: Text(
                                    '${s.errorSomethingWentWrong}: $e',
                                  ),
                                  backgroundColor: AppTheme.errorRed,
                                ),
                              );
                            }
                          },
                    child: submitting
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Text(s.radiologySignOffReport),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  void _showAddendumForm(int id) {
    final addendumController = TextEditingController();
    String? classification;
    String? significance;
    bool submitting = false;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (sheetContext) => StatefulBuilder(
        builder: (ctx, setSheetState) {
          final s = AppStrings.of(ctx);
          return SingleChildScrollView(
            padding: EdgeInsets.only(
              left: 24,
              right: 24,
              top: 24,
              bottom: MediaQuery.of(ctx).viewInsets.bottom + 24,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  s.radiologyAddAddendum,
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                    color: AppTheme.textPrimary,
                  ),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: addendumController,
                  maxLines: 5,
                  enabled: !submitting,
                  decoration: InputDecoration(
                    labelText: s.radiologyAddendumText,
                    alignLabelWithHint: true,
                  ),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: classification,
                  decoration: InputDecoration(
                    labelText: s.radiologyClassification,
                  ),
                  items: _classificationOptions
                      .map(
                        (value) => DropdownMenuItem(
                          value: value,
                          child: Text(_classificationLabel(value)),
                        ),
                      )
                      .toList(),
                  onChanged: submitting
                      ? null
                      : (value) => setSheetState(() => classification = value),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: significance,
                  decoration: InputDecoration(
                    labelText: s.radiologyClinicalSignificance,
                  ),
                  items: _significanceOptions
                      .map(
                        (value) => DropdownMenuItem(
                          value: value,
                          child: Text(_significanceLabel(value)),
                        ),
                      )
                      .toList(),
                  onChanged: submitting
                      ? null
                      : (value) => setSheetState(() => significance = value),
                ),
                const SizedBox(height: 20),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: submitting
                        ? null
                        : () async {
                            final addendum = addendumController.text.trim();
                            if (addendum.isEmpty) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(
                                  content: Text(s.radiologyAddendumRequired),
                                ),
                              );
                              return;
                            }
                            if (classification == null) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(
                                  content: Text(
                                    s.radiologyClassificationRequired,
                                  ),
                                ),
                              );
                              return;
                            }
                            if (significance == null) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(
                                  content: Text(
                                    s.radiologySignificanceRequired,
                                  ),
                                ),
                              );
                              return;
                            }
                            setSheetState(() => submitting = true);
                            try {
                              await RadiologyApiService.appendAddendum(
                                id,
                                addendum: addendum,
                                resultClassification: classification!,
                                clinicalSignificance: significance!,
                              );
                              if (!mounted || !sheetContext.mounted) return;
                              Navigator.pop(sheetContext);
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(
                                  content: Text(s.radiologyAddendumSubmitted),
                                ),
                              );
                              _fetchWorklist();
                            } catch (e) {
                              if (!mounted || !sheetContext.mounted) return;
                              setSheetState(() => submitting = false);
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(
                                  content: Text(
                                    '${s.errorSomethingWentWrong}: $e',
                                  ),
                                  backgroundColor: AppTheme.errorRed,
                                ),
                              );
                            }
                          },
                    child: submitting
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Text(s.actionSubmit),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    ).whenComplete(addendumController.dispose);
  }

  Future<void> _cancelOrder(BuildContext sheetCtx, int id) async {
    Navigator.pop(sheetCtx);
    final s = AppStrings.of(context);
    try {
      await RadiologyApiService.cancelOrder(id);
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(s.radiologyOrderCancelled)));
      }
      _fetchWorklist();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('${s.errorSomethingWentWrong}: $e'),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  void _showFilterSheet() {
    final str = AppStrings.of(context);
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                str.radiologyFiltersHeader,
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 16),
              Text(
                str.radiologyStatusLabel,
                style: const TextStyle(fontWeight: FontWeight.w500),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: _statusOptions.map((s) {
                  final selected = _statusFilter == s;
                  return ChoiceChip(
                    label: Text(
                      s == 'all' ? str.radiologyStatusAll : _statusLabel(s),
                    ),
                    selected: selected,
                    onSelected: (_) {
                      setState(() => _statusFilter = s);
                      Navigator.pop(ctx);
                      _fetchWorklist();
                    },
                  );
                }).toList(),
              ),
              const SizedBox(height: 16),
              Text(
                str.radiologyModalityLabel,
                style: const TextStyle(fontWeight: FontWeight.w500),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: _modalityOptions.map((m) {
                  final selected = _modalityFilter == m;
                  return ChoiceChip(
                    label: Text(m == 'all' ? str.radiologyStatusAll : m),
                    selected: selected,
                    onSelected: (_) {
                      setState(() => _modalityFilter = m);
                      Navigator.pop(ctx);
                      _fetchWorklist();
                    },
                  );
                }).toList(),
              ),
              const SizedBox(height: 16),
            ],
          ),
        );
      },
    );
  }
}
