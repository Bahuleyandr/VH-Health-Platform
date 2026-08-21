import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';

import '../../../core/models/composition_alternatives.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/order_payloads.dart';
import '../../../core/services/staff_clinical_action_gateway.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/api_error_messages.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/desktop_scroll_controls.dart';
import '../../../core/widgets/offline_clinical_fallback_dialog.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../core/widgets/voice_dictate_button.dart';
import '../../../l10n/app_strings.dart';
import '../dictated_order_parser.dart';
import '../drug_chart_offline_order.dart';
import '../utils/drug_chart_utils.dart';
import '../../pharmacy/widgets/composition_alternatives_panel.dart';

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

enum DrugChartDraftValidationFailure {
  drugRequired,
  catalogSelectionRequired,
  doseRequired,
  administrationTimeRequired,
}

DrugChartDraftValidationFailure? validateDrugChartDraft({
  required String drug,
  required int? catalogId,
  required String dose,
  required Iterable<String> doseTimes,
}) {
  if (drug.trim().isEmpty) return DrugChartDraftValidationFailure.drugRequired;
  if (catalogId == null) {
    return DrugChartDraftValidationFailure.catalogSelectionRequired;
  }
  if (dose.trim().isEmpty) return DrugChartDraftValidationFailure.doseRequired;
  if (doseTimes.isEmpty) {
    return DrugChartDraftValidationFailure.administrationTimeRequired;
  }
  return null;
}

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
      setState(
        () => _error = localizedApiErrorFromRaw(AppStrings.of(context), e),
      );
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
    if (row.saving) return;
    final s = AppStrings.of(context);
    final drug = row.drugCtrl.text.trim();
    final dose = row.doseCtrl.text.trim().isNotEmpty
        ? row.doseCtrl.text.trim()
        : deriveDoseFromDrug(drug);
    final doseTimes = row.selectedTimes.toList()
      ..sort((a, b) => _slotIndex(a).compareTo(_slotIndex(b)));

    final validationFailure = validateDrugChartDraft(
      drug: drug,
      catalogId: row.catalogId,
      dose: dose,
      doseTimes: doseTimes,
    );
    if (validationFailure != null) {
      if (validationFailure ==
              DrugChartDraftValidationFailure.catalogSelectionRequired &&
          row.catalogUnavailable) {
        await showOfflineClinicalFallbackDialog(
          context,
          paperFormSet: s.offlineClinicalFallbackInpatientDrugCharts,
        );
        return;
      }
      final key = switch (validationFailure) {
        DrugChartDraftValidationFailure.drugRequired =>
          's4.lib.drug_chart.drug_required',
        DrugChartDraftValidationFailure.catalogSelectionRequired =>
          's4.lib.drug_chart.catalog_selection_required',
        DrugChartDraftValidationFailure.doseRequired =>
          's4.lib.drug_chart.dose_required',
        DrugChartDraftValidationFailure.administrationTimeRequired =>
          's4.lib.drug_chart.administration_time_required',
      };
      _showSnack(s.lookup(key), isError: true);
      return;
    }

    setState(() => row.saving = true);
    try {
      if (drugChartSubmissionDisposition(
            isOnline: ConnectivitySyncService.instance.isOnline,
          ) ==
          DrugChartSubmissionDisposition.attemptLocalDraft) {
        if (!mounted) return;
        final patientUid = _text(_admission['patient_uid']);
        final encounterId = _text(_admission['encounter_id']).isEmpty
            ? null
            : _text(_admission['encounter_id']);
        final localBody = buildInpatientMedicationOrderBody(
          patientUid: patientUid,
          encounterId: encounterId,
          medicationName: drug,
          dose: dose,
          route: row.route,
          frequency: _frequencyForTimes(doseTimes),
          doseTimes: doseTimes,
          foodTiming: row.foodTiming.isEmpty ? null : row.foodTiming,
          instructions: row.notesCtrl.text.trim().isEmpty
              ? null
              : row.notesCtrl.text.trim(),
          catalogId: row.catalogId,
          originalCatalogId: row.originalCatalogId,
          compositionId: row.compositionId,
          compositionLabel: row.compositionLabel,
          compositionConfidence: row.compositionConfidence,
          genericName: row.genericName,
          strength: row.strength,
          strengthKey: row.strengthKey,
          form: row.form,
          formKey: row.formKey,
          releaseKey: row.releaseKey,
          doNotSubstitute: row.daw,
          startDate: DateTime.now(),
        );
        final saved = await StaffClinicalActionGateway.instance.saveLocalDraft(
          callSite: StaffCaptureCallSite.ipDrugChartLocalDraft,
          patientReference: patientUid,
          encounterId: encounterId,
          admissionId: _text(_admission['id']).isEmpty
              ? null
              : _text(_admission['id']),
          payload: Map<String, Object?>.from(localBody),
        );
        if (!mounted) return;
        if (saved.allowed) {
          _showSnack(s.localClinicalDraftSavedMessage);
        } else {
          await showOfflineClinicalFallbackDialog(
            context,
            paperFormSet: s.offlineClinicalFallbackInpatientDrugCharts,
          );
        }
        return;
      }
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
        catalogId: row.catalogId,
        originalCatalogId: row.originalCatalogId,
        compositionId: row.compositionId,
        compositionLabel: row.compositionLabel,
        compositionConfidence: row.compositionConfidence,
        genericName: row.genericName,
        strength: row.strength,
        strengthKey: row.strengthKey,
        form: row.form,
        formKey: row.formKey,
        releaseKey: row.releaseKey,
        doNotSubstitute: row.daw,
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
      if (mounted) unawaited(_load());
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

  void _applyCompositionAlternative(
    _DrugChartDraftRow row,
    CompositionAlternativeItem item,
  ) {
    final originalCatalogId = row.originalCatalogId ?? row.catalogId;
    final catalogRow = item.toCatalogRow(
      compositionId: row.compositionId,
      compositionLabel: row.compositionLabel ?? row.genericName,
    );
    setState(() {
      row.applyCatalogRow(catalogRow, originalCatalogId: originalCatalogId);
      row.applyDerivedDose(overwrite: true);
    });
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
      body: ConstrainedContent(
        child: RefreshIndicator(onRefresh: _load, child: _buildBody()),
      ),
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
          patientUid: _text(_admission['patient_uid']),
          admissionId: widget.admissionId,
        ),
        _buildCompositionAlternativesSection(),
      ],
    );
  }

  Widget _buildCompositionAlternativesSection() {
    final panels = _draftRows
        .where(
          (row) => shouldShowCompositionAlternativesPanel(
            catalogId: row.catalogId,
            compositionConfidence: row.compositionConfidence,
          ),
        )
        .toList(growable: false);
    if (panels.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 8),
        for (final row in panels)
          CompositionAlternativesPanel(
            key: ValueKey(
              'drug-chart-composition-alternatives-${identityHashCode(row)}-${row.catalogId}',
            ),
            catalogId: row.catalogId,
            visible: true,
            doNotSubstitute: row.daw,
            selectedLabel: row.drugCtrl.text.trim(),
            onSwap: (item) => _applyCompositionAlternative(row, item),
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
    final s = AppStrings.of(context);
    final admission =
        (chart['admission'] as Map?)?.cast<String, dynamic>() ?? const {};
    final governance =
        (chart['governance'] as Map?)?.cast<String, dynamic>() ?? const {};
    final patient = _text(
      admission['patient_name'],
      fallback: s.lookup('s4.lib.drug_chart.patient'),
    );
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
              if (bed.isNotEmpty)
                s.format('s4.dynamic.drug_chart.bed', {'bed': bed}),
              s.format('s4.dynamic.drug_chart.admission_number', {
                'id': admission['id'] ?? '-',
              }),
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
                    ? s.lookup('s4.lib.drug_chart.rules_clear')
                    : outcome == 'blocked'
                    ? s.lookup('s4.lib.drug_chart.safety_review_needed')
                    : '$outcome · $state',
                color: _stateColor(outcome),
              ),
              _StatusPill(
                icon: Icons.source_outlined,
                label: s.format(
                  sourceCount == 1
                      ? 's4.dynamic.drug_chart.source_count_one'
                      : 's4.dynamic.drug_chart.source_count',
                  {'count': sourceCount},
                ),
                color: AppTheme.primaryBlue,
              ),
              _StatusPill(
                icon: Icons.table_chart_outlined,
                label: s.lookup('s4.lib.drug_chart.workflow_hint'),
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
  final String? patientUid;
  final int admissionId;

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
    required this.patientUid,
    required this.admissionId,
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
          patientUid: patientUid,
          admissionId: admissionId,
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
    final s = AppStrings.of(context);
    return SizedBox(
      width: _chartWidth,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 28, 16, 32),
        child: EmptyState(
          icon: Icons.medication_outlined,
          title: s.drugChartEmpty,
          body: s.lookup('s4.lib.drug_chart.empty_body'),
          action: canPrescribe
              ? FilledButton.icon(
                  onPressed: onAddRow,
                  icon: const Icon(Icons.add),
                  label: Text(s.drugChartAddFirstRow),
                )
              : null,
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
    final s = AppStrings.of(context);
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
                AppText(
                  's4.lib.drug_chart.inpatient_drug_chart',
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
                      ? s.drugChartToolbarEditableHint
                      : s.drugChartToolbarReadOnlyHint,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 13),
                ),
              ],
            ),
          ),
          _MiniPill(
            label: s.drugChartActiveRows(orderCount),
            color: AppTheme.primaryBlue,
          ),
          if (draftCount > 0)
            _MiniPill(
              label: s.drugChartUnsavedRows(draftCount),
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
    final s = AppStrings.of(context);
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
          _tableHeaderCell(s.drugChartColumnDrug, width: _drugCol),
          _tableHeaderCell(s.drugChartColumnDose, width: _doseCol),
          _tableHeaderCell(s.drugChartColumnRoute, width: _routeCol),
          _tableHeaderCell(s.drugChartColumnStarted, width: _startedCol),
          ..._doseSlots.map(
            (slot) => _tableHeaderCell(
              '${_doseSlotLabel(s, slot)}\n${slot.time}',
              width: _timeCol,
            ),
          ),
          _tableHeaderCell(s.drugChartColumnFood, width: _foodCol),
          _tableHeaderCell(
            s.drugChartColumnSafetyMarActions,
            width: _actionCol,
          ),
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
    final s = AppStrings.of(context);
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
    final medicationName = _text(
      details['name'],
      fallback: s.composerChipMedication,
    );
    final dose = _displayDose(details, medicationName);
    final startedAt =
        _dateTime(order['start_date']) ?? _dateTime(order['created_at']);
    final startedBy = _text(
      order['ordered_by_name'],
      fallback: s.prescriptionsDoctorLabel,
    );
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
                        fallback: s.drugChartPharmacyPending,
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
            _routeLabel(s, _text(details['route'])),
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
            _foodLabel(s, _text(details['food_timing'])),
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
  final String? patientUid;
  final int admissionId;

  const _DrugChartDraftTableRow({
    required this.row,
    required this.onRemove,
    required this.onSave,
    required this.patientUid,
    required this.admissionId,
  });

  @override
  State<_DrugChartDraftTableRow> createState() =>
      _DrugChartDraftTableRowState();
}

class _DrugChartDraftTableRowState extends State<_DrugChartDraftTableRow> {
  static const _parser = DictatedOrderParser();

  void _applyDerivedDose(String drug, {bool overwrite = false}) {
    widget.row.applyDerivedDose(drug: drug, overwrite: overwrite);
  }

  void _focusNextField() {
    FocusScope.of(context).nextFocus();
  }

  void _saveFromField() {
    if (widget.row.saving) return;
    widget.onSave();
  }

  void _handleNewline(
    TextEditingController controller,
    String value,
    VoidCallback action,
  ) {
    if (!value.contains('\n')) return;
    final cleaned = value.replaceAll(RegExp(r'\s*\n\s*'), ' ');
    controller.value = TextEditingValue(
      text: cleaned,
      selection: TextSelection.collapsed(offset: cleaned.length),
    );
    action();
  }

  Future<bool> _applyDictatedOrder(BuildContext _, String transcript) async {
    final parsed = _parser.parse(transcript);
    final candidates = parsed.drugQuery.isEmpty
        ? const <DictatedCatalogCandidate>[]
        : await _catalogCandidates(parsed.drugQuery);
    final decision = DictatedOrderParser.chooseCatalogMatch(
      parsed.drugQuery,
      candidates,
    );

    if (!mounted) return false;
    setState(() {
      widget.row.rawDictation = transcript.trim();
      widget.row.dictatedFields.clear();
      if (decision.autoSelected != null) {
        widget.row.applyCatalogRow(decision.autoSelected!.row);
        widget.row.dictatedFields.add('drug');
      } else {
        widget.row.clearCatalogIdentity();
        widget.row.drugCtrl.clear();
      }
      _applyParsedOrder(parsed);
    });

    if (decision.autoSelected == null &&
        parsed.drugQuery.isNotEmpty &&
        decision.candidates.isNotEmpty) {
      final selected = await _showDictatedDrugPicker(
        context,
        decision.candidates,
      );
      if (!mounted) return true;
      if (selected != null) {
        setState(() {
          widget.row.applyCatalogRow(selected.row);
          widget.row.dictatedFields.add('drug');
          if (parsed.dose.isNotEmpty) {
            widget.row.doseCtrl.text = parsed.dose;
            widget.row.dictatedFields.add('dose');
          }
        });
      }
    }

    return parsed.hasStructuredFields ||
        parsed.drugQuery.isNotEmpty ||
        parsed.notes.isNotEmpty;
  }

  Future<List<DictatedCatalogCandidate>> _catalogCandidates(
    String query,
  ) async {
    try {
      final rows = await MedicalApiService.searchMedicationCatalog(query);
      return rows
          .take(5)
          .map(
            (row) => DictatedCatalogCandidate(
              label: _catalogDrugLabel(row),
              row: row,
            ),
          )
          .where((candidate) => candidate.label.trim().isNotEmpty)
          .toList(growable: false);
    } catch (_) {
      return const [];
    }
  }

  Future<DictatedCatalogCandidate?> _showDictatedDrugPicker(
    BuildContext pickerContext,
    List<DictatedCatalogCandidate> candidates,
  ) {
    final s = AppStrings.of(pickerContext);
    return showModalBottomSheet<DictatedCatalogCandidate>(
      context: pickerContext,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            ListTile(
              title: Text(
                s.drugChartPickDictatedDrug,
                style: TextStyle(
                  color: AppTheme.textPrimary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            for (final candidate in candidates)
              ListTile(
                title: Text(candidate.label),
                subtitle: Text(
                  [
                    _catalogStrength(candidate.row),
                    _catalogForm(candidate.row),
                  ].where((value) => value.trim().isNotEmpty).join(' - '),
                ),
                onTap: () => Navigator.of(context).pop(candidate),
              ),
          ],
        ),
      ),
    );
  }

  void _applyParsedOrder(DictatedOrderParseResult parsed) {
    final row = widget.row;
    if (parsed.dose.isNotEmpty) {
      row.doseCtrl.text = parsed.dose;
      row.dictatedFields.add('dose');
    }
    if (parsed.route != null && _routeOptions.containsKey(parsed.route)) {
      row.route = parsed.route!;
      row.dictatedFields.add('route');
    }
    if (parsed.doseTimes.isNotEmpty) {
      row.selectedTimes
        ..clear()
        ..addAll(parsed.doseTimes);
      row.dictatedFields.add('frequency');
    }
    if (parsed.foodTiming != null &&
        _foodOptions.containsKey(parsed.foodTiming)) {
      row.foodTiming = parsed.foodTiming!;
      row.dictatedFields.add(parsed.foodTiming == 'prn' ? 'prn' : 'food');
    }

    final notes = <String>[
      if (parsed.notes.isNotEmpty) parsed.notes,
      if (parsed.durationDays != null)
        AppStrings.of(context)
            .drugChartDictatedDurationNote(parsed.durationDays!),
    ].join('\n');
    if (notes.trim().isNotEmpty) {
      _appendController(row.notesCtrl, notes);
      row.dictatedFields.add(
        parsed.durationDays != null ? 'duration' : 'notes',
      );
    }
  }

  void _appendController(TextEditingController controller, String text) {
    final existing = controller.text.trimRight();
    final glue = existing.isEmpty ? '' : '\n';
    final next = '$existing$glue${text.trim()}';
    controller.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: next.length),
    );
  }

  String _dictatedFieldLabel(AppStrings s, String field) {
    return switch (field) {
      'drug' => s.drugChartColumnDrug,
      'dose' => s.drugChartColumnDose,
      'route' => s.drugChartColumnRoute,
      'frequency' => s.ordersFrequency,
      'food' => s.drugChartColumnFood,
      'prn' => s.drugChartFoodPrn,
      'duration' => s.prescriptionsDuration,
      'notes' => s.drugChartNotesLabel,
      _ => field,
    };
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final row = widget.row;
    return FocusTraversalGroup(
      child: Container(
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
              child: DrugCatalogSearchField(
                controller: row.drugCtrl,
                onAvailabilityChanged: (unavailable) {
                  row.catalogUnavailable = unavailable;
                },
                onTextChanged: (value) => setState(() {
                  row.clearCatalogIdentity();
                  _applyDerivedDose(value);
                }),
                onSelected: (catalogRow) => setState(() {
                  row.applyCatalogRow(catalogRow);
                  row.applyDerivedDose(overwrite: true);
                }),
              ),
            ),
            _tableCell(
              width: _doseCol,
              height: _draftRowHeight,
              child: TextField(
                controller: row.doseCtrl,
                keyboardType: TextInputType.text,
                textInputAction: TextInputAction.next,
                onSubmitted: (_) => _focusNextField(),
                onChanged: (value) =>
                    _handleNewline(row.doseCtrl, value, _focusNextField),
                minLines: 1,
                maxLines: 2,
                decoration: InputDecoration(
                  labelText: s.drugChartColumnDose,
                  hintText: s.drugChartDoseHint,
                  helperText: s.drugChartDoseHelper,
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
                decoration: InputDecoration(
                  labelText: s.drugChartColumnRoute,
                  isDense: true,
                ),
                items: _routeOptions.entries
                    .map(
                      (entry) => DropdownMenuItem(
                        value: entry.key,
                        child: Text(_routeLabel(s, entry.key)),
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
                  AppText(
                    's4.lib.drug_chart.starts_today',
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w700,
                      fontSize: 13,
                    ),
                  ),
                  const SizedBox(height: 4),
                  AppText(
                    's4.lib.drug_chart.active_until_stopped',
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 12,
                    ),
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
                decoration: InputDecoration(
                  labelText: s.drugChartColumnFood,
                  isDense: true,
                ),
                items: _foodOptions.entries
                    .map(
                      (entry) => DropdownMenuItem(
                        value: entry.key,
                        child: Text(_foodLabel(s, entry.key)),
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
                    keyboardType: TextInputType.text,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _saveFromField(),
                    onChanged: (value) =>
                        _handleNewline(row.notesCtrl, value, _saveFromField),
                    minLines: 1,
                    maxLines: 2,
                    decoration: InputDecoration(
                      labelText: s.drugChartNotesLabel,
                      hintText: s.drugChartNotesHint,
                      isDense: true,
                      suffixIcon: VoiceDictateButton(
                        controller: row.dictationCtrl,
                        patientUid: _text(widget.patientUid).isEmpty
                            ? null
                            : widget.patientUid,
                        admissionId: widget.admissionId,
                        onTranscript: _applyDictatedOrder,
                      ),
                    ),
                  ),
                  const SizedBox(height: 6),
                  if (row.dictatedFields.isNotEmpty ||
                      _text(row.rawDictation).isNotEmpty) ...[
                    _DictationProvenance(
                      fields: row.dictatedFields,
                      rawTranscript: row.rawDictation,
                      fieldLabel: (field) => _dictatedFieldLabel(s, field),
                    ),
                    const SizedBox(height: 6),
                  ],
                  Align(
                    alignment: Alignment.centerLeft,
                    child: FilterChip(
                      visualDensity: VisualDensity.compact,
                      label: Text(s.drugChartDawLabel),
                      selected: row.daw,
                      onSelected: row.saving
                          ? null
                          : (value) => setState(() => row.daw = value),
                    ),
                  ),
                  const SizedBox(height: 6),
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
                                ? AppStrings.of(context).drugChartSaving
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
      ),
    );
  }
}

class _DictationProvenance extends StatelessWidget {
  final Set<String> fields;
  final String? rawTranscript;
  final String Function(String field) fieldLabel;

  const _DictationProvenance({
    required this.fields,
    required this.rawTranscript,
    required this.fieldLabel,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final raw = _text(rawTranscript);
    return SizedBox(
      height: raw.isEmpty ? 30 : 56,
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              spacing: 4,
              runSpacing: 4,
              children: fields
                  .map(
                    (field) => _MiniPill(
                      label: s.drugChartDictatedField(fieldLabel(field)),
                      color: AppTheme.primaryBlue,
                    ),
                  )
                  .toList(growable: false),
            ),
            if (raw.isNotEmpty)
              Theme(
                data: Theme.of(context)
                    .copyWith(dividerColor: Colors.transparent),
                child: ExpansionTile(
                  dense: true,
                  tilePadding: EdgeInsets.zero,
                  childrenPadding: EdgeInsets.zero,
                  title: Text(
                    s.drugChartRawDictation,
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                  children: [
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        raw,
                        style: TextStyle(
                          color: AppTheme.textSecondary,
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

typedef DrugCatalogSearch = Future<List<Map<String, dynamic>>> Function(
  String query,
);

class DrugCatalogSearchField extends StatefulWidget {
  final TextEditingController controller;
  final ValueChanged<String>? onTextChanged;
  final ValueChanged<bool>? onAvailabilityChanged;
  final ValueChanged<Map<String, dynamic>> onSelected;
  final DrugCatalogSearch search;

  const DrugCatalogSearchField({
    super.key,
    required this.controller,
    this.onTextChanged,
    this.onAvailabilityChanged,
    required this.onSelected,
    DrugCatalogSearch? search,
  }) : search = search ?? MedicalApiService.searchMedicationCatalog;

  @override
  State<DrugCatalogSearchField> createState() => _DrugCatalogSearchFieldState();
}

class _DrugCatalogSearchFieldState extends State<DrugCatalogSearchField> {
  final _focusNode = FocusNode();
  var _searchGeneration = 0;
  bool _loading = false;
  bool _catalogUnavailable = false;

  void _updateSearchState({
    required bool loading,
    required bool catalogUnavailable,
  }) {
    final availabilityChanged = _catalogUnavailable != catalogUnavailable;
    setState(() {
      _loading = loading;
      _catalogUnavailable = catalogUnavailable;
    });
    if (availabilityChanged) {
      widget.onAvailabilityChanged?.call(catalogUnavailable);
    }
  }

  @override
  void dispose() {
    _focusNode.dispose();
    super.dispose();
  }

  Future<Iterable<Map<String, dynamic>>> _optionsFor(
    TextEditingValue value,
  ) async {
    final generation = ++_searchGeneration;
    final query = value.text.trim();
    if (query.length < 2) {
      if (mounted) {
        _updateSearchState(loading: false, catalogUnavailable: false);
      }
      return const <Map<String, dynamic>>[];
    }
    if (mounted) {
      _updateSearchState(loading: true, catalogUnavailable: false);
    }
    await Future<void>.delayed(const Duration(milliseconds: 250));
    if (generation != _searchGeneration) {
      return const <Map<String, dynamic>>[];
    }
    try {
      final rows = await widget.search(query);
      if (!mounted || generation != _searchGeneration) {
        return const <Map<String, dynamic>>[];
      }
      _updateSearchState(loading: false, catalogUnavailable: false);
      return _matchingOptions(rows, query);
    } catch (_) {
      if (!mounted || generation != _searchGeneration) {
        return const <Map<String, dynamic>>[];
      }
      _updateSearchState(loading: false, catalogUnavailable: true);
      return const <Map<String, dynamic>>[];
    }
  }

  Iterable<Map<String, dynamic>> _matchingOptions(
    Iterable<Map<String, dynamic>> suggestions,
    String query,
  ) {
    final rows = <Map<String, dynamic>>[];
    final seen = <String>{};

    void add(Map<String, dynamic> row) {
      final label = _catalogDrugLabel(row);
      if (label.isEmpty || _catalogIdFromRow(row) == null) return;
      if (seen.add(label.toLowerCase())) rows.add(row);
    }

    for (final row in suggestions) {
      if (_catalogRowMatchesQuery(row, query)) add(row);
    }
    return rows.take(6);
  }

  @override
  Widget build(BuildContext context) {
    return RawAutocomplete<Map<String, dynamic>>(
      textEditingController: widget.controller,
      focusNode: _focusNode,
      displayStringForOption: _catalogDrugLabel,
      optionsBuilder: _optionsFor,
      onSelected: (row) {
        final label = _catalogDrugLabel(row);
        widget.controller.text = label;
        widget.controller.selection = TextSelection.collapsed(
          offset: label.length,
        );
        widget.onSelected(row);
      },
      fieldViewBuilder: (context, controller, focusNode, onSubmitted) {
        return TextField(
          controller: controller,
          focusNode: focusNode,
          onChanged: widget.onTextChanged,
          textInputAction: TextInputAction.next,
          onSubmitted: (_) {
            onSubmitted();
            FocusScope.of(context).nextFocus();
          },
          style: TextStyle(color: AppTheme.textPrimary, fontSize: 13),
          decoration: InputDecoration(
            labelText: AppStrings.of(context).lookup('drug_chart.column.drug'),
            hintText: AppStrings.of(context)
                .lookup('s4.lib.prescriptions.type_drug_name'),
            helperText: _catalogUnavailable
                ? AppStrings.of(context)
                      .lookup('s4.lib.drug_chart.catalog_unavailable')
                : null,
            helperMaxLines: 2,
            errorText: _catalogUnavailable
                ? AppStrings.of(context)
                      .lookup('s4.lib.drug_chart.catalog_unavailable_short')
                : null,
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
        if (optionList.isEmpty) return const SizedBox.shrink();
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
                  final row = optionList[index];
                  final name = _catalogDrugLabel(row);
                  final generic = _rowText(row, const [
                    'generic_name',
                    'generic',
                  ]);
                  final strength = _catalogStrength(row);
                  final form = _catalogForm(row);
                  final s = AppStrings.of(context);
                  final availability = _text(row['availability_status'])
                      .toLowerCase();
                  final stockColor = availability == 'may_be_available'
                      ? AppTheme.warningOnSurface
                      : _isCatalogRowInStock(row)
                      ? AppTheme.successOnSurface
                      : AppTheme.errorOnSurface;
                  return ListTile(
                    dense: true,
                    title: Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: AppTheme.textPrimary),
                    ),
                    subtitle: Text(
                      [
                        if (generic.isNotEmpty) generic,
                        if (strength.isNotEmpty) strength,
                        if (form.isNotEmpty) form,
                      ].join(' - '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppTheme.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                    trailing: _MiniPill(
                      label: _catalogStockLabel(s, row),
                      color: stockColor,
                    ),
                    onTap: () => onSelected(row),
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
    final s = AppStrings.of(context);
    return _tableCell(
      width: width,
      height: _orderRowHeight,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            s.drugChartStartedOn(formatDrugChartDate(startedAt)),
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontWeight: FontWeight.w700,
              fontSize: 13,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            s.drugChartStartedBy(startedBy),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
          ),
          if (showAntibioticDay && startedAt != null) ...[
            const SizedBox(height: 8),
            _MiniPill(
              label: s.drugChartAntibioticDay(antibioticDay(startedAt!)),
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
    final s = AppStrings.of(context);
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
          _MiniPill(
            label: s.drugChartSafetyClear,
            color: AppTheme.successOnSurface,
          ),
        const SizedBox(height: 8),
        Text(
          [
            if (nextDue.isNotEmpty)
              s.drugChartNextDue(
                _timeLabel(
                  _dateTime(nextDue.first['scheduled_time']),
                  notTimedLabel: s.lookup('s4.lib.drug_chart.not_timed'),
                ),
              ),
            s.drugChartGivenCount(given),
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
  final dictationCtrl = TextEditingController();
  final selectedTimes = <String>{'08:00', '20:00'};
  final dictatedFields = <String>{};
  String? rawDictation;
  String? lastAutoDose;
  int? catalogId;
  int? originalCatalogId;
  int? compositionId;
  String? compositionLabel;
  String? compositionConfidence;
  String? genericName;
  String? strength;
  String? strengthKey;
  String? form;
  String? formKey;
  String? releaseKey;
  String route = 'oral';
  String foodTiming = '';
  bool saving = false;
  bool daw = false;
  bool catalogUnavailable = false;

  void applyDerivedDose({String? drug, bool overwrite = false}) {
    final derived = _text(strength).isNotEmpty
        ? _text(strength)
        : deriveDoseFromDrug(drug ?? drugCtrl.text);
    if (derived.isEmpty) return;
    final current = doseCtrl.text.trim();
    if (overwrite || current.isEmpty || current == lastAutoDose) {
      doseCtrl.text = derived;
      lastAutoDose = derived;
    }
  }

  void clearCatalogIdentity() {
    catalogId = null;
    originalCatalogId = null;
    compositionId = null;
    compositionLabel = null;
    compositionConfidence = null;
    genericName = null;
    strength = null;
    strengthKey = null;
    form = null;
    formKey = null;
    releaseKey = null;
  }

  void applyCatalogRow(Map<String, dynamic> row, {int? originalCatalogId}) {
    final label = _catalogDrugLabel(row);
    drugCtrl.text = label;
    drugCtrl.selection = TextSelection.collapsed(offset: label.length);

    catalogId = _catalogIdFromRow(row);
    this.originalCatalogId = originalCatalogId ?? catalogId;
    compositionId = _asInt(row['composition_id']);
    compositionLabel = _nullableText(row['composition_label']);
    compositionConfidence = _nullableText(row['composition_confidence']);
    genericName = _nullableText(
      _rowText(row, const ['generic_name', 'generic']),
    );
    strength = _nullableText(_catalogStrength(row));
    strengthKey = _nullableText(row['strength_key']);
    form = _nullableText(_catalogForm(row));
    formKey = _nullableText(row['form_key']);
    releaseKey = _nullableText(row['release_key']);

    final catalogRoute = _catalogRoute(row);
    if (catalogRoute != null) route = catalogRoute;
  }

  void dispose() {
    drugCtrl.dispose();
    doseCtrl.dispose();
    notesCtrl.dispose();
    dictationCtrl.dispose();
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
const double _draftRowHeight = 220;
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

String? _nullableText(Object? value) {
  final text = value?.toString().trim() ?? '';
  if (text.isEmpty || text.toLowerCase() == 'null') return null;
  return text;
}

String _rowText(Map<String, dynamic> row, List<String> keys) {
  for (final key in keys) {
    final text = _text(row[key]);
    if (text.isNotEmpty) return text;
  }
  return '';
}

int _catalogStockCount(Map<String, dynamic> row) {
  final value = row['stock_quantity'] ?? row['stock'] ?? row['quantity'];
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

bool _isCatalogRowInStock(Map<String, dynamic> row) {
  final availability = _text(row['availability_status']).toLowerCase();
  if (availability == 'in_stock' || availability == 'may_be_available') {
    return true;
  }
  final explicit = row['in_stock'] ?? row['is_available'];
  if (explicit is bool && explicit == false) return false;
  return _catalogStockCount(row) > 0 || explicit == true;
}

String _catalogStockLabel(AppStrings s, Map<String, dynamic> row) {
  final availability = _text(row['availability_status']).toLowerCase();
  if (availability == 'may_be_available') {
    return s.lookup('s4.lib.drug_chart.may_be_available');
  }
  final count = _catalogStockCount(row);
  if (!_isCatalogRowInStock(row)) {
    return s.lookup('s4.lib.drug_chart.out_of_stock');
  }
  return count > 0
      ? s.format('s4.dynamic.drug_chart.in_stock_count', {'count': count})
      : s.lookup('s4.lib.drug_chart.in_stock');
}

int? _catalogIdFromRow(Map<String, dynamic> row) {
  return _asInt(row['catalog_id']) ?? _asInt(row['id']);
}

String _catalogDrugLabel(Map<String, dynamic> row) {
  return _text(
    row['name'],
    fallback: _text(
      row['drug_name'],
      fallback: _text(row['medicine_name'], fallback: _text(row['label'])),
    ),
  );
}

String _catalogStrength(Map<String, dynamic> row) {
  final direct = _text(row['strength']);
  if (direct.isNotEmpty) return direct;
  final options = row['strength_options'];
  if (options is List) {
    for (final value in options) {
      final text = _text(value);
      if (text.isNotEmpty) return text;
    }
  }
  return deriveDoseFromDrug(_catalogDrugLabel(row));
}

String _catalogForm(Map<String, dynamic> row) {
  return _rowText(row, const ['form', 'dosage_form', 'medicine_type']);
}

String? _catalogRoute(Map<String, dynamic> row) {
  final raw = _nullableText(row['route'])?.toLowerCase();
  const aliases = {
    'po': 'oral',
    'oral': 'oral',
    'iv': 'iv',
    'intravenous': 'iv',
    'im': 'im',
    'intramuscular': 'im',
    'sc': 'sc',
    'subcutaneous': 'sc',
    'sl': 'sublingual',
    'sublingual': 'sublingual',
    'inhaled': 'inhaled',
    'inhalation': 'inhaled',
    'topical': 'topical',
  };
  final route = aliases[raw];
  if (route != null && _routeOptions.containsKey(route)) return route;

  final form = _catalogForm(row).toLowerCase();
  if (form.contains('inj') || form.contains('infusion')) return 'iv';
  if (form.contains('tablet') ||
      form.contains('capsule') ||
      form.contains('syrup') ||
      form.contains('suspension')) {
    return 'oral';
  }
  if (form.contains('inhaler')) return 'inhaled';
  if (form.contains('cream') || form.contains('ointment')) return 'topical';
  return null;
}

List<String> _catalogSearchTokens(Object? value) {
  final text = value?.toString().toLowerCase() ?? '';
  return RegExp(r'[a-z0-9]+')
      .allMatches(text)
      .map((match) => match.group(0) ?? '')
      .where((token) => token.isNotEmpty)
      .toList(growable: false);
}

bool _catalogRowMatchesQuery(Map<String, dynamic> row, String query) {
  final queryTokens = _catalogSearchTokens(query);
  if (queryTokens.isEmpty) return true;
  final fieldTokens = <String>[
    ..._catalogSearchTokens(_catalogDrugLabel(row)),
    ..._catalogSearchTokens(_rowText(row, const ['generic_name', 'generic'])),
    ..._catalogSearchTokens(_catalogStrength(row)),
    ..._catalogSearchTokens(_catalogForm(row)),
  ];
  return queryTokens.every(
    (queryToken) =>
        fieldTokens.any((fieldToken) => fieldToken.startsWith(queryToken)),
  );
}

DateTime? _dateTime(Object? value) {
  if (value == null) return null;
  try {
    return DateTime.parse(value.toString()).toLocal();
  } catch (_) {
    return null;
  }
}

String _timeLabel(DateTime? value, {String notTimedLabel = ''}) {
  if (value == null) return notTimedLabel;
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

String _doseSlotLabel(AppStrings s, _DoseSlot slot) {
  return switch (slot.key) {
    'morning' => s.drugChartDoseMorning,
    'afternoon' => s.drugChartDoseAfternoon,
    'evening' => s.drugChartDoseEvening,
    'night' => s.drugChartDoseNight,
    _ => slot.label,
  };
}

String _routeLabel(AppStrings s, String route) {
  if (route.isEmpty) return '-';
  return switch (route.toLowerCase()) {
    'oral' => s.drugChartRouteOral,
    'iv' => s.drugChartRouteIv,
    'im' => s.drugChartRouteIm,
    'sc' => s.drugChartRouteSc,
    'sublingual' => s.drugChartRouteSl,
    'inhaled' => s.drugChartRouteInhaled,
    'topical' => s.drugChartRouteTopical,
    _ => _routeOptions[route.toLowerCase()] ?? route,
  };
}

String _foodLabel(AppStrings s, String value) {
  return switch (value.toLowerCase()) {
    '' => s.drugChartFoodNone,
    'before_food' => s.drugChartFoodBefore,
    'after_food' => s.drugChartFoodAfter,
    'with_food' => s.drugChartFoodWith,
    'empty_stomach' => s.drugChartFoodEmptyStomach,
    'bedtime' => s.drugChartFoodBedtime,
    'prn' => s.drugChartFoodPrn,
    _ => _foodOptions[value] ?? _foodOptions[value.toLowerCase()] ?? '-',
  };
}

String _displayDose(Map<String, dynamic> details, String medicationName) {
  final explicit = _text(details['dose'], fallback: _text(details['dosage']));
  if (explicit.isNotEmpty) return explicit;
  return deriveDoseFromDrug(medicationName);
}
