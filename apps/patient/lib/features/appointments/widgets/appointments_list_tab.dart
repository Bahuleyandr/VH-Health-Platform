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

  @override
  void initState() {
    super.initState();
    _loadPatientId();
    // Refresh when the backend pushes an appointment-status-changed event.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        context.read<WebSocketProvider>().addListener(_onWsEvent);
      }
    });
  }

  @override
  void dispose() {
    context.read<WebSocketProvider>().removeListener(_onWsEvent);
    super.dispose();
  }

  void _onWsEvent() {
    final wsProv = context.read<WebSocketProvider>();
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
    setState(() => _loadingAppointments = true);
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
    } catch (e) {
      debugPrint('Fetch appointments failed: $e');
    }
    if (mounted) setState(() => _loadingAppointments = false);
  }

  Future<void> _viewPrescription(AppointmentInfo appt) async {
    try {
      final resp = await ApiClient.get('/appointments/${appt.id}/documents');
      if (!mounted) return;
      if (resp.isSuccess) {
        final List<dynamic> docs = resp.dataAsList();
        if (docs.isEmpty) {
          _showError('No documents available for this appointment');
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
                  'Documents',
                  style: Theme.of(ctx).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 12),
                ...docs.map((d) {
                  final m = d as Map<String, dynamic>;
                  final url = m['file_url']?.toString();
                  final name =
                      m['file_name'] ?? m['document_type'] ?? 'Document';
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
        _showError('Failed to load documents');
      }
    } catch (e) {
      _showError('Failed to load documents');
    }
  }

  Future<void> _cancelAppointment(AppointmentInfo appt) async {
    final l = AppLocalizations.of(context)!;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.appointmentsCancel),
        content: Text(
          'Cancel appointment with ${appt.doctorName} on ${appt.date} at ${appt.time}?',
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
        _showSuccess('Appointment cancelled');
        _fetchAppointments();
      } else {
        _showError('Failed to cancel appointment');
      }
    } catch (e) {
      debugPrint('Cancel appointment failed: $e');
      _showError('Failed to cancel appointment');
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
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;
    if (_loadingAppointments) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_patientId == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Text(
            l10n.appointmentsLogOutAndBack,
            textAlign: TextAlign.center,
          ),
        ),
      );
    }

    if (_appointments.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.event_busy,
              size: 64,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: 16),
            Text(
              l10n.appointmentsEmpty,
              style: TextStyle(
                fontSize: 16,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 8),
            TextButton.icon(
              onPressed: widget.onBookOne,
              icon: const Icon(Icons.add),
              label: Text(l10n.appointmentsBookOneNow),
            ),
          ],
        ),
      );
    }

    final upcoming = _appointments.where((a) => a.isUpcoming).toList()
      ..sort((a, b) => '${a.date} ${a.time}'.compareTo('${b.date} ${b.time}'));
    final past = _appointments.where((a) => !a.isUpcoming).toList()
      ..sort((a, b) => '${b.date} ${b.time}'.compareTo('${a.date} ${a.time}'));

    return RefreshIndicator(
      onRefresh: _fetchAppointments,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (upcoming.isNotEmpty) ...[
            _sectionHeader('Upcoming'),
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
            _sectionHeader('Past'),
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
  }
}
