// Shared record card widget and helpers used by Hospital Documents and My Uploads tabs
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';
import 'package:vhhealth/generated/app_localizations.dart';

IconData iconForDocType(String type) {
  switch (type) {
    case 'prescription':
      return Icons.medical_services;
    case 'lab_report':
      return Icons.science;
    case 'radiology':
      return Icons.image_search;
    case 'vaccination':
      return Icons.vaccines;
    case 'insurance':
      return Icons.shield;
    case 'discharge_summary':
      return Icons.assignment_returned;
    default:
      return Icons.description;
  }
}

Color colorForDocType(String type) {
  switch (type) {
    case 'prescription':
      return Colors.blue;
    case 'lab_report':
      return Colors.purple;
    case 'radiology':
      return Colors.indigo;
    case 'vaccination':
      return Colors.green;
    case 'insurance':
      return Colors.teal;
    case 'discharge_summary':
      return Colors.orange;
    default:
      return Colors.blueGrey;
  }
}

Future<void> openDocument(
  BuildContext context,
  Map<String, dynamic> record,
) async {
  final l = AppLocalizations.of(context)!;
  final url = record['file_url']?.toString();
  if (url == null || url.isEmpty) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(l.recordsDocumentUrlMissing)));
    return;
  }
  final launched = await SafeUrlLauncher.launch(
    url,
    mode: LaunchMode.externalApplication,
  );
  if (!launched && context.mounted) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(l.documentCouldNotOpen)));
  }
}

class RecordCard extends StatelessWidget {
  final Map<String, dynamic> record;
  final bool showSource;
  final VoidCallback? onTap;

  const RecordCard({
    super.key,
    required this.record,
    this.showSource = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final docType = record['document_type']?.toString() ?? 'other';
    final title = _recordTitle(record, docType);
    final doctorName = record['doctor_name'];
    final department = record['doctor_department'] ?? record['department'];
    final fileUrl = record['file_url'];
    final sourceHospital = record['source_hospital'];
    final source = record['source']?.toString();
    final extraction = _asMap(record['ai_extraction']);
    final extractionLabel = _extractionLabel(extraction);
    final appointmentDate = record['appointment_date']
        ?.toString()
        .split('T')
        .first;
    final createdAt = record['created_at']?.toString().split('T').first;
    final typeColor = colorForDocType(docType);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        onTap: onTap ?? () => openDocument(context, record),
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: typeColor.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(
                  iconForDocType(docType),
                  color: typeColor,
                  size: 24,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    if (doctorName != null)
                      Text(
                        '$doctorName${department != null ? ' • $department' : ''}',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: cs.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    if (sourceHospital != null)
                      Text(
                        sourceHospital.toString(),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: cs.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: typeColor.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            _compactType(docType).toUpperCase(),
                            style: TextStyle(
                              color: typeColor,
                              fontSize: 10,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        if (showSource || source != null)
                          _MiniChip(
                            label: source == 'appointment'
                                ? 'HOSPITAL'
                                : 'MY UPLOAD',
                            color: source == 'appointment'
                                ? Colors.teal
                                : Colors.orange,
                          ),
                        if (extractionLabel != null)
                          _MiniChip(
                            label: extractionLabel.toUpperCase(),
                            color: _trustColor(extractionLabel, cs),
                          ),
                        if (appointmentDate != null)
                          Text(
                            appointmentDate,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: cs.onSurfaceVariant,
                            ),
                          )
                        else if (createdAt != null)
                          Text(
                            createdAt,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Icon(
                onTap != null
                    ? Icons.fact_check_outlined
                    : fileUrl != null
                    ? Icons.open_in_new
                    : Icons.lock,
                size: 18,
                color: fileUrl != null || onTap != null
                    ? typeColor
                    : cs.onSurfaceVariant,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MiniChip extends StatelessWidget {
  final String label;
  final Color color;

  const _MiniChip({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.11),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 10,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

String _recordTitle(Map<String, dynamic> record, String docType) {
  final title = record['title']?.toString().trim();
  if (title != null && title.isNotEmpty) return title;

  final extraction = _asMap(record['ai_extraction']);
  final extractedType = extraction['document_type']?.toString().trim();
  if (extractedType != null && extractedType.isNotEmpty) {
    return _compactType(extractedType);
  }

  return _compactType(docType);
}

Map<String, dynamic> _asMap(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return {};
}

String? _extractionLabel(Map<String, dynamic> extraction) {
  if (extraction.isEmpty) return null;
  final status = (extraction['extraction_status'] ?? '')
      .toString()
      .toLowerCase();
  final reviewer = (extraction['reviewer_decision'] ?? '')
      .toString()
      .toLowerCase();
  if (reviewer == 'approved' || reviewer == 'accepted') {
    return 'reviewed';
  }
  if (status == 'completed') return 'ai draft';
  if (status == 'needs_review') return 'needs review';
  if (status == 'failed' || status == 'unavailable') return 'ai unavailable';
  if (status.isEmpty) return null;
  return _compactType(status);
}

Color _trustColor(String label, ColorScheme cs) {
  final lower = label.toLowerCase();
  if (lower.contains('reviewed')) return Colors.teal;
  if (lower.contains('unavailable') || lower.contains('failed')) {
    return cs.error;
  }
  return Colors.orange;
}

String _compactType(String value) {
  final normalized = value.replaceAll('-', '_').trim();
  if (normalized.isEmpty) return 'Record';
  return normalized
      .split('_')
      .where((part) => part.isNotEmpty)
      .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
      .join(' ');
}
