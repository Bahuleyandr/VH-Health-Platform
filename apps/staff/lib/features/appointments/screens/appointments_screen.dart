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

String? _doctorUid(Map<String, dynamic> doctor) {
  final value = doctor['uid'] ?? doctor['doctor_uid'] ?? doctor['doctorUid'];
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? null : text;
}

String _doctorDepartment(Map<String, dynamic> doctor) {
  final value = doctor['department'] ?? doctor['doctor_department'];
  return value?.toString().trim() ?? '';
}

String _departmentKey(String value) => value.trim().toLowerCase();

bool _sameDepartment(String a, String b) {
  final left = _departmentKey(a);
  final right = _departmentKey(b);
  return left.isNotEmpty && left == right;
}

DateTime _dateOnly(DateTime value) =>
    DateTime(value.year, value.month, value.day);

String _dateParam(DateTime value) => DateFormat('yyyy-MM-dd').format(value);

String _dayLabel(DateTime value) {
  final today = _dateOnly(DateTime.now());
  final day = _dateOnly(value);
  final offset = day.difference(today).inDays;
  if (offset == 0) return 'Today';
  if (offset == 1) return 'Tomorrow';
  if (offset == -1) return 'Yesterday';
  return DateFormat('EEE, d MMM').format(day);
}

bool _isDoctorQueueRole(String role) =>
    role == 'DOCTOR' || role == 'DUTY_DOCTOR';

Map<String, List<StaffAppointment>> appointmentSlotGroups(
  Iterable<StaffAppointment> appointments,
) {
  final groups = <String, List<StaffAppointment>>{};
  for (final appointment in appointments) {
    final slot = appointment.appointmentTime.trim().isEmpty
        ? 'Unscheduled'
        : appointment.appointmentTime.trim();
    groups.putIfAbsent(slot, () => <StaffAppointment>[]).add(appointment);
  }
  final entries = groups.entries.toList()
    ..sort((a, b) {
      if (a.key == 'Unscheduled') return 1;
      if (b.key == 'Unscheduled') return -1;
      return a.key.compareTo(b.key);
    });
  return Map.fromEntries(entries);
}

List<String> _departmentOptionsFromDoctors(List<Map<String, dynamic>> doctors) {
  final byKey = <String, String>{};
  for (final doctor in doctors) {
    final department = _doctorDepartment(doctor);
    if (department.isEmpty) continue;
    byKey.putIfAbsent(_departmentKey(department), () => department);
  }
  final options = byKey.values.toList(growable: false);
  options.sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
  return options;
}

Iterable<Map<String, dynamic>> _filterAppointmentDoctors({
  required List<Map<String, dynamic>> doctors,
  required String query,
  required String department,
}) {
  final normalizedQuery = query.trim().toLowerCase();
  final normalizedDepartment = _departmentKey(department);
  final filtered = doctors.where((doctor) {
    final doctorDepartment = _doctorDepartment(doctor);
    final normalizedDoctorDepartment = _departmentKey(doctorDepartment);
    if (normalizedDepartment.isNotEmpty &&
        !normalizedDoctorDepartment.contains(normalizedDepartment)) {
      return false;
    }
    if (normalizedQuery.isEmpty) return true;
    final label = _doctorLabel(doctor).toLowerCase();
    final name = doctor['name']?.toString().toLowerCase() ?? '';
    final specialization =
        doctor['specialization']?.toString().toLowerCase() ?? '';
    return label.contains(normalizedQuery) ||
        name.contains(normalizedQuery) ||
        doctorDepartment.toLowerCase().contains(normalizedQuery) ||
        specialization.contains(normalizedQuery);
  });
  return filtered.take(25);
}

String _doctorLabel(Map<String, dynamic> doctor) {
  final id = _doctorId(doctor);
  final name =
      doctor['name']?.toString() ?? (id == null ? 'Doctor' : 'Doctor #$id');
  final department = _doctorDepartment(doctor);
  final specialization = doctor['specialization']?.toString() ?? '';
  return [
    name,
    if (department.isNotEmpty) department,
    if (specialization.isNotEmpty) specialization,
  ].join(' - ');
}

class AppointmentsScreen extends StatefulWidget {
  final DateTime? initialDate;

  const AppointmentsScreen({super.key, this.initialDate});

  @override
  State<AppointmentsScreen> createState() => _AppointmentsScreenState();
}

class _AppointmentsScreenState extends State<AppointmentsScreen> {
  List<StaffAppointment> _appointments = [];
  bool _loading = true;
  String? _error;
  String _selectedStatus = 'all';
  String _searchQuery = '';
  late DateTime _selectedDate;
  bool _doctorScoped = false;
  String _scopeLabel = 'All OP queues';

  List<StaffAppointment> get _filtered =>
      _appointments.where((a) => a.matchesPatientSearch(_searchQuery)).toList();

  static const _statuses = [
    'all',
    'scheduled',
    'confirmed',
    'completed',
    'no_show',
    'cancelled',
  ];

  StreamSubscription<RealtimeEvent>? _appointmentsSub;
  Timer? _refreshDebounce;

  @override
  void initState() {
    super.initState();
    _selectedDate = _dateOnly(widget.initialDate ?? DateTime.now());
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
      final role = (await ApiConfig.getRole()).toUpperCase();
      final doctorScoped = _isDoctorQueueRole(role);
      final doctorId = doctorScoped ? await ApiConfig.getStaffId() : null;
      final data = await ScheduleApiService.getAppointments(
        doctorId: doctorId,
        date: _dateParam(_selectedDate),
        status: _selectedStatus == 'all' ? null : _selectedStatus,
        page: 1,
        limit: 100,
      );
      final list = StaffAppointment.listFrom(data);
      if (mounted) {
        setState(() {
          _appointments = list;
          _doctorScoped = doctorScoped;
          _scopeLabel = doctorScoped ? 'My OP queue' : 'All OP queues';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _selectDate(DateTime date) async {
    final next = _dateOnly(date);
    if (_selectedDate == next) return;
    setState(() => _selectedDate = next);
    await _load();
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
    final doctorCtrl = TextEditingController();
    final doctorFocus = FocusNode();
    final departmentCtrl = TextEditingController();
    final departmentFocus = FocusNode();
    final reasonCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    final doctorsFuture = ScheduleApiService.getAppointmentDoctors();
    final today = _dateOnly(DateTime.now());
    var appointmentDate = _selectedDate.isBefore(today) ? today : _selectedDate;
    var appointmentTime = TimeOfDay.fromDateTime(
      DateTime.now().add(const Duration(hours: 1)),
    );
    var submitting = false;
    var lookupMessage = 'Enter phone to check registered patient';
    var patientLookupBusy = false;
    var patientNameReadOnly = false;
    int? resolvedPatientId;
    int? selectedDoctorId;
    String? selectedDoctorUid;
    Map<String, dynamic>? selectedDoctor;
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
              final selectedDepartment = departmentCtrl.text.trim();
              if (selectedDoctorId == null && selectedDepartment.isEmpty) {
                ScaffoldMessenger.of(ctx).showSnackBar(
                  const SnackBar(
                    content: Text('Select a doctor or department'),
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
                  doctorId: selectedDoctorId,
                  doctorUid: selectedDoctorUid,
                  department: selectedDepartment.isEmpty
                      ? null
                      : selectedDepartment,
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
                          final departmentOptions =
                              _departmentOptionsFromDoctors(doctors);
                          final loading =
                              snapshot.connectionState ==
                              ConnectionState.waiting;

                          return Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              RawAutocomplete<Map<String, dynamic>>(
                                textEditingController: doctorCtrl,
                                focusNode: doctorFocus,
                                displayStringForOption: _doctorLabel,
                                optionsBuilder: (value) {
                                  if (loading) {
                                    return const Iterable<
                                      Map<String, dynamic>
                                    >.empty();
                                  }
                                  return _filterAppointmentDoctors(
                                    doctors: doctors,
                                    query: value.text,
                                    department: departmentCtrl.text,
                                  );
                                },
                                onSelected: (doctor) {
                                  final department = _doctorDepartment(doctor);
                                  setSheetState(() {
                                    selectedDoctor = doctor;
                                    selectedDoctorId = _doctorId(doctor);
                                    selectedDoctorUid = _doctorUid(doctor);
                                    doctorCtrl.text = _doctorLabel(doctor);
                                    if (department.isNotEmpty) {
                                      departmentCtrl.text = department;
                                    }
                                  });
                                  doctorFocus.unfocus();
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
                                          final selectedLabel =
                                              selectedDoctor == null
                                              ? ''
                                              : _doctorLabel(selectedDoctor!);
                                          if (selectedDoctor != null &&
                                              text.trim() != selectedLabel) {
                                            setSheetState(() {
                                              selectedDoctor = null;
                                              selectedDoctorId = null;
                                              selectedDoctorUid = null;
                                            });
                                          }
                                        },
                                        validator: (_) =>
                                            selectedDoctorId == null &&
                                                departmentCtrl.text
                                                    .trim()
                                                    .isEmpty
                                            ? 'Select a doctor or department'
                                            : null,
                                      );
                                    },
                                optionsViewBuilder:
                                    (context, onSelected, options) {
                                      final items = options.toList(
                                        growable: false,
                                      );
                                      return Align(
                                        alignment: Alignment.topLeft,
                                        child: Material(
                                          elevation: 4,
                                          borderRadius: BorderRadius.circular(
                                            10,
                                          ),
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
                                                    doctor['name']
                                                            ?.toString() ??
                                                        'Doctor',
                                                    overflow:
                                                        TextOverflow.ellipsis,
                                                  ),
                                                  subtitle: Text(
                                                    [
                                                          _doctorDepartment(
                                                            doctor,
                                                          ),
                                                          doctor['specialization']
                                                                  ?.toString() ??
                                                              '',
                                                        ]
                                                        .where(
                                                          (v) => v.isNotEmpty,
                                                        )
                                                        .join(' - '),
                                                    overflow:
                                                        TextOverflow.ellipsis,
                                                  ),
                                                  onTap: () =>
                                                      onSelected(doctor),
                                                );
                                              },
                                            ),
                                          ),
                                        ),
                                      );
                                    },
                              ),
                              const SizedBox(height: 12),
                              RawAutocomplete<String>(
                                textEditingController: departmentCtrl,
                                focusNode: departmentFocus,
                                optionsBuilder: (value) {
                                  final query = value.text.trim().toLowerCase();
                                  if (query.isEmpty) {
                                    return departmentOptions.take(25);
                                  }
                                  return departmentOptions
                                      .where(
                                        (department) => department
                                            .toLowerCase()
                                            .contains(query),
                                      )
                                      .take(25);
                                },
                                onSelected: (department) {
                                  setSheetState(() {
                                    departmentCtrl.text = department;
                                    if (selectedDoctor != null &&
                                        !_sameDepartment(
                                          _doctorDepartment(selectedDoctor!),
                                          department,
                                        )) {
                                      selectedDoctor = null;
                                      selectedDoctorId = null;
                                      selectedDoctorUid = null;
                                      doctorCtrl.clear();
                                    }
                                  });
                                  departmentFocus.unfocus();
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
                                        enabled: !submitting,
                                        decoration: const InputDecoration(
                                          labelText: 'Department',
                                          hintText: 'Any available doctor',
                                          prefixIcon: ExcludeSemantics(
                                            child: Icon(Icons.business),
                                          ),
                                        ),
                                        onChanged: (value) {
                                          final department = value.trim();
                                          if (selectedDoctor != null &&
                                              department.isNotEmpty &&
                                              !_sameDepartment(
                                                _doctorDepartment(
                                                  selectedDoctor!,
                                                ),
                                                department,
                                              )) {
                                            setSheetState(() {
                                              selectedDoctor = null;
                                              selectedDoctorId = null;
                                              selectedDoctorUid = null;
                                              doctorCtrl.clear();
                                            });
                                          }
                                        },
                                        validator: (_) =>
                                            selectedDoctorId == null &&
                                                textController.text
                                                    .trim()
                                                    .isEmpty
                                            ? 'Select a doctor or department'
                                            : null,
                                      );
                                    },
                                optionsViewBuilder:
                                    (context, onSelected, options) {
                                      final items = options.toList(
                                        growable: false,
                                      );
                                      return Align(
                                        alignment: Alignment.topLeft,
                                        child: Material(
                                          elevation: 4,
                                          borderRadius: BorderRadius.circular(
                                            10,
                                          ),
                                          child: ConstrainedBox(
                                            constraints: const BoxConstraints(
                                              maxHeight: 220,
                                              maxWidth: 520,
                                            ),
                                            child: ListView.separated(
                                              padding: EdgeInsets.zero,
                                              shrinkWrap: true,
                                              itemCount: items.length,
                                              separatorBuilder: (_, _) =>
                                                  const Divider(height: 1),
                                              itemBuilder: (context, index) {
                                                final department = items[index];
                                                return ListTile(
                                                  dense: true,
                                                  leading: const Icon(
                                                    Icons.business_outlined,
                                                  ),
                                                  title: Text(
                                                    department,
                                                    overflow:
                                                        TextOverflow.ellipsis,
                                                  ),
                                                  onTap: () =>
                                                      onSelected(department),
                                                );
                                              },
                                            ),
                                          ),
                                        ),
                                      );
                                    },
                              ),
                            ],
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
      doctorCtrl.dispose();
      doctorFocus.dispose();
      departmentCtrl.dispose();
      departmentFocus.dispose();
      reasonCtrl.dispose();
      notesCtrl.dispose();
    }
  }

  Widget _buildToolbar() {
    return Container(
      color: AppTheme.cardSurface,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final s in _statuses)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: FilterChip(
                        label: Text(s.replaceAll('_', ' ').toUpperCase()),
                        selected: s == _selectedStatus,
                        onSelected: (_) {
                          setState(() => _selectedStatus = s);
                          _load();
                        },
                        selectedColor: AppTheme.primaryBlue.withValues(
                          alpha: 0.15,
                        ),
                        checkmarkColor: AppTheme.primaryBlue,
                        labelStyle: TextStyle(
                          color: s == _selectedStatus
                              ? AppTheme.primaryBlue
                              : AppTheme.textSecondary,
                          fontSize: 11,
                          fontWeight: s == _selectedStatus
                              ? FontWeight.bold
                              : FontWeight.normal,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(width: 8),
          FilledButton.icon(
            onPressed: _createAppointment,
            icon: const Icon(Icons.add, size: 18),
            label: const Text('New'),
            style: FilledButton.styleFrom(
              minimumSize: const Size(0, 38),
              padding: const EdgeInsets.symmetric(horizontal: 12),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSearchField() {
    return TextField(
      decoration: InputDecoration(
        hintText: 'Search patient, phone, doctor, department',
        prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
        filled: true,
        fillColor: AppTheme.surfaceWhite,
      ),
      onChanged: (v) => setState(() => _searchQuery = v),
    );
  }

  Widget _buildCalendarPanel() {
    final today = _dateOnly(DateTime.now());
    return _CalendarPanel(
      selectedDate: _selectedDate,
      scopeLabel: _scopeLabel,
      appointmentCount: _filtered.length,
      doctorScoped: _doctorScoped,
      onDateSelected: _selectDate,
      onToday: () => _selectDate(today),
      onTomorrow: () => _selectDate(today.add(const Duration(days: 1))),
    );
  }

  Widget _buildSchedulePanel() {
    if (_loading) return const SkeletonList();
    if (_error != null) {
      return ErrorState(
        message:
            'Could not load appointments.\n${_error!.replaceFirst('Exception: ', '')}',
        onRetry: _load,
      );
    }
    if (_filtered.isEmpty) {
      if (_searchQuery.trim().isNotEmpty) {
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text(
              AppStrings.of(context).noMatchesFor(_searchQuery),
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ),
        );
      }
      return EmptyState(
        icon: Icons.event_available_outlined,
        title: 'No appointments for ${_dayLabel(_selectedDate)}',
        body: 'Booked patients will appear under their timing slots.',
      );
    }

    final groups = appointmentSlotGroups(_filtered);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _ScheduleHeader(
          title: '${_dayLabel(_selectedDate)} slots',
          subtitle:
              '${_filtered.length} patient${_filtered.length == 1 ? '' : 's'} queued',
        ),
        const SizedBox(height: 10),
        for (final entry in groups.entries) ...[
          _SlotSection(
            time: entry.key,
            appointments: entry.value,
            onConfirm: (id) => _updateStatus(id, 'confirmed'),
            onCancel: (id) => _updateStatus(id, 'cancelled'),
          ),
          const SizedBox(height: 12),
        ],
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Appointments',
      body: Column(
        children: [
          _buildToolbar(),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _load,
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final wide = constraints.maxWidth >= 980;
                  return ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      if (wide)
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            SizedBox(width: 330, child: _buildCalendarPanel()),
                            const SizedBox(width: 16),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  _buildSearchField(),
                                  const SizedBox(height: 14),
                                  _buildSchedulePanel(),
                                ],
                              ),
                            ),
                          ],
                        )
                      else ...[
                        _buildCalendarPanel(),
                        const SizedBox(height: 14),
                        _buildSearchField(),
                        const SizedBox(height: 14),
                        _buildSchedulePanel(),
                      ],
                    ],
                  );
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CalendarPanel extends StatelessWidget {
  final DateTime selectedDate;
  final String scopeLabel;
  final int appointmentCount;
  final bool doctorScoped;
  final ValueChanged<DateTime> onDateSelected;
  final VoidCallback onToday;
  final VoidCallback onTomorrow;

  const _CalendarPanel({
    required this.selectedDate,
    required this.scopeLabel,
    required this.appointmentCount,
    required this.doctorScoped,
    required this.onDateSelected,
    required this.onToday,
    required this.onTomorrow,
  });

  @override
  Widget build(BuildContext context) {
    final today = _dateOnly(DateTime.now());
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        border: Border.all(color: AppTheme.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.calendar_month_outlined,
                color: AppTheme.primaryBlue,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Queue Calendar',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            doctorScoped
                ? 'Doctor view: only your queued patients are shown.'
                : 'Counter view: all visible OP queues are shown.',
            style: TextStyle(color: AppTheme.textSecondary),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                onPressed: onToday,
                icon: const Icon(Icons.today_outlined, size: 18),
                label: const Text('Today'),
              ),
              OutlinedButton.icon(
                onPressed: onTomorrow,
                icon: const Icon(Icons.next_week_outlined, size: 18),
                label: const Text('Tomorrow'),
              ),
            ],
          ),
          const SizedBox(height: 10),
          CalendarDatePicker(
            initialDate: selectedDate,
            firstDate: today.subtract(const Duration(days: 60)),
            lastDate: today.add(const Duration(days: 240)),
            onDateChanged: onDateSelected,
          ),
          const SizedBox(height: 8),
          _QueueSummary(
            dateLabel: DateFormat('EEE, d MMM yyyy').format(selectedDate),
            scopeLabel: scopeLabel,
            appointmentCount: appointmentCount,
          ),
        ],
      ),
    );
  }
}

class _QueueSummary extends StatelessWidget {
  final String dateLabel;
  final String scopeLabel;
  final int appointmentCount;

  const _QueueSummary({
    required this.dateLabel,
    required this.scopeLabel,
    required this.appointmentCount,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.primaryBlue.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.primaryBlue.withValues(alpha: 0.22)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            dateLabel,
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            '$scopeLabel - $appointmentCount patient${appointmentCount == 1 ? '' : 's'}',
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ],
      ),
    );
  }
}

class _ScheduleHeader extends StatelessWidget {
  final String title;
  final String subtitle;

  const _ScheduleHeader({required this.title, required this.subtitle});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        border: Border.all(color: AppTheme.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          const Icon(Icons.schedule_outlined, color: AppTheme.primaryTeal),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                Text(subtitle, style: TextStyle(color: AppTheme.textSecondary)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SlotSection extends StatelessWidget {
  final String time;
  final List<StaffAppointment> appointments;
  final Function(String) onConfirm;
  final Function(String) onCancel;

  const _SlotSection({
    required this.time,
    required this.appointments,
    required this.onConfirm,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        border: Border.all(color: AppTheme.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: AppTheme.primaryTeal.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  time,
                  style: const TextStyle(
                    color: AppTheme.primaryTeal,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Text(
                '${appointments.length} patient${appointments.length == 1 ? '' : 's'}',
                style: TextStyle(color: AppTheme.textSecondary),
              ),
            ],
          ),
          const SizedBox(height: 10),
          for (final appointment in appointments)
            _AppointmentCard(
              appointment: appointment,
              onConfirm: onConfirm,
              onCancel: onCancel,
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
