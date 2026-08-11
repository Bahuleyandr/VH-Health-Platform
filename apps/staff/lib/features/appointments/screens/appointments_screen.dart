import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import '../../../core/config/api_config.dart';
import '../../../core/services/patient_api_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/realtime_status_banner.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../core/widgets/states/success_toast.dart';
import '../appointment_calendar_helpers.dart';
import '../models/staff_appointment.dart';
import '../../opd/op_doctor_workspace_route.dart';
import '../../teleconsult/models/staff_teleconsult_route_args.dart';
import '../../teleconsult/widgets/staff_teleconsult_badge.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

export '../appointment_calendar_helpers.dart';

typedef AppointmentsLoader =
    Future<Map<String, dynamic>> Function({
      String? doctorId,
      required String date,
      String? status,
      required int page,
      required int limit,
    });

typedef AppointmentsRoleLoader = Future<String> Function();
typedef AppointmentsStaffIdLoader = Future<String?> Function();

String _digitsOnly(String value) => value.replaceAll(RegExp(r'\D'), '');

@visibleForTesting
bool appointmentPatientLookupResultIsCurrent({
  required int capturedGeneration,
  required int currentGeneration,
  required String capturedPhone,
  required String currentPhone,
}) {
  final capturedDigits = _digitsOnly(capturedPhone);
  final currentDigits = _digitsOnly(currentPhone);
  final capturedLast10 = capturedDigits.length >= 10
      ? capturedDigits.substring(capturedDigits.length - 10)
      : capturedDigits;
  final currentLast10 = currentDigits.length >= 10
      ? currentDigits.substring(currentDigits.length - 10)
      : currentDigits;
  return capturedGeneration == currentGeneration &&
      capturedLast10.length == 10 &&
      capturedLast10 == currentLast10;
}

@visibleForTesting
bool appointmentPatientLookupCanSubmit({
  required String currentPhone,
  required String? verifiedPhone,
  required bool lookupBusy,
  required bool lookupFailed,
}) {
  if (lookupBusy || lookupFailed || verifiedPhone == null) return false;
  return appointmentPatientLookupResultIsCurrent(
    capturedGeneration: 0,
    currentGeneration: 0,
    capturedPhone: verifiedPhone,
    currentPhone: currentPhone,
  );
}

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

String _timeParam(TimeOfDay value) =>
    '${value.hour.toString().padLeft(2, '0')}:${value.minute.toString().padLeft(2, '0')}';

TimeOfDay _appointmentTimeFromText(String value) {
  final minutes = appointmentMinuteOfDayFromText(value);
  if (minutes == null) {
    return TimeOfDay.fromDateTime(DateTime.now().add(const Duration(hours: 1)));
  }
  return TimeOfDay(hour: minutes ~/ 60, minute: minutes % 60);
}

bool appointmentCanReschedule(String status) {
  return switch (status.trim().toUpperCase()) {
    'SCHEDULED' || 'CONFIRMED' || 'PENDING' => true,
    _ => false,
  };
}

List<DateTime> _appointmentWeekDays(DateTime value) {
  final start = appointmentWeekStart(value);
  return List.generate(7, (index) => start.add(Duration(days: index)));
}

String _appointmentWeekTitle(DateTime weekStart) {
  final end = weekStart.add(const Duration(days: 6));
  if (weekStart.year == end.year && weekStart.month == end.month) {
    return DateFormat('MMMM yyyy').format(weekStart);
  }
  if (weekStart.year == end.year) {
    return '${DateFormat('MMM').format(weekStart)} - ${DateFormat('MMM yyyy').format(end)}';
  }
  return '${DateFormat('MMM yyyy').format(weekStart)} - ${DateFormat('MMM yyyy').format(end)}';
}

bool _isDoctorQueueRole(String role) =>
    role == 'DOCTOR' || role == 'DUTY_DOCTOR';

const int _calendarStartHour = 5;
const int _calendarEndHour = 22;
const double _calendarTimeGutterWidth = 56;

double _calendarHourHeightForWidth(double width) {
  if (width < 760) return 46;
  if (width < 1100) return 52;
  return 58;
}

double _calendarHeaderHeightForWidth(double width) {
  if (width < 760) return 60;
  if (width < 1100) return 68;
  return 76;
}

Color _appointmentStatusColor(String status) {
  return switch (status.toLowerCase()) {
    'confirmed' => AppTheme.successOnSurface,
    'cancelled' => AppTheme.errorOnSurface,
    'completed' =>
      AppTheme.brightness == Brightness.dark
          ? const Color(0xFF80CBC4)
          : AppTheme.primaryTeal,
    'rescheduled' => AppTheme.warningOnSurface,
    'no_show' => AppTheme.textSecondary,
    _ => AppTheme.warningOnSurface,
  };
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
  return _doctorLabelWithStrings(doctor);
}

String _doctorLabelWithStrings(Map<String, dynamic> doctor, {AppStrings? s}) {
  final strings = s ?? AppStrings.forLocale(const Locale('en'));
  final id = _doctorId(doctor);
  final name =
      doctor['name']?.toString() ??
      (id == null
          ? strings.prescriptionsDoctorLabel
          : strings.format('s4.dynamic.appointments.doctor_number', {
              'id': id,
            }));
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
  final bool workspaceMode;
  final AppointmentsLoader? loadAppointments;
  final AppointmentsRoleLoader? loadRole;
  final AppointmentsStaffIdLoader? loadStaffId;
  final bool autoRefresh;

  const AppointmentsScreen({
    super.key,
    this.initialDate,
    this.workspaceMode = false,
    this.loadAppointments,
    this.loadRole,
    this.loadStaffId,
    this.autoRefresh = true,
  });

  @override
  State<AppointmentsScreen> createState() => _AppointmentsScreenState();
}

class _AppointmentsScreenState extends State<AppointmentsScreen> {
  Map<String, List<StaffAppointment>> _appointmentsByDate = {};
  bool _loading = true;
  String? _error;
  String _selectedStatus = 'all';
  String _patientSearchQuery = '';
  String _doctorDepartmentQuery = '';
  late DateTime _selectedDate;
  String _scopeLabel = '';
  bool _doctorScoped = false;
  int? _currentStaffId;
  bool _queuePanelCollapsed = false;
  bool _queuePanelManuallyToggled = false;
  late final ScrollController _queuePanelScrollController;
  int _loadGeneration = 0;
  bool _hasLoadedAppointments = false;

  bool get _canBookAppointments => !_doctorScoped;
  bool get _doctorWorkspaceMode => widget.workspaceMode && _doctorScoped;
  String get _screenTitle {
    final s = AppStrings.of(context);
    return _doctorWorkspaceMode
        ? s.lookup('s4.lib.appointments.op_workspace')
        : s.lookup('s4.lib.appointments.appointments');
  }

  List<StaffAppointment> get _filtered => _appointmentsByDate.values
      .expand((rows) => rows)
      .where(_matchesCalendarFilters)
      .toList();

  List<StaffAppointment> get _weekAppointments =>
      _appointmentsByDate.values.expand((rows) => rows).toList();

  List<StaffAppointment> _appointmentsForDate(DateTime date) =>
      (_appointmentsByDate[_dateParam(date)] ?? const [])
          .where(_matchesCalendarFilters)
          .toList(growable: false);

  bool _matchesCalendarFilters(StaffAppointment appointment) {
    return appointmentMatchesCalendarFilters(
      appointment,
      patientQuery: _patientSearchQuery,
      doctorDepartmentQuery: _doctorDepartmentQuery,
    );
  }

  static const _statuses = appointmentCalendarStatusFilters;

  StreamSubscription<RealtimeEvent>? _appointmentsSub;
  Timer? _refreshDebounce;

  @override
  void initState() {
    super.initState();
    _queuePanelScrollController = ScrollController();
    _selectedDate = _dateOnly(widget.initialDate ?? DateTime.now());
    _load();
    if (widget.autoRefresh) {
      _attachRealtime();
    }
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
        if (mounted) {
          _load(showLoading: false, preserveLastKnownData: true);
        }
      });
    });
  }

  @override
  void dispose() {
    _appointmentsSub?.cancel();
    _refreshDebounce?.cancel();
    _queuePanelScrollController.dispose();
    super.dispose();
  }

  Future<void> _load({
    bool showLoading = true,
    bool preserveLastKnownData = false,
  }) async {
    if (!mounted) return;
    final generation = ++_loadGeneration;
    final selectedDate = _selectedDate;
    final selectedStatus = _selectedStatus;
    if (showLoading && !_hasLoadedAppointments) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final role = (await (widget.loadRole?.call() ?? ApiConfig.getRole()))
          .toUpperCase();
      final doctorScoped = _isDoctorQueueRole(role);
      final doctorId = doctorScoped
          ? await (widget.loadStaffId?.call() ?? ApiConfig.getStaffId())
          : null;
      final days = _appointmentWeekDays(selectedDate);
      final results = await Future.wait(
        days.map((day) {
          final loader = widget.loadAppointments;
          if (loader != null) {
            return loader(
              doctorId: doctorId,
              date: _dateParam(day),
              status: selectedStatus == 'all' ? null : selectedStatus,
              page: 1,
              limit: 100,
            );
          }
          return ScheduleApiService.getAppointments(
            doctorId: doctorId,
            date: _dateParam(day),
            status: selectedStatus == 'all' ? null : selectedStatus,
            page: 1,
            limit: 100,
          );
        }),
      );
      if (!mounted || generation != _loadGeneration) return;
      final byDate = <String, List<StaffAppointment>>{};
      final s = AppStrings.of(context);
      for (var index = 0; index < days.length; index += 1) {
        byDate[_dateParam(days[index])] = StaffAppointment.listFrom(
          results[index],
          patientFallback: s.patientRecordsUnknownPatient,
        );
      }
      if (mounted) {
        setState(() {
          _appointmentsByDate = byDate;
          _hasLoadedAppointments = true;
          _error = null;
          _doctorScoped = doctorScoped;
          _currentStaffId = int.tryParse(doctorId ?? '');
          _scopeLabel = doctorScoped
              ? (widget.workspaceMode
                    ? s.lookup('s4.lib.appointments.my_op_workspace_queue')
                    : s.lookup('s4.lib.appointments.my_op_queue'))
              : s.lookup('s4.lib.appointments.all_op_queues');
          if (!_queuePanelManuallyToggled) {
            _queuePanelCollapsed = doctorScoped;
          }
        });
      }
    } catch (e) {
      if (mounted && generation == _loadGeneration) {
        setState(() {
          if (!_hasLoadedAppointments &&
              (!preserveLastKnownData || _appointmentsByDate.isEmpty)) {
            _error = e.toString().replaceFirst('Exception: ', '');
          }
        });
      }
    } finally {
      if (mounted && generation == _loadGeneration) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _selectDate(DateTime date) async {
    final next = _dateOnly(date);
    if (_selectedDate == next) return;
    final needsReload =
        appointmentWeekStart(_selectedDate) != appointmentWeekStart(next);
    setState(() => _selectedDate = next);
    if (needsReload) await _load();
  }

  Future<void> _shiftWeek(int delta) async {
    await _selectDate(_selectedDate.add(Duration(days: delta * 7)));
  }

  Future<void> _shiftMonth(int delta) async {
    final next = DateTime(_selectedDate.year, _selectedDate.month + delta, 1);
    await _selectDate(next);
  }

  void _toggleQueuePanel() {
    setState(() {
      _queuePanelCollapsed = !_queuePanelCollapsed;
      _queuePanelManuallyToggled = true;
    });
  }

  Future<void> _updateStatus(String id, String status) async {
    try {
      await ScheduleApiService.updateAppointmentStatus(id, status);
      if (!mounted) return;
      final s = AppStrings.of(context);
      SuccessToast.show(
        context,
        s.format('s4.dynamic.appointments.status_updated_successfully', {
          'status': appointmentStatusFilterLabel(status, strings: s),
        }),
      );
      unawaited(_load());
    } catch (e) {
      if (!mounted) return;
      ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _rescheduleAppointment(StaffAppointment appointment) async {
    final id = appointment.id;
    final s = AppStrings.of(context);
    if (id == null) {
      ErrorToast.show(
        context,
        s.lookup('s4.lib.front_office_workbench.appointment_id_is_missing'),
      );
      return;
    }

    final initialDate =
        DateTime.tryParse(appointment.appointmentDate) ?? _selectedDate;
    final request = await showDialog<StaffAppointmentRescheduleRequest>(
      context: context,
      builder: (dialogContext) => StaffAppointmentRescheduleDialog(
        patientName: appointment.patientName,
        initialDate: initialDate,
        initialTime: _appointmentTimeFromText(appointment.appointmentTime),
      ),
    );
    if (request == null) return;

    try {
      await ScheduleApiService.rescheduleAppointmentInPlace(
        id,
        appointmentDate: _dateParam(request.appointmentDate),
        appointmentTime: _timeParam(request.appointmentTime),
        notes: request.notes?.trim().isEmpty == false
            ? request.notes!.trim()
            : 'Rescheduled from Appointments screen',
      );
      if (!mounted) return;
      SuccessToast.show(
        context,
        s.lookup('s4.lib.front_office_workbench.appointment_rescheduled'),
      );
      unawaited(_load());
    } catch (e) {
      if (!mounted) return;
      ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
    }
  }

  String _appointmentPatientRoute(StaffAppointment appointment) {
    return opDoctorWorkspaceRouteFromAppointment(appointment);
  }

  void _openAppointmentPatient(StaffAppointment appointment) {
    if (appointment.canCurrentStaffJoinTeleconsult(_currentStaffId)) {
      final teleconsultContext = appointment.toTeleconsultContext();
      context.push(
        teleconsultContext.consultRoute(),
        extra: StaffTeleconsultRouteArgs(appointment: teleconsultContext),
      );
      return;
    }
    context.push(_appointmentPatientRoute(appointment));
  }

  Future<void> _createAppointment() async {
    final s = AppStrings.of(context);
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
    var selectedVisitType = 'NEW';
    var submitting = false;
    var lookupMessage = s.lookup(
      's4.lib.appointments.enter_phone_to_check_registered_patient',
    );
    var patientLookupBusy = false;
    var patientLookupFailed = false;
    var patientNameReadOnly = false;
    int? resolvedPatientId;
    String? verifiedPatientPhone;
    var lookupGeneration = 0;
    int? selectedDoctorId;
    String? selectedDoctorUid;
    Map<String, dynamic>? selectedDoctor;
    Timer? lookupDebounce;
    var sheetActive = true;

    Future<void> lookupPatient(
      StateSetter setSheetState, {
      required int generation,
      required String phone,
    }) async {
      final last10 = _digitsOnly(phone).length >= 10
          ? _digitsOnly(phone).substring(_digitsOnly(phone).length - 10)
          : _digitsOnly(phone);
      if (!appointmentPatientLookupResultIsCurrent(
        capturedGeneration: generation,
        currentGeneration: lookupGeneration,
        capturedPhone: phone,
        currentPhone: patientPhoneCtrl.text,
      )) {
        return;
      }
      if (last10.length < 10) {
        setSheetState(() {
          resolvedPatientId = null;
          verifiedPatientPhone = null;
          patientLookupBusy = false;
          patientLookupFailed = false;
          patientNameReadOnly = false;
          lookupMessage = s.lookup(
            's4.lib.appointments.enter_phone_to_check_registered_patient',
          );
        });
        return;
      }

      setSheetState(() {
        patientLookupBusy = true;
        patientLookupFailed = false;
        resolvedPatientId = null;
        verifiedPatientPhone = null;
        patientNameReadOnly = false;
        lookupMessage = s.lookup(
          's4.lib.appointments.checking_patient_registry',
        );
      });

      try {
        final matches = await PatientApiService.search(phone, limit: 10);
        if (!mounted ||
            !sheetActive ||
            !appointmentPatientLookupResultIsCurrent(
              capturedGeneration: generation,
              currentGeneration: lookupGeneration,
              capturedPhone: phone,
              currentPhone: patientPhoneCtrl.text,
            )) {
          return;
        }
        final exact = matches.cast<Map<String, dynamic>?>().firstWhere(
          (patient) =>
              patient != null &&
              _digitsOnly(patient['phone']?.toString() ?? '').endsWith(last10),
          orElse: () => null,
        );
        if (exact == null) {
          setSheetState(() {
            patientLookupBusy = false;
            patientLookupFailed = false;
            verifiedPatientPhone = last10;
            patientNameReadOnly = false;
            lookupMessage = s.lookup(
              's4.lib.appointments.new_patient_enter_name_to_register',
            );
          });
          return;
        }

        final id = int.tryParse(exact['id']?.toString() ?? '');
        setSheetState(() {
          resolvedPatientId = id;
          patientLookupBusy = false;
          patientLookupFailed = false;
          verifiedPatientPhone = last10;
          patientNameReadOnly = true;
          patientNameCtrl.text = exact['name']?.toString() ?? '';
          lookupMessage = id == null
              ? s.lookup('s4.lib.appointments.existing_patient_found')
              : s.format('s4.dynamic.appointments.existing_patient_found_id', {
                  'id': id,
                });
        });
      } catch (_) {
        if (!mounted ||
            !sheetActive ||
            !appointmentPatientLookupResultIsCurrent(
              capturedGeneration: generation,
              currentGeneration: lookupGeneration,
              capturedPhone: phone,
              currentPhone: patientPhoneCtrl.text,
            )) {
          return;
        }
        setSheetState(() {
          patientLookupBusy = false;
          patientLookupFailed = true;
          verifiedPatientPhone = null;
          patientNameReadOnly = false;
          lookupMessage = s.lookup(
            's4.lib.appointments.could_not_check_registry_new_patient_available',
          );
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
              if (!appointmentPatientLookupCanSubmit(
                currentPhone: patientPhoneCtrl.text,
                verifiedPhone: verifiedPatientPhone,
                lookupBusy: patientLookupBusy,
                lookupFailed: patientLookupFailed,
              )) {
                ScaffoldMessenger.of(ctx).showSnackBar(
                  SnackBar(
                    content: Text(
                      s.lookup(
                        's4.lib.appointments.could_not_check_registry_new_patient_available',
                      ),
                    ),
                    backgroundColor: AppTheme.errorRed,
                  ),
                );
                return;
              }
              final selectedDepartment = departmentCtrl.text.trim();
              if (selectedDoctorId == null && selectedDepartment.isEmpty) {
                ScaffoldMessenger.of(ctx).showSnackBar(
                  const SnackBar(
                    content: AppText(
                      's4.lib.appointments.select_a_doctor_or_department',
                    ),
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
                  visitType: selectedVisitType,
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
                            child: AppText(
                              's4.lib.appointments.create_appointment',
                              style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          IconButton(
                            icon: const Icon(Icons.close),
                            tooltip: AppStrings.of(
                              context,
                            ).lookup('action.close'),
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
                          labelText: AppStrings.of(
                            context,
                          ).lookup('reception_counter.patient.phone'),
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
                        onChanged: (value) {
                          lookupDebounce?.cancel();
                          final generation = ++lookupGeneration;
                          final hadResolvedIdentity =
                              resolvedPatientId != null || patientNameReadOnly;
                          setSheetState(() {
                            resolvedPatientId = null;
                            verifiedPatientPhone = null;
                            patientLookupBusy = false;
                            patientLookupFailed = false;
                            patientNameReadOnly = false;
                            if (hadResolvedIdentity) patientNameCtrl.clear();
                            lookupMessage = s.lookup(
                              's4.lib.appointments.enter_phone_to_check_registered_patient',
                            );
                          });
                          final capturedPhone = value.trim();
                          lookupDebounce = Timer(
                            const Duration(milliseconds: 450),
                            () {
                              if (ctx.mounted) {
                                lookupPatient(
                                  setSheetState,
                                  generation: generation,
                                  phone: capturedPhone,
                                );
                              }
                            },
                          );
                        },
                        validator: (value) {
                          final digits = _digitsOnly(value?.trim() ?? '');
                          return digits.length < 10
                              ? s.lookup(
                                  's4.lib.appointments.enter_a_valid_phone_number',
                                )
                              : null;
                        },
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: patientNameCtrl,
                        readOnly: patientNameReadOnly,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('reception_counter.patient.name'),
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.person_outline),
                          ),
                        ),
                        validator: (value) {
                          if (resolvedPatientId != null) return null;
                          final name = value?.trim() ?? '';
                          return name.length < 2
                              ? s.lookup(
                                  's4.lib.appointments.enter_patient_name_for_new_patient',
                                )
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
                                displayStringForOption: (doctor) =>
                                    _doctorLabelWithStrings(doctor, s: s),
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
                                    doctorCtrl.text = _doctorLabelWithStrings(
                                      doctor,
                                      s: s,
                                    );
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
                                          labelText: AppStrings.of(context)
                                              .lookup(
                                                'prescriptions.doctor_label',
                                              ),
                                          hintText: loading
                                              ? s.lookup(
                                                  's4.lib.appointments.loading_doctors',
                                                )
                                              : snapshot.hasError
                                              ? s.lookup(
                                                  's4.lib.appointments.could_not_load_doctors',
                                                )
                                              : s.lookup(
                                                  's4.lib.appointments.type_doctor_name',
                                                ),
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
                                              : _doctorLabelWithStrings(
                                                  selectedDoctor!,
                                                  s: s,
                                                );
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
                                            ? s.lookup(
                                                's4.lib.appointments.select_a_doctor_or_department',
                                              )
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
                                                    s.prescriptionsDoctorLabel,
                                                overflow: TextOverflow.ellipsis,
                                              ),
                                              subtitle: Text(
                                                [
                                                      _doctorDepartment(doctor),
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
                                        decoration: InputDecoration(
                                          labelText: AppStrings.of(
                                            context,
                                          ).lookup('profile.field.department'),
                                          hintText: AppStrings.of(context).lookup(
                                            's4.lib.appointments.any_available_doctor',
                                          ),
                                          prefixIcon: const ExcludeSemantics(
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
                                            ? s.lookup(
                                                's4.lib.appointments.select_a_doctor_or_department',
                                              )
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
                      DropdownButtonFormField<String>(
                        initialValue: selectedVisitType,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('s4.lib.front_office_workbench.visit_type'),
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.assignment_outlined),
                          ),
                        ),
                        items: const [
                          DropdownMenuItem(
                            value: 'NEW',
                            child: AppText(
                              's4.lib.front_office_workbench.new_consultation',
                            ),
                          ),
                          DropdownMenuItem(
                            value: 'FOLLOW_UP',
                            child: AppText(
                              's4.lib.front_office_workbench.follow_up',
                            ),
                          ),
                          DropdownMenuItem(
                            value: 'TELE',
                            child: AppText(
                              's4.lib.front_office_workbench.teleconsult',
                            ),
                          ),
                        ],
                        onChanged: submitting
                            ? null
                            : (value) {
                                if (value == null) return;
                                setSheetState(() => selectedVisitType = value);
                              },
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: reasonCtrl,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('drug_chart.stop_reason_label'),
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.subject_outlined),
                          ),
                        ),
                        minLines: 2,
                        maxLines: 3,
                        validator: (value) {
                          final trimmed = value?.trim() ?? '';
                          return trimmed.length < 3
                              ? s.lookup(
                                  's4.lib.appointments.enter_at_least_3_characters',
                                )
                              : null;
                        },
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: notesCtrl,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('appt_queue.notes_optional'),
                          prefixIcon: const ExcludeSemantics(
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
                            submitting
                                ? s.lookup('s4.lib.appointments.creating')
                                : s.lookup(
                                    's4.lib.appointments.create_appointment',
                                  ),
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
      sheetActive = false;

      if (created == true && mounted) {
        SuccessToast.show(
          context,
          s.lookup('s4.lib.appointments.appointment_created_successfully'),
        );
        unawaited(_load());
      }
    } finally {
      sheetActive = false;
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

  Widget _buildStatusChips() {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final status in _statuses)
          ChoiceChip(
            label: Text(
              appointmentStatusFilterLabel(
                status,
                strings: AppStrings.of(context),
              ),
            ),
            selected: status == _selectedStatus,
            onSelected: (_) {
              setState(() => _selectedStatus = status);
              _load();
            },
            selectedColor: AppTheme.primaryBlue.withValues(alpha: 0.16),
            labelStyle: TextStyle(
              color: status == _selectedStatus
                  ? AppTheme.primaryBlue
                  : AppTheme.textSecondary,
              fontSize: 11,
              fontWeight: status == _selectedStatus
                  ? FontWeight.w800
                  : FontWeight.w600,
            ),
          ),
      ],
    );
  }

  Widget _buildToolbar() {
    final weekStart = appointmentWeekStart(_selectedDate);
    final title = _appointmentWeekTitle(weekStart);
    return Container(
      color: AppTheme.cardSurface,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final searchWidth = constraints.maxWidth >= 1100
              ? 340.0
              : constraints.maxWidth >= 760
              ? 260.0
              : constraints.maxWidth - 32;
          return Wrap(
            spacing: 10,
            runSpacing: 10,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              OutlinedButton(
                onPressed: () => _selectDate(DateTime.now()),
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size(0, 40),
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                ),
                child: const AppText('attendance.tab.today'),
              ),
              IconButton(
                tooltip: AppStrings.of(context).lookup('schedule.prev_week'),
                onPressed: () => _shiftWeek(-1),
                icon: const Icon(Icons.chevron_left),
              ),
              IconButton(
                tooltip: AppStrings.of(context).lookup('schedule.next_week'),
                onPressed: () => _shiftWeek(1),
                icon: const Icon(Icons.chevron_right),
              ),
              SizedBox(
                width: constraints.maxWidth >= 900 ? 210 : searchWidth,
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    color: AppTheme.textPrimary,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
              SizedBox(
                width: searchWidth,
                child: TextField(
                  decoration: InputDecoration(
                    hintText: AppStrings.of(
                      context,
                    ).lookup('s4.lib.appointments.search_patient_or_phone'),
                    prefixIcon: const Icon(Icons.search),
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 11,
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                    filled: true,
                    fillColor: AppTheme.surfaceWhite,
                  ),
                  onChanged: (v) => setState(() => _patientSearchQuery = v),
                ),
              ),
              SizedBox(
                width: searchWidth,
                child: _DoctorDepartmentFilterField(
                  value: _doctorDepartmentQuery,
                  options: appointmentDoctorDepartmentFilterOptions(
                    _weekAppointments,
                    _doctorDepartmentQuery,
                  ),
                  onChanged: (v) => setState(() => _doctorDepartmentQuery = v),
                  onSelected: (v) => setState(() => _doctorDepartmentQuery = v),
                ),
              ),
              _CalendarModePill(scopeLabel: _scopeLabel),
              if (_canBookAppointments)
                FilledButton.icon(
                  onPressed: _createAppointment,
                  icon: const Icon(Icons.add, size: 18),
                  label: const AppText('s4.lib.appointments.book_op'),
                  style: FilledButton.styleFrom(
                    minimumSize: const Size(0, 40),
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }

  void _openAppointmentActions(StaffAppointment appointment) {
    if (_doctorScoped) {
      _openAppointmentPatient(appointment);
      return;
    }
    final statusColor = _appointmentStatusColor(appointment.status);
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppTheme.cardSurface,
      showDragHandle: true,
      builder: (sheetContext) {
        final s = AppStrings.of(sheetContext);
        final id = appointment.id?.toString() ?? '';
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        appointment.patientName,
                        style: Theme.of(context).textTheme.titleLarge?.copyWith(
                          color: AppTheme.textPrimary,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ),
                    _StatusBadge(
                      label: appointmentStatusFilterLabel(
                        appointment.status,
                        strings: s,
                      ),
                      color: statusColor,
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                _InfoRow(Icons.schedule_outlined, appointment.scheduledLabel),
                if (appointment.department.isNotEmpty)
                  _InfoRow(Icons.business_outlined, appointment.department),
                if (appointment.doctorName.isNotEmpty)
                  _InfoRow(Icons.person_outlined, appointment.doctorName),
                if (appointment.reason.isNotEmpty)
                  _InfoRow(Icons.local_hospital_outlined, appointment.reason),
                if (appointment.teleconsultBadgeVisible) ...[
                  const SizedBox(height: 10),
                  StaffTeleconsultBadge(state: appointment.teleconsultState),
                ],
                if (appointmentCanReschedule(appointment.status) &&
                    id.isNotEmpty) ...[
                  const SizedBox(height: 18),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton.icon(
                      onPressed: () {
                        Navigator.pop(sheetContext);
                        _rescheduleAppointment(appointment);
                      },
                      icon: const Icon(Icons.event_repeat_outlined, size: 18),
                      label: const AppText(
                        's4.lib.front_office_workbench.reschedule',
                      ),
                    ),
                  ),
                  if (appointment.isScheduled) ...[
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: () {
                              Navigator.pop(sheetContext);
                              _updateStatus(id, 'cancelled');
                            },
                            icon: const Icon(Icons.close, size: 18),
                            label: const AppText('action.cancel'),
                            style: OutlinedButton.styleFrom(
                              foregroundColor: AppTheme.errorOnSurface,
                              side: BorderSide(color: AppTheme.errorOnSurface),
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: FilledButton.icon(
                            onPressed: () {
                              Navigator.pop(sheetContext);
                              _updateStatus(id, 'confirmed');
                            },
                            icon: const Icon(Icons.check, size: 18),
                            label: const AppText('action.confirm'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildCalendarSurface() {
    if (_loading) return const SkeletonList();
    if (_error != null) {
      final s = AppStrings.of(context);
      return ErrorState(
        message: s.format('s4.dynamic.appointments.load_failed_detail', {
          'error': _error!.replaceFirst('Exception: ', ''),
        }),
        onRetry: _load,
      );
    }

    final weekDays = _appointmentWeekDays(_selectedDate);
    final selectedDayAppointments = _appointmentsForDate(_selectedDate);
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 1040;
        final sidebar = _SchedulerSidebar(
          selectedDate: _selectedDate,
          scopeLabel: _scopeLabel,
          visibleCount: _filtered.length,
          selectedDayAppointments: selectedDayAppointments,
          statusChips: _buildStatusChips(),
          onDateSelected: _selectDate,
          onPreviousMonth: () => _shiftMonth(-1),
          onNextMonth: () => _shiftMonth(1),
          onAppointmentTap: _openAppointmentActions,
          onCollapse: wide ? _toggleQueuePanel : null,
        );
        final board = _WeekCalendarBoard(
          days: weekDays,
          selectedDate: _selectedDate,
          appointmentsByDate: _appointmentsByDate,
          patientQuery: _patientSearchQuery,
          doctorDepartmentQuery: _doctorDepartmentQuery,
          onDateSelected: _selectDate,
          onAppointmentTap: _openAppointmentActions,
        );

        if (!wide) {
          return SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [sidebar, const SizedBox(height: 14), board],
            ),
          );
        }

        return Padding(
          padding: const EdgeInsets.all(16),
          child: SizedBox(
            width: constraints.maxWidth - 32,
            height: constraints.maxHeight - 32,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_queuePanelCollapsed)
                  SizedBox(
                    width: 72,
                    child: _SchedulerCollapsedRail(
                      selectedDate: _selectedDate,
                      scopeLabel: _scopeLabel,
                      visibleCount: _filtered.length,
                      selectedDayCount: selectedDayAppointments.length,
                      onExpand: _toggleQueuePanel,
                    ),
                  )
                else
                  SizedBox(
                    width: constraints.maxWidth >= 1280 ? 286 : 254,
                    child: Scrollbar(
                      controller: _queuePanelScrollController,
                      thumbVisibility: true,
                      interactive: true,
                      child: SingleChildScrollView(
                        controller: _queuePanelScrollController,
                        child: sidebar,
                      ),
                    ),
                  ),
                const SizedBox(width: 12),
                Expanded(child: board),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: _screenTitle,
      body: ConstrainedContent(
        child: Column(
          children: [
            RealtimeStatusBanner(
              watchChannels: const {'staff:appointments'},
              deniedMessageKey: 's4.lib.realtime_status.stale',
              fallbackPoll: () =>
                  _load(showLoading: false, preserveLastKnownData: true),
              margin: const EdgeInsets.only(bottom: 12),
            ),
            _buildToolbar(),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: _buildCalendarSurface(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class StaffAppointmentRescheduleRequest {
  final DateTime appointmentDate;
  final TimeOfDay appointmentTime;
  final String? notes;

  const StaffAppointmentRescheduleRequest({
    required this.appointmentDate,
    required this.appointmentTime,
    this.notes,
  });
}

class StaffAppointmentRescheduleDialog extends StatefulWidget {
  final String patientName;
  final DateTime initialDate;
  final TimeOfDay initialTime;
  final DateTime? firstDate;

  const StaffAppointmentRescheduleDialog({
    super.key,
    required this.patientName,
    required this.initialDate,
    required this.initialTime,
    this.firstDate,
  });

  @override
  State<StaffAppointmentRescheduleDialog> createState() =>
      _StaffAppointmentRescheduleDialogState();
}

class _StaffAppointmentRescheduleDialogState
    extends State<StaffAppointmentRescheduleDialog> {
  late DateTime _appointmentDate;
  late TimeOfDay _appointmentTime;
  late final TextEditingController _notesCtrl;

  DateTime get _firstDate => _dateOnly(widget.firstDate ?? DateTime.now());

  @override
  void initState() {
    super.initState();
    final initialDate = _dateOnly(widget.initialDate);
    final firstDate = _firstDate;
    _appointmentDate = initialDate.isBefore(firstDate)
        ? firstDate
        : initialDate;
    _appointmentTime = widget.initialTime;
    _notesCtrl = TextEditingController();
  }

  @override
  void dispose() {
    _notesCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final firstDate = _firstDate;
    final picked = await showDatePicker(
      context: context,
      initialDate: _appointmentDate.isBefore(firstDate)
          ? firstDate
          : _appointmentDate,
      firstDate: firstDate,
      lastDate: DateTime(firstDate.year + 1, firstDate.month, firstDate.day),
    );
    if (picked != null) setState(() => _appointmentDate = picked);
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: _appointmentTime,
    );
    if (picked != null) setState(() => _appointmentTime = picked);
  }

  void _submit() {
    Navigator.of(context).pop(
      StaffAppointmentRescheduleRequest(
        appointmentDate: _appointmentDate,
        appointmentTime: _appointmentTime,
        notes: _notesCtrl.text.trim().isEmpty ? null : _notesCtrl.text.trim(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
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
            Text(
              widget.patientName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _pickDate,
                    icon: const Icon(Icons.calendar_today_outlined),
                    label: Text(
                      DateFormat('dd MMM yyyy').format(_appointmentDate),
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _pickTime,
                    icon: const Icon(Icons.schedule_outlined),
                    label: Text(_appointmentTime.format(context)),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _notesCtrl,
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
          onPressed: () => Navigator.of(context).pop(),
          child: const AppText('action.cancel'),
        ),
        FilledButton.icon(
          onPressed: _submit,
          icon: const Icon(Icons.event_repeat_outlined),
          label: const AppText('s4.lib.front_office_workbench.reschedule'),
        ),
      ],
    );
  }
}

class _CalendarModePill extends StatelessWidget {
  final String scopeLabel;

  const _CalendarModePill({required this.scopeLabel});

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 40,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: AppTheme.primaryTeal.withValues(alpha: 0.12),
        border: Border.all(color: AppTheme.primaryTeal.withValues(alpha: 0.35)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.view_week_outlined, size: 18),
          const SizedBox(width: 8),
          AppText(
            's4.lib.appointments.week',
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(width: 10),
          Text(scopeLabel, style: TextStyle(color: AppTheme.textSecondary)),
        ],
      ),
    );
  }
}

class _DoctorDepartmentFilterField extends StatefulWidget {
  final String value;
  final List<String> options;
  final ValueChanged<String> onChanged;
  final ValueChanged<String> onSelected;

  const _DoctorDepartmentFilterField({
    required this.value,
    required this.options,
    required this.onChanged,
    required this.onSelected,
  });

  @override
  State<_DoctorDepartmentFilterField> createState() =>
      _DoctorDepartmentFilterFieldState();
}

class _DoctorDepartmentFilterFieldState
    extends State<_DoctorDepartmentFilterField> {
  late final TextEditingController _controller;
  late final FocusNode _focusNode;
  late final ScrollController _scrollController;
  bool _open = false;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.value);
    _focusNode = FocusNode();
    _scrollController = ScrollController();
    _focusNode.addListener(() {
      setState(() => _open = _focusNode.hasFocus);
    });
  }

  @override
  void didUpdateWidget(covariant _DoctorDepartmentFilterField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.value != _controller.text) {
      _controller.value = TextEditingValue(
        text: widget.value,
        selection: TextSelection.collapsed(offset: widget.value.length),
      );
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _select(String option) {
    _controller.value = TextEditingValue(
      text: option,
      selection: TextSelection.collapsed(offset: option.length),
    );
    widget.onSelected(option);
    setState(() => _open = false);
    _focusNode.unfocus();
  }

  @override
  Widget build(BuildContext context) {
    final showDropdown = _open;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _controller,
          focusNode: _focusNode,
          decoration: InputDecoration(
            hintText: AppStrings.of(
              context,
            ).lookup('s4.lib.appointments.filter_doctor_or_department'),
            prefixIcon: const Icon(Icons.manage_search_outlined),
            suffixIcon: _controller.text.trim().isEmpty
                ? const Icon(Icons.arrow_drop_down)
                : IconButton(
                    tooltip: AppStrings.of(context).lookup(
                      's4.lib.appointments.clear_doctor_or_department_filter',
                    ),
                    onPressed: () {
                      _controller.clear();
                      widget.onChanged('');
                      setState(() => _open = true);
                      _focusNode.requestFocus();
                    },
                    icon: const Icon(Icons.close, size: 18),
                  ),
            isDense: true,
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 12,
              vertical: 11,
            ),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
            filled: true,
            fillColor: AppTheme.surfaceWhite,
          ),
          onTap: () => setState(() => _open = true),
          onChanged: (value) {
            widget.onChanged(value);
            setState(() => _open = true);
          },
        ),
        if (showDropdown) ...[
          const SizedBox(height: 4),
          Material(
            color: AppTheme.cardSurface,
            elevation: 4,
            borderRadius: BorderRadius.circular(8),
            child: Container(
              constraints: const BoxConstraints(maxHeight: 190),
              decoration: BoxDecoration(
                border: Border.all(color: AppTheme.divider),
                borderRadius: BorderRadius.circular(8),
              ),
              child: widget.options.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.all(12),
                      child: AppText(
                        's4.lib.appointments.no_doctor_or_department_matches',
                        style: TextStyle(color: AppTheme.textSecondary),
                      ),
                    )
                  : Scrollbar(
                      controller: _scrollController,
                      thumbVisibility: widget.options.length > 5,
                      child: ListView.builder(
                        controller: _scrollController,
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        shrinkWrap: true,
                        itemCount: widget.options.length,
                        itemBuilder: (context, index) {
                          final option = widget.options[index];
                          final isDepartment = !option.toLowerCase().startsWith(
                            'dr ',
                          );
                          return ListTile(
                            dense: true,
                            minLeadingWidth: 20,
                            leading: Icon(
                              isDepartment
                                  ? Icons.business_outlined
                                  : Icons.person_outline,
                              color: isDepartment
                                  ? AppTheme.primaryTeal
                                  : AppTheme.primaryBlue,
                              size: 18,
                            ),
                            title: Text(
                              option,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: AppTheme.textPrimary,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            onTap: () => _select(option),
                          );
                        },
                      ),
                    ),
            ),
          ),
        ],
      ],
    );
  }
}

class _SchedulerSidebar extends StatelessWidget {
  final DateTime selectedDate;
  final String scopeLabel;
  final int visibleCount;
  final List<StaffAppointment> selectedDayAppointments;
  final Widget statusChips;
  final ValueChanged<DateTime> onDateSelected;
  final VoidCallback onPreviousMonth;
  final VoidCallback onNextMonth;
  final ValueChanged<StaffAppointment> onAppointmentTap;
  final VoidCallback? onCollapse;

  const _SchedulerSidebar({
    required this.selectedDate,
    required this.scopeLabel,
    required this.visibleCount,
    required this.selectedDayAppointments,
    required this.statusChips,
    required this.onDateSelected,
    required this.onPreviousMonth,
    required this.onNextMonth,
    required this.onAppointmentTap,
    this.onCollapse,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final groups = appointmentSlotGroups(
      selectedDayAppointments,
      unscheduledLabel: s.dueMedsUnscheduled,
    );
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
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: AppTheme.primaryBlue.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Icon(
                  Icons.event_note_outlined,
                  color: AppTheme.primaryBlue,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      scopeLabel,
                      style: TextStyle(
                        color: AppTheme.textPrimary,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    Text(
                      s.format('s4.dynamic.appointments.visible_this_week', {
                        'count': visibleCount,
                      }),
                      style: TextStyle(
                        color: AppTheme.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
              if (onCollapse != null)
                IconButton(
                  tooltip: AppStrings.of(
                    context,
                  ).lookup('s4.lib.appointments.collapse_queue_panel'),
                  onPressed: onCollapse,
                  icon: const Icon(Icons.keyboard_double_arrow_left),
                ),
            ],
          ),
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(
                child: Text(
                  DateFormat('MMMM yyyy').format(selectedDate),
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
              IconButton(
                tooltip: AppStrings.of(
                  context,
                ).lookup('s4.lib.appointments.previous_month'),
                onPressed: onPreviousMonth,
                icon: const Icon(Icons.chevron_left),
              ),
              IconButton(
                tooltip: AppStrings.of(
                  context,
                ).lookup('s4.lib.appointments.next_month'),
                onPressed: onNextMonth,
                icon: const Icon(Icons.chevron_right),
              ),
            ],
          ),
          const SizedBox(height: 6),
          _MiniMonthCalendar(
            selectedDate: selectedDate,
            onDateSelected: onDateSelected,
          ),
          const SizedBox(height: 18),
          AppText(
            's4.lib.appointments.queue_filter',
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 8),
          statusChips,
          const SizedBox(height: 18),
          Text(
            DateFormat('EEE, d MMM').format(selectedDate),
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 8),
          if (selectedDayAppointments.isEmpty)
            _MutedPanel(
              icon: Icons.event_busy_outlined,
              text: s.lookup('s4.lib.appointments.no_appointments'),
            )
          else
            for (final entry in groups.entries) ...[
              Padding(
                padding: const EdgeInsets.only(top: 8, bottom: 6),
                child: Text(
                  entry.key,
                  style: TextStyle(
                    color: AppTheme.textSecondary,
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              for (final appointment in entry.value)
                _SidebarAppointmentRow(
                  appointment: appointment,
                  onTap: () => onAppointmentTap(appointment),
                ),
            ],
        ],
      ),
    );
  }
}

class _SchedulerCollapsedRail extends StatelessWidget {
  final DateTime selectedDate;
  final String scopeLabel;
  final int visibleCount;
  final int selectedDayCount;
  final VoidCallback onExpand;

  const _SchedulerCollapsedRail({
    required this.selectedDate,
    required this.scopeLabel,
    required this.visibleCount,
    required this.selectedDayCount,
    required this.onExpand,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Tooltip(
      message: s.lookup('s4.lib.appointments.show_queue_panel'),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onExpand,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
          decoration: BoxDecoration(
            color: AppTheme.cardSurface,
            border: Border.all(color: AppTheme.divider),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Column(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: AppTheme.primaryBlue.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Icon(
                  Icons.event_note_outlined,
                  color: AppTheme.primaryBlue,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                DateFormat('d MMM').format(selectedDate),
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: AppTheme.textPrimary,
                  fontSize: 12,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                '$selectedDayCount',
                style: const TextStyle(
                  color: AppTheme.primaryBlue,
                  fontSize: 20,
                  fontWeight: FontWeight.w900,
                ),
              ),
              Text(
                s.lookup('s4.lib.appointments.calendar_day'),
                style: TextStyle(color: AppTheme.textSecondary, fontSize: 11),
              ),
              const Divider(height: 24),
              Text(
                '$visibleCount',
                style: const TextStyle(
                  color: AppTheme.primaryTeal,
                  fontSize: 18,
                  fontWeight: FontWeight.w900,
                ),
              ),
              Text(
                s.lookup('s4.lib.appointments.calendar_week'),
                style: TextStyle(color: AppTheme.textSecondary, fontSize: 11),
              ),
              const Spacer(),
              Icon(
                Icons.keyboard_double_arrow_right,
                color: AppTheme.textSecondary,
              ),
              const SizedBox(height: 6),
              RotatedBox(
                quarterTurns: 3,
                child: Text(
                  scopeLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppTheme.textSecondary,
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MiniMonthCalendar extends StatelessWidget {
  final DateTime selectedDate;
  final ValueChanged<DateTime> onDateSelected;

  const _MiniMonthCalendar({
    required this.selectedDate,
    required this.onDateSelected,
  });

  @override
  Widget build(BuildContext context) {
    final monthStart = DateTime(selectedDate.year, selectedDate.month, 1);
    final firstCell = monthStart.subtract(
      Duration(days: monthStart.weekday - DateTime.monday),
    );
    final today = _dateOnly(DateTime.now());
    final selected = _dateOnly(selectedDate);
    final weekLabels = const ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    return Column(
      children: [
        Row(
          children: [
            for (final label in weekLabels)
              Expanded(
                child: Center(
                  child: Text(
                    label,
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 8),
        for (var row = 0; row < 6; row += 1)
          Row(
            children: [
              for (var column = 0; column < 7; column += 1)
                Expanded(
                  child: _MiniMonthDay(
                    day: firstCell.add(Duration(days: row * 7 + column)),
                    selected: selected,
                    today: today,
                    visibleMonth: selectedDate.month,
                    onDateSelected: onDateSelected,
                  ),
                ),
            ],
          ),
      ],
    );
  }
}

class _MiniMonthDay extends StatelessWidget {
  final DateTime day;
  final DateTime selected;
  final DateTime today;
  final int visibleMonth;
  final ValueChanged<DateTime> onDateSelected;

  const _MiniMonthDay({
    required this.day,
    required this.selected,
    required this.today,
    required this.visibleMonth,
    required this.onDateSelected,
  });

  @override
  Widget build(BuildContext context) {
    final isSelected = _dateOnly(day) == selected;
    final isToday = _dateOnly(day) == today;
    final inMonth = day.month == visibleMonth;
    return Padding(
      padding: const EdgeInsets.all(2),
      child: InkWell(
        borderRadius: BorderRadius.circular(7),
        onTap: () => onDateSelected(day),
        child: Container(
          height: 30,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: isSelected
                ? AppTheme.primaryBlue
                : isToday
                ? AppTheme.primaryBlue.withValues(alpha: 0.12)
                : Colors.transparent,
            border: isToday && !isSelected
                ? Border.all(color: AppTheme.primaryBlue)
                : null,
            borderRadius: BorderRadius.circular(7),
          ),
          child: Text(
            '${day.day}',
            style: TextStyle(
              color: isSelected
                  ? Colors.white
                  : inMonth
                  ? AppTheme.textPrimary
                  : AppTheme.textSecondary.withValues(alpha: 0.58),
              fontWeight: isSelected || isToday
                  ? FontWeight.w900
                  : FontWeight.w700,
            ),
          ),
        ),
      ),
    );
  }
}

class _WeekCalendarBoard extends StatefulWidget {
  final List<DateTime> days;
  final DateTime selectedDate;
  final Map<String, List<StaffAppointment>> appointmentsByDate;
  final String patientQuery;
  final String doctorDepartmentQuery;
  final ValueChanged<DateTime> onDateSelected;
  final ValueChanged<StaffAppointment> onAppointmentTap;

  const _WeekCalendarBoard({
    required this.days,
    required this.selectedDate,
    required this.appointmentsByDate,
    required this.patientQuery,
    required this.doctorDepartmentQuery,
    required this.onDateSelected,
    required this.onAppointmentTap,
  });

  @override
  State<_WeekCalendarBoard> createState() => _WeekCalendarBoardState();
}

class _WeekCalendarBoardState extends State<_WeekCalendarBoard> {
  late final ScrollController _horizontalController;
  late final ScrollController _verticalController;

  @override
  void initState() {
    super.initState();
    _horizontalController = ScrollController();
    _verticalController = ScrollController();
  }

  @override
  void dispose() {
    _horizontalController.dispose();
    _verticalController.dispose();
    super.dispose();
  }

  List<StaffAppointment> _appointmentsFor(DateTime day) =>
      (widget.appointmentsByDate[_dateParam(day)] ?? const [])
          .where(
            (appointment) => appointmentMatchesCalendarFilters(
              appointment,
              patientQuery: widget.patientQuery,
              doctorDepartmentQuery: widget.doctorDepartmentQuery,
            ),
          )
          .toList(growable: false);

  List<StaffAppointment> _appointmentsForHour(DateTime day, int hour) {
    final start = hour * 60;
    final end = start + 60;
    return _appointmentsFor(day)
        .where((appointment) {
          final minute = appointmentMinuteOfDayFromText(
            appointment.appointmentTime,
          );
          return minute != null && minute >= start && minute < end;
        })
        .toList(growable: false);
  }

  List<StaffAppointment> _floatingAppointments(DateTime day) {
    return _appointmentsFor(day)
        .where((appointment) {
          final minute = appointmentMinuteOfDayFromText(
            appointment.appointmentTime,
          );
          return minute == null ||
              minute < _calendarStartHour * 60 ||
              minute >= _calendarEndHour * 60;
        })
        .toList(growable: false);
  }

  @override
  Widget build(BuildContext context) {
    final selected = _dateOnly(widget.selectedDate);
    return LayoutBuilder(
      builder: (context, constraints) {
        final compact = constraints.maxWidth < 960;
        final minDayWidth = compact ? 96.0 : 118.0;
        final minWidth =
            _calendarTimeGutterWidth + (minDayWidth * widget.days.length);
        final boardWidth = constraints.maxWidth > minWidth
            ? constraints.maxWidth
            : minWidth;
        final dayWidth =
            (boardWidth - _calendarTimeGutterWidth) / widget.days.length;
        final hourHeight = _calendarHourHeightForWidth(constraints.maxWidth);
        final headerHeight = _calendarHeaderHeightForWidth(
          constraints.maxWidth,
        );
        final floatingHeight = compact ? 96.0 : 112.0;
        final content = SizedBox(
          width: boardWidth,
          child: Scrollbar(
            controller: _verticalController,
            thumbVisibility: true,
            interactive: true,
            child: SingleChildScrollView(
              controller: _verticalController,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _WeekHeader(
                    days: widget.days,
                    selectedDate: selected,
                    dayWidth: dayWidth,
                    height: headerHeight,
                    onDateSelected: widget.onDateSelected,
                    appointmentCountFor: (day) => _appointmentsFor(day).length,
                  ),
                  _FloatingAppointmentRow(
                    days: widget.days,
                    dayWidth: dayWidth,
                    height: floatingHeight,
                    selectedDate: selected,
                    appointmentsFor: _floatingAppointments,
                    onDateSelected: widget.onDateSelected,
                    onAppointmentTap: widget.onAppointmentTap,
                  ),
                  for (
                    var hour = _calendarStartHour;
                    hour < _calendarEndHour;
                    hour += 1
                  )
                    _HourRow(
                      hour: hour,
                      days: widget.days,
                      dayWidth: dayWidth,
                      hourHeight: hourHeight,
                      selectedDate: selected,
                      appointmentsForHour: (day) =>
                          _appointmentsForHour(day, hour),
                      onDateSelected: widget.onDateSelected,
                      onAppointmentTap: widget.onAppointmentTap,
                    ),
                ],
              ),
            ),
          ),
        );
        return Container(
          decoration: BoxDecoration(
            color: AppTheme.cardSurface,
            border: Border.all(color: AppTheme.divider),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Scrollbar(
            controller: _horizontalController,
            thumbVisibility: true,
            interactive: true,
            notificationPredicate: (notification) =>
                notification.metrics.axis == Axis.horizontal,
            child: SingleChildScrollView(
              controller: _horizontalController,
              scrollDirection: Axis.horizontal,
              child: content,
            ),
          ),
        );
      },
    );
  }
}

class _WeekHeader extends StatelessWidget {
  final List<DateTime> days;
  final DateTime selectedDate;
  final double dayWidth;
  final double height;
  final ValueChanged<DateTime> onDateSelected;
  final int Function(DateTime day) appointmentCountFor;

  const _WeekHeader({
    required this.days,
    required this.selectedDate,
    required this.dayWidth,
    required this.height,
    required this.onDateSelected,
    required this.appointmentCountFor,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppTheme.surfaceWhite,
        border: Border(bottom: BorderSide(color: AppTheme.divider)),
        borderRadius: const BorderRadius.vertical(top: Radius.circular(8)),
      ),
      child: Row(
        children: [
          SizedBox(
            width: _calendarTimeGutterWidth,
            height: height,
            child: Align(
              alignment: Alignment.bottomCenter,
              child: Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: AppText(
                  's4.lib.appointments.gmt_5_30',
                  style: TextStyle(
                    color: AppTheme.textSecondary,
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ),
          ),
          for (final day in days)
            _DayHeaderCell(
              day: day,
              width: dayWidth,
              height: height,
              selected: _dateOnly(day) == selectedDate,
              today: _dateOnly(day) == _dateOnly(DateTime.now()),
              count: appointmentCountFor(day),
              onTap: () => onDateSelected(day),
            ),
        ],
      ),
    );
  }
}

class _DayHeaderCell extends StatelessWidget {
  final DateTime day;
  final double width;
  final double height;
  final bool selected;
  final bool today;
  final int count;
  final VoidCallback onTap;

  const _DayHeaderCell({
    required this.day,
    required this.width,
    required this.height,
    required this.selected,
    required this.today,
    required this.count,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Container(
        width: width,
        height: height,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
        decoration: BoxDecoration(
          color: selected
              ? AppTheme.primaryBlue.withValues(alpha: 0.12)
              : Colors.transparent,
          border: Border(left: BorderSide(color: AppTheme.divider)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              DateFormat('EEE').format(day),
              style: TextStyle(
                color: AppTheme.textSecondary,
                fontWeight: FontWeight.w800,
              ),
            ),
            const Spacer(),
            Row(
              children: [
                Container(
                  constraints: const BoxConstraints(minWidth: 30),
                  height: 30,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: selected
                        ? AppTheme.primaryBlue
                        : today
                        ? AppTheme.primaryBlue.withValues(alpha: 0.14)
                        : Colors.transparent,
                    border: today && !selected
                        ? Border.all(color: AppTheme.primaryBlue)
                        : null,
                    borderRadius: BorderRadius.circular(7),
                  ),
                  child: Text(
                    '${day.day}',
                    style: TextStyle(
                      color: selected ? Colors.white : AppTheme.textPrimary,
                      fontSize: 18,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  '$count',
                  style: TextStyle(
                    color: AppTheme.textSecondary,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _FloatingAppointmentRow extends StatelessWidget {
  final List<DateTime> days;
  final double dayWidth;
  final double height;
  final DateTime selectedDate;
  final List<StaffAppointment> Function(DateTime day) appointmentsFor;
  final ValueChanged<DateTime> onDateSelected;
  final ValueChanged<StaffAppointment> onAppointmentTap;

  const _FloatingAppointmentRow({
    required this.days,
    required this.dayWidth,
    required this.height,
    required this.selectedDate,
    required this.appointmentsFor,
    required this.onDateSelected,
    required this.onAppointmentTap,
  });

  @override
  Widget build(BuildContext context) {
    final hasFloating = days.any((day) => appointmentsFor(day).isNotEmpty);
    if (!hasFloating) return const SizedBox.shrink();
    return SizedBox(
      height: height,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: _calendarTimeGutterWidth,
            child: Center(
              child: AppText(
                's4.lib.appointments.flex',
                style: TextStyle(
                  color: AppTheme.textSecondary,
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
          ),
          for (final day in days)
            _CalendarCell(
              width: dayWidth,
              minHeight: 80,
              selected: _dateOnly(day) == selectedDate,
              onTap: () => onDateSelected(day),
              appointments: appointmentsFor(day),
              onAppointmentTap: onAppointmentTap,
            ),
        ],
      ),
    );
  }
}

class _HourRow extends StatelessWidget {
  final int hour;
  final List<DateTime> days;
  final double dayWidth;
  final double hourHeight;
  final DateTime selectedDate;
  final List<StaffAppointment> Function(DateTime day) appointmentsForHour;
  final ValueChanged<DateTime> onDateSelected;
  final ValueChanged<StaffAppointment> onAppointmentTap;

  const _HourRow({
    required this.hour,
    required this.days,
    required this.dayWidth,
    required this.hourHeight,
    required this.selectedDate,
    required this.appointmentsForHour,
    required this.onDateSelected,
    required this.onAppointmentTap,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: hourHeight,
      child: Row(
        children: [
          SizedBox(
            width: _calendarTimeGutterWidth,
            child: Align(
              alignment: Alignment.topCenter,
              child: Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _hourLabel(hour),
                  style: TextStyle(
                    color: AppTheme.textSecondary,
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ),
          ),
          for (final day in days)
            _CalendarCell(
              width: dayWidth,
              minHeight: hourHeight,
              selected: _dateOnly(day) == selectedDate,
              onTap: () => onDateSelected(day),
              appointments: appointmentsForHour(day),
              onAppointmentTap: onAppointmentTap,
            ),
        ],
      ),
    );
  }

  String _hourLabel(int hour) {
    if (hour == 0) return '12am';
    if (hour < 12) return '${hour}am';
    if (hour == 12) return '12pm';
    return '${hour - 12}pm';
  }
}

class _CalendarCell extends StatelessWidget {
  final double width;
  final double minHeight;
  final bool selected;
  final VoidCallback onTap;
  final List<StaffAppointment> appointments;
  final ValueChanged<StaffAppointment> onAppointmentTap;

  const _CalendarCell({
    required this.width,
    required this.minHeight,
    required this.selected,
    required this.onTap,
    required this.appointments,
    required this.onAppointmentTap,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final visibleAppointments = appointments.take(2).toList(growable: false);
    final extra = appointments.length - visibleAppointments.length;
    return InkWell(
      onTap: onTap,
      child: Container(
        width: width,
        constraints: BoxConstraints(minHeight: minHeight),
        padding: const EdgeInsets.all(5),
        decoration: BoxDecoration(
          color: selected
              ? AppTheme.primaryBlue.withValues(alpha: 0.05)
              : Colors.transparent,
          border: Border(
            top: BorderSide(color: AppTheme.divider),
            left: BorderSide(color: AppTheme.divider),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final appointment in visibleAppointments)
              _CalendarAppointmentPill(
                appointment: appointment,
                onTap: () => onAppointmentTap(appointment),
              ),
            if (extra > 0)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  s.format('s4.dynamic.appointments.more_count', {
                    'count': extra,
                  }),
                  style: TextStyle(
                    color: AppTheme.textSecondary,
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _CalendarAppointmentPill extends StatelessWidget {
  final StaffAppointment appointment;
  final VoidCallback onTap;

  const _CalendarAppointmentPill({
    required this.appointment,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final color = _appointmentStatusColor(appointment.status);
    final time = appointment.appointmentTime.trim().isEmpty
        ? s.lookup('s4.lib.appointments.flex')
        : appointment.appointmentTime.trim();
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(6),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 5),
          decoration: BoxDecoration(
            color: color.withValues(
              alpha: AppTheme.brightness == Brightness.dark ? 0.18 : 0.10,
            ),
            border: Border(left: BorderSide(color: color, width: 3)),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '$time  ${appointment.patientName}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: AppTheme.textPrimary,
                  fontSize: 12,
                  fontWeight: FontWeight.w900,
                ),
              ),
              if (appointment.teleconsultBadgeVisible) ...[
                const SizedBox(height: 3),
                StaffTeleconsultBadge(
                  state: appointment.teleconsultState,
                  compact: true,
                ),
              ],
              if (appointment.reason.isNotEmpty ||
                  appointment.doctorName.isNotEmpty)
                Text(
                  appointment.reason.isNotEmpty
                      ? appointment.reason
                      : appointment.doctorName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppTheme.textSecondary,
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SidebarAppointmentRow extends StatelessWidget {
  final StaffAppointment appointment;
  final VoidCallback onTap;

  const _SidebarAppointmentRow({
    required this.appointment,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final color = _appointmentStatusColor(appointment.status);
    final statusLabel = appointmentStatusFilterLabel(
      appointment.status,
      strings: s,
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(7),
        child: Container(
          padding: const EdgeInsets.all(9),
          decoration: BoxDecoration(
            color: AppTheme.surfaceWhite,
            border: Border.all(color: AppTheme.divider),
            borderRadius: BorderRadius.circular(7),
          ),
          child: Row(
            children: [
              Container(
                width: 8,
                height: 32,
                decoration: BoxDecoration(
                  color: color,
                  borderRadius: BorderRadius.circular(99),
                ),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      appointment.patientName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppTheme.textPrimary,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    if (appointment.teleconsultBadgeVisible) ...[
                      const SizedBox(height: 4),
                      StaffTeleconsultBadge(
                        state: appointment.teleconsultState,
                        compact: true,
                      ),
                    ],
                    Text(
                      appointment.appointmentTime.isEmpty
                          ? statusLabel
                          : s.format('s4.dynamic.appointments.time_status', {
                              'time': appointment.appointmentTime,
                              'status': statusLabel,
                            }),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppTheme.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MutedPanel extends StatelessWidget {
  final IconData icon;
  final String text;

  const _MutedPanel({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.surfaceWhite,
        border: Border.all(color: AppTheme.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(icon, color: AppTheme.textSecondary),
          const SizedBox(width: 8),
          Text(text, style: TextStyle(color: AppTheme.textSecondary)),
        ],
      ),
    );
  }
}

class _StatusBadge extends StatelessWidget {
  final String label;
  final Color color;

  const _StatusBadge({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(99),
      ),
      child: Text(
        label.toUpperCase(),
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w900,
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
