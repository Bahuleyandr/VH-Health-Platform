// lib/features/emr/widgets/patient_summary_sheet.dart
//
// One-screen patient summary (roadmap E5) — Epic-style information
// density: allergies, active problems, active medication orders, last
// vitals, and pending results in ONE modal sheet, reachable in a single
// tap from any patient context (and via the global patient search on
// every app bar, so "from anywhere" = magnifier → patient → summary).
//
// Composed CLIENT-SIDE from existing endpoints in parallel — no backend
// changes: command board (allergies + admission context), B7 problem
// list, EMR vitals chart, and the patient's clinical orders partitioned
// into active meds / pending results
// (lib/features/emr/models/patient_summary.dart, unit-tested).
//
// Every section degrades independently — one failed fetch renders that
// section's error line, never a blank sheet.

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';
import '../models/order_draft.dart';
import '../models/patient_summary.dart';

class PatientSummarySheet extends StatefulWidget {
  const PatientSummarySheet({
    super.key,
    required this.patientUid,
    this.patientName,
  });

  final String patientUid;
  final String? patientName;

  /// Open the summary for [patientUid]. One tap from any patient
  /// context — pair with an `Icons.assignment_ind_outlined` action.
  static Future<void> show(
    BuildContext context, {
    required String patientUid,
    String? patientName,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppTheme.cardSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (_) => Padding(
        padding: const EdgeInsets.only(top: 32),
        child: PatientSummarySheet(
          patientUid: patientUid,
          patientName: patientName,
        ),
      ),
    );
  }

  @override
  State<PatientSummarySheet> createState() => _PatientSummarySheetState();
}

class _SectionData<T> {
  T? value;
  String? error;
  bool loading = true;
}

class _PatientSummarySheetState extends State<PatientSummarySheet> {
  final _allergies = _SectionData<List<String>>();
  final _problems = _SectionData<List<Map<String, dynamic>>>();
  final _vitals = _SectionData<Map<String, dynamic>?>();
  final _orders =
      _SectionData<
        ({
          List<Map<String, dynamic>> activeMeds,
          List<Map<String, dynamic>> pendingResults,
        })
      >();
  Map<String, dynamic>? _admission;

  @override
  void initState() {
    super.initState();
    _loadAll();
  }

  void _loadAll() {
    // Independent parallel fetches; each section settles on its own.
    _run(_allergies, () async {
      final board = await MedicalApiService.getPatientCommandBoard(
        patientUid: widget.patientUid,
        limit: 1,
      );
      final entry = extractBoardEntry(board, widget.patientUid);
      if (entry != null && mounted) {
        setState(() => _admission = entry);
      }
      final items = entry?['allergies'] is Map
          ? ((entry!['allergies'] as Map)['items'] as List? ?? const [])
          : const <dynamic>[];
      return summarizeAllergies(items);
    });
    _run(_problems, () async {
      return MedicalApiService.getPatientProblems(
        widget.patientUid,
        status: 'active',
      );
    });
    _run(_vitals, () async {
      final data = await MedicalApiService.getVitalsChart(widget.patientUid);
      final rows = data['data'];
      if (rows is List && rows.isNotEmpty && rows.first is Map) {
        return Map<String, dynamic>.from(rows.first as Map);
      }
      return null;
    });
    _run(_orders, () async {
      final data = await MedicalApiService.getPatientOrders(widget.patientUid);
      final list = data['orders'] ?? data['data'];
      return partitionOrdersForSummary(list is List ? list : const []);
    });
  }

  Future<void> _run<T>(
    _SectionData<T> section,
    Future<T> Function() fetch,
  ) async {
    try {
      final value = await fetch();
      if (!mounted) return;
      setState(() {
        section.value = value;
        section.loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        section.error = e.toString().replaceFirst('Exception: ', '');
        section.loading = false;
      });
    }
  }

  String get _query => widget.patientName == null
      ? ''
      : '?name=${Uri.encodeQueryComponent(widget.patientName!)}';

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return SafeArea(
      top: false,
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.8,
        child: Column(
          children: [
            Container(
              width: 40,
              height: 4,
              margin: const EdgeInsets.only(top: 8, bottom: 10),
              decoration: BoxDecoration(
                color: AppTheme.divider,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            _header(s),
            const Divider(height: 1),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
                children: [
                  _allergySection(s),
                  _section(
                    s.summaryProblems,
                    Icons.medical_information_outlined,
                    _problems,
                    (problems) => problems.isEmpty
                        ? _muted(s.summaryNoProblems)
                        : Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              for (final p in problems.take(8))
                                _line(
                                  title: p['title']?.toString() ?? '—',
                                  subtitle:
                                      [
                                            p['icd10_code'],
                                            if (p['is_chronic'] == true)
                                              s.summaryChronic,
                                            p['severity'],
                                          ]
                                          .where(
                                            (e) =>
                                                e != null &&
                                                '$e'.trim().isNotEmpty,
                                          )
                                          .join(' · '),
                                ),
                            ],
                          ),
                  ),
                  _section(
                    s.summaryActiveMeds,
                    Icons.medication_outlined,
                    _orders,
                    (orders) => orders.activeMeds.isEmpty
                        ? _muted(s.summaryNoActiveMeds)
                        : Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              for (final med in orders.activeMeds.take(10))
                                _orderLine(med),
                            ],
                          ),
                  ),
                  _section(
                    s.summaryLastVitals,
                    Icons.monitor_heart_outlined,
                    _vitals,
                    (row) {
                      final line = latestVitalsLine(row);
                      if (line.isEmpty) return _muted(s.summaryNoVitals);
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            line,
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          if (row?['recorded_at'] != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: _muted(
                                _formatTimestamp(
                                  row!['recorded_at'].toString(),
                                ),
                              ),
                            ),
                        ],
                      );
                    },
                  ),
                  _section(
                    s.summaryPendingResults,
                    Icons.hourglass_top_outlined,
                    _orders,
                    (orders) => orders.pendingResults.isEmpty
                        ? _muted(s.summaryNoPendingResults)
                        : Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              for (final o in orders.pendingResults.take(10))
                                _orderLine(o),
                            ],
                          ),
                  ),
                  const SizedBox(height: 8),
                  _quickLinks(s),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _header(AppStrings s) {
    final bed = _admission?['bed'] is Map
        ? ((_admission!['bed'] as Map)['label'] ??
              (_admission!['bed'] as Map)['bed_number'])
        : (_admission?['bed_number'] ?? _admission?['ward']);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
      child: Row(
        children: [
          CircleAvatar(
            backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.12),
            child: const Icon(
              Icons.assignment_ind_outlined,
              color: AppTheme.primaryBlue,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  widget.patientName ?? s.summaryTitle,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  bed != null && '$bed'.isNotEmpty
                      ? s.summaryAdmittedBed('$bed')
                      : s.summaryTitle,
                  style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: s.actionRefresh,
            icon: const Icon(Icons.refresh),
            onPressed: () {
              setState(() {
                for (final section in [_allergies, _problems, _vitals]) {
                  section.loading = true;
                  section.error = null;
                }
                _orders.loading = true;
                _orders.error = null;
              });
              _loadAll();
            },
          ),
        ],
      ),
    );
  }

  /// Allergies render first and LOUD — the one summary line a nurse must
  /// never miss (A10).
  Widget _allergySection(AppStrings s) {
    Widget body;
    if (_allergies.loading) {
      body = const LinearProgressIndicator(minHeight: 2);
    } else if (_allergies.error != null) {
      body = _muted(s.summarySectionFailed);
    } else {
      final allergies = _allergies.value ?? const [];
      body = allergies.isEmpty
          ? _muted(s.summaryNoKnownAllergies)
          : Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final a in allergies)
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: AppTheme.errorRed.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: AppTheme.errorRed.withValues(alpha: 0.4),
                      ),
                    ),
                    child: Text(
                      a,
                      style: const TextStyle(
                        color: AppTheme.errorRed,
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
              ],
            );
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.warning_amber_rounded,
                size: 16,
                color: AppTheme.errorRed,
              ),
              const SizedBox(width: 6),
              Text(
                s.summaryAllergies,
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  color: AppTheme.errorRed,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          body,
        ],
      ),
    );
  }

  Widget _section<T>(
    String title,
    IconData icon,
    _SectionData<T> data,
    Widget Function(T value) builder,
  ) {
    final s = AppStrings.of(context);
    Widget body;
    if (data.loading) {
      body = const LinearProgressIndicator(minHeight: 2);
    } else if (data.error != null) {
      body = _muted(s.summarySectionFailed);
    } else if (data.value == null) {
      body = _muted(s.labelNoData);
    } else {
      body = builder(data.value as T);
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 16, color: AppTheme.textSecondary),
              const SizedBox(width: 6),
              Text(
                title,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  color: AppTheme.textSecondary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          body,
        ],
      ),
    );
  }

  Widget _orderLine(Map<String, dynamic> order) {
    final display = orderDisplayFields(order);
    final priority = order['priority']?.toString().toLowerCase();
    return _line(
      title: display.title,
      subtitle: display.subtitle,
      trailing: priority == 'stat' || priority == 'urgent'
          ? priority!.toUpperCase()
          : null,
    );
  }

  Widget _line({required String title, String? subtitle, String? trailing}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (subtitle != null && subtitle.isNotEmpty)
                  Text(
                    subtitle,
                    style: TextStyle(
                      fontSize: 12,
                      color: AppTheme.textSecondary,
                    ),
                  ),
              ],
            ),
          ),
          if (trailing != null)
            Text(
              trailing,
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: AppTheme.errorRed,
              ),
            ),
        ],
      ),
    );
  }

  Widget _muted(String text) {
    return Text(
      text,
      style: TextStyle(fontSize: 13, color: AppTheme.textSecondary),
    );
  }

  Widget _quickLinks(AppStrings s) {
    final uid = widget.patientUid;
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: [
        ActionChip(
          avatar: const Icon(Icons.receipt_long, size: 16),
          label: Text(s.ordersTitlePrefix),
          onPressed: () {
            Navigator.of(context).pop();
            context.push('/emr/orders/$uid$_query');
          },
        ),
        ActionChip(
          avatar: const Icon(Icons.monitor_heart, size: 16),
          label: Text(s.vitalsChartTitlePrefix),
          onPressed: () {
            Navigator.of(context).pop();
            context.push('/emr/vitals/$uid$_query');
          },
        ),
        ActionChip(
          avatar: const Icon(Icons.timeline, size: 16),
          label: Text(s.summaryTimeline),
          onPressed: () {
            Navigator.of(context).pop();
            context.push('/emr/timeline/$uid$_query');
          },
        ),
        ActionChip(
          avatar: const Icon(Icons.note_alt, size: 16),
          label: Text(s.summaryNotes),
          onPressed: () {
            Navigator.of(context).pop();
            context.push('/emr/notes/$uid$_query');
          },
        ),
      ],
    );
  }

  String _formatTimestamp(String ts) {
    try {
      final dt = DateTime.parse(ts).toLocal();
      return '${dt.day}/${dt.month} ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return ts;
    }
  }
}
