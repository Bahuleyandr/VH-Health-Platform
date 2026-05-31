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

  StaffRole _role = StaffRole.general;
  bool _loading = true;
  bool _lookupBusy = false;
  bool _invoiceBusy = false;
  String? _error;
  String? _lookupError;

  List<Map<String, dynamic>> _patientMatches = const [];
  Map<String, dynamic>? _selectedPatient;
  List<Map<String, dynamic>> _todayQueue = const [];
  List<Map<String, dynamic>> _activeAdmissions = const [];
  List<Map<String, dynamic>> _patientInvoices = const [];

  bool get _canBilling => RoleFeatures.hasBillingDesk(_role);
  bool get _canClinical => RoleFeatures.hasClinicalEntry(_role);

  @override
  void initState() {
    super.initState();
    _loadRole();
    _loadWorklists();
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadRole() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    if (!mounted) return;
    setState(() => _role = role);
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

  @override
  Widget build(BuildContext context) {
    final mode = appDeviceModeForContext(context);
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
                label: 'OP Booking',
                color: AppTheme.accentCyan,
                onTap: () => context.go('/appointments'),
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
                : TextButton.icon(
                    onPressed: () => context.go(_patientRoute('/billing-desk')),
                    icon: const Icon(Icons.open_in_new),
                    label: const Text('Open'),
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
    final status = invoice['status']?.toString() ?? 'draft';
    final due = invoice['amount_due'] ?? invoice['total_amount'] ?? 0;
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.receipt_long_outlined),
      title: Text(id.toString(), maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(status.toUpperCase()),
      trailing: Text('Rs $due'),
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
            trailing: TextButton.icon(
              onPressed: () => context.go('/emr/admissions'),
              icon: const Icon(Icons.open_in_new),
              label: const Text('Open'),
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
