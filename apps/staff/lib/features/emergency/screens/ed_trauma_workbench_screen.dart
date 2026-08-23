import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/services/ed_trauma_api_service.dart';
import '../../../core/services/stemi_pathway_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';
import '../widgets/ed_continuity_panel.dart';

typedef EdPolicyLoader = Future<Map<String, dynamic>> Function();
typedef StemiActivationCreator = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> body,
);
typedef EdDestinationHandoffLoader =
    Future<List<Map<String, dynamic>>> Function();
typedef EdDestinationHandoffRequester = Future<Map<String, dynamic>> Function({
  required int emergencyVisitId,
  required String destination,
  required String intendedRecipientRole,
  required String reason,
});
typedef EdDestinationHandoffDecider = Future<Map<String, dynamic>> Function({
  required int emergencyVisitId,
  required String handoffId,
  required String decision,
  String? reason,
  String? reasonCode,
});
typedef EdDestinationHandoffRerouter = Future<Map<String, dynamic>> Function({
  required int emergencyVisitId,
  required String handoffId,
  required String destination,
  required String intendedRecipientRole,
  required String reason,
});

class EdTraumaWorkbenchScreen extends StatefulWidget {
  const EdTraumaWorkbenchScreen({
    super.key,
    this.loadPolicy,
    this.createStemiActivation,
    this.loadDestinationHandoffs,
    this.requestDestinationHandoff,
    this.decideDestinationHandoff,
    this.rerouteDestinationHandoff,
  });

  final EdPolicyLoader? loadPolicy;
  final StemiActivationCreator? createStemiActivation;
  final EdDestinationHandoffLoader? loadDestinationHandoffs;
  final EdDestinationHandoffRequester? requestDestinationHandoff;
  final EdDestinationHandoffDecider? decideDestinationHandoff;
  final EdDestinationHandoffRerouter? rerouteDestinationHandoff;

  @override
  State<EdTraumaWorkbenchScreen> createState() =>
      _EdTraumaWorkbenchScreenState();
}

class _EdTraumaWorkbenchScreenState extends State<EdTraumaWorkbenchScreen> {
  final _stemiVisitId = TextEditingController();
  final _stemiPatientUid = TextEditingController();
  final _activationNumber = TextEditingController();
  final _visitId = TextEditingController();
  final _patientUid = TextEditingController();
  final _activationReason = TextEditingController();
  final _teamLeaderUid = TextEditingController();
  final _roleCode = TextEditingController(text: 'team_leader');
  final _handoffVisitId = TextEditingController();
  final _handoffRole = TextEditingController();
  final _handoffReason = TextEditingController();

  final _surveyActivationId = TextEditingController();
  final _surveyVisitId = TextEditingController();
  final _airway = TextEditingController();
  final _breathing = TextEditingController();
  final _circulation = TextEditingController();
  final _disability = TextEditingController();
  final _exposure = TextEditingController();
  final _citation = TextEditingController(text: 'clinician_exam');

  final _mlcId = TextEditingController();
  final _mlcVisitId = TextEditingController();
  final _allegedHistory = TextEditingController();
  final _injuryDescription = TextEditingController();
  final _certificateSignerUid = TextEditingController();

  final _evidenceVisitId = TextEditingController();
  final _vitalsChartId = TextEditingController();
  final _deviceObservationId = TextEditingController();

  String _activationLevel = 'full';
  String _surveyKind = 'primary';
  String _evidenceKind = 'vital_snapshot';
  String _handoffDestination = 'ward';
  bool _surveyComplete = false;
  bool _injuryDiagramComplete = false;
  bool _policeNotificationComplete = false;
  bool _chainOfCustodyComplete = false;
  bool _loading = true;
  String? _error;
  String? _message;
  Map<String, dynamic>? _policy;
  List<Map<String, dynamic>> _destinationHandoffs = const [];

  @override
  void initState() {
    super.initState();
    _loadPolicy();
  }

  @override
  void dispose() {
    for (final controller in [
      _stemiVisitId,
      _stemiPatientUid,
      _activationNumber,
      _visitId,
      _patientUid,
      _activationReason,
      _teamLeaderUid,
      _roleCode,
      _handoffVisitId,
      _handoffRole,
      _handoffReason,
      _surveyActivationId,
      _surveyVisitId,
      _airway,
      _breathing,
      _circulation,
      _disability,
      _exposure,
      _citation,
      _mlcId,
      _mlcVisitId,
      _allegedHistory,
      _injuryDescription,
      _certificateSignerUid,
      _evidenceVisitId,
      _vitalsChartId,
      _deviceObservationId,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _loadPolicy() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final loader = widget.loadPolicy ?? EdTraumaApiService.getPolicy;
      final policy = await loader();
      final handoffLoader = widget.loadDestinationHandoffs;
      final handoffs = handoffLoader != null
          ? await handoffLoader()
          : widget.loadPolicy == null
          ? await EdTraumaApiService.listDestinationHandoffs()
          : const <Map<String, dynamic>>[];
      if (!mounted) return;
      setState(() {
        _policy = policy;
        _destinationHandoffs = handoffs;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _cleanError(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _submitStemiActivation() async {
    final strings = AppStrings.of(context);
    await _submit(() async {
      final patientUid = _text(_stemiPatientUid);
      if (patientUid.isEmpty) {
        throw Exception(strings.lookup('ed_trauma.stemi.patient_required'));
      }
      final emergencyVisitId = _intText(_stemiVisitId);
      if (emergencyVisitId == null) {
        throw Exception(strings.lookup('ed_trauma.stemi.visit_required'));
      }
      final creator =
          widget.createStemiActivation ??
          StemiPathwayApiService.createActivation;
      try {
        await creator({
          'patient_uid': patientUid,
          'emergency_visit_id': emergencyVisitId,
          'activation_source': 'clinician',
        });
      } on StemiPathwayApiException {
        throw Exception(strings.lookup('ed_trauma.stemi.activation_failed'));
      }
      if (!mounted) return;
      final message = strings.lookup('ed_trauma.stemi.activated');
      _message = message;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(message)));
    });
  }

  Future<void> _submitActivation() async {
    final strings = AppStrings.of(context);
    await _submit(() async {
      final body = _stripNulls({
        'activation_number': _text(_activationNumber),
        'emergency_visit_id': _intText(_visitId),
        'patient_uid': _text(_patientUid),
        'activation_reason': _text(_activationReason),
        'activation_level': _activationLevel,
        'team_leader_uid': _text(_teamLeaderUid),
        'team_roles': [
          if (_text(_roleCode).isNotEmpty)
            {'role_code': _text(_roleCode), 'staff_uid': _text(_teamLeaderUid)},
        ],
      });
      final row = await EdTraumaApiService.createTraumaActivation(body);
      if (!mounted) return;
      _surveyActivationId.text = '${row['id'] ?? ''}';
      _message = strings.lookup('ed_trauma.activation_saved');
    });
  }

  Future<void> _requestDestinationHandoff() async {
    final strings = AppStrings.of(context);
    await _submit(() async {
      final visitId = _intText(_handoffVisitId);
      if (visitId == null) {
        throw Exception(strings.lookup('ed_trauma.handoff.visit_required'));
      }
      if (_text(_handoffRole).isEmpty || _text(_handoffReason).isEmpty) {
        throw Exception(
          strings.lookup('ed_trauma.handoff.role_reason_required'),
        );
      }
      final requester =
          widget.requestDestinationHandoff ??
          EdTraumaApiService.requestDestinationHandoff;
      await requester(
        emergencyVisitId: visitId,
        destination: _handoffDestination,
        intendedRecipientRole: _text(_handoffRole).toUpperCase(),
        reason: _text(_handoffReason),
      );
      await _reloadDestinationHandoffs();
      if (!mounted) return;
      _message = strings.lookup('ed_trauma.handoff.requested');
    });
  }

  Future<void> _reloadDestinationHandoffs() async {
    final loader = widget.loadDestinationHandoffs;
    final handoffs = loader != null
        ? await loader()
        : widget.loadPolicy == null
        ? await EdTraumaApiService.listDestinationHandoffs()
        : _destinationHandoffs;
    if (mounted) setState(() => _destinationHandoffs = handoffs);
  }

  Future<void> _decideDestinationHandoff(
    Map<String, dynamic> handoff,
    String decision,
  ) async {
    final strings = AppStrings.of(context);
    String? reason;
    String? reasonCode;
    if (decision == 'decline') {
      final decline = await _declineDialog(
        title: strings.lookup('ed_trauma.handoff.decline_title'),
      );
      if (decline == null) return;
      reason = decline.$1;
      reasonCode = decline.$2;
    }
    await _submit(() async {
      final decider =
          widget.decideDestinationHandoff ??
          EdTraumaApiService.decideDestinationHandoff;
      await decider(
        emergencyVisitId: handoff['emergency_visit_id'] as int,
        handoffId: '${handoff['id']}',
        decision: decision,
        reason: reason,
        reasonCode: reasonCode,
      );
      await _reloadDestinationHandoffs();
      if (!mounted) return;
      _message = strings.lookup(
        decision == 'accept'
            ? 'ed_trauma.handoff.accepted'
            : 'ed_trauma.handoff.declined',
      );
    });
  }

  Future<void> _rerouteHandoff(Map<String, dynamic> handoff) async {
    final strings = AppStrings.of(context);
    final result = await _rerouteDialog();
    if (result == null) return;
    await _submit(() async {
      final rerouter =
          widget.rerouteDestinationHandoff ??
          EdTraumaApiService.rerouteDestinationHandoff;
      await rerouter(
        emergencyVisitId: handoff['emergency_visit_id'] as int,
        handoffId: '${handoff['id']}',
        destination: result.$1,
        intendedRecipientRole: result.$2,
        reason: result.$3,
      );
      await _reloadDestinationHandoffs();
      if (!mounted) return;
      _message = strings.lookup('ed_trauma.handoff.rerouted');
    });
  }

  Future<(String, String)?> _declineDialog({required String title}) async {
    var reason = '';
    var reasonCode = 'other';
    return showDialog<(String, String)>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text(title),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                key: const ValueKey('ed-handoff-decline-reason-code'),
                initialValue: reasonCode,
                decoration: InputDecoration(
                  labelText: AppStrings.of(context)
                      .lookup('ed_trauma.handoff.decline_reason_code'),
                ),
                items:
                    const [
                          'capacity_unavailable',
                          'clinical_mismatch',
                          'resource_unavailable',
                          'other',
                        ]
                        .map(
                          (value) => DropdownMenuItem(
                            value: value,
                            child: Text(value.replaceAll('_', ' ')),
                          ),
                        )
                        .toList(),
                onChanged: (value) {
                  if (value != null) {
                    setDialogState(() => reasonCode = value);
                  }
                },
              ),
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('ed-handoff-decline-reason'),
                maxLines: 3,
                onChanged: (value) => reason = value,
                decoration: InputDecoration(
                  labelText: AppStrings.of(context)
                      .lookup('ed_trauma.handoff.reason'),
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: Text(AppStrings.of(context).actionCancel),
            ),
            FilledButton(
              onPressed: () {
                final value = reason.trim();
                if (value.isNotEmpty) {
                  Navigator.pop(context, (value, reasonCode));
                }
              },
              child: Text(AppStrings.of(context).actionSubmit),
            ),
          ],
        ),
      ),
    );
  }

  Future<(String, String, String)?> _rerouteDialog() async {
    var destination = 'ward';
    var role = '';
    var reason = '';
    return showDialog<(String, String, String)>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text(
            AppStrings.of(context).lookup('ed_trauma.handoff.reroute_title'),
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                initialValue: destination,
                items:
                    const ['ward', 'icu', 'hdu', 'surgery', 'external_transfer']
                        .map(
                          (value) => DropdownMenuItem(
                            value: value,
                            child: Text(value),
                          ),
                        )
                        .toList(),
                onChanged: (value) {
                  if (value != null) {
                    setDialogState(() => destination = value);
                  }
                },
              ),
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('ed-handoff-reroute-role'),
                onChanged: (value) => role = value,
                decoration: InputDecoration(
                  labelText: AppStrings.of(context)
                      .lookup('ed_trauma.handoff.receiving_role'),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('ed-handoff-reroute-reason'),
                maxLines: 3,
                onChanged: (value) => reason = value,
                decoration: InputDecoration(
                  labelText: AppStrings.of(context)
                      .lookup('ed_trauma.handoff.reason'),
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: Text(AppStrings.of(context).actionCancel),
            ),
            FilledButton(
              onPressed: () {
                final cleanRole = role.trim().toUpperCase();
                final cleanReason = reason.trim();
                if (cleanRole.isNotEmpty && cleanReason.isNotEmpty) {
                  Navigator.pop(context, (destination, cleanRole, cleanReason));
                }
              },
              child: Text(AppStrings.of(context).actionSubmit),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _submitSurvey() async {
    final strings = AppStrings.of(context);
    await _submit(() async {
      final body = _stripNulls({
        'trauma_activation_id': _intText(_surveyActivationId),
        'emergency_visit_id': _intText(_surveyVisitId),
        'survey_kind': _surveyKind,
        'airway': _text(_airway),
        'breathing': _text(_breathing),
        'circulation': _text(_circulation),
        'disability': _text(_disability),
        'exposure': _text(_exposure),
        'source_citations': [
          if (_text(_citation).isNotEmpty) {'source': _text(_citation)},
        ],
        'completion_status': _surveyComplete ? 'complete' : 'draft',
      });
      await EdTraumaApiService.recordTraumaSurvey(body);
      if (!mounted) return;
      _message = strings.lookup('ed_trauma.survey_saved');
    });
  }

  Future<void> _submitMlc() async {
    final strings = AppStrings.of(context);
    await _submit(() async {
      final mlcRecordId = int.tryParse(_text(_mlcId));
      if (mlcRecordId == null) {
        throw Exception(strings.lookup('ed_trauma.mlc_id_required'));
      }
      final body = _stripNulls({
        'emergency_visit_id': _intText(_mlcVisitId),
        'alleged_history': _text(_allegedHistory),
        'injury_description': _text(_injuryDescription),
        'injury_diagram_complete': _injuryDiagramComplete,
        'police_notification_complete': _policeNotificationComplete,
        'certificate_signer_uid': _text(_certificateSignerUid),
        'chain_of_custody_complete': _chainOfCustodyComplete,
        'closure_requirements': {'human_signoff': true},
        'completeness_status': 'complete',
      });
      await EdTraumaApiService.reviewMlcCompleteness(mlcRecordId, body);
      if (!mounted) return;
      _message = strings.lookup('ed_trauma.mlc_saved');
    });
  }

  Future<void> _submitEvidence() async {
    final strings = AppStrings.of(context);
    await _submit(() async {
      final body = _stripNulls({
        'emergency_visit_id': _intText(_evidenceVisitId),
        'evidence_kind': _evidenceKind,
        'vitals_chart_id': _evidenceKind == 'vital_snapshot'
            ? _intText(_vitalsChartId)
            : null,
        'device_vital_sample_observation_id':
            _evidenceKind == 'device_observation'
            ? _intText(_deviceObservationId)
            : null,
      });
      await EdTraumaApiService.linkEncounterEvidence(body);
      if (!mounted) return;
      _message = strings.lookup('ed_trauma.evidence_saved');
    });
  }

  Future<void> _submit(Future<void> Function() fn) async {
    setState(() {
      _loading = true;
      _error = null;
      _message = null;
    });
    try {
      await fn();
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _cleanError(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _text(TextEditingController controller) => controller.text.trim();

  int? _intText(TextEditingController controller) =>
      int.tryParse(controller.text.trim());

  Map<String, dynamic> _stripNulls(Map<String, dynamic> input) {
    return Map.fromEntries(
      input.entries.where((entry) {
        final value = entry.value;
        if (value == null) return false;
        if (value is String && value.trim().isEmpty) return false;
        return true;
      }),
    );
  }

  String _cleanError(Object e) =>
      e.toString().replaceFirst('Exception: ', '').trim();

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final policyScale = _policy?['canonical_triage_scale']?.toString();
    final active = _policy?['active'] == true && policyScale != null;
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.lookup('ed_trauma.title')),
        actions: [
          IconButton(
            key: const ValueKey('ed-trauma-ambulance-tracking'),
            tooltip: s.lookup('s4.lib.ambulance_tracking.title'),
            onPressed: () => context.push('/ambulance-tracking'),
            icon: const Icon(Icons.local_shipping_outlined),
          ),
          IconButton(
            tooltip: s.actionRefresh,
            onPressed: _loading ? null : _loadPolicy,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: ConstrainedContent(
        child: _loading && _policy == null
            ? const Center(child: CircularProgressIndicator())
            : RefreshIndicator(
                onRefresh: _loadPolicy,
                child: ListView(
                  key: const ValueKey('ed-trauma-workbench-scroll'),
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                  children: [
                    _PolicyBanner(active: active, scale: policyScale),
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      _MessageBanner(message: _error!, isError: true),
                    ],
                    if (_message != null) ...[
                      const SizedBox(height: 12),
                      _MessageBanner(message: _message!, isError: false),
                    ],
                    const SizedBox(height: 14),
                    _Section(
                      title: s.lookup('ed_trauma.handoff.title'),
                      icon: Icons.move_down_outlined,
                      children: [
                        _TextField(
                          fieldKey: const ValueKey('ed-handoff-visit-id'),
                          controller: _handoffVisitId,
                          label: s.lookup('ed_trauma.ed_visit_id'),
                          keyboardType: TextInputType.number,
                        ),
                        _SelectField(
                          label: s.lookup('ed_trauma.handoff.destination'),
                          value: _handoffDestination,
                          values: const [
                            'ward',
                            'icu',
                            'hdu',
                            'surgery',
                            'external_transfer',
                          ],
                          onChanged: (value) =>
                              setState(() => _handoffDestination = value),
                        ),
                        _TextField(
                          fieldKey: const ValueKey('ed-handoff-role'),
                          controller: _handoffRole,
                          label: s.lookup('ed_trauma.handoff.receiving_role'),
                        ),
                        _TextField(
                          fieldKey: const ValueKey('ed-handoff-reason'),
                          controller: _handoffReason,
                          label: s.lookup('ed_trauma.handoff.reason'),
                          maxLines: 2,
                        ),
                        _SubmitButton(
                          key: const ValueKey('ed-handoff-request'),
                          label: s.lookup('ed_trauma.handoff.request'),
                          icon: Icons.outbox_outlined,
                          busy: _loading,
                          onPressed: _requestDestinationHandoff,
                        ),
                        if (_destinationHandoffs.isEmpty)
                          Text(s.lookup('ed_trauma.handoff.empty'))
                        else
                          ..._destinationHandoffs.map(
                            (handoff) => _DestinationHandoffCard(
                              handoff: handoff,
                              busy: _loading,
                              onAccept: () =>
                                  _decideDestinationHandoff(handoff, 'accept'),
                              onDecline: () =>
                                  _decideDestinationHandoff(handoff, 'decline'),
                              onReroute: () => _rerouteHandoff(handoff),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    _Section(
                      title: s.lookup('ed_trauma.stemi.title'),
                      icon: Icons.monitor_heart_outlined,
                      children: [
                        _TextField(
                          fieldKey: const ValueKey('stemi-ed-visit-id'),
                          controller: _stemiVisitId,
                          label: s.lookup('ed_trauma.ed_visit_id'),
                          keyboardType: TextInputType.number,
                        ),
                        _TextField(
                          fieldKey: const ValueKey('stemi-patient-uid'),
                          controller: _stemiPatientUid,
                          label: s.lookup('ed_trauma.patient_uid'),
                        ),
                        _SubmitButton(
                          key: const ValueKey('code-stemi-activate'),
                          label: s.lookup('ed_trauma.stemi.activate'),
                          icon: Icons.monitor_heart_outlined,
                          busy: _loading,
                          onPressed: _submitStemiActivation,
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    _Section(
                      title: s.lookup('ed_trauma.activation'),
                      icon: Icons.emergency_share_outlined,
                      children: [
                        _TextField(
                          controller: _activationNumber,
                          label: s.lookup('ed_trauma.activation_number'),
                        ),
                        _TextField(
                          controller: _visitId,
                          label: s.lookup('ed_trauma.ed_visit_id'),
                          keyboardType: TextInputType.number,
                        ),
                        _TextField(
                          controller: _patientUid,
                          label: s.lookup('ed_trauma.patient_uid'),
                        ),
                        _TextField(
                          controller: _activationReason,
                          label: s.lookup('ed_trauma.reason'),
                          maxLines: 2,
                        ),
                        _SelectField(
                          label: s.lookup('ed_trauma.level'),
                          value: _activationLevel,
                          values: const [
                            'standby',
                            'partial',
                            'full',
                            'mass_casualty',
                          ],
                          onChanged: (value) =>
                              setState(() => _activationLevel = value),
                        ),
                        _TextField(
                          controller: _teamLeaderUid,
                          label: s.lookup('ed_trauma.team_leader_uid'),
                        ),
                        _TextField(
                          controller: _roleCode,
                          label: s.lookup('ed_trauma.role_code'),
                        ),
                        _SubmitButton(
                          label: s.lookup('ed_trauma.save_activation'),
                          busy: _loading,
                          onPressed: _submitActivation,
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    _Section(
                      title: s.lookup('ed_trauma.survey'),
                      icon: Icons.fact_check_outlined,
                      children: [
                        _TextField(
                          controller: _surveyActivationId,
                          label: s.lookup('ed_trauma.activation_id'),
                          keyboardType: TextInputType.number,
                        ),
                        _TextField(
                          controller: _surveyVisitId,
                          label: s.lookup('ed_trauma.ed_visit_id'),
                          keyboardType: TextInputType.number,
                        ),
                        _SelectField(
                          label: s.lookup('ed_trauma.survey_kind'),
                          value: _surveyKind,
                          values: const [
                            'primary',
                            'secondary',
                            'reassessment',
                          ],
                          onChanged: (value) =>
                              setState(() => _surveyKind = value),
                        ),
                        _TextField(
                          controller: _airway,
                          label: s.lookup('ed_trauma.airway'),
                        ),
                        _TextField(
                          controller: _breathing,
                          label: s.lookup('ed_trauma.breathing'),
                        ),
                        _TextField(
                          controller: _circulation,
                          label: s.lookup('ed_trauma.circulation'),
                        ),
                        _TextField(
                          controller: _disability,
                          label: s.lookup('ed_trauma.disability'),
                        ),
                        _TextField(
                          controller: _exposure,
                          label: s.lookup('ed_trauma.exposure'),
                        ),
                        _TextField(
                          controller: _citation,
                          label: s.lookup('ed_trauma.source_citation'),
                        ),
                        CheckboxListTile(
                          contentPadding: EdgeInsets.zero,
                          value: _surveyComplete,
                          onChanged: (value) =>
                              setState(() => _surveyComplete = value ?? false),
                          title: Text(s.lookup('ed_trauma.mark_complete')),
                        ),
                        _SubmitButton(
                          label: s.lookup('ed_trauma.save_survey'),
                          busy: _loading,
                          onPressed: _submitSurvey,
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    _Section(
                      title: s.lookup('ed_trauma.mlc'),
                      icon: Icons.gavel_outlined,
                      children: [
                        _TextField(
                          controller: _mlcId,
                          label: s.lookup('ed_trauma.mlc_record_id'),
                          keyboardType: TextInputType.number,
                        ),
                        _TextField(
                          controller: _mlcVisitId,
                          label: s.lookup('ed_trauma.ed_visit_id'),
                          keyboardType: TextInputType.number,
                        ),
                        _TextField(
                          controller: _allegedHistory,
                          label: s.lookup('ed_trauma.alleged_history'),
                          maxLines: 2,
                        ),
                        _TextField(
                          controller: _injuryDescription,
                          label: s.lookup('ed_trauma.injury_description'),
                          maxLines: 2,
                        ),
                        _TextField(
                          controller: _certificateSignerUid,
                          label: s.lookup('ed_trauma.signer_uid'),
                        ),
                        _CheckTile(
                          value: _injuryDiagramComplete,
                          label: s.lookup('ed_trauma.injury_diagram_complete'),
                          onChanged: (value) =>
                              setState(() => _injuryDiagramComplete = value),
                        ),
                        _CheckTile(
                          value: _policeNotificationComplete,
                          label: s.lookup('ed_trauma.police_complete'),
                          onChanged: (value) => setState(
                            () => _policeNotificationComplete = value,
                          ),
                        ),
                        _CheckTile(
                          value: _chainOfCustodyComplete,
                          label: s.lookup('ed_trauma.custody_complete'),
                          onChanged: (value) =>
                              setState(() => _chainOfCustodyComplete = value),
                        ),
                        _SubmitButton(
                          label: s.lookup('ed_trauma.save_mlc'),
                          busy: _loading,
                          onPressed: _submitMlc,
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    _Section(
                      title: s.lookup('ed_trauma.evidence'),
                      icon: Icons.monitor_heart_outlined,
                      children: [
                        _TextField(
                          controller: _evidenceVisitId,
                          label: s.lookup('ed_trauma.ed_visit_id'),
                          keyboardType: TextInputType.number,
                        ),
                        _SelectField(
                          label: s.lookup('ed_trauma.evidence_kind'),
                          value: _evidenceKind,
                          values: const [
                            'vital_snapshot',
                            'device_observation',
                          ],
                          onChanged: (value) =>
                              setState(() => _evidenceKind = value),
                        ),
                        if (_evidenceKind == 'vital_snapshot')
                          _TextField(
                            controller: _vitalsChartId,
                            label: s.lookup('ed_trauma.vitals_chart_id'),
                            keyboardType: TextInputType.number,
                          )
                        else
                          _TextField(
                            controller: _deviceObservationId,
                            label: s.lookup('ed_trauma.device_observation_id'),
                            keyboardType: TextInputType.number,
                          ),
                        _SubmitButton(
                          label: s.lookup('ed_trauma.save_evidence'),
                          busy: _loading,
                          onPressed: _submitEvidence,
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    const EdContinuityPanel(),
                  ],
                ),
              ),
      ),
    );
  }
}

class _DestinationHandoffCard extends StatelessWidget {
  const _DestinationHandoffCard({
    required this.handoff,
    required this.busy,
    required this.onAccept,
    required this.onDecline,
    required this.onReroute,
  });

  final Map<String, dynamic> handoff;
  final bool busy;
  final VoidCallback onAccept;
  final VoidCallback onDecline;
  final VoidCallback onReroute;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final status = '${handoff['status'] ?? ''}';
    final destination = '${handoff['destination'] ?? ''}';
    final role = '${handoff['intended_recipient_role'] ?? ''}';
    final canDecide = handoff['can_decide'] == true && status == 'requested';
    final canReroute = handoff['can_reroute'] == true && status == 'declined';
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              strings.format('ed_trauma.handoff.item', {
                'visit': handoff['emergency_visit_id'] ?? '',
                'destination': destination,
              }),
              style: Theme.of(context).textTheme.titleSmall
                  ?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            Text(
              strings.format('ed_trauma.handoff.role_status', {
                'role': role,
                'status': status,
              }),
            ),
            if ('${handoff['decline_reason'] ?? ''}'.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                strings.format('ed_trauma.handoff.decline_reason', {
                  'reason': handoff['decline_reason'],
                }),
              ),
            ],
            if ('${handoff['decline_reason_code'] ?? ''}'.isNotEmpty)
              Text(
                '${strings.lookup('ed_trauma.handoff.decline_reason_code')}: '
                '${handoff['decline_reason_code'].toString().replaceAll('_', ' ')}',
              ),
            if (canDecide) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: FilledButton.icon(
                      key: ValueKey('ed-handoff-accept-${handoff['id']}'),
                      onPressed: busy ? null : onAccept,
                      icon: const Icon(Icons.check_circle_outline),
                      label: Text(strings.lookup('ed_trauma.handoff.accept')),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      key: ValueKey('ed-handoff-decline-${handoff['id']}'),
                      onPressed: busy ? null : onDecline,
                      icon: const Icon(Icons.cancel_outlined),
                      label: Text(strings.lookup('ed_trauma.handoff.decline')),
                    ),
                  ),
                ],
              ),
            ],
            if (canReroute) ...[
              const SizedBox(height: 10),
              OutlinedButton.icon(
                key: ValueKey('ed-handoff-reroute-${handoff['id']}'),
                onPressed: busy ? null : onReroute,
                icon: const Icon(Icons.alt_route),
                label: Text(strings.lookup('ed_trauma.handoff.reroute')),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _PolicyBanner extends StatelessWidget {
  final bool active;
  final String? scale;

  const _PolicyBanner({required this.active, required this.scale});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: (active ? AppTheme.successOnSurface : AppTheme.warningOnSurface)
            .withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: active ? AppTheme.successOnSurface : AppTheme.warningOnSurface,
        ),
      ),
      child: Row(
        children: [
          Icon(
            active ? Icons.verified_outlined : Icons.lock_clock_outlined,
            color: active
                ? AppTheme.successOnSurface
                : AppTheme.warningOnSurface,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              active
                  ? s.format('ed_trauma.policy_active', {
                      'scale': scale?.toUpperCase() ?? '',
                    })
                  : s.lookup('ed_trauma.policy_inactive'),
            ),
          ),
        ],
      ),
    );
  }
}

class _MessageBanner extends StatelessWidget {
  final String message;
  final bool isError;

  const _MessageBanner({required this.message, required this.isError});

  @override
  Widget build(BuildContext context) {
    final color = isError ? AppTheme.errorOnSurface : AppTheme.successOnSurface;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Text(message, style: TextStyle(color: color)),
    );
  }
}

class _Section extends StatelessWidget {
  final String title;
  final IconData icon;
  final List<Widget> children;

  const _Section({
    required this.title,
    required this.icon,
    required this.children,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: AppTheme.cardSurface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: BorderSide(color: AppTheme.divider),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(icon, color: AppTheme.primaryBlue),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    title,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            ...children.expand((child) => [child, const SizedBox(height: 10)]),
          ],
        ),
      ),
    );
  }
}

class _TextField extends StatelessWidget {
  final Key? fieldKey;
  final TextEditingController controller;
  final String label;
  final int maxLines;
  final TextInputType? keyboardType;

  const _TextField({
    this.fieldKey,
    required this.controller,
    required this.label,
    this.maxLines = 1,
    this.keyboardType,
  });

  @override
  Widget build(BuildContext context) {
    return TextField(
      key: fieldKey,
      controller: controller,
      maxLines: maxLines,
      keyboardType: keyboardType,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
    );
  }
}

class _SelectField extends StatelessWidget {
  final String label;
  final String value;
  final List<String> values;
  final ValueChanged<String> onChanged;

  const _SelectField({
    required this.label,
    required this.value,
    required this.values,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return DropdownButtonFormField<String>(
      initialValue: value,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      items: values
          .map((item) => DropdownMenuItem(value: item, child: Text(item)))
          .toList(),
      onChanged: (value) {
        if (value != null) onChanged(value);
      },
    );
  }
}

class _CheckTile extends StatelessWidget {
  final bool value;
  final String label;
  final ValueChanged<bool> onChanged;

  const _CheckTile({
    required this.value,
    required this.label,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return CheckboxListTile(
      contentPadding: EdgeInsets.zero,
      value: value,
      onChanged: (next) => onChanged(next ?? false),
      title: Text(label),
    );
  }
}

class _SubmitButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final bool busy;
  final VoidCallback onPressed;

  const _SubmitButton({
    super.key,
    required this.label,
    this.icon = Icons.save_outlined,
    required this.busy,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return FilledButton.icon(
      onPressed: busy ? null : onPressed,
      icon: busy
          ? const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Icon(icon),
      label: Text(label),
    );
  }
}
