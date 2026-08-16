// "My Appointments" tab — lists upcoming + past appointments, handles
// view-prescription and cancel. Extracted from appointments_screen.dart as
// its own StatefulWidget so the screen is just a tab coordinator. The
// parent holds a GlobalKey<AppointmentsListTabState> and calls refresh()
// after a new booking.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';
import 'package:vhhealth/core/offline/patient_cache_invalidation.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/appointments/widgets/appointment_card.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_models.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_route_args.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

class AppointmentsListTab extends StatefulWidget {
  /// Invoked when the empty-state "Book one now" button is tapped — the
  /// parent screen switches to the Book tab.
  final VoidCallback onBookOne;
  final TeleconsultRepository teleconsultRepository;

  const AppointmentsListTab({
    super.key,
    required this.onBookOne,
    this.teleconsultRepository = const TeleconsultRepository(),
  });

  @override
  State<AppointmentsListTab> createState() => AppointmentsListTabState();
}

class AppointmentsListTabState extends State<AppointmentsListTab> {
  static final _secureStorage = VHSecureStorage.instance;

  List<AppointmentInfo> _appointments = [];
  Map<int, TeleconsultLobbyState> _teleconsultStates = const {};
  bool _loadingAppointments = true;
  String? _patientId;
  String? _error;
  WebSocketProvider? _webSocketProvider;
  int _lastAppointmentEventRevision = 0;
  DependentsProvider? _dependentsProvider;
  String? _lastProfileUid;

  @override
  void initState() {
    super.initState();
    _loadPatientId();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final provider = context.read<WebSocketProvider>();
    if (_webSocketProvider != provider) {
      _webSocketProvider?.removeListener(_onWsEvent);
      _webSocketProvider = provider;
      _lastAppointmentEventRevision = provider.appointmentEventRevision;
      // Refresh when the backend pushes a personal appointment/queue event.
      _webSocketProvider?.addListener(_onWsEvent);
    }

    // Track the active acting-as profile: when the guardian switches
    // between self and a linked dependent, re-fetch so the list shows the
    // selected profile's appointments (labelled in build()).
    final depProvider = context.read<DependentsProvider>();
    if (_dependentsProvider != depProvider) {
      _dependentsProvider?.removeListener(_onProfileChanged);
      _dependentsProvider = depProvider;
      _lastProfileUid = depProvider.activeDependent?.uid;
      _dependentsProvider?.addListener(_onProfileChanged);
    }
  }

  void _onProfileChanged() {
    final uid = _dependentsProvider?.activeDependent?.uid;
    if (uid == _lastProfileUid) return;
    _lastProfileUid = uid;
    if (mounted) _fetchAppointments();
  }

  @override
  void dispose() {
    _webSocketProvider?.removeListener(_onWsEvent);
    _dependentsProvider?.removeListener(_onProfileChanged);
    super.dispose();
  }

  void _onWsEvent() {
    final wsProv = _webSocketProvider;
    if (wsProv == null) return;
    if (wsProv.appointmentEventRevision <= _lastAppointmentEventRevision ||
        wsProv.lastAppointmentEvent == null) {
      return;
    }
    _lastAppointmentEventRevision = wsProv.appointmentEventRevision;
    _fetchAppointments();
  }

  /// Re-fetch the appointment list. Called by the parent (via GlobalKey)
  /// after a booking is created on the Book tab.
  void refresh() => _fetchAppointments();

  Future<void> _loadPatientId() async {
    _patientId = await _secureStorage.read(key: 'user_id');
    if (_patientId != null) {
      unawaited(_fetchAppointments());
    } else {
      if (mounted) setState(() => _loadingAppointments = false);
    }
  }

  Future<void> _fetchAppointments() async {
    // The active dependent's appointments when a dependent profile is
    // selected (the request also carries the acting-as header, so the
    // backend authorizes the guardian link); the guardian's own otherwise.
    // Read through the listener-cached provider — this method runs after
    // awaits (e.g. from _loadPatientId), when context lookups are unsafe.
    if (!mounted) return;
    final activeDep = _dependentsProvider?.activeDependent;
    final effectivePatientId = activeDep?.id.toString() ?? _patientId;
    if (effectivePatientId == null) return;
    final l = AppLocalizations.of(context)!;
    setState(() {
      _loadingAppointments = true;
      _error = null;
    });
    try {
      final resp = await ApiClient.get(
        '/appointments/patient/$effectivePatientId',
      );
      if (resp.isSuccess) {
        final data = resp.data ?? {};
        final List<dynamic> raw = data is List
            ? data
            : (data['appointments'] ?? data ?? []);
        final list = raw.map((a) {
          return AppointmentInfo(
            id: a['id'] ?? 0,
            doctorName: a['doctor_name'] ?? a['doctor']?['name'] ?? 'Doctor',
            department: a['department_name'] ?? a['department'] ?? '',
            date: a['appointment_date']?.toString().split('T').first ?? '',
            time: a['appointment_time']?.toString() ?? '',
            status: a['status']?.toString().toLowerCase() ?? 'scheduled',
            reason: a['reason']?.toString(),
            tokenNumber: a['token_number'] != null
                ? int.tryParse(a['token_number'].toString())
                : null,
            confirmationNotes: a['confirmation_notes']?.toString(),
            hasDocuments: false, // updated when documents are fetched
            visitType:
                a['visit_type']?.toString() ?? a['visitType']?.toString() ?? '',
          );
        }).toList();
        if (mounted) {
          setState(() {
            _appointments = list;
            _loadingAppointments = false;
            _teleconsultStates = Map.fromEntries(
              _teleconsultStates.entries.where(
                (entry) => list.any((appt) => appt.id == entry.key),
              ),
            );
          });
          unawaited(_refreshTeleconsultStates(list));
        }
        return;
      }
      if (mounted) {
        setState(() {
          _error = resp.failureMessage(l.appointmentsLoadFailed);
          _loadingAppointments = false;
        });
      }
      return;
    } catch (e) {
      debugPrint('Fetch appointments failed: $e');
    }
    if (mounted) {
      setState(() {
        _error = l.appointmentsLoadFailed;
        _loadingAppointments = false;
      });
    }
  }

  Future<void> _refreshTeleconsultStates(
    List<AppointmentInfo> appointments,
  ) async {
    final teleconsults = appointments
        .where((appt) => appt.isTeleconsult && !appt.hasTerminalStatus)
        .toList();
    if (teleconsults.isEmpty) {
      if (mounted && _teleconsultStates.isNotEmpty) {
        setState(() => _teleconsultStates = const {});
      }
      return;
    }

    for (final appt in teleconsults) {
      try {
        final state = await widget.teleconsultRepository.fetchLobbyState(
          appt.id,
        );
        if (!mounted) return;
        setState(() {
          _teleconsultStates = {..._teleconsultStates, appt.id: state};
        });
      } catch (e) {
        debugPrint('Teleconsult lobby state failed for ${appt.id}: $e');
      }
    }
  }

  void _openAppointmentDetail(AppointmentInfo appt) {
    context.push(
      '/appointments/${appt.id}',
      extra: TeleconsultRouteArgs(
        appointment: appt,
        initialState: _teleconsultStates[appt.id],
        repository: widget.teleconsultRepository,
      ),
    );
  }

  void _openTeleconsultLobby(AppointmentInfo appt) {
    final state = _teleconsultStates[appt.id];
    if (state?.joinable != true) return;
    context.push(
      '/teleconsult/appointments/${appt.id}/lobby',
      extra: TeleconsultRouteArgs(
        appointment: appt,
        initialState: state,
        repository: widget.teleconsultRepository,
      ),
    );
  }

  Future<void> _viewPrescription(AppointmentInfo appt) async {
    final l = AppLocalizations.of(context)!;
    try {
      final resp = await ApiClient.get('/appointments/${appt.id}/documents');
      if (!mounted) return;
      if (resp.isSuccess) {
        final List<dynamic> docs = resp.dataAsList();
        if (docs.isEmpty) {
          _showError(l.appointmentsNoDocuments);
          return;
        }
        // Show a bottom sheet with document links
        unawaited(
          showModalBottomSheet(
            context: context,
            builder: (ctx) => Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    l.appointmentsDocumentsTitle,
                    style: Theme.of(ctx).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 12),
                  ...docs.map((d) {
                    final m = d as Map<String, dynamic>;
                    final url = m['file_url']?.toString();
                    final name =
                        m['file_name'] ??
                        m['document_type'] ??
                        l.appointmentsDocumentFallback;
                    return ListTile(
                      leading: const Icon(Icons.description),
                      title: Text(name),
                      subtitle: Text(
                        m['document_type']?.toString().replaceAll('_', ' ') ??
                            '',
                      ),
                      trailing: url != null
                          ? const Icon(Icons.open_in_new)
                          : null,
                      onTap: url == null
                          ? null
                          : () async {
                              await SafeUrlLauncher.launch(
                                url,
                                mode: LaunchMode.externalApplication,
                              );
                            },
                    );
                  }),
                ],
              ),
            ),
          ),
        );
      } else {
        _showError(l.appointmentsDocumentsLoadFailed);
      }
    } catch (e) {
      _showError(l.appointmentsDocumentsLoadFailed);
    }
  }

  Future<void> _cancelAppointment(AppointmentInfo appt) async {
    final l = AppLocalizations.of(context)!;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.appointmentsCancel),
        content: Text(
          l.appointmentsCancelConfirm(appt.doctorName, appt.date, appt.time),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(l.no),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(l.appointmentsConfirmCancel),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    try {
      final resp = await ApiClient.delete('/appointments/${appt.id}');
      if (resp.isSuccess) {
        await PatientCacheInvalidation.afterAppointmentMutation();
        if (!mounted) return;
        _showSuccess(l.appointmentsCancelledToast);
        unawaited(_fetchAppointments());
      } else {
        _showError(resp.failureMessage(l.appointmentsCancelFailed));
      }
    } catch (e) {
      debugPrint('Cancel appointment failed: $e');
      _showError(l.appointmentsCancelFailed);
    }
  }

  Future<void> _rescheduleAppointment(AppointmentInfo appt) async {
    final l = AppLocalizations.of(context)!;
    final initialDate =
        DateTime.tryParse(appt.date) ??
        DateTime.now().add(const Duration(days: 1));
    final initialTime =
        _parseTimeOfDay(appt.time) ?? const TimeOfDay(hour: 9, minute: 0);
    final noteController = TextEditingController();

    try {
      final choice = await showModalBottomSheet<_RescheduleChoice>(
        context: context,
        isScrollControlled: true,
        builder: (ctx) {
          var selectedDate = initialDate;
          var selectedTime = initialTime;
          return StatefulBuilder(
            builder: (context, setSheetState) {
              final inset = MediaQuery.of(context).viewInsets.bottom;
              return SafeArea(
                child: Padding(
                  padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + inset),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        l.appointmentsRescheduleTitle,
                        style: Theme.of(context).textTheme.titleMedium
                            ?.copyWith(fontWeight: FontWeight.bold),
                      ),
                      const SizedBox(height: 12),
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.event_outlined),
                        title: Text(l.appointmentsRescheduleDate),
                        subtitle: Text(_formatDate(selectedDate)),
                        onTap: () async {
                          final today = _dateOnly(DateTime.now());
                          final picked = await showDatePicker(
                            context: context,
                            initialDate: selectedDate.isBefore(today)
                                ? today
                                : selectedDate,
                            firstDate: today,
                            lastDate: today.add(const Duration(days: 365)),
                          );
                          if (picked != null) {
                            setSheetState(() => selectedDate = picked);
                          }
                        },
                      ),
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.schedule_outlined),
                        title: Text(l.appointmentsRescheduleTime),
                        subtitle: Text(_formatTime(selectedTime)),
                        onTap: () async {
                          final picked = await showTimePicker(
                            context: context,
                            initialTime: selectedTime,
                          );
                          if (picked != null) {
                            setSheetState(() => selectedTime = picked);
                          }
                        },
                      ),
                      TextField(
                        controller: noteController,
                        maxLength: 280,
                        decoration: InputDecoration(
                          labelText: l.appointmentsRescheduleNote,
                          border: const OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          TextButton(
                            onPressed: () => Navigator.pop(ctx),
                            child: Text(l.commonCancelButton),
                          ),
                          const SizedBox(width: 8),
                          FilledButton.icon(
                            onPressed: () => Navigator.pop(
                              ctx,
                              _RescheduleChoice(
                                date: selectedDate,
                                time: selectedTime,
                                note: noteController.text.trim(),
                              ),
                            ),
                            icon: const Icon(Icons.check_outlined),
                            label: Text(l.appointmentsRescheduleReview),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              );
            },
          );
        },
      );
      if (choice == null) return;
      if (!mounted) return;

      final confirmed = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(l.appointmentsReschedule),
          content: Text(
            l.appointmentsRescheduleConfirm(
              appt.doctorName,
              _formatDate(choice.date),
              _formatTime(choice.time),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: Text(l.no),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(l.appointmentsReschedule),
            ),
          ],
        ),
      );
      if (confirmed != true) return;

      final resp = await ApiClient.patch(
        '/appointments/${appt.id}/reschedule',
        body: {
          'appointment_date': _formatDate(choice.date),
          'appointment_time': _formatTime(choice.time),
          if (choice.note.isNotEmpty) 'notes': choice.note,
        },
      );
      if (resp.isSuccess) {
        await PatientCacheInvalidation.afterAppointmentMutation();
        if (!mounted) return;
        _showSuccess(l.appointmentsRescheduledToast);
        unawaited(_fetchAppointments());
      } else {
        _showError(resp.failureMessage(l.appointmentsRescheduleFailed));
      }
    } catch (e) {
      debugPrint('Reschedule appointment failed: $e');
      _showError(l.appointmentsRescheduleFailed);
    } finally {
      noteController.dispose();
    }
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      LiveRegionSnackBar.build(
        message: msg,
        backgroundColor: Theme.of(context).colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  void _showSuccess(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      LiveRegionSnackBar.build(
        message: msg,
        backgroundColor: Theme.of(context).colorScheme.primary,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  Widget _sectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        title,
        style: Theme.of(
          context,
        ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final activeDep = context.watch<DependentsProvider>().activeDependent;

    final body = DataStateBuilder<AppointmentInfo>(
      isLoading: _loadingAppointments,
      error: _patientId == null ? l10n.appointmentsLogOutAndBack : _error,
      data: _appointments,
      onRetry: _patientId == null ? _loadPatientId : _fetchAppointments,
      onEmptyAction: widget.onBookOne,
      emptyIcon: Icons.event_busy,
      emptyTitle: l10n.appointmentsEmpty,
      emptySubtitle: l10n.appointmentsEmptyHint,
      emptyActionLabel: l10n.appointmentsBookOneNow,
      errorTitle: l10n.genericError,
      errorActionLabel: l10n.commonRetry,
      builder: (context, appointments) {
        final upcoming = appointments.where((a) => a.isUpcoming).toList()
          ..sort(
            (a, b) => '${a.date} ${a.time}'.compareTo('${b.date} ${b.time}'),
          );
        final past = appointments.where((a) => !a.isUpcoming).toList()
          ..sort(
            (a, b) => '${b.date} ${b.time}'.compareTo('${a.date} ${a.time}'),
          );
        return RefreshIndicator(
          onRefresh: _fetchAppointments,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              if (upcoming.isNotEmpty) ...[
                _sectionHeader(l10n.appointmentsUpcomingSection),
                ...upcoming.map(
                  (a) => AppointmentCard(
                    appt: a,
                    teleconsultState: _teleconsultStates[a.id],
                    onOpenDetails: () => _openAppointmentDetail(a),
                    onJoinTeleconsult: _openTeleconsultLobby,
                    onViewPrescription: _viewPrescription,
                    onReschedule: _rescheduleAppointment,
                    onCancel: _cancelAppointment,
                  ),
                ),
                const SizedBox(height: 24),
              ],
              if (past.isNotEmpty) ...[
                _sectionHeader(l10n.appointmentsPastSection),
                ...past.map(
                  (a) => AppointmentCard(
                    appt: a,
                    teleconsultState: _teleconsultStates[a.id],
                    onOpenDetails: () => _openAppointmentDetail(a),
                    onJoinTeleconsult: _openTeleconsultLobby,
                    onViewPrescription: _viewPrescription,
                    onReschedule: _rescheduleAppointment,
                    onCancel: _cancelAppointment,
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );

    if (activeDep == null) return body;

    // Clear labelling when viewing a dependent's appointments.
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    return Column(
      children: [
        Container(
          width: double.infinity,
          margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: cs.tertiary.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            children: [
              Icon(Icons.escalator_warning, size: 18, color: cs.tertiary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Showing appointments for ${activeDep.name}',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: cs.tertiary,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ),
        Expanded(child: body),
      ],
    );
  }
}

class _RescheduleChoice {
  const _RescheduleChoice({
    required this.date,
    required this.time,
    required this.note,
  });

  final DateTime date;
  final TimeOfDay time;
  final String note;
}

TimeOfDay? _parseTimeOfDay(String value) {
  final parts = value.split(':');
  if (parts.length < 2) return null;
  final hour = int.tryParse(parts[0]);
  final minute = int.tryParse(parts[1]);
  if (hour == null ||
      minute == null ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59) {
    return null;
  }
  return TimeOfDay(hour: hour, minute: minute);
}

String _formatDate(DateTime value) {
  return '${value.year.toString().padLeft(4, '0')}-'
      '${value.month.toString().padLeft(2, '0')}-'
      '${value.day.toString().padLeft(2, '0')}';
}

String _formatTime(TimeOfDay value) {
  return '${value.hour.toString().padLeft(2, '0')}:'
      '${value.minute.toString().padLeft(2, '0')}';
}

DateTime _dateOnly(DateTime value) =>
    DateTime(value.year, value.month, value.day);
