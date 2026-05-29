import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/services/patient_api_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../appointments/models/staff_appointment.dart';

class ReceptionCounterScreen extends StatefulWidget {
  const ReceptionCounterScreen({super.key});

  @override
  State<ReceptionCounterScreen> createState() => _ReceptionCounterScreenState();
}

class _ReceptionCounterScreenState extends State<ReceptionCounterScreen> {
  final _searchCtrl = TextEditingController();
  final _patientPhoneCtrl = TextEditingController();
  final _patientNameCtrl = TextEditingController();
  final _opReasonCtrl = TextEditingController();
  final _opNotesCtrl = TextEditingController();
  final _chiefComplaintCtrl = TextEditingController();
  final _diagnosisCtrl = TextEditingController();
  final _wardCtrl = TextEditingController();
  final _bedCtrl = TextEditingController();

  late final Future<List<Map<String, dynamic>>> _doctorsFuture;
  Timer? _searchDebounce;

  List<Map<String, dynamic>> _patientMatches = const [];
  List<StaffAppointment> _todayAppointments = const [];
  List<Map<String, dynamic>> _activeAdmissions = const [];
  Map<String, dynamic>? _selectedPatient;

  bool _lookupBusy = false;
  bool _workloadBusy = true;
  bool _opSubmitting = false;
  bool _ipSubmitting = false;
  String? _lookupError;
  int _tabIndex = 0;

  DateTime _appointmentDate = DateTime.now();
  late TimeOfDay _appointmentTime;
  String? _selectedDoctorKey;
  int? _selectedDoctorId;
  String? _selectedDoctorUid;
  String _selectedDoctorLabel = '';
  String _priority = 'Routine';
  String _codeStatus = 'Full Code';

  @override
  void initState() {
    super.initState();
    _doctorsFuture = ScheduleApiService.getAppointmentDoctors();
    _appointmentTime = TimeOfDay.fromDateTime(
      DateTime.now().add(const Duration(hours: 1)),
    );
    _loadWorkload();
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _searchCtrl.dispose();
    _patientPhoneCtrl.dispose();
    _patientNameCtrl.dispose();
    _opReasonCtrl.dispose();
    _opNotesCtrl.dispose();
    _chiefComplaintCtrl.dispose();
    _diagnosisCtrl.dispose();
    _wardCtrl.dispose();
    _bedCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadWorkload() async {
    setState(() => _workloadBusy = true);
    try {
      final today = DateFormat('yyyy-MM-dd').format(DateTime.now());
      final results = await Future.wait([
        ScheduleApiService.getAppointments(date: today, limit: 10),
        MedicalApiService.getActiveAdmissions(limit: 10),
      ]);
      if (!mounted) return;
      setState(() {
        _todayAppointments = StaffAppointment.listFrom(results[0]);
        _activeAdmissions = _listFromAdmissions(results[1]);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _todayAppointments = const [];
        _activeAdmissions = const [];
      });
    } finally {
      if (mounted) setState(() => _workloadBusy = false);
    }
  }

  List<Map<String, dynamic>> _listFromAdmissions(Map<String, dynamic> data) {
    dynamic value = data['admissions'] ?? data['data'] ?? data['items'];
    if (value is Map) {
      value = value['admissions'] ?? value['items'] ?? value['data'];
    }
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  void _queuePatientLookup(String value) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 350), () {
      _searchPatients(value);
    });
  }

  Future<void> _searchPatients(String rawQuery) async {
    final query = rawQuery.trim();
    if (query.length < 2) {
      setState(() {
        _patientMatches = const [];
        _lookupError = null;
        _lookupBusy = false;
      });
      return;
    }

    setState(() {
      _lookupBusy = true;
      _lookupError = null;
    });
    try {
      final patients = await PatientApiService.search(query, limit: 8);
      if (!mounted) return;
      setState(() => _patientMatches = patients);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _patientMatches = const [];
        _lookupError = e.toString().replaceFirst('Exception: ', '');
      });
    } finally {
      if (mounted) setState(() => _lookupBusy = false);
    }
  }

  void _selectPatient(Map<String, dynamic> patient) {
    final name = _text(patient['name']);
    final phone = _text(patient['phone']);
    final hospitalNumber = _text(patient['hospital_number']);
    setState(() {
      _selectedPatient = patient;
      _patientNameCtrl.text = name;
      _patientPhoneCtrl.text = phone;
      _searchCtrl.text = hospitalNumber.isNotEmpty ? hospitalNumber : name;
      _patientMatches = const [];
      _lookupError = null;
    });
  }

  int? _patientId() => _intFrom(_selectedPatient?['id']);

  String? _patientUid() {
    final value = _text(_selectedPatient?['uid']);
    return value.isEmpty ? null : value;
  }

  String _patientQuery() {
    final hospitalNumber = _text(_selectedPatient?['hospital_number']);
    final phone = _patientPhoneCtrl.text.trim();
    final name = _patientNameCtrl.text.trim();
    if (hospitalNumber.isNotEmpty) return hospitalNumber;
    if (phone.isNotEmpty) return phone;
    if (name.isNotEmpty) return name;
    return _searchCtrl.text.trim();
  }

  Future<void> _submitOpdBooking() async {
    final patientId = _patientId();
    final phone = _patientPhoneCtrl.text.trim();
    final reason = _opReasonCtrl.text.trim();
    if (patientId == null && _digitsOnly(phone).length < 10) {
      _showError('Select a patient or enter a valid phone number.');
      return;
    }
    if (_selectedDoctorId == null) {
      _showError('Select the consulting doctor.');
      return;
    }
    if (reason.isEmpty) {
      _showError('Enter the reason for visit.');
      return;
    }

    setState(() => _opSubmitting = true);
    try {
      await ScheduleApiService.createAppointment(
        patientId: patientId,
        patientPhone: patientId == null ? phone : null,
        patientName: _patientNameCtrl.text.trim(),
        doctorId: _selectedDoctorId!,
        doctorUid: _selectedDoctorUid,
        appointmentDate: DateFormat('yyyy-MM-dd').format(_appointmentDate),
        appointmentTime: _formatTime(_appointmentTime),
        reason: reason,
        notes: _opNotesCtrl.text.trim().isEmpty
            ? null
            : _opNotesCtrl.text.trim(),
      );
      if (!mounted) return;
      _showSuccess('OPD appointment booked.');
      _opReasonCtrl.clear();
      _opNotesCtrl.clear();
      await _loadWorkload();
    } catch (e) {
      if (mounted) _showError(e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _opSubmitting = false);
    }
  }

  Future<void> _submitIpAdmission() async {
    final patientQuery = _patientQuery();
    if (patientQuery.isEmpty) {
      _showError('Search and select a patient or enter a patient identifier.');
      return;
    }
    if ((_selectedDoctorUid ?? '').isEmpty) {
      _showError('Select the admitting doctor.');
      return;
    }
    if (_chiefComplaintCtrl.text.trim().isEmpty) {
      _showError('Enter the chief complaint.');
      return;
    }

    setState(() => _ipSubmitting = true);
    try {
      await MedicalApiService.admitPatient({
        'patient_query': patientQuery,
        'patient_uid': ?_patientUid(),
        'admitting_doctor': _selectedDoctorUid,
        'chief_complaint': _chiefComplaintCtrl.text.trim(),
        'provisional_diagnosis': _diagnosisCtrl.text.trim(),
        'ward': _wardCtrl.text.trim(),
        'bed': _bedCtrl.text.trim(),
        'priority': _apiPriority(_priority),
        'admission_type': _apiAdmissionType(_priority),
        'code_status': _apiCodeStatus(_codeStatus),
      });
      if (!mounted) return;
      _showSuccess('IP admission created.');
      _chiefComplaintCtrl.clear();
      _diagnosisCtrl.clear();
      _bedCtrl.clear();
      await _loadWorkload();
    } catch (e) {
      if (mounted) _showError(e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _ipSubmitting = false);
    }
  }

  String _apiPriority(String priority) {
    switch (priority.toLowerCase()) {
      case 'emergency':
      case 'critical':
        return 'emergent';
      case 'urgent':
        return 'urgent';
      default:
        return 'routine';
    }
  }

  String _apiAdmissionType(String priority) {
    final lower = priority.toLowerCase();
    return lower == 'emergency' || lower == 'critical'
        ? 'emergency'
        : 'elective';
  }

  String _apiCodeStatus(String codeStatus) {
    switch (codeStatus.toLowerCase()) {
      case 'dnr':
        return 'dnr';
      case 'dnr/dni':
        return 'dni';
      case 'comfort care':
        return 'comfort_care';
      default:
        return 'full_code';
    }
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: AppTheme.errorRed),
    );
  }

  void _showSuccess(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: AppTheme.successGreen),
    );
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Reception Counter',
      body: RefreshIndicator(
        onRefresh: _loadWorkload,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
          children: [
            _buildHeader(),
            const SizedBox(height: 12),
            _buildPatientLookup(),
            const SizedBox(height: 12),
            _buildDoctorPicker(),
            const SizedBox(height: 12),
            _buildModeSwitcher(),
            const SizedBox(height: 12),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 180),
              child: switch (_tabIndex) {
                0 => _buildOpdPanel(key: const ValueKey('opd')),
                1 => _buildIpPanel(key: const ValueKey('ip')),
                _ => _buildTodayPanel(key: const ValueKey('today')),
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildHeader() {
    return _Surface(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final compact = constraints.maxWidth < 620;
          final stats = [
            _CounterStat(
              label: 'Today OPD',
              value: '${_todayAppointments.length}',
              icon: Icons.event_available,
              color: AppTheme.primaryBlue,
            ),
            _CounterStat(
              label: 'Active IP',
              value: '${_activeAdmissions.length}',
              icon: Icons.local_hospital,
              color: AppTheme.primaryTeal,
            ),
          ];
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      color: AppTheme.primaryBlue.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: const Icon(
                      Icons.point_of_sale,
                      color: AppTheme.primaryBlue,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Counter Mode',
                          style: Theme.of(context).textTheme.titleLarge
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                        Text(
                          'Register OPD visits and IP admissions from one screen.',
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'Refresh',
                    onPressed: _loadWorkload,
                    icon: const Icon(Icons.refresh),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              if (compact)
                Column(
                  children: stats
                      .map(
                        (stat) => Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: stat,
                        ),
                      )
                      .toList(),
                )
              else
                Row(
                  children: stats
                      .map(
                        (stat) => Expanded(
                          child: Padding(
                            padding: const EdgeInsets.only(right: 8),
                            child: stat,
                          ),
                        ),
                      )
                      .toList(),
                ),
            ],
          );
        },
      ),
    );
  }

  Widget _buildPatientLookup() {
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.manage_search,
            title: 'Patient lookup',
            trailing: _selectedPatient == null
                ? null
                : TextButton.icon(
                    onPressed: () => setState(() => _selectedPatient = null),
                    icon: const Icon(Icons.close),
                    label: const Text('Clear'),
                  ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _searchCtrl,
                  onChanged: _queuePatientLookup,
                  onSubmitted: _searchPatients,
                  decoration: InputDecoration(
                    labelText: 'Hospital ID / phone / name',
                    prefixIcon: const Icon(Icons.search),
                    suffixIcon: _lookupBusy
                        ? const Padding(
                            padding: EdgeInsets.all(12),
                            child: SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          )
                        : null,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              IconButton.filledTonal(
                tooltip: 'Search',
                onPressed: () => _searchPatients(_searchCtrl.text),
                icon: const Icon(Icons.search),
              ),
            ],
          ),
          if (_lookupError != null) ...[
            const SizedBox(height: 8),
            Text(
              _lookupError!,
              style: TextStyle(color: AppTheme.errorOnSurface),
            ),
          ],
          if (_selectedPatient != null) ...[
            const SizedBox(height: 10),
            _SelectedPatientCard(patient: _selectedPatient!),
          ],
          if (_patientMatches.isNotEmpty) ...[
            const SizedBox(height: 10),
            ..._patientMatches.map(
              (patient) => _PatientMatchTile(
                patient: patient,
                onTap: () => _selectPatient(patient),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildDoctorPicker() {
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionTitle(
            icon: Icons.medical_services_outlined,
            title: 'Doctor',
          ),
          const SizedBox(height: 10),
          FutureBuilder<List<Map<String, dynamic>>>(
            future: _doctorsFuture,
            builder: (context, snapshot) {
              final doctors = snapshot.data ?? const [];
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const LinearProgressIndicator(minHeight: 2);
              }
              if (snapshot.hasError) {
                return Text(
                  'Could not load doctors.',
                  style: TextStyle(color: AppTheme.errorOnSurface),
                );
              }
              return DropdownButtonFormField<String>(
                initialValue: _selectedDoctorKey,
                decoration: const InputDecoration(
                  labelText: 'Select doctor',
                  prefixIcon: Icon(Icons.person_search_outlined),
                ),
                isExpanded: true,
                items: doctors
                    .where((doctor) => _doctorId(doctor) != null)
                    .map(
                      (doctor) => DropdownMenuItem<String>(
                        value: _doctorKey(doctor),
                        child: Text(
                          _doctorLabel(doctor),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    )
                    .toList(),
                onChanged: (key) {
                  final doctor = doctors.firstWhere(
                    (item) => _doctorKey(item) == key,
                    orElse: () => const <String, dynamic>{},
                  );
                  setState(() {
                    _selectedDoctorKey = key;
                    _selectedDoctorId = _doctorId(doctor);
                    _selectedDoctorUid = _doctorUid(doctor);
                    _selectedDoctorLabel = _doctorLabel(doctor);
                  });
                },
              );
            },
          ),
          if (_selectedDoctorLabel.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              _selectedDoctorLabel,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildModeSwitcher() {
    final tabs = const [
      (Icons.event_available, 'OPD'),
      (Icons.local_hospital, 'IP Admission'),
      (Icons.view_list, 'Today'),
    ];
    return Container(
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.divider),
      ),
      padding: const EdgeInsets.all(4),
      child: Row(
        children: [
          for (var i = 0; i < tabs.length; i++)
            Expanded(
              child: InkWell(
                borderRadius: BorderRadius.circular(10),
                onTap: () => setState(() => _tabIndex = i),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 160),
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  decoration: BoxDecoration(
                    color: _tabIndex == i
                        ? AppTheme.primaryBlue.withValues(alpha: 0.14)
                        : Colors.transparent,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        tabs[i].$1,
                        size: 18,
                        color: _tabIndex == i
                            ? AppTheme.primaryBlue
                            : AppTheme.textSecondary,
                      ),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          tabs[i].$2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: _tabIndex == i
                                ? AppTheme.primaryBlue
                                : AppTheme.textSecondary,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildOpdPanel({required Key key}) {
    return _Surface(
      key: key,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionTitle(
            icon: Icons.event_available,
            title: 'New OPD appointment',
          ),
          const SizedBox(height: 12),
          _buildPatientIdentityFields(),
          const SizedBox(height: 12),
          LayoutBuilder(
            builder: (context, constraints) {
              final compact = constraints.maxWidth < 620;
              final children = [
                _DateTimeButton(
                  icon: Icons.calendar_today,
                  label: DateFormat('dd MMM yyyy').format(_appointmentDate),
                  onTap: _pickAppointmentDate,
                ),
                _DateTimeButton(
                  icon: Icons.schedule,
                  label: _appointmentTime.format(context),
                  onTap: _pickAppointmentTime,
                ),
              ];
              if (compact) {
                return Column(
                  children: children
                      .map(
                        (child) => Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: child,
                        ),
                      )
                      .toList(),
                );
              }
              return Row(
                children: [
                  Expanded(child: children[0]),
                  const SizedBox(width: 10),
                  Expanded(child: children[1]),
                ],
              );
            },
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _opReasonCtrl,
            decoration: const InputDecoration(
              labelText: 'Reason / chief complaint',
              prefixIcon: Icon(Icons.short_text),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _opNotesCtrl,
            minLines: 2,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'Counter notes',
              prefixIcon: Icon(Icons.notes),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _opSubmitting ? null : _submitOpdBooking,
            icon: _opSubmitting
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.send),
            label: const Text('Book OPD appointment'),
          ),
        ],
      ),
    );
  }

  Widget _buildIpPanel({required Key key}) {
    return _Surface(
      key: key,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionTitle(
            icon: Icons.local_hospital,
            title: 'New IP admission',
          ),
          const SizedBox(height: 12),
          _buildPatientIdentityFields(),
          const SizedBox(height: 12),
          TextField(
            controller: _chiefComplaintCtrl,
            minLines: 2,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'Chief complaint',
              prefixIcon: Icon(Icons.report_problem_outlined),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _diagnosisCtrl,
            decoration: const InputDecoration(
              labelText: 'Provisional diagnosis',
              prefixIcon: Icon(Icons.assignment_outlined),
            ),
          ),
          const SizedBox(height: 12),
          LayoutBuilder(
            builder: (context, constraints) {
              final compact = constraints.maxWidth < 620;
              final wardField = TextField(
                controller: _wardCtrl,
                decoration: const InputDecoration(
                  labelText: 'Ward / floor',
                  prefixIcon: Icon(Icons.meeting_room_outlined),
                ),
              );
              final bedField = TextField(
                controller: _bedCtrl,
                decoration: const InputDecoration(
                  labelText: 'Bed',
                  prefixIcon: Icon(Icons.bed_outlined),
                ),
              );
              if (compact) {
                return Column(
                  children: [wardField, const SizedBox(height: 12), bedField],
                );
              }
              return Row(
                children: [
                  Expanded(child: wardField),
                  const SizedBox(width: 10),
                  Expanded(child: bedField),
                ],
              );
            },
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: _priority,
                  decoration: const InputDecoration(labelText: 'Priority'),
                  items: const ['Routine', 'Urgent', 'Emergency', 'Critical']
                      .map(
                        (value) =>
                            DropdownMenuItem(value: value, child: Text(value)),
                      )
                      .toList(),
                  onChanged: (value) =>
                      setState(() => _priority = value ?? _priority),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: _codeStatus,
                  decoration: const InputDecoration(labelText: 'Code status'),
                  items: const ['Full Code', 'DNR', 'DNR/DNI', 'Comfort Care']
                      .map(
                        (value) =>
                            DropdownMenuItem(value: value, child: Text(value)),
                      )
                      .toList(),
                  onChanged: (value) =>
                      setState(() => _codeStatus = value ?? _codeStatus),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _ipSubmitting ? null : _submitIpAdmission,
            icon: _ipSubmitting
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.local_hospital),
            label: const Text('Create IP admission'),
          ),
        ],
      ),
    );
  }

  Widget _buildPatientIdentityFields() {
    return LayoutBuilder(
      builder: (context, constraints) {
        final compact = constraints.maxWidth < 620;
        final phone = TextField(
          controller: _patientPhoneCtrl,
          keyboardType: TextInputType.phone,
          decoration: const InputDecoration(
            labelText: 'Patient phone',
            prefixIcon: Icon(Icons.phone_outlined),
          ),
        );
        final name = TextField(
          controller: _patientNameCtrl,
          decoration: const InputDecoration(
            labelText: 'Patient name',
            prefixIcon: Icon(Icons.person_outline),
          ),
        );
        if (compact) {
          return Column(children: [phone, const SizedBox(height: 12), name]);
        }
        return Row(
          children: [
            Expanded(child: phone),
            const SizedBox(width: 10),
            Expanded(child: name),
          ],
        );
      },
    );
  }

  Widget _buildTodayPanel({required Key key}) {
    return _Surface(
      key: key,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.view_list,
            title: 'Today at counter',
            trailing: TextButton(
              onPressed: () => context.go('/appointments'),
              child: const Text('Open appointments'),
            ),
          ),
          const SizedBox(height: 12),
          if (_workloadBusy)
            const LinearProgressIndicator(minHeight: 2)
          else ...[
            _MiniList(
              title: 'OPD appointments',
              emptyText: 'No appointments loaded',
              children: _todayAppointments.take(5).map((appointment) {
                return ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.event_available),
                  title: Text(appointment.patientName),
                  subtitle: Text(
                    [
                      appointment.scheduledLabel,
                      appointment.doctorName,
                    ].where((value) => value.isNotEmpty).join(' - '),
                  ),
                  trailing: Text(appointment.status),
                );
              }).toList(),
            ),
            const SizedBox(height: 14),
            _MiniList(
              title: 'Active admissions',
              emptyText: 'No active admissions loaded',
              children: _activeAdmissions.take(5).map((admission) {
                final patientName = _text(
                  admission['patient_name'] ?? admission['patientName'],
                );
                final bed = [
                  _text(admission['ward']),
                  if (_text(admission['bed']).isNotEmpty)
                    'Bed ${_text(admission['bed'])}',
                ].where((value) => value.isNotEmpty).join(' - ');
                return ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.local_hospital),
                  title: Text(
                    patientName.isEmpty ? 'Unknown Patient' : patientName,
                  ),
                  subtitle: Text(bed.isEmpty ? 'Admission active' : bed),
                  trailing: Text(_text(admission['status']).toUpperCase()),
                );
              }).toList(),
            ),
          ],
          const SizedBox(height: 10),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              OutlinedButton.icon(
                onPressed: () => context.go('/appointment-queue'),
                icon: const Icon(Icons.queue),
                label: const Text('Queue'),
              ),
              OutlinedButton.icon(
                onPressed: () => context.go('/emr/admissions'),
                icon: const Icon(Icons.local_hospital),
                label: const Text('Admissions'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _pickAppointmentDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _appointmentDate,
      firstDate: DateTime.now().subtract(const Duration(days: 1)),
      lastDate: DateTime.now().add(const Duration(days: 120)),
    );
    if (picked != null) setState(() => _appointmentDate = picked);
  }

  Future<void> _pickAppointmentTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: _appointmentTime,
    );
    if (picked != null) setState(() => _appointmentTime = picked);
  }
}

class _Surface extends StatelessWidget {
  final Widget child;

  const _Surface({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.divider),
      ),
      child: child,
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final IconData icon;
  final String title;
  final Widget? trailing;

  const _SectionTitle({required this.icon, required this.title, this.trailing});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, color: AppTheme.primaryBlue, size: 20),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            title,
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
        ),
        ?trailing,
      ],
    );
  }
}

class _CounterStat extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;
  final Color color;

  const _CounterStat({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.24)),
      ),
      child: Row(
        children: [
          Icon(icon, color: color),
          const SizedBox(width: 10),
          Text(
            value,
            style: Theme.of(context).textTheme.titleLarge?.copyWith(
              color: color,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}

class _SelectedPatientCard extends StatelessWidget {
  final Map<String, dynamic> patient;

  const _SelectedPatientCard({required this.patient});

  @override
  Widget build(BuildContext context) {
    final name = _text(patient['name']);
    final hospitalNumber = _text(patient['hospital_number']);
    final phone = _text(patient['phone']);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.primaryTeal.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppTheme.primaryTeal.withValues(alpha: 0.26)),
      ),
      child: Row(
        children: [
          const Icon(Icons.verified_user_outlined, color: AppTheme.primaryTeal),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name.isEmpty ? 'Selected patient' : name,
                  style: const TextStyle(fontWeight: FontWeight.w800),
                ),
                Text(
                  [
                    if (hospitalNumber.isNotEmpty) hospitalNumber,
                    if (phone.isNotEmpty) phone,
                  ].join(' - '),
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _PatientMatchTile extends StatelessWidget {
  final Map<String, dynamic> patient;
  final VoidCallback onTap;

  const _PatientMatchTile({required this.patient, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final name = _text(patient['name']);
    final hospitalNumber = _text(patient['hospital_number']);
    final phone = _text(patient['phone']);
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: const CircleAvatar(child: Icon(Icons.person_outline)),
      title: Text(name.isEmpty ? 'Unnamed patient' : name),
      subtitle: Text(
        [
          if (hospitalNumber.isNotEmpty) hospitalNumber,
          if (phone.isNotEmpty) phone,
        ].join(' - '),
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    );
  }
}

class _DateTimeButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  const _DateTimeButton({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: onTap,
      icon: Icon(icon),
      label: Text(label, overflow: TextOverflow.ellipsis),
    );
  }
}

class _MiniList extends StatelessWidget {
  final String title;
  final String emptyText;
  final List<Widget> children;

  const _MiniList({
    required this.title,
    required this.emptyText,
    required this.children,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: Theme.of(
            context,
          ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 6),
        if (children.isEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppTheme.backgroundGrey,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              emptyText,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          )
        else
          ...children,
      ],
    );
  }
}

String _digitsOnly(String value) => value.replaceAll(RegExp(r'\D'), '');

String _formatTime(TimeOfDay time) {
  final hour = time.hour.toString().padLeft(2, '0');
  final minute = time.minute.toString().padLeft(2, '0');
  return '$hour:$minute';
}

int? _intFrom(dynamic value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '');
}

String _text(dynamic value) => value?.toString().trim() ?? '';

int? _doctorId(Map<String, dynamic> doctor) => int.tryParse(
  (doctor['user_id'] ?? doctor['userId'] ?? doctor['id'])?.toString() ?? '',
);

String? _doctorUid(Map<String, dynamic> doctor) {
  final value = doctor['uid'] ?? doctor['doctor_uid'] ?? doctor['doctorUid'];
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? null : text;
}

String _doctorKey(Map<String, dynamic> doctor) {
  final uid = _doctorUid(doctor);
  final id = _doctorId(doctor);
  return uid ?? 'id:$id';
}

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
