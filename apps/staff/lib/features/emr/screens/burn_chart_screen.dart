import 'package:flutter/material.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

class BurnChartScreen extends StatefulWidget {
  final String patientUid;
  final String? patientName;
  final int? admissionId;
  final int? emergencyVisitId;
  final int? mlcRecordId;

  const BurnChartScreen({
    super.key,
    required this.patientUid,
    this.patientName,
    this.admissionId,
    this.emergencyVisitId,
    this.mlcRecordId,
  });

  @override
  State<BurnChartScreen> createState() => _BurnChartScreenState();
}

class _BurnChartScreenState extends State<BurnChartScreen> {
  final _mechanismCtrl = TextEditingController();
  final _firstAidCtrl = TextEditingController();
  final _edVisitCtrl = TextEditingController();
  final _admissionCtrl = TextEditingController();
  final _mlcCtrl = TextEditingController();
  final _tbsaReferenceCtrl = TextEditingController();
  final _regions = <_BurnRegionEntry>[_BurnRegionEntry()];

  bool _loading = true;
  bool _savingChart = false;
  bool _savingTbsa = false;
  bool _inhalationRisk = false;
  bool _circumferentialBurns = false;
  String? _error;
  Map<String, dynamic>? _chart;
  double? _lastTbsa;

  int? get _chartId {
    final raw = _chart?['id'];
    return raw is int ? raw : int.tryParse('${raw ?? ''}');
  }

  @override
  void initState() {
    super.initState();
    _edVisitCtrl.text = widget.emergencyVisitId?.toString() ?? '';
    _admissionCtrl.text = widget.admissionId?.toString() ?? '';
    _mlcCtrl.text = widget.mlcRecordId?.toString() ?? '';
    _loadExistingChart();
  }

  @override
  void dispose() {
    _mechanismCtrl.dispose();
    _firstAidCtrl.dispose();
    _edVisitCtrl.dispose();
    _admissionCtrl.dispose();
    _mlcCtrl.dispose();
    _tbsaReferenceCtrl.dispose();
    for (final region in _regions) {
      region.dispose();
    }
    super.dispose();
  }

  Future<void> _loadExistingChart() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await MedicalApiService.getBurnCharts(
        patientUid: widget.patientUid,
        admissionId: widget.admissionId,
        emergencyVisitId: widget.emergencyVisitId,
        mlcRecordId: widget.mlcRecordId,
        limit: 1,
      );
      final list = data['data'];
      if (list is List && list.isNotEmpty && list.first is Map) {
        final chart = Map<String, dynamic>.from(list.first as Map);
        if (!mounted) return;
        setState(() {
          _chart = chart;
          _mechanismCtrl.text = '${chart['mechanism'] ?? ''}';
          _firstAidCtrl.text = '${chart['first_aid'] ?? ''}';
          _inhalationRisk = chart['inhalation_risk'] == true;
          _circumferentialBurns = chart['circumferential_burns'] == true;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  int? _intFrom(TextEditingController ctrl) {
    final text = ctrl.text.trim();
    if (text.isEmpty) return null;
    return int.tryParse(text);
  }

  bool _hasContextLink() =>
      _intFrom(_edVisitCtrl) != null ||
      _intFrom(_admissionCtrl) != null ||
      _intFrom(_mlcCtrl) != null;

  Future<void> _saveChart() async {
    final s = AppStrings.of(context);
    final mechanism = _mechanismCtrl.text.trim();
    if (mechanism.isEmpty) {
      _toast(s.burnCareMechanismRequired);
      return;
    }
    if (!_hasContextLink()) {
      _toast(s.burnCareContextRequired);
      return;
    }
    setState(() {
      _savingChart = true;
      _error = null;
    });
    try {
      final chart = await MedicalApiService.createBurnChart(
        patientUid: widget.patientUid,
        emergencyVisitId: _intFrom(_edVisitCtrl),
        admissionId: _intFrom(_admissionCtrl),
        mlcRecordId: _intFrom(_mlcCtrl),
        mechanism: mechanism,
        firstAid: _firstAidCtrl.text,
        inhalationRisk: _inhalationRisk,
        circumferentialBurns: _circumferentialBurns,
      );
      if (!mounted) return;
      setState(() => _chart = chart);
      _toast(s.burnCareChartSaved);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _savingChart = false);
    }
  }

  List<Map<String, dynamic>> _regionPayload() {
    return _regions
        .map((region) => region.toPayload())
        .where((payload) => payload != null)
        .cast<Map<String, dynamic>>()
        .toList();
  }

  Future<void> _saveTbsa() async {
    final s = AppStrings.of(context);
    final chartId = _chartId;
    if (chartId == null) {
      _toast(s.burnCareOpenChartFirst);
      return;
    }
    final referenceKey = _tbsaReferenceCtrl.text.trim();
    if (referenceKey.isEmpty) {
      _toast(s.burnCareReferenceRequired);
      return;
    }
    final regions = _regionPayload();
    if (regions.isEmpty) {
      _toast(s.burnCareRegionRequired);
      return;
    }
    setState(() {
      _savingTbsa = true;
      _error = null;
    });
    try {
      final result = await MedicalApiService.recordBurnTbsaRegions(
        burnChartId: chartId,
        referenceKey: referenceKey,
        regions: regions,
      );
      final total = double.tryParse('${result['tbsa_percent'] ?? ''}');
      if (!mounted) return;
      setState(() => _lastTbsa = total);
      _toast(s.burnCareTbsaSaved);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _savingTbsa = false);
    }
  }

  void _toast(String message) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  void _addRegion([_RegionTemplate? template]) {
    setState(() => _regions.add(_BurnRegionEntry.fromTemplate(template)));
  }

  void _removeRegion(int index) {
    if (_regions.length == 1) {
      _regions.first.clear();
      setState(() {});
      return;
    }
    final removed = _regions.removeAt(index);
    removed.dispose();
    setState(() {});
  }

  double get _draftTbsa {
    var total = 0.0;
    for (final region in _regions) {
      total += region.selectedPercent;
    }
    return total;
  }

  List<_RegionTemplate> _regionTemplates(AppStrings s) => [
    _RegionTemplate('head_neck', s.burnCareRegionHeadNeck),
    _RegionTemplate('anterior_trunk', s.burnCareRegionAnteriorTrunk),
    _RegionTemplate('posterior_trunk', s.burnCareRegionPosteriorTrunk),
    _RegionTemplate('right_arm', s.burnCareRegionRightArm),
    _RegionTemplate('left_arm', s.burnCareRegionLeftArm),
    _RegionTemplate('right_leg', s.burnCareRegionRightLeg),
    _RegionTemplate('left_leg', s.burnCareRegionLeftLeg),
    _RegionTemplate('perineum', s.burnCareRegionPerineum),
  ];

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final title = widget.patientName == null || widget.patientName!.isEmpty
        ? s.burnCareTitle
        : s.burnCareTitleWithName(widget.patientName!);
    return StaffScaffold(
      title: title,
      actions: [
        IconButton(
          tooltip: s.actionRefresh,
          onPressed: _loading ? null : _loadExistingChart,
          icon: const Icon(Icons.refresh),
        ),
      ],
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _patientBanner(s),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  _errorBanner(s),
                ],
                const SizedBox(height: 12),
                _chartPanel(s),
                const SizedBox(height: 12),
                _tbsaPanel(s),
              ],
            ),
    );
  }

  Widget _patientBanner(AppStrings s) {
    final chartId = _chartId;
    return Material(
      color: AppTheme.primaryBlue.withValues(alpha: 0.08),
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Wrap(
          spacing: 8,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Chip(
              avatar: const Icon(Icons.person_outline, size: 18),
              label: Text(widget.patientName ?? widget.patientUid),
            ),
            Chip(
              avatar: const Icon(
                Icons.local_fire_department_outlined,
                size: 18,
              ),
              label: Text(
                chartId == null
                    ? s.burnCareChartNotOpen
                    : s.burnCareChartNumber(chartId),
              ),
            ),
            Chip(
              avatar: const Icon(Icons.percent, size: 18),
              label: Text(s.burnCareDraftTbsa(_draftTbsa.toStringAsFixed(1))),
            ),
            if (_lastTbsa != null)
              Chip(
                avatar: const Icon(Icons.verified_outlined, size: 18),
                label: Text(s.burnCareSavedTbsa(_lastTbsa!.toStringAsFixed(1))),
              ),
          ],
        ),
      ),
    );
  }

  Widget _errorBanner(AppStrings s) {
    return Material(
      color: Theme.of(context).colorScheme.errorContainer,
      borderRadius: BorderRadius.circular(8),
      child: ListTile(
        leading: const Icon(Icons.error_outline),
        title: Text(s.burnCareCouldNotSave),
        subtitle: Text(_error ?? ''),
      ),
    );
  }

  Widget _chartPanel(AppStrings s) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _sectionHeader(s.burnCareChartSection, Icons.assignment_outlined),
            const SizedBox(height: 12),
            LayoutBuilder(
              builder: (context, constraints) {
                final narrow = constraints.maxWidth < 680;
                final fields = [
                  _smallNumberField(_edVisitCtrl, s.burnCareEmergencyVisitId),
                  _smallNumberField(_admissionCtrl, s.burnCareAdmissionId),
                  _smallNumberField(_mlcCtrl, s.burnCareMlcRecordId),
                ];
                return narrow
                    ? Column(
                        children: fields
                            .map(
                              (field) => Padding(
                                padding: const EdgeInsets.only(bottom: 10),
                                child: field,
                              ),
                            )
                            .toList(),
                      )
                    : Row(
                        children: fields
                            .map(
                              (field) => Expanded(
                                child: Padding(
                                  padding: const EdgeInsets.only(right: 10),
                                  child: field,
                                ),
                              ),
                            )
                            .toList(),
                      );
              },
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _mechanismCtrl,
              decoration: InputDecoration(
                labelText: s.burnCareMechanism,
                prefixIcon: const Icon(Icons.local_fire_department_outlined),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _firstAidCtrl,
              minLines: 2,
              maxLines: 4,
              decoration: InputDecoration(
                labelText: s.burnCareFirstAid,
                prefixIcon: const Icon(Icons.health_and_safety_outlined),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 10,
              runSpacing: 8,
              children: [
                FilterChip(
                  selected: _inhalationRisk,
                  avatar: const Icon(Icons.air, size: 18),
                  label: Text(s.burnCareInhalationRisk),
                  onSelected: (value) =>
                      setState(() => _inhalationRisk = value),
                ),
                FilterChip(
                  selected: _circumferentialBurns,
                  avatar: const Icon(Icons.all_inclusive, size: 18),
                  label: Text(s.burnCareCircumferential),
                  onSelected: (value) =>
                      setState(() => _circumferentialBurns = value),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton.icon(
                onPressed: _savingChart ? null : _saveChart,
                icon: _savingChart
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.save_outlined),
                label: Text(
                  _savingChart ? s.burnCareSaving : s.burnCareOpenChart,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _tbsaPanel(AppStrings s) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _sectionHeader(s.burnCareTbsaSection, Icons.accessibility_new),
            const SizedBox(height: 12),
            TextField(
              controller: _tbsaReferenceCtrl,
              decoration: InputDecoration(
                labelText: s.burnCareReferenceKey,
                prefixIcon: const Icon(Icons.policy_outlined),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: _regionTemplates(s)
                  .map(
                    (template) => ActionChip(
                      avatar: const Icon(Icons.add, size: 18),
                      label: Text(template.label),
                      onPressed: () => _addRegion(template),
                    ),
                  )
                  .toList(),
            ),
            const SizedBox(height: 12),
            for (var i = 0; i < _regions.length; i++) ...[
              _regionEditor(s, _regions[i], i),
              if (i != _regions.length - 1) const SizedBox(height: 10),
            ],
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: Text(
                    s.burnCareDraftTbsa(_draftTbsa.toStringAsFixed(1)),
                    style: Theme.of(context).textTheme.titleMedium
                        ?.copyWith(fontWeight: FontWeight.w800),
                  ),
                ),
                FilledButton.icon(
                  onPressed: _savingTbsa ? null : _saveTbsa,
                  icon: _savingTbsa
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.fact_check_outlined),
                  label: Text(
                    _savingTbsa ? s.burnCareSaving : s.burnCareSaveTbsa,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _sectionHeader(String title, IconData icon) {
    return Row(
      children: [
        Icon(icon, color: AppTheme.primaryBlue),
        const SizedBox(width: 8),
        Text(
          title,
          style: Theme.of(context).textTheme.titleMedium
              ?.copyWith(fontWeight: FontWeight.w800),
        ),
      ],
    );
  }

  Widget _smallNumberField(TextEditingController ctrl, String label) {
    return TextField(
      controller: ctrl,
      keyboardType: TextInputType.number,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
        isDense: true,
      ),
    );
  }

  Widget _regionEditor(AppStrings s, _BurnRegionEntry entry, int index) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).dividerColor),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: entry.labelCtrl,
                  decoration: InputDecoration(
                    labelText: s.burnCareRegionLabel,
                    border: const OutlineInputBorder(),
                    isDense: true,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              IconButton(
                tooltip: s.burnCareRemoveRegion,
                onPressed: () => _removeRegion(index),
                icon: const Icon(Icons.delete_outline),
              ),
            ],
          ),
          const SizedBox(height: 10),
          LayoutBuilder(
            builder: (context, constraints) {
              final narrow = constraints.maxWidth < 620;
              final children = [
                _regionCodeField(s, entry),
                _depthDropdown(s, entry),
                _percentField(
                  entry.areaCtrl,
                  s.burnCareAreaPercent,
                  onChanged: (_) => setState(() {}),
                ),
                _percentField(
                  entry.overrideCtrl,
                  s.burnCareOverridePercent,
                  onChanged: (_) => setState(() {}),
                ),
              ];
              if (narrow) {
                return Column(
                  children: children
                      .map(
                        (child) => Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: child,
                        ),
                      )
                      .toList(),
                );
              }
              return Row(
                children: children
                    .map(
                      (child) => Expanded(
                        child: Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: child,
                        ),
                      ),
                    )
                    .toList(),
              );
            },
          ),
          const SizedBox(height: 10),
          TextField(
            controller: entry.overrideReasonCtrl,
            decoration: InputDecoration(
              labelText: s.burnCareOverrideReason,
              border: const OutlineInputBorder(),
              isDense: true,
            ),
          ),
        ],
      ),
    );
  }

  Widget _regionCodeField(AppStrings s, _BurnRegionEntry entry) {
    return TextField(
      controller: entry.codeCtrl,
      decoration: InputDecoration(
        labelText: s.burnCareRegionCode,
        border: const OutlineInputBorder(),
        isDense: true,
      ),
    );
  }

  Widget _depthDropdown(AppStrings s, _BurnRegionEntry entry) {
    return DropdownButtonFormField<String>(
      initialValue: entry.depth,
      decoration: InputDecoration(
        labelText: s.burnCareDepth,
        border: const OutlineInputBorder(),
        isDense: true,
      ),
      items: [
        DropdownMenuItem(
          value: 'superficial',
          child: Text(s.burnCareDepthSuperficial),
        ),
        DropdownMenuItem(
          value: 'partial_thickness',
          child: Text(s.burnCareDepthPartial),
        ),
        DropdownMenuItem(
          value: 'deep_partial',
          child: Text(s.burnCareDepthDeepPartial),
        ),
        DropdownMenuItem(
          value: 'full_thickness',
          child: Text(s.burnCareDepthFull),
        ),
        DropdownMenuItem(value: 'mixed', child: Text(s.burnCareDepthMixed)),
        DropdownMenuItem(value: 'unknown', child: Text(s.burnCareDepthUnknown)),
      ],
      onChanged: (value) => setState(() => entry.depth = value ?? 'unknown'),
    );
  }

  Widget _percentField(
    TextEditingController ctrl,
    String label, {
    required ValueChanged<String> onChanged,
  }) {
    return TextField(
      controller: ctrl,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      onChanged: onChanged,
      decoration: InputDecoration(
        labelText: label,
        suffixText: '%',
        border: const OutlineInputBorder(),
        isDense: true,
      ),
    );
  }
}

class _RegionTemplate {
  final String code;
  final String label;

  const _RegionTemplate(this.code, this.label);
}

class _BurnRegionEntry {
  final TextEditingController codeCtrl;
  final TextEditingController labelCtrl;
  final TextEditingController areaCtrl;
  final TextEditingController overrideCtrl;
  final TextEditingController overrideReasonCtrl;
  String depth = 'unknown';

  _BurnRegionEntry({String code = '', String label = ''})
    : codeCtrl = TextEditingController(text: code),
      labelCtrl = TextEditingController(text: label),
      areaCtrl = TextEditingController(),
      overrideCtrl = TextEditingController(),
      overrideReasonCtrl = TextEditingController();

  factory _BurnRegionEntry.fromTemplate(_RegionTemplate? template) {
    return _BurnRegionEntry(
      code: template?.code ?? '',
      label: template?.label ?? '',
    );
  }

  double get selectedPercent {
    final override = double.tryParse(overrideCtrl.text.trim());
    if (override != null) return override;
    return double.tryParse(areaCtrl.text.trim()) ?? 0;
  }

  Map<String, dynamic>? toPayload() {
    final label = labelCtrl.text.trim();
    final area = double.tryParse(areaCtrl.text.trim());
    if (label.isEmpty || area == null) return null;
    final override = double.tryParse(overrideCtrl.text.trim());
    final overrideReason = overrideReasonCtrl.text.trim();
    final overridePayload = override == null
        ? null
        : <String, dynamic>{
            'clinician_override_percent': override,
            if (overrideReason.isNotEmpty) 'override_reason': overrideReason,
          };
    return {
      'body_region_code': codeCtrl.text.trim().isEmpty
          ? label.toLowerCase().replaceAll(RegExp(r'\s+'), '_')
          : codeCtrl.text.trim(),
      'body_region_label': label,
      'depth': depth,
      'area_percent': area,
      ...?overridePayload,
    };
  }

  void clear() {
    codeCtrl.clear();
    labelCtrl.clear();
    areaCtrl.clear();
    overrideCtrl.clear();
    overrideReasonCtrl.clear();
    depth = 'unknown';
  }

  void dispose() {
    codeCtrl.dispose();
    labelCtrl.dispose();
    areaCtrl.dispose();
    overrideCtrl.dispose();
    overrideReasonCtrl.dispose();
  }
}
