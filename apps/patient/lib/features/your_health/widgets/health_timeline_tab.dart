import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/your_health/widgets/patient_record_extraction_sheet.dart';
import 'package:vhhealth/features/your_health/widgets/record_card.dart';
import 'package:vhhealth/generated/app_localizations.dart';

enum _TimelineFilter { all, visits, prescriptions, labs, uploads, hospital }

String _timelineFilterLabel(AppLocalizations l, _TimelineFilter filter) {
  switch (filter) {
    case _TimelineFilter.visits:
      return l.yourHealthTimelineFilterVisits;
    case _TimelineFilter.prescriptions:
      return l.yourHealthTimelineFilterPrescriptions;
    case _TimelineFilter.labs:
      return l.yourHealthTimelineFilterLabs;
    case _TimelineFilter.uploads:
      return l.yourHealthTimelineFilterUploads;
    case _TimelineFilter.hospital:
      return l.yourHealthTimelineFilterHospital;
    case _TimelineFilter.all:
      return l.yourHealthTimelineFilterAll;
  }
}

class HealthTimelineTab extends StatefulWidget {
  final ValueChanged<int>? onOpenTab;
  final VoidCallback? onUploadRecord;

  const HealthTimelineTab({super.key, this.onOpenTab, this.onUploadRecord});

  @override
  State<HealthTimelineTab> createState() => _HealthTimelineTabState();
}

class _HealthTimelineTabState extends State<HealthTimelineTab> {
  _TimelineFilter _filter = _TimelineFilter.all;
  bool _loading = true;
  String? _error;
  List<_TimelineItem> _items = [];

  @override
  void initState() {
    super.initState();
    _loadTimeline();
  }

  Future<void> _loadTimeline() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      Future<ApiResponse?> safeGet(String path) async {
        try {
          return await ApiClient.get(path);
        } catch (_) {
          return null;
        }
      }

      final results = await Future.wait([
        safeGet('/appointments/patient/records/all'),
        safeGet('/prescriptions/patient/my'),
        safeGet('/portal/clinical-notes'),
      ]);
      if (!mounted) return;

      final nextItems = <_TimelineItem>[];
      final partialErrors = <String>[];

      final recordsResponse = results[0];
      if (recordsResponse != null && recordsResponse.isSuccess) {
        final data = recordsResponse.dataAsMap();
        final hospitalRecords = (data['hospital_records'] as List?) ?? [];
        final uploads = (data['my_uploads'] as List?) ?? [];
        nextItems.addAll(
          hospitalRecords.whereType<Map>().map(
            (record) => _fromRecord(Map<String, dynamic>.from(record)),
          ),
        );
        nextItems.addAll(
          uploads.whereType<Map>().map(
            (record) => _fromUpload(Map<String, dynamic>.from(record)),
          ),
        );
      } else {
        partialErrors.add('records');
      }

      final prescriptionResponse = results[1];
      if (prescriptionResponse != null && prescriptionResponse.isSuccess) {
        nextItems.addAll(
          prescriptionResponse.dataAsList().whereType<Map>().map(
            (rx) => _fromPrescription(Map<String, dynamic>.from(rx)),
          ),
        );
      } else {
        partialErrors.add('prescriptions');
      }

      final consultationsResponse = results[2];
      if (consultationsResponse != null && consultationsResponse.isSuccess) {
        final rows = consultationsResponse.data is List
            ? consultationsResponse.data as List
            : const [];
        nextItems.addAll(
          rows.whereType<Map>().map(
            (visit) => _fromConsultation(Map<String, dynamic>.from(visit)),
          ),
        );
      } else {
        partialErrors.add('consultations');
      }

      nextItems.sort((a, b) => b.sortDate.compareTo(a.sortDate));
      setState(() {
        _items = nextItems;
        _loading = false;
        _error = partialErrors.isEmpty
            ? null
            : 'Some sections could not refresh: ${partialErrors.join(', ')}';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  _TimelineItem _fromRecord(Map<String, dynamic> record) {
    final docType = (record['document_type'] ?? 'other').toString();
    final doctor = _nonEmpty(record['doctor_name']?.toString());
    final department = _nonEmpty(
      (record['doctor_department'] ?? record['department'])?.toString(),
    );
    final subtitle = [?doctor, ?department, 'Hospital issued'].join(' - ');
    return _TimelineItem(
      kind: _TimelineKind.hospital,
      title: _titleForRecord(record),
      subtitle: subtitle,
      sourceLabel: 'Hospital',
      trustLabel: 'Hospital verified',
      date: _dateFrom(record, [
        'appointment_date',
        'record_date',
        'created_at',
      ]),
      icon: iconForDocType(docType),
      color: colorForDocType(docType),
      record: record,
      onTap: (context) => openDocument(context, record),
    );
  }

  _TimelineItem _fromUpload(Map<String, dynamic> record) {
    final docType = (record['document_type'] ?? 'other').toString();
    final extraction = _asMap(record['ai_extraction']);
    final aiStatus = _extractionLabel(extraction);
    final hospital = _nonEmpty(record['source_hospital']?.toString());
    final subtitle = [
      ?hospital,
      _fileLabel(record),
    ].where((part) => part.isNotEmpty).join(' - ');
    return _TimelineItem(
      kind: _TimelineKind.upload,
      title: _titleForRecord(record),
      subtitle: subtitle.isEmpty ? 'Patient upload' : subtitle,
      sourceLabel: 'My Upload',
      trustLabel: aiStatus,
      date: _dateFrom(record, ['record_date', 'created_at']),
      icon: iconForDocType(docType),
      color: colorForDocType(docType),
      record: record,
      onTap: (context) => _openExtractionReview(record),
    );
  }

  _TimelineItem _fromPrescription(Map<String, dynamic> rx) {
    final meds = rx['medications'] is List ? rx['medications'] as List : [];
    final doctor = _nonEmpty(rx['doctor_name']?.toString());
    final doctorLabel = doctor == null ? null : 'Dr. $doctor';
    final specialization = _nonEmpty(rx['doctor_specialization']?.toString());
    final subtitle = [
      ?doctorLabel,
      ?specialization,
      '${meds.length} medicines',
    ].join(' - ');
    return _TimelineItem(
      kind: _TimelineKind.prescription,
      title: _nonEmpty(rx['prescription_number']?.toString()) ?? 'Prescription',
      subtitle: subtitle,
      sourceLabel: 'Prescription',
      trustLabel: 'Doctor issued',
      date: _dateFrom(rx, ['issued_at', 'created_at', 'date']),
      icon: Icons.medication_outlined,
      color: Colors.blue,
      record: rx,
      onTap: (_) => widget.onOpenTab?.call(4),
    );
  }

  _TimelineItem _fromConsultation(Map<String, dynamic> visit) {
    final title = _nonEmpty(visit['title']?.toString());
    final role = _nonEmpty(visit['author_role']?.toString());
    final noteType = _nonEmpty(visit['note_type']?.toString());
    final content = _asMap(visit['content']);
    final diagnosis = _nonEmpty(
      (content['diagnosis'] ?? content['assessment'])?.toString(),
    );
    final plan = _nonEmpty(content['plan']?.toString());
    final subtitle = [
      ?(noteType == null ? null : _compactType(noteType)),
      ?(role == null ? null : _compactType(role)),
      ?diagnosis,
      ?plan,
    ].join(' - ');
    return _TimelineItem(
      kind: _TimelineKind.visit,
      title: title ?? 'Consultation note',
      subtitle: subtitle.isEmpty ? 'Appointment consultation note' : subtitle,
      sourceLabel: 'Visit',
      trustLabel: 'Consultation note',
      date: _dateFrom(visit, ['signed_at', 'created_at', 'updated_at']),
      icon: Icons.medical_services_outlined,
      color: Colors.teal,
      record: visit,
      onTap: (_) => widget.onOpenTab?.call(5),
    );
  }

  void _openExtractionReview(Map<String, dynamic> record) {
    showDialog<void>(
      context: context,
      builder: (_) => PatientRecordExtractionSheet(
        record: record,
        onRecordUpdated: (updated) {
          if (!mounted) return;
          setState(() {
            _items = _items.map((item) {
              if (item.record['id'] != updated['id']) return item;
              return _fromUpload({...item.record, ...updated});
            }).toList()..sort((a, b) => b.sortDate.compareTo(a.sortDate));
          });
        },
      ),
    );
  }

  List<_TimelineItem> get _filteredItems {
    return _items.where((item) {
      return switch (_filter) {
        _TimelineFilter.all => true,
        _TimelineFilter.visits => item.kind == _TimelineKind.visit,
        _TimelineFilter.prescriptions =>
          item.kind == _TimelineKind.prescription,
        _TimelineFilter.labs => item.isLabLike,
        _TimelineFilter.uploads => item.kind == _TimelineKind.upload,
        _TimelineFilter.hospital => item.kind == _TimelineKind.hospital,
      };
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l = AppLocalizations.of(context)!;

    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    final items = _filteredItems;

    return RefreshIndicator(
      onRefresh: _loadTimeline,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
        children: [
          _TimelineSummary(
            total: _items.length,
            prescriptions: _items
                .where((item) => item.kind == _TimelineKind.prescription)
                .length,
            visits: _items
                .where((item) => item.kind == _TimelineKind.visit)
                .length,
            uploads: _items
                .where((item) => item.kind == _TimelineKind.upload)
                .length,
            l: l,
          ),
          const SizedBox(height: 12),
          if (_error != null)
            _InlineNotice(
              icon: Icons.sync_problem_outlined,
              color: cs.error,
              text: _error!,
            ),
          _buildFilterChips(l),
          const SizedBox(height: 10),
          if (items.isEmpty)
            _TimelineEmptyState(
              filter: _filter,
              onUpload: widget.onUploadRecord,
              onRefresh: _loadTimeline,
              l: l,
            )
          else
            ...items.map(
              (item) => _TimelineCard(
                item: item,
                dateFormat: DateFormat('dd MMM yyyy'),
                l: l,
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildFilterChips(AppLocalizations l) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: _TimelineFilter.values.map((filter) {
          return Padding(
            padding: const EdgeInsets.only(right: 8),
            child: ChoiceChip(
              label: Text(_timelineFilterLabel(l, filter)),
              selected: _filter == filter,
              onSelected: (_) => setState(() => _filter = filter),
            ),
          );
        }).toList(),
      ),
    );
  }
}

class _TimelineSummary extends StatelessWidget {
  final int total;
  final int prescriptions;
  final int visits;
  final int uploads;
  final AppLocalizations l;

  const _TimelineSummary({
    required this.total,
    required this.prescriptions,
    required this.visits,
    required this.uploads,
    required this.l,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: cs.outlineVariant),
        color: cs.surfaceContainerHighest.withValues(alpha: 0.55),
      ),
      child: Row(
        children: [
          Icon(Icons.timeline_outlined, color: cs.primary),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              total == 0
                  ? l.yourHealthTimelineReady
                  : l.yourHealthTimelineUpdateCount(total),
              style: theme.textTheme.titleSmall?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          _CountPill(label: l.yourHealthTimelineRxPill, value: prescriptions),
          const SizedBox(width: 6),
          _CountPill(label: l.yourHealthTimelineVisitsPill, value: visits),
          const SizedBox(width: 6),
          _CountPill(label: l.yourHealthTimelineUploadsPill, value: uploads),
        ],
      ),
    );
  }
}

class _CountPill extends StatelessWidget {
  final String label;
  final int value;

  const _CountPill({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: cs.primaryContainer.withValues(alpha: 0.75),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        '$label $value',
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: cs.onPrimaryContainer,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

class _TimelineCard extends StatelessWidget {
  final _TimelineItem item;
  final DateFormat dateFormat;
  final AppLocalizations l;

  const _TimelineCard({
    required this.item,
    required this.dateFormat,
    required this.l,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final date = item.date == null
        ? l.yourHealthTimelineDatePending
        : dateFormat.format(item.date!);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => item.onTap(context),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  color: item.color.withValues(alpha: 0.13),
                  shape: BoxShape.circle,
                  border: Border.all(color: item.color.withValues(alpha: 0.35)),
                ),
                child: Icon(item.icon, color: item.color, size: 24),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Text(
                            item.title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          date,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      item.subtitle,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        _StatusChip(label: item.sourceLabel, color: item.color),
                        _StatusChip(
                          label: item.trustLabel,
                          color: _trustColor(item.trustLabel, cs),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              Icon(Icons.chevron_right, color: cs.onSurfaceVariant, size: 20),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  final String label;
  final Color color;

  const _StatusChip({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelSmall
            ?.copyWith(color: color, fontWeight: FontWeight.w800),
      ),
    );
  }
}

class _InlineNotice extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String text;

  const _InlineNotice({
    required this.icon,
    required this.color,
    required this.text,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          Icon(icon, color: color, size: 18),
          const SizedBox(width: 8),
          Expanded(child: Text(text)),
        ],
      ),
    );
  }
}

class _TimelineEmptyState extends StatelessWidget {
  final _TimelineFilter filter;
  final VoidCallback? onUpload;
  final Future<void> Function() onRefresh;
  final AppLocalizations l;

  const _TimelineEmptyState({
    required this.filter,
    required this.onUpload,
    required this.onRefresh,
    required this.l,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final filtered = filter != _TimelineFilter.all;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 56, horizontal: 10),
      child: Column(
        children: [
          Icon(
            filtered ? Icons.filter_alt_off_outlined : Icons.health_and_safety,
            size: 56,
            color: cs.onSurfaceVariant,
          ),
          const SizedBox(height: 12),
          Text(
            filtered
                ? l.yourHealthTimelineFilteredEmpty(
                    _timelineFilterLabel(l, filter).toLowerCase(),
                  )
                : l.yourHealthTimelineEmptyTitle,
            textAlign: TextAlign.center,
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            filtered
                ? l.yourHealthTimelineFilteredEmptySubtitle
                : l.yourHealthTimelineEmptySubtitle,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: cs.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 18),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            alignment: WrapAlignment.center,
            children: [
              OutlinedButton.icon(
                onPressed: onRefresh,
                icon: const Icon(Icons.refresh),
                label: Text(l.commonRefreshButton),
              ),
              if (onUpload != null)
                FilledButton.icon(
                  onPressed: onUpload,
                  icon: const Icon(Icons.upload_file),
                  label: Text(l.yourHealthUploadRecord),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

enum _TimelineKind { hospital, upload, prescription, visit }

class _TimelineItem {
  final _TimelineKind kind;
  final String title;
  final String subtitle;
  final String sourceLabel;
  final String trustLabel;
  final DateTime? date;
  final IconData icon;
  final Color color;
  final Map<String, dynamic> record;
  final void Function(BuildContext) onTap;

  _TimelineItem({
    required this.kind,
    required this.title,
    required this.subtitle,
    required this.sourceLabel,
    required this.trustLabel,
    required this.date,
    required this.icon,
    required this.color,
    required this.record,
    required this.onTap,
  });

  DateTime get sortDate => date ?? DateTime.fromMillisecondsSinceEpoch(0);

  bool get isLabLike {
    final type = (record['document_type'] ?? record['record_type'] ?? '')
        .toString()
        .toLowerCase();
    return type.contains('lab') ||
        type.contains('radiology') ||
        type.contains('investigation') ||
        type.contains('report');
  }
}

String _titleForRecord(Map<String, dynamic> record) {
  final explicitTitle = _nonEmpty(record['title']?.toString());
  if (explicitTitle != null) return explicitTitle;

  final extraction = _asMap(record['ai_extraction']);
  final extractedType = _nonEmpty(extraction['document_type']?.toString());
  if (extractedType != null) return _compactType(extractedType);

  final docType = _nonEmpty(record['document_type']?.toString());
  if (docType != null) return _compactType(docType);

  return 'Health record';
}

String _fileLabel(Map<String, dynamic> record) {
  final fileName = _nonEmpty(record['file_name']?.toString());
  if (fileName != null) return fileName;
  final mime = _nonEmpty(record['file_mime']?.toString());
  return mime ?? '';
}

String _extractionLabel(Map<String, dynamic> extraction) {
  if (extraction.isEmpty) return 'AI pending';
  final status = (extraction['extraction_status'] ?? '')
      .toString()
      .toLowerCase();
  final reviewer = (extraction['reviewer_decision'] ?? '')
      .toString()
      .toLowerCase();
  if (reviewer == 'approved' || reviewer == 'accepted') {
    return 'Clinician reviewed';
  }
  if (status == 'completed') return 'AI draft - cross-check';
  if (status == 'needs_review') return 'Needs review';
  if (status == 'unavailable' || status == 'failed') return 'AI unavailable';
  return status.isEmpty ? 'AI pending' : _compactType(status);
}

Color _trustColor(String label, ColorScheme cs) {
  final lower = label.toLowerCase();
  if (lower.contains('hospital') ||
      lower.contains('doctor') ||
      lower.contains('clinical') ||
      lower.contains('reviewed')) {
    return Colors.teal;
  }
  if (lower.contains('unavailable') || lower.contains('failed')) {
    return cs.error;
  }
  if (lower.contains('draft') || lower.contains('review')) {
    return Colors.orange;
  }
  return cs.primary;
}

DateTime? _dateFrom(Map<String, dynamic> map, List<String> keys) {
  for (final key in keys) {
    final value = map[key];
    if (value == null) continue;
    final parsed = DateTime.tryParse(value.toString());
    if (parsed != null) return parsed.toLocal();
  }
  return null;
}

Map<String, dynamic> _asMap(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return {};
}

String? _nonEmpty(String? value) {
  final trimmed = value?.trim();
  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}

String _compactType(String value) {
  return value
      .replaceAll('-', '_')
      .split('_')
      .where((part) => part.isNotEmpty)
      .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
      .join(' ');
}
