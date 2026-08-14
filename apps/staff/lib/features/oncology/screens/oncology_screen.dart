import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';

import '../../../core/services/api_client.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class OncologyTumorBoardCase {
  const OncologyTumorBoardCase({
    required this.id,
    required this.patientUid,
    required this.cancerSite,
    required this.question,
    required this.priority,
    required this.discussionState,
    this.patientName,
    this.tCategory,
    this.nCategory,
    this.mCategory,
    this.clinicalStage,
    this.pathologicStage,
  });

  factory OncologyTumorBoardCase.fromJson(Map<String, dynamic> json) {
    return OncologyTumorBoardCase(
      id: json['id'] as int? ?? int.tryParse('${json['id']}') ?? 0,
      patientUid: json['patient_uid']?.toString() ?? '',
      patientName: json['patient_name']?.toString(),
      cancerSite: json['cancer_site']?.toString() ?? '',
      question: json['question']?.toString() ?? '',
      priority: json['priority']?.toString() ?? 'routine',
      discussionState: json['discussion_state']?.toString() ?? 'queued',
      tCategory: json['t_category']?.toString(),
      nCategory: json['n_category']?.toString(),
      mCategory: json['m_category']?.toString(),
      clinicalStage: json['clinical_stage']?.toString(),
      pathologicStage: json['pathologic_stage']?.toString(),
    );
  }

  final int id;
  final String patientUid;
  final String? patientName;
  final String cancerSite;
  final String question;
  final String priority;
  final String discussionState;
  final String? tCategory;
  final String? nCategory;
  final String? mCategory;
  final String? clinicalStage;
  final String? pathologicStage;

  String get patientLabel =>
      patientName?.trim().isNotEmpty == true ? patientName! : patientUid;

  String get tnmLabel {
    final parts = [tCategory, nCategory, mCategory]
        .where((part) => part != null && part.trim().isNotEmpty)
        .cast<String>()
        .toList();
    if (parts.isNotEmpty) return parts.join(' ');
    return clinicalStage ?? pathologicStage ?? '';
  }
}

class OncologyToxicityEvent {
  const OncologyToxicityEvent({
    required this.id,
    required this.patientUid,
    required this.term,
    required this.grade,
    required this.signoffStatus,
    this.patientName,
    this.source,
    this.sourceVersion,
    this.actionTaken,
  });

  factory OncologyToxicityEvent.fromJson(Map<String, dynamic> json) {
    return OncologyToxicityEvent(
      id: json['id'] as int? ?? int.tryParse('${json['id']}') ?? 0,
      patientUid: json['patient_uid']?.toString() ?? '',
      patientName: json['patient_name']?.toString(),
      term: json['toxicity_term']?.toString() ?? '',
      grade:
          json['ctcae_grade'] as int? ??
          int.tryParse('${json['ctcae_grade']}') ??
          0,
      source: json['ctcae_source']?.toString(),
      sourceVersion: json['ctcae_source_version']?.toString(),
      actionTaken: json['action_taken']?.toString(),
      signoffStatus: json['signoff_status']?.toString() ?? 'draft',
    );
  }

  final int id;
  final String patientUid;
  final String? patientName;
  final String term;
  final int grade;
  final String? source;
  final String? sourceVersion;
  final String? actionTaken;
  final String signoffStatus;

  String get patientLabel =>
      patientName?.trim().isNotEmpty == true ? patientName! : patientUid;
}

class OncologyToxicityInput {
  const OncologyToxicityInput({
    required this.patientUid,
    required this.term,
    required this.grade,
    required this.source,
    required this.sourceVersion,
    required this.actionTaken,
    this.diagnosisId,
    this.chemoCycleId,
    this.chemoAdministrationId,
    this.signoff = true,
  });

  final String patientUid;
  final int? diagnosisId;
  final String term;
  final int grade;
  final String source;
  final String sourceVersion;
  final String actionTaken;
  final int? chemoCycleId;
  final int? chemoAdministrationId;
  final bool signoff;

  Map<String, dynamic> toJson() => {
    'patient_uid': patientUid,
    if (diagnosisId != null) 'diagnosis_id': diagnosisId,
    'toxicity_term': term,
    'ctcae_grade': grade,
    'ctcae_source': source,
    'ctcae_source_version': sourceVersion,
    'action_taken': actionTaken,
    if (chemoCycleId != null) 'chemo_cycle_id': chemoCycleId,
    if (chemoAdministrationId != null)
      'chemo_administration_id': chemoAdministrationId,
    'signoff': signoff,
  };
}

abstract class OncologyApiClient {
  Future<List<OncologyTumorBoardCase>> fetchTumorBoardQueue();
  Future<List<OncologyToxicityEvent>> fetchToxicityEvents();
  Future<OncologyToxicityEvent> createToxicityEvent(
    OncologyToxicityInput input,
  );
}

class HttpOncologyApiClient implements OncologyApiClient {
  const HttpOncologyApiClient();

  Map<String, dynamic> _dataOrThrow(ApiResponse response, String fallback) {
    if (!response.isSuccess) {
      throw Exception(response.failureMessage(fallback));
    }
    return response.dataAsMap();
  }

  @override
  Future<List<OncologyTumorBoardCase>> fetchTumorBoardQueue() async {
    final response = await ApiClient.get('/oncology/tumor-board/queue');
    final data = _dataOrThrow(response, 'Could not load tumor board queue');
    final rows = data['cases'] as List? ?? const [];
    return rows
        .whereType<Map>()
        .map(
          (row) =>
              OncologyTumorBoardCase.fromJson(Map<String, dynamic>.from(row)),
        )
        .toList(growable: false);
  }

  @override
  Future<List<OncologyToxicityEvent>> fetchToxicityEvents() async {
    final response = await ApiClient.get(
      '/oncology/toxicity-events',
      queryParameters: const {'limit': '25'},
    );
    final data = _dataOrThrow(response, 'Could not load toxicity events');
    final rows = data['toxicity_events'] as List? ?? const [];
    return rows
        .whereType<Map>()
        .map(
          (row) =>
              OncologyToxicityEvent.fromJson(Map<String, dynamic>.from(row)),
        )
        .toList(growable: false);
  }

  @override
  Future<OncologyToxicityEvent> createToxicityEvent(
    OncologyToxicityInput input,
  ) async {
    final response = await ApiClient.post(
      '/oncology/toxicity-events',
      body: input.toJson(),
      idempotencyKey: IdempotencyKey.generate(),
    );
    final data = _dataOrThrow(response, 'Could not save toxicity event');
    final row = data['toxicity_event'] as Map? ?? const {};
    return OncologyToxicityEvent.fromJson(Map<String, dynamic>.from(row));
  }
}

class OncologyScreen extends StatefulWidget {
  const OncologyScreen({super.key, OncologyApiClient? apiClient})
    : apiClient = apiClient ?? const HttpOncologyApiClient();

  final OncologyApiClient apiClient;

  @override
  State<OncologyScreen> createState() => _OncologyScreenState();
}

class _OncologyScreenState extends State<OncologyScreen> {
  var _loading = true;
  var _saving = false;
  String? _error;
  List<OncologyTumorBoardCase> _queue = const [];
  List<OncologyToxicityEvent> _toxicity = const [];

  final _patientUid = TextEditingController();
  final _diagnosisId = TextEditingController();
  final _term = TextEditingController();
  final _source = TextEditingController();
  final _sourceVersion = TextEditingController();
  final _cycleId = TextEditingController();
  final _administrationId = TextEditingController();
  var _grade = 2;
  var _action = 'monitor';
  var _signoff = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _patientUid.dispose();
    _diagnosisId.dispose();
    _term.dispose();
    _source.dispose();
    _sourceVersion.dispose();
    _cycleId.dispose();
    _administrationId.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait([
        widget.apiClient.fetchTumorBoardQueue(),
        widget.apiClient.fetchToxicityEvents(),
      ]);
      if (!mounted) return;
      setState(() {
        _queue = results[0] as List<OncologyTumorBoardCase>;
        _toxicity = results[1] as List<OncologyToxicityEvent>;
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

  Future<void> _saveToxicity() async {
    final s = AppStrings.of(context);
    if (_patientUid.text.trim().isEmpty ||
        _term.text.trim().isEmpty ||
        (_signoff &&
            (_source.text.trim().isEmpty ||
                _sourceVersion.text.trim().isEmpty))) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.lookup('s4.lib.oncology.required_fields'))),
      );
      return;
    }

    setState(() => _saving = true);
    try {
      await widget.apiClient.createToxicityEvent(
        OncologyToxicityInput(
          patientUid: _patientUid.text.trim(),
          diagnosisId: int.tryParse(_diagnosisId.text.trim()),
          term: _term.text.trim(),
          grade: _grade,
          source: _source.text.trim(),
          sourceVersion: _sourceVersion.text.trim(),
          actionTaken: _action,
          chemoCycleId: int.tryParse(_cycleId.text.trim()),
          chemoAdministrationId: int.tryParse(_administrationId.text.trim()),
          signoff: _signoff,
        ),
      );
      _term.clear();
      _diagnosisId.clear();
      _cycleId.clear();
      _administrationId.clear();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.lookup('s4.lib.oncology.toxicity_saved'))),
      );
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        backgroundColor: AppTheme.backgroundGrey,
        appBar: AppBar(
          leading: const NavigationBackAction(),
          title: Text(s.lookup('s4.lib.oncology.title')),
          actions: [
            IconButton(
              onPressed: _load,
              icon: const Icon(Icons.refresh),
              tooltip: s.lookup('action.refresh'),
            ),
            const LogoutAction(),
          ],
          bottom: TabBar(
            tabs: [
              Tab(text: s.lookup('s4.lib.oncology.tumor_board')),
              Tab(text: s.lookup('s4.lib.oncology.toxicity')),
            ],
          ),
        ),
        body: _body(s),
      ),
    );
  }

  Widget _body(AppStrings s) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.error_outline,
                color: AppTheme.errorRed,
                size: 44,
              ),
              const SizedBox(height: 12),
              Text(_error!, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              ElevatedButton.icon(
                onPressed: _load,
                icon: const Icon(Icons.refresh),
                label: Text(s.actionRetry),
              ),
            ],
          ),
        ),
      );
    }

    return TabBarView(
      children: [
        RefreshIndicator(
          onRefresh: _load,
          child: _queue.isEmpty
              ? _emptyList(s.lookup('s4.lib.oncology.no_cases'))
              : ListView.separated(
                  padding: const EdgeInsets.all(16),
                  itemCount: _queue.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 12),
                  itemBuilder: (context, index) => _caseCard(_queue[index], s),
                ),
        ),
        RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              _toxicityForm(s),
              const SizedBox(height: 16),
              if (_toxicity.isEmpty)
                _emptyPanel(s.lookup('s4.lib.oncology.no_toxicity'))
              else
                ..._toxicity.map(
                  (event) => Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: _toxicityCard(event, s),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _emptyList(String label) {
    return ListView(
      children: [const SizedBox(height: 120), _emptyPanel(label)],
    );
  }

  Widget _emptyPanel(String label) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.assignment_outlined, size: 56, color: Colors.grey),
          const SizedBox(height: 10),
          Text(label, style: const TextStyle(color: Colors.grey)),
        ],
      ),
    );
  }

  Widget _caseCard(OncologyTumorBoardCase row, AppStrings s) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    row.cancerSite,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                _chip(row.priority),
                const SizedBox(width: 8),
                _chip(row.discussionState.replaceAll('_', ' ')),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              row.patientLabel,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            if (row.tnmLabel.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                row.tnmLabel,
                style: TextStyle(color: AppTheme.textSecondary),
              ),
            ],
            const SizedBox(height: 10),
            Text(row.question),
          ],
        ),
      ),
    );
  }

  Widget _toxicityForm(AppStrings s) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.lookup('s4.lib.oncology.capture_toxicity'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 12),
            _field(_patientUid, s.lookup('s4.lib.oncology.patient_uid')),
            _field(
              _diagnosisId,
              s.lookup('s4.lib.oncology.diagnosis_id'),
              number: true,
            ),
            _field(_term, s.lookup('s4.lib.oncology.toxicity_term')),
            Row(
              children: [
                Expanded(
                  child: DropdownButtonFormField<int>(
                    initialValue: _grade,
                    decoration: InputDecoration(
                      labelText: s.lookup('s4.lib.oncology.ctcae_grade'),
                    ),
                    items: [1, 2, 3, 4, 5]
                        .map(
                          (grade) => DropdownMenuItem(
                            value: grade,
                            child: Text('$grade'),
                          ),
                        )
                        .toList(),
                    onChanged: (value) => setState(() => _grade = value ?? 2),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: DropdownButtonFormField<String>(
                    initialValue: _action,
                    decoration: InputDecoration(
                      labelText: s.lookup('s4.lib.oncology.action_taken'),
                    ),
                    items:
                        const [
                              'monitor',
                              'supportive_care',
                              'dose_delay',
                              'dose_reduce',
                              'withhold',
                              'stop',
                              'admit',
                              'other',
                            ]
                            .map(
                              (action) => DropdownMenuItem(
                                value: action,
                                child: Text(action.replaceAll('_', ' ')),
                              ),
                            )
                            .toList(),
                    onChanged: (value) =>
                        setState(() => _action = value ?? 'monitor'),
                  ),
                ),
              ],
            ),
            _field(_source, s.lookup('s4.lib.oncology.ctcae_source')),
            _field(_sourceVersion, s.lookup('s4.lib.oncology.ctcae_version')),
            _field(
              _cycleId,
              s.lookup('s4.lib.oncology.chemo_cycle_id'),
              number: true,
            ),
            _field(
              _administrationId,
              s.lookup('s4.lib.oncology.chemo_admin_id'),
              number: true,
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: _signoff,
              title: Text(s.lookup('s4.lib.oncology.signoff')),
              onChanged: (value) => setState(() => _signoff = value),
            ),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                onPressed: _saving ? null : _saveToxicity,
                icon: _saving
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.save_outlined),
                label: Text(
                  _saving
                      ? s.lookup('s4.lib.oncology.saving')
                      : s.lookup('s4.lib.oncology.save_toxicity'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _toxicityCard(OncologyToxicityEvent event, AppStrings s) {
    return Card(
      child: ListTile(
        leading: CircleAvatar(child: Text('${event.grade}')),
        title: Text(event.term),
        subtitle: Text(
          '${event.patientLabel}\n${event.source ?? ''} ${event.sourceVersion ?? ''}'
              .trim(),
        ),
        isThreeLine: true,
        trailing: _chip(event.signoffStatus),
      ),
    );
  }

  Widget _field(
    TextEditingController controller,
    String label, {
    bool number = false,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextField(
        controller: controller,
        keyboardType: number ? TextInputType.number : TextInputType.text,
        decoration: InputDecoration(labelText: label),
      ),
    );
  }

  Widget _chip(String label) {
    return Chip(label: Text(label), visualDensity: VisualDensity.compact);
  }
}
