import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';

class DrugChartScreen extends StatefulWidget {
  final int admissionId;
  final String? patientName;

  const DrugChartScreen({
    super.key,
    required this.admissionId,
    this.patientName,
  });

  @override
  State<DrugChartScreen> createState() => _DrugChartScreenState();
}

class _DrugChartScreenState extends State<DrugChartScreen> {
  Map<String, dynamic>? _chart;
  bool _loading = true;
  String? _error;

  Map<String, dynamic> get _admission =>
      (_chart?['admission'] as Map?)?.cast<String, dynamic>() ?? const {};

  List<Map<String, dynamic>> get _orders =>
      (_chart?['medication_orders'] as List? ?? const [])
          .whereType<Map>()
          .map((row) => row.cast<String, dynamic>())
          .toList();

  Map<String, dynamic> get _permissions =>
      (_chart?['permissions'] as Map?)?.cast<String, dynamic>() ?? const {};

  bool get _canPrescribe => _permissions['can_prescribe'] == true;

  bool get _canAdminister => _permissions['can_administer'] == true;

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
      final chart = await MedicalApiService.getInpatientDrugChart(
        widget.admissionId,
      );
      if (!mounted) return;
      setState(() => _chart = chart);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openNewMedicationSheet() async {
    final created = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: AppTheme.surfaceWhite,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) => _NewMedicationSheet(admission: _admission),
    );
    if (created == true && mounted) _load();
  }

  Future<void> _stopOrder(Map<String, dynamic> order) async {
    final reasonCtrl = TextEditingController();
    final reason = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Stop medication'),
        content: TextField(
          controller: reasonCtrl,
          autofocus: true,
          maxLines: 3,
          decoration: const InputDecoration(
            labelText: 'Reason',
            hintText: 'e.g. course completed, adverse effect, changed plan',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              final value = reasonCtrl.text.trim();
              if (value.isEmpty) return;
              Navigator.of(context).pop(value);
            },
            child: const Text('Stop'),
          ),
        ],
      ),
    );
    reasonCtrl.dispose();
    if (reason == null || reason.isEmpty) return;

    try {
      await MedicalApiService.discontinueClinicalOrder(
        orderId: _asInt(order['id']) ?? 0,
        reason: reason,
      );
      if (mounted) _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: AppTheme.errorRed,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Drug Chart',
      floatingActionButton: _chart != null && _canPrescribe
          ? FloatingActionButton.extended(
              onPressed: _openNewMedicationSheet,
              icon: const Icon(Icons.add),
              label: const Text('New drug'),
            )
          : null,
      body: RefreshIndicator(onRefresh: _load, child: _buildBody()),
    );
  }

  Widget _buildBody() {
    if (_loading && _chart == null) {
      return const SkeletonList();
    }
    if (_error != null && _chart == null) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const SizedBox(height: 80),
          ErrorState(message: _error!, onRetry: _load),
        ],
      );
    }

    final orders = _orders;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
      children: [
        _DrugChartHeader(chart: _chart ?? const {}),
        const SizedBox(height: 12),
        if (orders.isEmpty)
          const EmptyState(
            icon: Icons.medication_outlined,
            title: 'No inpatient drugs charted',
            body: 'Doctors can add drug orders once the admission is active.',
          )
        else
          ...orders.map(
            (order) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: _MedicationOrderCard(
                order: order,
                canPrescribe: _canPrescribe,
                canAdminister: _canAdminister,
                onStop: () => _stopOrder(order),
                onAdministrationChanged: _load,
              ),
            ),
          ),
      ],
    );
  }
}

class _DrugChartHeader extends StatelessWidget {
  final Map<String, dynamic> chart;

  const _DrugChartHeader({required this.chart});

  @override
  Widget build(BuildContext context) {
    final admission =
        (chart['admission'] as Map?)?.cast<String, dynamic>() ?? const {};
    final governance =
        (chart['governance'] as Map?)?.cast<String, dynamic>() ?? const {};
    final patient = _text(admission['patient_name'], fallback: 'Patient');
    final hospitalId = _text(admission['hospital_id']);
    final bed = _text(admission['bed_number']);
    final ward = _text(admission['ward_name']);
    final state = _text(governance['state'], fallback: 'schema-unavailable');
    final outcome = _text(governance['outcome'], fallback: state);
    final sourceCount = _asInt(governance['source_count']) ?? 0;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            patient,
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontSize: 20,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            [
              if (hospitalId.isNotEmpty) hospitalId,
              if (ward.isNotEmpty) ward,
              if (bed.isNotEmpty) 'Bed $bed',
              'Admission #${admission['id'] ?? '-'}',
            ].join(' · '),
            style: TextStyle(color: AppTheme.textSecondary),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _StatusPill(
                icon: Icons.verified_user_outlined,
                label: outcome == 'clear'
                    ? 'Rules clear'
                    : outcome == 'blocked'
                    ? 'Safety review needed'
                    : '$outcome · $state',
                color: _stateColor(outcome),
              ),
              _StatusPill(
                icon: Icons.source_outlined,
                label: '$sourceCount sources',
                color: AppTheme.primaryBlue,
              ),
              const _StatusPill(
                icon: Icons.visibility_outlined,
                label: 'Doctor edit · Nurse MAR · Pharmacy indent',
                color: AppTheme.primaryTeal,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _MedicationOrderCard extends StatelessWidget {
  final Map<String, dynamic> order;
  final bool canPrescribe;
  final bool canAdminister;
  final VoidCallback onStop;
  final VoidCallback onAdministrationChanged;

  const _MedicationOrderCard({
    required this.order,
    required this.canPrescribe,
    required this.canAdminister,
    required this.onStop,
    required this.onAdministrationChanged,
  });

  @override
  Widget build(BuildContext context) {
    final details =
        (order['details'] as Map?)?.cast<String, dynamic>() ?? const {};
    final safety =
        (order['safety'] as Map?)?.cast<String, dynamic>() ?? const {};
    final administrations = (order['administrations'] as List? ?? const [])
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
    final warnings = (safety['warnings'] as List? ?? const []).whereType<Map>();
    final blockers = (safety['blockers'] as List? ?? const []).whereType<Map>();
    final status = _text(order['status'], fallback: 'ordered');
    final active = !_inactive(status);

    return Container(
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        _text(details['name'], fallback: 'Medication'),
                        style: TextStyle(
                          color: AppTheme.textPrimary,
                          fontSize: 17,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        [
                          _text(details['dose']),
                          _text(details['route']),
                          _text(details['frequency']),
                          if (_text(details['duration']).isNotEmpty)
                            '${details['duration']} days',
                        ].where((part) => part.isNotEmpty).join(' · '),
                        style: TextStyle(color: AppTheme.textSecondary),
                      ),
                    ],
                  ),
                ),
                _StatusPill(
                  icon: active ? Icons.play_circle_outline : Icons.block,
                  label: status,
                  color: active
                      ? AppTheme.successOnSurface
                      : AppTheme.errorOnSurface,
                ),
              ],
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _StatusPill(
                  icon: Icons.local_pharmacy_outlined,
                  label: _text(order['pharmacy_status'], fallback: 'pending'),
                  color: AppTheme.warningOnSurface,
                ),
                _StatusPill(
                  icon: Icons.person_outline,
                  label: _text(order['ordered_by_name'], fallback: 'Doctor'),
                  color: AppTheme.primaryBlue,
                ),
                if (blockers.isNotEmpty)
                  _StatusPill(
                    icon: Icons.gpp_bad_outlined,
                    label: '${blockers.length} blockers',
                    color: AppTheme.errorOnSurface,
                  )
                else if (warnings.isNotEmpty)
                  _StatusPill(
                    icon: Icons.warning_amber_outlined,
                    label: '${warnings.length} warnings',
                    color: AppTheme.warningOnSurface,
                  )
                else
                  _StatusPill(
                    icon: Icons.check_circle_outline,
                    label: 'Safety clear',
                    color: AppTheme.successOnSurface,
                  ),
              ],
            ),
            if (warnings.isNotEmpty || blockers.isNotEmpty) ...[
              const SizedBox(height: 10),
              ...[
                ...blockers.map(
                  (row) =>
                      _SafetyLine(row: row, color: AppTheme.errorOnSurface),
                ),
                ...warnings.map(
                  (row) =>
                      _SafetyLine(row: row, color: AppTheme.warningOnSurface),
                ),
              ],
            ],
            if (_text(details['instructions']).isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(
                _text(details['instructions']),
                style: TextStyle(color: AppTheme.textPrimary),
              ),
            ],
            const SizedBox(height: 12),
            _AdministrationTimeline(
              administrations: administrations,
              canAdminister: canAdminister,
              onChanged: onAdministrationChanged,
            ),
            if (canPrescribe && active) ...[
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: onStop,
                  icon: const Icon(Icons.stop_circle_outlined),
                  label: const Text('Stop'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _AdministrationTimeline extends StatelessWidget {
  final List<Map<String, dynamic>> administrations;
  final bool canAdminister;
  final VoidCallback onChanged;

  const _AdministrationTimeline({
    required this.administrations,
    required this.canAdminister,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final rows = administrations.take(8).toList();
    if (rows.isEmpty) {
      return Text(
        'No MAR schedule generated yet',
        style: TextStyle(color: AppTheme.textSecondary),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Administration',
          style: TextStyle(
            color: AppTheme.textPrimary,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 6),
        ...rows.map(
          (row) => _AdministrationRow(
            row: row,
            canAdminister: canAdminister,
            onChanged: onChanged,
          ),
        ),
      ],
    );
  }
}

class _AdministrationRow extends StatelessWidget {
  final Map<String, dynamic> row;
  final bool canAdminister;
  final VoidCallback onChanged;

  const _AdministrationRow({
    required this.row,
    required this.canAdminister,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final status = _text(row['status'], fallback: 'scheduled');
    final scheduled = _dateTime(row['scheduled_time']);
    final given = _dateTime(row['administered_at']);
    final due = status == 'scheduled' || status == 'held';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        children: [
          Icon(
            given != null ? Icons.check_circle : Icons.schedule,
            color: given != null
                ? AppTheme.successOnSurface
                : AppTheme.warningOnSurface,
            size: 18,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              [
                'Due ${_timeLabel(scheduled)}',
                if (given != null) 'given ${_timeLabel(given)}',
                if (_text(row['administered_by_name']).isNotEmpty)
                  'by ${row['administered_by_name']}',
              ].join(' · '),
              style: TextStyle(color: AppTheme.textPrimary),
            ),
          ),
          if (canAdminister && due)
            TextButton(
              onPressed: () => context
                  .push('/mar/scan/${row['id']}')
                  .then((_) => onChanged()),
              child: const Text('Scan'),
            )
          else
            Text(
              status,
              style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
            ),
        ],
      ),
    );
  }
}

class _SafetyLine extends StatelessWidget {
  final Map row;
  final Color color;

  const _SafetyLine({required this.row, required this.color});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.info_outline, color: color, size: 16),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              _text(row['message'], fallback: _text(row['type'])),
              style: TextStyle(color: color, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;

  const _StatusPill({
    required this.icon,
    required this.label,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: color),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              color: color,
              fontWeight: FontWeight.w700,
              fontSize: 12,
            ),
          ),
        ],
      ),
    );
  }
}

class _NewMedicationSheet extends StatefulWidget {
  final Map<String, dynamic> admission;

  const _NewMedicationSheet({required this.admission});

  @override
  State<_NewMedicationSheet> createState() => _NewMedicationSheetState();
}

class _NewMedicationSheetState extends State<_NewMedicationSheet> {
  final _formKey = GlobalKey<FormState>();
  final _drugCtrl = TextEditingController();
  final _doseCtrl = TextEditingController();
  final _durationCtrl = TextEditingController(text: '3');
  final _instructionsCtrl = TextEditingController();
  String _route = 'oral';
  String _frequency = 'BD';
  bool _saving = false;

  @override
  void dispose() {
    _drugCtrl.dispose();
    _doseCtrl.dispose();
    _durationCtrl.dispose();
    _instructionsCtrl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _saving = true);
    try {
      final duration = int.tryParse(_durationCtrl.text.trim());
      await MedicalApiService.createInpatientMedicationOrder(
        patientUid: _text(widget.admission['patient_uid']),
        encounterId: _text(widget.admission['encounter_id']).isEmpty
            ? null
            : _text(widget.admission['encounter_id']),
        medicationName: _drugCtrl.text.trim(),
        dose: _doseCtrl.text.trim(),
        route: _route,
        frequency: _frequency,
        durationDays: duration,
        instructions: _instructionsCtrl.text.trim().isEmpty
            ? null
            : _instructionsCtrl.text.trim(),
      );
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: AppTheme.errorRed,
        ),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, bottom + 16),
      child: Form(
        key: _formKey,
        child: ListView(
          shrinkWrap: true,
          children: [
            Center(
              child: Container(
                width: 48,
                height: 4,
                decoration: BoxDecoration(
                  color: AppTheme.divider,
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(
              'New drug order',
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontSize: 20,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 14),
            TextFormField(
              controller: _drugCtrl,
              decoration: const InputDecoration(
                labelText: 'Drug',
                prefixIcon: Icon(Icons.medication_outlined),
              ),
              validator: (v) =>
                  v == null || v.trim().isEmpty ? 'Drug is required' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _doseCtrl,
              decoration: const InputDecoration(
                labelText: 'Dose',
                hintText: 'e.g. 500 mg',
                prefixIcon: Icon(Icons.straighten),
              ),
              validator: (v) =>
                  v == null || v.trim().isEmpty ? 'Dose is required' : null,
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: DropdownButtonFormField<String>(
                    initialValue: _route,
                    decoration: const InputDecoration(labelText: 'Route'),
                    items: const [
                      DropdownMenuItem(value: 'oral', child: Text('Oral')),
                      DropdownMenuItem(value: 'iv', child: Text('IV')),
                      DropdownMenuItem(value: 'im', child: Text('IM')),
                      DropdownMenuItem(value: 'sc', child: Text('SC')),
                      DropdownMenuItem(value: 'sublingual', child: Text('SL')),
                      DropdownMenuItem(
                        value: 'inhaled',
                        child: Text('Inhaled'),
                      ),
                      DropdownMenuItem(
                        value: 'topical',
                        child: Text('Topical'),
                      ),
                    ],
                    onChanged: (v) => setState(() => _route = v ?? _route),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: DropdownButtonFormField<String>(
                    initialValue: _frequency,
                    decoration: const InputDecoration(labelText: 'Frequency'),
                    items: const [
                      DropdownMenuItem(value: 'OD', child: Text('OD')),
                      DropdownMenuItem(value: 'BD', child: Text('BD')),
                      DropdownMenuItem(value: 'TDS', child: Text('TDS')),
                      DropdownMenuItem(value: 'QID', child: Text('QID')),
                      DropdownMenuItem(
                        value: '8-hourly',
                        child: Text('8-hourly'),
                      ),
                      DropdownMenuItem(
                        value: '12-hourly',
                        child: Text('12-hourly'),
                      ),
                    ],
                    onChanged: (v) =>
                        setState(() => _frequency = v ?? _frequency),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _durationCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'Duration in days',
                prefixIcon: Icon(Icons.date_range_outlined),
              ),
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _instructionsCtrl,
              minLines: 2,
              maxLines: 4,
              decoration: const InputDecoration(
                labelText: 'Instructions',
                prefixIcon: Icon(Icons.notes_outlined),
              ),
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _saving ? null : _save,
              icon: _saving
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.save_outlined),
              label: Text(_saving ? 'Saving' : 'Save order'),
            ),
          ],
        ),
      ),
    );
  }
}

String _text(Object? value, {String fallback = ''}) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? fallback : text;
}

int? _asInt(Object? value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '');
}

DateTime? _dateTime(Object? value) {
  if (value == null) return null;
  try {
    return DateTime.parse(value.toString()).toLocal();
  } catch (_) {
    return null;
  }
}

String _timeLabel(DateTime? value) {
  if (value == null) return 'not timed';
  final h = value.hour.toString().padLeft(2, '0');
  final m = value.minute.toString().padLeft(2, '0');
  return '$h:$m';
}

bool _inactive(String status) {
  final s = status.toLowerCase();
  return s.contains('cancel') ||
      s.contains('discontinu') ||
      s.contains('stop') ||
      s.contains('hold') ||
      s.contains('suspend');
}

Color _stateColor(String state) {
  final s = state.toLowerCase();
  if (s == 'blocked') return AppTheme.errorOnSurface;
  if (s == 'fallback' || s.contains('schema')) return AppTheme.warningOnSurface;
  return AppTheme.successOnSurface;
}
