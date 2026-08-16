import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/widgets/logout_action.dart';

import 'package:vhhealth_staff/l10n/app_strings.dart';

class DischargeHubListScreen extends StatefulWidget {
  const DischargeHubListScreen({super.key});

  @override
  State<DischargeHubListScreen> createState() => _DischargeHubListScreenState();
}

class _DischargeHubListScreenState extends State<DischargeHubListScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _items = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await MedicalApiService.listDischargeHubs();
      final raw = data['admissions'];
      final items = raw is List
          ? raw
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .toList()
          : <Map<String, dynamic>>[];
      if (!mounted) return;
      setState(() => _items = items);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Map<String, dynamic> _map(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    return <String, dynamic>{};
  }

  String _patientName(Map<String, dynamic> hub) {
    final admission = _map(hub['admission']);
    final name = (admission['patient_name'] ?? '').toString().trim();
    return name.isNotEmpty ? name : 'Patient';
  }

  void _openHub(Map<String, dynamic> hub) {
    final admission = _map(hub['admission']);
    final id = int.tryParse('${admission['id'] ?? ''}');
    if (id == null) return;
    final name = Uri.encodeQueryComponent(_patientName(hub));
    context.push('/emr/discharge-hub/$id?name=$name').then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: const AppText('bed_board.discharge_hub'),
        actions: [
          IconButton(
            tooltip: AppStrings.of(context).lookup('action.refresh'),
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? _buildError(theme)
          : RefreshIndicator(
              onRefresh: _load,
              child: _items.isEmpty
                  ? _buildEmpty(theme)
                  : ListView.separated(
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                      itemCount: _items.length,
                      separatorBuilder: (context, index) =>
                          const SizedBox(height: 12),
                      itemBuilder: (context, index) => _DischargeHubCard(
                        hub: _items[index],
                        onTap: _openHub,
                      ),
                    ),
            ),
    );
  }

  Widget _buildError(ThemeData theme) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off, size: 48, color: theme.colorScheme.error),
            const SizedBox(height: 12),
            Text(_error!, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _load,
              icon: const Icon(Icons.refresh),
              label: const AppText('action.retry'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEmpty(ThemeData theme) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        SizedBox(height: MediaQuery.sizeOf(context).height * 0.2),
        Icon(
          Icons.rule_folder_outlined,
          size: 56,
          color: theme.colorScheme.outline,
        ),
        const SizedBox(height: 12),
        AppText(
          's4.lib.discharge_hub_list.no_active_discharge_work',
          textAlign: TextAlign.center,
          style: theme.textTheme.titleMedium,
        ),
        const SizedBox(height: 6),
        AppText(
          's4.lib.discharge_hub_list.patients_appear_here_after_discharge_is_initiate',
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

class _DischargeHubCard extends StatelessWidget {
  final Map<String, dynamic> hub;
  final ValueChanged<Map<String, dynamic>> onTap;

  const _DischargeHubCard({required this.hub, required this.onTap});

  Map<String, dynamic> _map(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    return <String, dynamic>{};
  }

  List<Map<String, dynamic>> _list(dynamic value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    final admission = _map(hub['admission']);
    final readiness = _map(hub['readiness']);
    final summary = _map(hub['summary']);
    final counts = _map(hub['work_item_counts']);
    final blockers = _list(readiness['blockers']);

    final name = (admission['patient_name'] ?? 'Patient').toString();
    final admissionId = admission['id'];
    final ward = (admission['ward'] ?? admission['bed_ward_name'] ?? '')
        .toString();
    final bed = (admission['bed_number'] ?? '').toString();
    final hospitalNumber =
        (admission['patient_hospital_number'] ??
                admission['hospital_number'] ??
                '')
            .toString()
            .trim();
    final ready = readiness['ready'] == true;
    final signed = summary['is_signed'] == true;
    final pending = int.tryParse('${counts['pending'] ?? 0}') ?? 0;
    final total = int.tryParse('${counts['total'] ?? 0}') ?? 0;

    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => onTap(hub),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  CircleAvatar(
                    backgroundColor: ready
                        ? Colors.green.withValues(alpha: 0.12)
                        : Colors.orange.withValues(alpha: 0.12),
                    child: Icon(
                      ready ? Icons.verified : Icons.pending_actions,
                      color: ready ? Colors.green : Colors.orange,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(name, style: theme.textTheme.titleMedium),
                        const SizedBox(height: 4),
                        Text(
                          [
                            if (hospitalNumber.isNotEmpty)
                              s.format('s4.dynamic.discharge_hub.hospital_id', {
                                'id': hospitalNumber,
                              }),
                            if (ward.isNotEmpty) ward,
                            if (bed.isNotEmpty)
                              s.format('s4.dynamic.discharge_hub.bed', {
                                'bed': bed,
                              }),
                            if (admissionId != null)
                              s.format(
                                's4.dynamic.discharge_hub.admission_id',
                                {'id': admissionId},
                              ),
                          ].join(' - '),
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const Icon(Icons.chevron_right),
                ],
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  _chip(
                    ready
                        ? s.lookup('s4.lib.discharge_hub_list.ready')
                        : s.lookup('s4.lib.discharge_hub_list.blocked'),
                    ready ? Colors.green : Colors.orange,
                    ready ? Icons.verified : Icons.rule,
                  ),
                  _chip(
                    signed
                        ? s.lookup('s4.lib.discharge_hub_list.summary_signed')
                        : s.lookup(
                            's4.lib.discharge_hub_list.doctor_sign_pending',
                          ),
                    signed ? Colors.green : Colors.blue,
                    Icons.draw,
                  ),
                  _chip(
                    s.format('s4.dynamic.discharge_hub_list.tasks_pending', {
                      'pending': pending,
                      'total': total,
                    }),
                    pending == 0 ? Colors.green : Colors.deepOrange,
                    Icons.groups,
                  ),
                ],
              ),
              if (blockers.isNotEmpty) ...[
                const SizedBox(height: 12),
                Text(
                  blockers
                      .take(2)
                      .map(
                        (blocker) =>
                            (blocker['message'] ?? blocker['type']).toString(),
                      )
                      .join('\n'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _chip(String label, Color color, IconData icon) {
    return Chip(
      avatar: Icon(icon, size: 16, color: color),
      label: Text(label),
      side: BorderSide(color: color.withValues(alpha: 0.35)),
      backgroundColor: color.withValues(alpha: 0.08),
      visualDensity: VisualDensity.compact,
    );
  }
}
