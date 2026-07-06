// ignore_for_file: invalid_use_of_protected_member

part of '../front_office_workbench_screen.dart';

extension _FrontOfficeWorkbenchWalkInDialog
    on _FrontOfficeWorkbenchScreenState {
  Future<void> _showWalkInRegistrationDialog() async {
    final patient = _selectedPatient;
    if (!_canBookOp) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.front_office_workbench.walk_in_registration_is_not_enabled_for_this_rol',
          ),
        ),
      );
      return;
    }
    if (patient == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.front_office_workbench.select_a_patient_before_registering_a_walk_in',
          ),
        ),
      );
      return;
    }

    final reasonCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    final departmentCtrl = TextEditingController();
    final insurerCtrl = TextEditingController();
    final policyCtrl = TextEditingController();
    final schemeCtrl = TextEditingController();
    final allergiesCtrl = TextEditingController(
      text: _text(patient['allergies']),
    );
    final medicationsCtrl = TextEditingController();
    final mlcNumberCtrl = TextEditingController();
    final mlcNotesCtrl = TextEditingController();
    final walkInFormKey = GlobalKey<FormState>();
    var selectedVisitType = 'NEW';
    var patientCategory = 'cash';
    var mlc = false;
    Map<String, dynamic>? selectedDoctor;
    var saving = false;
    String? dialogError;

    final registered = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            final s = AppStrings.of(context);

            void focusNextField() {
              FocusScope.of(context).nextFocus();
            }

            void handleNewline(
              TextEditingController controller,
              String value,
              VoidCallback action,
            ) {
              if (!value.contains('\n')) return;
              final cleaned = value.replaceAll(RegExp(r'\s*\n\s*'), ' ');
              controller.value = TextEditingValue(
                text: cleaned,
                selection: TextSelection.collapsed(offset: cleaned.length),
              );
              action();
            }

            Future<void> register() async {
              if (saving) return;
              if (!(walkInFormKey.currentState?.validate() ?? false)) {
                setDialogState(() => dialogError = null);
                return;
              }
              final patientId = _intFrom(patient['id']);
              final patientPhone = _text(patient['phone']);
              final reason = reasonCtrl.text.trim();
              if (patientId == null && _digitsOnly(patientPhone).length < 8) {
                setDialogState(() {
                  dialogError = s.lookup(
                    's4.lib.front_office_workbench.patient_needs_saved_record_or_valid_phone',
                  );
                });
                return;
              }

              setDialogState(() {
                saving = true;
                dialogError = null;
              });
              try {
                final payload = frontOfficeWalkInRegistrationPayload(
                  patient: patient,
                  doctor: selectedDoctor,
                  reason: reason,
                  notes: notesCtrl.text,
                  visitType: selectedVisitType,
                  department:
                      departmentCtrl.text.trim().isEmpty &&
                          selectedVisitType == 'LAB_ONLY'
                      ? 'Laboratory'
                      : departmentCtrl.text,
                  patientCategory: patientCategory,
                  payerType: patientCategory == 'cash' ? null : patientCategory,
                  insurerName: insurerCtrl.text,
                  policyNumber: policyCtrl.text,
                  schemeName: schemeCtrl.text,
                  allergies: allergiesCtrl.text,
                  chronicMedications: medicationsCtrl.text,
                  mlc: mlc,
                  mlcNumber: mlcNumberCtrl.text,
                  mlcNotes: mlcNotesCtrl.text,
                );
                final result = await ScheduleApiService.registerWalkInPayload(
                  payload,
                );
                if (dialogContext.mounted) {
                  Navigator.of(dialogContext).pop(result);
                }
              } catch (e) {
                setDialogState(() {
                  dialogError = localizedApiErrorFromRaw(s, e);
                  saving = false;
                });
              }
            }

            return FocusTraversalGroup(
              child: AlertDialog(
                title: const AppText('appt_queue.register_walk_in'),
                content: SizedBox(
                  width: 620,
                  child: SingleChildScrollView(
                    child: Form(
                      key: walkInFormKey,
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
                                return const LinearProgressIndicator(
                                  minHeight: 2,
                                );
                              }
                              if (snapshot.hasError) {
                                return AppText(
                                  'reception_counter.doctor.could_not_load',
                                  style: TextStyle(
                                    color: AppTheme.errorOnSurface,
                                  ),
                                );
                              }
                              final doctors = frontOfficeFilterDoctors(
                                snapshot.data ?? const [],
                                '',
                                requireNumericId: true,
                                limit: 500,
                              );
                              return _DoctorAutocompleteField(
                                doctors: doctors,
                                selectedDoctor: selectedDoctor,
                                enabled: !saving,
                                labelText: AppStrings.of(context).lookup(
                                  's4.lib.front_office_workbench.consulting_doctor',
                                ),
                                requireNumericId: true,
                                onSelected: (doctor) {
                                  setDialogState(() {
                                    selectedDoctor = doctor;
                                    final department = _text(
                                      doctor?['department'],
                                    );
                                    if (department.isNotEmpty) {
                                      departmentCtrl.text = department;
                                    }
                                  });
                                },
                              );
                            },
                          ),
                          const SizedBox(height: 12),
                          TextFormField(
                            controller: departmentCtrl,
                            textInputAction: TextInputAction.next,
                            onFieldSubmitted: (_) => focusNextField(),
                            decoration: InputDecoration(
                              labelText: AppStrings.of(context).lookup(
                                's4.lib.front_office_workbench.department_counter',
                              ),
                              prefixIcon: const Icon(Icons.apartment_outlined),
                            ),
                            validator: (value) {
                              if (selectedVisitType == 'LAB_ONLY' ||
                                  selectedDoctor != null ||
                                  (value ?? '').trim().isNotEmpty) {
                                return null;
                              }
                              return s.lookup(
                                's4.lib.front_office_workbench.select_doctor_or_department',
                              );
                            },
                          ),
                          const SizedBox(height: 12),
                          Row(
                            children: [
                              Expanded(
                                child: DropdownButtonFormField<String>(
                                  initialValue: selectedVisitType,
                                  decoration: InputDecoration(
                                    labelText: AppStrings.of(context).lookup(
                                      's4.lib.front_office_workbench.visit_type',
                                    ),
                                    prefixIcon: const Icon(
                                      Icons.assignment_outlined,
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
                                      value: 'EMERGENCY',
                                      child: AppText('department.emergency'),
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
                                        's4.lib.front_office_workbench.lab_only',
                                      ),
                                    ),
                                    DropdownMenuItem(
                                      value: 'PAEDIATRIC_OPD',
                                      child: AppText(
                                        's4.lib.front_office_workbench.paediatric_opd',
                                      ),
                                    ),
                                  ].toList(),
                                  onChanged: saving
                                      ? null
                                      : (value) {
                                          if (value == null) return;
                                          setDialogState(() {
                                            selectedVisitType = value;
                                            if (value == 'LAB_ONLY' &&
                                                departmentCtrl.text
                                                    .trim()
                                                    .isEmpty) {
                                              departmentCtrl.text =
                                                  'Laboratory';
                                            }
                                          });
                                        },
                                ),
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: DropdownButtonFormField<String>(
                                  initialValue: patientCategory,
                                  decoration: InputDecoration(
                                    labelText: AppStrings.of(context).lookup(
                                      's4.lib.front_office_workbench.payment_category',
                                    ),
                                    prefixIcon: const Icon(
                                      Icons.payments_outlined,
                                    ),
                                  ),
                                  items: const [
                                    DropdownMenuItem(
                                      value: 'cash',
                                      child: AppText(
                                        's4.lib.front_office_workbench.cash',
                                      ),
                                    ),
                                    DropdownMenuItem(
                                      value: 'corporate',
                                      child: AppText(
                                        's4.lib.front_office_workbench.corporate',
                                      ),
                                    ),
                                    DropdownMenuItem(
                                      value: 'insurance',
                                      child: AppText(
                                        's4.lib.front_office_workbench.insurance',
                                      ),
                                    ),
                                    DropdownMenuItem(
                                      value: 'tpa',
                                      child: AppText(
                                        's4.lib.front_office_workbench.tpa',
                                      ),
                                    ),
                                    DropdownMenuItem(
                                      value: 'scheme',
                                      child: AppText(
                                        's4.lib.front_office_workbench.govt_scheme',
                                      ),
                                    ),
                                  ].toList(),
                                  onChanged: saving
                                      ? null
                                      : (value) => setDialogState(
                                          () =>
                                              patientCategory = value ?? 'cash',
                                        ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          TextFormField(
                            controller: reasonCtrl,
                            textInputAction: TextInputAction.next,
                            onFieldSubmitted: (_) => focusNextField(),
                            decoration: InputDecoration(
                              labelText: AppStrings.of(context).lookup(
                                's4.lib.front_office_workbench.visit_reason_chief_complaint',
                              ),
                              prefixIcon: const Icon(Icons.short_text),
                            ),
                            validator: (value) => (value ?? '').trim().isEmpty
                                ? s.lookup(
                                    's4.lib.front_office_workbench.enter_visit_reason_or_complaint',
                                  )
                                : null,
                          ),
                          const SizedBox(height: 12),
                          TextField(
                            controller: notesCtrl,
                            keyboardType: TextInputType.text,
                            textInputAction: TextInputAction.next,
                            onSubmitted: (_) => focusNextField(),
                            onChanged: (value) =>
                                handleNewline(notesCtrl, value, focusNextField),
                            minLines: 2,
                            maxLines: 3,
                            decoration: InputDecoration(
                              labelText: AppStrings.of(context).lookup(
                                's4.lib.front_office_workbench.counter_intake_notes',
                              ),
                              prefixIcon: const Icon(Icons.notes_outlined),
                            ),
                          ),
                          const SizedBox(height: 12),
                          Row(
                            children: [
                              Expanded(
                                child: TextField(
                                  controller: allergiesCtrl,
                                  textInputAction: TextInputAction.next,
                                  onSubmitted: (_) => focusNextField(),
                                  decoration: InputDecoration(
                                    labelText: AppStrings.of(context).lookup(
                                      's4.lib.front_office_workbench.known_allergies',
                                    ),
                                    prefixIcon: const Icon(
                                      Icons.warning_amber_outlined,
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: TextField(
                                  controller: medicationsCtrl,
                                  textInputAction: TextInputAction.next,
                                  onSubmitted: (_) => focusNextField(),
                                  decoration: InputDecoration(
                                    labelText: AppStrings.of(context).lookup(
                                      's4.lib.front_office_workbench.current_medicines',
                                    ),
                                    prefixIcon: const Icon(
                                      Icons.medication_outlined,
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          Row(
                            children: [
                              Expanded(
                                child: TextField(
                                  controller: insurerCtrl,
                                  textInputAction: TextInputAction.next,
                                  onSubmitted: (_) => focusNextField(),
                                  decoration: InputDecoration(
                                    labelText: AppStrings.of(context).lookup(
                                      's4.lib.front_office_workbench.insurer_tpa',
                                    ),
                                    prefixIcon: const Icon(
                                      Icons.account_balance,
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: TextField(
                                  controller: policyCtrl,
                                  textInputAction: TextInputAction.next,
                                  onSubmitted: (_) => focusNextField(),
                                  decoration: InputDecoration(
                                    labelText: AppStrings.of(context).lookup(
                                      's4.lib.front_office_workbench.policy_number',
                                    ),
                                    prefixIcon: const Icon(
                                      Icons.confirmation_number,
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          TextField(
                            controller: schemeCtrl,
                            textInputAction: mlc
                                ? TextInputAction.next
                                : TextInputAction.done,
                            onSubmitted: (_) {
                              if (mlc) {
                                focusNextField();
                              } else {
                                register();
                              }
                            },
                            decoration: InputDecoration(
                              labelText: AppStrings.of(context).lookup(
                                's4.lib.front_office_workbench.scheme_name',
                              ),
                              prefixIcon: const Icon(
                                Icons.health_and_safety_outlined,
                              ),
                            ),
                          ),
                          const SizedBox(height: 4),
                          CheckboxListTile(
                            value: mlc,
                            onChanged: saving
                                ? null
                                : (value) => setDialogState(
                                    () => mlc = value ?? false,
                                  ),
                            contentPadding: EdgeInsets.zero,
                            controlAffinity: ListTileControlAffinity.leading,
                            title: const AppText(
                              's4.lib.front_office_workbench.medico_legal_case',
                            ),
                          ),
                          if (mlc) ...[
                            Row(
                              children: [
                                Expanded(
                                  child: TextField(
                                    controller: mlcNumberCtrl,
                                    textInputAction: TextInputAction.next,
                                    onSubmitted: (_) => focusNextField(),
                                    decoration: InputDecoration(
                                      labelText: AppStrings.of(context).lookup(
                                        's4.lib.front_office_workbench.mlc_number',
                                      ),
                                      prefixIcon: const Icon(
                                        Icons.gavel_outlined,
                                      ),
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: TextField(
                                    controller: mlcNotesCtrl,
                                    textInputAction: TextInputAction.done,
                                    onSubmitted: (_) => register(),
                                    decoration: InputDecoration(
                                      labelText: AppStrings.of(context).lookup(
                                        's4.lib.front_office_workbench.mlc_notes',
                                      ),
                                      prefixIcon: const Icon(
                                        Icons.description_outlined,
                                      ),
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ],
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
                ),
                actions: [
                  TextButton(
                    onPressed: saving
                        ? null
                        : () => Navigator.pop(context, null),
                    child: const AppText('action.cancel'),
                  ),
                  FilledButton.icon(
                    onPressed: saving ? null : register,
                    icon: saving
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.how_to_reg_outlined),
                    label: Text(
                      saving
                          ? s.frontOfficeWalkInRegisteringButton
                          : s.frontOfficeWalkInRegisterButton,
                    ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );

    reasonCtrl.dispose();
    notesCtrl.dispose();
    departmentCtrl.dispose();
    insurerCtrl.dispose();
    policyCtrl.dispose();
    schemeCtrl.dispose();
    allergiesCtrl.dispose();
    medicationsCtrl.dispose();
    mlcNumberCtrl.dispose();
    mlcNotesCtrl.dispose();

    if (registered == null || !mounted) return;
    final visitNo = _text(registered['visit_no']);
    final token = _text(registered['token_number']);
    final s = AppStrings.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          [
            if (visitNo.isEmpty)
              s.lookup('s4.lib.front_office_workbench.walk_in_registered')
            else
              s.format('s4.dynamic.front_office_workbench.visit_number', {
                'visit': visitNo,
              }),
            if (token.isNotEmpty)
              s.format('s4.dynamic.front_office_workbench.token_number', {
                'token': token,
              }),
          ].join(' - '),
        ),
        backgroundColor: AppTheme.successGreen,
      ),
    );
    await _refreshWorklists();
  }
}
