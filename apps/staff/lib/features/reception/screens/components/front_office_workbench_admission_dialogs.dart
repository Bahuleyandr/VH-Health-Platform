// ignore_for_file: invalid_use_of_protected_member

part of '../front_office_workbench_screen.dart';

extension _FrontOfficeWorkbenchAdmissionDialogs
    on _FrontOfficeWorkbenchScreenState {
  Future<void> _showOpBookingDialog() async {
    final s = AppStrings.of(context);
    final patient = _selectedPatient;
    if (!_canBookOp) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.front_office_workbench.op_booking_is_not_enabled_for_this_role',
          ),
        ),
      );
      return;
    }
    if (patient == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.front_office_workbench.select_a_patient_before_booking_op',
          ),
        ),
      );
      return;
    }

    final reasonCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    final doctorCtrl = TextEditingController();
    final doctorFocus = FocusNode();
    final departmentCtrl = TextEditingController();
    final departmentFocus = FocusNode();
    var appointmentDate = DateTime.now();
    var appointmentTime = TimeOfDay.fromDateTime(
      DateTime.now().add(const Duration(hours: 1)),
    );
    var selectedVisitType = 'NEW';
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
              final department = departmentCtrl.text.trim();
              final reason = reasonCtrl.text.trim();
              final patientId = _intFrom(patient['id']);
              final patientPhone = _text(patient['phone']);
              if (doctorId == null && department.isEmpty) {
                setDialogState(
                  () => dialogError = s.lookup(
                    's4.lib.front_office_workbench.select_doctor_or_department',
                  ),
                );
                return;
              }
              if (patientId == null && _digitsOnly(patientPhone).length < 10) {
                setDialogState(() {
                  dialogError = s.lookup(
                    's4.lib.front_office_workbench.patient_needs_saved_record_or_valid_phone',
                  );
                });
                return;
              }
              if (reason.isEmpty) {
                setDialogState(
                  () => dialogError = s.lookup(
                    's4.lib.front_office_workbench.enter_reason_for_visit',
                  ),
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
                  doctorUid: doctor == null ? null : _doctorUid(doctor),
                  department: department.isEmpty ? null : department,
                  appointmentDate: DateFormat(
                    'yyyy-MM-dd',
                  ).format(appointmentDate),
                  appointmentTime: _formatTime(appointmentTime),
                  reason: reason,
                  notes: notesCtrl.text.trim().isEmpty
                      ? null
                      : notesCtrl.text.trim(),
                  visitType: selectedVisitType,
                );
                if (dialogContext.mounted) {
                  Navigator.of(dialogContext).pop(true);
                }
              } catch (e) {
                setDialogState(() {
                  dialogError = localizedApiErrorFromRaw(s, e);
                  saving = false;
                });
              }
            }

            return AlertDialog(
              title: const AppText(
                's4.lib.front_office_workbench.book_op_appointment',
              ),
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
                        future: _doctorOptionsFuture(),
                        builder: (context, snapshot) {
                          if (snapshot.connectionState ==
                              ConnectionState.waiting) {
                            return const LinearProgressIndicator(minHeight: 2);
                          }
                          if (snapshot.hasError) {
                            return AppText(
                              'reception_counter.doctor.could_not_load',
                              style: TextStyle(color: AppTheme.errorOnSurface),
                            );
                          }
                          final doctors = frontOfficeFilterDoctors(
                            snapshot.data ?? const [],
                            '',
                            requireNumericId: true,
                            limit: 500,
                          );
                          return _OpBookingClinicianFields(
                            doctors: doctors,
                            selectedDoctor: selectedDoctor,
                            doctorController: doctorCtrl,
                            doctorFocus: doctorFocus,
                            departmentController: departmentCtrl,
                            departmentFocus: departmentFocus,
                            enabled: !saving,
                            onDoctorSelected: (doctor) {
                              setDialogState(() {
                                selectedDoctor = doctor;
                                if (doctor == null) return;
                                doctorCtrl.text = _doctorLabel(doctor);
                                final department = frontOfficeDoctorDepartment(
                                  doctor,
                                );
                                if (department.isNotEmpty) {
                                  departmentCtrl.text = department;
                                }
                              });
                              doctorFocus.unfocus();
                            },
                            onDoctorTextChanged: (text) {
                              final selectedLabel = selectedDoctor == null
                                  ? ''
                                  : _doctorLabel(selectedDoctor!);
                              if (selectedDoctor != null &&
                                  text.trim() != selectedLabel) {
                                setDialogState(() => selectedDoctor = null);
                              }
                            },
                            onDepartmentChanged: (department) {
                              if (selectedDoctor == null ||
                                  department.trim().isEmpty ||
                                  frontOfficeSameDepartment(
                                    frontOfficeDoctorDepartment(
                                      selectedDoctor!,
                                    ),
                                    department,
                                  )) {
                                return;
                              }
                              setDialogState(() => selectedDoctor = null);
                              doctorCtrl.clear();
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
                      DropdownButtonFormField<String>(
                        initialValue: selectedVisitType,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('s4.lib.front_office_workbench.visit_type'),
                          prefixIcon: const Icon(Icons.assignment_outlined),
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
                          DropdownMenuItem(
                            value: 'LAB_ONLY',
                            child: AppText(
                              's4.lib.front_office_workbench.lab_only_visit',
                            ),
                          ),
                          DropdownMenuItem(
                            value: 'PAEDIATRIC_OPD',
                            child: AppText(
                              's4.lib.front_office_workbench.paediatric_opd',
                            ),
                          ),
                        ],
                        onChanged: saving
                            ? null
                            : (value) {
                                if (value == null) return;
                                setDialogState(() => selectedVisitType = value);
                              },
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: reasonCtrl,
                        textInputAction: TextInputAction.next,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('reception_counter.opd.reason'),
                          prefixIcon: const Icon(Icons.short_text),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: notesCtrl,
                        minLines: 2,
                        maxLines: 3,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('reception_counter.opd.notes'),
                          prefixIcon: const Icon(Icons.notes_outlined),
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
                  child: const AppText('action.cancel'),
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
                  label: const AppText('s4.lib.appointments.book_op'),
                ),
              ],
            );
          },
        );
      },
    );

    reasonCtrl.dispose();
    notesCtrl.dispose();
    doctorCtrl.dispose();
    doctorFocus.dispose();
    departmentCtrl.dispose();
    departmentFocus.dispose();

    if (booked != true || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: AppText('s4.lib.front_office_workbench.op_appointment_booked'),
        backgroundColor: AppTheme.successGreen,
      ),
    );
    await _refreshWorklists();
  }

  Future<void> _showIpAdmissionDialog({
    Map<String, dynamic>? admissionAdvice,
  }) async {
    final s = AppStrings.of(context);
    final patient =
        _selectedPatient ??
        (admissionAdvice == null
            ? null
            : frontOfficeAdmissionAdvicePatientFrom(admissionAdvice));
    if (!_canAdmitIp) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.front_office_workbench.ip_admission_is_not_enabled_for_this_role',
          ),
        ),
      );
      return;
    }
    if (patient == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.front_office_workbench.select_a_patient_before_admitting_ip',
          ),
        ),
      );
      return;
    }

    final adviceId = admissionAdvice == null
        ? null
        : frontOfficeAdmissionAdviceIdFrom(admissionAdvice);
    final acceptedAdmissionSource = admissionAdvice == null
        ? null
        : frontOfficeAcceptedAdmissionSourceFrom(admissionAdvice);
    final sourceAppointmentId = _intFrom(
      acceptedAdmissionSource?['appointment_id'],
    );
    final effectiveAdviceId = sourceAppointmentId ?? adviceId;
    final acceptedRecipientUid = _text(
      acceptedAdmissionSource?['accepted_recipient_uid'],
    );
    final adviceNote = _admissionAdviceNote(admissionAdvice);
    final chiefComplaintCtrl = TextEditingController(text: adviceNote);
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
                  () => dialogError = s.lookup(
                    's4.lib.front_office_workbench.select_admitting_doctor',
                  ),
                );
                return;
              }
              if (acceptedRecipientUid.isNotEmpty &&
                  doctorUid.toLowerCase() !=
                      acceptedRecipientUid.toLowerCase()) {
                setDialogState(
                  () => dialogError = s.lookup(
                    's4.lib.front_office_workbench.accepted_transfer_doctor_must_match',
                  ),
                );
                return;
              }
              if (chiefComplaint.isEmpty) {
                setDialogState(
                  () => dialogError = s.lookup(
                    's4.lib.front_office_workbench.enter_chief_complaint',
                  ),
                );
                return;
              }
              if (patientQuery.isEmpty) {
                setDialogState(
                  () => dialogError = s.lookup(
                    's4.lib.front_office_workbench.selected_patient_needs_identifier',
                  ),
                );
                return;
              }
              if (!isEmergency && _bedId(selectedBed) == null) {
                setDialogState(
                  () => dialogError = s.lookup(
                    's4.lib.front_office_workbench.select_bed_for_routine_ip_admission',
                  ),
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
                  'admission_advice_id': ?effectiveAdviceId,
                  'appointment_id': ?sourceAppointmentId,
                  if (acceptedAdmissionSource != null)
                    'source_pathway_instance_id':
                        acceptedAdmissionSource['source_pathway_instance_id'],
                  if (acceptedAdmissionSource != null)
                    'source_handoff_id':
                        acceptedAdmissionSource['source_handoff_id'],
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
                  dialogError = localizedApiErrorFromRaw(s, e);
                  saving = false;
                });
              } finally {
                if (mounted) setState(() => _admissionActionBusy = false);
              }
            }

            return AlertDialog(
              title: const AppText(
                's4.lib.front_office_workbench.create_ip_admission',
              ),
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
                      if (admissionAdvice != null) ...[
                        const SizedBox(height: 12),
                        _InlineAlert(
                          message: _admissionAdviceSummary(s, admissionAdvice),
                          color: AppTheme.primaryTeal,
                        ),
                      ],
                      if (acceptedAdmissionSource != null) ...[
                        const SizedBox(height: 8),
                        _InlineAlert(
                          message: s.format(
                            's4.dynamic.front_office_workbench.accepted_transfer_source',
                            {'uid': acceptedRecipientUid},
                          ),
                          color: AppTheme.primaryBlue,
                        ),
                      ],
                      const SizedBox(height: 12),
                      FutureBuilder<List<Map<String, dynamic>>>(
                        future: _doctorOptionsFuture(),
                        builder: (context, snapshot) {
                          if (snapshot.connectionState ==
                              ConnectionState.waiting) {
                            return const LinearProgressIndicator(minHeight: 2);
                          }
                          if (snapshot.hasError) {
                            return AppText(
                              'reception_counter.doctor.could_not_load',
                              style: TextStyle(color: AppTheme.errorOnSurface),
                            );
                          }
                          final doctors = frontOfficeFilterDoctors(
                            snapshot.data ?? const [],
                            '',
                            requireUid: true,
                            limit: 500,
                          );
                          return _DoctorAutocompleteField(
                            doctors: doctors,
                            selectedDoctor: selectedDoctor,
                            enabled: !saving,
                            labelText: AppStrings.of(
                              context,
                            ).lookup('s4.lib.admission.admitting_doctor'),
                            requireUid: true,
                            onSelected: (doctor) {
                              setDialogState(() => selectedDoctor = doctor);
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
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('bed_sheet.field.chief_complaint'),
                          prefixIcon: const Icon(Icons.report_problem_outlined),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: diagnosisCtrl,
                        textInputAction: TextInputAction.next,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('reception_counter.ip.diagnosis'),
                          prefixIcon: const Icon(Icons.assignment_outlined),
                        ),
                      ),
                      const SizedBox(height: 12),
                      LayoutBuilder(
                        builder: (context, constraints) {
                          final compact = constraints.maxWidth < 560;
                          final wardPicker = FutureBuilder<List<Map<String, dynamic>>>(
                            future: _wardOptionsFuture(),
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
                                decoration: InputDecoration(
                                  labelText: AppStrings.of(
                                    context,
                                  ).lookup('reception_counter.ip.ward'),
                                  prefixIcon: const Icon(
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
                                          priority =
                                              frontOfficeAdmissionPriorityAfterWardSelection(
                                                wardLabel: _wardLabel(
                                                  selectedWard,
                                                ),
                                                currentPriority: priority,
                                              );
                                          bedOptionsFuture =
                                              MedicalApiService.getAdmissionBedOptions(
                                                wardId: _wardId(selectedWard),
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
                                    decoration: InputDecoration(
                                      labelText: AppStrings.of(
                                        context,
                                      ).lookup('bed.label'),
                                      prefixIcon: const Icon(
                                        Icons.bed_outlined,
                                      ),
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
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('clinical_inbox.priority'),
                              ),
                              items: _FrontOfficeWorkbenchScreenState
                                  ._admissionPriorities
                                  .map(
                                    (value) => DropdownMenuItem(
                                      value: value,
                                      child: Text(
                                        _frontOfficeAdmissionPriorityLabel(
                                          s,
                                          value,
                                        ),
                                      ),
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
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('reception_counter.ip.code_status'),
                              ),
                              items: _FrontOfficeWorkbenchScreenState
                                  ._codeStatuses
                                  .map(
                                    (value) => DropdownMenuItem(
                                      value: value,
                                      child: Text(
                                        _frontOfficeCodeStatusLabel(s, value),
                                      ),
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
                        title: const AppText(
                          'reception_counter.ip.consent_title',
                        ),
                        subtitle: AppText(
                          's4.lib.front_office_workbench.emergency_admissions_can_proceed_without_a_bed_r',
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
                  child: const AppText('action.cancel'),
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
                  label: const AppText(
                    's4.lib.front_office_workbench.create_ip',
                  ),
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
              s.lookup('s4.lib.front_office_workbench.ip_admission_created')
            else
              s.format(
                's4.dynamic.front_office_workbench.ip_admission_number_created',
                {'ip': ipNumber},
              ),
            if (hospitalNumber.isNotEmpty)
              s.format('s4.dynamic.front_office_workbench.hospital_id_number', {
                'id': hospitalNumber,
              }),
          ].join(' - '),
        ),
        backgroundColor: AppTheme.successGreen,
      ),
    );
    await _refreshWorklists();
  }
}
