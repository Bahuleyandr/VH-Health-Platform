import 'package:flutter/material.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/document_opener.dart';

class PatientRecordExtractionSheet extends StatefulWidget {
  final Map<String, dynamic> record;
  final ValueChanged<Map<String, dynamic>>? onRecordUpdated;

  const PatientRecordExtractionSheet({
    super.key,
    required this.record,
    this.onRecordUpdated,
  });

  @override
  State<PatientRecordExtractionSheet> createState() =>
      _PatientRecordExtractionSheetState();
}

class _PatientRecordExtractionSheetState
    extends State<PatientRecordExtractionSheet> {
  late Map<String, dynamic> _record;
  Map<String, dynamic>? _extraction;
  bool _loading = true;
  bool _processing = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _record = Map<String, dynamic>.from(widget.record);
    final initialExtraction = _record['ai_extraction'];
    if (initialExtraction is Map) {
      _extraction = Map<String, dynamic>.from(initialExtraction);
    }
    _loadExtraction(autoProcess: true);
  }

  int? get _recordId {
    final id = _record['id'];
    if (id is num) return id.toInt();
    return int.tryParse(id?.toString() ?? '');
  }

  Future<void> _loadExtraction({bool autoProcess = false}) async {
    final id = _recordId;
    if (id == null) {
      setState(() {
        _loading = false;
        _error = 'Record ID is missing';
      });
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final response = await ApiClient.get(
        '/appointments/patient/records/$id/extraction',
      );
      if (!mounted) return;
      if (response.isSuccess) {
        _applyExtractionPayload(response.dataAsMap());
        setState(() => _loading = false);
        return;
      }

      if (autoProcess && response.statusCode == 404) {
        setState(() => _loading = false);
        await _processExtraction();
        return;
      }

      setState(() {
        _loading = false;
        _error = response.message ?? 'Extraction is not available yet';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _processExtraction() async {
    final id = _recordId;
    if (id == null) return;

    setState(() {
      _processing = true;
      _error = null;
    });

    try {
      final response = await ApiClient.post(
        '/appointments/patient/records/$id/extraction/process',
      );
      if (!mounted) return;
      if (response.isSuccess) {
        _applyExtractionPayload(response.dataAsMap());
        setState(() => _processing = false);
      } else {
        setState(() {
          _processing = false;
          _error = response.message ?? 'Extraction could not be processed';
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _processing = false;
        _error = e.toString();
      });
    }
  }

  void _applyExtractionPayload(Map<String, dynamic> payload) {
    final record = payload['record'];
    if (record is Map) {
      _record = {..._record, ...Map<String, dynamic>.from(record)};
      widget.onRecordUpdated?.call(_record);
    }

    final extraction = payload['ai_extraction'] ?? _record['ai_extraction'];
    if (extraction is Map) {
      _extraction = Map<String, dynamic>.from(extraction);
    }
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    return Dialog(
      insetPadding: const EdgeInsets.all(20),
      clipBehavior: Clip.antiAlias,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: 1120,
          maxHeight: size.height * 0.9,
        ),
        child: Column(
          children: [
            _DialogHeader(record: _record, onRefresh: _loadExtraction),
            const Divider(height: 1),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final wide = constraints.maxWidth >= 780;
                  final preview = _DocumentPreview(record: _record);
                  final extraction = _ExtractionPanel(
                    extraction: _extraction,
                    loading: _loading,
                    processing: _processing,
                    error: _error,
                    onProcess: _processExtraction,
                    onRefresh: _loadExtraction,
                  );
                  if (wide) {
                    return Row(
                      children: [
                        Expanded(child: preview),
                        const VerticalDivider(width: 1),
                        Expanded(child: extraction),
                      ],
                    );
                  }
                  return ListView(
                    children: [
                      SizedBox(height: 420, child: preview),
                      const Divider(height: 1),
                      SizedBox(height: 520, child: extraction),
                    ],
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DialogHeader extends StatelessWidget {
  final Map<String, dynamic> record;
  final Future<void> Function({bool autoProcess}) onRefresh;

  const _DialogHeader({required this.record, required this.onRefresh});

  @override
  Widget build(BuildContext context) {
    final title = _recordTitle(record);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 12, 14),
      child: Row(
        children: [
          const Icon(Icons.document_scanner_outlined),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  _compactType(record['document_type']) ?? 'Uploaded record',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Refresh extraction',
            onPressed: () => onRefresh(autoProcess: true),
            icon: const Icon(Icons.refresh),
          ),
          IconButton(
            tooltip: 'Close',
            onPressed: () => Navigator.of(context).pop(),
            icon: const Icon(Icons.close),
          ),
        ],
      ),
    );
  }
}

class _DocumentPreview extends StatelessWidget {
  final Map<String, dynamic> record;

  const _DocumentPreview({required this.record});

  @override
  Widget build(BuildContext context) {
    final url = record['file_url']?.toString();
    final mime = record['file_mime']?.toString().toLowerCase() ?? '';
    final fileName = record['file_name']?.toString();
    final isImage =
        mime.startsWith('image/') ||
        _looksLikeImage(fileName) ||
        _looksLikeImage(url);

    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Icon(Icons.image_search_outlined, size: 18),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  fileName ?? 'Uploaded file',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleSmall,
                ),
              ),
              TextButton.icon(
                onPressed: url == null || url.isEmpty
                    ? null
                    : () => DocumentOpener.openFromUrl(
                        context,
                        url,
                        filename: fileName,
                      ),
                icon: const Icon(Icons.open_in_new, size: 16),
                label: const Text('Open'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Expanded(
            child: DecoratedBox(
              decoration: BoxDecoration(
                border: Border.all(
                  color: Theme.of(context).dividerColor.withValues(alpha: 0.7),
                ),
                borderRadius: BorderRadius.circular(8),
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: _buildPreview(context, url, isImage),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPreview(BuildContext context, String? url, bool isImage) {
    if (url == null || url.isEmpty) {
      return const Center(child: Text('File preview unavailable'));
    }
    if (!isImage) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.picture_as_pdf_outlined, size: 56),
            const SizedBox(height: 12),
            Text(
              'Open the file to compare it',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
        ),
      );
    }
    return InteractiveViewer(
      minScale: 0.5,
      maxScale: 4,
      child: Image.network(
        url,
        fit: BoxFit.contain,
        loadingBuilder: (context, child, loadingProgress) {
          if (loadingProgress == null) return child;
          return const Center(child: CircularProgressIndicator());
        },
        errorBuilder: (_, _, _) =>
            const Center(child: Text('Image preview unavailable')),
      ),
    );
  }
}

class _ExtractionPanel extends StatelessWidget {
  final Map<String, dynamic>? extraction;
  final bool loading;
  final bool processing;
  final String? error;
  final Future<void> Function() onProcess;
  final Future<void> Function({bool autoProcess}) onRefresh;

  const _ExtractionPanel({
    required this.extraction,
    required this.loading,
    required this.processing,
    required this.error,
    required this.onProcess,
    required this.onRefresh,
  });

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const Center(child: CircularProgressIndicator());
    }

    final extraction = this.extraction;
    if (extraction == null || error != null) {
      return _EmptyExtractionState(
        message: error ?? 'Extraction is not available yet',
        processing: processing,
        onProcess: onProcess,
      );
    }

    final extractedFields = _asMap(extraction['extracted_fields']);
    final normalized = _asMap(extraction['normalized_sections']);
    final rawText = extraction['raw_text']?.toString().trim();
    final safetyFlags = _asList(extraction['safety_flags']);
    final citations = _asList(extraction['source_citations']);

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _ExtractionStatusHeader(extraction: extraction, processing: processing),
        const SizedBox(height: 10),
        _ReviewBanner(extraction: extraction),
        const SizedBox(height: 12),
        if (safetyFlags.isNotEmpty)
          _SectionCard(
            title: 'Review flags',
            icon: Icons.warning_amber_outlined,
            children: safetyFlags.map(_SafetyFlagTile.new).toList(),
          ),
        _SectionCard(
          title: 'Summary',
          icon: Icons.summarize_outlined,
          children: _valueListWidgets(normalized['summary']),
        ),
        _SectionCard(
          title: 'Patient identifiers',
          icon: Icons.badge_outlined,
          children: _mapWidgets(_asMap(extractedFields['patient_identifiers'])),
        ),
        _SectionCard(
          title: 'Diagnoses',
          icon: Icons.medical_information_outlined,
          children: _valueListWidgets(extractedFields['diagnoses']),
        ),
        _SectionCard(
          title: 'Medications',
          icon: Icons.medication_outlined,
          children: _valueListWidgets(extractedFields['medications']),
        ),
        _SectionCard(
          title: 'Investigations',
          icon: Icons.science_outlined,
          children: _valueListWidgets(extractedFields['investigations']),
        ),
        _SectionCard(
          title: 'Follow up',
          icon: Icons.event_available_outlined,
          children: _valueListWidgets(extractedFields['follow_up']),
        ),
        _SectionCard(
          title: 'Other extracted fields',
          icon: Icons.fact_check_outlined,
          children: [
            ..._mapWidgets(_asMap(extractedFields['billing_fields'])),
            ..._fieldRowList('Dates', extractedFields['dates']),
          ],
        ),
        if (citations.isNotEmpty)
          _SectionCard(
            title: 'Citations',
            icon: Icons.format_quote_outlined,
            children: _valueListWidgets(citations),
          ),
        if (rawText != null && rawText.isNotEmpty)
          _SectionCard(
            title: 'OCR text',
            icon: Icons.text_snippet_outlined,
            children: [SelectableText(rawText)],
          ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: processing ? null : () => onRefresh(autoProcess: true),
          icon: const Icon(Icons.refresh, size: 16),
          label: const Text('Refresh extraction'),
        ),
      ],
    );
  }
}

class _ReviewBanner extends StatelessWidget {
  final Map<String, dynamic> extraction;

  const _ReviewBanner({required this.extraction});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final reviewerDecision = extraction['reviewer_decision']?.toString().trim();
    final reviewed =
        reviewerDecision != null &&
        reviewerDecision.isNotEmpty &&
        reviewerDecision.toLowerCase() != 'pending';

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: reviewed
            ? Colors.teal.withValues(alpha: 0.10)
            : Colors.orange.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: reviewed
              ? Colors.teal.withValues(alpha: 0.35)
              : Colors.orange.withValues(alpha: 0.36),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            reviewed ? Icons.verified_user_outlined : Icons.fact_check_outlined,
            color: reviewed ? Colors.teal : Colors.orange.shade800,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              reviewed
                  ? 'Extraction reviewed: ${_compactType(reviewerDecision)}'
                  : 'AI draft - cross-check every extracted value against the original document before relying on it.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: reviewed ? Colors.teal.shade800 : cs.onSurface,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyExtractionState extends StatelessWidget {
  final String message;
  final bool processing;
  final Future<void> Function() onProcess;

  const _EmptyExtractionState({
    required this.message,
    required this.processing,
    required this.onProcess,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.auto_awesome_outlined, size: 52),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: processing ? null : onProcess,
              icon: processing
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.document_scanner_outlined),
              label: Text(processing ? 'Processing' : 'Process extraction'),
            ),
          ],
        ),
      ),
    );
  }
}

class _ExtractionStatusHeader extends StatelessWidget {
  final Map<String, dynamic> extraction;
  final bool processing;

  const _ExtractionStatusHeader({
    required this.extraction,
    required this.processing,
  });

  @override
  Widget build(BuildContext context) {
    final status = extraction['extraction_status']?.toString() ?? 'pending';
    final type = _compactType(extraction['document_type']) ?? 'Document';
    final confidence = extraction['confidence'];
    final ocr = extraction['ocr_status']?.toString();
    final provider = extraction['provider'] ?? extraction['ocr_provider'];

    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        _Chip(label: status, icon: Icons.task_alt_outlined),
        _Chip(label: type, icon: Icons.description_outlined),
        if (confidence != null)
          _Chip(label: '$confidence% confidence', icon: Icons.speed_outlined),
        if (ocr != null) _Chip(label: 'OCR $ocr', icon: Icons.text_fields),
        if (provider != null)
          _Chip(label: provider.toString(), icon: Icons.memory_outlined),
        if (processing)
          const _Chip(label: 'Processing', icon: Icons.hourglass_top),
      ],
    );
  }
}

class _Chip extends StatelessWidget {
  final String label;
  final IconData icon;

  const _Chip({required this.label, required this.icon});

  @override
  Widget build(BuildContext context) {
    return Chip(
      avatar: Icon(icon, size: 16),
      label: Text(label),
      visualDensity: VisualDensity.compact,
    );
  }
}

class _SectionCard extends StatelessWidget {
  final String title;
  final IconData icon;
  final List<Widget> children;

  const _SectionCard({
    required this.title,
    required this.icon,
    required this.children,
  });

  @override
  Widget build(BuildContext context) {
    final visibleChildren = children.isEmpty
        ? [
            Text(
              'No extracted values',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ]
        : children;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 18),
                const SizedBox(width: 8),
                Text(
                  title,
                  style: Theme.of(
                    context,
                  ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
                ),
              ],
            ),
            const SizedBox(height: 10),
            ...visibleChildren,
          ],
        ),
      ),
    );
  }
}

class _SafetyFlagTile extends StatelessWidget {
  final dynamic flag;

  const _SafetyFlagTile(this.flag);

  @override
  Widget build(BuildContext context) {
    final map = flag is Map ? Map<String, dynamic>.from(flag as Map) : {};
    final severity = map['severity']?.toString() ?? 'review';
    final message = map['message']?.toString() ?? _stringify(flag);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            severity.toUpperCase(),
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              fontWeight: FontWeight.w800,
              color: Theme.of(context).colorScheme.error,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(child: Text(message)),
        ],
      ),
    );
  }
}

List<Widget> _mapWidgets(Map<String, dynamic> map) {
  return map.entries
      .expand((entry) => _fieldRowList(entry.key, entry.value))
      .toList();
}

List<Widget> _fieldRowList(String label, dynamic value) {
  final values = _asList(value);
  if (values.isEmpty && !_hasTextValue(value)) return [];
  if (values.isEmpty) {
    return [_KeyValueRow(label: label, value: _stringify(value))];
  }
  return [_KeyValueRow(label: label, value: values.map(_stringify).join('\n'))];
}

List<Widget> _valueListWidgets(dynamic value) {
  final values = _asList(value);
  if (values.isEmpty && !_hasTextValue(value)) return [];
  if (values.isEmpty) {
    return [
      Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(_stringify(value)),
      ),
    ];
  }
  return values
      .map(
        (item) => Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('- '),
              Expanded(child: SelectableText(_stringify(item))),
            ],
          ),
        ),
      )
      .toList();
}

class _KeyValueRow extends StatelessWidget {
  final String label;
  final String value;

  const _KeyValueRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              _compactType(label) ?? label,
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w700),
            ),
          ),
          Expanded(child: SelectableText(value)),
        ],
      ),
    );
  }
}

Map<String, dynamic> _asMap(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return {};
}

List<dynamic> _asList(dynamic value) {
  if (value is List) return value.where((item) => _hasTextValue(item)).toList();
  return [];
}

bool _hasTextValue(dynamic value) {
  if (value == null) return false;
  if (value is String) return value.trim().isNotEmpty;
  if (value is Iterable) return value.any(_hasTextValue);
  if (value is Map) return value.values.any(_hasTextValue);
  return true;
}

String _stringify(dynamic value) {
  if (value == null) return '';
  if (value is String) return value;
  if (value is Map) {
    if (value['text'] != null) return value['text'].toString();
    if (value['label'] != null) return value['label'].toString();
    if (value['message'] != null) return value['message'].toString();
    return value.entries
        .where((entry) => _hasTextValue(entry.value))
        .map(
          (entry) =>
              '${_compactType(entry.key) ?? entry.key}: ${_stringify(entry.value)}',
        )
        .join(', ');
  }
  if (value is Iterable) return value.map(_stringify).join(', ');
  return value.toString();
}

String _recordTitle(Map<String, dynamic> record) {
  final title = record['title']?.toString().trim();
  if (title != null && title.isNotEmpty) return title;
  final extraction = record['ai_extraction'];
  if (extraction is Map) {
    final type = _compactType(extraction['document_type']);
    if (type != null) return type;
  }
  return _compactType(record['document_type']) ?? 'Uploaded record';
}

String? _compactType(dynamic value) {
  final raw = value?.toString().trim();
  if (raw == null || raw.isEmpty) return null;
  return raw
      .split('_')
      .where((part) => part.isNotEmpty)
      .map((part) => part[0].toUpperCase() + part.substring(1))
      .join(' ');
}

bool _looksLikeImage(String? value) {
  final text = value?.toLowerCase() ?? '';
  return text.endsWith('.jpg') ||
      text.endsWith('.jpeg') ||
      text.endsWith('.png') ||
      text.endsWith('.webp') ||
      text.endsWith('.bmp') ||
      text.endsWith('.tif') ||
      text.endsWith('.tiff');
}
