// ignore_for_file: invalid_use_of_protected_member

part of '../front_office_workbench_screen.dart';

extension _FrontOfficeWorkbenchQueueDialogs
    on _FrontOfficeWorkbenchScreenState {
  Future<bool> _confirmQueueAction({
    required String title,
    required String message,
    required String confirmLabel,
    Color? confirmColor,
  }) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const AppText('action.cancel'),
          ),
          FilledButton(
            style: confirmColor == null
                ? null
                : FilledButton.styleFrom(backgroundColor: confirmColor),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
    return confirmed == true;
  }

  Future<void> _runQueueAction(
    Map<String, dynamic> row, {
    required String successMessage,
    required Future<void> Function(int id) action,
  }) async {
    final id = _appointmentId(row);
    if (id == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.front_office_workbench.appointment_id_is_missing',
          ),
        ),
      );
      return;
    }

    setState(() {
      _queueActionId = id;
      _error = null;
    });
    try {
      await action(id);
      await _refreshWorklists();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(successMessage),
          backgroundColor: AppTheme.successGreen,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(
        () => _error = localizedApiErrorFromRaw(AppStrings.of(context), e),
      );
    } finally {
      if (mounted) setState(() => _queueActionId = null);
    }
  }

  Future<void> _confirmQueueAppointment(Map<String, dynamic> row) async {
    final s = AppStrings.of(context);
    await _runQueueAction(
      row,
      successMessage: s.apptQueueConfirmedToast,
      action: (id) => ScheduleApiService.confirmAppointment(id, {
        'confirmation_notes': 'Checked in from Front Office Workbench',
      }).then((_) {}),
    );
  }

  Future<void> _arrivalCheckInQueueAppointment(Map<String, dynamic> row) async {
    final s = AppStrings.of(context);
    await _runQueueAction(
      row,
      successMessage: s.lookup(
        's4.lib.front_office_workbench.arrival_checked_in',
      ),
      action: (id) => ScheduleApiService.supervisedKioskCheckIn(
        appointmentId: id,
        department: _queueDepartment(row),
      ).then((_) {}),
    );
  }

  Future<void> _completeQueueAppointment(Map<String, dynamic> row) async {
    final s = AppStrings.of(context);
    final successMessage = s.apptQueueCompletedToast;
    final notesCtrl = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const AppText(
          's4.lib.front_office_workbench.complete_appointment',
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AppText(
              's4.dynamic.front_office.mark_completed',
              values: {'patient': _queuePatientName(row, strings: s)},
            ),
            const SizedBox(height: 12),
            TextField(
              controller: notesCtrl,
              maxLines: 2,
              decoration: InputDecoration(
                labelText: s.lookup(
                  's4.lib.front_office_workbench.visit_notes_optional',
                ),
                prefixIcon: const Icon(Icons.notes_outlined),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const AppText('action.cancel'),
          ),
          FilledButton.icon(
            onPressed: () => Navigator.pop(dialogContext, true),
            icon: const Icon(Icons.done_all),
            label: const AppText('front_office.appointment_status.completed'),
          ),
        ],
      ),
    );
    final notes = notesCtrl.text.trim();
    notesCtrl.dispose();
    if (confirmed != true) return;

    await _runQueueAction(
      row,
      successMessage: successMessage,
      action: (id) => ScheduleApiService.completeAppointmentStaff(
        id,
        notes: notes.isEmpty ? null : notes,
      ).then((_) {}),
    );
  }

  Future<void> _markQueueNoShow(Map<String, dynamic> row) async {
    final s = AppStrings.of(context);
    final confirmed = await _confirmQueueAction(
      title: s.apptQueueNoShowTitle,
      message: s.apptQueueNoShowBody(_queuePatientName(row, strings: s)),
      confirmLabel: s.frontOfficeAppointmentStatusLabel('NO_SHOW'),
      confirmColor: AppTheme.textSecondary,
    );
    if (!confirmed) return;
    await _runQueueAction(
      row,
      successMessage: s.apptQueueNoShowMarked,
      action: (id) => ScheduleApiService.markNoShow(id).then((_) {}),
    );
  }

  Future<void> _rescheduleQueueAppointment(Map<String, dynamic> row) async {
    final s = AppStrings.of(context);
    final currentDate = _appointmentDate(row) ?? _queueDate;
    final currentTime = _appointmentTime(row) ?? TimeOfDay.now();
    var appointmentDate = currentDate;
    var appointmentTime = currentTime;
    final notesCtrl = TextEditingController();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) {
          Future<void> pickDate() async {
            final picked = await showDatePicker(
              context: dialogContext,
              initialDate: appointmentDate,
              firstDate: DateTime.now().subtract(const Duration(days: 1)),
              lastDate: DateTime.now().add(const Duration(days: 365)),
            );
            if (picked != null) {
              setDialogState(() => appointmentDate = picked);
            }
          }

          Future<void> pickTime() async {
            final picked = await showTimePicker(
              context: dialogContext,
              initialTime: appointmentTime,
            );
            if (picked != null) {
              setDialogState(() => appointmentTime = picked);
            }
          }

          return AlertDialog(
            title: const AppText(
              's4.lib.front_office_workbench.reschedule_appointment',
            ),
            content: SizedBox(
              width: 420,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_queuePatientName(row, strings: s)),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: _DateTimeButton(
                          icon: Icons.calendar_today,
                          label: DateFormat('dd MMM yyyy')
                              .format(appointmentDate),
                          onTap: pickDate,
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: _DateTimeButton(
                          icon: Icons.schedule,
                          label: appointmentTime.format(dialogContext),
                          onTap: pickTime,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: notesCtrl,
                    maxLines: 2,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(
                        context,
                      ).lookup('s4.lib.front_office_workbench.reschedule_note'),
                      prefixIcon: const Icon(Icons.notes_outlined),
                    ),
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: const AppText('action.cancel'),
              ),
              FilledButton.icon(
                onPressed: () => Navigator.pop(dialogContext, true),
                icon: const Icon(Icons.event_repeat_outlined),
                label: const AppText(
                  's4.lib.front_office_workbench.reschedule',
                ),
              ),
            ],
          );
        },
      ),
    );
    final notes = notesCtrl.text.trim();
    notesCtrl.dispose();
    if (confirmed != true) return;

    await _runQueueAction(
      row,
      successMessage: s.lookup(
        's4.lib.front_office_workbench.appointment_rescheduled',
      ),
      action: (id) => ScheduleApiService.rescheduleAppointmentStaff(
        id,
        appointmentDate: _dateParam(appointmentDate),
        appointmentTime: _formatTime(appointmentTime),
        notes: notes.isEmpty
            ? 'Rescheduled from Front Office Workbench'
            : notes,
      ).then((_) {}),
    );
  }

  Future<void> _cancelQueueAppointment(Map<String, dynamic> row) async {
    final s = AppStrings.of(context);
    final reasonCtrl = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const AppText(
          's4.lib.front_office_workbench.cancel_appointment',
        ),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(_queuePatientName(row, strings: s)),
              const SizedBox(height: 12),
              TextField(
                controller: reasonCtrl,
                maxLines: 2,
                decoration: InputDecoration(
                  labelText: AppStrings.of(
                    context,
                  ).lookup('s4.lib.front_office_workbench.cancellation_reason'),
                  prefixIcon: const Icon(Icons.notes_outlined),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const AppText(
              's4.lib.front_office_workbench.keep_appointment',
            ),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppTheme.errorRed),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const AppText(
              's4.lib.front_office_workbench.cancel_appointment',
            ),
          ),
        ],
      ),
    );
    final reason = reasonCtrl.text.trim();
    reasonCtrl.dispose();
    if (confirmed != true) return;

    await _runQueueAction(
      row,
      successMessage: s.lookup(
        's4.lib.front_office_workbench.appointment_cancelled',
      ),
      action: (id) => ScheduleApiService.cancelAppointmentStaff(
        id,
        reason: reason.isEmpty
            ? 'Cancelled from Front Office Workbench'
            : reason,
      ).then((_) {}),
    );
  }
}
