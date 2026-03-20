import 'package:go_router/go_router.dart';

import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/utils/calendar_utils.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class AppointmentsScreen extends StatefulWidget {
  final String phone;
  const AppointmentsScreen({super.key, required this.phone});

  @override
  State<AppointmentsScreen> createState() => _AppointmentsScreenState();
}

class _AppointmentsScreenState extends State<AppointmentsScreen> {
  final _formKey = GlobalKey<FormState>();
  final _phoneController = TextEditingController();

  String? _selectedDepartment;
  String? _selectedDoctor;
  DateTime? _selectedDate;
  TimeOfDay? _selectedTime;

  // Departments and doctors — fetched from backend when available,
  // falling back to these defaults until the API is wired up.
  List<String> _departments = [];
  Map<String, List<String>> _doctorsByDept = {};
  bool _loadingDepts = true;

  late final bool _isGuest;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _isGuest = widget.phone.trim().isEmpty || widget.phone.toLowerCase() == 'guest';
    _phoneController.text = _isGuest ? '' : widget.phone;
    _fetchDepartments();
  }

  Future<void> _fetchDepartments() async {
    try {
      final resp = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/departments-with-doctors'),
        headers: ApiConfig.authHeaders,
      );
      if (resp.statusCode == 200) {
        final data = jsonDecode(resp.body);
        final List<dynamic> depts = data['data'] ?? data ?? [];
        final Map<String, List<String>> doctorMap = {};
        final List<String> deptNames = [];
        for (final dept in depts) {
          final name = dept['department'] ?? dept['name'] ?? '';
          if (name.toString().isEmpty) continue;
          deptNames.add(name.toString());
          final doctors = dept['doctors'] as List<dynamic>? ?? [];
          doctorMap[name.toString()] = doctors
              .map((d) => d['name']?.toString() ?? d.toString())
              .toList();
        }
        if (mounted) {
          setState(() {
            _departments = deptNames;
            _doctorsByDept = doctorMap;
            _loadingDepts = false;
          });
        }
        return;
      }
    } catch (_) {}
    // Fallback if API fails
    if (mounted) {
      setState(() {
        _departments = ['General Medicine'];
        _doctorsByDept = {'General Medicine': []};
        _loadingDepts = false;
      });
    }
  }

  String _deptLabel(AppLocalizations l10n, String englishName) {
    switch (englishName.toLowerCase()) {
      case 'cardiology': return l10n.cardiology;
      case 'neurology': return l10n.neurology;
      case 'orthopedics': return l10n.orthopedics;
      case 'dermatology': return l10n.dermatology;
      case 'pediatrics': return l10n.pediatrics;
      case 'general medicine': return l10n.general_medicine;
      default: return englishName;
    }
  }

  Future<void> _setAutoAddToCalendar(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('auto_add_to_calendar', value);
  }

  Future<bool> _getAutoAddToCalendar() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool('auto_add_to_calendar') ?? false;
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
    }
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: _selectedTime ?? const TimeOfDay(hour: 9, minute: 0),
    );
    if (picked != null && mounted) {
      setState(() => _selectedTime = picked);
    }
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate() || _submitting) return;
    if (_selectedDate == null || _selectedTime == null) {
      final l10n = AppLocalizations.of(context)!;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(l10n.selectDoctorAndDate),
        backgroundColor: Theme.of(context).colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
      return;
    }

    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final messenger = ScaffoldMessenger.of(context);

    final phone = _phoneController.text.trim();
    final department = _selectedDepartment!;
    final doctor = _selectedDoctor;
    final date = _selectedDate!;
    final time = _selectedTime!;

    // Format date as YYYY-MM-DD and time as HH:mm for backend
    final dateStr = '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
    final timeStr = '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';

    setState(() => _submitting = true);

    try {
      final resp = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/appointments'),
        headers: ApiConfig.jsonHeaders,
        body: jsonEncode({
          'phone': phone,
          'doctor_name': doctor ?? 'Any Doctor',
          'date': dateStr,
          'time': timeStr,
          'department': department,
        }),
      );

      setState(() => _submitting = false);
      if (!mounted) return;

      if (resp.statusCode == 200) {
        messenger.showSnackBar(SnackBar(
          content: Text(l10n.appointmentConfirmationNote),
          backgroundColor: theme.colorScheme.primary,
          behavior: SnackBarBehavior.floating,
        ));

        final start = DateTime(date.year, date.month, date.day, time.hour, time.minute);
        final end = start.add(const Duration(minutes: 30));

        final auto = await _getAutoAddToCalendar();
        if (auto) {
          await addEventToCalendar(
            title: l10n.calendarEventTitle,
            description: l10n.calendarEventDescription(doctor ?? l10n.generalDoctor),
            startDate: start,
            endDate: end,
            location: l10n.calendarEventLocation,
          );
        } else {
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
                      description: l10n.calendarEventDescription(doctor ?? l10n.generalDoctor),
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

        if (mounted) context.pop();
      } else {
        String err = l10n.appointmentFailed;
        try {
          final data = jsonDecode(resp.body);
          if (data['message'] != null) err = data['message'];
        } catch (_) {}
        messenger.showSnackBar(SnackBar(
          content: Text(err),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ));
      }
    } catch (_) {
      setState(() => _submitting = false);
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.genericError),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    }
  }

  Future<void> _triggerSOS() async {
    final l10n = AppLocalizations.of(context)!;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(l10n.authSosTriggered),
      backgroundColor: Theme.of(context).colorScheme.error,
      behavior: SnackBarBehavior.floating,
    ));
    await SOSService.triggerSOS();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return FeatureScreenScaffold(
      title: l10n.requestAppointment,
      icon: Icons.calendar_month_outlined,
      color: FeatureScreenScaffold.featureColors['appointments']!,
      heroTag: 'appointments',
      child: Form(
        key: _formKey,
        child: ListView(
          shrinkWrap: true,  // Add this line
          physics: const AlwaysScrollableScrollPhysics(),  // Add this line
          children: [
            if (_isGuest) ...[
              Text(l10n.enterYourPhone, style: theme.textTheme.titleMedium),
              const SizedBox(height: 8),
              TextFormField(
                controller: _phoneController,
                keyboardType: TextInputType.phone,
                decoration: InputDecoration(labelText: l10n.authPhoneNumber),
                validator: (v) =>
                    v == null || v.trim().length != 10 ? l10n.enterValidPhone : null,
                style: theme.textTheme.bodyLarge,
              ),
              const SizedBox(height: 16),
            ],

            if (_loadingDepts)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 16),
                child: Center(child: CircularProgressIndicator()),
              )
            else
            DropdownButtonFormField<String>(
              value: _selectedDepartment,
              decoration: InputDecoration(labelText: l10n.chooseDepartmentOrDoctor),
              items: _departments.map((dept) {
                return DropdownMenuItem(
                  value: dept,
                  child: Text(_deptLabel(l10n, dept)),
                );
              }).toList(),
              onChanged: (val) {
                setState(() {
                  _selectedDepartment = val;
                  _selectedDoctor = null;
                });
              },
              validator: (v) => v == null ? l10n.selectDoctorAndDate : null,
              style: theme.textTheme.bodyLarge?.copyWith(color: cs.onSurface),
              dropdownColor: theme.cardColor,
              iconEnabledColor: cs.primary,
            ),
            const SizedBox(height: 12),

            if (_selectedDepartment != null &&
                (_doctorsByDept[_selectedDepartment!] ?? []).isNotEmpty)
              DropdownButtonFormField<String>(
                value: _selectedDoctor,
                decoration: InputDecoration(labelText: l10n.selectDoctorPlaceholder),
                items: (_doctorsByDept[_selectedDepartment!] ?? [])
                    .map((doc) => DropdownMenuItem(value: doc, child: Text(doc)))
                    .toList(),
                onChanged: (val) => setState(() => _selectedDoctor = val),
                style: theme.textTheme.bodyLarge?.copyWith(color: cs.onSurface),
                dropdownColor: theme.cardColor,
                iconEnabledColor: cs.primary,
              ),
            const SizedBox(height: 12),

            // Date picker
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(Icons.calendar_today, color: cs.primary),
              title: Text(
                _selectedDate != null
                    ? '${_selectedDate!.day.toString().padLeft(2, '0')}/${_selectedDate!.month.toString().padLeft(2, '0')}/${_selectedDate!.year}'
                    : 'Select Date',
                style: theme.textTheme.bodyLarge,
              ),
              trailing: Icon(Icons.arrow_drop_down, color: cs.onSurface),
              onTap: _pickDate,
            ),

            // Time picker
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(Icons.access_time, color: cs.primary),
              title: Text(
                _selectedTime != null
                    ? _selectedTime!.format(context)
                    : 'Select Time',
                style: theme.textTheme.bodyLarge,
              ),
              trailing: Icon(Icons.arrow_drop_down, color: cs.onSurface),
              onTap: _pickTime,
            ),
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
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _triggerSOS,
        tooltip: l10n.authSosTooltip,
        backgroundColor: Colors.red,
        child: const Icon(Icons.favorite),
      ),
    );
  }
}
