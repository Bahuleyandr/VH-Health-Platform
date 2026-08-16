import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';

import '../../../core/services/clinical_ai_api_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/desktop_scroll_controls.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

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
  bool _draftingSummary = false;
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
    final s = AppStrings.of(context);
    final patientUid = _text(_admission['patient_uid']);
    final department = _departmentCtrl.text.trim();
    final reason = _reasonCtrl.text.trim();
    final receiverUid = _text(_selectedConsultant?['uid']);
    if (patientUid.isEmpty ||
        department.isEmpty ||
        reason.isEmpty ||
        receiverUid.isEmpty) {
      _showSnack(
        s.lookup(
          's4.lib.referrals.patient_receiver_department_reason_required',
        ),
        isError: true,
      );
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
        referredToDoctor: receiverUid,
        reason: reason,
        urgency: _urgency,
        clinicalSummary: _summaryCtrl.text.trim().isEmpty
            ? null
            : _summaryCtrl.text.trim(),
      );
      if (!mounted) return;
      _showSnack(s.lookup('s4.lib.referrals.requested_notified'));
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
      // A dropped first-seen write is not cosmetic: first_seen_at drives
      // referral aging/escalation, so a swallowed failure keeps paging a
      // referral somebody has already opened and corrupts the audit trail.
      try {
        await MedicalApiService.markReferralSeen(id);
      } catch (_) {
        try {
          // One immediate retry for transient network blips.
          await MedicalApiService.markReferralSeen(id);
        } catch (retryError, retryStack) {
          // Still failing: report it. first_seen_at stays empty on the
          // server, so the next open of this referral retries the write.
          unawaited(
            CrashReporter.instance.recordError(
              retryError,
              retryStack,
              context: 'referral first-seen write (referral id=$id)',
              fatal: false,
            ),
          );
        }
      }
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
        final response = await _showResponseDialog();
        if (response == null) return;
        await MedicalApiService.completeReferral(
          id,
          assessment: _text(response['assessment']),
          recommendations: _text(response['recommendations']),
          followUpPlan: _text(response['follow_up_plan']).isEmpty
              ? null
              : _text(response['follow_up_plan']),
          patientSummary: _text(response['patient_summary']).isEmpty
              ? null
              : _text(response['patient_summary']),
          patientInstructions: _text(response['patient_instructions']).isEmpty
              ? null
              : _text(response['patient_instructions']),
          releaseToPatient: response['release_to_patient'] == true,
          continuingOwnership: response['continuing_ownership'] == true,
        );
      } else if (action == 'decline') {
        final reason = await _showReasonDialog(
          titleKey: 's4.lib.referrals.decline_referral',
          labelKey: 's4.lib.referrals.decline_reason',
        );
        if (reason == null) return;
        await MedicalApiService.declineReferral(id, reason: reason);
      } else if (action == 'close') {
        final planUpdate = await _showReasonDialog(
          titleKey: 's4.lib.referrals.acknowledge_response',
          labelKey: 's4.lib.referrals.plan_update',
        );
        if (planUpdate == null) return;
        await MedicalApiService.acknowledgeReferralResponse(
          id,
          disposition: 'plan_updated',
          planUpdate: planUpdate,
        );
      } else if (action == 'reroute') {
        final reroute = await _showRerouteDialog();
        if (reroute == null) return;
        await MedicalApiService.rerouteReferral(
          id,
          referredToDoctor: _text(reroute['uid']),
          department: _text(reroute['department']),
          reason: _text(reroute['reason']),
        );
      }
      await _load();
      if (mounted) unawaited(Navigator.of(context).maybePop());
    } catch (e) {
      _showSnack(e.toString().replaceFirst('Exception: ', ''), isError: true);
    }
  }

  Future<String?> _showReasonDialog({
    required String titleKey,
    required String labelKey,
  }) async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: AppText(titleKey),
        content: TextField(
          controller: controller,
          autofocus: true,
          minLines: 3,
          maxLines: 6,
          decoration: InputDecoration(
            labelText: AppStrings.of(context).lookup(labelKey),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const AppText('action.cancel'),
          ),
          FilledButton(
            onPressed: () {
              final value = controller.text.trim();
              if (value.isNotEmpty) Navigator.of(context).pop(value);
            },
            child: const AppText('action.confirm'),
          ),
        ],
      ),
    );
    controller.dispose();
    return result;
  }

  Future<Map<String, dynamic>?> _showResponseDialog() async {
    final assessment = TextEditingController();
    final recommendations = TextEditingController();
    final followUp = TextEditingController();
    final patientSummary = TextEditingController();
    final patientInstructions = TextEditingController();
    var releaseToPatient = false;
    var continuingOwnership = false;
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const AppText('s4.lib.referrals.sign_specialist_response'),
          content: SizedBox(
            width: 560,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: assessment,
                    minLines: 3,
                    maxLines: 6,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(
                        context,
                      ).lookup('s4.lib.referrals.assessment'),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: recommendations,
                    minLines: 3,
                    maxLines: 6,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(
                        context,
                      ).lookup('s4.lib.referrals.recommendations'),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: followUp,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(
                        context,
                      ).lookup('s4.lib.referrals.follow_up_plan'),
                    ),
                  ),
                  SwitchListTile.adaptive(
                    value: continuingOwnership,
                    onChanged: (value) =>
                        setDialogState(() => continuingOwnership = value),
                    title: const AppText('s4.lib.referrals.continue_ownership'),
                  ),
                  SwitchListTile.adaptive(
                    value: releaseToPatient,
                    onChanged: (value) =>
                        setDialogState(() => releaseToPatient = value),
                    title: const AppText('s4.lib.referrals.release_to_patient'),
                  ),
                  if (releaseToPatient) ...[
                    TextField(
                      controller: patientSummary,
                      minLines: 2,
                      maxLines: 5,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(
                          context,
                        ).lookup('s4.lib.referrals.patient_summary'),
                      ),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: patientInstructions,
                      minLines: 2,
                      maxLines: 5,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(
                          context,
                        ).lookup('s4.lib.referrals.patient_instructions'),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const AppText('action.cancel'),
            ),
            FilledButton(
              onPressed: () {
                if (assessment.text.trim().isEmpty ||
                    recommendations.text.trim().isEmpty ||
                    (releaseToPatient &&
                        (patientSummary.text.trim().isEmpty ||
                            patientInstructions.text.trim().isEmpty))) {
                  return;
                }
                Navigator.of(context).pop({
                  'assessment': assessment.text.trim(),
                  'recommendations': recommendations.text.trim(),
                  'follow_up_plan': followUp.text.trim(),
                  'patient_summary': patientSummary.text.trim(),
                  'patient_instructions': patientInstructions.text.trim(),
                  'release_to_patient': releaseToPatient,
                  'continuing_ownership': continuingOwnership,
                });
              },
              child: const AppText('s4.lib.referrals.sign_response'),
            ),
          ],
        ),
      ),
    );
    for (final controller in [
      assessment,
      recommendations,
      followUp,
      patientSummary,
      patientInstructions,
    ]) {
      controller.dispose();
    }
    return result;
  }

  Future<Map<String, dynamic>?> _showRerouteDialog() async {
    final search = TextEditingController();
    final department = TextEditingController();
    final reason = TextEditingController();
    var candidates = <Map<String, dynamic>>[];
    Map<String, dynamic>? selected;
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const AppText('s4.lib.referrals.reroute_referral'),
          content: SizedBox(
            width: 520,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: department,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(
                        context,
                      ).lookup('s4.lib.referrals.department_specialty'),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: search,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(
                        context,
                      ).lookup('s4.lib.referrals.consultant_name'),
                      suffixIcon: IconButton(
                        icon: const Icon(Icons.search),
                        onPressed: () async {
                          final rows =
                              await MedicalApiService.searchReferralConsultants(
                                query: search.text,
                                department: department.text,
                              );
                          setDialogState(() => candidates = rows);
                        },
                      ),
                    ),
                  ),
                  for (final candidate in candidates) ...[
                    ListTile(
                      selected:
                          _text(selected?['uid']) == _text(candidate['uid']),
                      leading: Icon(
                        _text(selected?['uid']) == _text(candidate['uid'])
                            ? Icons.radio_button_checked
                            : Icons.radio_button_off,
                      ),
                      onTap: () => setDialogState(() {
                        selected = candidate;
                        department.text = _text(candidate['department']);
                      }),
                      title: Text(_text(candidate['name'])),
                      subtitle: Text(_text(candidate['department'])),
                    ),
                  ],
                  TextField(
                    controller: reason,
                    minLines: 2,
                    maxLines: 5,
                    decoration: InputDecoration(
                      labelText: AppStrings.of(
                        context,
                      ).lookup('s4.lib.referrals.reroute_reason'),
                    ),
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const AppText('action.cancel'),
            ),
            FilledButton(
              onPressed: selected == null || reason.text.trim().isEmpty
                  ? null
                  : () => Navigator.of(context).pop({
                      ...selected!,
                      'department': department.text.trim(),
                      'reason': reason.text.trim(),
                    }),
              child: const AppText('s4.lib.referrals.reroute'),
            ),
          ],
        ),
      ),
    );
    search.dispose();
    department.dispose();
    reason.dispose();
    return result;
  }

  void _showReferralSheet(
    Map<String, dynamic> referral, {
    String actionContext = 'incoming',
  }) {
    final s = AppStrings.of(context);
    final status = _text(referral['status'], 'pending').toLowerCase();
    final isIncoming = actionContext == 'incoming';
    final isOutgoing = actionContext == 'outgoing';
    final canAccept = isIncoming && status == 'pending';
    final canComplete =
        isIncoming && const {'accepted', 'in_progress'}.contains(status);
    final canDecline = status == 'pending' && isIncoming;
    final canClose =
        isOutgoing &&
        status == 'completed' &&
        _text(referral['closure_status'], 'open') == 'open';
    final canReroute = isOutgoing && status == 'declined';

    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) => Container(
        decoration: BoxDecoration(
          color: AppTheme.cardSurface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
          border: Border(top: BorderSide(color: AppTheme.divider)),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 18, 18, 28),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _text(
                    referral['referral_number'],
                    s.lookup('s4.lib.referrals.referral'),
                  ),
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    color: AppTheme.textPrimary,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    _pill(
                      _referralUrgencyLabel(
                        s,
                        _text(referral['urgency'], 'routine'),
                      ),
                    ),
                    _pill(
                      _referralStatusLabel(
                        s,
                        _text(referral['status'], 'pending'),
                      ),
                    ),
                    _pill(
                      _text(
                        referral['referred_to_department'],
                        s.lookup('s4.lib.referrals.department'),
                      ),
                    ),
                    // Structured destination facility for external referrals
                    // (migration 680); absent on internal/legacy rows.
                    if (_destinationFacilityText(referral).isNotEmpty)
                      _pill(_destinationFacilityText(referral)),
                  ],
                ),
                const SizedBox(height: 14),
                _labelValue(
                  s.lookup('s4.lib.referrals.reason'),
                  _text(referral['reason']),
                ),
                _labelValue(
                  s.lookup('s4.lib.referrals.summary'),
                  _text(referral['clinical_summary'], '-'),
                ),
                _labelValue(
                  s.lookup('s4.lib.referrals.requested'),
                  _formatDateTime(referral['created_at']),
                ),
                _labelValue(
                  s.lookup('s4.lib.referrals.first_seen'),
                  _formatDateTime(referral['first_seen_at']),
                ),
                const SizedBox(height: 16),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  children: [
                    if (canAccept)
                      FilledButton.icon(
                        onPressed: () =>
                            _transitionReferral(referral, 'accept'),
                        icon: const Icon(Icons.check_circle_outline),
                        label: const AppText('leave.action.accept'),
                      ),
                    if (canComplete)
                      OutlinedButton.icon(
                        onPressed: () =>
                            _transitionReferral(referral, 'complete'),
                        icon: const Icon(Icons.done_all),
                        label: const AppText(
                          'front_office.appointment_status.completed',
                        ),
                      ),
                    if (canDecline)
                      OutlinedButton.icon(
                        onPressed: () =>
                            _transitionReferral(referral, 'decline'),
                        icon: const Icon(Icons.block),
                        label: Text(
                          isOutgoing
                              ? s.lookup('s4.lib.referrals.decline_request')
                              : s.lookup('s4.lib.referrals.decline'),
                        ),
                      ),
                    if (canClose)
                      FilledButton.icon(
                        onPressed: () => _transitionReferral(referral, 'close'),
                        icon: const Icon(Icons.fact_check_outlined),
                        label: const AppText(
                          's4.lib.referrals.acknowledge_response',
                        ),
                      ),
                    if (canReroute)
                      OutlinedButton.icon(
                        onPressed: () =>
                            _transitionReferral(referral, 'reroute'),
                        icon: const Icon(Icons.alt_route),
                        label: const AppText('s4.lib.referrals.reroute'),
                      ),
                    OutlinedButton.icon(
                      onPressed: () {
                        final uid = _text(referral['patient_uid']);
                        if (uid.isEmpty) return;
                        context.push('/emr/timeline/$uid');
                      },
                      icon: const Icon(Icons.timeline),
                      label: const AppText('s4.lib.referrals.open_patient'),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  isIncoming
                      ? s.lookup('s4.lib.referrals.incoming_action_hint')
                      : s.lookup('s4.lib.referrals.outgoing_action_hint'),
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
                ),
              ],
            ),
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
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: _requestMode
          ? s.lookup('s4.lib.referrals.request_referral')
          : s.lookup('s4.lib.referrals.referrals'),
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
          tabs: [
            Tab(
              text: AppStrings.of(context).lookup('s4.lib.referrals.incoming'),
            ),
            Tab(
              text: AppStrings.of(context).lookup('s4.lib.referrals.outgoing'),
            ),
            Tab(text: AppStrings.of(context).lookup('s4.lib.referrals.audit')),
          ],
        ),
        Expanded(
          child: TabBarView(
            controller: _tabController,
            children: [
              _ReferralList(
                rows: _incoming,
                empty: AppStrings.of(
                  context,
                ).lookup('s4.lib.referrals.no_incoming_referrals'),
                onTap: _markSeenAndOpen,
              ),
              _ReferralList(
                rows: _outgoing,
                empty: AppStrings.of(
                  context,
                ).lookup('s4.lib.referrals.no_outgoing_referrals'),
                onTap: (row) =>
                    _showReferralSheet(row, actionContext: 'outgoing'),
              ),
              _auditAllowed
                  ? _AuditList(rows: _audit)
                  : const Center(
                      child: AppText(
                        's4.lib.referrals.referral_audit_is_available_to_admin_superadmin',
                      ),
                    ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildRequestForm() {
    final s = AppStrings.of(context);
    final patient = _text(
      _admission['patient_name'],
      s.lookup('s4.lib.referrals.patient'),
    );
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
                        if (bed.isNotEmpty)
                          s.format('s4.dynamic.referrals.bed', {'bed': bed}),
                        s.format('s4.dynamic.referrals.admission_id', {
                          'id': widget.requestAdmissionId,
                        }),
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
              decoration: InputDecoration(
                labelText: AppStrings.of(
                  context,
                ).lookup('s4.lib.referrals.department_specialty'),
                prefixIcon: const Icon(Icons.apartment_outlined),
                helperText: AppStrings.of(context).lookup(
                  's4.lib.referrals.leave_consultant_unselected_to_notify_the_depart',
                ),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _consultantSearchCtrl,
              onChanged: _debouncedSearch,
              decoration: InputDecoration(
                labelText: AppStrings.of(
                  context,
                ).lookup('s4.lib.referrals.consultant_name'),
                prefixIcon: const Icon(Icons.search),
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
                ButtonSegment(
                  value: 'routine',
                  label: AppText('admission.priority.routine'),
                ),
                ButtonSegment(
                  value: 'urgent',
                  label: AppText('priority.urgent'),
                ),
                ButtonSegment(
                  value: 'emergency',
                  label: AppText('department.emergency'),
                ),
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
              decoration: InputDecoration(
                labelText: AppStrings.of(
                  context,
                ).lookup('s4.lib.referrals.reason_for_referral'),
                prefixIcon: const Icon(Icons.report_outlined),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _summaryCtrl,
              minLines: 3,
              maxLines: 6,
              decoration: InputDecoration(
                labelText: AppStrings.of(
                  context,
                ).lookup('s4.lib.referrals.clinical_summary'),
                prefixIcon: const Icon(Icons.notes_outlined),
              ),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: _draftingSummary ? null : _draftClinicalSummary,
              icon: _draftingSummary
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.auto_awesome_outlined),
              label: Text(
                _draftingSummary
                    ? s.lookup('s4.lib.referrals.drafting_clinical_summary')
                    : s.lookup('s4.lib.referrals.ai_assist_clinical_summary'),
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
              label: Text(
                _saving
                    ? s.lookup('s4.lib.referrals.sending_referral')
                    : s.lookup('s4.lib.referrals.request_referral'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _draftClinicalSummary() async {
    final admissionId = widget.requestAdmissionId;
    if (admissionId == null) return;
    final s = AppStrings.of(context);
    final draftAddedMessage = s.lookup('s4.lib.referrals.ai_draft_added');
    final reason = _reasonCtrl.text.trim();
    if (reason.isEmpty) {
      _showSnack(
        s.lookup('s4.lib.referrals.enter_reason_before_ai'),
        isError: true,
      );
      return;
    }

    setState(() => _draftingSummary = true);
    try {
      final result = await ClinicalAiApiService.generateAdmissionDraft(
        admissionId: admissionId,
        moduleKey: 'referral_letter',
      );
      final draft =
          (result['draft'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      final summary = _formatAiReferralSummary(s, draft, reason);
      if (!mounted) return;
      final confirmed = await _showAiSummaryEditor(summary);
      if (confirmed == null || confirmed.trim().isEmpty) return;
      setState(() => _summaryCtrl.text = confirmed.trim());
      _showSnack(draftAddedMessage);
    } catch (e) {
      if (!mounted) return;
      _showSnack(e.toString().replaceFirst('Exception: ', ''), isError: true);
    } finally {
      if (mounted) setState(() => _draftingSummary = false);
    }
  }

  Future<String?> _showAiSummaryEditor(String initialText) async {
    final ctrl = TextEditingController(text: initialText);
    final result = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) => Container(
        decoration: BoxDecoration(
          color: AppTheme.cardSurface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
          border: Border(top: BorderSide(color: AppTheme.divider)),
        ),
        padding: EdgeInsets.only(
          left: 18,
          right: 18,
          top: 18,
          bottom: MediaQuery.of(context).viewInsets.bottom + 18,
        ),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              AppText(
                's4.lib.referrals.ai_assisted_clinical_summary',
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  color: AppTheme.textPrimary,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 6),
              AppText(
                's4.lib.referrals.edit_and_confirm_this_draft_it_is_not_sent_until',
                style: TextStyle(color: AppTheme.textSecondary),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: ctrl,
                autofocus: true,
                minLines: 8,
                maxLines: 14,
                decoration: InputDecoration(
                  labelText: AppStrings.of(
                    context,
                  ).lookup('s4.lib.referrals.referral_clinical_summary'),
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: const AppText('action.cancel'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: () =>
                          Navigator.of(context).pop(ctrl.text.trim()),
                      icon: const Icon(Icons.check),
                      label: const AppText('s4.lib.referrals.use_summary'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
    ctrl.dispose();
    return result;
  }

  String _formatAiReferralSummary(
    AppStrings s,
    Map<String, dynamic> draft,
    String fallbackReason,
  ) {
    final lines = <String>[];
    final reason = _text(draft['reason_for_referral'], fallbackReason);
    if (reason.isNotEmpty) {
      lines.add(
        s.format('s4.dynamic.referrals.reason_line', {'reason': reason}),
      );
    }
    final summary = _text(draft['clinical_summary']);
    if (summary.isNotEmpty) lines.add(summary);

    void addList(String label, dynamic value) {
      if (value is! List || value.isEmpty) return;
      lines.add('$label:');
      for (final item in value.take(8)) {
        final text = _text(item);
        if (text.isNotEmpty) lines.add('- $text');
      }
    }

    addList(
      s.lookup('s4.lib.referrals.active_diagnoses'),
      draft['active_diagnoses'],
    );
    addList(
      s.lookup('s4.lib.referrals.current_treatment'),
      draft['current_treatment'],
    );
    addList(
      s.lookup('s4.lib.referrals.investigations'),
      draft['investigations'],
    );
    addList(s.lookup('s4.lib.referrals.pending_items'), draft['pending_items']);
    return lines.where((line) => line.trim().isNotEmpty).join('\n');
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
    final s = AppStrings.of(context);
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
                      _text(
                        row['referral_number'],
                        s.lookup('s4.lib.referrals.referral'),
                      ),
                      _text(row['referred_to_department']),
                    ].where((part) => part.isNotEmpty).join(' - '),
                  ),
                  subtitle: Text(
                    [
                      _text(row['reason']),
                      _referralStatusLabel(s, _text(row['status'])),
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
    final s = AppStrings.of(context);
    if (rows.isEmpty) {
      return const Center(
        child: AppText('s4.lib.referrals.no_referral_audit_rows'),
      );
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
                      _text(
                        row['referral_number'],
                        s.lookup('s4.lib.referrals.referral'),
                      ),
                      _text(row['patient_name'], _text(row['patient_uid'])),
                    ].where((part) => part.isNotEmpty).join(' - '),
                  ),
                  subtitle: Text(
                    [
                      _text(row['referred_to_department']),
                      _referralStatusLabel(s, _text(row['status'])),
                      _int(row['minutes_to_first_seen']) > 0
                          ? s.format('s4.dynamic.referrals.min_to_first_seen', {
                              'minutes': _int(row['minutes_to_first_seen']),
                            })
                          : s.lookup('s4.lib.referrals.not_seen_yet'),
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
    final s = AppStrings.of(context);
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
            title: Text(
              _text(row['name'], s.lookup('s4.lib.referrals.consultant')),
            ),
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
        Text(
          label,
          style: TextStyle(
            color: AppTheme.textPrimary,
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: 3),
        Text(
          value.isEmpty ? '-' : value,
          style: TextStyle(color: AppTheme.textSecondary),
        ),
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

String _referralStatusLabel(AppStrings s, String status) {
  switch (status.toLowerCase()) {
    case 'pending':
      return s.lookup('s4.lib.referrals.status.pending');
    case 'accepted':
      return s.lookup('s4.lib.referrals.status.accepted');
    case 'in_progress':
      return s.lookup('s4.lib.referrals.status.in_progress');
    case 'completed':
      return s.lookup('s4.lib.referrals.status.completed');
    case 'declined':
      return s.lookup('s4.lib.referrals.status.declined');
    case 'cancelled':
    case 'canceled':
      return s.lookup('s4.lib.referrals.status.cancelled');
    default:
      return status.replaceAll('_', ' ');
  }
}

String _referralUrgencyLabel(AppStrings s, String urgency) {
  switch (urgency.toLowerCase()) {
    case 'routine':
      return s.lookup('admission.priority.routine');
    case 'urgent':
      return s.lookup('priority.urgent');
    case 'emergency':
      return s.lookup('department.emergency');
    default:
      return urgency.replaceAll('_', ' ');
  }
}

String _text(dynamic value, [String fallback = '']) {
  final text = (value ?? '').toString().trim();
  return text.isEmpty ? fallback : text;
}

/// "Name - City" for the linked destination facility of an external referral,
/// or '' when the referral carries no structured destination.
String _destinationFacilityText(Map<String, dynamic> referral) {
  final facility = (referral['destination_facility'] as Map?)
      ?.cast<String, dynamic>();
  if (facility == null) return '';
  final name = _text(facility['name']);
  if (name.isEmpty) return '';
  final city = _text(facility['city']);
  return city.isEmpty ? name : '$name - $city';
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
