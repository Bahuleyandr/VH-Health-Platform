// lib/features/safety/widgets/resus_trigger_button.dart
//
// Deliberately-guarded Code Blue / rapid-response trigger (NL-14 P2).
//
// Two explicit steps — collect the minimal event details (kind, patient,
// optional reason/location), then a separate confirmation dialog — so the
// alarm cannot fire from a stray tap or pocket activation. On success the
// durable resuscitation record opens (`/safety/resus/:eventId`); the
// backend owns the realtime notification (emitted post-commit).
//
// The guard runs in both directions. As well as "no accidental fire", the
// confirmation step enforces "no accidental *miss*": it cannot be closed by a
// barrier tap or a back gesture, and if it is ever torn down some other way
// the caller says so out loud instead of treating it as a Cancel. A clinician
// must never be left believing they raised a Code Blue that was never sent.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/services/patient_api_service.dart';
import '../../../core/services/resus_api_service.dart';
import '../../../l10n/app_strings.dart';
import 'resus_event_panel.dart';

const _kEventKinds = <String>['code_blue', 'rapid_response'];

typedef ResusPatientSearch = Future<List<Map<String, dynamic>>> Function(
  String query,
);

typedef ResusCreateEvent = Future<Map<String, dynamic>> Function({
  required String patientUid,
  String eventKind,
  String? reason,
  String? ward,
  String? bedNumber,
  int? admissionId,
  bool isDrill,
});

class ResusTriggerButton extends StatefulWidget {
  const ResusTriggerButton({
    super.key,
    this.searchPatients = PatientApiService.search,
    this.createEvent = ResusApiService.createEvent,
    this.onCreated,
  });

  final ResusPatientSearch searchPatients;
  final ResusCreateEvent createEvent;

  /// Invoked with the created event id. Defaults to opening the resus
  /// documentation route for the event.
  final void Function(int eventId)? onCreated;

  @override
  State<ResusTriggerButton> createState() => _ResusTriggerButtonState();
}

class _ResusTriggerButtonState extends State<ResusTriggerButton> {
  bool _busy = false;

  Future<void> _startFlow() async {
    if (_busy) return;
    final s = AppStrings.of(context);
    final draft = await _collectDraft(s);
    // A `null` draft is an ordinary abandon of the details form: nothing has
    // been escalated, the screen returns unchanged, and the trigger stays on
    // screen — so it needs no announcement. See `_collectDraft` for why that
    // step is guarded differently from the confirmation step.
    if (draft == null || !mounted) return;
    await _confirmAndCreate(s, draft);
  }

  /// Confirmation step plus create, split out of [_startFlow] so the
  /// "escalation was dropped" recovery action can resume here without making
  /// the clinician re-enter the patient and context during an arrest.
  Future<void> _confirmAndCreate(AppStrings s, _ResusDraft draft) async {
    // Re-entrant via the recovery action below, which can outlive this widget.
    if (_busy || !mounted) return;
    final confirmed = await _confirm(s, draft);
    if (!mounted) return;
    if (confirmed == true) {
      await _create(s, draft);
      return;
    }
    // `false` is an explicit Cancel — the clinician chose it, so staying quiet
    // is right. `null` is NOT a choice. The confirmation dialog is barrier- and
    // back-locked, so a `null` can now only mean the route was torn down from
    // underneath us (session timeout redirect, a programmatic pop). That must
    // never read as "cancelled": the clinician would walk away believing the
    // resuscitation team had been called when nothing was sent.
    if (confirmed == null) _warnNotTriggered(s, draft);
  }

  /// Loud, dismissible-by-the-clinician notice that the escalation did **not**
  /// go out, with a one-tap resume that keeps the drafted patient/context.
  void _warnNotTriggered(AppStrings s, _ResusDraft draft) {
    final theme = Theme.of(context);
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(
          backgroundColor: theme.colorScheme.error,
          duration: const Duration(seconds: 10),
          content: Text(
            s.lookup('resus.trigger_not_sent'),
            style: TextStyle(color: theme.colorScheme.onError),
          ),
          action: SnackBarAction(
            label: s.actionRetry,
            textColor: theme.colorScheme.onError,
            onPressed: () => unawaited(_confirmAndCreate(s, draft)),
          ),
        ),
      );
  }

  Future<_ResusDraft?> _collectDraft(AppStrings s) {
    var eventKind = 'code_blue';
    final query = TextEditingController();
    final reason = TextEditingController();
    final ward = TextEditingController();
    final bed = TextEditingController();
    var results = <Map<String, dynamic>>[];
    Map<String, dynamic>? selected;
    var searching = false;
    var searched = false;

    String text(Object? value) => value?.toString().trim() ?? '';

    return showDialog<_ResusDraft>(
      context: context,
      // Guarded more weakly than the confirmation step, on purpose. Dismissing
      // this step cannot lose an escalation — nothing has been triggered yet —
      // so the failure mode here is only the loss of half-entered emergency
      // context (patient search, reason, ward, bed), which still costs seconds
      // during an arrest. So: block the accidental surface (a stray tap on the
      // barrier, easy to hit around a scrolling, keyboard-covered form) but
      // deliberately leave the system back gesture working as a real escape.
      // Back here is equivalent to Cancel and its outcome is self-evident —
      // the unchanged screen with the trigger still on it — which is exactly
      // what is NOT true of the confirmation step below.
      barrierDismissible: false,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) {
          Future<void> runSearch() async {
            final q = query.text.trim();
            if (q.isEmpty || searching) return;
            setDialogState(() => searching = true);
            var rows = const <Map<String, dynamic>>[];
            try {
              rows = await widget.searchPatients(q);
            } catch (_) {
              rows = const [];
            }
            setDialogState(() {
              results = rows
                  .where((row) => text(row['uid']).isNotEmpty)
                  .take(5)
                  .toList();
              searched = true;
              searching = false;
            });
          }

          return AlertDialog(
            title: const AppText('resus.trigger_title'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  DropdownButtonFormField<String>(
                    initialValue: eventKind,
                    decoration: InputDecoration(
                      labelText: s.lookup('resus.trigger_kind'),
                    ),
                    items: [
                      for (final kind in _kEventKinds)
                        DropdownMenuItem(
                          value: kind,
                          child: Text(resusEnumLabel(s, 'event_kind', kind)),
                        ),
                    ],
                    onChanged: (v) =>
                        setDialogState(() => eventKind = v ?? 'code_blue'),
                  ),
                  TextField(
                    controller: query,
                    textInputAction: TextInputAction.search,
                    onSubmitted: (_) => runSearch(),
                    decoration: InputDecoration(
                      labelText: s.lookup('resus.trigger_patient_hint'),
                      suffixIcon: IconButton(
                        icon: const Icon(Icons.search),
                        onPressed: searching ? null : runSearch,
                      ),
                    ),
                  ),
                  if (searching)
                    const Padding(
                      padding: EdgeInsets.all(12),
                      child: Center(child: CircularProgressIndicator()),
                    ),
                  if (!searching &&
                      searched &&
                      results.isEmpty &&
                      selected == null)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 8),
                      child: AppText('resus.trigger_no_results'),
                    ),
                  for (final row in results)
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      selected: selected?['uid'] == row['uid'],
                      leading: Icon(
                        selected?['uid'] == row['uid']
                            ? Icons.radio_button_checked
                            : Icons.radio_button_off,
                      ),
                      title: Text(
                        text(row['name']).isEmpty
                            ? text(row['uid'])
                            : text(row['name']),
                      ),
                      subtitle: Text(
                        [
                          text(row['hospital_number']),
                          text(row['phone']),
                        ].where((part) => part.isNotEmpty).join(' · '),
                      ),
                      onTap: () => setDialogState(() => selected = row),
                    ),
                  TextField(
                    controller: reason,
                    decoration: InputDecoration(
                      labelText: s.lookup('resus.reason'),
                    ),
                  ),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: ward,
                          decoration: InputDecoration(
                            labelText: s.lookup('resus.ward'),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: bed,
                          decoration: InputDecoration(
                            labelText: s.lookup('resus.bed'),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(),
                child: Text(s.actionCancel),
              ),
              FilledButton(
                onPressed: selected == null
                    ? null
                    : () => Navigator.of(ctx).pop(
                        _ResusDraft(
                          patientUid: text(selected!['uid']),
                          patientName: text(selected!['name']),
                          eventKind: eventKind,
                          reason: reason.text.trim().isEmpty
                              ? null
                              : reason.text.trim(),
                          ward: ward.text.trim().isEmpty
                              ? null
                              : ward.text.trim(),
                          bedNumber: bed.text.trim().isEmpty
                              ? null
                              : bed.text.trim(),
                        ),
                      ),
                child: Text(s.actionConfirm),
              ),
            ],
          );
        },
      ),
    );
  }

  Future<bool?> _confirm(AppStrings s, _ResusDraft draft) {
    return showDialog<bool>(
      context: context,
      // The escalation decision itself lives in this dialog, so an accidental
      // dismissal is a patient-safety failure, not an inconvenience: it used to
      // complete the future with `null`, which the caller could not tell apart
      // from an explicit Cancel, and the Code Blue was abandoned with no
      // feedback whatsoever. Both accidental exits are closed — the barrier
      // here, the back gesture via the `PopScope` below. This is "no *silent*
      // cancel", not "no cancel": the deliberate way out stays a plainly
      // visible, screen-reader-labelled Cancel button in `actions`, which is
      // also the escape a locked-down modal owes assistive-technology users
      // once their dismiss gesture is inert.
      barrierDismissible: false,
      builder: (ctx) {
        final theme = Theme.of(ctx);
        return PopScope(
          canPop: false,
          child: AlertDialog(
            icon: Icon(
              Icons.warning_amber_rounded,
              color: theme.colorScheme.error,
            ),
            title: const AppText('resus.trigger_confirm_title'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  s.lookup('resus.trigger_confirm_body'),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 10),
                Text(
                  [
                    resusEnumLabel(s, 'event_kind', draft.eventKind),
                    if (draft.patientName.isNotEmpty) draft.patientName,
                    if (draft.ward != null)
                      '${s.lookup('resus.ward')} ${draft.ward}',
                  ].join(' · '),
                  textAlign: TextAlign.center,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: Text(s.actionCancel),
              ),
              FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: theme.colorScheme.error,
                  foregroundColor: theme.colorScheme.onError,
                ),
                onPressed: () => Navigator.of(ctx).pop(true),
                child: Text(s.lookup('resus.trigger_confirm_action')),
              ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _create(AppStrings s, _ResusDraft draft) async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final row = await widget.createEvent(
        patientUid: draft.patientUid,
        eventKind: draft.eventKind,
        reason: draft.reason,
        ward: draft.ward,
        bedNumber: draft.bedNumber,
      );
      messenger.showSnackBar(
        SnackBar(content: Text(s.lookup('resus.trigger_created'))),
      );
      final id = int.tryParse('${row['id'] ?? ''}');
      if (!mounted || id == null) return;
      if (widget.onCreated != null) {
        widget.onCreated!(id);
      } else {
        unawaited(context.push('/safety/resus/$id'));
      }
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

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return FloatingActionButton.extended(
      heroTag: 'resus-trigger',
      backgroundColor: theme.colorScheme.error,
      foregroundColor: theme.colorScheme.onError,
      onPressed: _busy ? null : _startFlow,
      icon: const Icon(Icons.emergency_outlined),
      label: const AppText('resus.trigger_button'),
    );
  }
}

class _ResusDraft {
  const _ResusDraft({
    required this.patientUid,
    required this.patientName,
    required this.eventKind,
    this.reason,
    this.ward,
    this.bedNumber,
  });

  final String patientUid;
  final String patientName;
  final String eventKind;
  final String? reason;
  final String? ward;
  final String? bedNumber;
}
