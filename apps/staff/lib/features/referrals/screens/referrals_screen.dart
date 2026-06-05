import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/desktop_scroll_controls.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';

class ReferralsScreen extends StatefulWidget {
  final int? requestAdmissionId;

  const ReferralsScreen({super.key, this.requestAdmissionId});

  @override
  State<ReferralsScreen> createState() => _ReferralsScreenState();
}

class _ReferralsScreenState extends State<ReferralsScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  final _departmentCtrl = TextEditingController();
  final _reasonCtrl = TextEditingController();
  final _summaryCtrl = TextEditingController();
  final _consultantSearchCtrl = TextEditingController();
  Timer? _searchDebounce;

  bool _loading = true;
  bool _saving = false;
  String? _error;
  String _urgency = 'routine';
  Map<String, dynamic>? _admissionChart;
  List<Map<String, dynamic>> _incoming = const [];
  List<Map<String, dynamic>> _outgoing = const [];
  List<Map<String, dynamic>> _audit = const [];
  List<Map<String, dynamic>> _consultants = const [];
  Map<String, dynamic>? _selectedConsultant;
  bool _auditAllowed = true;

  bool get _requestMode => widget.requestAdmissionId != null;

  Map<String, dynamic> get _admission =>
      (_admissionChart?['admission'] as Map?)?.cast<String, dynamic>() ??
      const {};

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _load();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _departmentCtrl.dispose();
    _reasonCtrl.dispose();
    _summaryCtrl.dispose();
    _consultantSearchCtrl.dispose();
    _searchDebounce?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      if (_requestMode) {
        _admissionChart = await MedicalApiService.getInpatientDrugChart(
          widget.requestAdmissionId!,
        );
      }
      final incoming = await MedicalApiService.getIncomingReferrals();
      final outgoing = await MedicalApiService.getOutgoingReferrals();
      List<Map<String, dynamic>> audit = const [];
      var auditAllowed = true;
      try {
        audit = await MedicalApiService.getReferralAudit();
      } catch (_) {
        auditAllowed = false;
      }
      if (!mounted) return;
      setState(() {
        _incoming = incoming;
        _outgoing = outgoing;
        _audit = audit;
        _auditAllowed = auditAllowed;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _searchConsultants(String value) async {
    final query = value.trim();
    final dept = _departmentCtrl.text.trim();
    if (query.length < 2 && dept.length < 2) {
      setState(() => _consultants = const []);
      return;
    }
    try {
      final rows = await MedicalApiService.searchReferralConsultants(
        query: query,
        department: dept,
      );
      if (!mounted) return;
      setState(() => _consultants = rows);
    } catch (_) {
      if (!mounted) return;
      setState(() => _consultants = const []);
    }
  }

  void _debouncedSearch(String value) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(
      const Duration(milliseconds: 250),
      () => _searchConsultants(value),
    );
  }

  Future<void> _submitReferral() async {
    final patientUid = _text(_admission['patient_uid']);
    final department = _departmentCtrl.text.trim();
    final reason = _reasonCtrl.text.trim();
    if (patientUid.isEmpty || department.isEmpty || reason.isEmpty) {
      _showSnack('Patient, department, and reason are required', isError: true);
      return;
    }

    setState(() => _saving = true);
    try {
      await MedicalApiService.createWardReferral(
        patientUid: patientUid,
        encounterId: _text(_admission['encounter_id']).isEmpty
            ? null
            : _text(_admission['encounter_id']),
        admissionId: widget.requestAdmissionId,
        department: department,
        referredToDoctor: _text(_selectedConsultant?['uid']).isEmpty
            ? null
            : _text(_selectedConsultant?['uid']),
        reason: reason,
        urgency: _urgency,
        clinicalSummary: _summaryCtrl.text.trim().isEmpty
            ? null
            : _summaryCtrl.text.trim(),
      );
      if (!mounted) return;
      _showSnack('Referral requested and specialist notified');
      context.go('/referrals');
    } catch (e) {
      if (!mounted) return;
      _showSnack(e.toString().replaceFirst('Exception: ', ''), isError: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _markSeenAndOpen(Map<String, dynamic> referral) async {
    final id = _int(referral['id']);
    if (id > 0 && _text(referral['first_seen_at']).isEmpty) {
      try {
        await MedicalApiService.markReferralSeen(id);
      } catch (_) {}
      await _load();
    }
    if (!mounted) return;
    _showReferralSheet(referral);
  }

  Future<void> _transitionReferral(
    Map<String, dynamic> referral,
    String action,
  ) async {
    final id = _int(referral['id']);
    if (id <= 0) return;
    try {
      if (action == 'accept') {
        await MedicalApiService.acceptReferral(id);
      } else if (action == 'complete') {
        await MedicalApiService.completeReferral(id);
      } else if (action == 'decline') {
        await MedicalApiService.declineReferral(id, reason: 'Declined');
      }
      await _load();
      if (mounted) Navigator.of(context).maybePop();
    } catch (e) {
      _showSnack(e.toString().replaceFirst('Exception: ', ''), isError: true);
    }
  }

  void _showReferralSheet(Map<String, dynamic> referral) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => Padding(
        padding: const EdgeInsets.fromLTRB(18, 18, 18, 28),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _text(referral['referral_number'], 'Referral'),
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  _pill(_text(referral['urgency'], 'routine')),
                  _pill(_text(referral['status'], 'pending')),
                  _pill(
                    _text(referral['referred_to_department'], 'Department'),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              _labelValue('Reason', _text(referral['reason'])),
              _labelValue('Summary', _text(referral['clinical_summary'], '-')),
              _labelValue('Requested', _formatDateTime(referral['created_at'])),
              _labelValue(
                'First seen',
                _formatDateTime(referral['first_seen_at']),
              ),
              const SizedBox(height: 16),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [
                  FilledButton.icon(
                    onPressed: () => _transitionReferral(referral, 'accept'),
                    icon: const Icon(Icons.check_circle_outline),
                    label: const Text('Accept'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () => _transitionReferral(referral, 'complete'),
                    icon: const Icon(Icons.done_all),
                    label: const Text('Complete'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () => _transitionReferral(referral, 'decline'),
                    icon: const Icon(Icons.block),
                    label: const Text('Decline'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () {
                      final uid = _text(referral['patient_uid']);
                      if (uid.isEmpty) return;
                      context.push('/emr/timeline/$uid');
                    },
                    icon: const Icon(Icons.timeline),
                    label: const Text('Open patient'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showSnack(String message, {bool isError = false}) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: isError ? AppTheme.errorRed : AppTheme.successGreen,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: _requestMode ? 'Request Referral' : 'Referrals',
      body: _loading
          ? const SkeletonList()
          : _error != null
          ? ErrorState(message: _error!, onRetry: _load)
          : _requestMode
          ? _buildRequestForm()
          : _buildBoard(),
    );
  }

  Widget _buildBoard() {
    return Column(
      children: [
        TabBar(
          controller: _tabController,
          tabs: const [
            Tab(text: 'Incoming'),
            Tab(text: 'Outgoing'),
            Tab(text: 'Audit'),
          ],
        ),
        Expanded(
          child: TabBarView(
            controller: _tabController,
            children: [
              _ReferralList(
                rows: _incoming,
                empty: 'No incoming referrals',
                onTap: _markSeenAndOpen,
              ),
              _ReferralList(
                rows: _outgoing,
                empty: 'No outgoing referrals',
                onTap: _showReferralSheet,
              ),
              _auditAllowed
                  ? _AuditList(rows: _audit)
                  : const Center(
                      child: Text(
                        'Referral audit is available to Admin/SuperAdmin roles.',
                      ),
                    ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildRequestForm() {
    final patient = _text(_admission['patient_name'], 'Patient');
    final bed = _text(_admission['bed_number']);
    final ward = _text(_admission['ward_name']);
    return DesktopScrollControls(
      axis: Axis.vertical,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      patient,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      [
                        if (ward.isNotEmpty) ward,
                        if (bed.isNotEmpty) 'Bed $bed',
                        'Admission #${widget.requestAdmissionId}',
                      ].join(' - '),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _departmentCtrl,
              onChanged: _debouncedSearch,
              decoration: const InputDecoration(
                labelText: 'Department / specialty',
                prefixIcon: Icon(Icons.apartment_outlined),
                helperText:
                    'Leave consultant unselected to notify the department.',
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _consultantSearchCtrl,
              onChanged: _debouncedSearch,
              decoration: const InputDecoration(
                labelText: 'Consultant name',
                prefixIcon: Icon(Icons.search),
              ),
            ),
            if (_consultants.isNotEmpty) ...[
              const SizedBox(height: 8),
              _ConsultantResults(
                rows: _consultants,
                selectedUid: _text(_selectedConsultant?['uid']),
                onSelected: (row) {
                  setState(() {
                    _selectedConsultant = row;
                    _consultantSearchCtrl.text = _text(row['name']);
                    _departmentCtrl.text = _text(row['department']);
                  });
                },
              ),
            ],
            const SizedBox(height: 10),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'routine', label: Text('Routine')),
                ButtonSegment(value: 'urgent', label: Text('Urgent')),
                ButtonSegment(value: 'emergency', label: Text('Emergency')),
              ],
              selected: {_urgency},
              onSelectionChanged: (value) =>
                  setState(() => _urgency = value.first),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _reasonCtrl,
              minLines: 2,
              maxLines: 4,
              decoration: const InputDecoration(
                labelText: 'Reason for referral',
                prefixIcon: Icon(Icons.report_outlined),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _summaryCtrl,
              minLines: 3,
              maxLines: 6,
              decoration: const InputDecoration(
                labelText: 'Clinical summary',
                prefixIcon: Icon(Icons.notes_outlined),
              ),
            ),
            const SizedBox(height: 18),
            FilledButton.icon(
              onPressed: _saving ? null : _submitReferral,
              icon: _saving
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send_outlined),
              label: Text(_saving ? 'Sending referral' : 'Request referral'),
            ),
          ],
        ),
      ),
    );
  }
}

class _ReferralList extends StatelessWidget {
  final List<Map<String, dynamic>> rows;
  final String empty;
  final void Function(Map<String, dynamic> row) onTap;

  const _ReferralList({
    required this.rows,
    required this.empty,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) return Center(child: Text(empty));
    return DesktopScrollControls(
      axis: Axis.vertical,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 96),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final row in rows) ...[
              Card(
                child: ListTile(
                  leading: Icon(
                    _text(row['first_seen_at']).isEmpty
                        ? Icons.mark_email_unread_outlined
                        : Icons.mark_email_read_outlined,
                    color: _urgencyColor(row['urgency']),
                  ),
                  title: Text(
                    [
                      _text(row['referral_number'], 'Referral'),
                      _text(row['referred_to_department']),
                    ].where((part) => part.isNotEmpty).join(' - '),
                  ),
                  subtitle: Text(
                    [
                      _text(row['reason']),
                      _text(row['status']),
                      _formatDateTime(row['created_at']),
                    ].where((part) => part.isNotEmpty).join(' - '),
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => onTap(row),
                ),
              ),
              const SizedBox(height: 8),
            ],
          ],
        ),
      ),
    );
  }
}

class _AuditList extends StatelessWidget {
  final List<Map<String, dynamic>> rows;

  const _AuditList({required this.rows});

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) {
      return const Center(child: Text('No referral audit rows'));
    }
    return DesktopScrollControls(
      axis: Axis.vertical,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 96),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final row in rows) ...[
              Card(
                child: ListTile(
                  leading: Icon(
                    Icons.manage_search,
                    color: _urgencyColor(row['urgency']),
                  ),
                  title: Text(
                    [
                      _text(row['referral_number'], 'Referral'),
                      _text(row['patient_name'], _text(row['patient_uid'])),
                    ].where((part) => part.isNotEmpty).join(' - '),
                  ),
                  subtitle: Text(
                    [
                      _text(row['referred_to_department']),
                      _text(row['status']),
                      _int(row['minutes_to_first_seen']) > 0
                          ? '${_int(row['minutes_to_first_seen'])} min to first seen'
                          : 'Not seen yet',
                    ].join(' - '),
                  ),
                ),
              ),
              const SizedBox(height: 8),
            ],
          ],
        ),
      ),
    );
  }
}

class _ConsultantResults extends StatelessWidget {
  final List<Map<String, dynamic>> rows;
  final String selectedUid;
  final void Function(Map<String, dynamic> row) onSelected;

  const _ConsultantResults({
    required this.rows,
    required this.selectedUid,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxHeight: 220),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        border: Border.all(color: AppTheme.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: ListView.separated(
        shrinkWrap: true,
        itemCount: rows.length,
        separatorBuilder: (context, index) =>
            Divider(height: 1, color: AppTheme.divider),
        itemBuilder: (context, index) {
          final row = rows[index];
          final selected = _text(row['uid']) == selectedUid;
          return ListTile(
            dense: true,
            leading: Icon(
              selected ? Icons.check_circle : Icons.person_search_outlined,
              color: selected
                  ? AppTheme.successOnSurface
                  : AppTheme.primaryBlue,
            ),
            title: Text(_text(row['name'], 'Consultant')),
            subtitle: Text(
              [
                _text(row['department']),
                _text(row['specialty']),
              ].where((part) => part.isNotEmpty).join(' - '),
            ),
            onTap: () => onSelected(row),
          );
        },
      ),
    );
  }
}

Widget _pill(String label) {
  return Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
    decoration: BoxDecoration(
      color: AppTheme.primaryBlue.withValues(alpha: 0.10),
      border: Border.all(color: AppTheme.primaryBlue.withValues(alpha: 0.30)),
      borderRadius: BorderRadius.circular(18),
    ),
    child: Text(label),
  );
}

Widget _labelValue(String label, String value) {
  return Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontWeight: FontWeight.w800)),
        const SizedBox(height: 3),
        Text(value.isEmpty ? '-' : value),
      ],
    ),
  );
}

Color _urgencyColor(dynamic value) {
  final urgency = _text(value).toLowerCase();
  if (urgency == 'emergency') return AppTheme.errorOnSurface;
  if (urgency == 'urgent') return AppTheme.warningOnSurface;
  return AppTheme.primaryBlue;
}

String _text(dynamic value, [String fallback = '']) {
  final text = (value ?? '').toString().trim();
  return text.isEmpty ? fallback : text;
}

int _int(dynamic value) => int.tryParse('${value ?? 0}') ?? 0;

String _formatDateTime(dynamic value) {
  final parsed = DateTime.tryParse(_text(value));
  if (parsed == null) return _text(value, '-');
  final local = parsed.toLocal();
  final dd = local.day.toString().padLeft(2, '0');
  final mm = local.month.toString().padLeft(2, '0');
  final hh = local.hour.toString().padLeft(2, '0');
  final min = local.minute.toString().padLeft(2, '0');
  return '$dd/$mm $hh:$min';
}
