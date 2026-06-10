// lib/features/emr/screens/order_composer_screen.dart
//
// CPOE order composer (roadmap E1). Epic-style basket flow on top of the
// existing backend CPOE surface — no backend changes:
//
//   * searchable catalog type-ahead (pharmacy formulary via
//     GET /pharmacy-orders/catalog + investigation/imaging catalog via
//     GET /investigations/catalog) feeding type-specific forms,
//   * one-tap order sets (productivity clinical_order_sets browsed via
//     OrderSetsScreen in picker mode; selected items map into drafts),
//   * inline CDS: advisory pre-check per draft (POST /emr/cds/check-order),
//     hard server blockers on submit (400 CDS_BLOCKER from
//     POST /emr/orders/bulk) surfaced through CdsBlockerModal. The bulk
//     endpoint re-runs the full safety engine server-side, so the
//     pre-check chips are advisory only — the server gate is canonical.
//   * atomic signing: every basket item lands in ONE POST /emr/orders/bulk
//     (all-or-nothing; per-item CDS runs before any row is written).
//
// Medication items are doctor-gated server-side (MEDICATION_ORDER_WRITE_ROLES
// in orderRoutes.js). The composer mirrors that gate client-side so nurses
// don't build a basket the server will reject.
//
// Pure helpers (drafts, payload builders, CDS partitioning, role gate) are
// top-level so unit tests can pin them without plugin channels — same
// pattern as vitals_chart_screen.dart / cds_allergy_blocker_test.dart.

import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/services/auth_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';
import '../../doctor/widgets/cds_blocker_modal.dart';
import '../../productivity/screens/order_sets_screen.dart';
import '../models/order_draft.dart';
import '../widgets/patient_summary_sheet.dart';

// Pure helpers (OrderDraft, payload builders, CDS partitioning, role gate)
// live in ../models/order_draft.dart so the order-sets picker and the unit
// tests can share them without importing this screen.

// ───────────────────────────────────────────────────────────────────────────
// Screen
// ───────────────────────────────────────────────────────────────────────────

class OrderComposerScreen extends StatefulWidget {
  const OrderComposerScreen({
    super.key,
    required this.patientUid,
    this.patientName,
    this.encounterId,
  });

  final String patientUid;
  final String? patientName;
  final String? encounterId;

  @override
  State<OrderComposerScreen> createState() => _OrderComposerScreenState();
}

class _OrderComposerScreenState extends State<OrderComposerScreen> {
  final List<OrderDraft> _basket = [];
  final TextEditingController _searchCtrl = TextEditingController();
  Timer? _searchDebounce;
  bool _searching = false;
  List<Map<String, dynamic>> _medResults = const [];
  List<Map<String, dynamic>> _testResults = const [];
  bool _submitting = false;
  String? _role;
  int? _blockedIndex;

  bool get _canPrescribe => canPrescribeMedicationOrders(_role);

  @override
  void initState() {
    super.initState();
    _loadRole();
  }

  Future<void> _loadRole() async {
    try {
      final role = await AuthService.getRole();
      if (mounted) setState(() => _role = role);
    } catch (_) {
      // Role unknown — leave UI permissive; the server gate is canonical.
      if (mounted) setState(() => _role = null);
    }
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  // ── Catalog search ──

  void _onSearchChanged(String value) {
    _searchDebounce?.cancel();
    final q = value.trim();
    if (q.length < 2) {
      setState(() {
        _medResults = const [];
        _testResults = const [];
        _searching = false;
      });
      return;
    }
    _searchDebounce = Timer(const Duration(milliseconds: 350), () async {
      setState(() => _searching = true);
      try {
        final results = await Future.wait([
          _canPrescribe
              ? MedicalApiService.searchMedicationCatalog(q)
              : Future.value(const <Map<String, dynamic>>[]),
          MedicalApiService.searchInvestigationCatalog(q),
        ]);
        if (!mounted || _searchCtrl.text.trim() != q) return;
        setState(() {
          _medResults = results[0];
          _testResults = results[1];
          _searching = false;
        });
      } catch (_) {
        if (!mounted) return;
        setState(() => _searching = false);
      }
    });
  }

  void _clearSearch() {
    _searchCtrl.clear();
    setState(() {
      _medResults = const [];
      _testResults = const [];
    });
  }

  // ── Basket ──

  void _addDraft(OrderDraft draft) {
    setState(() {
      _basket.add(draft);
      _blockedIndex = null;
    });
    _precheckDraft(draft);
  }

  /// Advisory CDS pre-check; chips only. The server re-runs the full safety
  /// engine at submit and is the canonical gate.
  Future<void> _precheckDraft(OrderDraft draft) async {
    if (draft.orderType != 'medication' && draft.orderType != 'investigation') {
      return; // cdsEngine.checkOrder only evaluates these two types.
    }
    setState(() => draft.checkingCds = true);
    try {
      final data = await MedicalApiService.checkOrder({
        'type': draft.orderType,
        'patient_uid': widget.patientUid,
        if (widget.encounterId != null) 'encounter_id': widget.encounterId,
        if (draft.orderType == 'medication')
          'medication_name': draft.details['medication_name'],
        if (draft.orderType == 'investigation')
          'test_name': draft.details['test_name'],
        'details': draft.details,
      });
      final alerts = data['alerts'];
      draft.cdsAlerts = alerts is List
          ? alerts.whereType<Map>().map(Map<String, dynamic>.from).toList()
          : <Map<String, dynamic>>[];
    } catch (_) {
      draft.cdsAlerts = null; // pre-check unavailable — stay silent.
    } finally {
      if (mounted) setState(() => draft.checkingCds = false);
    }
  }

  Future<void> _openOrderSets() async {
    final s = AppStrings.of(context);
    // Picker mode pops with the selected raw set items ({kind, payload});
    // mapping to drafts stays here so order_sets_screen needs no knowledge
    // of composer types.
    final items = await Navigator.of(context).push<List<Map<String, dynamic>>>(
      MaterialPageRoute(
        builder: (_) => OrderSetsScreen(
          patientUid: widget.patientUid,
          encounterId: int.tryParse(widget.encounterId ?? ''),
          composerMode: true,
        ),
      ),
    );
    if (items == null || items.isEmpty || !mounted) return;
    var skippedMeds = 0;
    for (final item in items) {
      final draft = orderDraftFromSetItem(item);
      if (draft == null) continue; // note/other — not placeable.
      if (draft.orderType == 'medication' && !_canPrescribe) {
        skippedMeds++;
        continue;
      }
      _addDraft(draft);
    }
    if (skippedMeds > 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.composerMedItemsSkipped(skippedMeds)),
          backgroundColor: AppTheme.warningAmber,
        ),
      );
    }
  }

  // ── Submit ──

  Future<void> _submit() async {
    if (_basket.isEmpty || _submitting) return;
    final s = AppStrings.of(context);
    setState(() {
      _submitting = true;
      _blockedIndex = null;
    });
    try {
      final items = [
        for (final d in _basket)
          buildBulkOrderItem(
            d,
            patientUid: widget.patientUid,
            encounterId: widget.encounterId,
          ),
      ];
      final resp = await MedicalApiService.createEmrOrdersBulkRaw(items);
      if (!mounted) return;
      if (resp.isSuccess) {
        // Each created entry is { order, cds_warnings } — aggregate warnings.
        final created = resp.dataAsList();
        final warnings = <dynamic>[];
        for (final e in created) {
          if (e is Map && e['cds_warnings'] is List) {
            warnings.addAll(e['cds_warnings'] as List);
          }
        }
        if (warnings.isNotEmpty) {
          await _showSubmitWarnings(warnings);
        }
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.composerPlacedToast(_basket.length)),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        Navigator.of(context).pop(true);
        return;
      }
      // Failure paths — keep the basket so the doctor can adjust.
      final raw = resp.raw;
      if (isDeviceWriteGate(raw)) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              (raw as Map)['code'] == 'DEVICE_TYPE_MISSING'
                  ? s.composerRelogin
                  : s.composerDesktopOnly,
            ),
            backgroundColor: AppTheme.errorRed,
          ),
        );
        return;
      }
      final cds = parseCdsBlockerDetails(raw);
      if (cds.blockers.isNotEmpty) {
        setState(() => _blockedIndex = cds.orderIndex);
        await CdsBlockerModal.show(
          context,
          blockers: cds.blockers,
          warnings: cds.warnings,
          allowOverride: false,
        );
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(resp.message ?? s.composerSubmitFailed),
          backgroundColor: AppTheme.errorRed,
        ),
      );
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _showSubmitWarnings(List<dynamic> warnings) {
    final s = AppStrings.of(context);
    return showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Row(
          children: [
            const Icon(Icons.warning_amber, color: AppTheme.warningAmber),
            const SizedBox(width: 8),
            Expanded(child: Text(s.composerWarningsTitle)),
          ],
        ),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final w in warnings)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    w is Map
                        ? (w['message'] ?? w['description'] ?? w['title'] ?? w)
                              .toString()
                        : '$w',
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
            ],
          ),
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(s.actionClose),
          ),
        ],
      ),
    );
  }

  // ── Forms (pre-filled or blank) ──

  Future<void> _openDraftForm(OrderDraft draft, {int? editIndex}) async {
    _clearSearch();
    final result = await showModalBottomSheet<OrderDraft>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => _OrderDraftFormSheet(draft: draft),
    );
    if (result == null || !mounted) return;
    if (editIndex != null) {
      setState(() {
        _basket[editIndex] = result;
        _blockedIndex = null;
      });
      _precheckDraft(result);
    } else {
      _addDraft(result);
    }
  }

  // ── Build ──

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final hasResults = _medResults.isNotEmpty || _testResults.isNotEmpty;
    return StaffScaffold(
      title: widget.patientName == null
          ? s.composerTitle
          : s.composerTitleWithName(widget.patientName!),
      actions: [
        // One-tap summary while composing — allergies and active meds
        // are exactly what a prescriber wants mid-order (roadmap E5).
        IconButton(
          tooltip: s.summaryTooltip,
          icon: const Icon(Icons.assignment_ind_outlined),
          onPressed: () => PatientSummarySheet.show(
            context,
            patientUid: widget.patientUid,
            patientName: widget.patientName,
          ),
        ),
      ],
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
            child: Semantics(
              textField: true,
              label: s.composerSearchLabel,
              child: TextField(
                controller: _searchCtrl,
                onChanged: _onSearchChanged,
                decoration: InputDecoration(
                  hintText: _canPrescribe
                      ? s.composerSearchHint
                      : s.composerSearchHintTestsOnly,
                  prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
                  suffixIcon: _searchCtrl.text.isEmpty
                      ? null
                      : IconButton(
                          tooltip: s.actionClose,
                          icon: const Icon(Icons.close),
                          onPressed: _clearSearch,
                        ),
                  border: const OutlineInputBorder(),
                  isDense: true,
                ),
              ),
            ),
          ),
          if (_searching) const LinearProgressIndicator(minHeight: 2),
          Expanded(
            child: hasResults ? _buildSearchResults(s) : _buildBasketArea(s),
          ),
          Material(
            elevation: 8,
            color: AppTheme.cardSurface,
            child: SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        s.composerBasketCount(_basket.length),
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                    FilledButton.icon(
                      onPressed: _basket.isEmpty || _submitting
                          ? null
                          : _submit,
                      icon: _submitting
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.task_alt),
                      label: Text(
                        _submitting
                            ? s.composerPlacing
                            : s.composerPlaceOrders(_basket.length),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSearchResults(AppStrings s) {
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      children: [
        if (_medResults.isNotEmpty) ...[
          _sectionHeader(s.composerSectionMedications, Icons.medication),
          for (final row in _medResults.take(8))
            _catalogTile(
              icon: Icons.medication,
              color: const Color(0xFFE65100),
              title: (row['name'] ?? row['medication_name'] ?? '—').toString(),
              subtitle: [
                row['generic_name'],
                row['strength'],
                row['form'],
              ].where((e) => e != null && '$e'.isNotEmpty).join(' · '),
              onTap: () => _openDraftForm(orderDraftFromMedCatalogRow(row)),
            ),
        ],
        if (_testResults.isNotEmpty) ...[
          _sectionHeader(s.composerSectionInvestigations, Icons.biotech),
          for (final row in _testResults.take(8))
            _catalogTile(
              icon: Icons.biotech,
              color: const Color(0xFF558B2F),
              title: (row['name'] ?? '—').toString(),
              subtitle: [
                row['code'],
                row['category'],
                if (row['requires_fasting'] == true) s.ordersFastingRequired,
              ].where((e) => e != null && '$e'.isNotEmpty).join(' · '),
              onTap: () => _openDraftForm(orderDraftFromTestCatalogRow(row)),
            ),
        ],
      ],
    );
  }

  Widget _sectionHeader(String label, IconData icon) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 10, 4, 6),
      child: Row(
        children: [
          Icon(icon, size: 16, color: AppTheme.textSecondary),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: AppTheme.textSecondary,
            ),
          ),
        ],
      ),
    );
  }

  Widget _catalogTile({
    required IconData icon,
    required Color color,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
  }) {
    return Card(
      margin: const EdgeInsets.only(bottom: 6),
      child: ListTile(
        dense: true,
        leading: CircleAvatar(
          radius: 16,
          backgroundColor: color.withValues(alpha: 0.15),
          child: Icon(icon, size: 16, color: color),
        ),
        title: Text(title, style: const TextStyle(fontSize: 14)),
        subtitle: subtitle.isEmpty
            ? null
            : Text(subtitle, style: const TextStyle(fontSize: 12)),
        trailing: const Icon(Icons.add_circle_outline, size: 20),
        onTap: onTap,
      ),
    );
  }

  Widget _buildBasketArea(AppStrings s) {
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      children: [
        _buildQuickAddRow(s),
        const SizedBox(height: 8),
        if (_basket.isEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 64),
            child: Column(
              children: [
                Icon(Icons.playlist_add, size: 64, color: AppTheme.divider),
                const SizedBox(height: 12),
                Text(
                  s.composerEmptyBasket,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          )
        else
          for (var i = 0; i < _basket.length; i++) _draftCard(s, i),
      ],
    );
  }

  Widget _buildQuickAddRow(AppStrings s) {
    final chips = <Widget>[
      ActionChip(
        avatar: const Icon(Icons.dashboard_customize, size: 16),
        label: Text(s.composerOrderSets),
        onPressed: _openOrderSets,
      ),
      if (_canPrescribe)
        ActionChip(
          avatar: const Icon(Icons.medication, size: 16),
          label: Text(s.ordersTypeMedication),
          onPressed: () =>
              _openDraftForm(OrderDraft(orderType: 'medication', details: {})),
        ),
      ActionChip(
        avatar: const Icon(Icons.biotech, size: 16),
        label: Text(s.ordersTypeInvestigation),
        onPressed: () =>
            _openDraftForm(OrderDraft(orderType: 'investigation', details: {})),
      ),
      ActionChip(
        avatar: const Icon(Icons.camera_alt, size: 16),
        label: Text(s.composerTypeRadiology),
        onPressed: () =>
            _openDraftForm(OrderDraft(orderType: 'radiology', details: {})),
      ),
      ActionChip(
        avatar: const Icon(Icons.people_alt, size: 16),
        label: Text(s.composerTypeConsult),
        onPressed: () =>
            _openDraftForm(OrderDraft(orderType: 'consultation', details: {})),
      ),
      ActionChip(
        avatar: const Icon(Icons.medical_services, size: 16),
        label: Text(s.ordersTypeNursing),
        onPressed: () =>
            _openDraftForm(OrderDraft(orderType: 'nursing', details: {})),
      ),
      ActionChip(
        avatar: const Icon(Icons.restaurant, size: 16),
        label: Text(s.composerTypeDiet),
        onPressed: () =>
            _openDraftForm(OrderDraft(orderType: 'diet', details: {})),
      ),
    ];
    return Wrap(spacing: 6, runSpacing: 6, children: chips);
  }

  Widget _draftCard(AppStrings s, int index) {
    final draft = _basket[index];
    final blocked = _blockedIndex == index;
    final precheck = classifyPrecheckAlerts(draft.cdsAlerts ?? const []);
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      shape: blocked
          ? RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
              side: const BorderSide(color: AppTheme.errorRed, width: 1.5),
            )
          : null,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 6, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        draft.title,
                        style: const TextStyle(
                          fontWeight: FontWeight.w600,
                          fontSize: 14,
                        ),
                      ),
                      if (draft.subtitle.isNotEmpty)
                        Text(
                          draft.subtitle,
                          style: TextStyle(
                            fontSize: 12,
                            color: AppTheme.textSecondary,
                          ),
                        ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: s.actionEdit,
                  icon: const Icon(Icons.edit_outlined, size: 19),
                  onPressed: () => _openDraftForm(
                    OrderDraft(
                      orderType: draft.orderType,
                      details: Map<String, dynamic>.from(draft.details),
                      priority: draft.priority,
                      notes: draft.notes,
                      source: draft.source,
                    ),
                    editIndex: index,
                  ),
                ),
                IconButton(
                  tooltip: s.composerRemoveItem,
                  icon: const Icon(Icons.delete_outline, size: 19),
                  onPressed: () => setState(() {
                    _basket.removeAt(index);
                    _blockedIndex = null;
                  }),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Wrap(
              spacing: 6,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                _miniChip(
                  _orderTypeLabel(s, draft.orderType),
                  AppTheme.primaryBlue,
                ),
                _miniChip(
                  _priorityLabel(s, draft.priority),
                  draft.priority == 'stat'
                      ? AppTheme.errorRed
                      : draft.priority == 'urgent'
                      ? AppTheme.warningAmber
                      : AppTheme.textSecondary,
                ),
                if (draft.source != 'manual')
                  _miniChip(
                    draft.source == 'order-set'
                        ? s.composerSourceOrderSet
                        : s.composerSourceCatalog,
                    AppTheme.accentCyan,
                  ),
                if (draft.checkingCds)
                  const SizedBox(
                    width: 12,
                    height: 12,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                for (final a in precheck.criticals)
                  _miniChip(
                    (a['title'] ?? a['type'] ?? 'CDS').toString(),
                    AppTheme.errorRed,
                    icon: Icons.error_outline,
                  ),
                for (final a in precheck.cautions)
                  _miniChip(
                    (a['title'] ?? a['type'] ?? 'CDS').toString(),
                    AppTheme.warningAmber,
                    icon: Icons.warning_amber,
                  ),
                if (blocked)
                  _miniChip(
                    s.composerBlockedChip,
                    AppTheme.errorRed,
                    icon: Icons.block,
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _miniChip(String label, Color color, {IconData? icon}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 12, color: color),
            const SizedBox(width: 3),
          ],
          Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: color,
            ),
          ),
        ],
      ),
    );
  }

  String _orderTypeLabel(AppStrings s, String type) {
    switch (type) {
      case 'medication':
        return s.composerChipMedication;
      case 'investigation':
        return s.composerChipInvestigation;
      case 'radiology':
        return s.composerTypeRadiology;
      case 'ecg':
        return 'ECG';
      case 'consultation':
        return s.composerTypeConsult;
      case 'nursing':
        return s.ordersTypeNursing;
      case 'diet':
        return s.composerTypeDiet;
      default:
        return type.toUpperCase();
    }
  }

  String _priorityLabel(AppStrings s, String priority) {
    switch (priority) {
      case 'stat':
        return s.ordersPriorityStat;
      case 'urgent':
        return s.ordersPriorityUrgent;
      case 'prn':
        return 'PRN';
      default:
        return s.ordersPriorityRoutine;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Draft form bottom sheet — type-specific fields, returns the edited draft.
// ───────────────────────────────────────────────────────────────────────────

class _OrderDraftFormSheet extends StatefulWidget {
  const _OrderDraftFormSheet({required this.draft});
  final OrderDraft draft;

  @override
  State<_OrderDraftFormSheet> createState() => _OrderDraftFormSheetState();
}

class _OrderDraftFormSheetState extends State<_OrderDraftFormSheet> {
  final _formKey = GlobalKey<FormState>();
  late final Map<String, TextEditingController> _ctrl;
  late String _priority;
  late bool _fasting;

  String get _type => widget.draft.orderType;

  @override
  void initState() {
    super.initState();
    final d = widget.draft.details;
    String txt(String key) => d[key]?.toString() ?? '';
    _ctrl = {
      'medication_name': TextEditingController(text: txt('medication_name')),
      'dose': TextEditingController(text: txt('dose')),
      'route': TextEditingController(text: txt('route')),
      'frequency': TextEditingController(text: txt('frequency')),
      'duration_days': TextEditingController(text: txt('duration_days')),
      'test_name': TextEditingController(text: txt('test_name')),
      'test_code': TextEditingController(text: txt('test_code')),
      'reason': TextEditingController(text: txt('reason')),
      'specialty': TextEditingController(text: txt('specialty')),
      'description': TextEditingController(text: txt('description')),
      'instructions': TextEditingController(text: txt('instructions')),
    };
    _priority = widget.draft.priority;
    _fasting = d['fasting_required'] == true;
  }

  @override
  void dispose() {
    for (final c in _ctrl.values) {
      c.dispose();
    }
    super.dispose();
  }

  OrderDraft _buildResult() {
    final v = <String, dynamic>{};
    switch (_type) {
      case 'medication':
        v['medication_name'] = _ctrl['medication_name']!.text.trim();
        v['dose'] = _ctrl['dose']!.text.trim();
        v['route'] = _ctrl['route']!.text.trim();
        v['frequency'] = _ctrl['frequency']!.text.trim();
        final days = int.tryParse(_ctrl['duration_days']!.text.trim());
        if (days != null && days > 0) v['duration_days'] = days;
        v['instructions'] = _ctrl['instructions']!.text.trim();
      case 'investigation':
      case 'radiology':
      case 'ecg':
        v['test_name'] = _ctrl['test_name']!.text.trim();
        v['test_code'] = _ctrl['test_code']!.text.trim();
        v['reason'] = _ctrl['reason']!.text.trim();
        if (_type == 'investigation' && _fasting) v['fasting_required'] = true;
      case 'consultation':
        v['specialty'] = _ctrl['specialty']!.text.trim();
        v['reason'] = _ctrl['reason']!.text.trim();
      default: // nursing, diet
        v['description'] = _ctrl['description']!.text.trim();
        v['frequency'] = _ctrl['frequency']!.text.trim();
        v['instructions'] = _ctrl['instructions']!.text.trim();
    }
    return OrderDraft(
      orderType: _type,
      details: v,
      priority: _priority,
      source: widget.draft.source,
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Container(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
        border: Border(top: BorderSide(color: AppTheme.divider)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Center(
                  child: Container(
                    width: 40,
                    height: 4,
                    decoration: BoxDecoration(
                      color: AppTheme.divider,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  _formTitle(s),
                  style: const TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 20),
                ..._fieldsForType(s),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _priority,
                  decoration: InputDecoration(
                    labelText: s.ordersPriority,
                    border: const OutlineInputBorder(),
                  ),
                  items: [
                    DropdownMenuItem(
                      value: 'routine',
                      child: Text(s.ordersPriorityRoutine),
                    ),
                    DropdownMenuItem(
                      value: 'urgent',
                      child: Text(s.ordersPriorityUrgent),
                    ),
                    DropdownMenuItem(
                      value: 'stat',
                      child: Text(s.ordersPriorityStat),
                    ),
                  ],
                  onChanged: (v) => setState(() => _priority = v ?? _priority),
                ),
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: () {
                      if (!_formKey.currentState!.validate()) return;
                      Navigator.of(context).pop(_buildResult());
                    },
                    icon: const Icon(Icons.playlist_add_check),
                    label: Text(s.composerAddToBasket),
                  ),
                ),
                const SizedBox(height: 12),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _formTitle(AppStrings s) {
    switch (_type) {
      case 'medication':
        return s.ordersTypeMedication;
      case 'investigation':
        return s.ordersTypeInvestigation;
      case 'radiology':
        return s.composerTypeRadiology;
      case 'ecg':
        return 'ECG';
      case 'consultation':
        return s.composerTypeConsult;
      case 'diet':
        return s.composerTypeDiet;
      default:
        return s.ordersTypeNursing;
    }
  }

  String? _required(String? v) {
    final s = AppStrings.of(context);
    return (v == null || v.trim().isEmpty) ? s.admissionRequired : null;
  }

  List<Widget> _fieldsForType(AppStrings s) {
    InputDecoration deco(String label, {String? hint}) => InputDecoration(
      labelText: label,
      hintText: hint,
      border: const OutlineInputBorder(),
    );
    switch (_type) {
      case 'medication':
        return [
          TextFormField(
            controller: _ctrl['medication_name'],
            decoration: deco(s.ordersMedicationName),
            validator: _required,
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: TextFormField(
                  controller: _ctrl['dose'],
                  decoration: deco(s.ordersDosage),
                  validator: _required,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextFormField(
                  controller: _ctrl['route'],
                  decoration: deco(s.ordersRoute, hint: s.ordersRouteHint),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: TextFormField(
                  controller: _ctrl['frequency'],
                  decoration: deco(
                    s.ordersFrequency,
                    hint: s.ordersFrequencyHint,
                  ),
                  validator: _required,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextFormField(
                  controller: _ctrl['duration_days'],
                  keyboardType: TextInputType.number,
                  decoration: deco(
                    s.composerDurationDays,
                    hint: s.ordersDurationHint,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _ctrl['instructions'],
            decoration: deco(s.ordersSpecialInstructions),
            maxLines: 2,
          ),
        ];
      case 'investigation':
      case 'radiology':
      case 'ecg':
        return [
          TextFormField(
            controller: _ctrl['test_name'],
            decoration: deco(
              _type == 'radiology'
                  ? s.composerStudyName
                  : s.ordersInvestigation,
              hint: _type == 'radiology'
                  ? s.composerStudyHint
                  : s.ordersInvestigationHint,
            ),
            validator: _required,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _ctrl['reason'],
            decoration: deco(s.ordersClinicalIndication),
            maxLines: 2,
          ),
          if (_type == 'investigation') ...[
            const SizedBox(height: 8),
            SwitchListTile(
              title: Text(s.ordersFastingRequired),
              value: _fasting,
              onChanged: (v) => setState(() => _fasting = v),
              contentPadding: EdgeInsets.zero,
            ),
          ],
        ];
      case 'consultation':
        return [
          TextFormField(
            controller: _ctrl['specialty'],
            decoration: deco(
              s.composerSpecialty,
              hint: s.composerSpecialtyHint,
            ),
            validator: _required,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _ctrl['reason'],
            decoration: deco(s.ordersClinicalIndication),
            maxLines: 2,
            validator: _required,
          ),
        ];
      default: // nursing, diet
        return [
          TextFormField(
            controller: _ctrl['description'],
            decoration: deco(
              s.ordersDescription,
              hint: _type == 'diet'
                  ? s.composerDietHint
                  : s.ordersDescriptionHint,
            ),
            validator: _required,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _ctrl['frequency'],
            decoration: deco(
              s.ordersFrequency,
              hint: s.ordersFrequencyHintNursing,
            ),
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _ctrl['instructions'],
            decoration: deco(s.ordersSpecialInstructions),
            maxLines: 2,
          ),
        ];
    }
  }
}
