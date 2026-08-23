// lib/features/scheduling/screens/scheduling_workbench_screen.dart
//
// Roadmap D2 — Scheduling Workbench. First staff-side surface over the
// /api/v1/scheduling backend (20 live endpoints, previously zero UI):
//   * Slot Grid  — per doctor+date grid with status-colored slot chips and
//     the hold → confirm/release flow (hold TTL surfaced from the create
//     response's expires_at).
//   * Waitlist   — add-to-waitlist form, fill-from-waitlist pass, and
//     PATCH resolution. The backend has NO waitlist list endpoint, so the
//     tab honestly shows only entries/offers returned in this session.
//   * Templates  — per-doctor availability templates + exceptions viewer,
//     create-template / add-exception dialogs, record-leave action.
//   * Resources  — create bookable rooms/equipment (no list endpoint —
//     session-created rows only), compatibility add/view, book, and the
//     per-day schedule viewer.
//
// Everything rendered comes straight from API responses — nothing is
// synthesized client-side.

import 'package:flutter/material.dart';

import '../../../core/services/scheduling_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../l10n/app_strings.dart';

String _todayIso() => DateTime.now().toIso8601String().substring(0, 10);

String _errText(Object e) => e.toString().replaceFirst('Exception: ', '');

String _hhmm(Object? value) {
  final text = '${value ?? ''}';
  return text.length >= 5 ? text.substring(0, 5) : text;
}

List<Map<String, dynamic>> _mapList(Object? value) {
  return (value as List? ?? const [])
      .whereType<Map>()
      .map((row) => Map<String, dynamic>.from(row))
      .toList(growable: false);
}

Future<void> _pickDateInto(
  State<StatefulWidget> state,
  TextEditingController controller,
) async {
  final initial = DateTime.tryParse(controller.text.trim()) ?? DateTime.now();
  final picked = await showDatePicker(
    context: state.context,
    initialDate: initial,
    firstDate: DateTime.now().subtract(const Duration(days: 365)),
    lastDate: DateTime.now().add(const Duration(days: 730)),
  );
  if (picked == null || !state.mounted) return;
  controller.text = picked.toIso8601String().substring(0, 10);
}

class SchedulingWorkbenchScreen extends StatelessWidget {
  const SchedulingWorkbenchScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return DefaultTabController(
      length: 4,
      child: Scaffold(
        appBar: AppBar(
          title: Text(s.schedulingWorkbenchTitle),
          bottom: TabBar(
            isScrollable: true,
            tabs: [
              Tab(text: s.schedulingTabSlotGrid),
              Tab(text: s.schedulingTabWaitlist),
              Tab(text: s.schedulingTabTemplates),
              Tab(text: s.schedulingTabResources),
            ],
          ),
        ),
        body: const TabBarView(
          children: [
            _SlotGridTab(),
            _WaitlistTab(),
            _TemplatesTab(),
            _ResourcesTab(),
          ],
        ),
      ),
    );
  }
}

// ─── Slot Grid ───────────────────────────────────────────────────────────────

class _SlotGridTab extends StatefulWidget {
  const _SlotGridTab();

  @override
  State<_SlotGridTab> createState() => _SlotGridTabState();
}

class _SlotGridTabState extends State<_SlotGridTab> {
  final _doctor = TextEditingController();
  final _date = TextEditingController(text: _todayIso());
  Map<String, dynamic>? _grid;
  Map<String, dynamic>? _lastHold;
  bool _loading = false;
  String? _error;

  @override
  void dispose() {
    _doctor.dispose();
    _date.dispose();
    super.dispose();
  }

  int? get _doctorId => int.tryParse(_doctor.text.trim());

  Future<void> _load() async {
    final s = AppStrings.of(context);
    final doctorId = _doctorId;
    if (doctorId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('${s.prescriptionsDoctorLabel}: ${s.labelRequired}'),
        ),
      );
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await SchedulingApiService.getSlotGrid(
        doctorId: doctorId,
        date: _date.text.trim(),
      );
      if (!mounted) return;
      setState(() {
        _grid = data;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = _errText(e);
        _loading = false;
      });
    }
  }

  String _slotStatus(Map<String, dynamic> slot) {
    if ((slot['booked_appointment_ids'] as List?)?.isNotEmpty ?? false) {
      return 'booked';
    }
    if (slot['active_hold_id'] != null) return 'held';
    if (slot['blocked_by_exception_id'] != null) return 'blocked';
    return slot['available'] == true ? 'open' : 'blocked';
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'booked':
        return AppTheme.errorRed;
      case 'held':
        return AppTheme.warningAmber;
      case 'blocked':
        return Theme.of(context).disabledColor;
      default:
        return AppTheme.successGreen;
    }
  }

  Future<void> _openHoldDialog(Map<String, dynamic> slot) async {
    final s = AppStrings.of(context);
    final patientCtrl = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(s.schedulingHoldTitle),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${slot['start']}–${slot['end']}'),
            if (slot['location'] != null) Text('${slot['location']}'),
            TextField(
              controller: patientCtrl,
              decoration: InputDecoration(
                labelText:
                    '${s.prescriptionsPatientLabel} (${s.labelOptional})',
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(s.actionConfirm),
          ),
        ],
      ),
    );
    final patientUid = patientCtrl.text.trim();
    patientCtrl.dispose();
    if (confirmed != true || !mounted) return;
    await _createHold(slot, patientUid.isEmpty ? null : patientUid);
  }

  Future<void> _createHold(
    Map<String, dynamic> slot,
    String? patientUid,
  ) async {
    final s = AppStrings.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final doctorId = _doctorId;
    if (doctorId == null) return;
    try {
      final data = await SchedulingApiService.createSlotHold(
        doctorId: doctorId,
        date: _date.text.trim(),
        slotStart: '${slot['start']}',
        slotEnd: slot['end'] == null ? null : '${slot['end']}',
        patientUid: patientUid,
      );
      if (!mounted) return;
      setState(() {
        _lastHold = data['hold'] is Map
            ? Map<String, dynamic>.from(data['hold'] as Map)
            : null;
      });
      messenger.showSnackBar(SnackBar(content: Text(s.schedulingSaved)));
      await _load();
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(_errText(e))));
    }
  }

  Future<void> _heldSlotDialog(Map<String, dynamic> slot) async {
    final s = AppStrings.of(context);
    final holdId = int.tryParse('${slot['active_hold_id']}');
    if (holdId == null) return;
    final action = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(s.schedulingSlotHeld),
        content: Text('#$holdId · ${slot['start']}–${slot['end']}'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: Text(s.actionCancel),
          ),
          OutlinedButton(
            onPressed: () => Navigator.pop(dialogContext, 'release'),
            child: Text(s.schedulingHoldRelease),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, 'confirm'),
            child: Text(s.actionConfirm),
          ),
        ],
      ),
    );
    if (action == null || !mounted) return;
    await _resolveHold(holdId, confirm: action == 'confirm');
  }

  Future<void> _resolveHold(int holdId, {required bool confirm}) async {
    final s = AppStrings.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final data = confirm
          ? await SchedulingApiService.confirmSlotHold(holdId)
          : await SchedulingApiService.releaseSlotHold(holdId);
      if (!mounted) return;
      setState(() {
        _lastHold = data['hold'] is Map
            ? Map<String, dynamic>.from(data['hold'] as Map)
            : _lastHold;
      });
      messenger.showSnackBar(SnackBar(content: Text(s.schedulingSaved)));
      await _load();
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(_errText(e))));
    }
  }

  Widget _slotChip(AppStrings s, Map<String, dynamic> slot) {
    final status = _slotStatus(slot);
    final color = _statusColor(status);
    final label = Text('${slot['start']}');
    final background = color.withValues(alpha: 0.14);
    final side = BorderSide(color: color);
    if (status == 'open') {
      return ActionChip(
        label: label,
        backgroundColor: background,
        side: side,
        onPressed: () => _openHoldDialog(slot),
      );
    }
    if (status == 'held') {
      return ActionChip(
        label: label,
        backgroundColor: background,
        side: side,
        onPressed: () => _heldSlotDialog(slot),
      );
    }
    final reason = slot['block_reason'];
    return Tooltip(
      message: status == 'blocked'
          ? '${s.schedulingSlotBlocked}${reason == null ? '' : ' · $reason'}'
          : s.schedulingSlotBooked,
      child: Chip(label: label, backgroundColor: background, side: side),
    );
  }

  Widget _legendDot(String text, Color color) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Text(text),
      ],
    );
  }

  Widget _holdBanner(AppStrings s, Map<String, dynamic> hold) {
    final status = '${hold['status'] ?? ''}';
    final expires = hold['expires_at'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.schedulingHoldTitle,
              style: Theme.of(context).textTheme.titleSmall,
            ),
            Text(
              '#${hold['id']} · ${_hhmm(hold['slot_start'])} · $status'
              '${expires == null ? '' : ' · $expires'}',
            ),
            if (status == 'held')
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Wrap(
                  spacing: 8,
                  children: [
                    FilledButton(
                      onPressed: () => _resolveHold(
                        int.tryParse('${hold['id']}') ?? 0,
                        confirm: true,
                      ),
                      child: Text(s.actionConfirm),
                    ),
                    OutlinedButton(
                      onPressed: () => _resolveHold(
                        int.tryParse('${hold['id']}') ?? 0,
                        confirm: false,
                      ),
                      child: Text(s.schedulingHoldRelease),
                    ),
                  ],
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
    final grid = _grid;
    final slots = grid == null
        ? const <Map<String, dynamic>>[]
        : _mapList(grid['slots']);
    return ConstrainedContent(
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _doctor,
                  keyboardType: TextInputType.number,
                  decoration: InputDecoration(
                    labelText: s.prescriptionsDoctorLabel,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _date,
                  decoration: InputDecoration(
                    labelText: s.theatreLabelDate,
                    hintText: 'yyyy-MM-dd',
                    suffixIcon: IconButton(
                      icon: const Icon(Icons.calendar_today_outlined),
                      tooltip: s.theatreLabelDate,
                      onPressed: () => _pickDateInto(this, _date),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: _loading ? null : _load,
                child: Text(s.actionSearch),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (_loading) const Center(child: CircularProgressIndicator()),
          if (_error != null) ...[
            Text(_error!, style: const TextStyle(color: AppTheme.errorRed)),
            const SizedBox(height: 8),
            OutlinedButton(onPressed: _load, child: Text(s.actionRetry)),
          ],
          if (!_loading && _error == null && grid == null) Text(s.labelNoData),
          if (_lastHold != null) _holdBanner(s, _lastHold!),
          if (!_loading && grid != null) ...[
            if (grid['on_leave'] == true)
              Text(
                '${s.schedulingOnLeave}'
                '${grid['leave_reason'] == null ? '' : ' · ${grid['leave_reason']}'}',
                style: const TextStyle(color: AppTheme.warningAmber),
              )
            else if (grid['schedule_closed'] == true)
              Text(
                '${s.schedulingClosed}'
                '${grid['closure_reason'] == null ? '' : ' · ${grid['closure_reason']}'}',
                style: const TextStyle(color: AppTheme.warningAmber),
              )
            else ...[
              Text(
                '${s.schedulingCapacityLabel}: ${grid['capacity']} · '
                '${s.schedulingSlotOpen}: ${grid['free_count']} · '
                '${s.schedulingSlotHeld}: ${grid['held_count']} · '
                '${s.schedulingSlotBooked}: ${grid['booked_count']} · '
                '${s.schedulingOverbookLabel}: ${grid['overbook_allowance']}',
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 16,
                runSpacing: 4,
                children: [
                  _legendDot(s.schedulingSlotOpen, AppTheme.successGreen),
                  _legendDot(s.schedulingSlotHeld, AppTheme.warningAmber),
                  _legendDot(s.schedulingSlotBooked, AppTheme.errorRed),
                  _legendDot(
                    s.schedulingSlotBlocked,
                    Theme.of(context).disabledColor,
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [for (final slot in slots) _slotChip(s, slot)],
              ),
            ],
          ],
        ],
      ),
    );
  }
}

// ─── Waitlist ────────────────────────────────────────────────────────────────

class _WaitlistTab extends StatefulWidget {
  const _WaitlistTab();

  @override
  State<_WaitlistTab> createState() => _WaitlistTabState();
}

class _WaitlistTabState extends State<_WaitlistTab> {
  final _doctor = TextEditingController();
  final _date = TextEditingController(text: _todayIso());
  final _patientUid = TextEditingController();
  final _priority = TextEditingController(text: '5');
  final _notes = TextEditingController();
  String _window = 'any';
  final List<Map<String, dynamic>> _entries = [];
  Map<String, dynamic>? _fillResult;
  bool _busy = false;

  @override
  void dispose() {
    _doctor.dispose();
    _date.dispose();
    _patientUid.dispose();
    _priority.dispose();
    _notes.dispose();
    super.dispose();
  }

  int? get _doctorId => int.tryParse(_doctor.text.trim());

  Future<void> _add() async {
    final s = AppStrings.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final doctorId = _doctorId;
    final patientUid = _patientUid.text.trim();
    if (doctorId == null || patientUid.isEmpty) {
      messenger.showSnackBar(SnackBar(content: Text(s.labelRequired)));
      return;
    }
    setState(() => _busy = true);
    try {
      final data = await SchedulingApiService.addToWaitlist(
        patientUid: patientUid,
        doctorId: doctorId,
        preferredDate: _date.text.trim().isEmpty ? null : _date.text.trim(),
        preferredWindow: _window,
        priority: int.tryParse(_priority.text.trim()) ?? 5,
        notes: _notes.text.trim().isEmpty ? null : _notes.text.trim(),
      );
      if (!mounted) return;
      setState(() {
        if (data['entry'] is Map) {
          _entries.insert(0, Map<String, dynamic>.from(data['entry'] as Map));
        }
      });
      messenger.showSnackBar(SnackBar(content: Text(s.schedulingSaved)));
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(_errText(e))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _fill() async {
    final s = AppStrings.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final doctorId = _doctorId;
    if (doctorId == null) {
      messenger.showSnackBar(
        SnackBar(
          content: Text('${s.prescriptionsDoctorLabel}: ${s.labelRequired}'),
        ),
      );
      return;
    }
    setState(() => _busy = true);
    try {
      final data = await SchedulingApiService.fillWaitlist(
        doctorId: doctorId,
        date: _date.text.trim(),
      );
      if (!mounted) return;
      setState(() => _fillResult = data);
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(_errText(e))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resolve(Map<String, dynamic> entry, String status) async {
    final s = AppStrings.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final id = int.tryParse('${entry['id']}');
    if (id == null) return;
    try {
      final data = await SchedulingApiService.resolveWaitlistEntry(
        id,
        status: status,
      );
      if (!mounted) return;
      setState(() {
        final updated = data['entry'];
        final index = _entries.indexWhere((e) => '${e['id']}' == '$id');
        if (updated is Map && index >= 0) {
          _entries[index] = Map<String, dynamic>.from(updated);
        }
      });
      messenger.showSnackBar(SnackBar(content: Text(s.schedulingSaved)));
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(_errText(e))));
    }
  }

  Widget _entryCard(AppStrings s, Map<String, dynamic> entry) {
    final status = '${entry['status'] ?? ''}';
    final open = status == 'waiting' || status == 'offered';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('#${entry['id']} · ${entry['patient_uid']}'),
            Text(
              '$status · ${entry['preferred_window'] ?? ''}'
              ' · ${s.clinicalInboxPriority} ${entry['priority'] ?? ''}'
              '${entry['preferred_date'] == null ? '' : ' · ${entry['preferred_date']}'}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            if (open)
              Wrap(
                children: [
                  for (final resolution in const [
                    'booked',
                    'expired',
                    'cancelled',
                  ])
                    TextButton(
                      onPressed: () => _resolve(entry, resolution),
                      child: Text(resolution),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Widget _fillResultView(AppStrings s, Map<String, dynamic> result) {
    final offers = _mapList(result['offers']);
    final reason = result['reason'];
    final remaining = result['free_slots_remaining'];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '${s.schedulingWaitlistOffers}: ${offers.length}'
          '${reason == null ? '' : ' · $reason'}'
          '${remaining == null ? '' : ' · ${s.schedulingSlotOpen}: $remaining'}',
          style: Theme.of(context).textTheme.titleSmall,
        ),
        for (final offer in offers)
          ListTile(
            dense: true,
            leading: const Icon(Icons.event_available_outlined),
            title: Text('#${offer['waitlist_id']} · ${offer['patient_uid']}'),
            subtitle: Text(
              '${(offer['slot'] as Map?)?['date'] ?? ''} '
              '${(offer['slot'] as Map?)?['start'] ?? ''}',
            ),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return ConstrainedContent(
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _doctor,
                  keyboardType: TextInputType.number,
                  decoration: InputDecoration(
                    labelText: s.prescriptionsDoctorLabel,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _date,
                  decoration: InputDecoration(
                    labelText: s.theatreLabelDate,
                    hintText: 'yyyy-MM-dd',
                    suffixIcon: IconButton(
                      icon: const Icon(Icons.calendar_today_outlined),
                      tooltip: s.theatreLabelDate,
                      onPressed: () => _pickDateInto(this, _date),
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.schedulingWaitlistAddTitle,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  TextField(
                    controller: _patientUid,
                    decoration: InputDecoration(
                      labelText: s.prescriptionsPatientLabel,
                    ),
                  ),
                  Row(
                    children: [
                      Expanded(
                        child: DropdownButtonFormField<String>(
                          initialValue: _window,
                          items: [
                            for (final window in const ['any', 'am', 'pm'])
                              DropdownMenuItem(
                                value: window,
                                child: Text(window),
                              ),
                          ],
                          onChanged: (value) =>
                              setState(() => _window = value ?? 'any'),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: _priority,
                          keyboardType: TextInputType.number,
                          decoration: InputDecoration(
                            labelText: s.clinicalInboxPriority,
                          ),
                        ),
                      ),
                    ],
                  ),
                  TextField(
                    controller: _notes,
                    decoration: InputDecoration(
                      labelText: s.radiologyLabelNotes,
                    ),
                  ),
                  const SizedBox(height: 8),
                  FilledButton(
                    onPressed: _busy ? null : _add,
                    child: Text(s.actionSubmit),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          FilledButton.tonal(
            onPressed: _busy ? null : _fill,
            child: Text(s.schedulingWaitlistFill),
          ),
          const SizedBox(height: 8),
          if (_fillResult != null) _fillResultView(s, _fillResult!),
          const SizedBox(height: 12),
          Text(
            s.schedulingWaitlistSessionOnly,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          for (final entry in _entries) _entryCard(s, entry),
        ],
      ),
    );
  }
}

// ─── Templates ───────────────────────────────────────────────────────────────

class _TemplatesTab extends StatefulWidget {
  const _TemplatesTab();

  @override
  State<_TemplatesTab> createState() => _TemplatesTabState();
}

class _TemplatesTabState extends State<_TemplatesTab> {
  final _doctor = TextEditingController();
  List<Map<String, dynamic>> _templates = const [];
  List<Map<String, dynamic>> _exceptions = const [];
  bool _loading = false;
  String? _error;

  @override
  void dispose() {
    _doctor.dispose();
    super.dispose();
  }

  int? get _doctorId => int.tryParse(_doctor.text.trim());

  Future<void> _load() async {
    final s = AppStrings.of(context);
    final doctorId = _doctorId;
    if (doctorId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('${s.prescriptionsDoctorLabel}: ${s.labelRequired}'),
        ),
      );
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait([
        SchedulingApiService.getTemplates(doctorId),
        SchedulingApiService.getTemplateExceptions(doctorId),
      ]);
      if (!mounted) return;
      setState(() {
        _templates = _mapList(results[0]['templates']);
        _exceptions = _mapList(results[1]['exceptions']);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = _errText(e);
        _loading = false;
      });
    }
  }

  Future<void> _createTemplateDialog() async {
    final s = AppStrings.of(context);
    final doctorId = _doctorId;
    if (doctorId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('${s.prescriptionsDoctorLabel}: ${s.labelRequired}'),
        ),
      );
      return;
    }
    final start = TextEditingController(text: '09:00');
    final end = TextEditingController(text: '13:00');
    final slotMinutes = TextEditingController(text: '15');
    final location = TextEditingController();
    var weekday = 1;
    final save = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: Text(s.schedulingTemplateCreateTitle),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButtonFormField<int>(
                  initialValue: weekday,
                  decoration: InputDecoration(
                    labelText: s.schedulingWeekdayLabel,
                  ),
                  items: [
                    for (var day = 0; day <= 6; day += 1)
                      DropdownMenuItem(value: day, child: Text('$day')),
                  ],
                  onChanged: (value) =>
                      setDialogState(() => weekday = value ?? 1),
                ),
                TextField(
                  controller: start,
                  decoration: InputDecoration(
                    labelText: s.schedulingStartLabel,
                    hintText: 'HH:mm',
                  ),
                ),
                TextField(
                  controller: end,
                  decoration: InputDecoration(
                    labelText: s.schedulingEndLabel,
                    hintText: 'HH:mm',
                  ),
                ),
                TextField(
                  controller: slotMinutes,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(hintText: 'min'),
                ),
                TextField(
                  controller: location,
                  decoration: InputDecoration(
                    labelText: s.myReportsLabelLocation,
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: Text(s.actionSave),
            ),
          ],
        ),
      ),
    );
    final body = (
      start: start.text.trim(),
      end: end.text.trim(),
      slotMinutes: int.tryParse(slotMinutes.text.trim()) ?? 15,
      location: location.text.trim(),
    );
    start.dispose();
    end.dispose();
    slotMinutes.dispose();
    location.dispose();
    if (save != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await SchedulingApiService.saveTemplate(
        doctorId: doctorId,
        weekday: weekday,
        startTime: body.start,
        endTime: body.end,
        slotMinutes: body.slotMinutes,
        location: body.location.isEmpty ? null : body.location,
      );
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(AppStrings.of(context).schedulingSaved)),
      );
      await _load();
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(_errText(e))));
    }
  }

  Future<void> _exceptionDialog(Map<String, dynamic> template) async {
    final s = AppStrings.of(context);
    final doctorId = _doctorId;
    final templateId = int.tryParse('${template['id']}');
    if (doctorId == null || templateId == null) return;
    final date = TextEditingController(text: _todayIso());
    final start = TextEditingController();
    final end = TextEditingController();
    final reason = TextEditingController();
    var type = 'blocked';
    final save = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: Text(s.schedulingTemplateExceptionTitle),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('#$templateId'),
                TextField(
                  controller: date,
                  decoration: InputDecoration(
                    labelText: s.theatreLabelDate,
                    hintText: 'yyyy-MM-dd',
                  ),
                ),
                DropdownButtonFormField<String>(
                  initialValue: type,
                  items: [
                    for (final exceptionType in const [
                      'closed',
                      'blocked',
                      'modified',
                      'extra',
                    ])
                      DropdownMenuItem(
                        value: exceptionType,
                        child: Text(exceptionType),
                      ),
                  ],
                  onChanged: (value) =>
                      setDialogState(() => type = value ?? 'blocked'),
                ),
                TextField(
                  controller: start,
                  decoration: InputDecoration(
                    labelText: s.schedulingStartLabel,
                    hintText: 'HH:mm',
                  ),
                ),
                TextField(
                  controller: end,
                  decoration: InputDecoration(
                    labelText: s.schedulingEndLabel,
                    hintText: 'HH:mm',
                  ),
                ),
                TextField(
                  controller: reason,
                  decoration: InputDecoration(labelText: s.leaveReasonLabel),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: Text(s.actionSave),
            ),
          ],
        ),
      ),
    );
    final body = (
      date: date.text.trim(),
      start: start.text.trim(),
      end: end.text.trim(),
      reason: reason.text.trim(),
    );
    date.dispose();
    start.dispose();
    end.dispose();
    reason.dispose();
    if (save != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await SchedulingApiService.addTemplateException(
        templateId: templateId,
        doctorId: doctorId,
        exceptionDate: body.date,
        exceptionType: type,
        // A 'closed' exception with no window means the whole day.
        allDay: type == 'closed' && body.start.isEmpty && body.end.isEmpty,
        startTime: body.start.isEmpty ? null : body.start,
        endTime: body.end.isEmpty ? null : body.end,
        reason: body.reason.isEmpty ? null : body.reason,
      );
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(AppStrings.of(context).schedulingSaved)),
      );
      await _load();
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(_errText(e))));
    }
  }

  Future<void> _leaveDialog() async {
    final s = AppStrings.of(context);
    final doctorId = _doctorId;
    if (doctorId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('${s.prescriptionsDoctorLabel}: ${s.labelRequired}'),
        ),
      );
      return;
    }
    final startsOn = TextEditingController(text: _todayIso());
    final endsOn = TextEditingController(text: _todayIso());
    final reason = TextEditingController();
    final save = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(s.schedulingLeaveTitle),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: startsOn,
              decoration: InputDecoration(
                labelText: s.schedulingStartLabel,
                hintText: 'yyyy-MM-dd',
              ),
            ),
            TextField(
              controller: endsOn,
              decoration: InputDecoration(
                labelText: s.schedulingEndLabel,
                hintText: 'yyyy-MM-dd',
              ),
            ),
            TextField(
              controller: reason,
              decoration: InputDecoration(labelText: s.leaveReasonLabel),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(s.actionSave),
          ),
        ],
      ),
    );
    final body = (
      startsOn: startsOn.text.trim(),
      endsOn: endsOn.text.trim(),
      reason: reason.text.trim(),
    );
    startsOn.dispose();
    endsOn.dispose();
    reason.dispose();
    if (save != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await SchedulingApiService.recordLeave(
        doctorId: doctorId,
        startsOn: body.startsOn,
        endsOn: body.endsOn,
        reason: body.reason.isEmpty ? null : body.reason,
      );
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(AppStrings.of(context).schedulingSaved)),
      );
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(_errText(e))));
    }
  }

  Widget _templateCard(AppStrings s, Map<String, dynamic> template) {
    final location = template['location'];
    return Card(
      child: ListTile(
        title: Text(
          'W${template['weekday']} · ${_hhmm(template['start_time'])}–'
          '${_hhmm(template['end_time'])}',
        ),
        subtitle: Text(
          '#${template['id']} · ${template['slot_minutes']} min · '
          'v${template['version']} · ${template['status']}'
          '${location == null ? '' : ' · $location'}',
        ),
        trailing: TextButton(
          onPressed: () => _exceptionDialog(template),
          child: Text(s.schedulingTemplateExceptionTitle),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return ConstrainedContent(
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _doctor,
                  keyboardType: TextInputType.number,
                  decoration: InputDecoration(
                    labelText: s.prescriptionsDoctorLabel,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: _loading ? null : _load,
                child: Text(s.actionSearch),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              FilledButton.tonal(
                onPressed: _createTemplateDialog,
                child: Text(s.schedulingTemplateCreateTitle),
              ),
              OutlinedButton(
                onPressed: _leaveDialog,
                child: Text(s.schedulingLeaveTitle),
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (_loading) const Center(child: CircularProgressIndicator()),
          if (_error != null)
            Text(_error!, style: const TextStyle(color: AppTheme.errorRed)),
          if (!_loading && _error == null && _templates.isEmpty)
            Text(s.labelNoData),
          for (final template in _templates) _templateCard(s, template),
          for (final exception in _exceptions)
            ListTile(
              dense: true,
              leading: const Icon(
                Icons.event_busy_outlined,
                color: AppTheme.warningAmber,
              ),
              title: Text(
                '${exception['exception_date']} · '
                '${exception['exception_type']}'
                '${exception['all_day'] == true ? '' : ' · ${_hhmm(exception['start_time'])}–${_hhmm(exception['end_time'])}'}',
              ),
              subtitle: exception['reason'] == null
                  ? null
                  : Text('${exception['reason']}'),
            ),
        ],
      ),
    );
  }
}

// ─── Resources ───────────────────────────────────────────────────────────────

class _ResourcesTab extends StatefulWidget {
  const _ResourcesTab();

  @override
  State<_ResourcesTab> createState() => _ResourcesTabState();
}

class _ResourcesTabState extends State<_ResourcesTab> {
  final _name = TextEditingController();
  final _location = TextEditingController();
  final _capacity = TextEditingController(text: '1');
  String _kind = 'room';
  final List<Map<String, dynamic>> _created = [];

  final _resourceId = TextEditingController();
  final _date = TextEditingController(text: _todayIso());
  List<Map<String, dynamic>>? _compatibility;
  List<Map<String, dynamic>>? _bookings;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _location.dispose();
    _capacity.dispose();
    _resourceId.dispose();
    _date.dispose();
    super.dispose();
  }

  int? get _typedResourceId => int.tryParse(_resourceId.text.trim());

  Future<void> _create() async {
    final s = AppStrings.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final name = _name.text.trim();
    if (name.isEmpty) {
      messenger.showSnackBar(
        SnackBar(content: Text('${s.profileFieldName}: ${s.labelRequired}')),
      );
      return;
    }
    setState(() => _busy = true);
    try {
      final data = await SchedulingApiService.createResource(
        kind: _kind,
        name: name,
        location: _location.text.trim().isEmpty ? null : _location.text.trim(),
        capacity: int.tryParse(_capacity.text.trim()) ?? 1,
      );
      if (!mounted) return;
      setState(() {
        if (data['resource'] is Map) {
          final resource = Map<String, dynamic>.from(data['resource'] as Map);
          _created.insert(0, resource);
          _resourceId.text = '${resource['id'] ?? ''}';
        }
      });
      messenger.showSnackBar(SnackBar(content: Text(s.schedulingSaved)));
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(_errText(e))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _loadResourceViews() async {
    final s = AppStrings.of(context);
    final resourceId = _typedResourceId;
    if (resourceId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('${s.schedulingResourceIdLabel}: ${s.labelRequired}'),
        ),
      );
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final results = await Future.wait([
        SchedulingApiService.getResourceCompatibility(resourceId),
        SchedulingApiService.getResourceSchedule(
          resourceId: resourceId,
          date: _date.text.trim(),
        ),
      ]);
      if (!mounted) return;
      setState(() {
        _compatibility = _mapList(results[0]['compatibility']);
        _bookings = _mapList(results[1]['bookings']);
        _busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = _errText(e);
        _busy = false;
      });
    }
  }

  Future<void> _compatibilityDialog() async {
    final s = AppStrings.of(context);
    final resourceId = _typedResourceId;
    if (resourceId == null) return;
    final doctor = TextEditingController();
    final appointmentType = TextEditingController();
    final serviceCode = TextEditingController();
    final visitType = TextEditingController();
    var requirement = 'compatible';
    final save = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: Text(s.schedulingResourceCompatTitle),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButtonFormField<String>(
                  initialValue: requirement,
                  items: [
                    for (final level in const [
                      'compatible',
                      'preferred',
                      'required',
                    ])
                      DropdownMenuItem(value: level, child: Text(level)),
                  ],
                  onChanged: (value) =>
                      setDialogState(() => requirement = value ?? 'compatible'),
                ),
                TextField(
                  controller: doctor,
                  keyboardType: TextInputType.number,
                  decoration: InputDecoration(
                    labelText:
                        '${s.prescriptionsDoctorLabel} (${s.labelOptional})',
                  ),
                ),
                TextField(
                  controller: appointmentType,
                  decoration: const InputDecoration(
                    hintText: 'appointment_type',
                  ),
                ),
                TextField(
                  controller: serviceCode,
                  decoration: const InputDecoration(hintText: 'service_code'),
                ),
                TextField(
                  controller: visitType,
                  decoration: const InputDecoration(hintText: 'visit_type'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: Text(s.actionSave),
            ),
          ],
        ),
      ),
    );
    final body = (
      doctorId: int.tryParse(doctor.text.trim()),
      appointmentType: appointmentType.text.trim(),
      serviceCode: serviceCode.text.trim(),
      visitType: visitType.text.trim(),
    );
    doctor.dispose();
    appointmentType.dispose();
    serviceCode.dispose();
    visitType.dispose();
    if (save != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await SchedulingApiService.addResourceCompatibility(
        resourceId: resourceId,
        doctorId: body.doctorId,
        appointmentType: body.appointmentType.isEmpty
            ? null
            : body.appointmentType,
        serviceCode: body.serviceCode.isEmpty ? null : body.serviceCode,
        visitType: body.visitType.isEmpty ? null : body.visitType,
        requirement: requirement,
      );
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(AppStrings.of(context).schedulingSaved)),
      );
      await _loadResourceViews();
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(_errText(e))));
    }
  }

  Future<void> _bookDialog() async {
    final s = AppStrings.of(context);
    final resourceId = _typedResourceId;
    if (resourceId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('${s.schedulingResourceIdLabel}: ${s.labelRequired}'),
        ),
      );
      return;
    }
    final day = _date.text.trim().isEmpty ? _todayIso() : _date.text.trim();
    final startsAt = TextEditingController(text: '${day}T09:00:00');
    final endsAt = TextEditingController(text: '${day}T10:00:00');
    final bookedForType = TextEditingController(text: 'other');
    final patientUid = TextEditingController();
    final notes = TextEditingController();
    final save = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(s.schedulingResourceBookTitle),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: startsAt,
                decoration: InputDecoration(labelText: s.schedulingStartLabel),
              ),
              TextField(
                controller: endsAt,
                decoration: InputDecoration(labelText: s.schedulingEndLabel),
              ),
              TextField(
                controller: bookedForType,
                decoration: const InputDecoration(hintText: 'booked_for_type'),
              ),
              TextField(
                controller: patientUid,
                decoration: InputDecoration(
                  labelText:
                      '${s.prescriptionsPatientLabel} (${s.labelOptional})',
                ),
              ),
              TextField(
                controller: notes,
                decoration: InputDecoration(labelText: s.radiologyLabelNotes),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(s.actionSave),
          ),
        ],
      ),
    );
    final body = (
      startsAt: startsAt.text.trim(),
      endsAt: endsAt.text.trim(),
      bookedForType: bookedForType.text.trim(),
      patientUid: patientUid.text.trim(),
      notes: notes.text.trim(),
    );
    startsAt.dispose();
    endsAt.dispose();
    bookedForType.dispose();
    patientUid.dispose();
    notes.dispose();
    if (save != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await SchedulingApiService.bookResource(
        resourceId: resourceId,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        bookedForType: body.bookedForType.isEmpty
            ? 'other'
            : body.bookedForType,
        patientUid: body.patientUid.isEmpty ? null : body.patientUid,
        notes: body.notes.isEmpty ? null : body.notes,
      );
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(AppStrings.of(context).schedulingSaved)),
      );
      await _loadResourceViews();
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(_errText(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final compatibility = _compatibility;
    final bookings = _bookings;
    return ConstrainedContent(
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.schedulingResourceCreateTitle,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  Row(
                    children: [
                      Expanded(
                        child: DropdownButtonFormField<String>(
                          initialValue: _kind,
                          items: [
                            for (final kind in const ['room', 'equipment'])
                              DropdownMenuItem(value: kind, child: Text(kind)),
                          ],
                          onChanged: (value) =>
                              setState(() => _kind = value ?? 'room'),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: _capacity,
                          keyboardType: TextInputType.number,
                          decoration: InputDecoration(
                            labelText: s.schedulingCapacityLabel,
                          ),
                        ),
                      ),
                    ],
                  ),
                  TextField(
                    controller: _name,
                    decoration: InputDecoration(labelText: s.profileFieldName),
                  ),
                  TextField(
                    controller: _location,
                    decoration: InputDecoration(
                      labelText: s.myReportsLabelLocation,
                    ),
                  ),
                  const SizedBox(height: 8),
                  FilledButton(
                    onPressed: _busy ? null : _create,
                    child: Text(s.actionSave),
                  ),
                  for (final resource in _created)
                    ListTile(
                      dense: true,
                      leading: const Icon(Icons.meeting_room_outlined),
                      title: Text(
                        '#${resource['id']} · ${resource['kind']} · '
                        '${resource['name']}',
                      ),
                      onTap: () => setState(
                        () => _resourceId.text = '${resource['id'] ?? ''}',
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _resourceId,
                  keyboardType: TextInputType.number,
                  decoration: InputDecoration(
                    labelText: s.schedulingResourceIdLabel,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _date,
                  decoration: InputDecoration(
                    labelText: s.theatreLabelDate,
                    hintText: 'yyyy-MM-dd',
                    suffixIcon: IconButton(
                      icon: const Icon(Icons.calendar_today_outlined),
                      tooltip: s.theatreLabelDate,
                      onPressed: () => _pickDateInto(this, _date),
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              OutlinedButton(
                onPressed: _busy ? null : _loadResourceViews,
                child: Text(s.actionSearch),
              ),
              FilledButton.tonal(
                onPressed: _busy ? null : _bookDialog,
                child: Text(s.schedulingResourceBookTitle),
              ),
            ],
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                _error!,
                style: const TextStyle(color: AppTheme.errorRed),
              ),
            ),
          if (compatibility != null) ...[
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: Text(
                    '${s.schedulingResourceCompatTitle}: '
                    '${compatibility.length}',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.add_circle_outline),
                  tooltip: s.schedulingResourceCompatTitle,
                  onPressed: _compatibilityDialog,
                ),
              ],
            ),
            for (final rule in compatibility)
              ListTile(
                dense: true,
                leading: const Icon(Icons.rule_outlined),
                title: Text(
                  '${rule['requirement']}'
                  '${rule['doctor_id'] == null ? '' : ' · ${s.prescriptionsDoctorLabel} ${rule['doctor_id']}'}'
                  '${rule['appointment_type'] == null ? '' : ' · ${rule['appointment_type']}'}'
                  '${rule['service_code'] == null ? '' : ' · ${rule['service_code']}'}'
                  '${rule['visit_type'] == null ? '' : ' · ${rule['visit_type']}'}',
                ),
              ),
          ],
          if (bookings != null) ...[
            const SizedBox(height: 12),
            Text(
              '${s.schedulingResourceScheduleTitle}: ${bookings.length}',
              style: Theme.of(context).textTheme.titleSmall,
            ),
            if (bookings.isEmpty) Text(s.labelNoData),
            for (final booking in bookings)
              ListTile(
                dense: true,
                leading: const Icon(Icons.schedule_outlined),
                title: Text('${booking['starts_at']} → ${booking['ends_at']}'),
                subtitle: Text(
                  '${booking['resource_name'] ?? ''} · '
                  '${booking['booked_for_type'] ?? ''}'
                  '${booking['notes'] == null ? '' : ' · ${booking['notes']}'}',
                ),
              ),
          ],
        ],
      ),
    );
  }
}
