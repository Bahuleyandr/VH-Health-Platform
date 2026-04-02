// Shared record card widget and helpers used by Hospital Documents and My Uploads tabs
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';

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

Future<void> openDocument(BuildContext context, Map<String, dynamic> record) async {
  final url = record['file_url']?.toString();
  if (url == null || url.isEmpty) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Document URL not available')),
    );
    return;
  }
  final launched = await SafeUrlLauncher.launch(url, mode: LaunchMode.externalApplication);
  if (!launched && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Could not open document')),
    );
  }
}

class RecordCard extends StatelessWidget {
  final Map<String, dynamic> record;
  final bool showSource;

  const RecordCard({
    super.key,
    required this.record,
    this.showSource = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final docType = record['document_type']?.toString() ?? 'other';
    final title =
        record['title'] ?? docType.replaceAll('_', ' ').toUpperCase();
    final doctorName = record['doctor_name'];
    final department = record['doctor_department'] ?? record['department'];
    final fileUrl = record['file_url'];
    final sourceHospital = record['source_hospital'];
    final appointmentDate =
        record['appointment_date']?.toString().split('T').first;
    final createdAt = record['created_at']?.toString().split('T').first;
    final typeColor = colorForDocType(docType);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        onTap: () => openDocument(context, record),
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
                child:
                    Icon(iconForDocType(docType), color: typeColor, size: 24),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title.toString(),
                        style: theme.textTheme.titleSmall
                            ?.copyWith(fontWeight: FontWeight.bold),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 2),
                    if (doctorName != null)
                      Text(
                        '$doctorName${department != null ? ' • $department' : ''}',
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: Colors.grey[600]),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    if (sourceHospital != null)
                      Text(sourceHospital.toString(),
                          style: theme.textTheme.bodySmall
                              ?.copyWith(color: Colors.grey[600]),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: typeColor.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            docType.replaceAll('_', ' ').toUpperCase(),
                            style: TextStyle(
                                color: typeColor,
                                fontSize: 10,
                                fontWeight: FontWeight.w600),
                          ),
                        ),
                        if (appointmentDate != null) ...[
                          const SizedBox(width: 8),
                          Text(appointmentDate,
                              style: theme.textTheme.bodySmall
                                  ?.copyWith(color: Colors.grey[500])),
                        ] else if (createdAt != null) ...[
                          const SizedBox(width: 8),
                          Text(createdAt,
                              style: theme.textTheme.bodySmall
                                  ?.copyWith(color: Colors.grey[500])),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Icon(
                fileUrl != null ? Icons.open_in_new : Icons.lock,
                size: 18,
                color: fileUrl != null ? typeColor : Colors.grey,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
