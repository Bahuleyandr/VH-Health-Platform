import 'package:flutter/material.dart';

import '../../../core/services/transport_api_service.dart';
import '../../../l10n/app_strings.dart';

/// Modal sheet for raising a new porter transport request. Zones come from
/// GET /patient-flow/transport/zones (active only); submit POSTs
/// /patient-flow/transport/tasks. Resolves to `true` when a task was created
/// so the caller can refresh its lists.
Future<bool?> showTransportRequestSheet(BuildContext context) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => const _TransportRequestSheet(),
  );
}

class _TransportRequestSheet extends StatefulWidget {
  const _TransportRequestSheet();

  @override
  State<_TransportRequestSheet> createState() => _TransportRequestSheetState();
}

class _TransportRequestSheetState extends State<_TransportRequestSheet> {
  final _patientController = TextEditingController();
  final _notesController = TextEditingController();

  bool _loading = true;
  bool _submitting = false;
  String? _error;
  bool _transportEnabled = true;
  List<Map<String, dynamic>> _zones = const [];
  int? _fromZoneId;
  int? _toZoneId;
  String _priority = 'medium';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _patientController.dispose();
    _notesController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait<Object?>([
        TransportApiService.getZones(activeOnly: true),
        // Settings tell us up-front whether creation would be refused with
        // TRANSPORT_DISABLED; surface that instead of a failing submit.
        TransportApiService.getSettings().catchError(
          (_) => <String, dynamic>{'enabled': true},
        ),
      ]);
      if (!mounted) return;
      final settings = results[1] is Map<String, dynamic>
          ? results[1] as Map<String, dynamic>
          : const <String, dynamic>{};
      setState(() {
        _zones = results[0] as List<Map<String, dynamic>>;
        _transportEnabled = settings['enabled'] != false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _zoneLabel(Map<String, dynamic> zone) {
    final name = zone['name']?.toString().trim() ?? '';
    final building = zone['building']?.toString().trim() ?? '';
    final floor = zone['floor']?.toString().trim() ?? '';
    final suffix = [
      if (building.isNotEmpty) building,
      if (floor.isNotEmpty) floor,
    ].join(', ');
    final label = name.isEmpty ? 'Zone #${zone['id']}' : name;
    return suffix.isEmpty ? label : '$label ($suffix)';
  }

  String? _zoneNameFor(int? zoneId) {
    if (zoneId == null) return null;
    for (final zone in _zones) {
      if (int.tryParse(zone['id']?.toString() ?? '') == zoneId) {
        final name = zone['name']?.toString().trim() ?? '';
        if (name.isNotEmpty) return name;
      }
    }
    return null;
  }

  Future<void> _submit() async {
    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    final navigator = Navigator.of(context);
    final fromZoneId = _fromZoneId;
    final toZoneId = _toZoneId;
    if (fromZoneId == null || toZoneId == null) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(AppStrings.of(context).transportSelectBothZones),
        ),
      );
      return;
    }
    if (fromZoneId == toZoneId) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(AppStrings.of(context).transportZonesMustDiffer),
        ),
      );
      return;
    }

    setState(() => _submitting = true);
    try {
      final patientUid = _patientController.text.trim();
      final notes = _notesController.text.trim();
      final result = await TransportApiService.createTask(
        pickupZoneId: fromZoneId,
        destinationZoneId: toZoneId,
        pickupLabel: _zoneNameFor(fromZoneId),
        destinationLabel: _zoneNameFor(toZoneId),
        priority: _priority,
        // Backend `maybeUuid` drops non-UUID patient identifiers silently,
        // so anything typed here only links when it is a real patient uid.
        patientUid: patientUid.isEmpty ? null : patientUid,
        notes: notes.isEmpty ? null : notes,
      );
      if (!mounted) return;
      final task = result['task'];
      final taskNumber = task is Map
          ? (task['task_number']?.toString() ?? '')
          : '';
      navigator.pop(true);
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            taskNumber.isEmpty
                ? 'Transport task created'
                : 'Transport task $taskNumber created',
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      messenger.showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: theme.colorScheme.error,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;

    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + bottomInset),
      child: _loading
          ? const SizedBox(
              height: 180,
              child: Center(child: CircularProgressIndicator()),
            )
          : SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'New transport request',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (_error != null) ...[
                    Text(
                      _error!,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.error,
                      ),
                    ),
                    const SizedBox(height: 8),
                    OutlinedButton.icon(
                      onPressed: _load,
                      icon: const Icon(Icons.refresh, size: 16),
                      label: Text(s.actionRetry),
                    ),
                    const SizedBox(height: 8),
                  ],
                  if (!_transportEnabled) ...[
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: theme.colorScheme.errorContainer,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        'Patient transport is not enabled for this hospital.',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onErrorContainer,
                        ),
                      ),
                    ),
                    const SizedBox(height: 10),
                  ],
                  DropdownButtonFormField<int>(
                    initialValue: _fromZoneId,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(context).transportFromZone,
                      border: const OutlineInputBorder(),
                    ),
                    items: [
                      for (final zone in _zones)
                        DropdownMenuItem(
                          value: int.tryParse(zone['id']?.toString() ?? ''),
                          child: Text(
                            _zoneLabel(zone),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                    onChanged: (value) => setState(() => _fromZoneId = value),
                  ),
                  const SizedBox(height: 10),
                  DropdownButtonFormField<int>(
                    initialValue: _toZoneId,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(context).transportToZone,
                      border: const OutlineInputBorder(),
                    ),
                    items: [
                      for (final zone in _zones)
                        DropdownMenuItem(
                          value: int.tryParse(zone['id']?.toString() ?? ''),
                          child: Text(
                            _zoneLabel(zone),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                    onChanged: (value) => setState(() => _toZoneId = value),
                  ),
                  const SizedBox(height: 12),
                  SegmentedButton<String>(
                    segments: [
                      ButtonSegment(
                        value: 'low',
                        label: Text(
                          AppStrings.of(context).transportPriorityLow,
                        ),
                      ),
                      ButtonSegment(
                        value: 'medium',
                        label: Text(
                          AppStrings.of(context).transportPriorityMedium,
                        ),
                      ),
                      ButtonSegment(
                        value: 'high',
                        label: Text(
                          AppStrings.of(context).transportPriorityHigh,
                        ),
                      ),
                      ButtonSegment(
                        value: 'urgent',
                        label: Text(
                          AppStrings.of(context).transportPriorityUrgent,
                        ),
                      ),
                    ],
                    selected: {_priority},
                    onSelectionChanged: (selection) =>
                        setState(() => _priority = selection.first),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _patientController,
                    decoration: InputDecoration(
                      labelText: 'Patient identifier (${s.labelOptional})',
                      helperText:
                          'Patient UID; links the task to the patient timeline',
                      border: const OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _notesController,
                    maxLines: 2,
                    maxLength: 500,
                    decoration: InputDecoration(
                      labelText: 'Notes (${s.labelOptional})',
                      hintText: AppStrings.of(context).transportNotesHint,
                      border: const OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      TextButton(
                        onPressed: _submitting
                            ? null
                            : () => Navigator.of(context).pop(false),
                        child: Text(s.actionCancel),
                      ),
                      const SizedBox(width: 8),
                      FilledButton.icon(
                        onPressed: _submitting || !_transportEnabled
                            ? null
                            : _submit,
                        icon: _submitting
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.send, size: 16),
                        label: Text(s.actionSubmit),
                      ),
                    ],
                  ),
                ],
              ),
            ),
    );
  }
}
