import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../core/platform_info.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/recent_patients_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';
import '../widgets/patient_health_journey_panel.dart';

enum _TimelineView { healthJourney, eventLog }

class _TimelineAction {
  final IconData icon;
  final String label;
  final String route;

  const _TimelineAction({
    required this.icon,
    required this.label,
    required this.route,
  });
}

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
  _TimelineView _view = _TimelineView.healthJourney;

  static const _eventTypes = [
    'all',
    'admission',
    'vitals',
    'note',
    'order',
    'drug_chart',
    'medication',
    'investigation',
    'referral',
    'discharge',
  ];

  @override
  void initState() {
    super.initState();
    _loadTimeline();
    // Record the patient in the local "recently viewed" cache so the
    // dashboard's recent-patients tile can offer one-tap return. Fire
    // and forget — failures here shouldn't block the timeline load.
    RecentPatientsService.add(widget.patientUid, widget.patientName);
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
      final list = data['events'] ?? data['timeline'] ?? data['data'];
      setState(() {
        _events = list is List
            ? list.map((e) => Map<String, dynamic>.from(e as Map)).toList()
            : [];
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  List<Map<String, dynamic>> get _filteredEvents {
    if (_filterType == null || _filterType == 'all') return _events;
    return _events
        .where((e) => _normalizedEventType(e['event_type']) == _filterType)
        .toList();
  }

  // ── Event type visual config ──

  String _normalizedEventType(dynamic type) {
    final value = (type ?? '').toString().trim().toLowerCase();
    switch (value) {
      case 'clinical_note':
      case 'doctor_note':
      case 'nursing_note':
      case 'op_consultation':
      case 'consultation_note':
      case 'soap':
      case 'progress':
        return 'note';
      case 'clinical_order':
        return 'order';
      case 'drug_chart':
      case 'medication_order':
        return 'drug_chart';
      case 'e_prescription':
      case 'prescription':
      case 'op_prescription':
        return 'medication';
      case 'referral':
      case 'ward_referral':
      case 'cross_referral':
        return 'referral';
      default:
        return value.isEmpty ? 'event' : value;
    }
  }

  IconData _eventIcon(String? type) {
    switch (_normalizedEventType(type)) {
      case 'admission':
        return Icons.local_hospital;
      case 'vitals':
        return Icons.monitor_heart;
      case 'note':
        return Icons.note_alt;
      case 'order':
        return Icons.receipt_long;
      case 'drug_chart':
        return Icons.medication_liquid_outlined;
      case 'medication':
        return Icons.medication;
      case 'investigation':
        return Icons.biotech;
      case 'referral':
        return Icons.call_split_outlined;
      case 'discharge':
        return Icons.exit_to_app;
      default:
        return Icons.circle;
    }
  }

  Color _eventColor(String? type) {
    switch (_normalizedEventType(type)) {
      case 'admission':
        return AppTheme.primaryBlue;
      case 'vitals':
        return AppTheme.primaryTeal;
      case 'note':
        return const Color(0xFF7B1FA2); // Purple
      case 'order':
        return AppTheme.accentCyan;
      case 'drug_chart':
        return AppTheme.warningOnSurface;
      case 'medication':
        return const Color(0xFFE65100); // Deep orange
      case 'investigation':
        return const Color(0xFF558B2F); // Light green dark
      case 'referral':
        return AppTheme.warningOnSurface;
      case 'discharge':
        return AppTheme.successGreen;
      default:
        return AppTheme.textSecondary;
    }
  }

  String _eventTitle(Map<String, dynamic> event) {
    final type = _normalizedEventType(event['event_type']);
    final rawTitle = (event['title'] ?? '').toString().trim();
    if (rawTitle.isNotEmpty) return rawTitle;

    final payload = _eventPayload(event);
    if (type == 'note') {
      final noteType = (payload['note_type'] ?? event['sub_type'] ?? 'Note')
          .toString()
          .trim();
      final author = (payload['author_name'] ?? payload['author_uid'] ?? '')
          .toString()
          .trim();
      return author.isEmpty
          ? '${_formatKey(noteType)} note'
          : '${_formatKey(noteType)} note - $author';
    }
    if (type == 'drug_chart') {
      final details = _asMap(payload['details']);
      final med =
          (details['medication_name'] ??
                  details['name'] ??
                  details['medication'] ??
                  payload['medication_name'] ??
                  'Medication order')
              .toString()
              .trim();
      return 'Drug chart - $med';
    }
    if (type == 'referral') {
      final dept =
          (payload['referred_to_department'] ??
                  payload['department'] ??
                  'specialist')
              .toString()
              .trim();
      return 'Referral - $dept';
    }
    return AppStrings.of(context).timelineEventTitle(type);
  }

  String _eventDescription(Map<String, dynamic> event) {
    final explicit = (event['description'] ?? '').toString().trim();
    if (explicit.isNotEmpty) return explicit;
    final summary = (event['summary'] ?? '').toString().trim();
    if (summary.isNotEmpty) return summary;

    final payload = _eventPayload(event);
    final content = payload['content'];
    if (content is Map) {
      final parts =
          [
                content['chief_complaint'],
                content['chief_complaints'],
                content['history'],
                content['examination'],
                content['diagnosis'],
                content['subjective'],
                content['objective'],
                content['assessment'],
                content['plan'],
                content['notes'],
              ]
              .whereType<Object>()
              .map((value) => value.toString().trim())
              .where((value) => value.isNotEmpty)
              .toList();
      if (parts.isNotEmpty) return parts.join(' ');
    }
    if (content != null && content.toString().trim().isNotEmpty) {
      return content.toString().trim();
    }
    return '';
  }

  Map<String, dynamic> _eventPayload(Map<String, dynamic> event) {
    return _asMap(event['payload']);
  }

  Map<String, dynamic> _asMap(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return value.cast<String, dynamic>();
    return const {};
  }

  Map<String, dynamic> _eventDetails(Map<String, dynamic> event) {
    final details = _asMap(event['details']);
    if (details.isNotEmpty) return details;
    final payload = _eventPayload(event);
    if (payload.isNotEmpty) return payload;
    return event;
  }

  String _displayValue(dynamic value) {
    if (value == null) return '-';
    if (value is Map) {
      return value.entries
          .map((entry) => '${_formatKey(entry.key.toString())}: ${entry.value}')
          .join('\n');
    }
    if (value is Iterable) {
      return value.map((item) => item.toString()).join(', ');
    }
    return value.toString();
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
        final title = _eventTitle(event);
        final description = _eventDescription(event);
        final details = _eventDetails(event);
        return Container(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(ctx).size.height * 0.75,
          ),
          decoration: BoxDecoration(
            color: AppTheme.cardSurface,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
            border: Border(top: BorderSide(color: AppTheme.divider)),
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
                            title,
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
                if (description.isNotEmpty) ...[
                  Text(
                    description,
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontSize: 14,
                      height: 1.5,
                    ),
                  ),
                  const SizedBox(height: 12),
                ],
                if (event['author'] != null || details['author_name'] != null)
                  _detailRow(
                    AppStrings.of(context).timelineByPrefix,
                    (event['author'] ?? details['author_name']).toString(),
                  ),
                if (event['department'] != null ||
                    details['department'] != null)
                  _detailRow(
                    AppStrings.of(context).timelineDepartment,
                    (event['department'] ?? details['department']).toString(),
                  ),
                if (details.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  Text(
                    AppStrings.of(context).timelineDetails,
                    style: const TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 14,
                      color: AppTheme.primaryBlue,
                    ),
                  ),
                  const SizedBox(height: 6),
                  ...details.entries.map(
                    (e) => _detailRow(
                      _formatKey(e.key.toString()),
                      _displayValue(e.value),
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
              style: TextStyle(color: AppTheme.textSecondary, fontSize: 13),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontWeight: FontWeight.w500,
                fontSize: 13,
              ),
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

  String _localizedFilterLabel(BuildContext context, String type) {
    final s = AppStrings.of(context);
    switch (type) {
      case 'all':
        return s.timelineFilterAll;
      case 'admission':
        return s.timelineFilterAdmission;
      case 'vitals':
        return s.timelineFilterVitals;
      case 'note':
        return s.timelineFilterNote;
      case 'order':
        return s.timelineFilterOrder;
      case 'drug_chart':
        return 'Drug chart';
      case 'medication':
        return s.timelineFilterMedication;
      case 'investigation':
        return s.timelineFilterInvestigation;
      case 'referral':
        return 'Referrals';
      case 'discharge':
        return s.timelineFilterDischarge;
      default:
        return '${type[0].toUpperCase()}${type.substring(1)}';
    }
  }

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
            label: Text(_localizedFilterLabel(ctx, type)),
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

  Widget _buildViewToggle() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: SegmentedButton<_TimelineView>(
        segments: const [
          ButtonSegment<_TimelineView>(
            value: _TimelineView.healthJourney,
            icon: Icon(Icons.insights_outlined, size: 18),
            label: Text('Health journey'),
          ),
          ButtonSegment<_TimelineView>(
            value: _TimelineView.eventLog,
            icon: Icon(Icons.list_alt_outlined, size: 18),
            label: Text('Event log'),
          ),
        ],
        selected: {_view},
        onSelectionChanged: (selection) {
          setState(() => _view = selection.first);
        },
        style: ButtonStyle(
          visualDensity: VisualDensity.compact,
          foregroundColor: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.selected)
                ? AppTheme.primaryBlue
                : AppTheme.textSecondary,
          ),
        ),
      ),
    );
  }

  String _patientRouteQuery() {
    final params = <String>[
      if ((widget.patientName ?? '').trim().isNotEmpty)
        'name=${Uri.encodeQueryComponent(widget.patientName!.trim())}',
    ];
    return params.isEmpty ? '' : '?${params.join('&')}';
  }

  Widget _buildClinicalActionStrip() {
    if (appDeviceModeForContext(context) == AppDeviceMode.mobile) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: AppTheme.primaryBlue.withValues(alpha: 0.10),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: AppTheme.primaryBlue.withValues(alpha: 0.25),
            ),
          ),
          child: const Row(
            children: [
              Icon(Icons.visibility_outlined, color: AppTheme.primaryBlue),
              SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Read-only on phone. Clinical entries must be completed on Staff Desktop.',
                ),
              ),
            ],
          ),
        ),
      );
    }

    final query = _patientRouteQuery();
    final actions = [
      _TimelineAction(
        icon: Icons.note_add_outlined,
        label: 'Add note',
        route: '/emr/notes/${widget.patientUid}$query',
      ),
      _TimelineAction(
        icon: Icons.receipt_long_outlined,
        label: 'Orders',
        route: '/emr/orders/${widget.patientUid}$query',
      ),
      _TimelineAction(
        icon: Icons.monitor_heart_outlined,
        label: 'Vitals',
        route: '/emr/vitals/${widget.patientUid}$query',
      ),
      _TimelineAction(
        icon: Icons.biotech_outlined,
        label: 'Investigations',
        route:
            '/investigations?patient_uid=${Uri.encodeQueryComponent(widget.patientUid)}',
      ),
    ];

    return SizedBox(
      height: 42,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        itemCount: actions.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final action = actions[index];
          return ActionChip(
            avatar: Icon(action.icon, size: 18, color: AppTheme.primaryBlue),
            label: Text(action.label),
            onPressed: () => context.push(action.route),
            backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.08),
            side: BorderSide(
              color: AppTheme.primaryBlue.withValues(alpha: 0.22),
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
    final normalizedType = _normalizedEventType(type);
    final description = _eventDescription(event);

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
                                normalizedType.toUpperCase(),
                                style: TextStyle(
                                  color: color,
                                  fontSize: 10,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            const Spacer(),
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
                          _eventTitle(event),
                          style: TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 14,
                            color: AppTheme.textPrimary,
                          ),
                        ),
                        if (description.isNotEmpty) ...[
                          const SizedBox(height: 4),
                          Text(
                            description,
                            style: TextStyle(
                              fontSize: 13,
                              color: AppTheme.textSecondary,
                            ),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                        if (event['author'] != null ||
                            _eventPayload(event)['author_name'] != null) ...[
                          const SizedBox(height: 6),
                          Row(
                            children: [
                              Icon(
                                Icons.person_outline,
                                size: 13,
                                color: AppTheme.textSecondary,
                              ),
                              const SizedBox(width: 4),
                              Text(
                                (event['author'] ??
                                        _eventPayload(event)['author_name'])
                                    .toString(),
                                style: TextStyle(
                                  fontSize: 11,
                                  color: AppTheme.textSecondary,
                                ),
                              ),
                            ],
                          ),
                        ],
                        if (normalizedType == 'drug_chart') ...[
                          const SizedBox(height: 6),
                          Text(
                            'Current IP medication order',
                            style: TextStyle(
                              fontSize: 11,
                              color: AppTheme.warningOnSurface,
                              fontWeight: FontWeight.w700,
                            ),
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
    final s = AppStrings.of(context);
    final filtered = _filteredEvents;

    return StaffScaffold(
      title: widget.patientName != null
          ? s.timelineTitleWithName(widget.patientName!)
          : s.timelineTitle,
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
                    child: Text(s.timelineRetry),
                  ),
                ],
              ),
            )
          : Column(
              children: [
                const SizedBox(height: 8),
                _buildClinicalActionStrip(),
                const SizedBox(height: 4),
                _buildViewToggle(),
                const SizedBox(height: 8),
                if (_view == _TimelineView.eventLog) ...[
                  _buildFilterChips(),
                  const SizedBox(height: 8),
                ],
                Expanded(
                  child: _view == _TimelineView.healthJourney
                      ? RefreshIndicator(
                          onRefresh: _loadTimeline,
                          child: PatientHealthJourneyPanel(
                            events: _events,
                            onEventTap: _showEventDetail,
                          ),
                        )
                      : filtered.isEmpty
                      ? Center(
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(
                                Icons.timeline,
                                size: 64,
                                color: AppTheme.divider,
                              ),
                              const SizedBox(height: 12),
                              Text(
                                s.timelineNoEvents,
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
