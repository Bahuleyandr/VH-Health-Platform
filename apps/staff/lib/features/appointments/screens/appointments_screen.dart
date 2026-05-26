import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import '../../../core/config/api_config.dart';
import '../../../core/services/patient_api_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';
import '../../../core/widgets/states/success_toast.dart';
import '../models/staff_appointment.dart';

String _digitsOnly(String value) => value.replaceAll(RegExp(r'\D'), '');

int? _doctorId(Map<String, dynamic> doctor) => int.tryParse(
  (doctor['user_id'] ?? doctor['userId'] ?? doctor['id'])?.toString() ?? '',
);

String _doctorLabel(Map<String, dynamic> doctor) {
  final id = _doctorId(doctor);
  final name =
      doctor['name']?.toString() ?? (id == null ? 'Doctor' : 'Doctor #$id');
  final department = doctor['department']?.toString() ?? '';
  final specialization = doctor['specialization']?.toString() ?? '';
  return [
    name,
    if (department.isNotEmpty) department,
    if (specialization.isNotEmpty) specialization,
  ].join(' - ');
}

class AppointmentsScreen extends StatefulWidget {
  const AppointmentsScreen({super.key});

  @override
  State<AppointmentsScreen> createState() => _AppointmentsScreenState();
}

class _AppointmentsScreenState extends State<AppointmentsScreen> {
  List<StaffAppointment> _appointments = [];
  bool _loading = true;
  String? _error;
  String _selectedStatus = 'all';
  String _searchQuery = '';

  List<StaffAppointment> get _filtered =>
      _appointments.where((a) => a.matchesPatientSearch(_searchQuery)).toList();

  static const _statuses = [
    'all',
    'scheduled',
    'confirmed',
    'completed',
    'cancelled',
  ];

  StreamSubscription<RealtimeEvent>? _appointmentsSub;
  Timer? _refreshDebounce;

  @override
  void initState() {
    super.initState();
    _load();
    _attachRealtime();
  }

  Future<void> _attachRealtime() async {
    final rt = RealtimeClient.instance;
    await rt.connect();
    // Backend `appointmentStatusController.broadcast('staff:appointments', …)`
    // fires whenever any appointment status changes. Debounce so a burst
    // of status flips (queue marshalling) doesn't refetch N times.
    _appointmentsSub = rt.events('staff:appointments').listen((_) {
      _refreshDebounce?.cancel();
      _refreshDebounce = Timer(const Duration(milliseconds: 400), () {
        if (mounted) _load();
      });
    });
  }

  @override
  void dispose() {
    _appointmentsSub?.cancel();
    _refreshDebounce?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final today = DateFormat('yyyy-MM-dd').format(DateTime.now());
      final role = (await ApiConfig.getRole()).toUpperCase();
      final doctorId = role == 'DOCTOR' ? await ApiConfig.getStaffId() : null;
      final data = await ScheduleApiService.getAppointments(
        doctorId: doctorId,
        date: today,
        status: _selectedStatus == 'all' ? null : _selectedStatus,
      );
      final list = StaffAppointment.listFrom(data);
      if (mounted) setState(() => _appointments = list);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _updateStatus(String id, String status) async {
    try {
      await ScheduleApiService.updateAppointmentStatus(id, status);
      if (!mounted) return;
      SuccessToast.show(context, 'Appointment $status successfully');
      _load();
    } catch (e) {
      if (!mounted) return;
      ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _createAppointment() async {
    final formKey = GlobalKey<FormState>();
    final patientPhoneCtrl = TextEditingController();
    final patientNameCtrl = TextEditingController();
    final reasonCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    final doctorsFuture = ScheduleApiService.getAppointmentDoctors();
    final today = DateTime.now();
    var appointmentDate = DateTime(today.year, today.month, today.day);
    var appointmentTime = TimeOfDay.fromDateTime(
      DateTime.now().add(const Duration(hours: 1)),
    );
    var submitting = false;
    var lookupMessage = 'Enter phone to check registered patient';
    var patientLookupBusy = false;
    var patientNameReadOnly = false;
    int? resolvedPatientId;
    int? selectedDoctorId;
    Timer? lookupDebounce;

    Future<void> lookupPatient(StateSetter setSheetState) async {
      final phone = patientPhoneCtrl.text.trim();
      final last10 = _digitsOnly(phone).length >= 10
          ? _digitsOnly(phone).substring(_digitsOnly(phone).length - 10)
          : _digitsOnly(phone);
      if (last10.length < 10) {
        setSheetState(() {
          resolvedPatientId = null;
          patientLookupBusy = false;
          patientNameReadOnly = false;
          lookupMessage = 'Enter phone to check registered patient';
        });
        return;
      }

      setSheetState(() {
        patientLookupBusy = true;
        resolvedPatientId = null;
        patientNameReadOnly = false;
        lookupMessage = 'Checking patient registry...';
      });

      try {
        final matches = await PatientApiService.search(phone, limit: 10);
        final exact = matches.cast<Map<String, dynamic>?>().firstWhere(
          (patient) =>
              patient != null &&
              _digitsOnly(patient['phone']?.toString() ?? '').endsWith(last10),
          orElse: () => null,
        );
        if (exact == null) {
          setSheetState(() {
            patientLookupBusy = false;
            patientNameReadOnly = false;
            lookupMessage =
                'New patient - enter name to register while booking';
          });
          return;
        }

        final id = int.tryParse(exact['id']?.toString() ?? '');
        setSheetState(() {
          resolvedPatientId = id;
          patientLookupBusy = false;
          patientNameReadOnly = true;
          patientNameCtrl.text = exact['name']?.toString() ?? '';
          lookupMessage = id == null
              ? 'Existing patient found'
              : 'Existing patient found: #$id';
        });
      } catch (_) {
        setSheetState(() {
          patientLookupBusy = false;
          patientNameReadOnly = false;
          lookupMessage =
              'Could not check registry now; new-patient booking is available';
        });
      }
    }

    try {
      final created = await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        builder: (ctx) => StatefulBuilder(
          builder: (ctx, setSheetState) {
            final dateLabel = DateFormat('yyyy-MM-dd').format(appointmentDate);
            final timeLabel =
                '${appointmentTime.hour.toString().padLeft(2, '0')}:${appointmentTime.minute.toString().padLeft(2, '0')}';

            Future<void> submit() async {
              if (!formKey.currentState!.validate()) return;
              if (selectedDoctorId == null) {
                ScaffoldMessenger.of(ctx).showSnackBar(
                  const SnackBar(
                    content: Text('Select a doctor'),
                    backgroundColor: AppTheme.errorRed,
                  ),
                );
                return;
              }
              setSheetState(() => submitting = true);
              try {
                await ScheduleApiService.createAppointment(
                  patientId: resolvedPatientId,
                  patientPhone: patientPhoneCtrl.text.trim(),
                  patientName: patientNameCtrl.text.trim(),
                  doctorId: selectedDoctorId!,
                  appointmentDate: dateLabel,
                  appointmentTime: timeLabel,
                  reason: reasonCtrl.text.trim(),
                  notes: notesCtrl.text.trim().isEmpty
                      ? null
                      : notesCtrl.text.trim(),
                );
                if (!ctx.mounted) return;
                Navigator.pop(ctx, true);
              } catch (e) {
                if (!ctx.mounted) return;
                setSheetState(() => submitting = false);
                ScaffoldMessenger.of(ctx).showSnackBar(
                  SnackBar(
                    content: Text(e.toString().replaceFirst('Exception: ', '')),
                    backgroundColor: AppTheme.errorRed,
                  ),
                );
              }
            }

            return Padding(
              padding: EdgeInsets.only(
                left: 20,
                right: 20,
                top: 20,
                bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
              ),
              child: SingleChildScrollView(
                child: Form(
                  key: formKey,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Expanded(
                            child: Text(
                              'Create Appointment',
                              style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          IconButton(
                            icon: const Icon(Icons.close),
                            tooltip: 'Close',
                            onPressed: submitting
                                ? null
                                : () => Navigator.pop(ctx, false),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: patientPhoneCtrl,
                        keyboardType: TextInputType.phone,
                        decoration: InputDecoration(
                          labelText: 'Patient phone',
                          helperText: lookupMessage,
                          suffixIcon: patientLookupBusy
                              ? const Padding(
                                  padding: EdgeInsets.all(12),
                                  child: SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  ),
                                )
                              : const ExcludeSemantics(
                                  child: Icon(Icons.search_outlined),
                                ),
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.phone_outlined),
                          ),
                        ),
                        onChanged: (_) {
                          lookupDebounce?.cancel();
                          lookupDebounce = Timer(
                            const Duration(milliseconds: 450),
                            () {
                              if (ctx.mounted) lookupPatient(setSheetState);
                            },
                          );
                        },
                        validator: (value) {
                          final digits = _digitsOnly(value?.trim() ?? '');
                          return digits.length < 10
                              ? 'Enter a valid phone number'
                              : null;
                        },
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: patientNameCtrl,
                        readOnly: patientNameReadOnly,
                        decoration: const InputDecoration(
                          labelText: 'Patient name',
                          prefixIcon: ExcludeSemantics(
                            child: Icon(Icons.person_outline),
                          ),
                        ),
                        validator: (value) {
                          if (resolvedPatientId != null) return null;
                          final name = value?.trim() ?? '';
                          return name.length < 2
                              ? 'Enter patient name for new patient'
                              : null;
                        },
                      ),
                      const SizedBox(height: 12),
                      FutureBuilder<List<Map<String, dynamic>>>(
                        future: doctorsFuture,
                        builder: (context, snapshot) {
                          final doctors =
                              snapshot.data ?? const <Map<String, dynamic>>[];
                          final loading =
                              snapshot.connectionState ==
                              ConnectionState.waiting;

                          return Autocomplete<Map<String, dynamic>>(
                            displayStringForOption: _doctorLabel,
                            optionsBuilder: (value) {
                              final query = value.text.trim().toLowerCase();
                              final options = query.isEmpty
                                  ? doctors
                                  : doctors.where((doctor) {
                                      final label = _doctorLabel(
                                        doctor,
                                      ).toLowerCase();
                                      final name =
                                          doctor['name']
                                              ?.toString()
                                              .toLowerCase() ??
                                          '';
                                      final department =
                                          doctor['department']
                                              ?.toString()
                                              .toLowerCase() ??
                                          '';
                                      final specialization =
                                          doctor['specialization']
                                              ?.toString()
                                              .toLowerCase() ??
                                          '';
                                      return label.contains(query) ||
                                          name.contains(query) ||
                                          department.contains(query) ||
                                          specialization.contains(query);
                                    });
                              return options.take(25);
                            },
                            onSelected: (doctor) {
                              setSheetState(
                                () => selectedDoctorId = _doctorId(doctor),
                              );
                            },
                            fieldViewBuilder:
                                (
                                  context,
                                  textController,
                                  focusNode,
                                  onFieldSubmitted,
                                ) {
                                  return TextFormField(
                                    controller: textController,
                                    focusNode: focusNode,
                                    enabled: !submitting && !loading,
                                    decoration: InputDecoration(
                                      labelText: 'Doctor',
                                      hintText: loading
                                          ? 'Loading doctors...'
                                          : snapshot.hasError
                                          ? 'Could not load doctors'
                                          : 'Type doctor name',
                                      prefixIcon: const ExcludeSemantics(
                                        child: Icon(
                                          Icons.medical_services_outlined,
                                        ),
                                      ),
                                    ),
                                    onChanged: (text) {
                                      final typed = text.trim().toLowerCase();
                                      int? matchedId;
                                      for (final doctor in doctors) {
                                        if (_doctorLabel(
                                              doctor,
                                            ).toLowerCase() ==
                                            typed) {
                                          matchedId = _doctorId(doctor);
                                          break;
                                        }
                                      }
                                      setSheetState(
                                        () => selectedDoctorId = matchedId,
                                      );
                                    },
                                    validator: (_) => selectedDoctorId == null
                                        ? 'Select a doctor'
                                        : null,
                                  );
                                },
                            optionsViewBuilder: (context, onSelected, options) {
                              final items = options.toList(growable: false);
                              return Align(
                                alignment: Alignment.topLeft,
                                child: Material(
                                  elevation: 4,
                                  borderRadius: BorderRadius.circular(10),
                                  child: ConstrainedBox(
                                    constraints: const BoxConstraints(
                                      maxHeight: 260,
                                      maxWidth: 520,
                                    ),
                                    child: ListView.separated(
                                      padding: EdgeInsets.zero,
                                      shrinkWrap: true,
                                      itemCount: items.length,
                                      separatorBuilder: (_, _) =>
                                          const Divider(height: 1),
                                      itemBuilder: (context, index) {
                                        final doctor = items[index];
                                        return ListTile(
                                          dense: true,
                                          leading: const Icon(
                                            Icons.person_outline,
                                          ),
                                          title: Text(
                                            doctor['name']?.toString() ??
                                                'Doctor',
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                          subtitle: Text(
                                            [
                                                  doctor['department']
                                                          ?.toString() ??
                                                      '',
                                                  doctor['specialization']
                                                          ?.toString() ??
                                                      '',
                                                ]
                                                .where((v) => v.isNotEmpty)
                                                .join(' - '),
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                          onTap: () => onSelected(doctor),
                                        );
                                      },
                                    ),
                                  ),
                                ),
                              );
                            },
                          );
                        },
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: submitting
                                  ? null
                                  : () async {
                                      final picked = await showDatePicker(
                                        context: ctx,
                                        initialDate: appointmentDate,
                                        firstDate: DateTime(
                                          today.year,
                                          today.month,
                                          today.day,
                                        ),
                                        lastDate: DateTime(
                                          today.year + 1,
                                          today.month,
                                          today.day,
                                        ),
                                      );
                                      if (picked != null) {
                                        setSheetState(
                                          () => appointmentDate = picked,
                                        );
                                      }
                                    },
                              icon: const Icon(Icons.calendar_today_outlined),
                              label: Text(dateLabel),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: submitting
                                  ? null
                                  : () async {
                                      final picked = await showTimePicker(
                                        context: ctx,
                                        initialTime: appointmentTime,
                                      );
                                      if (picked != null) {
                                        setSheetState(
                                          () => appointmentTime = picked,
                                        );
                                      }
                                    },
                              icon: const Icon(Icons.schedule_outlined),
                              label: Text(timeLabel),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: reasonCtrl,
                        decoration: const InputDecoration(
                          labelText: 'Reason',
                          prefixIcon: ExcludeSemantics(
                            child: Icon(Icons.subject_outlined),
                          ),
                        ),
                        minLines: 2,
                        maxLines: 3,
                        validator: (value) {
                          final trimmed = value?.trim() ?? '';
                          return trimmed.length < 3
                              ? 'Enter at least 3 characters'
                              : null;
                        },
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: notesCtrl,
                        decoration: const InputDecoration(
                          labelText: 'Notes (optional)',
                          prefixIcon: ExcludeSemantics(
                            child: Icon(Icons.notes_outlined),
                          ),
                        ),
                        maxLines: 2,
                      ),
                      const SizedBox(height: 18),
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton.icon(
                          onPressed: submitting ? null : submit,
                          icon: submitting
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : const Icon(Icons.add, color: Colors.white),
                          label: Text(
                            submitting ? 'Creating...' : 'Create Appointment',
                          ),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppTheme.primaryBlue,
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(vertical: 14),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      );

      if (created == true && mounted) {
        SuccessToast.show(context, 'Appointment created successfully');
        _load();
      }
    } finally {
      lookupDebounce?.cancel();
      patientPhoneCtrl.dispose();
      patientNameCtrl.dispose();
      reasonCtrl.dispose();
      notesCtrl.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Appointments',
      body: Column(
        children: [
          // Filter chips
          Container(
            color: Colors.white,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              children: [
                Expanded(
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(
                      children: _statuses.map((s) {
                        final selected = s == _selectedStatus;
                        return Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: FilterChip(
                            label: Text(s.toUpperCase()),
                            selected: selected,
                            onSelected: (_) {
                              setState(() => _selectedStatus = s);
                              _load();
                            },
                            selectedColor: AppTheme.primaryBlue.withValues(
                              alpha: 0.15,
                            ),
                            checkmarkColor: AppTheme.primaryBlue,
                            labelStyle: TextStyle(
                              color: selected
                                  ? AppTheme.primaryBlue
                                  : AppTheme.textSecondary,
                              fontSize: 11,
                              fontWeight: selected
                                  ? FontWeight.bold
                                  : FontWeight.normal,
                            ),
                          ),
                        );
                      }).toList(),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                ElevatedButton.icon(
                  onPressed: _createAppointment,
                  icon: const Icon(Icons.add, color: Colors.white, size: 18),
                  label: const Text('New'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.primaryBlue,
                    foregroundColor: Colors.white,
                    minimumSize: const Size(0, 38),
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                  ),
                ),
              ],
            ),
          ),

          Padding(
            padding: const EdgeInsets.all(16),
            child: TextField(
              decoration: InputDecoration(
                hintText: 'Search by patient name…',
                prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                filled: true,
                fillColor: Colors.white,
              ),
              onChanged: (v) => setState(() => _searchQuery = v),
            ),
          ),

          Expanded(
            child: RefreshIndicator(
              onRefresh: _load,
              child: _loading
                  ? const SkeletonList()
                  : _error != null
                  ? ErrorState(
                      message:
                          'Could not load appointments.\n${_error!.replaceFirst('Exception: ', '')}',
                      onRetry: _load,
                    )
                  : _filtered.isEmpty
                  ? (_searchQuery.trim().isNotEmpty
                        ? Center(
                            child: Text(
                              AppStrings.of(context).noMatchesFor(_searchQuery),
                              style: TextStyle(color: AppTheme.textSecondary),
                            ),
                          )
                        : EmptyState(
                            icon: Icons.event_available_outlined,
                            title: AppStrings.of(context).appointmentsNoToday,
                            body: 'New appointments will show up here.',
                          ))
                  : ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: _filtered.length,
                      itemBuilder: (ctx, i) => _AppointmentCard(
                        appointment: _filtered[i],
                        onConfirm: (id) => _updateStatus(id, 'confirmed'),
                        onCancel: (id) => _updateStatus(id, 'cancelled'),
                      ),
                    ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AppointmentCard extends StatelessWidget {
  final StaffAppointment appointment;
  final Function(String) onConfirm;
  final Function(String) onCancel;

  const _AppointmentCard({
    required this.appointment,
    required this.onConfirm,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    final id = appointment.id?.toString() ?? '';
    final patientName = appointment.patientName;
    final type = appointment.reasonLabel;
    final dateTime = appointment.scheduledLabel;
    final status = appointment.status;
    final doctor = appointment.doctorName;
    final department = appointment.department;

    final statusColor = switch (status.toLowerCase()) {
      'confirmed' => AppTheme.successGreen,
      'cancelled' => AppTheme.errorRed,
      'completed' => AppTheme.primaryTeal,
      _ => AppTheme.warningAmber,
    };

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    patientName,
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 15,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: statusColor.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    status.toUpperCase(),
                    style: TextStyle(
                      color: statusColor,
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            _InfoRow(Icons.local_hospital_outlined, type),
            if (department.isNotEmpty) _InfoRow(Icons.business, department),
            if (doctor.isNotEmpty) _InfoRow(Icons.person_outlined, doctor),
            if (dateTime.isNotEmpty)
              _InfoRow(Icons.schedule_outlined, dateTime),

            if (appointment.isScheduled) ...[
              const SizedBox(height: 10),
              const Divider(height: 1),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: id.isEmpty ? null : () => onCancel(id),
                      icon: const Icon(Icons.close, size: 16),
                      label: const Text('Cancel'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: AppTheme.errorRed,
                        side: const BorderSide(color: AppTheme.errorRed),
                        minimumSize: const Size(0, 36),
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: ElevatedButton.icon(
                      onPressed: id.isEmpty ? null : () => onConfirm(id),
                      icon: const Icon(
                        Icons.check,
                        size: 16,
                        color: Colors.white,
                      ),
                      label: const Text('Confirm'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppTheme.successGreen,
                        minimumSize: const Size(0, 36),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  final IconData icon;
  final String text;
  const _InfoRow(this.icon, this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: [
          Icon(icon, size: 14, color: AppTheme.textSecondary),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              text,
              style: TextStyle(fontSize: 13, color: AppTheme.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}
