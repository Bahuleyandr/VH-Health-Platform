// "My Appointments" tab — lists upcoming + past appointments, handles
// view-prescription and cancel. Extracted from appointments_screen.dart as
// its own StatefulWidget so the screen is just a tab coordinator. The
// parent holds a GlobalKey<AppointmentsListTabState> and calls refresh()
// after a new booking.
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:vhhealth/core/providers/websocket_provider.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/appointments/widgets/appointment_card.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class AppointmentsListTab extends StatefulWidget {
  /// Invoked when the empty-state "Book one now" button is tapped — the
  /// parent screen switches to the Book tab.
  final VoidCallback onBookOne;

  const AppointmentsListTab({super.key, required this.onBookOne});

  @override
  State<AppointmentsListTab> createState() => AppointmentsListTabState();
}

class AppointmentsListTabState extends State<AppointmentsListTab> {
  static final _secureStorage = VHSecureStorage.instance;

  List<AppointmentInfo> _appointments = [];
  bool _loadingAppointments = true;
  String? _patientId;
  String? _error;
  WebSocketProvider? _webSocketProvider;

  @override
  void initState() {
    super.initState();
    _loadPatientId();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final provider = context.read<WebSocketProvider>();
    if (_webSocketProvider == provider) return;
    _webSocketProvider?.removeListener(_onWsEvent);
    _webSocketProvider = provider;
    // Refresh when the backend pushes an appointment-status-changed event.
    _webSocketProvider?.addListener(_onWsEvent);
  }

  @override
  void dispose() {
    _webSocketProvider?.removeListener(_onWsEvent);
    super.dispose();
  }

  void _onWsEvent() {
    final wsProv = _webSocketProvider;
    if (wsProv == null) return;
    final event = wsProv.lastAppointmentEvent;
    if (event != null) {
      wsProv.clearAppointmentEvent();
      _fetchAppointments();
    }
  }

  /// Re-fetch the appointment list. Called by the parent (via GlobalKey)
  /// after a booking is created on the Book tab.
  void refresh() => _fetchAppointments();

  Future<void> _loadPatientId() async {
    _patientId = await _secureStorage.read(key: 'user_id');
    if (_patientId != null) {
      _fetchAppointments();
    } else {
      if (mounted) setState(() => _loadingAppointments = false);
    }
  }

  Future<void> _fetchAppointments() async {
    if (_patientId == null) return;
    final l = AppLocalizations.of(context)!;
    setState(() {
      _loadingAppointments = true;
      _error = null;
    });
    try {
      final resp = await ApiClient.get('/appointments/patient/$_patientId');
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
          );
        }).toList();
        if (mounted) {
          setState(() {
            _appointments = list;
            _loadingAppointments = false;
          });
        }
        return;
      }
      if (mounted) {
        setState(() {
          _error = resp.message ?? l.appointmentsLoadFailed;
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
                      m['document_type']?.toString().replaceAll('_', ' ') ?? '',
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
        _showSuccess(l.appointmentsCancelledToast);
        _fetchAppointments();
      } else {
        _showError(resp.message ?? l.appointmentsCancelFailed);
      }
    } catch (e) {
      debugPrint('Cancel appointment failed: $e');
      _showError(l.appointmentsCancelFailed);
    }
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: Theme.of(context).colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  void _showSuccess(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
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

    return DataStateBuilder<AppointmentInfo>(
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
      errorActionLabel: l10n.commonRetryButton,
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
                    onViewPrescription: _viewPrescription,
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
                    onViewPrescription: _viewPrescription,
                    onCancel: _cancelAppointment,
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}
