import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/services/patient_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/patient_identity.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';
import '../models/dental_models.dart';
import '../services/dental_api_service.dart';
import '../widgets/dental_entry_forms.dart';
import '../widgets/odontogram_grid.dart';

class DentalScreen extends StatefulWidget {
  final String? initialPatientUid;
  final String? initialPatientName;
  final DentalApiService service;

  const DentalScreen({
    super.key,
    this.initialPatientUid,
    this.initialPatientName,
    this.service = const DentalApiService(),
  });

  @override
  State<DentalScreen> createState() => _DentalScreenState();
}

class _DentalScreenState extends State<DentalScreen> {
  final _searchController = TextEditingController();
  Timer? _searchDebounce;
  Map<String, dynamic>? _patient;
  List<Map<String, dynamic>> _searchResults = const [];
  DentalChart? _chart;
  List<DentalProcedure> _procedures = const [];
  String? _selectedTooth;
  bool _loading = false;
  bool _searching = false;
  String? _error;
  String? _searchError;

  String get _patientUid {
    return patientUidFrom(_patient);
  }

  String get _patientName {
    return patientNameFrom(_patient, fallback: '');
  }

  @override
  void initState() {
    super.initState();
    final initialUid = widget.initialPatientUid?.trim();
    if (initialUid != null && initialUid.isNotEmpty) {
      _patient = {
        'uid': initialUid,
        if (widget.initialPatientName?.trim().isNotEmpty == true)
          'name': widget.initialPatientName!.trim(),
      };
      unawaited(_loadDentalChart());
    }
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _loadDentalChart() async {
    final uid = _patientUid;
    if (uid.isEmpty) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final chart = await widget.service.getChart(uid);
      final procedures = await widget.service.listProcedures(uid);
      if (!mounted) return;
      setState(() {
        _chart = chart;
        _procedures = procedures;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  void _onSearchChanged(String value) {
    _searchDebounce?.cancel();
    final query = value.trim();
    if (!patientLookupQueryReady(query)) {
      setState(() {
        _searchResults = const [];
        _searchError = null;
        _searching = false;
      });
      return;
    }
    _searchDebounce = Timer(
      const Duration(milliseconds: 300),
      () => _runPatientSearch(query),
    );
  }

  Future<void> _runPatientSearch(String query) async {
    setState(() {
      _searching = true;
      _searchError = null;
    });
    try {
      final results = (await PatientApiService.search(query))
          .where((patient) => patientMatchesLookupQuery(patient, query))
          .toList(growable: false);
      if (!mounted) return;
      setState(() {
        _searchResults = results;
        _searching = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _searchError = e.toString().replaceFirst('Exception: ', '');
        _searching = false;
      });
    }
  }

  Future<void> _selectPatient(Map<String, dynamic> patient) async {
    setState(() {
      _patient = patient;
      _searchResults = const [];
      _searchController.clear();
      _selectedTooth = null;
      _chart = null;
      _procedures = const [];
    });
    await _loadDentalChart();
  }

  Future<void> _openFindingForm({String? tooth}) async {
    final uid = _patientUid;
    if (uid.isEmpty) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppTheme.cardSurface,
      builder: (context) => Padding(
        padding: EdgeInsets.fromLTRB(
          20,
          20,
          20,
          20 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: DentalFindingEntryForm(
          initialTooth: tooth ?? _selectedTooth ?? '',
          onSubmit: (draft) async {
            await widget.service.recordFinding(patientUid: uid, draft: draft);
            if (context.mounted) Navigator.of(context).pop();
            await _loadDentalChart();
            if (mounted) setState(() => _selectedTooth = draft.toothFdi);
          },
        ),
      ),
    );
  }

  Future<void> _openProcedureForm({
    String? tooth,
    DentalFinding? finding,
  }) async {
    final uid = _patientUid;
    if (uid.isEmpty) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppTheme.cardSurface,
      builder: (context) => Padding(
        padding: EdgeInsets.fromLTRB(
          20,
          20,
          20,
          20 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: DentalProcedureEntryForm(
          initialTooth: tooth ?? _selectedTooth,
          linkedFinding: finding,
          onSubmit: (draft) async {
            await widget.service.planProcedure(patientUid: uid, draft: draft);
            if (context.mounted) Navigator.of(context).pop();
            await _loadDentalChart();
          },
        ),
      ),
    );
  }

  Future<void> _completeProcedure(DentalProcedure procedure) async {
    final s = AppStrings.of(context);
    final materials = TextEditingController();
    final anesthesia = TextEditingController(text: procedure.anesthesia ?? '');
    final notes = TextEditingController();
    try {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(s.lookup('dental.complete_procedure')),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Align(
                  alignment: Alignment.centerLeft,
                  child: Text(procedure.procedureName),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: materials,
                  decoration: InputDecoration(
                    labelText: s.lookup('dental.materials'),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: anesthesia,
                  decoration: InputDecoration(
                    labelText: s.lookup('dental.anesthesia'),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: notes,
                  decoration: InputDecoration(
                    labelText: s.lookup('dental.notes'),
                  ),
                  minLines: 2,
                  maxLines: 4,
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: Text(s.lookup('dental.complete')),
            ),
          ],
        ),
      );
      if (confirmed != true) return;
      await widget.service.completeProcedure(
        procedureId: procedure.id,
        materials: materials.text,
        anesthesia: anesthesia.text,
        notes: notes.text,
      );
      await _loadDentalChart();
    } finally {
      materials.dispose();
      anesthesia.dispose();
      notes.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.lookup('dental.title'),
      body: RefreshIndicator(
        onRefresh: _loadDentalChart,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _buildPatientPanel(s),
            if (_patientUid.isNotEmpty) ...[
              const SizedBox(height: 14),
              _buildChartPanel(s),
              const SizedBox(height: 14),
              _buildSelectedToothPanel(s),
              const SizedBox(height: 14),
              _buildHistoryPanel(s),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildPatientPanel(AppStrings s) {
    final hasPatient = _patientUid.isNotEmpty;
    return _Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Icon(Icons.person_search_outlined),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  hasPatient
                      ? s.lookup('dental.selected_patient')
                      : s.lookup('dental.select_patient'),
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              if (hasPatient)
                TextButton.icon(
                  onPressed: () {
                    setState(() {
                      _patient = null;
                      _chart = null;
                      _procedures = const [];
                      _selectedTooth = null;
                    });
                  },
                  icon: const Icon(Icons.close),
                  label: Text(s.lookup('dental.clear_patient')),
                ),
            ],
          ),
          const SizedBox(height: 12),
          if (hasPatient)
            Text(
              [
                if (_patientName.isNotEmpty) _patientName,
                _patientUid,
              ].join(' - '),
              style: Theme.of(context).textTheme.bodyLarge,
            )
          else ...[
            TextField(
              controller: _searchController,
              decoration: InputDecoration(
                hintText: s.lookup('dental.search_hint'),
                prefixIcon: const Icon(Icons.search),
              ),
              onChanged: _onSearchChanged,
              onSubmitted: (value) => _runPatientSearch(value.trim()),
            ),
            if (_searching)
              const Padding(
                padding: EdgeInsets.only(top: 16),
                child: LinearProgressIndicator(),
              ),
            if (_searchError != null) ...[
              const SizedBox(height: 12),
              Text(
                _searchError!,
                style: const TextStyle(color: AppTheme.errorRed),
              ),
            ],
            if (_searchResults.isNotEmpty) ...[
              const SizedBox(height: 12),
              for (final patient in _searchResults)
                ListTile(
                  key: ValueKey('dental-patient-${patientUidFrom(patient)}'),
                  leading: const Icon(Icons.person_outline),
                  title: Text(patientNameFrom(patient)),
                  subtitle: Text(
                    patientSubtitle(patient, includeAgeGender: true),
                  ),
                  onTap: () => _selectPatient(patient),
                ),
            ],
          ],
        ],
      ),
    );
  }

  Widget _buildChartPanel(AppStrings s) {
    return _Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  s.lookup('dental.odontogram'),
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              IconButton(
                tooltip: s.actionRefresh,
                onPressed: _loading ? null : _loadDentalChart,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (_loading)
            const Center(
              child: Padding(
                padding: EdgeInsets.all(32),
                child: CircularProgressIndicator(),
              ),
            )
          else if (_error != null)
            _ErrorBlock(message: _error!, onRetry: _loadDentalChart)
          else ...[
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                _StatChip(
                  label: s.lookup('dental.active_findings'),
                  value: '${_chart?.activeFindingCount ?? 0}',
                  icon: Icons.warning_amber_outlined,
                ),
                _StatChip(
                  label: s.lookup('dental.procedures'),
                  value: '${_procedures.length}',
                  icon: Icons.medical_services_outlined,
                ),
              ],
            ),
            const SizedBox(height: 14),
            OdontogramGrid(
              chart: _chart,
              selectedTooth: _selectedTooth,
              onToothSelected: (tooth) =>
                  setState(() => _selectedTooth = tooth),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                FilledButton.icon(
                  key: const ValueKey('dental-add-finding'),
                  onPressed: () => _openFindingForm(),
                  icon: const Icon(Icons.add),
                  label: Text(s.lookup('dental.add_finding')),
                ),
                OutlinedButton.icon(
                  onPressed: () => _openProcedureForm(),
                  icon: const Icon(Icons.add_task_outlined),
                  label: Text(s.lookup('dental.plan_procedure')),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildSelectedToothPanel(AppStrings s) {
    final tooth = _selectedTooth;
    if (tooth == null || tooth.isEmpty) {
      return _Panel(
        child: Text(
          s.lookup('dental.select_tooth_hint'),
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      );
    }
    final summary = _chart?.summaryFor(tooth) ?? const DentalToothSummary();
    return _Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  s.format('dental.tooth_value', {'tooth': tooth}),
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              TextButton.icon(
                onPressed: () => _openFindingForm(tooth: tooth),
                icon: const Icon(Icons.add),
                label: Text(s.lookup('dental.add_finding')),
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (summary.findings.isEmpty && summary.procedures.isEmpty)
            Text(s.lookup('dental.tooth_no_history'))
          else ...[
            for (final finding in summary.findings)
              _FindingTile(
                finding: finding,
                onPlan: () => _openProcedureForm(
                  tooth: finding.toothFdi,
                  finding: finding,
                ),
              ),
            for (final procedure in summary.procedures)
              _ProcedureTile(
                procedure: procedure,
                onComplete: _canComplete(procedure)
                    ? () => _completeProcedure(procedure)
                    : null,
              ),
          ],
        ],
      ),
    );
  }

  Widget _buildHistoryPanel(AppStrings s) {
    final activeFindings =
        _chart?.teeth.values
            .expand((summary) => summary.findings)
            .toList(growable: false) ??
        const <DentalFinding>[];
    return _Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            s.lookup('dental.patient_history'),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 12),
          if (activeFindings.isEmpty)
            Text(s.lookup('dental.no_active_findings'))
          else
            for (final finding in activeFindings)
              _FindingTile(
                finding: finding,
                onPlan: () => _openProcedureForm(
                  tooth: finding.toothFdi,
                  finding: finding,
                ),
              ),
          const Divider(height: 28),
          if (_procedures.isEmpty)
            Text(s.lookup('dental.no_procedures'))
          else
            for (final procedure in _procedures)
              _ProcedureTile(
                procedure: procedure,
                onComplete: _canComplete(procedure)
                    ? () => _completeProcedure(procedure)
                    : null,
              ),
        ],
      ),
    );
  }

  bool _canComplete(DentalProcedure procedure) {
    final status = procedure.status.toLowerCase();
    return status == 'planned' || status == 'in_progress';
  }
}

class _Panel extends StatelessWidget {
  final Widget child;

  const _Panel({required this.child});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      padding: const EdgeInsets.all(16),
      child: child,
    );
  }
}

class _StatChip extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;

  const _StatChip({
    required this.label,
    required this.value,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    return Chip(avatar: Icon(icon, size: 18), label: Text('$label: $value'));
  }
}

class _FindingTile extends StatelessWidget {
  final DentalFinding finding;
  final VoidCallback onPlan;

  const _FindingTile({required this.finding, required this.onPlan});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: const Icon(
        Icons.warning_amber_outlined,
        color: AppTheme.errorRed,
      ),
      title: Text(
        '${dentalLabel(finding.finding)} - ${s.format('dental.tooth_value', {'tooth': finding.toothFdi})}',
      ),
      subtitle: Text(
        [
          if (finding.surface != null) dentalLabel(finding.surface!),
          if (finding.severity != null) finding.severity!,
          if (finding.notes != null) finding.notes!,
        ].join(' - '),
      ),
      trailing: TextButton.icon(
        onPressed: onPlan,
        icon: const Icon(Icons.add_task_outlined),
        label: Text(s.lookup('dental.plan')),
      ),
    );
  }
}

class _ProcedureTile extends StatelessWidget {
  final DentalProcedure procedure;
  final VoidCallback? onComplete;

  const _ProcedureTile({required this.procedure, this.onComplete});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final details = [
      if (procedure.toothFdi != null)
        s.format('dental.tooth_value', {'tooth': procedure.toothFdi!}),
      if (procedure.procedureCode != null) procedure.procedureCode!,
      dentalLabel(procedure.status),
    ].join(' - ');
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.medical_services_outlined),
      title: Text(procedure.procedureName),
      subtitle: Text(details),
      trailing: onComplete == null
          ? null
          : TextButton.icon(
              key: ValueKey('dental-complete-${procedure.id}'),
              onPressed: onComplete,
              icon: const Icon(Icons.done_all),
              label: Text(s.lookup('dental.complete')),
            ),
    );
  }
}

class _ErrorBlock extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorBlock({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Column(
      children: [
        const Icon(Icons.error_outline, color: AppTheme.errorRed),
        const SizedBox(height: 8),
        Text(message, textAlign: TextAlign.center),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: onRetry,
          icon: const Icon(Icons.refresh),
          label: Text(s.actionRetry),
        ),
      ],
    );
  }
}
