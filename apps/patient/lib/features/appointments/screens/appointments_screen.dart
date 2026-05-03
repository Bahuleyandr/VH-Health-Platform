import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';
import 'package:vhhealth/core/utils/calendar_utils.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/widgets/contact_banner.dart';
import 'package:vhhealth/generated/app_localizations.dart';

// ─── Data models ────────────────────────────────────────────────────────────

class _DeptInfo {
  final int id;
  final String name;
  final List<_DoctorInfo> doctors;
  const _DeptInfo({
    required this.id,
    required this.name,
    required this.doctors,
  });
}

class _DoctorInfo {
  final int id;
  final String name;
  final String? specialization;
  const _DoctorInfo({
    required this.id,
    required this.name,
    this.specialization,
  });
}

class _AppointmentInfo {
  final int id;
  final String doctorName;
  final String department;
  final String date;
  final String time;
  final String status;
  final String? reason;
  final int? tokenNumber;
  final String? confirmationNotes;
  final bool hasDocuments;

  const _AppointmentInfo({
    required this.id,
    required this.doctorName,
    required this.department,
    required this.date,
    required this.time,
    required this.status,
    this.reason,
    this.tokenNumber,
    this.confirmationNotes,
    this.hasDocuments = false,
  });

  bool get isUpcoming {
    final dt = DateTime.tryParse('$date $time');
    return dt != null && dt.isAfter(DateTime.now()) && status != 'cancelled';
  }
}

// ─── Screen ─────────────────────────────────────────────────────────────────

class AppointmentsScreen extends StatefulWidget {
  final String phone;
  const AppointmentsScreen({super.key, required this.phone});

  @override
  State<AppointmentsScreen> createState() => _AppointmentsScreenState();
}

class _AppointmentsScreenState extends State<AppointmentsScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  // ── Book tab state ──
  final _formKey = GlobalKey<FormState>();
  final _phoneController = TextEditingController();
  final _reasonController = TextEditingController();

  List<_DeptInfo> _departments = [];
  _DeptInfo? _selectedDept;
  _DoctorInfo? _selectedDoctor;
  DateTime? _selectedDate;
  TimeOfDay? _selectedTime;

  // Slot picker state
  List<Map<String, dynamic>> _availableSlots = [];
  bool _loadingSlots = false;
  String? _selectedSlotTime; // "HH:mm"

  bool _loadingDepts = true;
  bool _submitting = false;
  late final bool _isGuest;

  // ── My Appointments tab state ──
  List<_AppointmentInfo> _appointments = [];
  bool _loadingAppointments = true;
  String? _patientId;

  static const _secureStorage = FlutterSecureStorage();

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _isGuest =
        widget.phone.trim().isEmpty || widget.phone.toLowerCase() == 'guest';
    _phoneController.text = _isGuest ? '' : widget.phone;
    _loadPatientId();
    _fetchDepartments();

    // Listen to WS appointment-status-changed events.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<WebSocketProvider>().addListener(_onWsEvent);
    });
  }

  void _onWsEvent() {
    final wsProv = context.read<WebSocketProvider>();
    final event = wsProv.lastAppointmentEvent;
    if (event != null) {
      wsProv.clearAppointmentEvent();
      _fetchAppointments();
    }
  }

  @override
  void dispose() {
    context.read<WebSocketProvider>().removeListener(_onWsEvent);
    _tabController.dispose();
    _phoneController.dispose();
    _reasonController.dispose();
    super.dispose();
  }

  Future<void> _loadPatientId() async {
    _patientId = await _secureStorage.read(key: 'user_id');
    if (_patientId != null) {
      _fetchAppointments();
    } else {
      if (mounted) setState(() => _loadingAppointments = false);
    }
  }

  // ── Departments & doctors ──────────────────────────────────────────────────

  Future<void> _fetchDepartments() async {
    try {
      final resp = await ApiClient.get('/departments/departments-with-doctors');
      if (resp.isSuccess) {
        final rawData = resp.data;
        final List<dynamic> depts = rawData is Map
            ? (rawData['departments'] ?? [])
            : (rawData ?? []);

        final parsed = <_DeptInfo>[];
        for (final dept in depts) {
          final id = dept['id'];
          final name = dept['name']?.toString() ?? '';
          if (id == null || name.isEmpty) continue;

          final rawDoctors = dept['doctors'] as List<dynamic>? ?? [];
          final doctors = rawDoctors
              .where((d) => d['id'] != null)
              .map(
                (d) => _DoctorInfo(
                  id: d['id'] as int,
                  name: d['name']?.toString() ?? 'Doctor',
                  specialization: d['specialization']?.toString(),
                ),
              )
              .toList();

          parsed.add(
            _DeptInfo(
              id: id is int ? id : int.parse(id.toString()),
              name: name,
              doctors: doctors,
            ),
          );
        }

        if (mounted) {
          setState(() {
            _departments = parsed;
            _loadingDepts = false;
          });
        }
        return;
      }
    } catch (e) {
      debugPrint('Fetch departments failed: $e');
    }
    if (mounted) setState(() => _loadingDepts = false);
  }

  // ── Appointments list ──────────────────────────────────────────────────────

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
          return _AppointmentInfo(
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

  // ── Submit booking ─────────────────────────────────────────────────────────

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate() || _submitting) return;
    if (_selectedDate == null) {
      _showError('Please select a date');
      return;
    }
    // When slots are shown, require a slot selection
    if (_availableSlots.isNotEmpty && _selectedSlotTime == null) {
      _showError('Please select an available time slot');
      return;
    }
    if (_availableSlots.isEmpty && _selectedTime == null) {
      _showError(AppLocalizations.of(context)!.selectDoctorAndDate);
      return;
    }
    if (_selectedDoctor == null) {
      _showError('Please select a doctor');
      return;
    }
    if (_patientId == null) {
      _showError('User session not found. Please log out and log back in.');
      return;
    }

    final l10n = AppLocalizations.of(context)!;
    final date = _selectedDate!;
    final time = _selectedTime!;
    final dateStr =
        '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
    final timeStr =
        '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';

    setState(() => _submitting = true);

    try {
      final resp = await ApiClient.post(
        '/appointments/book',
        body: {
          'patient_id': int.parse(_patientId!),
          'doctor_id': _selectedDoctor!.id,
          'appointment_date': dateStr,
          'appointment_time': timeStr,
          'reason': _reasonController.text.trim().isEmpty
              ? 'General consultation'
              : _reasonController.text.trim(),
        },
      );

      if (!mounted) return;
      setState(() => _submitting = false);

      if (resp.isSuccess) {
        _showSuccess(l10n.appointmentConfirmationNote);
        _reasonController.clear();

        // Calendar integration
        final start = DateTime(
          date.year,
          date.month,
          date.day,
          time.hour,
          time.minute,
        );
        final end = start.add(const Duration(minutes: 30));
        final doctor = _selectedDoctor?.name ?? l10n.generalDoctor;

        final auto = await _getAutoAddToCalendar();
        if (auto) {
          await addEventToCalendar(
            title: l10n.calendarEventTitle,
            description: l10n.calendarEventDescription(doctor),
            startDate: start,
            endDate: end,
            location: l10n.calendarEventLocation,
          );
        } else {
          await _promptCalendarSync(l10n, doctor, start, end);
        }

        // Switch to My Appointments tab and refresh
        _tabController.animateTo(1);
        _fetchAppointments();
      } else {
        _showError(resp.message ?? l10n.appointmentFailed);
      }
    } catch (e) {
      debugPrint('Appointment booking failed: $e');
      setState(() => _submitting = false);
      _showError(l10n.genericError);
    }
  }

  // ── View prescription/documents ───────────────────────────────────────────

  Future<void> _viewPrescription(_AppointmentInfo appt) async {
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

  // ── Cancel appointment ─────────────────────────────────────────────────────

  Future<void> _cancelAppointment(_AppointmentInfo appt) async {
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

  // ── Helpers ────────────────────────────────────────────────────────────────

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

  Future<bool> _getAutoAddToCalendar() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool('auto_add_to_calendar') ?? false;
  }

  Future<void> _setAutoAddToCalendar(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('auto_add_to_calendar', value);
  }

  Future<void> _promptCalendarSync(
    AppLocalizations l10n,
    String doctor,
    DateTime start,
    DateTime end,
  ) async {
    await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l10n.calendarSyncTitle),
        content: Text(l10n.calendarSyncPrompt),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(l10n.no),
          ),
          TextButton(
            onPressed: () async {
              Navigator.pop(ctx, true);
              await _setAutoAddToCalendar(true);
              await addEventToCalendar(
                title: l10n.calendarEventTitle,
                description: l10n.calendarEventDescription(doctor),
                startDate: start,
                endDate: end,
                location: l10n.calendarEventLocation,
              );
            },
            child: Text(l10n.yesAlways),
          ),
        ],
      ),
    );
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _selectedDate ?? now.add(const Duration(days: 1)),
      firstDate: now,
      lastDate: now.add(const Duration(days: 90)),
    );
    if (picked != null && mounted) {
      setState(() => _selectedDate = picked);
      _fetchSlots();
    }
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: _selectedTime ?? const TimeOfDay(hour: 9, minute: 0),
    );
    if (picked != null && mounted) setState(() => _selectedTime = picked);
  }

  Future<void> _fetchSlots() async {
    if (_selectedDoctor == null || _selectedDate == null) return;
    final dateStr =
        '${_selectedDate!.year}-${_selectedDate!.month.toString().padLeft(2, '0')}-${_selectedDate!.day.toString().padLeft(2, '0')}';
    setState(() {
      _loadingSlots = true;
      _availableSlots = [];
      _selectedSlotTime = null;
      _selectedTime = null;
    });
    try {
      final resp = await ApiClient.get(
        '/appointments/slots',
        queryParameters: {
          'doctor_id': _selectedDoctor!.id.toString(),
          'date': dateStr,
        },
      );
      if (resp.isSuccess) {
        final data = resp.dataAsMap();
        if (data['available'] == false) {
          // Doctor not available this day
          if (mounted) setState(() => _availableSlots = []);
        } else {
          final slots = (data['slots'] as List<dynamic>? ?? [])
              .map((s) => s as Map<String, dynamic>)
              .toList();
          if (mounted) setState(() => _availableSlots = slots);
        }
      }
    } catch (e) {
      debugPrint('Fetch appointment slots failed: $e');
    } finally {
      if (mounted) setState(() => _loadingSlots = false);
    }
  }

  String _deptLabel(AppLocalizations l10n, String englishName) {
    switch (englishName.toLowerCase()) {
      case 'cardiology':
        return l10n.cardiology;
      case 'neurology':
        return l10n.neurology;
      case 'orthopedics':
        return l10n.orthopedics;
      case 'dermatology':
        return l10n.dermatology;
      case 'pediatrics':
        return l10n.pediatrics;
      case 'general medicine':
        return l10n.general_medicine;
      default:
        return englishName;
    }
  }

  Color _statusColor(String status) {
    switch (status.toLowerCase()) {
      case 'scheduled':
        return Colors.orange;
      case 'confirmed':
        return const Color(0xFF00796B); // teal
      case 'in_progress':
        return Colors.blue;
      case 'completed':
        return Colors.green;
      case 'cancelled':
        return Colors.red;
      case 'no_show':
        return Colors.grey;
      default:
        return Colors.blueGrey;
    }
  }

  String _statusLabel(String status) {
    switch (status.toLowerCase()) {
      case 'scheduled':
        return 'Scheduled';
      case 'confirmed':
        return 'Confirmed ✓';
      case 'in_progress':
        return 'In Progress';
      case 'completed':
        return 'Completed';
      case 'cancelled':
        return 'Cancelled';
      case 'no_show':
        return 'No Show';
      default:
        return status.isNotEmpty
            ? status[0].toUpperCase() + status.substring(1)
            : status;
    }
  }

  Future<void> _triggerSOS() async {
    final l10n = AppLocalizations.of(context)!;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(l10n.authSosTriggered),
        backgroundColor: Theme.of(context).colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );
    await SOSService.triggerSOS();
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return FeatureScreenScaffold(
      title: l10n.requestAppointment,
      icon: Icons.calendar_month_outlined,
      color: FeatureScreenScaffold.featureColors['appointments']!,
      heroTag: 'appointments',
      floatingActionButton: FloatingActionButton(
        onPressed: _triggerSOS,
        tooltip: l10n.authSosTooltip,
        backgroundColor: Colors.red,
        child: const Icon(Icons.favorite),
      ),
      child: Column(
        children: [
          TabBar(
            controller: _tabController,
            tabs: [
              Tab(text: 'Book', icon: Icon(Icons.add_circle_outline)),
              Tab(text: 'My Appointments', icon: Icon(Icons.list_alt)),
            ],
          ),
          ContactBanner.appointments(),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [_buildBookTab(l10n), _buildAppointmentsTab()],
            ),
          ),
        ],
      ),
    );
  }

  // ── Book tab ───────────────────────────────────────────────────────────────

  Widget _buildBookTab(AppLocalizations l10n) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (_isGuest) ...[
            Text(l10n.enterYourPhone, style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            TextFormField(
              controller: _phoneController,
              keyboardType: TextInputType.phone,
              decoration: InputDecoration(labelText: l10n.authPhoneNumber),
              validator: (v) => v == null || v.trim().length != 10
                  ? l10n.enterValidPhone
                  : null,
              style: theme.textTheme.bodyLarge,
            ),
            const SizedBox(height: 16),
          ],

          // Department dropdown
          if (_loadingDepts)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Center(child: CircularProgressIndicator()),
            )
          else
            DropdownButtonFormField<_DeptInfo>(
              initialValue: _selectedDept,
              decoration: InputDecoration(
                labelText: l10n.chooseDepartmentOrDoctor,
              ),
              items: _departments.map((dept) {
                return DropdownMenuItem(
                  value: dept,
                  child: Text(_deptLabel(l10n, dept.name)),
                );
              }).toList(),
              onChanged: (val) {
                setState(() {
                  _selectedDept = val;
                  _selectedDoctor = null;
                  _availableSlots = [];
                  _selectedSlotTime = null;
                  _selectedTime = null;
                });
              },
              validator: (v) => v == null ? l10n.selectDoctorAndDate : null,
              style: theme.textTheme.bodyLarge?.copyWith(color: cs.onSurface),
              dropdownColor: theme.cardColor,
              iconEnabledColor: cs.primary,
            ),
          const SizedBox(height: 12),

          // Doctor dropdown
          if (_selectedDept != null && _selectedDept!.doctors.isNotEmpty)
            DropdownButtonFormField<_DoctorInfo>(
              initialValue: _selectedDoctor,
              decoration: InputDecoration(
                labelText: l10n.selectDoctorPlaceholder,
              ),
              items: _selectedDept!.doctors
                  .map(
                    (doc) => DropdownMenuItem(
                      value: doc,
                      child: Text(
                        doc.specialization != null
                            ? '${doc.name} (${doc.specialization})'
                            : doc.name,
                      ),
                    ),
                  )
                  .toList(),
              onChanged: (val) {
                setState(() {
                  _selectedDoctor = val;
                  _availableSlots = [];
                  _selectedSlotTime = null;
                  _selectedTime = null;
                });
                if (val != null && _selectedDate != null) _fetchSlots();
              },
              validator: (v) => v == null ? 'Please select a doctor' : null,
              style: theme.textTheme.bodyLarge?.copyWith(color: cs.onSurface),
              dropdownColor: theme.cardColor,
              iconEnabledColor: cs.primary,
            ),
          const SizedBox(height: 12),

          // Reason
          TextFormField(
            controller: _reasonController,
            decoration: const InputDecoration(
              labelText: 'Reason for visit',
              hintText: 'e.g. Regular checkup, headache, follow-up...',
            ),
            maxLines: 2,
            style: theme.textTheme.bodyLarge,
          ),
          const SizedBox(height: 12),

          // Date picker
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.calendar_today, color: cs.primary),
            title: Text(
              _selectedDate != null
                  ? '${_selectedDate!.day.toString().padLeft(2, '0')}/${_selectedDate!.month.toString().padLeft(2, '0')}/${_selectedDate!.year}'
                  : 'Select Date',
              style: theme.textTheme.bodyLarge,
            ),
            trailing: Icon(Icons.arrow_drop_down, color: cs.onSurface),
            onTap: _pickDate,
          ),

          // Time slot picker
          if (_loadingSlots)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
            )
          else if (_availableSlots.isNotEmpty) ...[
            Padding(
              padding: const EdgeInsets.only(top: 4, bottom: 8),
              child: Text(
                l10n.appointmentsSelectTimeSlot,
                style: theme.textTheme.bodyMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: _availableSlots.map((slot) {
                final time = slot['time'] as String;
                final available = slot['available'] as bool? ?? false;
                final isSelected = _selectedSlotTime == time;
                return GestureDetector(
                  onTap: available
                      ? () {
                          setState(() {
                            _selectedSlotTime = time;
                            final parts = time.split(':');
                            _selectedTime = TimeOfDay(
                              hour: int.parse(parts[0]),
                              minute: int.parse(parts[1]),
                            );
                          });
                        }
                      : null,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 8,
                    ),
                    decoration: BoxDecoration(
                      color: isSelected
                          ? const Color(0xFF00796B)
                          : available
                          ? const Color(0xFFE0F2F1)
                          : theme.colorScheme.surfaceContainerLow,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(
                        color: isSelected
                            ? const Color(0xFF00796B)
                            : available
                            ? const Color(0xFF80CBC4)
                            : theme.colorScheme.outlineVariant,
                      ),
                    ),
                    child: Text(
                      time,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w500,
                        color: isSelected
                            ? Colors.white
                            : available
                            ? const Color(0xFF00796B)
                            : theme.colorScheme.onSurfaceVariant,
                        decoration: available
                            ? null
                            : TextDecoration.lineThrough,
                      ),
                    ),
                  ),
                );
              }).toList(),
            ),
            if (_selectedSlotTime != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  'Selected: $_selectedSlotTime',
                  style: TextStyle(
                    fontSize: 12,
                    color: const Color(0xFF00796B),
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
          ] else ...[
            // Fallback: manual time picker when no slots available
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(Icons.access_time, color: cs.primary),
              title: Text(
                _selectedTime != null
                    ? _selectedTime!.format(context)
                    : 'Select Time',
                style: theme.textTheme.bodyLarge,
              ),
              trailing: Icon(Icons.arrow_drop_down, color: cs.onSurface),
              onTap: _pickTime,
            ),
          ],
          const SizedBox(height: 24),

          ElevatedButton(
            onPressed: _submitting ? null : _submit,
            child: _submitting
                ? SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      valueColor: AlwaysStoppedAnimation(cs.onPrimary),
                    ),
                  )
                : Text(l10n.submitRequest),
          ),
        ],
      ),
    );
  }

  // ── Appointments tab ───────────────────────────────────────────────────────

  Widget _buildAppointmentsTab() {
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
              onPressed: () => _tabController.animateTo(0),
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
            ...upcoming.map(_appointmentCard),
            const SizedBox(height: 24),
          ],
          if (past.isNotEmpty) ...[
            _sectionHeader('Past'),
            ...past.map(_appointmentCard),
          ],
        ],
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

  Widget _appointmentCard(_AppointmentInfo appt) {
    final theme = Theme.of(context);
    final statusCol = _statusColor(appt.status);

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
                  child: Text(
                    appt.doctorName,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: statusCol.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    _statusLabel(appt.status),
                    style: TextStyle(
                      color: statusCol,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (appt.department.isNotEmpty)
              Text(
                appt.department,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            const SizedBox(height: 4),
            Row(
              children: [
                Icon(
                  Icons.calendar_today,
                  size: 14,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 4),
                Text(appt.date, style: theme.textTheme.bodySmall),
                const SizedBox(width: 16),
                Icon(
                  Icons.access_time,
                  size: 14,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 4),
                Text(appt.time, style: theme.textTheme.bodySmall),
              ],
            ),
            if (appt.tokenNumber != null) ...[
              const SizedBox(height: 6),
              Row(
                children: [
                  Icon(
                    Icons.confirmation_number,
                    size: 14,
                    color: const Color(0xFF00796B),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    'Token #${appt.tokenNumber}',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: const Color(0xFF00796B),
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ],
            if (appt.reason != null && appt.reason!.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                'Reason: ${appt.reason}',
                style: theme.textTheme.bodySmall?.copyWith(
                  fontStyle: FontStyle.italic,
                ),
              ),
            ],
            if (appt.confirmationNotes != null &&
                appt.confirmationNotes!.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                'Note: ${appt.confirmationNotes}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            if (appt.status == 'completed') ...[
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: () => _viewPrescription(appt),
                  icon: const Icon(Icons.description_outlined, size: 18),
                  label: Text(AppLocalizations.of(context)!.appointmentsViewPrescription),
                  style: TextButton.styleFrom(
                    foregroundColor: const Color(0xFF00796B),
                  ),
                ),
              ),
            ],
            if (appt.isUpcoming && appt.status == 'scheduled') ...[
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: () => _cancelAppointment(appt),
                  icon: const Icon(Icons.cancel_outlined, size: 18),
                  label: const Text('Cancel'),
                  style: TextButton.styleFrom(foregroundColor: Colors.red),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
