import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/notification_scheduler.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';

// ── Data model ──────────────────────────────────────────────────────────────

class _Reminder {
  final int id;
  final String medicationName;
  final String dosage;
  final String frequency;
  final List<String> reminderTimes;
  final String startDate;
  final String? endDate;
  final bool isActive;
  final String? notes;

  /// Origin of the reminder. `medication_reminder` rows are owned by
  /// the patient; `anc_supplement` rows are doctor-managed projections
  /// from `maternity_supplements` and are read-only on this screen.
  final String source;

  _Reminder({
    required this.id,
    required this.medicationName,
    required this.dosage,
    required this.frequency,
    required this.reminderTimes,
    required this.startDate,
    this.endDate,
    required this.isActive,
    this.notes,
    this.source = 'medication_reminder',
  });

  bool get isReadOnly => source == 'anc_supplement';

  factory _Reminder.fromJson(Map<String, dynamic> json) {
    return _Reminder(
      id: (json['id'] as num).toInt(),
      medicationName: json['medication_name'] as String? ?? '',
      dosage: json['dosage'] as String? ?? '',
      frequency: json['frequency'] as String? ?? '',
      reminderTimes:
          (json['reminder_times'] as List<dynamic>?)
              ?.map((e) => e.toString())
              .toList() ??
          [],
      startDate: json['start_date']?.toString().split('T').first ?? '',
      endDate: json['end_date']?.toString().split('T').first,
      isActive: json['is_active'] as bool? ?? true,
      notes: json['notes'] as String?,
      source: json['source'] as String? ?? 'medication_reminder',
    );
  }
}

// ── Frequency helpers ───────────────────────────────────────────────────────

const _frequencyValues = [
  'once_daily',
  'twice_daily',
  'thrice_daily',
  'as_needed',
];

String _frequencyLabel(AppLocalizations l, String value) {
  return switch (value) {
    'once_daily' => l.medicationFrequencyOnceDaily,
    'twice_daily' => l.medicationFrequencyTwiceDaily,
    'thrice_daily' => l.medicationFrequencyThriceDaily,
    'as_needed' => l.medicationFrequencyAsNeeded,
    _ => value,
  };
}

// ── Screen ──────────────────────────────────────────────────────────────────

class MedicationRemindersScreen extends StatefulWidget {
  const MedicationRemindersScreen({super.key});

  @override
  State<MedicationRemindersScreen> createState() =>
      _MedicationRemindersScreenState();
}

class _MedicationRemindersScreenState extends State<MedicationRemindersScreen> {
  List<_Reminder> _reminders = [];
  bool _loading = true;
  String? _error;
  bool _didLoad = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_didLoad) return;
    _didLoad = true;
    _loadReminders();
  }

  Future<void> _loadReminders() async {
    final l = AppLocalizations.of(context)!;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final resp = await ApiClient.get('/reminders/medication');
      if (!mounted) return;
      if (resp.isSuccess) {
        final list = resp.dataAsList();
        setState(() {
          _reminders = list
              .map((e) => _Reminder.fromJson(e as Map<String, dynamic>))
              .toList();
          _loading = false;
        });
        _syncNotifications();
      } else {
        setState(() {
          _error = resp.failureMessage(l.medicationRemindersLoadFailed);
          _loading = false;
        });
      }
    } catch (e) {
      if (kDebugMode) debugPrint('Error loading reminders: $e');
      if (mounted) {
        setState(() {
          _error = l.medicationRemindersLoadFailed;
          _loading = false;
        });
      }
    }
  }

  Future<void> _syncNotifications() async {
    try {
      await NotificationScheduler.rescheduleAll(
        _reminders
            .map(
              (r) => <String, dynamic>{
                'id': r.id,
                'medication_name': r.medicationName,
                'dosage': r.dosage,
                'reminder_times': r.reminderTimes,
                'end_date': r.endDate,
                'is_active': r.isActive,
              },
            )
            .toList(),
      );
    } catch (e) {
      if (kDebugMode) debugPrint('Error syncing notifications: $e');
    }
  }

  Future<void> _toggleReminder(_Reminder reminder) async {
    try {
      if (reminder.isActive) {
        // Deactivate
        final resp = await ApiClient.delete(
          '/reminders/medication/${reminder.id}',
        );
        if (mounted && resp.isSuccess) {
          _loadReminders();
        }
      } else {
        // Reactivate by updating is_active
        final resp = await ApiClient.put(
          '/reminders/medication/${reminder.id}',
          body: {
            'medication_name': reminder.medicationName,
            'dosage': reminder.dosage,
            'frequency': reminder.frequency,
            'reminder_times': reminder.reminderTimes,
            'start_date': reminder.startDate,
          },
        );
        if (mounted && resp.isSuccess) {
          _loadReminders();
        }
      }
    } catch (e) {
      if (kDebugMode) debugPrint('Error toggling reminder: $e');
    }
  }

  Future<void> _deleteReminder(int id) async {
    try {
      final resp = await ApiClient.delete('/reminders/medication/$id');
      if (mounted && resp.isSuccess) {
        NotificationScheduler.cancelReminder(id);
        _loadReminders();
      }
    } catch (e) {
      if (kDebugMode) debugPrint('Error deleting reminder: $e');
    }
  }

  void _showAddReminderSheet() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (_) => _AddReminderSheet(
        onSaved: () {
          _loadReminders();
        },
      ),
    );
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;

    return Scaffold(
      appBar: AppBar(title: Text(l.medicationRemindersTitle)),
      floatingActionButton: FloatingActionButton(
        onPressed: _showAddReminderSheet,
        // Accessible name for the icon-only FAB (screen readers announce it;
        // long-press shows it visually).
        tooltip: l.medicationReminderAdd,
        child: const Icon(Icons.add),
      ),
      body: DataStateBuilder<_Reminder>(
        isLoading: _loading,
        error: _error,
        data: _reminders,
        onRetry: _loadReminders,
        onEmptyAction: _showAddReminderSheet,
        emptyIcon: Icons.medication_outlined,
        emptyTitle: l.medicationRemindersEmpty,
        emptySubtitle: l.medicationRemindersEmptyHint,
        emptyActionLabel: l.medicationReminderAdd,
        errorTitle: l.genericError,
        errorActionLabel: l.medicationRemindersRetryButton,
        builder: (context, reminders) {
          return RefreshIndicator(
            onRefresh: _loadReminders,
            child: ListView.builder(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              itemCount: reminders.length,
              itemBuilder: (context, index) {
                final r = reminders[index];
                return _ReminderCard(
                  reminder: r,
                  onToggle: () => _toggleReminder(r),
                  onDelete: () => _deleteReminder(r.id),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

// ── Reminder card ───────────────────────────────────────────────────────────

class _ReminderCard extends StatelessWidget {
  final _Reminder reminder;
  final VoidCallback onToggle;
  final VoidCallback onDelete;

  const _ReminderCard({
    required this.reminder,
    required this.onToggle,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;
    final freq = _frequencyLabel(l, reminder.frequency);
    final times = reminder.reminderTimes.join(', ');

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        reminder.medicationName,
                        style: theme.textTheme.titleMedium?.copyWith(
                          color: reminder.isActive
                              ? null
                              : theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                      if (reminder.isReadOnly)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 2,
                            ),
                            decoration: BoxDecoration(
                              color: theme.colorScheme.secondaryContainer,
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              l.medicationReminderAncSupplement,
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: theme.colorScheme.onSecondaryContainer,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                if (!reminder.isReadOnly) ...[
                  Switch.adaptive(
                    value: reminder.isActive,
                    onChanged: (_) => onToggle(),
                  ),
                  IconButton(
                    icon: const Icon(Icons.delete_outline, size: 20),
                    onPressed: onDelete,
                    tooltip: l.medicationReminderDeleteTooltip,
                  ),
                ],
              ],
            ),
            const SizedBox(height: 4),
            Text(
              l.medicationReminderDosageLine(reminder.dosage),
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 2),
            Text(
              l.medicationReminderFrequencyLine(freq),
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 2),
            Text(
              l.medicationReminderTimesLine(times),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            if (reminder.notes != null && reminder.notes!.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                l.medicationReminderNotesLine(reminder.notes!),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

// ── Add Reminder Sheet ──────────────────────────────────────────────────────

class _AddReminderSheet extends StatefulWidget {
  final VoidCallback onSaved;
  const _AddReminderSheet({required this.onSaved});

  @override
  State<_AddReminderSheet> createState() => _AddReminderSheetState();
}

class _AddReminderSheetState extends State<_AddReminderSheet> {
  final _nameCtrl = TextEditingController();
  final _dosageCtrl = TextEditingController();
  final _notesCtrl = TextEditingController();
  String _frequency = 'once_daily';
  final List<TimeOfDay> _times = [const TimeOfDay(hour: 8, minute: 0)];
  DateTime _startDate = DateTime.now();
  DateTime? _endDate;
  bool _saving = false;

  @override
  void dispose() {
    _nameCtrl.dispose();
    _dosageCtrl.dispose();
    _notesCtrl.dispose();
    super.dispose();
  }

  String _formatTime(TimeOfDay t) =>
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  String _formatDate(DateTime d) =>
      '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Future<void> _pickTime(int index) async {
    final picked = await showTimePicker(
      context: context,
      initialTime: _times[index],
    );
    if (picked != null && mounted) {
      setState(() => _times[index] = picked);
    }
  }

  Future<void> _pickStartDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _startDate,
      firstDate: DateTime.now().subtract(const Duration(days: 30)),
      lastDate: DateTime.now().add(const Duration(days: 365)),
    );
    if (picked != null && mounted) {
      setState(() => _startDate = picked);
    }
  }

  Future<void> _pickEndDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _endDate ?? _startDate.add(const Duration(days: 30)),
      firstDate: _startDate,
      lastDate: _startDate.add(const Duration(days: 365)),
    );
    if (mounted) {
      setState(() => _endDate = picked);
    }
  }

  Future<void> _save() async {
    final l = AppLocalizations.of(context)!;
    final name = _nameCtrl.text.trim();
    final dosage = _dosageCtrl.text.trim();
    if (name.isEmpty || dosage.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l.medicationReminderRequiredFields)),
      );
      return;
    }

    setState(() => _saving = true);

    try {
      final resp = await ApiClient.post(
        '/reminders/medication',
        body: {
          'medication_name': name,
          'dosage': dosage,
          'frequency': _frequency,
          'reminder_times': _times.map(_formatTime).toList(),
          'start_date': _formatDate(_startDate),
          if (_endDate != null) 'end_date': _formatDate(_endDate!),
          if (_notesCtrl.text.trim().isNotEmpty)
            'notes': _notesCtrl.text.trim(),
        },
      );

      if (!mounted) return;

      if (resp.isSuccess) {
        widget.onSaved();
        Navigator.of(context).pop();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(resp.failureMessage(l.medicationReminderSaveFailed)),
          ),
        );
      }
    } catch (e) {
      if (kDebugMode) debugPrint('Error saving reminder: $e');
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l.medicationReminderSaveFailed)));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;

    return Padding(
      padding: EdgeInsets.fromLTRB(24, 24, 24, 24 + bottomInset),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              l.medicationReminderAddSheetTitle,
              style: theme.textTheme.titleLarge,
            ),
            const SizedBox(height: 20),

            // Medication name
            TextField(
              controller: _nameCtrl,
              decoration: InputDecoration(
                labelText: l.medicationReminderName,
                border: const OutlineInputBorder(),
              ),
              textCapitalization: TextCapitalization.words,
            ),
            const SizedBox(height: 12),

            // Dosage
            TextField(
              controller: _dosageCtrl,
              decoration: InputDecoration(
                labelText: l.medicationReminderDosage,
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),

            // Frequency
            DropdownButtonFormField<String>(
              initialValue: _frequency,
              decoration: InputDecoration(
                labelText: l.medicationReminderFrequency,
                border: const OutlineInputBorder(),
              ),
              items: _frequencyValues
                  .map(
                    (v) => DropdownMenuItem(
                      value: v,
                      child: Text(_frequencyLabel(l, v)),
                    ),
                  )
                  .toList(),
              onChanged: (v) {
                if (v != null) setState(() => _frequency = v);
              },
            ),
            const SizedBox(height: 12),

            // Reminder times
            Text(l.medicationReminderTimes, style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            ..._times.asMap().entries.map((entry) {
              final idx = entry.key;
              final t = entry.value;
              return Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => _pickTime(idx),
                        icon: const Icon(Icons.access_time, size: 18),
                        label: Text(_formatTime(t)),
                      ),
                    ),
                    if (_times.length > 1)
                      IconButton(
                        icon: const Icon(Icons.remove_circle_outline, size: 20),
                        onPressed: () => setState(() => _times.removeAt(idx)),
                      ),
                  ],
                ),
              );
            }),
            TextButton.icon(
              onPressed: () => setState(
                () => _times.add(const TimeOfDay(hour: 12, minute: 0)),
              ),
              icon: const Icon(Icons.add, size: 18),
              label: Text(l.medicationReminderAddTime),
            ),
            const SizedBox(height: 12),

            // Start / end date
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _pickStartDate,
                    child: Text(
                      l.medicationReminderStartLine(_formatDate(_startDate)),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: OutlinedButton(
                    onPressed: _pickEndDate,
                    child: Text(
                      _endDate != null
                          ? l.medicationReminderEndLine(_formatDate(_endDate!))
                          : l.medicationReminderNoEndDate,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),

            // Notes
            TextField(
              controller: _notesCtrl,
              decoration: InputDecoration(
                labelText: l.medicationReminderNotesOptional,
                border: const OutlineInputBorder(),
              ),
              maxLines: 2,
            ),
            const SizedBox(height: 20),

            // Save button
            FilledButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(
                      height: 20,
                      width: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text(l.medicationReminderSave),
            ),
          ],
        ),
      ),
    );
  }
}
