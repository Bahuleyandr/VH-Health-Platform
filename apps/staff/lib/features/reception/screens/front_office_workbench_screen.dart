import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/platform_info.dart';
import '../../../core/services/billing_api_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/patient_api_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

class FrontOfficeWorkbenchScreen extends StatefulWidget {
  const FrontOfficeWorkbenchScreen({super.key});

  @override
  State<FrontOfficeWorkbenchScreen> createState() =>
      _FrontOfficeWorkbenchScreenState();
}

class _FrontOfficeWorkbenchScreenState
    extends State<FrontOfficeWorkbenchScreen> {
  final _searchCtrl = TextEditingController();
  Timer? _searchDebounce;
  late final Future<List<Map<String, dynamic>>> _doctorsFuture;
  late final Future<List<Map<String, dynamic>>> _wardsFuture;

  StaffRole _role = StaffRole.general;
  bool _roleLoaded = false;
  bool _loading = true;
  bool _lookupBusy = false;
  bool _invoiceBusy = false;
  bool _billingActionBusy = false;
  bool _admissionActionBusy = false;
  String? _error;
  String? _lookupError;

  List<Map<String, dynamic>> _patientMatches = const [];
  Map<String, dynamic>? _selectedPatient;
  List<Map<String, dynamic>> _todayQueue = const [];
  List<Map<String, dynamic>> _activeAdmissions = const [];
  List<Map<String, dynamic>> _patientInvoices = const [];

  bool get _canBilling => RoleFeatures.hasBillingDesk(_role);
  bool get _canClinical => RoleFeatures.hasClinicalEntry(_role);
  bool get _canAdmitIp =>
      _role == StaffRole.admin ||
      _role == StaffRole.superAdmin ||
      _role == StaffRole.medicalSuperintendent ||
      _role == StaffRole.receptionist ||
      _role == StaffRole.receptionIncharge ||
      _role == StaffRole.billingStaff ||
      _role == StaffRole.billingIncharge ||
      _role == StaffRole.financeIncharge ||
      _role == StaffRole.admissionOfficer ||
      _role == StaffRole.insuranceCoordinator ||
      _role == StaffRole.ipdCounsellor;

  @override
  void initState() {
    super.initState();
    _doctorsFuture = ScheduleApiService.getAppointmentDoctors();
    _wardsFuture = MedicalApiService.getAdmissionWardOptions();
    _loadInitialState();
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadInitialState() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    if (!mounted) return;
    setState(() {
      _role = role;
      _roleLoaded = true;
    });

    if (!RoleFeatures.hasFrontOfficeWorkbench(role) ||
        !currentAppDeviceMode.isWorkbench) {
      setState(() => _loading = false);
      return;
    }

    await _loadWorklists();
  }

  Future<void> _loadWorklists() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait<dynamic>([
        ScheduleApiService.getTodayAppointmentQueue(),
        MedicalApiService.getActiveAdmissions(limit: 12),
      ]);
      if (!mounted) return;
      setState(() {
        _todayQueue = _mapList(results[0]);
        _activeAdmissions = _admissionList(results[1]);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  List<Map<String, dynamic>> _mapList(dynamic value) {
    if (value is Map) value = value['data'] ?? value['items'] ?? value['rows'];
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
  }

  List<Map<String, dynamic>> _admissionList(dynamic data) {
    dynamic value = data;
    if (value is Map) {
      value = value['admissions'] ?? value['data'] ?? value['items'];
      if (value is Map) {
        value = value['admissions'] ?? value['data'] ?? value['items'];
      }
    }
    return _mapList(value);
  }

  void _queuePatientLookup(String value) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(
      const Duration(milliseconds: 280),
      () => _searchPatients(value),
    );
  }

  Future<void> _searchPatients(String value) async {
    final query = value.trim();
    if (query.length < 2) {
      setState(() {
        _patientMatches = const [];
        _lookupError = null;
      });
      return;
    }
    setState(() {
      _lookupBusy = true;
      _lookupError = null;
    });
    try {
      final matches = await PatientApiService.search(query, limit: 12);
      if (!mounted) return;
      setState(() {
        _patientMatches = matches;
        _lookupBusy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _lookupError = e.toString();
        _lookupBusy = false;
      });
    }
  }

  Future<void> _selectPatient(Map<String, dynamic> patient) async {
    setState(() {
      _selectedPatient = patient;
      _patientMatches = const [];
      _searchCtrl.text = _patientLabel(patient);
    });
    await _loadInvoicesFor(patient);
  }

  Future<void> _loadInvoicesFor(Map<String, dynamic>? patient) async {
    final uid = patient?['uid']?.toString();
    if (!_canBilling || uid == null || uid.isEmpty) {
      setState(() => _patientInvoices = const []);
      return;
    }
    setState(() => _invoiceBusy = true);
    try {
      final invoices = await BillingApiService.listInvoices(
        patientUid: uid,
        limit: 8,
      );
      if (!mounted) return;
      setState(() {
        _patientInvoices = invoices;
        _invoiceBusy = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _patientInvoices = const [];
        _invoiceBusy = false;
      });
    }
  }

  Future<void> _createDraftInvoice() async {
    final patient = _selectedPatient;
    final uid = patient?['uid']?.toString();
    if (!_canBilling || patient == null || uid == null || uid.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Select a patient before billing.')),
      );
      return;
    }

    setState(() {
      _billingActionBusy = true;
      _error = null;
    });
    try {
      await BillingApiService.createDraftInvoice(
        patientUid: uid,
        patientName: _text(patient['name']),
        patientPhone: _text(patient['phone']),
        invoiceType: 'OP',
        department: 'Front Office',
        notes: 'Front office OP draft invoice',
      );
      await _loadInvoicesFor(patient);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Draft OP invoice created'),
          backgroundColor: AppTheme.successGreen,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _billingActionBusy = false);
    }
  }

  Future<void> _issueInvoice(Map<String, dynamic> invoice) async {
    final id = _intFrom(invoice['id']);
    if (!_canBilling || id == null) return;

    setState(() {
      _billingActionBusy = true;
      _error = null;
    });
    try {
      await BillingApiService.issueInvoice(id);
      await _loadInvoicesFor(_selectedPatient);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Invoice issued'),
          backgroundColor: AppTheme.successGreen,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _billingActionBusy = false);
    }
  }

  String _patientLabel(Map<String, dynamic> patient) {
    final hn = patient['hospital_number']?.toString();
    final name = patient['name']?.toString();
    final phone = patient['phone']?.toString();
    return [
      if (hn != null && hn.isNotEmpty) hn,
      if (name != null && name.isNotEmpty) name,
      if (phone != null && phone.isNotEmpty) phone,
    ].join(' - ');
  }

  String? _selectedPatientUid() => _selectedPatient?['uid']?.toString();

  String _patientRoute(String path) {
    final patient = _selectedPatient;
    final uid = patient?['uid']?.toString();
    final params = <String, String>{
      if (uid != null && uid.isNotEmpty) 'patient_uid': uid,
      if (patient?['id'] != null) 'patient_id': patient!['id'].toString(),
      if (patient?['name'] != null) 'name': patient!['name'].toString(),
      if (patient?['phone'] != null) 'phone': patient!['phone'].toString(),
    };
    final query = Uri(queryParameters: params).query;
    return query.isEmpty ? path : '$path?$query';
  }

  Future<void> _showPatientDialog({Map<String, dynamic>? patient}) async {
    final nameCtrl = TextEditingController(text: patient?['name']?.toString());
    final phoneCtrl = TextEditingController(
      text: patient?['phone']?.toString(),
    );
    final genderCtrl = TextEditingController(
      text: patient?['gender']?.toString(),
    );
    final birthdayCtrl = TextEditingController(
      text: patient?['birthday']?.toString().split('T').first,
    );
    final addressCtrl = TextEditingController(
      text: patient?['address']?.toString(),
    );
    var saving = false;
    String? dialogError;

    final saved = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            Future<void> save() async {
              setDialogState(() {
                saving = true;
                dialogError = null;
              });
              try {
                final result = patient == null
                    ? await PatientApiService.createPatient(
                        name: nameCtrl.text,
                        phone: phoneCtrl.text,
                        gender: genderCtrl.text,
                        birthday: birthdayCtrl.text,
                        address: addressCtrl.text,
                      )
                    : await PatientApiService.updatePatient(
                        uid: patient['uid'].toString(),
                        name: nameCtrl.text,
                        phone: phoneCtrl.text,
                        gender: genderCtrl.text,
                        birthday: birthdayCtrl.text,
                        address: addressCtrl.text,
                      );
                if (dialogContext.mounted) {
                  Navigator.of(dialogContext).pop(result);
                }
              } catch (e) {
                setDialogState(() {
                  dialogError = e.toString();
                  saving = false;
                });
              }
            }

            return AlertDialog(
              title: Text(patient == null ? 'New Patient' : 'Edit Patient'),
              content: SizedBox(
                width: 520,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      TextField(
                        controller: nameCtrl,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Patient name',
                          prefixIcon: Icon(Icons.badge_outlined),
                        ),
                      ),
                      const SizedBox(height: 10),
                      TextField(
                        controller: phoneCtrl,
                        keyboardType: TextInputType.phone,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Phone',
                          prefixIcon: Icon(Icons.phone_outlined),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: genderCtrl,
                              textInputAction: TextInputAction.next,
                              decoration: const InputDecoration(
                                labelText: 'Gender',
                                prefixIcon: Icon(Icons.wc_outlined),
                              ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: TextField(
                              controller: birthdayCtrl,
                              keyboardType: TextInputType.datetime,
                              textInputAction: TextInputAction.next,
                              decoration: const InputDecoration(
                                labelText: 'Birth date',
                                hintText: 'YYYY-MM-DD',
                                prefixIcon: Icon(Icons.cake_outlined),
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      TextField(
                        controller: addressCtrl,
                        minLines: 2,
                        maxLines: 3,
                        decoration: const InputDecoration(
                          labelText: 'Address',
                          prefixIcon: Icon(Icons.home_outlined),
                        ),
                      ),
                      if (dialogError != null) ...[
                        const SizedBox(height: 10),
                        Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            dialogError!,
                            style: TextStyle(color: AppTheme.errorOnSurface),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: saving ? null : () => Navigator.pop(context),
                  child: const Text('Cancel'),
                ),
                FilledButton.icon(
                  onPressed: saving ? null : save,
                  icon: saving
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.save_outlined),
                  label: const Text('Save'),
                ),
              ],
            );
          },
        );
      },
    );

    nameCtrl.dispose();
    phoneCtrl.dispose();
    genderCtrl.dispose();
    birthdayCtrl.dispose();
    addressCtrl.dispose();

    if (saved == null || !mounted) return;
    setState(() => _selectedPatient = saved);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(patient == null ? 'Patient created' : 'Patient updated'),
        backgroundColor: AppTheme.successGreen,
      ),
    );
    await _loadInvoicesFor(saved);
  }

  Future<void> _showOpBookingDialog() async {
    final patient = _selectedPatient;
    if (patient == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Select a patient before booking OP.')),
      );
      return;
    }

    final reasonCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    var appointmentDate = DateTime.now();
    var appointmentTime = TimeOfDay.fromDateTime(
      DateTime.now().add(const Duration(hours: 1)),
    );
    Map<String, dynamic>? selectedDoctor;
    var saving = false;
    String? dialogError;

    final booked = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
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

            Future<void> book() async {
              final doctor = selectedDoctor;
              final doctorId = doctor == null ? null : _doctorId(doctor);
              final reason = reasonCtrl.text.trim();
              final patientId = _intFrom(patient['id']);
              final patientPhone = _text(patient['phone']);
              if (doctorId == null) {
                setDialogState(
                  () => dialogError = 'Select the consulting doctor.',
                );
                return;
              }
              if (patientId == null && _digitsOnly(patientPhone).length < 10) {
                setDialogState(() {
                  dialogError =
                      'Patient needs a saved record or a valid phone number.';
                });
                return;
              }
              if (reason.isEmpty) {
                setDialogState(
                  () => dialogError = 'Enter the reason for visit.',
                );
                return;
              }

              setDialogState(() {
                saving = true;
                dialogError = null;
              });
              try {
                await ScheduleApiService.createAppointment(
                  patientId: patientId,
                  patientPhone: patientId == null ? patientPhone : null,
                  patientName: _text(patient['name']),
                  doctorId: doctorId,
                  doctorUid: _doctorUid(doctor!),
                  appointmentDate: DateFormat(
                    'yyyy-MM-dd',
                  ).format(appointmentDate),
                  appointmentTime: _formatTime(appointmentTime),
                  reason: reason,
                  notes: notesCtrl.text.trim().isEmpty
                      ? null
                      : notesCtrl.text.trim(),
                );
                if (dialogContext.mounted) {
                  Navigator.of(dialogContext).pop(true);
                }
              } catch (e) {
                setDialogState(() {
                  dialogError = e.toString().replaceFirst('Exception: ', '');
                  saving = false;
                });
              }
            }

            return AlertDialog(
              title: const Text('Book OP Appointment'),
              content: SizedBox(
                width: 560,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _PatientCard(
                        patient: patient,
                        selected: true,
                        onTap: () {},
                      ),
                      const SizedBox(height: 12),
                      FutureBuilder<List<Map<String, dynamic>>>(
                        future: _doctorsFuture,
                        builder: (context, snapshot) {
                          if (snapshot.connectionState ==
                              ConnectionState.waiting) {
                            return const LinearProgressIndicator(minHeight: 2);
                          }
                          if (snapshot.hasError) {
                            return Text(
                              'Could not load doctors.',
                              style: TextStyle(color: AppTheme.errorOnSurface),
                            );
                          }
                          final doctors = (snapshot.data ?? const [])
                              .where((doctor) => _doctorId(doctor) != null)
                              .toList();
                          return DropdownButtonFormField<int>(
                            initialValue: selectedDoctor == null
                                ? null
                                : _doctorId(selectedDoctor!),
                            isExpanded: true,
                            decoration: const InputDecoration(
                              labelText: 'Consulting doctor',
                              prefixIcon: Icon(Icons.medical_services_outlined),
                            ),
                            items: doctors
                                .map(
                                  (doctor) => DropdownMenuItem<int>(
                                    value: _doctorId(doctor),
                                    child: Text(
                                      _doctorLabel(doctor),
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                )
                                .toList(),
                            onChanged: saving
                                ? null
                                : (doctorId) {
                                    setDialogState(() {
                                      selectedDoctor = doctors.firstWhere(
                                        (doctor) =>
                                            _doctorId(doctor) == doctorId,
                                        orElse: () => <String, dynamic>{},
                                      );
                                      if (selectedDoctor!.isEmpty) {
                                        selectedDoctor = null;
                                      }
                                    });
                                  },
                          );
                        },
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: _DateTimeButton(
                              icon: Icons.calendar_today,
                              label: DateFormat(
                                'dd MMM yyyy',
                              ).format(appointmentDate),
                              onTap: saving ? null : pickDate,
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: _DateTimeButton(
                              icon: Icons.schedule,
                              label: appointmentTime.format(dialogContext),
                              onTap: saving ? null : pickTime,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: reasonCtrl,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Reason / chief complaint',
                          prefixIcon: Icon(Icons.short_text),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: notesCtrl,
                        minLines: 2,
                        maxLines: 3,
                        decoration: const InputDecoration(
                          labelText: 'Counter notes',
                          prefixIcon: Icon(Icons.notes_outlined),
                        ),
                      ),
                      if (dialogError != null) ...[
                        const SizedBox(height: 10),
                        Text(
                          dialogError!,
                          style: TextStyle(color: AppTheme.errorOnSurface),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: saving
                      ? null
                      : () => Navigator.pop(context, false),
                  child: const Text('Cancel'),
                ),
                FilledButton.icon(
                  onPressed: saving ? null : book,
                  icon: saving
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.event_available),
                  label: const Text('Book OP'),
                ),
              ],
            );
          },
        );
      },
    );

    reasonCtrl.dispose();
    notesCtrl.dispose();

    if (booked != true || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('OP appointment booked'),
        backgroundColor: AppTheme.successGreen,
      ),
    );
    await _loadWorklists();
  }

  Future<void> _showIpAdmissionDialog() async {
    final patient = _selectedPatient;
    if (!_canAdmitIp) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('IP admission is not enabled for this role.'),
        ),
      );
      return;
    }
    if (patient == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Select a patient before admitting IP.')),
      );
      return;
    }

    final chiefComplaintCtrl = TextEditingController();
    final diagnosisCtrl = TextEditingController();
    Map<String, dynamic>? selectedDoctor;
    Map<String, dynamic>? selectedWard;
    Map<String, dynamic>? selectedBed;
    Future<List<Map<String, dynamic>>> bedOptionsFuture = Future.value(
      const <Map<String, dynamic>>[],
    );
    var priority = 'Routine';
    var codeStatus = 'Full Code';
    var consentCaptured = false;
    var saving = false;
    String? dialogError;

    final admitted = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            Future<void> admit() async {
              final doctor = selectedDoctor;
              final doctorUid = doctor == null ? null : _doctorUid(doctor);
              final patientQuery = _patientAdmissionQuery(patient);
              final chiefComplaint = chiefComplaintCtrl.text.trim();
              final isEmergency = _apiAdmissionPriority(priority) == 'emergent';

              if (doctorUid == null || doctorUid.isEmpty) {
                setDialogState(
                  () => dialogError = 'Select an admitting doctor.',
                );
                return;
              }
              if (chiefComplaint.isEmpty) {
                setDialogState(
                  () => dialogError = 'Enter the chief complaint.',
                );
                return;
              }
              if (patientQuery.isEmpty) {
                setDialogState(
                  () =>
                      dialogError = 'The selected patient needs an identifier.',
                );
                return;
              }
              if (!isEmergency && _bedId(selectedBed) == null) {
                setDialogState(
                  () => dialogError = 'Select a bed for routine IP admission.',
                );
                return;
              }

              setDialogState(() {
                saving = true;
                dialogError = null;
              });
              setState(() => _admissionActionBusy = true);
              try {
                final result = await MedicalApiService.admitPatient({
                  'patient_query': patientQuery,
                  if (_text(patient['uid']).isNotEmpty)
                    'patient_uid': _text(patient['uid']),
                  if (_text(patient['phone']).isNotEmpty)
                    'patient_phone': _text(patient['phone']),
                  if (_text(patient['name']).isNotEmpty)
                    'patient_name': _text(patient['name']),
                  'admitting_doctor': doctorUid,
                  'chief_complaint': chiefComplaint,
                  if (diagnosisCtrl.text.trim().isNotEmpty)
                    'provisional_diagnosis': diagnosisCtrl.text.trim(),
                  if (_wardLabel(selectedWard).isNotEmpty)
                    'ward': _wardLabel(selectedWard),
                  if (_bedId(selectedBed) != null)
                    'bed_id': _bedId(selectedBed),
                  if (_bedLabel(selectedBed).isNotEmpty)
                    'bed': _bedLabel(selectedBed),
                  'priority': _apiAdmissionPriority(priority),
                  'admission_type': _apiAdmissionType(priority),
                  'code_status': _apiCodeStatus(codeStatus),
                  'counter_consent_captured': consentCaptured,
                });
                if (dialogContext.mounted) {
                  Navigator.of(
                    dialogContext,
                  ).pop(_admissionFromResponse(result));
                }
              } catch (e) {
                setDialogState(() {
                  dialogError = e.toString().replaceFirst('Exception: ', '');
                  saving = false;
                });
              } finally {
                if (mounted) setState(() => _admissionActionBusy = false);
              }
            }

            return AlertDialog(
              title: const Text('Create IP Admission'),
              content: SizedBox(
                width: 620,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _PatientCard(
                        patient: patient,
                        selected: true,
                        onTap: () {},
                      ),
                      const SizedBox(height: 12),
                      FutureBuilder<List<Map<String, dynamic>>>(
                        future: _doctorsFuture,
                        builder: (context, snapshot) {
                          if (snapshot.connectionState ==
                              ConnectionState.waiting) {
                            return const LinearProgressIndicator(minHeight: 2);
                          }
                          if (snapshot.hasError) {
                            return Text(
                              'Could not load doctors.',
                              style: TextStyle(color: AppTheme.errorOnSurface),
                            );
                          }
                          final doctors = (snapshot.data ?? const [])
                              .where((doctor) => _doctorUid(doctor) != null)
                              .toList();
                          return DropdownButtonFormField<String>(
                            initialValue: selectedDoctor == null
                                ? null
                                : _doctorUid(selectedDoctor!),
                            isExpanded: true,
                            decoration: const InputDecoration(
                              labelText: 'Admitting doctor',
                              prefixIcon: Icon(Icons.medical_services_outlined),
                            ),
                            items: doctors
                                .map(
                                  (doctor) => DropdownMenuItem<String>(
                                    value: _doctorUid(doctor),
                                    child: Text(
                                      _doctorLabel(doctor),
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                )
                                .toList(),
                            onChanged: saving
                                ? null
                                : (doctorUid) {
                                    setDialogState(() {
                                      selectedDoctor = doctors.firstWhere(
                                        (doctor) =>
                                            _doctorUid(doctor) == doctorUid,
                                        orElse: () => <String, dynamic>{},
                                      );
                                      if (selectedDoctor!.isEmpty) {
                                        selectedDoctor = null;
                                      }
                                    });
                                  },
                          );
                        },
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: chiefComplaintCtrl,
                        minLines: 2,
                        maxLines: 3,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Chief complaint',
                          prefixIcon: Icon(Icons.report_problem_outlined),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: diagnosisCtrl,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Provisional diagnosis',
                          prefixIcon: Icon(Icons.assignment_outlined),
                        ),
                      ),
                      const SizedBox(height: 12),
                      LayoutBuilder(
                        builder: (context, constraints) {
                          final compact = constraints.maxWidth < 560;
                          final wardPicker =
                              FutureBuilder<List<Map<String, dynamic>>>(
                                future: _wardsFuture,
                                builder: (context, snapshot) {
                                  if (snapshot.connectionState ==
                                      ConnectionState.waiting) {
                                    return const LinearProgressIndicator(
                                      minHeight: 2,
                                    );
                                  }
                                  final wards = snapshot.data ?? const [];
                                  return DropdownButtonFormField<int>(
                                    initialValue: _wardId(selectedWard),
                                    isExpanded: true,
                                    decoration: const InputDecoration(
                                      labelText: 'Ward / floor',
                                      prefixIcon: Icon(
                                        Icons.apartment_outlined,
                                      ),
                                    ),
                                    items: wards
                                        .map(
                                          (ward) => DropdownMenuItem<int>(
                                            value: _wardId(ward),
                                            child: Text(
                                              _wardLabel(ward),
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ),
                                        )
                                        .where((item) => item.value != null)
                                        .toList(),
                                    onChanged: saving
                                        ? null
                                        : (wardId) {
                                            final ward = wards.firstWhere(
                                              (item) => _wardId(item) == wardId,
                                              orElse: () => <String, dynamic>{},
                                            );
                                            setDialogState(() {
                                              selectedWard = ward.isEmpty
                                                  ? null
                                                  : ward;
                                              selectedBed = null;
                                              bedOptionsFuture =
                                                  MedicalApiService.getAdmissionBedOptions(
                                                    wardId: _wardId(
                                                      selectedWard,
                                                    ),
                                                    wardLabel: _wardLabel(
                                                      selectedWard,
                                                    ),
                                                  );
                                            });
                                          },
                                  );
                                },
                              );
                          final bedPicker =
                              FutureBuilder<List<Map<String, dynamic>>>(
                                future: bedOptionsFuture,
                                builder: (context, snapshot) {
                                  final waiting =
                                      snapshot.connectionState ==
                                      ConnectionState.waiting;
                                  final beds = snapshot.data ?? const [];
                                  if (waiting) {
                                    return const LinearProgressIndicator(
                                      minHeight: 2,
                                    );
                                  }
                                  return DropdownButtonFormField<int>(
                                    initialValue: _bedId(selectedBed),
                                    isExpanded: true,
                                    decoration: const InputDecoration(
                                      labelText: 'Bed',
                                      prefixIcon: Icon(Icons.bed_outlined),
                                    ),
                                    items: beds
                                        .map(
                                          (bed) => DropdownMenuItem<int>(
                                            value: _bedId(bed),
                                            child: Text(
                                              _bedLabel(bed),
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ),
                                        )
                                        .where((item) => item.value != null)
                                        .toList(),
                                    onChanged: saving
                                        ? null
                                        : (bedId) {
                                            setDialogState(() {
                                              selectedBed = beds.firstWhere(
                                                (bed) => _bedId(bed) == bedId,
                                                orElse: () =>
                                                    <String, dynamic>{},
                                              );
                                              if (selectedBed!.isEmpty) {
                                                selectedBed = null;
                                              }
                                            });
                                          },
                                  );
                                },
                              );
                          if (compact) {
                            return Column(
                              children: [
                                wardPicker,
                                const SizedBox(height: 12),
                                bedPicker,
                              ],
                            );
                          }
                          return Row(
                            children: [
                              Expanded(child: wardPicker),
                              const SizedBox(width: 10),
                              Expanded(child: bedPicker),
                            ],
                          );
                        },
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: DropdownButtonFormField<String>(
                              initialValue: priority,
                              decoration: const InputDecoration(
                                labelText: 'Priority',
                              ),
                              items:
                                  const [
                                        'Routine',
                                        'Urgent',
                                        'Emergency',
                                        'Critical',
                                      ]
                                      .map(
                                        (value) => DropdownMenuItem(
                                          value: value,
                                          child: Text(value),
                                        ),
                                      )
                                      .toList(),
                              onChanged: saving
                                  ? null
                                  : (value) => setDialogState(
                                      () => priority = value ?? priority,
                                    ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: DropdownButtonFormField<String>(
                              initialValue: codeStatus,
                              decoration: const InputDecoration(
                                labelText: 'Code status',
                              ),
                              items:
                                  const [
                                        'Full Code',
                                        'DNR',
                                        'DNR/DNI',
                                        'Comfort Care',
                                      ]
                                      .map(
                                        (value) => DropdownMenuItem(
                                          value: value,
                                          child: Text(value),
                                        ),
                                      )
                                      .toList(),
                              onChanged: saving
                                  ? null
                                  : (value) => setDialogState(
                                      () => codeStatus = value ?? codeStatus,
                                    ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      CheckboxListTile(
                        value: consentCaptured,
                        onChanged: saving
                            ? null
                            : (value) => setDialogState(
                                () => consentCaptured = value ?? false,
                              ),
                        contentPadding: EdgeInsets.zero,
                        controlAffinity: ListTileControlAffinity.leading,
                        title: const Text(
                          'Treatment consent captured at counter',
                        ),
                        subtitle: Text(
                          'Emergency admissions can proceed without a bed; routine admissions require a selected bed.',
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      ),
                      if (dialogError != null) ...[
                        const SizedBox(height: 10),
                        Text(
                          dialogError!,
                          style: TextStyle(color: AppTheme.errorOnSurface),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: saving ? null : () => Navigator.pop(context, null),
                  child: const Text('Cancel'),
                ),
                FilledButton.icon(
                  onPressed: saving ? null : admit,
                  icon: saving
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.local_hospital),
                  label: const Text('Create IP'),
                ),
              ],
            );
          },
        );
      },
    );

    chiefComplaintCtrl.dispose();
    diagnosisCtrl.dispose();

    if (admitted == null || !mounted) return;
    final ipNumber = _text(admitted['ip_number']);
    final hospitalNumber = _text(
      admitted['patient_hospital_number'] ?? admitted['hospital_number'],
    );
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          [
            if (ipNumber.isEmpty)
              'IP admission created'
            else
              'IP admission $ipNumber created',
            if (hospitalNumber.isNotEmpty) 'Hospital ID $hospitalNumber',
          ].join(' - '),
        ),
        backgroundColor: AppTheme.successGreen,
      ),
    );
    await _loadWorklists();
  }

  @override
  Widget build(BuildContext context) {
    final mode = appDeviceModeForContext(context);
    if (!_roleLoaded) {
      return const StaffScaffold(
        title: 'Front Office',
        body: Center(child: CircularProgressIndicator()),
      );
    }

    if (!RoleFeatures.hasFrontOfficeWorkbench(_role)) {
      return StaffScaffold(
        title: 'Front Office',
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _buildUnavailablePanel(
              icon: Icons.lock_outline,
              title: 'Front Office unavailable',
              message: 'Front Office is not enabled for ${_role.displayName}.',
            ),
          ],
        ),
      );
    }

    if (!mode.isWorkbench) {
      return StaffScaffold(
        title: 'Front Office',
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _buildUnavailablePanel(
              icon: Icons.devices_outlined,
              title: 'Workstation mode required',
              message:
                  'Patient search, OP booking, admissions, billing, and clinical entry open on tablet or desktop workstations.',
              actions: [
                _ActionTile(
                  icon: Icons.schedule_outlined,
                  label: 'Roster',
                  color: AppTheme.primaryTeal,
                  onTap: () => context.go('/schedule'),
                ),
                _ActionTile(
                  icon: Icons.event_available_outlined,
                  label: 'Leave',
                  color: AppTheme.primaryBlue,
                  onTap: () => context.go('/leave'),
                ),
                _ActionTile(
                  icon: Icons.person_outline,
                  label: 'Profile',
                  color: AppTheme.warningAmber,
                  onTap: () => context.go('/profile'),
                ),
              ],
            ),
          ],
        ),
      );
    }

    return StaffScaffold(
      title: 'Front Office Workbench',
      body: RefreshIndicator(
        onRefresh: _loadWorklists,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth >= 980;
            return ListView(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
              children: [
                _buildHeader(mode),
                const SizedBox(height: 12),
                if (_error != null)
                  _InlineAlert(message: _error!, color: AppTheme.errorRed),
                if (_loading) const LinearProgressIndicator(minHeight: 2),
                if (wide)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        flex: 5,
                        child: Column(
                          children: [
                            _buildPatientPanel(),
                            const SizedBox(height: 12),
                            _buildActionPanel(),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        flex: 4,
                        child: Column(
                          children: [
                            _buildQueuePanel(),
                            const SizedBox(height: 12),
                            _buildBillingPanel(),
                            const SizedBox(height: 12),
                            _buildAdmissionsPanel(),
                          ],
                        ),
                      ),
                    ],
                  )
                else ...[
                  _buildPatientPanel(),
                  const SizedBox(height: 12),
                  _buildActionPanel(),
                  const SizedBox(height: 12),
                  _buildQueuePanel(),
                  const SizedBox(height: 12),
                  _buildBillingPanel(),
                  const SizedBox(height: 12),
                  _buildAdmissionsPanel(),
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildHeader(AppDeviceMode mode) {
    return _Surface(
      child: Wrap(
        spacing: 12,
        runSpacing: 12,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: AppTheme.primaryBlue.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(
              Icons.space_dashboard_outlined,
              color: AppTheme.primaryBlue,
            ),
          ),
          ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 220, maxWidth: 520),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Front Office Workbench',
                  style: Theme.of(
                    context,
                  ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
                ),
                Text(
                  _role.displayName,
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
          _Metric(
            icon: Icons.event_available,
            label: 'Today Queue',
            value: '${_todayQueue.length}',
            color: AppTheme.primaryTeal,
          ),
          _Metric(
            icon: Icons.local_hospital,
            label: 'Active IP',
            value: '${_activeAdmissions.length}',
            color: AppTheme.primaryBlue,
          ),
          Chip(
            avatar: const Icon(Icons.devices_outlined, size: 18),
            label: Text(mode.apiValue.toUpperCase()),
          ),
          IconButton.filledTonal(
            tooltip: 'Refresh',
            onPressed: _loadWorklists,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
    );
  }

  Widget _buildUnavailablePanel({
    required IconData icon,
    required String title,
    required String message,
    List<Widget> actions = const [],
  }) {
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(icon: icon, title: title),
          const SizedBox(height: 8),
          Text(message, style: TextStyle(color: AppTheme.textSecondary)),
          if (actions.isNotEmpty) ...[
            const SizedBox(height: 14),
            Wrap(spacing: 10, runSpacing: 10, children: actions),
          ],
        ],
      ),
    );
  }

  Widget _buildPatientPanel() {
    final selected = _selectedPatient;
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.manage_search,
            title: 'Patient',
            trailing: Wrap(
              spacing: 8,
              children: [
                if (selected != null)
                  IconButton.filledTonal(
                    tooltip: 'Edit patient',
                    onPressed: () => _showPatientDialog(patient: selected),
                    icon: const Icon(Icons.edit_outlined),
                  ),
                IconButton.filled(
                  tooltip: 'New patient',
                  onPressed: () => _showPatientDialog(),
                  icon: const Icon(Icons.person_add_alt_1),
                ),
              ],
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
          if (selected != null) ...[
            const SizedBox(height: 10),
            _PatientCard(
              patient: selected,
              selected: true,
              onTap: () => context.go(
                '/emr/timeline/${selected['uid']}?name=${Uri.encodeComponent(selected['name']?.toString() ?? 'Patient')}',
              ),
            ),
          ],
          if (_patientMatches.isNotEmpty) ...[
            const SizedBox(height: 10),
            ..._patientMatches.map(
              (patient) => Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _PatientCard(
                  patient: patient,
                  onTap: () => _selectPatient(patient),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildActionPanel() {
    final hasPatient = _selectedPatientUid() != null;
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionTitle(icon: Icons.apps_outlined, title: 'Workflows'),
          const SizedBox(height: 10),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              _ActionTile(
                icon: Icons.point_of_sale,
                label: 'Counter',
                color: AppTheme.primaryBlue,
                onTap: () => context.go('/reception-counter'),
              ),
              _ActionTile(
                icon: Icons.event_available,
                label: 'Queue',
                color: AppTheme.primaryTeal,
                onTap: () => context.go('/appointment-queue'),
              ),
              _ActionTile(
                icon: Icons.calendar_month,
                label: 'Book OP',
                color: AppTheme.accentCyan,
                enabled: hasPatient,
                onTap: _showOpBookingDialog,
              ),
              if (_canAdmitIp)
                _ActionTile(
                  icon: Icons.local_hospital_outlined,
                  label: 'Admit IP',
                  color: AppTheme.warningAmber,
                  enabled: hasPatient && !_admissionActionBusy,
                  onTap: _showIpAdmissionDialog,
                ),
              _ActionTile(
                icon: Icons.local_hospital,
                label: 'Admissions',
                color: AppTheme.warningAmber,
                onTap: () => context.go('/emr/admissions'),
              ),
              if (_canBilling)
                _ActionTile(
                  icon: Icons.receipt_long,
                  label: 'Billing',
                  color: AppTheme.primaryBlue,
                  onTap: () => context.go(_patientRoute('/billing-desk')),
                ),
              if (_canClinical)
                _ActionTile(
                  icon: Icons.folder_shared,
                  label: 'Records',
                  color: AppTheme.primaryTeal,
                  onTap: () =>
                      context.go('/patient-records?context=front-office'),
                ),
              if (_canClinical)
                _ActionTile(
                  icon: Icons.note_add_outlined,
                  label: 'Notes',
                  color: AppTheme.primaryBlue,
                  enabled: hasPatient,
                  onTap: () {
                    final uid = _selectedPatientUid();
                    if (uid == null) return;
                    context.go(
                      '/emr/notes/$uid?name=${Uri.encodeComponent(_selectedPatient?['name']?.toString() ?? 'Patient')}',
                    );
                  },
                ),
              if (_canClinical)
                _ActionTile(
                  icon: Icons.monitor_heart_outlined,
                  label: 'Vitals',
                  color: AppTheme.errorRed,
                  enabled: hasPatient,
                  onTap: () => context.go(_patientRoute('/vitals')),
                ),
              if (_canClinical)
                _ActionTile(
                  icon: Icons.playlist_add_check_circle_outlined,
                  label: 'Orders',
                  color: AppTheme.warningAmber,
                  enabled: hasPatient,
                  onTap: () {
                    final uid = _selectedPatientUid();
                    if (uid == null) return;
                    context.go(
                      '/emr/orders/$uid?name=${Uri.encodeComponent(_selectedPatient?['name']?.toString() ?? 'Patient')}',
                    );
                  },
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildQueuePanel() {
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.event_note,
            title: 'Today Queue',
            trailing: TextButton.icon(
              onPressed: () => context.go('/appointment-queue'),
              icon: const Icon(Icons.open_in_new),
              label: const Text('Open'),
            ),
          ),
          const SizedBox(height: 8),
          if (_todayQueue.isEmpty)
            const _EmptyLine(
              icon: Icons.event_busy,
              text: 'No queue rows loaded',
            )
          else
            ..._todayQueue.take(5).map(_queueTile),
        ],
      ),
    );
  }

  Widget _queueTile(Map<String, dynamic> row) {
    final name =
        row['patient_name'] ?? row['name'] ?? row['phone'] ?? 'Patient';
    final status = row['status']?.toString() ?? 'scheduled';
    final time = row['appointment_time'] ?? row['time'] ?? row['slot'];
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: const CircleAvatar(child: Icon(Icons.person_outline)),
      title: Text(
        name.toString(),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text([?time, status].join(' - ')),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => context.go('/appointment-queue'),
    );
  }

  Widget _buildBillingPanel() {
    if (!_canBilling) return const SizedBox.shrink();
    final selected = _selectedPatient;
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.receipt_long,
            title: 'Billing',
            trailing: selected == null
                ? null
                : Wrap(
                    spacing: 8,
                    children: [
                      TextButton.icon(
                        onPressed: () =>
                            context.go(_patientRoute('/billing-desk')),
                        icon: const Icon(Icons.open_in_new),
                        label: const Text('Open'),
                      ),
                      FilledButton.icon(
                        onPressed: _billingActionBusy
                            ? null
                            : _createDraftInvoice,
                        icon: _billingActionBusy
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.add),
                        label: const Text('Draft OP'),
                      ),
                    ],
                  ),
          ),
          const SizedBox(height: 8),
          if (selected == null)
            const _EmptyLine(
              icon: Icons.person_search,
              text: 'Select a patient',
            )
          else if (_invoiceBusy)
            const LinearProgressIndicator(minHeight: 2)
          else if (_patientInvoices.isEmpty)
            const _EmptyLine(
              icon: Icons.receipt_long,
              text: 'No invoices found',
            )
          else
            ..._patientInvoices.take(4).map(_invoiceTile),
        ],
      ),
    );
  }

  Widget _invoiceTile(Map<String, dynamic> invoice) {
    final id = invoice['invoice_number'] ?? '#${invoice['id']}';
    final status = invoice['status']?.toString().toUpperCase() ?? 'DRAFT';
    final isDraft = status == 'DRAFT';
    final due = invoice['amount_due'] ?? invoice['total_amount'] ?? 0;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: ListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.receipt_long_outlined),
        title: Text(
          id.toString(),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text('${invoice['invoice_type'] ?? 'OP'} - $status'),
        trailing: Wrap(
          spacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(_money(due)),
            if (isDraft)
              SizedBox(
                height: 34,
                child: OutlinedButton.icon(
                  onPressed: _billingActionBusy
                      ? null
                      : () => _issueInvoice(invoice),
                  icon: const Icon(Icons.publish_outlined, size: 16),
                  label: const Text('Issue'),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildAdmissionsPanel() {
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.local_hospital,
            title: 'Active Admissions',
            trailing: Wrap(
              spacing: 8,
              children: [
                if (_canAdmitIp && _selectedPatient != null)
                  FilledButton.icon(
                    onPressed: _admissionActionBusy
                        ? null
                        : _showIpAdmissionDialog,
                    icon: _admissionActionBusy
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.add),
                    label: const Text('Admit IP'),
                  ),
                TextButton.icon(
                  onPressed: () => context.go('/emr/admissions'),
                  icon: const Icon(Icons.open_in_new),
                  label: const Text('Open'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          if (_activeAdmissions.isEmpty)
            const _EmptyLine(
              icon: Icons.local_hospital_outlined,
              text: 'No active admissions',
            )
          else
            ..._activeAdmissions.take(5).map(_admissionTile),
        ],
      ),
    );
  }

  Widget _admissionTile(Map<String, dynamic> row) {
    final name = row['patient_name'] ?? row['name'] ?? 'Patient';
    final ward = row['ward'] ?? row['ward_name'] ?? row['bed_ward_name'];
    final admittedAt = row['admitted_at'] ?? row['created_at'];
    final date = admittedAt == null
        ? null
        : DateTime.tryParse(admittedAt.toString())?.toLocal();
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.bed_outlined),
      title: Text(
        name.toString(),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        [
          ?ward,
          if (date != null) DateFormat('dd MMM, HH:mm').format(date),
        ].join(' - '),
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => context.go('/emr/admissions'),
    );
  }
}

class _Surface extends StatelessWidget {
  final Widget child;

  const _Surface({required this.child});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
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
        Icon(icon, color: AppTheme.primaryBlue),
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

class _Metric extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color color;

  const _Metric({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minWidth: 132),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, color: color),
          const SizedBox(width: 8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                value,
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w800,
                  color: color,
                ),
              ),
              Text(label, style: TextStyle(color: AppTheme.textSecondary)),
            ],
          ),
        ],
      ),
    );
  }
}

class _PatientCard extends StatelessWidget {
  final Map<String, dynamic> patient;
  final bool selected;
  final VoidCallback onTap;

  const _PatientCard({
    required this.patient,
    required this.onTap,
    this.selected = false,
  });

  @override
  Widget build(BuildContext context) {
    final name = patient['name']?.toString() ?? 'Patient';
    final phone = patient['phone']?.toString();
    final hn = patient['hospital_number']?.toString();
    final age = patient['age']?.toString();
    final gender = patient['gender']?.toString();
    return Material(
      color: selected
          ? AppTheme.primaryBlue.withValues(alpha: 0.08)
          : Colors.transparent,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Row(
            children: [
              CircleAvatar(
                backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.14),
                child: const Icon(Icons.person_outline),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w800),
                    ),
                    Text(
                      [
                        if (hn != null && hn.isNotEmpty) hn,
                        if (phone != null && phone.isNotEmpty) phone,
                        if (age != null && age.isNotEmpty) '$age yrs',
                        if (gender != null && gender.isNotEmpty) gender,
                      ].join(' - '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right),
            ],
          ),
        ),
      ),
    );
  }
}

class _ActionTile extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;
  final bool enabled;

  const _ActionTile({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) {
    final effectiveColor = enabled ? color : AppTheme.textSecondary;
    return SizedBox(
      width: 148,
      height: 86,
      child: Material(
        color: effectiveColor.withValues(alpha: enabled ? 0.1 : 0.05),
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: enabled ? onTap : null,
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Icon(icon, color: effectiveColor),
                Text(
                  label,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: effectiveColor,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _DateTimeButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

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
      label: Align(
        alignment: Alignment.centerLeft,
        child: Text(label, overflow: TextOverflow.ellipsis),
      ),
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(50),
        alignment: Alignment.centerLeft,
      ),
    );
  }
}

class _EmptyLine extends StatelessWidget {
  final IconData icon;
  final String text;

  const _EmptyLine({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Icon(icon, color: AppTheme.textSecondary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: TextStyle(color: AppTheme.textSecondary)),
          ),
        ],
      ),
    );
  }
}

String _digitsOnly(String value) => value.replaceAll(RegExp(r'\D'), '');

String _formatTime(TimeOfDay time) {
  final hour = time.hour.toString().padLeft(2, '0');
  final minute = time.minute.toString().padLeft(2, '0');
  return '$hour:$minute';
}

String _patientAdmissionQuery(Map<String, dynamic> patient) {
  for (final key in [
    'uid',
    'hospital_number',
    'patient_hospital_number',
    'phone',
    'name',
  ]) {
    final value = _text(patient[key]);
    if (value.isNotEmpty) return value;
  }
  return '';
}

Map<String, dynamic> _admissionFromResponse(Map<String, dynamic> result) {
  final admission = result['admission'];
  if (admission is Map<String, dynamic>) return admission;
  if (admission is Map) return Map<String, dynamic>.from(admission);
  return result;
}

String _apiAdmissionPriority(String priority) {
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
  return lower == 'emergency' || lower == 'critical' ? 'emergency' : 'elective';
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

int? _intFrom(dynamic value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '');
}

String _text(dynamic value) => value?.toString().trim() ?? '';

int? _wardId(Map<String, dynamic>? ward) => _intFrom(ward?['id']);

String _wardLabel(Map<String, dynamic>? ward) {
  if (ward == null) return '';
  return _text(
    ward['name'] ?? ward['ward_name'] ?? ward['label'] ?? ward['floor_label'],
  );
}

int? _bedId(Map<String, dynamic>? bed) => _intFrom(bed?['id']);

String _bedLabel(Map<String, dynamic>? bed) {
  if (bed == null) return '';
  final label = _text(
    bed['bed_number'] ?? bed['bed'] ?? bed['label'] ?? bed['name'],
  );
  final ward = _text(bed['ward_name']);
  final type = _text(bed['bed_type']);
  return [
    if (label.isNotEmpty) label,
    if (ward.isNotEmpty) ward,
    if (type.isNotEmpty) type,
  ].join(' - ');
}

String _money(dynamic value) {
  final number = value is num ? value : num.tryParse(value?.toString() ?? '');
  if (number == null) return 'Rs 0';
  return 'Rs ${number.toStringAsFixed(number.truncateToDouble() == number ? 0 : 2)}';
}

int? _doctorId(Map<String, dynamic> doctor) => int.tryParse(
  (doctor['user_id'] ?? doctor['userId'] ?? doctor['id'])?.toString() ?? '',
);

String? _doctorUid(Map<String, dynamic> doctor) {
  final value = doctor['uid'] ?? doctor['doctor_uid'] ?? doctor['doctorUid'];
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? null : text;
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

class _InlineAlert extends StatelessWidget {
  final String message;
  final Color color;

  const _InlineAlert({required this.message, required this.color});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: color.withValues(alpha: 0.28)),
        ),
        child: Row(
          children: [
            Icon(Icons.info_outline, color: color),
            const SizedBox(width: 8),
            Expanded(child: Text(message)),
          ],
        ),
      ),
    );
  }
}
