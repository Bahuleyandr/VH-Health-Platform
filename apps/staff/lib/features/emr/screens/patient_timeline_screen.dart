import 'package:flutter/material.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

/// EMR Patient Timeline — chronological list of all clinical events for a patient.
class PatientTimelineScreen extends StatefulWidget {
  final String patientUid;
  final String? patientName;

  const PatientTimelineScreen({
    super.key,
    required this.patientUid,
    this.patientName,
  });

  @override
  State<PatientTimelineScreen> createState() => _PatientTimelineScreenState();
}

class _PatientTimelineScreenState extends State<PatientTimelineScreen> {
  List<Map<String, dynamic>> _events = [];
  bool _loading = true;
  String? _error;
  String? _filterType;

  static const _eventTypes = [
    'all',
    'admission',
    'vitals',
    'note',
    'order',
    'medication',
    'investigation',
    'discharge',
  ];

  @override
  void initState() {
    super.initState();
    _loadTimeline();
  }

  Future<void> _loadTimeline() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await MedicalApiService.getPatientTimeline(
        widget.patientUid,
      );
      final list = data['events'] ?? data['timeline'];
      setState(() {
        _events = list is List
            ? list.map((e) => Map<String, dynamic>.from(e as Map)).toList()
            : [];
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  List<Map<String, dynamic>> get _filteredEvents {
    if (_filterType == null || _filterType == 'all') return _events;
    return _events
        .where(
          (e) => (e['event_type'] as String?)?.toLowerCase() == _filterType,
        )
        .toList();
  }

  // ── Event type visual config ──

  IconData _eventIcon(String? type) {
    switch (type?.toLowerCase()) {
      case 'admission':
        return Icons.local_hospital;
      case 'vitals':
        return Icons.monitor_heart;
      case 'note':
        return Icons.note_alt;
      case 'order':
        return Icons.receipt_long;
      case 'medication':
        return Icons.medication;
      case 'investigation':
        return Icons.biotech;
      case 'discharge':
        return Icons.exit_to_app;
      default:
        return Icons.circle;
    }
  }

  Color _eventColor(String? type) {
    switch (type?.toLowerCase()) {
      case 'admission':
        return AppTheme.primaryBlue;
      case 'vitals':
        return AppTheme.primaryTeal;
      case 'note':
        return const Color(0xFF7B1FA2); // Purple
      case 'order':
        return AppTheme.accentCyan;
      case 'medication':
        return const Color(0xFFE65100); // Deep orange
      case 'investigation':
        return const Color(0xFF558B2F); // Light green dark
      case 'discharge':
        return AppTheme.successGreen;
      default:
        return AppTheme.textSecondary;
    }
  }

  String _formatTimestamp(String? ts) {
    if (ts == null) return '-';
    try {
      final dt = DateTime.parse(ts);
      final now = DateTime.now();
      final diff = now.difference(dt);
      if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
      if (diff.inHours < 24) return '${diff.inHours}h ago';
      return '${dt.day}/${dt.month}/${dt.year} ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return ts;
    }
  }

  // ── Event Detail ──

  void _showEventDetail(Map<String, dynamic> event) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) {
        final type = event['event_type'] as String?;
        final color = _eventColor(type);
        return Container(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(ctx).size.height * 0.75,
          ),
          decoration: const BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
          ),
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Center(
                  child: Container(
                    width: 40,
                    height: 4,
                    decoration: BoxDecoration(
                      color: AppTheme.divider,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    CircleAvatar(
                      backgroundColor: color.withValues(alpha: 0.15),
                      child: Icon(_eventIcon(type), color: color, size: 22),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            event['title'] as String? ??
                                '${(type ?? 'event').toUpperCase()} Event',
                            style: TextStyle(
                              fontSize: 18,
                              fontWeight: FontWeight.w600,
                              color: AppTheme.textPrimary,
                            ),
                          ),
                          Text(
                            _formatTimestamp(event['timestamp'] as String?),
                            style: TextStyle(
                              color: AppTheme.textSecondary,
                              fontSize: 13,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const Divider(height: 24),
                if (event['description'] != null) ...[
                  Text(
                    event['description'] as String,
                    style: const TextStyle(fontSize: 14, height: 1.5),
                  ),
                  const SizedBox(height: 12),
                ],
                if (event['author'] != null)
                  _detailRow('By', event['author'] as String),
                if (event['department'] != null)
                  _detailRow('Department', event['department'] as String),
                if (event['details'] is Map) ...[
                  const SizedBox(height: 12),
                  const Text(
                    'Details',
                    style: TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 14,
                      color: AppTheme.primaryBlue,
                    ),
                  ),
                  const SizedBox(height: 6),
                  ...(event['details'] as Map).entries.map(
                    (e) => _detailRow(
                      _formatKey(e.key.toString()),
                      e.value?.toString() ?? '-',
                    ),
                  ),
                ],
                const SizedBox(height: 20),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _detailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              label,
              style: TextStyle(
                color: AppTheme.textSecondary,
                fontSize: 13,
              ),
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

  String _formatKey(String key) {
    return key
        .replaceAll('_', ' ')
        .split(' ')
        .map((w) => w.isNotEmpty ? '${w[0].toUpperCase()}${w.substring(1)}' : w)
        .join(' ');
  }

  // ── Filter Chips ──

  Widget _buildFilterChips() {
    return SizedBox(
      height: 44,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        itemCount: _eventTypes.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (ctx, i) {
          final type = _eventTypes[i];
          final selected =
              (_filterType == null && type == 'all') || _filterType == type;
          return FilterChip(
            label: Text(
              type == 'all'
                  ? 'All'
                  : '${type[0].toUpperCase()}${type.substring(1)}',
            ),
            selected: selected,
            onSelected: (_) {
              setState(() => _filterType = type == 'all' ? null : type);
            },
            selectedColor: AppTheme.primaryBlue.withValues(alpha: 0.15),
            checkmarkColor: AppTheme.primaryBlue,
            labelStyle: TextStyle(
              color: selected ? AppTheme.primaryBlue : AppTheme.textSecondary,
              fontSize: 12,
              fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
            ),
          );
        },
      ),
    );
  }

  // ── Timeline Item ──

  Widget _buildTimelineItem(Map<String, dynamic> event, bool isLast) {
    final type = event['event_type'] as String?;
    final color = _eventColor(type);

    return InkWell(
      onTap: () => _showEventDetail(event),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Timeline line + dot
            SizedBox(
              width: 48,
              child: Column(
                children: [
                  Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: 0.15),
                      shape: BoxShape.circle,
                    ),
                    child: Icon(_eventIcon(type), color: color, size: 16),
                  ),
                  if (!isLast)
                    Expanded(
                      child: Container(width: 2, color: AppTheme.divider),
                    ),
                ],
              ),
            ),
            // Event content
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(bottom: 16, left: 4, right: 12),
                child: Card(
                  margin: EdgeInsets.zero,
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: color.withValues(alpha: 0.12),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text(
                                (type ?? 'event').toUpperCase(),
                                style: TextStyle(
                                  color: color,
                                  fontSize: 10,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            Spacer(),
                            Text(
                              _formatTimestamp(event['timestamp'] as String?),
                              style: TextStyle(
                                fontSize: 11,
                                color: AppTheme.textSecondary,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Text(
                          event['title'] as String? ?? 'Clinical Event',
                          style: const TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 14,
                          ),
                        ),
                        if (event['description'] != null) ...[
                          SizedBox(height: 4),
                          Text(
                            event['description'] as String,
                            style: TextStyle(
                              fontSize: 13,
                              color: AppTheme.textSecondary,
                            ),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                        if (event['author'] != null) ...[
                          SizedBox(height: 6),
                          Row(
                            children: [
                              Icon(
                                Icons.person_outline,
                                size: 13,
                                color: AppTheme.textSecondary,
                              ),
                              SizedBox(width: 4),
                              Text(
                                event['author'] as String,
                                style: TextStyle(
                                  fontSize: 11,
                                  color: AppTheme.textSecondary,
                                ),
                              ),
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _filteredEvents;

    return StaffScaffold(
      title: widget.patientName != null
          ? 'Timeline - ${widget.patientName}'
          : 'Patient Timeline',
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.error_outline,
                    size: 48,
                    color: AppTheme.errorRed,
                  ),
                  const SizedBox(height: 12),
                  Text(_error!, textAlign: TextAlign.center),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: _loadTimeline,
                    child: const Text('Retry'),
                  ),
                ],
              ),
            )
          : Column(
              children: [
                const SizedBox(height: 8),
                _buildFilterChips(),
                SizedBox(height: 8),
                Expanded(
                  child: filtered.isEmpty
                      ? Center(
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(
                                Icons.timeline,
                                size: 64,
                                color: AppTheme.divider,
                              ),
                              SizedBox(height: 12),
                              Text(
                                'No events found',
                                style: TextStyle(color: AppTheme.textSecondary),
                              ),
                            ],
                          ),
                        )
                      : RefreshIndicator(
                          onRefresh: _loadTimeline,
                          child: ListView.builder(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 4,
                            ),
                            itemCount: filtered.length,
                            itemBuilder: (ctx, i) => _buildTimelineItem(
                              filtered[i],
                              i == filtered.length - 1,
                            ),
                          ),
                        ),
                ),
              ],
            ),
    );
  }
}
