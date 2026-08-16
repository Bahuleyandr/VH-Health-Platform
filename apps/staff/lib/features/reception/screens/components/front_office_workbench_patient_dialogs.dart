// ignore_for_file: invalid_use_of_protected_member

part of '../front_office_workbench_screen.dart';

extension _FrontOfficeWorkbenchPatientDialogs
    on _FrontOfficeWorkbenchScreenState {
  Future<Map<String, dynamic>?> _showDuplicatePatientDialog(
    List<Map<String, dynamic>> matches,
  ) {
    final reasonCtrl = TextEditingController();
    String? reasonError;
    return showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) {
          return AlertDialog(
            title: const AppText(
              's4.lib.front_office_workbench.possible_existing_patient',
            ),
            content: SizedBox(
              width: 600,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AppText(
                      's4.lib.front_office_workbench.a_similar_patient_already_exists_select_the_exis',
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                    const SizedBox(height: 12),
                    ...matches
                        .take(5)
                        .map(
                          (patient) => Padding(
                            padding: const EdgeInsets.only(bottom: 6),
                            child: _PatientCard(
                              patient: patient,
                              onTap: () =>
                                  Navigator.pop(dialogContext, patient),
                            ),
                          ),
                        ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: reasonCtrl,
                      minLines: 2,
                      maxLines: 3,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(context).lookup(
                          's4.lib.front_office_workbench.create_anyway_reason',
                        ),
                        prefixIcon: const Icon(Icons.fact_check_outlined),
                        errorText: reasonError,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            actions: [
              TextButton(
                onPressed: () =>
                    Navigator.pop(dialogContext, {'_action': 'cancel'}),
                child: const AppText('action.cancel'),
              ),
              FilledButton.tonalIcon(
                onPressed: () {
                  final reason = reasonCtrl.text.trim();
                  if (reason.length < 10) {
                    setDialogState(() {
                      reasonError = AppStrings.of(context).lookup(
                        's4.lib.front_office_workbench.create_anyway_reason_required',
                      );
                    });
                    return;
                  }
                  Navigator.pop(dialogContext, {
                    '_action': 'create',
                    '_reason': reason,
                  });
                },
                icon: const Icon(Icons.person_add_alt_1),
                label: const AppText(
                  's4.lib.front_office_workbench.create_anyway',
                ),
              ),
            ],
          );
        },
      ),
    ).whenComplete(reasonCtrl.dispose);
  }

  Future<void> _showPatientDialog({
    Map<String, dynamic>? patient,
    String? initialPhone,
  }) async {
    final nameCtrl = TextEditingController(text: patient?['name']?.toString());
    final phoneCtrl = TextEditingController(
      text: patient?['phone']?.toString() ?? initialPhone,
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
    File? patientPhoto;

    final saved = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            final s = AppStrings.of(context);
            Future<void> pickPatientPhoto() async {
              final picked = await ImagePicker().pickImage(
                source: ImageSource.camera,
                maxWidth: 1200,
                imageQuality: 86,
              );
              if (picked == null || !dialogContext.mounted) return;
              setDialogState(() {
                patientPhoto = File(picked.path);
              });
            }

            Future<Map<String, dynamic>?> createPatientWithReview(
              String? duplicateOverrideReason,
            ) async {
              var overrideReason = duplicateOverrideReason;
              while (true) {
                try {
                  return await PatientApiService.createPatient(
                    name: nameCtrl.text,
                    phone: phoneCtrl.text,
                    gender: genderCtrl.text,
                    birthday: birthdayCtrl.text,
                    address: addressCtrl.text,
                    duplicateOverrideReason: overrideReason,
                    photoPath: patientPhoto?.path,
                  );
                } on PatientDuplicateReviewException catch (e) {
                  if (!dialogContext.mounted) return null;
                  setDialogState(() {
                    saving = false;
                    dialogError = null;
                  });
                  final decision = await _showDuplicatePatientDialog(
                    e.candidates,
                  );
                  final action = decision?['_action']?.toString();
                  if (action == 'cancel' || decision == null) return null;
                  if (action != 'create') {
                    if (dialogContext.mounted) {
                      Navigator.of(dialogContext).pop(decision);
                    }
                    return null;
                  }
                  overrideReason = decision['_reason']?.toString();
                  if (!dialogContext.mounted) return null;
                  setDialogState(() {
                    saving = true;
                    dialogError = null;
                  });
                }
              }
            }

            Future<void> save() async {
              if (!frontOfficePhoneMeetsMinimum(phoneCtrl.text)) {
                setDialogState(() {
                  dialogError = s.lookup(
                    's4.lib.front_office_workbench.patient_phone_min_digits',
                  );
                });
                return;
              }
              String? duplicateOverrideReason;
              if (patient == null) {
                setDialogState(() {
                  saving = true;
                  dialogError = s.lookup(
                    's4.lib.front_office_workbench.checking_existing_patients',
                  );
                });
                try {
                  final duplicates = await _findPotentialDuplicatePatients(
                    name: nameCtrl.text,
                    phone: phoneCtrl.text,
                    birthday: birthdayCtrl.text,
                  );
                  if (duplicates.isNotEmpty) {
                    if (!dialogContext.mounted) return;
                    setDialogState(() {
                      saving = false;
                      dialogError = null;
                    });
                    final decision = await _showDuplicatePatientDialog(
                      duplicates,
                    );
                    final action = decision?['_action']?.toString();
                    if (action == 'cancel' || decision == null) return;
                    if (action != 'create') {
                      if (dialogContext.mounted) {
                        Navigator.of(dialogContext).pop(decision);
                      }
                      return;
                    }
                    duplicateOverrideReason = decision['_reason']
                        ?.toString()
                        .trim();
                  }
                } catch (_) {
                  if (!dialogContext.mounted) return;
                  setDialogState(() {
                    saving = false;
                    dialogError = null;
                  });
                }
              }
              setDialogState(() {
                saving = true;
                dialogError = null;
              });
              try {
                final result = patient == null
                    ? await createPatientWithReview(duplicateOverrideReason)
                    : await PatientApiService.updatePatient(
                        uid: patient['uid'].toString(),
                        name: nameCtrl.text,
                        phone: phoneCtrl.text,
                        gender: genderCtrl.text,
                        birthday: birthdayCtrl.text,
                        address: addressCtrl.text,
                      );
                if (result == null) return;
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

            return AlertDialog(
              title: Text(
                patient == null
                    ? s.lookup('s4.lib.front_office_workbench.new_patient')
                    : s.lookup('s4.lib.front_office_workbench.edit_patient'),
              ),
              content: SizedBox(
                width: 520,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      TextField(
                        controller: nameCtrl,
                        textInputAction: TextInputAction.next,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(context)
                              .lookup('reception_counter.patient.name'),
                          prefixIcon: const Icon(Icons.badge_outlined),
                        ),
                      ),
                      const SizedBox(height: 10),
                      TextField(
                        controller: phoneCtrl,
                        keyboardType: TextInputType.phone,
                        textInputAction: TextInputAction.next,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(context)
                              .lookup('profile.field.phone'),
                          prefixIcon: const Icon(Icons.phone_outlined),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: genderCtrl,
                              textInputAction: TextInputAction.next,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('bed_sheet.field.gender'),
                                prefixIcon: const Icon(Icons.wc_outlined),
                              ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: TextField(
                              controller: birthdayCtrl,
                              keyboardType: TextInputType.datetime,
                              textInputAction: TextInputAction.next,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context).lookup(
                                  's4.lib.front_office_workbench.birth_date',
                                ),
                                hintText: AppStrings.of(context).lookup(
                                  's4.lib.front_office_workbench.yyyy_mm_dd',
                                ),
                                prefixIcon: const Icon(Icons.cake_outlined),
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
                        decoration: InputDecoration(
                          labelText: AppStrings.of(context)
                              .lookup('profile.field.address'),
                          prefixIcon: const Icon(Icons.home_outlined),
                        ),
                      ),
                      if (patient == null) ...[
                        const SizedBox(height: 10),
                        Container(
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: AppTheme.divider),
                          ),
                          child: Row(
                            children: [
                              CircleAvatar(
                                radius: 28,
                                backgroundColor: AppTheme.primaryBlue
                                    .withValues(alpha: 0.12),
                                backgroundImage: patientPhoto == null
                                    ? null
                                    : FileImage(patientPhoto!),
                                child: patientPhoto == null
                                    ? const Icon(Icons.person_outline)
                                    : null,
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  s.lookup(
                                    's4.lib.front_office_workbench.patient_photo',
                                  ),
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                              ),
                              OutlinedButton.icon(
                                onPressed: saving ? null : pickPatientPhoto,
                                icon: const Icon(Icons.camera_alt_outlined),
                                label: AppText(
                                  patientPhoto == null
                                      ? 's4.lib.front_office_workbench.take_photo'
                                      : 's4.lib.front_office_workbench.retake_photo',
                                ),
                              ),
                              if (patientPhoto != null) ...[
                                const SizedBox(width: 8),
                                IconButton.filledTonal(
                                  tooltip: s.lookup(
                                    's4.lib.front_office_workbench.remove_photo',
                                  ),
                                  onPressed: saving
                                      ? null
                                      : () => setDialogState(() {
                                          patientPhoto = null;
                                        }),
                                  icon: const Icon(Icons.close),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ],
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
                  child: const AppText('action.cancel'),
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
                  label: const AppText('action.save'),
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
    setState(() {
      _selectedPatient = saved;
      _patientMatches = const [];
      _searchCtrl.text = _patientLabel(saved);
    });
    final s = AppStrings.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          patient == null
              ? s.lookup('s4.lib.front_office_workbench.patient_created')
              : s.lookup('s4.lib.front_office_workbench.patient_updated'),
        ),
        backgroundColor: AppTheme.successGreen,
      ),
    );
    await _loadInvoicesFor(saved);
  }
}
