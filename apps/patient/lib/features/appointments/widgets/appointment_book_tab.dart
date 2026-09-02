// "Book" tab — department/doctor pickers, date + slot selection, and the
// booking submit (with optional calendar sync). Extracted from
// appointments_screen.dart as its own StatefulWidget. On a successful
// booking it calls [onBooked] so the parent screen switches to — and
// refreshes — the My-Appointments tab.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/offline/patient_cache_invalidation.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/calendar_utils.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

class AppointmentBookTab extends StatefulWidget {
  /// Invoked after a booking is created — the parent switches to and
  /// refreshes the My-Appointments tab.
  final VoidCallback onBooked;

  const AppointmentBookTab({super.key, required this.onBooked});

  @override
  State<AppointmentBookTab> createState() => _AppointmentBookTabState();
}

class _AppointmentBookTabState extends State<AppointmentBookTab> {
  static final _secureStorage = VHSecureStorage.instance;

  final _formKey = GlobalKey<FormState>();
  final _phoneController = TextEditingController();
  final _reasonController = TextEditingController();

  List<DeptInfo> _departments = [];
  DeptInfo? _selectedDept;
  DoctorInfo? _selectedDoctor;
  DateTime? _selectedDate;
  TimeOfDay? _selectedTime;
  String _visitType = 'NEW';

  // Slot picker state
  List<Map<String, dynamic>> _availableSlots = [];
  bool _loadingSlots = false;
  String? _selectedSlotTime; // "HH:mm"

  bool _loadingDepts = true;
  bool _submitting = false;
  late final bool _isGuest;

  String? _patientId;

  @override
  void initState() {
    super.initState();
    final phone = context.read<UserProvider>().phone;
    _isGuest = phone.trim().isEmpty || phone.toLowerCase() == 'guest';
    _phoneController.text = _isGuest ? '' : phone;
    _loadPatientId();
    _fetchDepartments();
    // Load the linked-dependent roster so the "Booking for" selector can
    // offer self + dependents. Deferred past the first build (ProfileSwitcher
    // idiom).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _isGuest) return;
      context.read<DependentsProvider>().loadDependents();
    });
  }

  @override
  void dispose() {
    _phoneController.dispose();
    _reasonController.dispose();
    super.dispose();
  }

  Future<void> _loadPatientId() async {
    _patientId = await _secureStorage.read(key: 'user_id');
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

        final parsed = <DeptInfo>[];
        for (final dept in depts) {
          final id = dept['id'];
          final name = dept['name']?.toString() ?? '';
          if (id == null || name.isEmpty) continue;

          final rawDoctors = dept['doctors'] as List<dynamic>? ?? [];
          final doctors = rawDoctors
              .where((d) => d['id'] != null)
              .map(
                (d) => DoctorInfo(
                  id: d['id'] as int,
                  name: d['name']?.toString() ?? 'Doctor',
                  specialization: d['specialization']?.toString(),
                ),
              )
              .toList();

          parsed.add(
            DeptInfo(
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

  // ── Submit booking ─────────────────────────────────────────────────────────

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate() || _submitting) return;
    final l10n = AppLocalizations.of(context)!;
    if (_selectedDate == null) {
      _showError(l10n.appointmentSelectDateError);
      return;
    }
    // When slots are shown, require a slot selection
    if (_availableSlots.isNotEmpty && _selectedSlotTime == null) {
      _showError(l10n.appointmentSelectAvailableSlotError);
      return;
    }
    if (_availableSlots.isEmpty && _selectedTime == null) {
      _showError(AppLocalizations.of(context)!.selectDoctorAndDate);
      return;
    }
    if (_selectedDoctor == null) {
      _showError(l10n.appointmentSelectDoctorError);
      return;
    }
    // Booking-for: when a dependent profile is active, the booking targets
    // the DEPENDENT's identity. Every request already carries the
    // X-Acting-As-Uid header for the active dependent (DependentsProvider →
    // VHHttpClient), so the backend authorizes the guardian→minor link and
    // records the guardian as the booking actor on the audit trail.
    final activeDependent = context.read<DependentsProvider>().activeDependent;
    final int? effectivePatientId =
        activeDependent?.id ??
        (_patientId == null ? null : int.tryParse(_patientId!));
    if (effectivePatientId == null) {
      _showError(l10n.appointmentSessionMissingError);
      return;
    }

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
          'patient_id': effectivePatientId,
          'doctor_id': _selectedDoctor!.id,
          'appointment_date': dateStr,
          'appointment_time': timeStr,
          'visit_type': _visitType,
          'reason': _reasonController.text.trim().isEmpty
              ? 'General consultation'
              : _reasonController.text.trim(),
        },
      );

      if (!mounted) return;
      setState(() => _submitting = false);

      if (resp.isSuccess) {
        await PatientCacheInvalidation.afterAppointmentMutation();
        if (!mounted) return;
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

        // Hand back to the parent: switch to + refresh My Appointments.
        widget.onBooked();
      } else {
        _showError(resp.failureMessage(l10n.appointmentFailed));
      }
    } catch (e) {
      debugPrint('Appointment booking failed: $e');
      setState(() => _submitting = false);
      _showError(l10n.genericError);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      LiveRegionSnackBar.build(
        message: msg,
        backgroundColor: Theme.of(context).colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  void _showSuccess(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      LiveRegionSnackBar.build(
        message: msg,
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
      unawaited(_fetchSlots());
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

  /// "Booking for" selector — self + linked dependents. Selecting a
  /// dependent switches the app's active acting-as profile (the platform's
  /// single guardian→minor delegation mechanism), so the booking below and
  /// the My-Appointments tab both scope to the selected profile.
  Widget _buildBookingForSelector(ThemeData theme, ColorScheme cs) {
    final dependents = context.watch<DependentsProvider>();
    if (_isGuest || !dependents.hasDependents) return const SizedBox.shrink();
    final userName = context.watch<UserProvider>().name;
    final selfLabel = userName.isNotEmpty ? '$userName (you)' : 'Yourself';

    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: DropdownButtonFormField<Dependent?>(
        // Re-key on the active profile so an external switch (dashboard
        // ProfileSwitcher) is reflected here too.
        key: ValueKey(dependents.activeDependent?.uid ?? 'self'),
        initialValue: dependents.activeDependent,
        decoration: InputDecoration(
          labelText: 'Booking for',
          helperText: dependents.isViewingDependent
              ? 'This appointment will be booked for '
                    '${dependents.activeDependent!.name}, with you recorded '
                    'as the booking guardian.'
              : null,
          prefixIcon: Icon(
            dependents.isViewingDependent
                ? Icons.escalator_warning
                : Icons.person,
            color: dependents.isViewingDependent ? cs.tertiary : cs.primary,
          ),
        ),
        items: [
          DropdownMenuItem<Dependent?>(value: null, child: Text(selfLabel)),
          ...dependents.dependents.map(
            (dep) => DropdownMenuItem<Dependent?>(
              value: dep,
              child: Text(dep.name, overflow: TextOverflow.ellipsis),
            ),
          ),
        ],
        onChanged: (dep) => context.read<DependentsProvider>().switchTo(dep),
        style: theme.textTheme.bodyLarge?.copyWith(color: cs.onSurface),
        dropdownColor: theme.cardColor,
        iconEnabledColor: cs.primary,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _buildBookingForSelector(theme, cs),
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
            DropdownButtonFormField<DeptInfo>(
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
            DropdownButtonFormField<DoctorInfo>(
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
              validator: (v) =>
                  v == null ? l10n.appointmentSelectDoctorError : null,
              style: theme.textTheme.bodyLarge?.copyWith(color: cs.onSurface),
              dropdownColor: theme.cardColor,
              iconEnabledColor: cs.primary,
            ),
          const SizedBox(height: 12),

          DropdownButtonFormField<String>(
            initialValue: _visitType,
            decoration: InputDecoration(labelText: l10n.appointmentVisitType),
            items: [
              DropdownMenuItem(
                value: 'NEW',
                child: Text(l10n.appointmentInPersonConsultation),
              ),
              DropdownMenuItem(
                value: 'TELE',
                child: Text(l10n.appointmentTeleconsultVideoVisit),
              ),
            ],
            onChanged: (value) {
              if (value == null) return;
              setState(() => _visitType = value);
            },
          ),
          const SizedBox(height: 12),

          // Reason
          TextFormField(
            controller: _reasonController,
            decoration: InputDecoration(
              labelText: l10n.appointmentReasonForVisitLabel,
              hintText: l10n.appointmentReasonForVisitHint,
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
                  : l10n.appointmentSelectDateLabel,
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
                return Semantics(
                  button: true,
                  enabled: available,
                  selected: isSelected,
                  child: GestureDetector(
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
                      // 48dp minimum tap target (WCAG 2.5.8 / Android
                      // accessibility guideline).
                      constraints: const BoxConstraints(
                        minWidth: 48,
                        minHeight: 48,
                      ),
                      alignment: Alignment.center,
                      padding: const EdgeInsets.symmetric(horizontal: 14),
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
                  ),
                );
              }).toList(),
            ),
            if (_selectedSlotTime != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  l10n.appointmentSelectedTime(_selectedSlotTime!),
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
                    : l10n.appointmentSelectTimeLabel,
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
}
