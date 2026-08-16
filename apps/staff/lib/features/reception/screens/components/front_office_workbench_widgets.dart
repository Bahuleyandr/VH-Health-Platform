part of '../front_office_workbench_screen.dart';

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
            style: Theme.of(context).textTheme.titleMedium
                ?.copyWith(fontWeight: FontWeight.w800),
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
  final VoidCallback? onTap;

  const _Metric({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final content = Container(
      constraints: const BoxConstraints(minWidth: 156),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, color: color),
          const SizedBox(width: 8),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  value,
                  style: Theme.of(context).textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.w800, color: color),
                ),
                Text(
                  label,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
    return Material(
      color: color.withValues(alpha: 0.1),
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: content,
      ),
    );
  }
}

class _InfoPill extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;

  const _InfoPill({
    required this.icon,
    required this.label,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 260),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.22)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: color, fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String label;
  final Color color;

  const _StatusPill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: color,
          fontWeight: FontWeight.w800,
          fontSize: 12,
        ),
      ),
    );
  }
}

class _DetailLine extends StatelessWidget {
  final String label;
  final String value;

  const _DetailLine({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    if (value.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 96,
            child: Text(label, style: TextStyle(color: AppTheme.textSecondary)),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}

class _PatientCard extends StatelessWidget {
  final Map<String, dynamic> patient;
  final bool selected;
  final VoidCallback? onTap;

  const _PatientCard({
    required this.patient,
    required this.onTap,
    this.selected = false,
  });

  @override
  Widget build(BuildContext context) {
    final name = patientNameFrom(patient);
    final subtitle = patientSubtitle(patient, includeAgeGender: true);
    final profilePicture = patientProfilePictureFrom(patient);
    final confidence = _text(patient['confidence_band']);
    final abhaMasked = _text(patient['abha_masked']);
    final interactive = onTap != null;
    return Semantics(
      button: interactive,
      selected: selected,
      label: [name, subtitle].where((part) => part.isNotEmpty).join(', '),
      child: Material(
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
                  backgroundImage: profilePicture.isEmpty
                      ? null
                      : NetworkImage(profilePicture),
                  child: profilePicture.isEmpty
                      ? const ExcludeSemantics(
                          child: Icon(Icons.person_outline),
                        )
                      : null,
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
                      if (subtitle.isNotEmpty)
                        Text(
                          subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      if (confidence.isNotEmpty || abhaMasked.isNotEmpty)
                        Wrap(
                          spacing: 8,
                          runSpacing: 2,
                          children: [
                            if (confidence.isNotEmpty)
                              _StatusPill(
                                label: confidence.toUpperCase(),
                                color: AppTheme.warningAmber,
                              ),
                            if (abhaMasked.isNotEmpty)
                              Text(
                                abhaMasked,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: AppTheme.textSecondary,
                                  fontSize: 12,
                                ),
                              ),
                          ],
                        ),
                    ],
                  ),
                ),
                if (interactive) const Icon(Icons.chevron_right),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _OpBookingClinicianFields extends StatelessWidget {
  final List<Map<String, dynamic>> doctors;
  final Map<String, dynamic>? selectedDoctor;
  final TextEditingController doctorController;
  final FocusNode doctorFocus;
  final TextEditingController departmentController;
  final FocusNode departmentFocus;
  final bool enabled;
  final ValueChanged<Map<String, dynamic>?> onDoctorSelected;
  final ValueChanged<String> onDoctorTextChanged;
  final ValueChanged<String> onDepartmentChanged;

  const _OpBookingClinicianFields({
    required this.doctors,
    required this.selectedDoctor,
    required this.doctorController,
    required this.doctorFocus,
    required this.departmentController,
    required this.departmentFocus,
    required this.onDoctorSelected,
    required this.onDoctorTextChanged,
    required this.onDepartmentChanged,
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) {
    final departments = frontOfficeDepartmentOptionsFromDoctors(doctors);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        RawAutocomplete<Map<String, dynamic>>(
          textEditingController: doctorController,
          focusNode: doctorFocus,
          displayStringForOption: _doctorLabel,
          optionsBuilder: (value) {
            if (!enabled) return const Iterable<Map<String, dynamic>>.empty();
            return frontOfficeFilterDoctors(
              doctors,
              value.text,
              department: departmentController.text,
              requireNumericId: true,
              limit: 25,
            );
          },
          onSelected: enabled ? onDoctorSelected : null,
          fieldViewBuilder: (context, textController, focusNode, _) {
            return TextFormField(
              controller: textController,
              focusNode: focusNode,
              enabled: enabled,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                labelText: AppStrings.of(context)
                    .lookup('s4.lib.front_office_workbench.consulting_doctor'),
                hintText: AppStrings.of(context).lookup(
                  's4.lib.front_office_workbench.optional_if_department_is_selected',
                ),
                prefixIcon: const Icon(Icons.medical_services_outlined),
              ),
              onChanged: onDoctorTextChanged,
            );
          },
          optionsViewBuilder: (context, onOptionSelected, options) {
            final items = options.toList(growable: false);
            return Align(
              alignment: Alignment.topLeft,
              child: Material(
                elevation: 4,
                borderRadius: BorderRadius.circular(8),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxHeight: 260,
                    maxWidth: 560,
                  ),
                  child: ListView.separated(
                    padding: EdgeInsets.zero,
                    shrinkWrap: true,
                    itemCount: items.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final doctor = items[index];
                      final department = _firstText([
                        frontOfficeDoctorDepartment(doctor),
                        doctor['specialty'],
                        doctor['specialization'],
                      ]);
                      return ListTile(
                        dense: true,
                        leading: const Icon(Icons.person_outline),
                        title: Text(
                          _doctorLabel(doctor),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        subtitle: department.isEmpty
                            ? null
                            : Text(
                                department,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                        onTap: () => onOptionSelected(doctor),
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
          textEditingController: departmentController,
          focusNode: departmentFocus,
          optionsBuilder: (value) {
            if (!enabled) return const Iterable<String>.empty();
            final query = value.text.trim().toLowerCase();
            if (query.isEmpty) return departments.take(25);
            return departments
                .where((department) => department.toLowerCase().contains(query))
                .take(25);
          },
          onSelected: enabled
              ? (department) {
                  departmentController.text = department;
                  onDepartmentChanged(department);
                  departmentFocus.unfocus();
                }
              : null,
          fieldViewBuilder: (context, textController, focusNode, _) {
            return TextFormField(
              controller: textController,
              focusNode: focusNode,
              enabled: enabled,
              decoration: InputDecoration(
                labelText: AppStrings.of(context)
                    .lookup('profile.field.department'),
                hintText: AppStrings.of(context)
                    .lookup('s4.lib.appointments.any_available_doctor'),
                prefixIcon: const Icon(Icons.business),
              ),
              onChanged: onDepartmentChanged,
            );
          },
          optionsViewBuilder: (context, onOptionSelected, options) {
            final items = options.toList(growable: false);
            return Align(
              alignment: Alignment.topLeft,
              child: Material(
                elevation: 4,
                borderRadius: BorderRadius.circular(8),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxHeight: 220,
                    maxWidth: 560,
                  ),
                  child: ListView.separated(
                    padding: EdgeInsets.zero,
                    shrinkWrap: true,
                    itemCount: items.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final department = items[index];
                      return ListTile(
                        dense: true,
                        leading: const Icon(Icons.business_outlined),
                        title: Text(
                          department,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        trailing: selectedDoctor == null
                            ? const AppText(
                                's4.lib.front_office_workbench.any_doctor',
                              )
                            : null,
                        onTap: () => onOptionSelected(department),
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
  }
}

class _DoctorAutocompleteField extends StatelessWidget {
  final List<Map<String, dynamic>> doctors;
  final Map<String, dynamic>? selectedDoctor;
  final ValueChanged<Map<String, dynamic>?> onSelected;
  final String labelText;
  final bool enabled;
  final bool requireNumericId;
  final bool requireUid;

  const _DoctorAutocompleteField({
    required this.doctors,
    required this.selectedDoctor,
    required this.onSelected,
    required this.labelText,
    this.enabled = true,
    this.requireNumericId = false,
    this.requireUid = false,
  });

  @override
  Widget build(BuildContext context) {
    final selectedValue = selectedDoctor;

    return Autocomplete<Map<String, dynamic>>(
      displayStringForOption: _doctorLabel,
      initialValue: TextEditingValue(
        text: selectedValue == null ? '' : _doctorLabel(selectedValue),
      ),
      optionsBuilder: (textEditingValue) {
        if (!enabled) return const Iterable<Map<String, dynamic>>.empty();
        return frontOfficeFilterDoctors(
          doctors,
          textEditingValue.text,
          requireNumericId: requireNumericId,
          requireUid: requireUid,
        );
      },
      onSelected: enabled ? (doctor) => onSelected(doctor) : null,
      fieldViewBuilder: (context, textController, focusNode, onFieldSubmitted) {
        return TextFormField(
          controller: textController,
          focusNode: focusNode,
          enabled: enabled,
          textInputAction: TextInputAction.search,
          decoration: InputDecoration(
            labelText: labelText,
            prefixIcon: const Icon(Icons.medical_services_outlined),
          ),
          onChanged: (value) {
            final selectedLabel = selectedDoctor == null
                ? ''
                : _doctorLabel(selectedDoctor!);
            if (selectedDoctor != null && value.trim() != selectedLabel) {
              onSelected(null);
            }
          },
          onFieldSubmitted: (_) => onFieldSubmitted(),
        );
      },
      optionsViewBuilder: (context, onOptionSelected, options) {
        return Align(
          alignment: Alignment.topLeft,
          child: Material(
            elevation: 4,
            borderRadius: BorderRadius.circular(8),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 280, maxWidth: 560),
              child: ListView.builder(
                padding: EdgeInsets.zero,
                shrinkWrap: true,
                itemCount: options.length,
                itemBuilder: (context, index) {
                  final doctor = options.elementAt(index);
                  final department = _text(
                    doctor['department'] ??
                        doctor['specialty'] ??
                        doctor['specialization'],
                  );
                  return ListTile(
                    dense: true,
                    leading: const Icon(Icons.person_outline),
                    title: Text(
                      _doctorLabel(doctor),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: department.isEmpty
                        ? null
                        : Text(
                            department,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                    onTap: () => onOptionSelected(doctor),
                  );
                },
              ),
            ),
          ),
        );
      },
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

class _QueueActionButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback? onPressed;

  const _QueueActionButton({
    required this.icon,
    required this.label,
    required this.color,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 32,
      child: OutlinedButton.icon(
        onPressed: onPressed,
        icon: Icon(icon, size: 15),
        label: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
        style: OutlinedButton.styleFrom(
          foregroundColor: color,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          visualDensity: VisualDensity.compact,
        ),
      ),
    );
  }
}

class _QueueDateSwitcher extends StatelessWidget {
  final DateTime selectedDate;
  final Future<void> Function(DateTime date) onSelected;

  const _QueueDateSwitcher({
    required this.selectedDate,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final today = _dateOnly(DateTime.now());
    final days = [
      today,
      today.add(const Duration(days: 1)),
      today.add(const Duration(days: 2)),
    ];
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final day in days) ...[
            ChoiceChip(
              label: Text(
                frontOfficeQuickQueueDateLabel(s, day.difference(today).inDays),
              ),
              selected: _dateOnly(selectedDate) == day,
              onSelected: (_) => onSelected(day),
            ),
            const SizedBox(width: 8),
          ],
          OutlinedButton.icon(
            onPressed: () async {
              final picked = await showDatePicker(
                context: context,
                initialDate: selectedDate,
                firstDate: today.subtract(const Duration(days: 30)),
                lastDate: today.add(const Duration(days: 180)),
              );
              if (picked != null) await onSelected(picked);
            },
            icon: const Icon(Icons.event_outlined, size: 18),
            label: Text(DateFormat('d MMM').format(selectedDate)),
            style: OutlinedButton.styleFrom(
              visualDensity: VisualDensity.compact,
              minimumSize: const Size(0, 36),
            ),
          ),
        ],
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
