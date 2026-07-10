import 'package:flutter/material.dart';

import '../../../core/config/api_config.dart';
import '../../../core/services/resus_api_service.dart';
import '../../../l10n/app_strings.dart';
import '../widgets/resus_event_panel.dart';

const _kEntryTypes = <String>[
  'compressions_started',
  'compressions_stopped',
  'rhythm_check',
  'shock',
  'airway_intervention',
  'medication',
  'lab_sample',
  'fluid_bolus',
  'blood_product',
  'procedure',
  'rosc',
  'transfer',
  'death_declaration',
  'note',
  'correction_note',
];

const _kRoles = <String>[
  'team_leader',
  'recorder',
  'airway',
  'compressions',
  'medications',
  'defibrillation',
  'circulation',
  'runner',
  'observer',
  'other',
];

const _kOutcomes = <String>[
  'rosc',
  'death',
  'transferred',
  'stopped_futility',
];

/// Live documentation surface for one durable resuscitation event: header +
/// append-only timeline entry, team-role/signature capture, end + finalize.
/// Renders from the PERSISTED record (WS pushes are notification-only).
class ResusDocumentationScreen extends StatefulWidget {
  const ResusDocumentationScreen({super.key, required this.eventId});

  final int eventId;

  @override
  State<ResusDocumentationScreen> createState() =>
      _ResusDocumentationScreenState();
}

class _ResusDocumentationScreenState extends State<ResusDocumentationScreen> {
  Map<String, dynamic>? _detail;
  bool _loading = true;
  String? _error;
  bool _busy = false;

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
      final detail = await ResusApiService.getEvent(widget.eventId);
      if (!mounted) return;
      setState(() {
        _detail = detail;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = AppStrings.of(context).lookup('resus.load_error');
        _loading = false;
      });
    }
  }

  Map<String, dynamic> get _event =>
      (_detail?['event'] is Map<String, dynamic>)
      ? _detail!['event'] as Map<String, dynamic>
      : const <String, dynamic>{};

  bool get _isOpen {
    final status = '${_event['status'] ?? ''}';
    return status == 'active' || status == 'ended';
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy || !mounted) return;
    setState(() => _busy = true);
    final s = AppStrings.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await action();
      messenger.showSnackBar(SnackBar(content: Text(s.lookup('resus.saved'))));
      await _load();
    } catch (e) {
      final message = e.toString().replaceFirst('Exception: ', '');
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            message.isEmpty ? s.lookup('resus.error_generic') : message,
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _addEntry() async {
    final s = AppStrings.of(context);
    var entryType = 'compressions_started';
    final rhythm = TextEditingController();
    final energy = TextEditingController();
    final medName = TextEditingController();
    final dose = TextEditingController();
    final route = TextEditingController();
    final marId = TextEditingController();
    final note = TextEditingController();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) {
          final isShock = entryType == 'shock' || entryType == 'rhythm_check';
          final isMed =
              entryType == 'medication' ||
              entryType == 'fluid_bolus' ||
              entryType == 'blood_product';
          return AlertDialog(
            title: AppText('resus.add_entry'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  DropdownButtonFormField<String>(
                    initialValue: entryType,
                    decoration: InputDecoration(
                      labelText: s.lookup('resus.entry_type'),
                    ),
                    items: [
                      for (final t in _kEntryTypes)
                        DropdownMenuItem(
                          value: t,
                          child: Text(resusEnumLabel(s, 'entry', t)),
                        ),
                    ],
                    onChanged: (v) => setDialogState(
                      () => entryType = v ?? 'compressions_started',
                    ),
                  ),
                  if (isShock) ...[
                    TextField(
                      controller: rhythm,
                      decoration: InputDecoration(
                        labelText: s.lookup('resus.rhythm'),
                      ),
                    ),
                    if (entryType == 'shock')
                      TextField(
                        controller: energy,
                        keyboardType: TextInputType.number,
                        decoration: InputDecoration(
                          labelText: s.lookup('resus.energy_j'),
                        ),
                      ),
                  ],
                  if (isMed) ...[
                    TextField(
                      controller: medName,
                      decoration: InputDecoration(
                        labelText: s.lookup('resus.medication'),
                      ),
                    ),
                    TextField(
                      controller: dose,
                      decoration: InputDecoration(
                        labelText: s.lookup('resus.dose'),
                      ),
                    ),
                    TextField(
                      controller: route,
                      decoration: InputDecoration(
                        labelText: s.lookup('resus.route'),
                      ),
                    ),
                    TextField(
                      controller: marId,
                      keyboardType: TextInputType.number,
                      decoration: InputDecoration(
                        labelText: s.lookup('resus.mar_id'),
                        helperText: s.lookup('resus.mar_hint'),
                        helperMaxLines: 3,
                      ),
                    ),
                  ],
                  TextField(
                    controller: note,
                    decoration: InputDecoration(
                      labelText: s.lookup('resus.details_note'),
                    ),
                    maxLines: 2,
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: Text(s.actionCancel),
              ),
              FilledButton(
                onPressed: () => Navigator.of(ctx).pop(true),
                child: Text(s.actionSave),
              ),
            ],
          );
        },
      ),
    );
    if (confirmed != true) return;

    await _run(() async {
      await ResusApiService.appendTimelineEntry(
        eventId: widget.eventId,
        entryType: entryType,
        rhythm: rhythm.text.trim().isEmpty ? null : rhythm.text.trim(),
        energyJoules: double.tryParse(energy.text.trim()),
        medicationName: medName.text.trim().isEmpty
            ? null
            : medName.text.trim(),
        dose: dose.text.trim().isEmpty ? null : dose.text.trim(),
        route: route.text.trim().isEmpty ? null : route.text.trim(),
        marAdministrationId: int.tryParse(marId.text.trim()),
        details: note.text.trim().isEmpty ? null : {'note': note.text.trim()},
      );
    });
  }

  Future<void> _addRole() async {
    final s = AppStrings.of(context);
    var role = 'team_leader';
    var signNow = true;
    final name = TextEditingController();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: AppText('resus.add_role'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                initialValue: role,
                decoration: InputDecoration(labelText: s.lookup('resus.role')),
                items: [
                  for (final r in _kRoles)
                    DropdownMenuItem(
                      value: r,
                      child: Text(resusEnumLabel(s, 'role', r)),
                    ),
                ],
                onChanged: (v) =>
                    setDialogState(() => role = v ?? 'team_leader'),
              ),
              TextField(
                controller: name,
                decoration: InputDecoration(
                  labelText: s.lookup('resus.staff_name'),
                ),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: AppText('resus.sign_now'),
                value: signNow,
                onChanged: (v) => setDialogState(() => signNow = v),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(s.actionSave),
            ),
          ],
        ),
      ),
    );
    if (confirmed != true) return;

    final genericError = s.lookup('resus.error_generic');
    await _run(() async {
      final staffUid =
          await ApiConfig.getStaffUid() ?? await ApiConfig.getStaffId();
      if (staffUid == null || staffUid.isEmpty) {
        throw Exception(genericError);
      }
      await ResusApiService.upsertTeamRole(
        eventId: widget.eventId,
        staffUid: staffUid,
        role: role,
        staffName: name.text.trim().isEmpty ? null : name.text.trim(),
        sign: signNow,
      );
    });
  }

  Future<void> _endEvent() async {
    final s = AppStrings.of(context);
    var outcome = 'rosc';
    final note = TextEditingController();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: AppText('resus.end_event'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                initialValue: outcome,
                decoration: InputDecoration(
                  labelText: s.lookup('resus.outcome'),
                ),
                items: [
                  for (final o in _kOutcomes)
                    DropdownMenuItem(
                      value: o,
                      child: Text(resusEnumLabel(s, 'outcome', o)),
                    ),
                ],
                onChanged: (v) => setDialogState(() => outcome = v ?? 'rosc'),
              ),
              TextField(
                controller: note,
                decoration: InputDecoration(
                  labelText: s.lookup('resus.details_note'),
                ),
                maxLines: 2,
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(s.actionConfirm),
            ),
          ],
        ),
      ),
    );
    if (confirmed != true) return;

    await _run(() async {
      await ResusApiService.endEvent(
        eventId: widget.eventId,
        outcome: outcome,
        outcomeNote: note.text.trim().isEmpty ? null : note.text.trim(),
      );
    });
  }

  Future<void> _finalize() async {
    await _run(() async {
      await ResusApiService.finalizeEvent(widget.eventId);
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final status = '${_event['status'] ?? ''}';

    return Scaffold(
      appBar: AppBar(title: AppText('resus.title')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(_error!),
                  const SizedBox(height: 10),
                  FilledButton(
                    onPressed: _load,
                    child: Text(s.actionRetry),
                  ),
                ],
              ),
            )
          : RefreshIndicator(
              onRefresh: _load,
              child: SingleChildScrollView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(16),
                child: ResusEventPanel(detail: _detail ?? const {}),
              ),
            ),
      bottomNavigationBar: _loading || _error != null || !_isOpen
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
                child: Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  alignment: WrapAlignment.center,
                  children: [
                    FilledButton.tonalIcon(
                      onPressed: _busy ? null : _addEntry,
                      icon: const Icon(Icons.playlist_add),
                      label: AppText('resus.add_entry'),
                    ),
                    FilledButton.tonalIcon(
                      onPressed: _busy ? null : _addRole,
                      icon: const Icon(Icons.group_add_outlined),
                      label: AppText('resus.add_role'),
                    ),
                    if (status == 'active')
                      FilledButton.icon(
                        onPressed: _busy ? null : _endEvent,
                        icon: const Icon(Icons.stop_circle_outlined),
                        label: AppText('resus.end_event'),
                      ),
                    if (status == 'ended')
                      FilledButton.icon(
                        onPressed: _busy ? null : _finalize,
                        icon: const Icon(Icons.task_alt),
                        label: AppText('resus.finalize'),
                      ),
                  ],
                ),
              ),
            ),
    );
  }
}
