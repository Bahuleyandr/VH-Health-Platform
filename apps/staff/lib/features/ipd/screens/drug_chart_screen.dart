import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/desktop_scroll_controls.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';
import '../utils/drug_chart_utils.dart';

const _routeOptions = <String, String>{
  'oral': 'Oral',
  'iv': 'IV',
  'im': 'IM',
  'sc': 'SC',
  'sublingual': 'SL',
  'inhaled': 'Inhaled',
  'topical': 'Topical',
};

const _foodOptions = <String, String>{
  '': '-',
  'before_food': 'Before food',
  'after_food': 'After food',
  'with_food': 'With food',
  'empty_stomach': 'Empty stomach',
  'bedtime': 'Bedtime',
  'prn': 'PRN',
};

const _doseSlots = <_DoseSlot>[
  _DoseSlot('morning', 'Morning', '08:00'),
  _DoseSlot('afternoon', 'Afternoon', '14:00'),
  _DoseSlot('evening', 'Evening', '20:00'),
  _DoseSlot('night', 'Night', '22:00'),
];

const _fallbackDrugs = <String>[
  'Paracetamol 650 mg',
  'Pantoprazole 40 mg',
  'Ondansetron 4 mg',
  'Ceftriaxone 1 g',
  'Amoxicillin-Clavulanate 625 mg',
  'Metformin 500 mg',
  'Insulin regular',
  'Normal Saline 500 mL',
  'Ringer Lactate 500 mL',
  'Tramadol 50 mg',
  'Enoxaparin 40 mg',
  'Aspirin 75 mg',
];

class DrugChartScreen extends StatefulWidget {
  final int admissionId;
  final String? patientName;

  const DrugChartScreen({
    super.key,
    required this.admissionId,
    this.patientName,
  });

  @override
  State<DrugChartScreen> createState() => _DrugChartScreenState();
}

class _DrugChartScreenState extends State<DrugChartScreen> {
  final List<_DrugChartDraftRow> _draftRows = [];
  Map<String, dynamic>? _chart;
  bool _loading = true;
  String? _error;

  Map<String, dynamic> get _admission =>
      (_chart?['admission'] as Map?)?.cast<String, dynamic>() ?? const {};

  List<Map<String, dynamic>> get _orders =>
      (_chart?['medication_orders'] as List? ?? const [])
          .whereType<Map>()
          .map((row) => row.cast<String, dynamic>())
          .toList();

  Map<String, dynamic> get _permissions =>
      (_chart?['permissions'] as Map?)?.cast<String, dynamic>() ?? const {};

  bool get _canPrescribe => _permissions['can_prescribe'] == true;

  bool get _canAdminister => _permissions['can_administer'] == true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final row in _draftRows) {
      row.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final chart = await MedicalApiService.getInpatientDrugChart(
        widget.admissionId,
      );
      if (!mounted) return;
      setState(() => _chart = chart);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _addDraftRow() {
    setState(() => _draftRows.add(_DrugChartDraftRow()));
  }

  void _removeDraftRow(_DrugChartDraftRow row) {
    setState(() => _draftRows.remove(row));
    row.dispose();
  }

  Future<void> _saveDraftRow(_DrugChartDraftRow row) async {
    final drug = row.drugCtrl.text.trim();
    final dose = row.doseCtrl.text.trim().isNotEmpty
        ? row.doseCtrl.text.trim()
        : deriveDoseFromDrug(drug);
    final doseTimes = row.selectedTimes.toList()
      ..sort((a, b) => _slotIndex(a).compareTo(_slotIndex(b)));

    String? error;
    if (drug.isEmpty) {
      error = 'Drug is required';
    } else if (dose.isEmpty) {
      error = 'Dose is required; select a drug with strength or enter dose';
    } else if (doseTimes.isEmpty) {
      error = 'Select at least one administration time';
    }
    if (error != null) {
      _showSnack(error, isError: true);
      return;
    }

    setState(() => row.saving = true);
    try {
      await MedicalApiService.createInpatientMedicationOrder(
        patientUid: _text(_admission['patient_uid']),
        encounterId: _text(_admission['encounter_id']).isEmpty
            ? null
            : _text(_admission['encounter_id']),
        medicationName: drug,
        dose: dose,
        route: row.route,
        frequency: _frequencyForTimes(doseTimes),
        doseTimes: doseTimes,
        foodTiming: row.foodTiming.isEmpty ? null : row.foodTiming,
        instructions: row.notesCtrl.text.trim().isEmpty
            ? null
            : row.notesCtrl.text.trim(),
      );
      if (!mounted) return;
      _removeDraftRow(row);
      await _load();
      if (!mounted) return;
      _showSnack(AppStrings.of(context).drugChartSavedToast);
    } catch (e) {
      if (!mounted) return;
      _showSnack(e.toString().replaceFirst('Exception: ', ''), isError: true);
    } finally {
      if (mounted && _draftRows.contains(row)) {
        setState(() => row.saving = false);
      }
    }
  }

  Future<void> _stopOrder(Map<String, dynamic> order) async {
    final reasonCtrl = TextEditingController();
    final reason = await showDialog<String>(
      context: context,
      builder: (context) {
        final s = AppStrings.of(context);
        return AlertDialog(
          title: Text(s.drugChartStopTitle),
          content: TextField(
            controller: reasonCtrl,
            autofocus: true,
            maxLines: 3,
            decoration: InputDecoration(
              labelText: s.drugChartStopReasonLabel,
              hintText: s.drugChartStopReasonHint,
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              onPressed: () {
                final value = reasonCtrl.text.trim();
                if (value.isEmpty) return;
                Navigator.of(context).pop(value);
              },
              child: Text(s.drugChartStopButton),
            ),
          ],
        );
      },
    );
    reasonCtrl.dispose();
    if (reason == null || reason.isEmpty) return;

    try {
      await MedicalApiService.discontinueClinicalOrder(
        orderId: _asInt(order['id']) ?? 0,
        reason: reason,
      );
      if (mounted) _load();
    } catch (e) {
      if (!mounted) return;
      _showSnack(e.toString().replaceFirst('Exception: ', ''), isError: true);
    }
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
      title: s.drugChartTitle,
      floatingActionButton: _chart != null && _canPrescribe
          ? FloatingActionButton.extended(
              onPressed: _addDraftRow,
              icon: const Icon(Icons.add),
              label: Text(s.drugChartAddRow),
            )
          : null,
      body: RefreshIndicator(onRefresh: _load, child: _buildBody()),
    );
  }

  Widget _buildBody() {
    if (_loading && _chart == null) {
      return const SkeletonList();
    }
    if (_error != null && _chart == null) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const SizedBox(height: 80),
          ErrorState(message: _error!, onRetry: _load),
        ],
      );
    }

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
      children: [
        _DrugChartHeader(chart: _chart ?? const {}),
        const SizedBox(height: 12),
        _DrugChartTable(
          orders: _orders,
          draftRows: _draftRows,
          canPrescribe: _canPrescribe,
          canAdminister: _canAdminister,
          onAddRow: _addDraftRow,
          onRemoveDraft: _removeDraftRow,
          onSaveDraft: _saveDraftRow,
          onStopOrder: _stopOrder,
          onAdministrationChanged: _load,
        ),
      ],
    );
  }
}

class _DrugChartHeader extends StatelessWidget {
  final Map<String, dynamic> chart;

  const _DrugChartHeader({required this.chart});

  @override
  Widget build(BuildContext context) {
    final admission =
        (chart['admission'] as Map?)?.cast<String, dynamic>() ?? const {};
    final governance =
        (chart['governance'] as Map?)?.cast<String, dynamic>() ?? const {};
    final patient = _text(admission['patient_name'], fallback: 'Patient');
    final hospitalId = _text(admission['hospital_id']);
    final bed = _text(admission['bed_number']);
    final ward = _text(admission['ward_name']);
    final state = _text(governance['state'], fallback: 'schema-unavailable');
    final outcome = _text(governance['outcome'], fallback: state);
    final sourceCount = _asInt(governance['source_count']) ?? 0;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            patient,
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontSize: 20,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            [
              if (hospitalId.isNotEmpty) hospitalId,
              if (ward.isNotEmpty) ward,
              if (bed.isNotEmpty) 'Bed $bed',
              'Admission #${admission['id'] ?? '-'}',
            ].join(' · '),
            style: TextStyle(color: AppTheme.textSecondary),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _StatusPill(
                icon: Icons.verified_user_outlined,
                label: outcome == 'clear'
                    ? 'Rules clear'
                    : outcome == 'blocked'
                    ? 'Safety review needed'
                    : '$outcome · $state',
                color: _stateColor(outcome),
              ),
              _StatusPill(
                icon: Icons.source_outlined,
                label: '$sourceCount sources',
                color: AppTheme.primaryBlue,
              ),
              const _StatusPill(
                icon: Icons.table_chart_outlined,
                label: 'Doctor edit · Nurse MAR · Pharmacy indent',
                color: AppTheme.primaryTeal,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _DrugChartTable extends StatelessWidget {
  final List<Map<String, dynamic>> orders;
  final List<_DrugChartDraftRow> draftRows;
  final bool canPrescribe;
  final bool canAdminister;
  final VoidCallback onAddRow;
  final void Function(_DrugChartDraftRow row) onRemoveDraft;
  final void Function(_DrugChartDraftRow row) onSaveDraft;
  final void Function(Map<String, dynamic> order) onStopOrder;
  final VoidCallback onAdministrationChanged;

  const _DrugChartTable({
    required this.orders,
    required this.draftRows,
    required this.canPrescribe,
    required this.canAdminister,
    required this.onAddRow,
    required this.onRemoveDraft,
    required this.onSaveDraft,
    required this.onStopOrder,
    required this.onAdministrationChanged,
  });

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[
      const _DrugChartHeaderRow(),
      ...orders.map(
        (order) => _DrugChartOrderRow(
          order: order,
          canPrescribe: canPrescribe,
          canAdminister: canAdminister,
          onStop: () => onStopOrder(order),
          onAdministrationChanged: onAdministrationChanged,
        ),
      ),
      ...draftRows.map(
        (row) => _DrugChartDraftTableRow(
          row: row,
          onRemove: () => onRemoveDraft(row),
          onSave: () => onSaveDraft(row),
        ),
      ),
      if (orders.isEmpty && draftRows.isEmpty) _emptyRow(context),
    ];

    return LayoutBuilder(
      builder: (context, constraints) {
        final viewportWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : _chartWidth;
        final sheetWidth = viewportWidth > _chartWidth
            ? viewportWidth
            : _chartWidth;

        return Container(
          decoration: BoxDecoration(
            color: AppTheme.cardSurface,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppTheme.divider),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _DrugChartToolbar(
                  canPrescribe: canPrescribe,
                  orderCount: orders.length,
                  draftCount: draftRows.length,
                  onAddRow: onAddRow,
                ),
                DesktopScrollControls(
                  axis: Axis.horizontal,
                  child: SizedBox(
                    width: sheetWidth,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: rows,
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _emptyRow(BuildContext context) {
    return SizedBox(
      width: _chartWidth,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 28, 16, 32),
        child: Column(
          children: [
            Icon(
              Icons.medication_outlined,
              color: AppTheme.textSecondary,
              size: 44,
            ),
            const SizedBox(height: 8),
            Text(
              AppStrings.of(context).drugChartEmpty,
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontWeight: FontWeight.w700,
              ),
            ),
            if (canPrescribe) ...[
              const SizedBox(height: 10),
              FilledButton.icon(
                onPressed: onAddRow,
                icon: const Icon(Icons.add),
                label: Text(AppStrings.of(context).drugChartAddFirstRow),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _DrugChartToolbar extends StatelessWidget {
  final bool canPrescribe;
  final int orderCount;
  final int draftCount;
  final VoidCallback onAddRow;

  const _DrugChartToolbar({
    required this.canPrescribe,
    required this.orderCount,
    required this.draftCount,
    required this.onAddRow,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        border: Border(bottom: BorderSide(color: AppTheme.divider)),
      ),
      child: Wrap(
        spacing: 10,
        runSpacing: 10,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 240, maxWidth: 460),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Inpatient Drug Chart',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontSize: 18,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  canPrescribe
                      ? 'Add rows inline. Time ticks become nurse MAR due doses.'
                      : 'Read-only chart with nurse MAR and pharmacy indent status.',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 13),
                ),
              ],
            ),
          ),
          _MiniPill(
            label: '$orderCount active rows',
            color: AppTheme.primaryBlue,
          ),
          if (draftCount > 0)
            _MiniPill(
              label: '$draftCount unsaved',
              color: AppTheme.warningOnSurface,
            ),
          if (canPrescribe)
            OutlinedButton.icon(
              onPressed: onAddRow,
              icon: const Icon(Icons.add),
              label: Text(AppStrings.of(context).drugChartAddRow),
            ),
        ],
      ),
    );
  }
}

class _DrugChartHeaderRow extends StatelessWidget {
  const _DrugChartHeaderRow();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: _chartWidth,
      height: _headerRowHeight,
      decoration: BoxDecoration(
        color: AppTheme.primaryBlue.withValues(alpha: 0.14),
        border: Border(
          top: BorderSide(color: AppTheme.divider),
          bottom: BorderSide(color: AppTheme.divider),
        ),
      ),
      child: Row(
        children: [
          _tableHeaderCell('Drug', width: _drugCol),
          _tableHeaderCell('Dose', width: _doseCol),
          _tableHeaderCell('Route', width: _routeCol),
          _tableHeaderCell('Started', width: _startedCol),
          ..._doseSlots.map(
            (slot) => _tableHeaderCell(
              '${slot.label}\n${slot.time}',
              width: _timeCol,
            ),
          ),
          _tableHeaderCell('Food', width: _foodCol),
          _tableHeaderCell('Safety / MAR / actions', width: _actionCol),
        ],
      ),
    );
  }
}

class _DrugChartOrderRow extends StatelessWidget {
  final Map<String, dynamic> order;
  final bool canPrescribe;
  final bool canAdminister;
  final VoidCallback onStop;
  final VoidCallback onAdministrationChanged;

  const _DrugChartOrderRow({
    required this.order,
    required this.canPrescribe,
    required this.canAdminister,
    required this.onStop,
    required this.onAdministrationChanged,
  });

  @override
  Widget build(BuildContext context) {
    final details =
        (order['details'] as Map?)?.cast<String, dynamic>() ?? const {};
    final administrations = _administrations(order);
    final status = _text(order['status'], fallback: 'ordered');
    final active = !_inactive(status);
    final safety =
        (order['safety'] as Map?)?.cast<String, dynamic>() ?? const {};
    final warnings = (safety['warnings'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    final blockers = (safety['blockers'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    final medicationName = _text(details['name'], fallback: 'Medication');
    final dose = _displayDose(details, medicationName);
    final startedAt =
        _dateTime(order['start_date']) ?? _dateTime(order['created_at']);
    final startedBy = _text(order['ordered_by_name'], fallback: 'Doctor');
    final antibiotic = isAntibioticMedication(medicationName, details: details);

    return Container(
      width: _chartWidth,
      height: _orderRowHeight,
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        border: Border(bottom: BorderSide(color: AppTheme.divider)),
      ),
      child: Row(
        children: [
          _tableCell(
            width: _drugCol,
            height: _orderRowHeight,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  medicationName,
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    _MiniPill(
                      label: status,
                      color: active
                          ? AppTheme.successOnSurface
                          : AppTheme.errorOnSurface,
                    ),
                    _MiniPill(
                      label: _text(
                        order['pharmacy_status'],
                        fallback: 'pharmacy pending',
                      ),
                      color: AppTheme.warningOnSurface,
                    ),
                  ],
                ),
              ],
            ),
          ),
          _tableTextCell(dose, width: _doseCol),
          _tableTextCell(
            _routeLabel(_text(details['route'])),
            width: _routeCol,
          ),
          _StartedCell(
            startedAt: startedAt,
            startedBy: startedBy,
            showAntibioticDay: antibiotic,
            width: _startedCol,
          ),
          ..._doseSlots.map(
            (slot) => _DoseTimeCell(
              slot: slot,
              order: order,
              canAdminister: canAdminister,
              onAdministrationChanged: onAdministrationChanged,
            ),
          ),
          _tableTextCell(
            _foodLabel(_text(details['food_timing'])),
            width: _foodCol,
          ),
          _tableCell(
            width: _actionCol,
            height: _orderRowHeight,
            child: _SafetyAndActionsCell(
              order: order,
              warnings: warnings,
              blockers: blockers,
              administrations: administrations,
              canPrescribe: canPrescribe,
              active: active,
              onStop: onStop,
            ),
          ),
        ],
      ),
    );
  }
}

class _DrugChartDraftTableRow extends StatefulWidget {
  final _DrugChartDraftRow row;
  final VoidCallback onRemove;
  final VoidCallback onSave;

  const _DrugChartDraftTableRow({
    required this.row,
    required this.onRemove,
    required this.onSave,
  });

  @override
  State<_DrugChartDraftTableRow> createState() =>
      _DrugChartDraftTableRowState();
}

class _DrugChartDraftTableRowState extends State<_DrugChartDraftTableRow> {
  void _applyDerivedDose(String drug, {bool overwrite = false}) {
    final derived = deriveDoseFromDrug(drug);
    if (derived.isEmpty) return;
    final current = widget.row.doseCtrl.text.trim();
    if (overwrite || current.isEmpty || current == widget.row.lastAutoDose) {
      widget.row.doseCtrl.text = derived;
      widget.row.lastAutoDose = derived;
    }
  }

  @override
  Widget build(BuildContext context) {
    final row = widget.row;
    return Container(
      width: _chartWidth,
      height: _draftRowHeight,
      decoration: BoxDecoration(
        color: AppTheme.primaryTeal.withValues(alpha: 0.06),
        border: Border(bottom: BorderSide(color: AppTheme.divider)),
      ),
      child: Row(
        children: [
          _tableCell(
            width: _drugCol,
            height: _draftRowHeight,
            child: _DrugAutocompleteField(
              controller: row.drugCtrl,
              onTextChanged: (value) =>
                  setState(() => _applyDerivedDose(value)),
              onSelected: (value) =>
                  setState(() => _applyDerivedDose(value, overwrite: true)),
            ),
          ),
          _tableCell(
            width: _doseCol,
            height: _draftRowHeight,
            child: TextField(
              controller: row.doseCtrl,
              minLines: 1,
              maxLines: 2,
              decoration: const InputDecoration(
                labelText: 'Dose',
                hintText: 'auto-filled from drug strength',
                helperText: 'Edit only if dose differs',
                isDense: true,
              ),
            ),
          ),
          _tableCell(
            width: _routeCol,
            height: _draftRowHeight,
            child: DropdownButtonFormField<String>(
              initialValue: row.route,
              isExpanded: true,
              decoration: const InputDecoration(
                labelText: 'Route',
                isDense: true,
              ),
              items: _routeOptions.entries
                  .map(
                    (entry) => DropdownMenuItem(
                      value: entry.key,
                      child: Text(entry.value),
                    ),
                  )
                  .toList(),
              onChanged: (v) => setState(() => row.route = v ?? row.route),
            ),
          ),
          _tableCell(
            width: _startedCol,
            height: _draftRowHeight,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Starts today',
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontWeight: FontWeight.w700,
                    fontSize: 13,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'Active until stopped',
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
                ),
              ],
            ),
          ),
          ..._doseSlots.map(
            (slot) => _tableCell(
              width: _timeCol,
              height: _draftRowHeight,
              child: Center(
                child: Checkbox(
                  value: row.selectedTimes.contains(slot.time),
                  onChanged: (value) {
                    setState(() {
                      if (value == true) {
                        row.selectedTimes.add(slot.time);
                      } else {
                        row.selectedTimes.remove(slot.time);
                      }
                    });
                  },
                ),
              ),
            ),
          ),
          _tableCell(
            width: _foodCol,
            height: _draftRowHeight,
            child: DropdownButtonFormField<String>(
              initialValue: row.foodTiming,
              isExpanded: true,
              decoration: const InputDecoration(
                labelText: 'Food',
                isDense: true,
              ),
              items: _foodOptions.entries
                  .map(
                    (entry) => DropdownMenuItem(
                      value: entry.key,
                      child: Text(entry.value),
                    ),
                  )
                  .toList(),
              onChanged: (v) =>
                  setState(() => row.foodTiming = v ?? row.foodTiming),
            ),
          ),
          _tableCell(
            width: _actionCol,
            height: _draftRowHeight,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: row.notesCtrl,
                  minLines: 1,
                  maxLines: 2,
                  decoration: const InputDecoration(
                    labelText: 'Notes',
                    hintText: 'Dilution, PRN reason, hold rules',
                    isDense: true,
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: row.saving ? null : widget.onSave,
                        icon: row.saving
                            ? const SizedBox(
                                width: 14,
                                height: 14,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.save_outlined),
                        label: Text(
                          row.saving
                              ? AppStrings.of(context).bedSheetSavingLabel
                              : AppStrings.of(context).actionSave,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    IconButton(
                      tooltip: AppStrings.of(context).drugChartRemoveRow,
                      onPressed: row.saving ? null : widget.onRemove,
                      icon: const Icon(Icons.delete_outline),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _DrugAutocompleteField extends StatefulWidget {
  final TextEditingController controller;
  final ValueChanged<String>? onTextChanged;
  final ValueChanged<String> onSelected;

  const _DrugAutocompleteField({
    required this.controller,
    this.onTextChanged,
    required this.onSelected,
  });

  @override
  State<_DrugAutocompleteField> createState() => _DrugAutocompleteFieldState();
}

class _DrugAutocompleteFieldState extends State<_DrugAutocompleteField> {
  final _focusNode = FocusNode();
  Timer? _debounce;
  List<Map<String, dynamic>> _catalogSuggestions = const [];
  bool _loading = false;

  @override
  void dispose() {
    _debounce?.cancel();
    _focusNode.dispose();
    super.dispose();
  }

  Future<void> _search(String value) async {
    final query = value.trim();
    if (query.length < 2) {
      setState(() => _catalogSuggestions = const []);
      return;
    }
    setState(() => _loading = true);
    try {
      final rows = await MedicalApiService.searchMedicationCatalog(query);
      if (!mounted) return;
      setState(() => _catalogSuggestions = rows.take(6).toList());
    } catch (_) {
      if (!mounted) return;
      setState(() => _catalogSuggestions = const []);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _onChanged(String value) {
    widget.onTextChanged?.call(value);
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 250), () => _search(value));
  }

  @override
  Widget build(BuildContext context) {
    return RawAutocomplete<String>(
      textEditingController: widget.controller,
      focusNode: _focusNode,
      optionsBuilder: (value) {
        final query = value.text.trim().toLowerCase();
        if (query.length < 2) return const Iterable<String>.empty();
        final names = <String>[
          ..._catalogSuggestions.map(
            (row) => _text(row['name'], fallback: _text(row['label'])),
          ),
          ..._fallbackDrugs.where((drug) => drug.toLowerCase().contains(query)),
        ].where((name) => name.isNotEmpty).toList();
        return names.toSet().take(7);
      },
      onSelected: (value) {
        widget.controller.text = value;
        widget.controller.selection = TextSelection.collapsed(
          offset: value.length,
        );
        widget.onSelected(value);
      },
      fieldViewBuilder: (context, controller, focusNode, onSubmitted) {
        return TextField(
          controller: controller,
          focusNode: focusNode,
          onChanged: _onChanged,
          style: TextStyle(color: AppTheme.textPrimary, fontSize: 13),
          decoration: InputDecoration(
            labelText: 'Drug',
            hintText: 'Type drug name',
            isDense: true,
            suffixIcon: _loading
                ? const Padding(
                    padding: EdgeInsets.all(12),
                    child: SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : const Icon(Icons.search, size: 18),
          ),
        );
      },
      optionsViewBuilder: (context, onSelected, options) {
        final optionList = options.toList();
        return Align(
          alignment: Alignment.topLeft,
          child: Material(
            color: AppTheme.cardSurface,
            elevation: 8,
            borderRadius: BorderRadius.circular(8),
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                maxHeight: 210,
                maxWidth: _drugCol - 20,
              ),
              child: ListView.separated(
                padding: EdgeInsets.zero,
                shrinkWrap: true,
                itemCount: optionList.length,
                separatorBuilder: (context, index) =>
                    Divider(height: 1, color: AppTheme.divider),
                itemBuilder: (context, index) {
                  final name = optionList[index];
                  return ListTile(
                    dense: true,
                    title: Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: AppTheme.textPrimary),
                    ),
                    onTap: () => onSelected(name),
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

class _StartedCell extends StatelessWidget {
  final DateTime? startedAt;
  final String startedBy;
  final bool showAntibioticDay;
  final double width;

  const _StartedCell({
    required this.startedAt,
    required this.startedBy,
    required this.showAntibioticDay,
    required this.width,
  });

  @override
  Widget build(BuildContext context) {
    return _tableCell(
      width: width,
      height: _orderRowHeight,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Started ${formatDrugChartDate(startedAt)}',
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontWeight: FontWeight.w700,
              fontSize: 13,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            'By $startedBy',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
          ),
          if (showAntibioticDay && startedAt != null) ...[
            const SizedBox(height: 8),
            _MiniPill(
              label: 'Antibiotic day ${antibioticDay(startedAt!)}',
              color: AppTheme.warningOnSurface,
            ),
          ],
        ],
      ),
    );
  }
}

class _DoseTimeCell extends StatelessWidget {
  final _DoseSlot slot;
  final Map<String, dynamic> order;
  final bool canAdminister;
  final VoidCallback onAdministrationChanged;

  const _DoseTimeCell({
    required this.slot,
    required this.order,
    required this.canAdminister,
    required this.onAdministrationChanged,
  });

  @override
  Widget build(BuildContext context) {
    final details =
        (order['details'] as Map?)?.cast<String, dynamic>() ?? const {};
    final doseTimes = _explicitDoseTimes(details);
    final administrations = _administrations(order);
    final matched = administrations
        .where(
          (row) => _timeLabel(_dateTime(row['scheduled_time'])) == slot.time,
        )
        .toList();
    final latest = matched.isEmpty ? null : matched.last;
    final status = _text(latest?['status'], fallback: 'scheduled');
    final given = latest == null ? null : _dateTime(latest['administered_at']);
    final due = latest != null && (status == 'scheduled' || status == 'held');
    final selected = doseTimes.contains(slot.time) || latest != null;

    return _tableCell(
      width: _timeCol,
      child: Center(
        child: selected
            ? Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    given != null
                        ? Icons.check_circle
                        : due
                        ? Icons.schedule
                        : Icons.radio_button_checked,
                    color: given != null
                        ? AppTheme.successOnSurface
                        : due
                        ? AppTheme.warningOnSurface
                        : AppTheme.primaryBlue,
                    size: 18,
                  ),
                  if (canAdminister && due && latest['id'] != null)
                    TextButton(
                      style: TextButton.styleFrom(
                        padding: EdgeInsets.zero,
                        minimumSize: const Size(48, 28),
                      ),
                      onPressed: () => context
                          .push('/mar/scan/${latest['id']}')
                          .then((_) => onAdministrationChanged()),
                      child: Text(AppStrings.of(context).drugChartScan),
                    )
                  else
                    Text(
                      given != null
                          ? AppStrings.of(context).drugChartGiven
                          : status,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: AppTheme.textSecondary,
                        fontSize: 11,
                      ),
                    ),
                ],
              )
            : Text('-', style: TextStyle(color: AppTheme.textSecondary)),
      ),
    );
  }
}

class _SafetyAndActionsCell extends StatelessWidget {
  final Map<String, dynamic> order;
  final List<Map> warnings;
  final List<Map> blockers;
  final List<Map<String, dynamic>> administrations;
  final bool canPrescribe;
  final bool active;
  final VoidCallback onStop;

  const _SafetyAndActionsCell({
    required this.order,
    required this.warnings,
    required this.blockers,
    required this.administrations,
    required this.canPrescribe,
    required this.active,
    required this.onStop,
  });

  @override
  Widget build(BuildContext context) {
    final nextDue = administrations.where((row) {
      final status = _text(row['status']);
      return status == 'scheduled' || status == 'held';
    }).toList();
    final given = administrations
        .where((row) => _text(row['status']) == 'administered')
        .length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (blockers.isNotEmpty)
          _SafetyLine(row: blockers.first, color: AppTheme.errorOnSurface)
        else if (warnings.isNotEmpty)
          _SafetyLine(row: warnings.first, color: AppTheme.warningOnSurface)
        else
          _MiniPill(label: 'Safety clear', color: AppTheme.successOnSurface),
        const SizedBox(height: 8),
        Text(
          [
            if (nextDue.isNotEmpty)
              'Next due ${_timeLabel(_dateTime(nextDue.first['scheduled_time']))}',
            '$given given',
          ].join(' · '),
          style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
        ),
        if (canPrescribe && active) ...[
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: onStop,
              icon: const Icon(Icons.stop_circle_outlined),
              label: Text(AppStrings.of(context).drugChartStopButton),
            ),
          ),
        ],
      ],
    );
  }
}

class _SafetyLine extends StatelessWidget {
  final Map row;
  final Color color;

  const _SafetyLine({required this.row, required this.color});

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.info_outline, color: color, size: 16),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            _text(row['message'], fallback: _text(row['type'])),
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: color, fontSize: 12),
          ),
        ),
      ],
    );
  }
}

class _StatusPill extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;

  const _StatusPill({
    required this.icon,
    required this.label,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: color),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              color: color,
              fontWeight: FontWeight.w700,
              fontSize: 12,
            ),
          ),
        ],
      ),
    );
  }
}

class _MiniPill extends StatelessWidget {
  final String label;
  final Color color;

  const _MiniPill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

class _DrugChartDraftRow {
  final drugCtrl = TextEditingController();
  final doseCtrl = TextEditingController();
  final notesCtrl = TextEditingController();
  final selectedTimes = <String>{'08:00', '20:00'};
  String? lastAutoDose;
  String route = 'oral';
  String foodTiming = '';
  bool saving = false;

  void dispose() {
    drugCtrl.dispose();
    doseCtrl.dispose();
    notesCtrl.dispose();
  }
}

class _DoseSlot {
  final String key;
  final String label;
  final String time;

  const _DoseSlot(this.key, this.label, this.time);
}

const double _drugCol = 280;
const double _doseCol = 130;
const double _routeCol = 120;
const double _startedCol = 180;
const double _timeCol = 86;
const double _foodCol = 150;
const double _actionCol = 240;
const double _headerRowHeight = 54;
const double _orderRowHeight = 142;
const double _draftRowHeight = 144;
const double _chartWidth =
    _drugCol +
    _doseCol +
    _routeCol +
    _startedCol +
    (_timeCol * 4) +
    _foodCol +
    _actionCol;

Widget _tableHeaderCell(String text, {required double width}) {
  return SizedBox(
    width: width,
    height: _headerRowHeight,
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        border: Border(right: BorderSide(color: AppTheme.divider)),
      ),
      child: Text(
        text,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: AppTheme.textPrimary,
          fontWeight: FontWeight.w800,
          fontSize: 12,
        ),
      ),
    ),
  );
}

Widget _tableCell({
  required double width,
  required Widget child,
  double height = _orderRowHeight,
}) {
  return SizedBox(
    width: width,
    height: height,
    child: Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        border: Border(right: BorderSide(color: AppTheme.divider)),
      ),
      child: child,
    ),
  );
}

Widget _tableTextCell(
  String text, {
  required double width,
  double height = _orderRowHeight,
}) {
  return _tableCell(
    width: width,
    height: height,
    child: Align(
      alignment: Alignment.topLeft,
      child: Text(
        text.isEmpty ? '-' : text,
        maxLines: 4,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: AppTheme.textPrimary),
      ),
    ),
  );
}

String _text(Object? value, {String fallback = ''}) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? fallback : text;
}

int? _asInt(Object? value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '');
}

DateTime? _dateTime(Object? value) {
  if (value == null) return null;
  try {
    return DateTime.parse(value.toString()).toLocal();
  } catch (_) {
    return null;
  }
}

String _timeLabel(DateTime? value) {
  if (value == null) return 'not timed';
  final h = value.hour.toString().padLeft(2, '0');
  final m = value.minute.toString().padLeft(2, '0');
  return '$h:$m';
}

bool _inactive(String status) {
  final s = status.toLowerCase();
  return s.contains('cancel') ||
      s.contains('discontinu') ||
      s.contains('stop') ||
      s.contains('hold') ||
      s.contains('suspend');
}

Color _stateColor(String state) {
  final s = state.toLowerCase();
  if (s == 'blocked') return AppTheme.errorOnSurface;
  if (s == 'fallback' || s.contains('schema')) return AppTheme.warningOnSurface;
  return AppTheme.successOnSurface;
}

List<Map<String, dynamic>> _administrations(Map<String, dynamic> order) {
  return (order['administrations'] as List? ?? const [])
      .whereType<Map>()
      .map((row) => row.cast<String, dynamic>())
      .toList();
}

List<String> _explicitDoseTimes(Map<String, dynamic> details) {
  final raw = details['dose_times'];
  if (raw is List) {
    return raw.map((v) => _text(v)).where((v) => v.isNotEmpty).toList();
  }
  if (raw is String) {
    return raw
        .split(RegExp(r'[,\s]+'))
        .map((v) => v.trim())
        .where((v) => v.isNotEmpty)
        .toList();
  }
  return _defaultTimesForFrequency(_text(details['frequency']));
}

List<String> _defaultTimesForFrequency(String frequency) {
  switch (frequency.toUpperCase()) {
    case 'OD':
    case 'QD':
      return const ['08:00'];
    case 'BD':
    case 'BID':
    case '12-HOURLY':
      return const ['08:00', '20:00'];
    case 'TDS':
    case 'TID':
    case '8-HOURLY':
      return const ['08:00', '14:00', '20:00'];
    case 'QID':
    case '6-HOURLY':
      return const ['08:00', '14:00', '20:00', '22:00'];
    default:
      return const [];
  }
}

String _frequencyForTimes(List<String> times) {
  switch (times.length) {
    case 1:
      return 'OD';
    case 2:
      return 'BD';
    case 3:
      return 'TDS';
    default:
      return 'QID';
  }
}

int _slotIndex(String time) {
  final index = _doseSlots.indexWhere((slot) => slot.time == time);
  return index == -1 ? 999 : index;
}

String _routeLabel(String route) {
  if (route.isEmpty) return '-';
  return _routeOptions[route.toLowerCase()] ?? route;
}

String _foodLabel(String value) {
  return _foodOptions[value] ?? _foodOptions[value.toLowerCase()] ?? '-';
}

String _displayDose(Map<String, dynamic> details, String medicationName) {
  final explicit = _text(details['dose'], fallback: _text(details['dosage']));
  if (explicit.isNotEmpty) return explicit;
  return deriveDoseFromDrug(medicationName);
}
