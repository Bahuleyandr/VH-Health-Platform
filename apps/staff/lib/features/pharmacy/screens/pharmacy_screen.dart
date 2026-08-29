import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/services/pharmacy_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';
import '../models/pharmacy_funding_recovery.dart';
import '../services/ward_indent_role_policy.dart';
import '../widgets/dispense_substitution_sheet.dart';
import '../widgets/ward_indent_workbench.dart';

class PharmacyScreen extends StatefulWidget {
  const PharmacyScreen({super.key, this.initialTab, this.initialIndentId});

  final String? initialTab;
  final int? initialIndentId;

  @override
  State<PharmacyScreen> createState() => _PharmacyScreenState();
}

class _PharmacyScreenState extends State<PharmacyScreen> {
  List<dynamic> _allOrders = [];
  List<Map<String, dynamic>> _catalog = [];
  List<Map<String, dynamic>> _inventoryItems = [];
  List<Map<String, dynamic>> _expiryAlerts = [];
  bool _loading = true;
  bool _catalogLoading = false;
  bool _inventoryLoading = false;
  String? _error;
  String? _catalogError;
  String? _inventoryError;
  StaffRole _role = StaffRole.general;
  String _rawRole = '';
  final TextEditingController _catalogSearchCtrl = TextEditingController();
  final TextEditingController _inventorySearchCtrl = TextEditingController();
  final Map<String, IdempotencyAttempt> _controlledDeliveryWitnessAttempts = {};
  final Map<String, String> _controlledDeliveryPendingApprovals = {};
  final Map<String, String> _controlledDeliveryApprovedWitnesses = {};
  final Map<int, List<Map<String, dynamic>>> _controlledDeliveryAllocations =
      {};

  @override
  void initState() {
    super.initState();
    _loadRole();
  }

  @override
  void dispose() {
    _catalogSearchCtrl.dispose();
    _inventorySearchCtrl.dispose();
    super.dispose();
  }

  bool get _canManageFormulary =>
      _role == StaffRole.pharmacyIncharge || _role.isAdminTier;

  bool get _canWorkPharmacyOrders =>
      _role == StaffRole.pharmacy ||
      _role == StaffRole.pharmacyIncharge ||
      _role.isAdminTier;

  bool get _canPerformClinicalVerification =>
      _role == StaffRole.pharmacy || _role == StaffRole.pharmacyIncharge;

  bool get _canBreakGlassVerification => _role == StaffRole.pharmacyIncharge;

  bool get _canOpenBillingDesk =>
      RoleFeatures.getFeaturesForRawRole(_rawRole)
          .any((feature) => feature.id == 'billing_desk');

  bool get _canViewInventory =>
      _role == StaffRole.pharmacy ||
      _role == StaffRole.pharmacyIncharge ||
      _role == StaffRole.storesPurchaseIncharge ||
      _role.isAdminTier;

  bool get _canManageInventory =>
      _role == StaffRole.pharmacyIncharge ||
      _role == StaffRole.storesPurchaseIncharge ||
      _role.isAdminTier;

  bool get _canViewWardIndents =>
      WardIndentRolePolicy.canRead(rawRole: _rawRole, role: _role);

  Future<void> _loadRole() async {
    final rawRole = await ApiConfig.getRole();
    final role = StaffRole.fromString(rawRole);
    if (!mounted) return;
    setState(() {
      _role = role;
      _rawRole = rawRole;
      if (!_canWorkPharmacyOrders) _loading = false;
    });
    await Future.wait([
      _loadCatalog(),
      if (_canViewInventory) _loadInventory(),
      if (_canWorkPharmacyOrders) _loadOrders(),
    ]);
  }

  Future<void> _loadOrders() async {
    if (!_canWorkPharmacyOrders) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = null;
          _allOrders = [];
        });
      }
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final orders = await PharmacyApiService.getPharmacyOrderQueue();
      if (mounted) {
        setState(() {
          _allOrders = orders;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString().replaceFirst('Exception: ', '');
          _loading = false;
        });
      }
    }
  }

  Future<void> _loadCatalog({String? search}) async {
    setState(() {
      _catalogLoading = true;
      _catalogError = null;
    });
    try {
      final items = await PharmacyApiService.getCatalog(
        search: search ?? _catalogSearchCtrl.text,
      );
      if (mounted) {
        setState(() {
          _catalog = items;
          _catalogLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _catalogError = e.toString().replaceFirst('Exception: ', '');
          _catalogLoading = false;
        });
      }
    }
  }

  Future<void> _loadInventory({String? search}) async {
    if (!_canViewInventory) return;
    setState(() {
      _inventoryLoading = true;
      _inventoryError = null;
    });
    try {
      final results = await Future.wait([
        PharmacyApiService.getInventoryItems(
          search: search ?? _inventorySearchCtrl.text,
        ),
        PharmacyApiService.getExpiryAlerts(),
      ]);
      if (mounted) {
        setState(() {
          _inventoryItems = results[0];
          _expiryAlerts = results[1];
          _inventoryLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _inventoryError = e.toString().replaceFirst('Exception: ', '');
          _inventoryLoading = false;
        });
      }
    }
  }

  bool _isNewStatus(Object? status) {
    final value = status?.toString().toUpperCase();
    return value == 'PENDING' || value == 'PLACED';
  }

  List<dynamic> get _newOrders =>
      _allOrders.where((o) => _isNewStatus(o['status'])).toList();

  List<dynamic> get _activeOrders => _allOrders
      .where(
        (o) => [
          'CONFIRMED',
          'PREPARING',
          'READY',
          'DISPATCHED',
          'PARTIALLY_DISPENSED',
        ].contains(o['status']),
      )
      .toList();

  List<dynamic> get _completedOrders => _allOrders
      .where(
        (o) => [
          'DELIVERED',
          'DISPENSED',
          'CANCELLED',
          'UNAVAILABLE',
        ].contains(o['status']),
      )
      .toList();

  void _snack(
    String msg, {
    bool isError = false,
    String? actionLabel,
    VoidCallback? onAction,
  }) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: isError ? AppTheme.errorRed : AppTheme.successGreen,
        action: actionLabel == null || onAction == null
            ? null
            : SnackBarAction(label: actionLabel, onPressed: onAction),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  Future<void> _confirmOrder(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    final notesController = TextEditingController();
    final existingLines = ((order['items_list'] as List?) ?? const [])
        .whereType<Map>()
        .map((line) => Map<String, dynamic>.from(line))
        .toList(growable: false);
    final prescriptionBound =
        _positiveInt(order['prescription_id']) != null ||
        (_positiveInt(order['linked_prescription_count']) ?? 0) > 0;
    final manualLines = <_ManualConfirmationLine>[_ManualConfirmationLine()];

    final payload = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) => Padding(
          padding: EdgeInsets.only(
            left: 20,
            right: 20,
            top: 20,
            bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      '${s.pharmacyConfirmDialog} ${order['order_number'] ?? ''}',
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.close),
                      tooltip: s.actionClose,
                      onPressed: () => Navigator.pop(ctx),
                    ),
                  ],
                ),

                // Prescription photo
                if (order['prescription_photo_url'] != null) ...[
                  const SizedBox(height: 12),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Image.network(
                      order['prescription_photo_url'],
                      height: 180,
                      width: double.infinity,
                      fit: BoxFit.cover,
                      errorBuilder: (_, _, _) => Container(
                        height: 80,
                        color: Colors.grey.shade200,
                        child: Center(
                          child: Text(AppStrings.of(context).pharmacyNoPreview),
                        ),
                      ),
                    ),
                  ),
                ],

                if (order['order_note'] != null &&
                    order['order_note'].toString().isNotEmpty) ...[
                  const SizedBox(height: 12),
                  Text(
                    '${s.pharmacyPatientNotePrefix} ${order['order_note']}',
                    style: const TextStyle(fontStyle: FontStyle.italic),
                  ),
                ],

                const SizedBox(height: 16),
                if (prescriptionBound) ...[
                  Text(
                    s.lookup('med03.pharmacy.prescription_items_locked'),
                    style: TextStyle(color: Colors.grey.shade700),
                  ),
                  const SizedBox(height: 8),
                  for (final entry in existingLines.asMap().entries)
                    ListTile(
                      key: ValueKey('immutable-rx-line-${entry.key}'),
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.lock_outline),
                      title: Text(
                        (entry.value['name'] ??
                                entry.value['medication_name'] ??
                                s.format('med03.pharmacy.catalog_fallback', {
                                  'id': entry.value['catalog_id'],
                                }))
                            .toString(),
                      ),
                      subtitle: Text(
                        s.format('med03.pharmacy.locked_line_summary', {
                          'line': entry.value['order_line_index'],
                          'quantity':
                              entry.value['ordered_qty'] ??
                              entry.value['qty'] ??
                              entry.value['quantity'],
                        }),
                      ),
                    ),
                ] else ...[
                  Text(
                    s.lookup('med03.pharmacy.select_authoritative_catalog'),
                    style: TextStyle(color: Colors.grey.shade700),
                  ),
                  const SizedBox(height: 8),
                  for (final entry in manualLines.asMap().entries)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            flex: 3,
                            child: DropdownButtonFormField<int>(
                              key: ValueKey('manual-catalog-${entry.key}'),
                              initialValue: entry.value.catalogId,
                              isExpanded: true,
                              decoration: InputDecoration(
                                labelText: s.lookup(
                                  'med03.pharmacy.catalog_medicine',
                                ),
                                border: OutlineInputBorder(),
                              ),
                              items: _catalog
                                  .where((item) => item['id'] is num)
                                  .map(
                                    (item) => DropdownMenuItem<int>(
                                      value: (item['id'] as num).toInt(),
                                      child: Text(
                                        '${item['name'] ?? item['display_name'] ?? item['id']} '
                                        '· ₹${item['unit_price'] ?? 0}',
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                  )
                                  .toList(growable: false),
                              onChanged: (value) => setSheetState(
                                () => entry.value.catalogId = value,
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: TextField(
                              key: ValueKey('manual-quantity-${entry.key}'),
                              controller: entry.value.quantityController,
                              keyboardType:
                                  const TextInputType.numberWithOptions(
                                    decimal: true,
                                  ),
                              decoration: InputDecoration(
                                labelText: s.lookup('med03.pharmacy.quantity'),
                                border: OutlineInputBorder(),
                              ),
                            ),
                          ),
                          if (manualLines.length > 1)
                            IconButton(
                              onPressed: () => setSheetState(() {
                                final removed = manualLines.removeAt(entry.key);
                                removed.dispose();
                              }),
                              icon: const Icon(Icons.remove_circle_outline),
                            ),
                        ],
                      ),
                    ),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      key: const ValueKey('add-manual-catalog-line'),
                      onPressed: () => setSheetState(
                        () => manualLines.add(_ManualConfirmationLine()),
                      ),
                      icon: const Icon(Icons.add),
                      label: Text(s.lookup('med03.pharmacy.add_medicine')),
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                TextField(
                  controller: notesController,
                  decoration: InputDecoration(
                    labelText: AppStrings.of(context)
                        .lookup('appt_queue.notes_optional'),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
                const SizedBox(height: 20),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton.icon(
                    onPressed: () {
                      if (prescriptionBound) {
                        Navigator.pop(ctx, {
                          'confirmation_notes': notesController.text.trim(),
                        });
                        return;
                      }
                      final catalogLines = <Map<String, dynamic>>[];
                      var total = 0.0;
                      for (final entry in manualLines.asMap().entries) {
                        final catalogId = entry.value.catalogId;
                        final quantity = double.tryParse(
                          entry.value.quantityController.text.trim(),
                        );
                        Map<String, dynamic>? catalog;
                        for (final candidate in _catalog) {
                          if (_positiveInt(candidate['id']) == catalogId) {
                            catalog = candidate;
                            break;
                          }
                        }
                        final unitPrice = _number(
                          catalog?['unit_price'] ?? catalog?['price'],
                        )?.toDouble();
                        if (catalogId == null ||
                            quantity == null ||
                            quantity <= 0 ||
                            unitPrice == null ||
                            unitPrice <= 0) {
                          ScaffoldMessenger.of(ctx).showSnackBar(
                            SnackBar(
                              content: Text(
                                s.lookup(
                                  'med03.pharmacy.catalog_quantity_required',
                                ),
                              ),
                            ),
                          );
                          return;
                        }
                        catalogLines.add({
                          'order_line_index': entry.key,
                          'catalog_id': catalogId,
                          'quantity': quantity,
                        });
                        total += unitPrice * quantity;
                      }
                      Navigator.pop(ctx, {
                        'items_list': catalogLines,
                        'total_amount': double.parse(total.toStringAsFixed(2)),
                        'confirmation_notes': notesController.text.trim(),
                      });
                    },
                    icon: const Icon(Icons.check, color: Colors.white),
                    label: Text(s.pharmacyConfirmOrder),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppTheme.primaryBlue,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    for (final line in manualLines) {
      line.dispose();
    }
    notesController.dispose();
    if (payload == null) return;

    try {
      var currentPayload = payload;
      final lineCount = ((payload['items_list'] as List?) ?? const []).length;
      final maximumAttempts = lineCount + 1;
      final recoveredLines = <int>{};
      for (var attempt = 0; attempt < maximumAttempts; attempt++) {
        try {
          await PharmacyApiService.confirmPharmacyOrder(
            order['id'],
            currentPayload,
          );
          break;
        } on PharmacyApiException catch (error) {
          final lineIndex = _nonNegativeInt(error.details?['order_line_index']);
          if (lineIndex == null || !recoveredLines.add(lineIndex)) rethrow;
          final recovered = await _recoverManualCatalogSelection(
            error,
            currentPayload,
          );
          if (recovered == null) rethrow;
          currentPayload = recovered;
          if (attempt == maximumAttempts - 1) rethrow;
        }
      }
      _snack(s.pharmacyOrderConfirmedToast);
      unawaited(_loadOrders());
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  String _paymentModeLabel(AppStrings strings, String mode) =>
      strings.lookup('med03.pharmacy.payment_mode.$mode');

  String _expiryBucketLabel(AppStrings strings, Object? rawBucket) {
    final key = switch (rawBucket?.toString()) {
      'expired' => 'expired',
      '0-30' => 'within_30',
      '31-60' => 'within_60',
      '61-90' => 'within_90',
      'beyond-90' => 'beyond_90',
      _ => 'unknown',
    };
    return strings.lookup('med03.pharmacy.expiry_bucket.$key');
  }

  String _recoveryActionLabel(AppStrings strings, Object? rawAction) {
    final action = rawAction?.toString();
    return switch (action) {
      'select_exact_tpa_claim_allocation' => strings.lookup(
        'med03.pharmacy.recovery.select_exact_tpa_claim_allocation',
      ),
      'materialize_pharmacy_funding' => strings.lookup(
        'med03.pharmacy.recovery.materialize_pharmacy_funding',
      ),
      'open_exact_pharmacy_funding_task' => strings.lookup(
        'med03.pharmacy.recovery.open_exact_pharmacy_funding_task',
      ),
      'complete_manual_allergy_review' => strings.lookup(
        'med03.pharmacy.recovery.complete_manual_allergy_review',
      ),
      _ => strings.lookup('med03.pharmacy.recovery.contact_owner'),
    };
  }

  PharmacyFundingRecovery? _fundingRecovery(PharmacyApiException error) =>
      PharmacyFundingRecovery.from(error.details?['funding_recovery']);

  bool _requiresFundingRecovery(PharmacyApiException error) {
    final nextAction = error.details?['next_action']?.toString();
    return error.code == 'PHARMACY_TPA_FUNDING_REQUIRED' ||
        error.code == 'COUNTER_FUNDING_POSTED_AUTHORITY_REQUIRED' ||
        nextAction == 'select_exact_tpa_claim_allocation' ||
        nextAction == 'materialize_pharmacy_funding' ||
        nextAction == 'open_exact_pharmacy_funding_task';
  }

  void _openFundingRecovery(PharmacyFundingRecovery recovery) {
    final deepLink = recovery.deepLink;
    if (!_canOpenBillingDesk || deepLink == null) return;
    context.push(deepLink.toString());
  }

  Future<Map<String, dynamic>?> _recoverManualCatalogSelection(
    PharmacyApiException error,
    Map<String, dynamic> payload,
  ) async {
    if (error.code != 'PHARMACY_ORDER_CATALOG_RESOLUTION_REQUIRED') return null;
    final details = error.details;
    final lineIndex = _nonNegativeInt(details?['order_line_index']);
    final candidates =
        ((details?['inventory_item_candidates'] as List?) ?? const [])
            .whereType<Map>()
            .map((row) => Map<String, dynamic>.from(row))
            .where((row) => _positiveInt(row['inventory_item_id']) != null)
            .toList(growable: false);
    if (lineIndex == null || lineIndex < 0 || candidates.isEmpty || !mounted)
      return null;
    final selected = await showDialog<int>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => SimpleDialog(
        title: Text(
          AppStrings.of(context).lookup('med03.pharmacy.select_inventory_item'),
        ),
        children: candidates
            .map((candidate) {
              final id = _positiveInt(candidate['inventory_item_id'])!;
              return SimpleDialogOption(
                onPressed: () => Navigator.pop(ctx, id),
                child: Text(
                  candidate['display_name']?.toString() ??
                      AppStrings.of(context).format(
                        'med03.pharmacy.inventory_item_fallback',
                        {'id': id},
                      ),
                ),
              );
            })
            .toList(growable: false),
      ),
    );
    if (selected == null) return null;
    final recovered = Map<String, dynamic>.from(payload);
    final lines = ((payload['items_list'] as List?) ?? const [])
        .whereType<Map>()
        .map((line) => Map<String, dynamic>.from(line))
        .toList();
    if (lineIndex >= lines.length) return null;
    lines[lineIndex]['inventory_item_id'] = selected;
    recovered['items_list'] = lines;
    return recovered;
  }

  bool _verificationCleared(Map<String, dynamic> order) => const {
    'verified',
    'override',
  }.contains(order['clinical_verification_status']?.toString().toLowerCase());

  Future<void> _verifyOrder(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    if (!_canPerformClinicalVerification) {
      _snack(
        s.lookup('med03.pharmacy.verification_pharmacist_only'),
        isError: true,
      );
      return;
    }
    var decision = 'verified';
    var manualAllergyReviewCompleted = false;
    final notesController = TextEditingController();
    final overrideController = TextEditingController();
    final verificationDecisions = [
      'verified',
      if (_canBreakGlassVerification) 'override',
      'rejected',
    ];
    final verification = await showDialog<Map<String, dynamic>>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(s.lookup('med03.pharmacy.verify_order')),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                key: const ValueKey('pharmacy-verification-decision'),
                initialValue: decision,
                decoration: InputDecoration(
                  labelText: s.lookup('med03.pharmacy.verification_decision'),
                ),
                items: verificationDecisions
                    .map(
                      (value) => DropdownMenuItem(
                        value: value,
                        child: Text(
                          s.lookup('med03.pharmacy.verification_$value'),
                        ),
                      ),
                    )
                    .toList(growable: false),
                onChanged: (value) => setDialogState(() {
                  if (value != null) decision = value;
                }),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('pharmacy-verification-notes'),
                controller: notesController,
                maxLength: decision == 'rejected' ? 500 : 2000,
                decoration: InputDecoration(
                  labelText: s.lookup(
                    decision == 'rejected'
                        ? 'med03.pharmacy.verification_rejection_reason'
                        : 'med03.pharmacy.verification_notes',
                  ),
                ),
                onChanged: (_) => setDialogState(() {}),
              ),
              if (decision == 'override') ...[
                const SizedBox(height: 12),
                Text(
                  s.lookup('med03.pharmacy.verification_override_incharge'),
                  style: TextStyle(color: Colors.orange.shade900),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey('pharmacy-verification-override-reason'),
                  controller: overrideController,
                  minLines: 2,
                  maxLines: 4,
                  maxLength: 1000,
                  decoration: InputDecoration(
                    labelText: s.lookup(
                      'med03.pharmacy.verification_override_reason',
                    ),
                    helperText: s.lookup(
                      'med03.pharmacy.verification_override_reason_help',
                    ),
                  ),
                  onChanged: (_) => setDialogState(() {}),
                ),
                CheckboxListTile(
                  key: const ValueKey(
                    'pharmacy-verification-manual-allergy-review',
                  ),
                  contentPadding: EdgeInsets.zero,
                  value: manualAllergyReviewCompleted,
                  title: Text(
                    s.lookup(
                      'med03.pharmacy.verification_manual_allergy_review',
                    ),
                  ),
                  subtitle: Text(
                    s.lookup(
                      'med03.pharmacy.verification_manual_allergy_review_help',
                    ),
                  ),
                  onChanged: (value) => setDialogState(
                    () => manualAllergyReviewCompleted = value == true,
                  ),
                ),
              ],
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              key: const ValueKey('pharmacy-verification-submit'),
              onPressed:
                  (decision != 'override' ||
                          (_canBreakGlassVerification &&
                              overrideController.text.trim().length >= 10 &&
                              overrideController.text.trim().length <= 1000 &&
                              manualAllergyReviewCompleted)) &&
                      (decision != 'rejected' ||
                          (notesController.text.trim().length >= 10 &&
                              notesController.text.trim().length <= 500))
                  ? () => Navigator.pop(ctx, {
                      'decision': decision,
                      'notes': notesController.text.trim(),
                      'override_reason': overrideController.text.trim(),
                      'manual_allergy_review_completed':
                          manualAllergyReviewCompleted,
                    })
                  : null,
              child: Text(s.lookup('med03.pharmacy.submit_verification')),
            ),
          ],
        ),
      ),
    );
    notesController.dispose();
    overrideController.dispose();
    if (verification == null) return;
    try {
      await PharmacyApiService.verifyPharmacyOrder(
        (order['id'] as num).toInt(),
        decision: verification['decision']!,
        notes: verification['notes'],
        overrideReason: verification['override_reason'],
        manualAllergyReviewCompleted:
            verification['manual_allergy_review_completed'] == true,
      );
      _snack(s.lookup('med03.pharmacy.verification_complete'));
      unawaited(_loadOrders());
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _markPreparing(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    try {
      await PharmacyApiService.markPharmacyPreparing(order['id']);
      _snack(s.pharmacyMarkPreparingToast);
      unawaited(_loadOrders());
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _completeCounterDispense(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    final paymentMode =
        const {
          'cash',
          'card',
          'upi',
          'wallet',
          'insurance',
          'corporate_tpa',
        }.contains(order['payment_mode']?.toString())
        ? order['payment_mode'].toString()
        : '';
    final collected = _number(order['amount_collected']);
    final initialAmount = collected ?? 0;
    final amountController = TextEditingController(
      text: initialAmount.toString(),
    );
    final paymentMetadata = order['payment_metadata'] is Map
        ? Map<String, dynamic>.from(order['payment_metadata'] as Map)
        : const <String, dynamic>{};
    final tpaReferenceController = TextEditingController(
      text:
          (paymentMetadata['tpa_reference'] ??
                  paymentMetadata['approval_reference'] ??
                  paymentMetadata['funding_reference'] ??
                  '')
              .toString(),
    );
    final payload = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(s.lookup('med03.pharmacy.complete_counter_dispense')),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                key: const ValueKey('pharmacy-counter-payment-mode'),
                initialValue: paymentMode.isEmpty ? null : paymentMode,
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.counter_sale.payment_mode'),
                ),
                items:
                    const [
                          'cash',
                          'card',
                          'upi',
                          'wallet',
                          'insurance',
                          'corporate_tpa',
                        ]
                        .map(
                          (mode) => DropdownMenuItem(
                            value: mode,
                            child: Text(_paymentModeLabel(s, mode)),
                          ),
                        )
                        .toList(growable: false),
                onChanged: null,
              ),
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('pharmacy-counter-amount-collected'),
                controller: amountController,
                readOnly: true,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                decoration: InputDecoration(
                  labelText: s.lookup('med03.pharmacy.amount_collected'),
                  helperText: s.lookup(
                    'med03.pharmacy.authoritative_total_rechecked',
                  ),
                ),
              ),
              if (const {
                'insurance',
                'corporate_tpa',
              }.contains(paymentMode)) ...[
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey('pharmacy-counter-tpa-reference'),
                  controller: tpaReferenceController,
                  readOnly: true,
                  maxLength: 160,
                  decoration: InputDecoration(
                    labelText: s.lookup('med03.pharmacy.tpa_reference'),
                    helperText: s.lookup(
                      'med03.pharmacy.tpa_reference_exact_help',
                    ),
                  ),
                ),
              ],
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              key: const ValueKey('pharmacy-counter-complete-submit'),
              onPressed: () {
                final amount = num.tryParse(amountController.text.trim());
                if (paymentMode.isEmpty || amount == null ||
                    !amount.isFinite || amount < 0) {
                  return;
                }
                final tpaReference = tpaReferenceController.text.trim();
                if (const {
                      'insurance',
                      'corporate_tpa',
                    }.contains(paymentMode) &&
                    tpaReference.isEmpty) {
                  return;
                }
                Navigator.pop(ctx, {
                  'payment_mode': paymentMode,
                  'amount_collected': amount,
                  if (tpaReference.isNotEmpty) 'tpa_reference': tpaReference,
                });
              },
              child: Text(s.lookup('med03.pharmacy.dispense_remainder')),
            ),
          ],
        ),
      ),
    );
    amountController.dispose();
    tpaReferenceController.dispose();
    if (payload == null) return;
    try {
      await PharmacyApiService.markPharmacyCounterDispensed(
        (order['id'] as num).toInt(),
        payload,
      );
      _snack(s.lookup('med03.pharmacy.counter_dispense_complete'));
      unawaited(_loadOrders());
    } on PharmacyApiException catch (error) {
      final nextAction = error.details?['next_action']?.toString();
      final fundingTask = _fundingRecovery(error);
      final fundingRecovery = _requiresFundingRecovery(error);
      _snack(
        [
          error.toString(),
          if (nextAction != null) _recoveryActionLabel(s, nextAction),
          if (fundingTask != null) fundingTask.summary(s),
        ].join(' · '),
        isError: true,
        actionLabel:
            fundingRecovery &&
                fundingTask != null &&
                fundingTask.deepLink != null &&
                _canOpenBillingDesk
            ? s.lookup('med03.pharmacy.recovery.open_billing_desk')
            : null,
        onAction:
            fundingRecovery &&
                fundingTask != null &&
                fundingTask.deepLink != null &&
                _canOpenBillingDesk
            ? () => _openFundingRecovery(fundingTask)
            : null,
      );
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _markUnavailable(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    final reasonController = TextEditingController();
    final reason = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.lookup('med03.pharmacy.mark_unavailable')),
        content: TextField(
          key: const ValueKey('pharmacy-unavailable-reason'),
          controller: reasonController,
          maxLength: 500,
          decoration: InputDecoration(
            labelText: s.lookup('med03.pharmacy.unavailable_reason'),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () {
              final value = reasonController.text.trim();
              if (value.isNotEmpty) Navigator.pop(ctx, value);
            },
            child: Text(s.lookup('med03.pharmacy.mark_unavailable')),
          ),
        ],
      ),
    );
    reasonController.dispose();
    if (reason == null) return;
    try {
      await PharmacyApiService.markPharmacyUnavailable(
        (order['id'] as num).toInt(),
        reason: reason,
      );
      _snack(s.lookup('med03.pharmacy.unavailable_complete'));
      unawaited(_loadOrders());
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _assignFacility(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    final facilityId = _positiveInt(order['facility_recovery_target_id']);
    if (facilityId == null) {
      _snack(s.lookup('med03.pharmacy.facility_admin_required'), isError: true);
      return;
    }
    try {
      await PharmacyApiService.assignPharmacyOrderFacility(
        (order['id'] as num).toInt(),
        facilityId: facilityId,
      );
      _snack(s.lookup('med03.pharmacy.facility_assigned'));
      unawaited(_loadOrders());
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _resolveLineIdentities(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    final orderLines = ((order['items_list'] as List?) ?? const [])
        .whereType<Map>()
        .map((line) => Map<String, dynamic>.from(line))
        .toList(growable: false);
    final prescriptionLines =
        ((order['prescription_medications'] as List?) ?? const [])
            .whereType<Map>()
            .map((line) => Map<String, dynamic>.from(line))
            .toList(growable: false);
    if (orderLines.isEmpty || prescriptionLines.isEmpty) {
      _snack(
        s.lookup('med03.pharmacy.line_identity_source_missing'),
        isError: true,
      );
      return;
    }
    final selected = List<int?>.filled(orderLines.length, null);
    final mappings = await showDialog<List<Map<String, dynamic>>>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(s.lookup('med03.pharmacy.resolve_line_identities')),
          content: SizedBox(
            width: 520,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(s.lookup('med03.pharmacy.resolve_line_identity_help')),
                  const SizedBox(height: 12),
                  for (final entry in orderLines.asMap().entries)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: DropdownButtonFormField<int>(
                        key: ValueKey('legacy-line-map-${entry.key}'),
                        initialValue: selected[entry.key],
                        isExpanded: true,
                        decoration: InputDecoration(
                          labelText:
                              (entry.value['name'] ??
                                      entry.value['medication_name'] ??
                                      s.format(
                                        'med03.pharmacy.order_line_fallback',
                                        {'line': entry.key + 1},
                                      ))
                                  .toString(),
                          border: const OutlineInputBorder(),
                        ),
                        items: prescriptionLines
                            .asMap()
                            .entries
                            .map((rxEntry) {
                              final line = rxEntry.value;
                              return DropdownMenuItem<int>(
                                value: rxEntry.key,
                                child: Text(
                                  '${rxEntry.key + 1}. '
                                  '${line['name'] ?? line['medication_name'] ?? s.format('med03.pharmacy.catalog_fallback', {'id': line['catalog_id']})} '
                                  '· ${line['dose'] ?? line['strength'] ?? ''}',
                                  overflow: TextOverflow.ellipsis,
                                ),
                              );
                            })
                            .toList(growable: false),
                        onChanged: (value) =>
                            setDialogState(() => selected[entry.key] = value),
                      ),
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              key: const ValueKey('legacy-line-map-submit'),
              onPressed:
                  selected.every((value) => value != null) &&
                      selected.toSet().length == selected.length
                  ? () => Navigator.pop(
                      ctx,
                      selected
                          .asMap()
                          .entries
                          .map(
                            (entry) => {
                              'order_line_index': entry.key,
                              'prescription_line_index': entry.value,
                            },
                          )
                          .toList(growable: false),
                    )
                  : null,
              child: Text(s.lookup('med03.pharmacy.save_line_identities')),
            ),
          ],
        ),
      ),
    );
    if (mappings == null) return;
    try {
      await PharmacyApiService.resolvePharmacyOrderLineIdentities(
        (order['id'] as num).toInt(),
        lineMappings: mappings,
      );
      _snack(s.lookup('med03.pharmacy.line_identities_resolved'));
      unawaited(_loadOrders());
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _dispatchOrder(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    final orderId = (order['id'] as num).toInt();
    late final List<Map<String, dynamic>> assignees;
    try {
      assignees = await PharmacyApiService.getPharmacyDeliveryAssignees(
        orderId,
      );
    } catch (error) {
      _snack(error.toString(), isError: true);
      return;
    }
    if (!mounted) return;
    if (assignees.isEmpty) {
      _snack(
        s.lookup('med03.pharmacy.delivery_assignee_required'),
        isError: true,
      );
      return;
    }
    String? selectedUid;
    final deliveryAssigneeUid = await showDialog<String>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(s.pharmacyDispatchDialog),
          content: DropdownButtonFormField<String>(
            key: const ValueKey('pharmacy-delivery-assignee'),
            initialValue: selectedUid,
            decoration: InputDecoration(
              labelText: s.pharmacyDeliveryPersonName,
              prefixIcon: const ExcludeSemantics(child: Icon(Icons.person)),
            ),
            items: assignees
                .map(
                  (assignee) => DropdownMenuItem<String>(
                    value: assignee['uid']?.toString(),
                    child: Text(
                      [
                        assignee['name']?.toString() ?? '',
                        if ((assignee['phone']?.toString() ?? '').isNotEmpty)
                          assignee['phone'].toString(),
                      ].where((part) => part.isNotEmpty).join(' · '),
                    ),
                  ),
                )
                .toList(growable: false),
            onChanged: (value) => setDialogState(() => selectedUid = value),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text(s.actionCancel),
            ),
            ElevatedButton(
              key: const ValueKey('pharmacy-delivery-dispatch-submit'),
              onPressed: selectedUid == null
                  ? null
                  : () => Navigator.pop(ctx, selectedUid),
              child: Text(s.pharmacyDispatch),
            ),
          ],
        ),
      ),
    );
    if (deliveryAssigneeUid == null) return;

    final allocations = _controlledDeliveryAllocations.putIfAbsent(
      orderId,
      () => <Map<String, dynamic>>[],
    );
    final rawOrderLines = order['items_list'];
    final orderLineCount = rawOrderLines is List ? rawOrderLines.length : 0;
    final maximumDispatchAttempts = (orderLineCount * 2) + 1;
    final seenRecoverySteps = <String>{};
    try {
      for (
        var dispatchAttempt = 0;
        dispatchAttempt < maximumDispatchAttempts;
        dispatchAttempt++
      ) {
        try {
          await PharmacyApiService.dispatchPharmacyOrder(orderId, {
            'delivery_assignee_uid': deliveryAssigneeUid,
            if (allocations.isNotEmpty) 'dispensed_items': allocations,
          });
          _controlledDeliveryAllocations.remove(orderId);
          _clearControlledDeliveryWitnessState(orderId);
          _snack(s.pharmacyOrderDispatchedToast);
          unawaited(_loadOrders());
          return;
        } on PharmacyApiException catch (error) {
          if (error.code != 'PHARMACY_ORDER_CONTROLLED_ALLOCATION_REQUIRED' &&
              error.code != 'PHARMACY_ORDER_INVENTORY_ITEM_AMBIGUOUS') {
            throw error;
          }
          final recoveryLineIndex = _deliveryRecoveryLineIndex(error);
          if (recoveryLineIndex == null ||
              recoveryLineIndex >= orderLineCount) {
            throw StateError(
              'Controlled delivery recovery line identity is invalid',
            );
          }
          final recoveryStep = '${error.code}:$recoveryLineIndex';
          if (!seenRecoverySteps.add(recoveryStep)) {
            throw StateError(
              'Controlled delivery recovery made no authoritative progress',
            );
          }
          final allocation = switch (error.code) {
            'PHARMACY_ORDER_CONTROLLED_ALLOCATION_REQUIRED' =>
              await _collectControlledDeliveryAllocation(
                orderId: orderId,
                error: error,
              ),
            'PHARMACY_ORDER_INVENTORY_ITEM_AMBIGUOUS' =>
              await _collectAmbiguousInventoryItemSelection(error),
            _ => throw error,
          };
          if (allocation == null) return;
          final matchingAllocations = allocations.where(
            (item) =>
                item['order_line_index'] == allocation['order_line_index'],
          );
          final priorAllocation = matchingAllocations.isEmpty
              ? null
              : matchingAllocations.first;
          allocations.removeWhere(
            (item) =>
                item['order_line_index'] == allocation['order_line_index'],
          );
          allocations.add(allocation);
          if (priorAllocation != null &&
              _sameControlledDeliveryAllocation(priorAllocation, allocation)) {
            throw StateError(
              'Controlled delivery recovery made no authoritative progress',
            );
          }
        }
      }
      throw StateError(
        'Controlled delivery recovery exceeded its order-derived evidence bound',
      );
    } on PharmacyApiException catch (error) {
      if (error.statusCode >= 400 && error.statusCode < 500) {
        _controlledDeliveryAllocations.remove(orderId);
        _clearControlledDeliveryWitnessState(orderId);
      }
      final nextAction = error.details?['next_action']?.toString();
      final fundingTask = _fundingRecovery(error);
      final fundingRecovery = _requiresFundingRecovery(error);
      _snack(
        [
          error.toString(),
          if (nextAction != null) _recoveryActionLabel(s, nextAction),
          if (fundingTask != null) fundingTask.summary(s),
        ].join(' · '),
        isError: true,
        actionLabel:
            fundingRecovery &&
                fundingTask != null &&
                fundingTask.deepLink != null &&
                _canOpenBillingDesk
            ? s.lookup('med03.pharmacy.recovery.open_billing_desk')
            : null,
        onAction:
            fundingRecovery &&
                fundingTask != null &&
                fundingTask.deepLink != null &&
                _canOpenBillingDesk
            ? () => _openFundingRecovery(fundingTask)
            : null,
      );
    } catch (error) {
      _controlledDeliveryAllocations.remove(orderId);
      _clearControlledDeliveryWitnessState(orderId);
      _snack(error.toString(), isError: true);
    }
  }

  Future<void> _markDelivered(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    final tokenController = TextEditingController();
    final reasonController = TextEditingController();
    final requiresBreakGlassReason = _role == StaffRole.pharmacyIncharge;
    final evidence = await showDialog<Map<String, String>>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(s.pharmacyMarkDeliveredDialog),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              AppText(
                's4.dynamic.pharmacy.confirm_delivered',
                values: {'orderNumber': order['order_number'] ?? ''},
              ),
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('pharmacy-delivery-handoff-token'),
                controller: tokenController,
                obscureText: true,
                enableSuggestions: false,
                autocorrect: false,
                onChanged: (_) => setDialogState(() {}),
                decoration: InputDecoration(
                  labelText: s.transportVerifyHandoff,
                ),
              ),
              if (requiresBreakGlassReason) ...[
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey(
                    'pharmacy-delivery-break-glass-reason',
                  ),
                  controller: reasonController,
                  minLines: 2,
                  maxLines: 4,
                  maxLength: 500,
                  onChanged: (_) => setDialogState(() {}),
                  decoration: InputDecoration(
                    labelText: s.lookup(
                      'med03.pharmacy.verification_override_reason',
                    ),
                    helperText: s.lookup(
                      'med03.pharmacy.verification_override_reason_help',
                    ),
                  ),
                ),
              ],
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text(s.actionCancel),
            ),
            ElevatedButton(
              key: const ValueKey('pharmacy-delivery-submit'),
              onPressed:
                  tokenController.text.trim().length >= 20 &&
                      tokenController.text.trim().length <= 200 &&
                      (!requiresBreakGlassReason ||
                          (reasonController.text.trim().length >= 10 &&
                              reasonController.text.trim().length <= 500))
                  ? () => Navigator.pop(ctx, {
                      'handoff_token': tokenController.text.trim(),
                      if (requiresBreakGlassReason)
                        'break_glass_reason': reasonController.text.trim(),
                    })
                  : null,
              child: Text(s.pharmacyMarkDeliveredYes),
            ),
          ],
        ),
      ),
    );
    tokenController.dispose();
    reasonController.dispose();
    if (evidence == null) return;

    try {
      await PharmacyApiService.completePharmacyDelivery(
        (order['id'] as num).toInt(),
        handoffToken: evidence['handoff_token']!,
        breakGlassReason: evidence['break_glass_reason'],
      );
      _snack(s.pharmacyOrderDeliveredToast);
      unawaited(_loadOrders());
    } catch (error) {
      _snack(error.toString(), isError: true);
    }
  }
  void _clearControlledDeliveryWitnessState(int orderId) {
    final marker = ':$orderId:';
    _controlledDeliveryWitnessAttempts.removeWhere(
      (scope, _) => scope.contains(marker),
    );
    _controlledDeliveryPendingApprovals.removeWhere(
      (scope, _) => scope.contains(marker),
    );
    _controlledDeliveryApprovedWitnesses.removeWhere(
      (scope, _) => scope.contains(marker),
    );
  }

  int? _deliveryRecoveryLineIndex(PharmacyApiException error) {
    final direct = _nonNegativeInt(error.details?['order_line_index']);
    if (direct != null) return direct;
    final recovery = error.details?['recovery_action'];
    final requestShape = recovery is Map ? recovery['request_shape'] : null;
    final rawItems = requestShape is Map
        ? requestShape['dispensed_items']
        : null;
    if (rawItems is! List || rawItems.length != 1 || rawItems.first is! Map) {
      return null;
    }
    return _nonNegativeInt((rawItems.first as Map)['order_line_index']);
  }

  bool _sameControlledDeliveryAllocation(
    Map<String, dynamic> left,
    Map<String, dynamic> right,
  ) {
    if (_nonNegativeInt(left['order_line_index']) !=
            _nonNegativeInt(right['order_line_index']) ||
        _positiveInt(left['catalog_id']) != _positiveInt(right['catalog_id']) ||
        _positiveInt(left['inventory_item_id']) !=
            _positiveInt(right['inventory_item_id'])) {
      return false;
    }
    final leftAllocations = left['inventory_allocations'];
    final rightAllocations = right['inventory_allocations'];
    if (leftAllocations is! List || rightAllocations is! List) {
      return leftAllocations == null && rightAllocations == null;
    }
    if (leftAllocations.length != rightAllocations.length) return false;
    for (var index = 0; index < leftAllocations.length; index++) {
      final leftAllocation = leftAllocations[index];
      final rightAllocation = rightAllocations[index];
      if (leftAllocation is! Map || rightAllocation is! Map) return false;
      if (_positiveInt(
                leftAllocation['inventory_batch_id'] ??
                    leftAllocation['batch_id'],
              ) !=
              _positiveInt(
                rightAllocation['inventory_batch_id'] ??
                    rightAllocation['batch_id'],
              ) ||
          _number(leftAllocation['quantity']) !=
              _number(rightAllocation['quantity']) ||
          leftAllocation['witness_approval_id']?.toString() !=
              rightAllocation['witness_approval_id']?.toString()) {
        return false;
      }
    }
    return true;
  }

  Future<Map<String, dynamic>?> _collectAmbiguousInventoryItemSelection(
    PharmacyApiException error,
  ) async {
    final details = error.details;
    final rawRecovery = details?['recovery_action'];
    final rawShape = rawRecovery is Map ? rawRecovery['request_shape'] : null;
    final rawItems = rawShape is Map ? rawShape['dispensed_items'] : null;
    final requestLine =
        rawItems is List && rawItems.length == 1 && rawItems.first is Map
        ? Map<String, dynamic>.from(rawItems.first as Map)
        : <String, dynamic>{
            'order_line_index': details?['order_line_index'],
            'catalog_id': details?['catalog_id'],
          };
    final orderLineIndex = _nonNegativeInt(requestLine['order_line_index']);
    final catalogId = _positiveInt(requestLine['catalog_id']);
    final rawCandidates = details?['inventory_item_candidates'];
    final candidates = rawCandidates is List
        ? rawCandidates
              .whereType<Map>()
              .map((candidate) => Map<String, dynamic>.from(candidate))
              .where(
                (candidate) =>
                    _positiveInt(candidate['inventory_item_id']) != null,
              )
              .toList(growable: false)
        : const <Map<String, dynamic>>[];
    if (orderLineIndex == null || catalogId == null || candidates.isEmpty) {
      throw StateError('Inventory item selection authority is unavailable');
    }
    if (!mounted) return null;
    final strings = AppStrings.of(context);
    final selected = await showDialog<Map<String, dynamic>>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => SimpleDialog(
        title: Text(strings.lookup('ward_indent.controlled.select_inventory')),
        children: [
          for (final candidate in candidates)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(dialogContext, candidate),
              child: Text(
                candidate['display_name']?.toString().trim().isNotEmpty == true
                    ? candidate['display_name'].toString()
                    : '#${candidate['inventory_item_id']}',
              ),
            ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: Text(strings.actionCancel),
          ),
        ],
      ),
    );
    final inventoryItemId = _positiveInt(selected?['inventory_item_id']);
    if (inventoryItemId == null) return null;
    return {
      ...requestLine,
      'order_line_index': orderLineIndex,
      'catalog_id': catalogId,
      'inventory_item_id': inventoryItemId,
    };
  }

  Future<Map<String, dynamic>?> _collectControlledDeliveryAllocation({
    required int orderId,
    required PharmacyApiException error,
  }) async {
    final details = error.details;
    final rawRecovery = details?['recovery_action'];
    if (rawRecovery is! Map) {
      throw StateError('Controlled delivery recovery evidence is unavailable');
    }
    final recovery = Map<String, dynamic>.from(rawRecovery);
    final rawShape = recovery['request_shape'];
    final rawItems = rawShape is Map ? rawShape['dispensed_items'] : null;
    if (rawItems is! List || rawItems.length != 1 || rawItems.first is! Map) {
      throw StateError('Controlled delivery recovery shape is invalid');
    }
    final requestLine = Map<String, dynamic>.from(rawItems.first as Map);
    final catalogId = _positiveInt(requestLine['catalog_id']);
    final inventoryItemId = _positiveInt(requestLine['inventory_item_id']);
    final orderLineIndex = _nonNegativeInt(requestLine['order_line_index']);
    final rawAllocations = requestLine['inventory_allocations'];
    final allocationTemplate =
        rawAllocations is List &&
            rawAllocations.length == 1 &&
            rawAllocations.first is Map
        ? Map<String, dynamic>.from(rawAllocations.first as Map)
        : null;
    final quantity = _number(allocationTemplate?['quantity']);
    if (catalogId == null ||
        inventoryItemId == null ||
        orderLineIndex == null ||
        quantity == null ||
        quantity <= 0) {
      throw StateError(
        'Controlled delivery allocation authority is incomplete',
      );
    }

    final batches = await PharmacyApiService.getInventoryBatches(
      itemId: inventoryItemId,
    );
    if (!mounted) return null;
    final selection = await _selectControlledDeliveryBatches(
      batches: batches,
      quantity: quantity,
      witnessRequired: recovery['witness_required'] == true,
    );
    if (selection == null) return null;

    final witnessRequired = recovery['witness_required'] == true;
    final rawWitnessTemplate = recovery['witness_payload_template'];
    final witnessTemplate = rawWitnessTemplate is Map
        ? Map<String, dynamic>.from(rawWitnessTemplate)
        : null;
    if (witnessRequired && witnessTemplate == null) {
      throw StateError('Controlled delivery witness authority is unavailable');
    }
    final inventoryAllocations = <Map<String, dynamic>>[];
    for (final batchAllocation in selection.allocations) {
      final witnessApprovalId = witnessRequired
          ? await _controlledDeliveryWitnessApproval(
              orderId: orderId,
              inventoryItemId: inventoryItemId,
              allocation: batchAllocation,
              witnessTemplate: witnessTemplate!,
              employeeId: selection.employeeId!,
              password: selection.password!,
            )
          : null;
      inventoryAllocations.add({
        'inventory_batch_id': batchAllocation.batchId,
        'quantity': batchAllocation.quantity,
        if (witnessApprovalId != null) 'witness_approval_id': witnessApprovalId,
      });
    }

    return {
      ...requestLine,
      'order_line_index': orderLineIndex,
      'catalog_id': catalogId,
      'inventory_item_id': inventoryItemId,
      'inventory_allocations': inventoryAllocations,
    };
  }

  Future<String> _controlledDeliveryWitnessApproval({
    required int orderId,
    required int inventoryItemId,
    required _ControlledDeliveryBatchAllocation allocation,
    required Map<String, dynamic> witnessTemplate,
    required String employeeId,
    required String password,
  }) async {
    final allocationScope =
        'witness:$orderId:$inventoryItemId:${allocation.batchId}:${allocation.quantity}';
    final alreadyApproved =
        _controlledDeliveryApprovedWitnesses[allocationScope];
    if (alreadyApproved != null) return alreadyApproved;

    final witnessPayload = Map<String, dynamic>.from(witnessTemplate)
      ..['inventory_batch_id'] = allocation.batchId
      ..['quantity'] = allocation.quantity;
    final requestScope =
        'request:$orderId:$inventoryItemId:${allocation.batchId}:${allocation.quantity}';
    final requestAttempt = _controlledDeliveryWitnessAttempts.putIfAbsent(
      requestScope,
      () => IdempotencyAttempt(
        'pharmacy-delivery-witness-request-$orderId-$inventoryItemId',
      ),
    );
    var approvalId = _controlledDeliveryPendingApprovals[requestScope];
    if (approvalId == null) {
      late final Map<String, dynamic> pending;
      try {
        pending =
            await PharmacyApiService.requestControlledDispenseWitnessApproval(
              dispense: witnessPayload,
              idempotencyKey: requestAttempt.keyFor(witnessPayload),
            );
        requestAttempt.reset();
        _controlledDeliveryWitnessAttempts.remove(requestScope);
      } on PharmacyApiException catch (requestError) {
        if (requestError.statusCode >= 400 && requestError.statusCode < 500) {
          requestAttempt.reset();
          _controlledDeliveryWitnessAttempts.remove(requestScope);
        }
        rethrow;
      }
      approvalId =
          pending['id']?.toString() ?? pending['approval_id']?.toString();
      if (approvalId == null ||
          !RegExp(r'^[1-9][0-9]*$').hasMatch(approvalId)) {
        throw StateError('Controlled delivery witness approval id is missing');
      }
      _controlledDeliveryPendingApprovals[requestScope] = approvalId;
    }
    final resolvedApprovalId = approvalId;
    if (resolvedApprovalId == null) {
      throw StateError('Controlled delivery witness approval id is missing');
    }
    final approvalScope = 'approve:$orderId:$resolvedApprovalId';
    final approvalAttempt = _controlledDeliveryWitnessAttempts.putIfAbsent(
      approvalScope,
      () => IdempotencyAttempt(
        'pharmacy-delivery-witness-approve-$orderId-$resolvedApprovalId',
      ),
    );
    final approvalIdentity = {
      'approvalId': resolvedApprovalId,
      'dispense': witnessPayload,
      'employeeId': employeeId,
    };
    try {
      await PharmacyApiService.approveControlledDispenseWitnessApproval(
        approvalId: resolvedApprovalId,
        dispense: witnessPayload,
        employeeId: employeeId,
        password: password,
        idempotencyKey: approvalAttempt.keyFor(approvalIdentity),
      );
      approvalAttempt.reset();
      _controlledDeliveryWitnessAttempts.remove(approvalScope);
      _controlledDeliveryPendingApprovals.remove(requestScope);
      _controlledDeliveryApprovedWitnesses[allocationScope] =
          resolvedApprovalId;
    } on PharmacyApiException catch (approvalError) {
      if (approvalError.statusCode >= 400 && approvalError.statusCode < 500) {
        approvalAttempt.reset();
        _controlledDeliveryWitnessAttempts.remove(approvalScope);
        _controlledDeliveryPendingApprovals.remove(requestScope);
      }
      rethrow;
    }
    return resolvedApprovalId;
  }

  Future<_ControlledDeliverySelection?> _selectControlledDeliveryBatches({
    required List<Map<String, dynamic>> batches,
    required num quantity,
    required bool witnessRequired,
  }) async {
    final allocations = _planControlledDeliveryBatches(batches, quantity);
    var employeeId = '';
    var password = '';
    final strings = AppStrings.of(context);
    return showDialog<_ControlledDeliverySelection>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: Text(
            strings.lookup('s4.lib.pharmacy.controlled_narcotic_item'),
          ),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(strings.lookup('ward_indent.controlled.select_batch')),
                const SizedBox(height: 8),
                for (final allocation in allocations)
                  ListTile(
                    dense: true,
                    key: ValueKey(
                      'pharmacy-delivery-controlled-batch-${allocation.batchId}',
                    ),
                    title: Text(allocation.label),
                    trailing: Text('${allocation.quantity}'),
                  ),
                if (witnessRequired) ...[
                  const SizedBox(height: 12),
                  Text(
                    strings.lookup('s4.lib.counter_sale.witness_review_hint'),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    key: const ValueKey(
                      'pharmacy-delivery-witness-employee-id',
                    ),
                    textCapitalization: TextCapitalization.characters,
                    onChanged: (value) =>
                        setDialogState(() => employeeId = value),
                    decoration: InputDecoration(
                      labelText: strings.lookup(
                        's4.lib.counter_sale.witness_employee_id',
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    key: const ValueKey('pharmacy-delivery-witness-password'),
                    obscureText: true,
                    enableSuggestions: false,
                    autocorrect: false,
                    onChanged: (value) =>
                        setDialogState(() => password = value),
                    decoration: InputDecoration(
                      labelText: strings.lookup(
                        's4.lib.counter_sale.witness_password',
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: Text(strings.actionCancel),
            ),
            FilledButton(
              key: const ValueKey('pharmacy-delivery-controlled-confirm'),
              onPressed:
                  witnessRequired &&
                      (employeeId.trim().isEmpty || password.isEmpty)
                  ? null
                  : () => Navigator.pop(
                      dialogContext,
                      _ControlledDeliverySelection(
                        allocations: allocations,
                        employeeId: witnessRequired
                            ? employeeId.trim().toUpperCase()
                            : null,
                        password: witnessRequired ? password : null,
                      ),
                    ),
              child: Text(strings.actionConfirm),
            ),
          ],
        ),
      ),
    );
  }

  List<_ControlledDeliveryBatchAllocation> _planControlledDeliveryBatches(
    List<Map<String, dynamic>> batches,
    num quantity,
  ) {
    final usable =
        batches.where((batch) {
          final remaining = _number(batch['remaining_quantity']);
          return _positiveInt(batch['id'] ?? batch['inventory_batch_id']) !=
                  null &&
              _isUnexpiredInventoryBatch(batch['expiry_date']) &&
              remaining != null &&
              remaining > 0;
        }).toList()..sort((left, right) {
          final expiry = '${left['expiry_date']}'.compareTo(
            '${right['expiry_date']}',
          );
          if (expiry != 0) return expiry;
          return _positiveInt(left['id'] ?? left['inventory_batch_id'])!
              .compareTo(
                _positiveInt(right['id'] ?? right['inventory_batch_id'])!,
              );
        });
    var outstanding = quantity.toDouble();
    final allocations = <_ControlledDeliveryBatchAllocation>[];
    for (final batch in usable) {
      if (outstanding <= 0.000001) break;
      final available = _number(batch['remaining_quantity'])!.toDouble();
      final taken = available < outstanding ? available : outstanding;
      if (taken <= 0) continue;
      final batchId = _positiveInt(batch['id'] ?? batch['inventory_batch_id'])!;
      final normalizedQuantity = (taken - taken.round()).abs() <= 0.000001
          ? taken.round()
          : double.parse(taken.toStringAsFixed(6));
      allocations.add(
        _ControlledDeliveryBatchAllocation(
          batchId: batchId,
          quantity: normalizedQuantity,
          label:
              batch['batch_number']?.toString() ??
              batch['lot_number']?.toString() ??
              '#$batchId',
        ),
      );
      outstanding -= taken;
    }
    if (outstanding > 0.000001) {
      throw StateError(
        'Insufficient exact Inventory V2 batch stock for this delivery',
      );
    }
    return List.unmodifiable(allocations);
  }

  bool _isUnexpiredInventoryBatch(Object? rawExpiryDate) {
    final match = RegExp(r'^(\d{4})-(\d{2})-(\d{2})')
        .firstMatch(rawExpiryDate?.toString().trim() ?? '');
    if (match == null) return false;
    final year = int.parse(match.group(1)!);
    final month = int.parse(match.group(2)!);
    final day = int.parse(match.group(3)!);
    final expiry = DateTime(year, month, day);
    if (expiry.year != year || expiry.month != month || expiry.day != day) {
      return false;
    }
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    return !expiry.isBefore(today);
  }

  int? _positiveInt(Object? value) {
    final parsed = value is num ? value.toInt() : int.tryParse('$value');
    return parsed != null && parsed > 0 ? parsed : null;
  }

  int? _nonNegativeInt(Object? value) {
    final parsed = value is num ? value.toInt() : int.tryParse('$value');
    return parsed != null && parsed >= 0 ? parsed : null;
  }

  num? _number(Object? value) {
    return value is num ? value : num.tryParse('$value');
  }

  Future<void> _cancelOrder(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    final reasonCtrl = TextEditingController();
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(s.pharmacyCancelDialog),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              AppText(
                's4.dynamic.pharmacy.cancel_order_confirm',
                values: {'orderNumber': order['order_number'] ?? ''},
              ),
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('pharmacy-cancellation-reason'),
                controller: reasonCtrl,
                decoration: InputDecoration(
                  labelText: s.pharmacyCancellationReason,
                  helperText: s.lookup(
                    'med03.pharmacy.cancellation_reason_help',
                  ),
                ),
                maxLength: 500,
                maxLines: 2,
                onChanged: (_) => setDialogState(() {}),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const AppText('action.cancel'),
            ),
            ElevatedButton(
              key: const ValueKey('pharmacy-cancel-submit'),
              onPressed: reasonCtrl.text.trim().length >= 3
                  ? () => Navigator.pop(ctx, true)
                  : null,
              style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
              child: Text(
                s.pharmacyCancelDialog,
                style: const TextStyle(color: Colors.white),
              ),
            ),
          ],
        ),
      ),
    );

    final cancellationReason = reasonCtrl.text.trim();
    reasonCtrl.dispose();
    if (confirm != true) return;

    try {
      await PharmacyApiService.cancelPharmacyOrder(
        order['id'],
        cancellationReason,
      );
      _snack(s.pharmacyOrderCancelledToast);
      unawaited(_loadOrders());
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _openCatalogEditor([Map<String, dynamic>? item]) async {
    if (!_canManageFormulary) {
      _snack(
        AppStrings.of(context)
            .lookup('s4.lib.pharmacy.only_incharge_admin_change_formulary'),
        isError: true,
      );
      return;
    }

    final savedMessage = AppStrings.of(context).lookup(
      item == null
          ? 's4.lib.pharmacy.drug_added_to_formulary'
          : 's4.lib.pharmacy.drug_updated',
    );
    final formKey = GlobalKey<FormState>();
    final nameCtrl = TextEditingController(
      text: item?['name']?.toString() ?? '',
    );
    final genericCtrl = TextEditingController(
      text: item?['generic_name']?.toString() ?? '',
    );
    final categoryCtrl = TextEditingController(
      text: item?['category']?.toString() ?? 'other',
    );
    final manufacturerCtrl = TextEditingController(
      text: item?['manufacturer']?.toString() ?? '',
    );
    final unitPriceCtrl = TextEditingController(
      text: (item?['unit_price'] ?? item?['price'] ?? '').toString(),
    );
    final packSizeCtrl = TextEditingController(
      text: item?['pack_size']?.toString() ?? '',
    );
    final stockCtrl = TextEditingController(
      text: (item?['stock_quantity'] ?? item?['stock'] ?? '0').toString(),
    );
    final reorderCtrl = TextEditingController(
      text: (item?['reorder_level'] ?? '10').toString(),
    );
    var requiresPrescription = item?['requires_prescription'] != false;
    var inStock = item?['in_stock'] != false && item?['is_available'] != false;
    var submitting = false;

    int? itemId() {
      final raw = item?['id'];
      if (raw is int) return raw;
      if (raw is num) return raw.toInt();
      return int.tryParse(raw?.toString() ?? '');
    }

    try {
      final saved = await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        backgroundColor: AppTheme.cardSurface,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        builder: (ctx) => StatefulBuilder(
          builder: (ctx, setSheetState) {
            Future<void> submit() async {
              if (!formKey.currentState!.validate()) return;
              setSheetState(() => submitting = true);
              try {
                await PharmacyApiService.saveCatalogItem(
                  id: itemId(),
                  name: nameCtrl.text,
                  genericName: genericCtrl.text,
                  category: categoryCtrl.text,
                  manufacturer: manufacturerCtrl.text,
                  unitPrice: double.tryParse(unitPriceCtrl.text.trim()),
                  packSize: packSizeCtrl.text,
                  requiresPrescription: requiresPrescription,
                  inStock: inStock,
                  stockQuantity: int.tryParse(stockCtrl.text.trim()) ?? 0,
                  reorderLevel: int.tryParse(reorderCtrl.text.trim()) ?? 10,
                );
                if (!ctx.mounted) return;
                Navigator.pop(ctx, true);
              } catch (e) {
                if (!ctx.mounted) return;
                setSheetState(() => submitting = false);
                ScaffoldMessenger.of(ctx).showSnackBar(
                  SnackBar(
                    content: Text(e.toString().replaceFirst('Exception: ', '')),
                    backgroundColor: AppTheme.errorRed,
                  ),
                );
              }
            }

            return Padding(
              padding: EdgeInsets.only(
                left: 20,
                right: 20,
                top: 20,
                bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
              ),
              child: SingleChildScrollView(
                child: Form(
                  key: formKey,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              AppStrings.of(context).lookup(
                                item == null
                                    ? 's4.lib.pharmacy.add_formulary_drug'
                                    : 's4.lib.pharmacy.edit_formulary_drug',
                              ),
                              style: TextStyle(
                                color: AppTheme.textPrimary,
                                fontSize: 18,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                          IconButton(
                            tooltip: AppStrings.of(context)
                                .lookup('action.close'),
                            onPressed: submitting
                                ? null
                                : () => Navigator.pop(ctx, false),
                            icon: const Icon(Icons.close),
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      TextFormField(
                        controller: nameCtrl,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('s4.lib.pharmacy.drug_name_with_strength'),
                          hintText: AppStrings.of(context)
                              .lookup('s4.lib.pharmacy.paracetamol_650_mg'),
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.medication_outlined),
                          ),
                        ),
                        validator: (value) => (value?.trim().isEmpty ?? true)
                            ? AppStrings.of(context)
                                  .lookup('s4.lib.pharmacy.drug_name_required')
                            : null,
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: TextFormField(
                              controller: genericCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.generic_name'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: categoryCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('vitals_chart.category'),
                                hintText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.analgesic_hint'),
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: TextFormField(
                              controller: packSizeCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.pack_strength_note'),
                                hintText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.10_tablets_strip'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: unitPriceCtrl,
                              keyboardType:
                                  const TextInputType.numberWithOptions(
                                    decimal: true,
                                  ),
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.unit_price'),
                                prefixText: '₹ ',
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: TextFormField(
                              controller: manufacturerCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.manufacturer'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: stockCtrl,
                              keyboardType: TextInputType.number,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.stock_quantity'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: reorderCtrl,
                              keyboardType: TextInputType.number,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.reorder_level'),
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        value: requiresPrescription,
                        title: const AppText(
                          's4.lib.pharmacy.prescription_required',
                        ),
                        onChanged: submitting
                            ? null
                            : (value) => setSheetState(
                                () => requiresPrescription = value,
                              ),
                      ),
                      SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        value: inStock,
                        title: const AppText(
                          's4.lib.pharmacy.available_in_formulary',
                        ),
                        onChanged: submitting
                            ? null
                            : (value) => setSheetState(() => inStock = value),
                      ),
                      const SizedBox(height: 18),
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton.icon(
                          onPressed: submitting ? null : submit,
                          icon: submitting
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.save_outlined),
                          label: Text(
                            AppStrings.of(context).lookup(
                              submitting
                                  ? 's4.lib.pharmacy.saving'
                                  : 's4.lib.pharmacy.save_drug',
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      );

      if (saved == true) {
        _snack(savedMessage);
        await _loadCatalog();
      }
    } finally {
      nameCtrl.dispose();
      genericCtrl.dispose();
      categoryCtrl.dispose();
      manufacturerCtrl.dispose();
      unitPriceCtrl.dispose();
      packSizeCtrl.dispose();
      stockCtrl.dispose();
      reorderCtrl.dispose();
    }
  }

  Future<void> _removeCatalogItem(Map<String, dynamic> item) async {
    if (!_canManageFormulary) {
      _snack(
        AppStrings.of(context)
            .lookup('s4.lib.pharmacy.only_incharge_admin_remove_formulary'),
        isError: true,
      );
      return;
    }

    final rawId = item['id'];
    final id = rawId is int ? rawId : int.tryParse(rawId?.toString() ?? '');
    if (id == null) {
      _snack(
        AppStrings.of(context)
            .lookup('s4.lib.pharmacy.could_not_identify_formulary_item'),
        isError: true,
      );
      return;
    }

    final name =
        item['name']?.toString() ??
        AppStrings.of(context).lookup('s4.lib.pharmacy.this_drug');
    final removedMessage = AppStrings.of(context)
        .lookup('s4.lib.pharmacy.drug_removed_from_formulary');
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const AppText('s4.lib.pharmacy.remove_from_formulary'),
        content: AppText(
          's4.dynamic.pharmacy.remove_formulary_body',
          values: {'name': name},
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const AppText('action.cancel'),
          ),
          ElevatedButton.icon(
            onPressed: () => Navigator.pop(ctx, true),
            icon: const Icon(Icons.delete_outline),
            label: const AppText('s4.lib.pharmacy.remove'),
            style: ElevatedButton.styleFrom(
              backgroundColor: AppTheme.errorRed,
              foregroundColor: Colors.white,
            ),
          ),
        ],
      ),
    );

    if (confirm != true) return;
    try {
      await PharmacyApiService.removeCatalogItem(id);
      _snack(removedMessage);
      await _loadCatalog();
    } catch (e) {
      _snack(e.toString().replaceFirst('Exception: ', ''), isError: true);
    }
  }

  Future<void> _runExpiryScan() async {
    if (!_canManageInventory) {
      _snack(
        AppStrings.of(context)
            .lookup('s4.lib.pharmacy.only_stores_incharge_admin_run_expiry'),
        isError: true,
      );
      return;
    }
    final completedMessage = AppStrings.of(context)
        .lookup('s4.lib.pharmacy.expiry_scan_completed');
    try {
      await PharmacyApiService.runExpiryScan();
      _snack(completedMessage);
      await _loadInventory();
    } catch (e) {
      _snack(e.toString().replaceFirst('Exception: ', ''), isError: true);
    }
  }

  Future<void> _openInventoryItemEditor() async {
    if (!_canManageInventory) {
      _snack(
        AppStrings.of(context)
            .lookup('s4.lib.pharmacy.only_stores_incharge_admin_add_inventory'),
        isError: true,
      );
      return;
    }

    final formKey = GlobalKey<FormState>();
    final inventoryItemAddedMessage = AppStrings.of(context)
        .lookup('s4.lib.pharmacy.inventory_item_added');
    final skuCtrl = TextEditingController();
    final displayCtrl = TextEditingController();
    final genericCtrl = TextEditingController();
    final brandCtrl = TextEditingController();
    final manufacturerCtrl = TextEditingController();
    final formCtrl = TextEditingController();
    final strengthCtrl = TextEditingController();
    final unitCtrl = TextEditingController(text: 'each');
    final packCtrl = TextEditingController();
    final reorderLevelCtrl = TextEditingController();
    final reorderQtyCtrl = TextEditingController();
    String? scheduleClass;
    var isColdChain = false;
    var isNarcotic = false;
    var submitting = false;

    try {
      final saved = await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        backgroundColor: AppTheme.cardSurface,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        builder: (ctx) => StatefulBuilder(
          builder: (ctx, setSheetState) {
            Future<void> submit() async {
              if (!formKey.currentState!.validate()) return;
              setSheetState(() => submitting = true);
              try {
                await PharmacyApiService.createInventoryItem(
                  skuCode: skuCtrl.text,
                  displayName: displayCtrl.text,
                  genericName: genericCtrl.text,
                  brandName: brandCtrl.text,
                  manufacturer: manufacturerCtrl.text,
                  form: formCtrl.text,
                  strength: strengthCtrl.text,
                  unitLabel: unitCtrl.text,
                  packSize: packCtrl.text,
                  scheduleClass: scheduleClass,
                  isNarcotic: isNarcotic,
                  isColdChain: isColdChain,
                  reorderLevel: num.tryParse(reorderLevelCtrl.text.trim()),
                  reorderQuantity: num.tryParse(reorderQtyCtrl.text.trim()),
                );
                if (!ctx.mounted) return;
                Navigator.pop(ctx, true);
              } catch (e) {
                if (!ctx.mounted) return;
                setSheetState(() => submitting = false);
                ScaffoldMessenger.of(ctx).showSnackBar(
                  SnackBar(
                    content: Text(e.toString().replaceFirst('Exception: ', '')),
                    backgroundColor: AppTheme.errorRed,
                  ),
                );
              }
            }

            return Padding(
              padding: EdgeInsets.only(
                left: 20,
                right: 20,
                top: 20,
                bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
              ),
              child: SingleChildScrollView(
                child: Form(
                  key: formKey,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: AppText(
                              's4.lib.pharmacy.add_inventory_item',
                              style: TextStyle(
                                color: AppTheme.textPrimary,
                                fontSize: 18,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                          IconButton(
                            tooltip: AppStrings.of(context)
                                .lookup('action.close'),
                            onPressed: submitting
                                ? null
                                : () => Navigator.pop(ctx, false),
                            icon: const Icon(Icons.close),
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          Expanded(
                            child: TextFormField(
                              controller: skuCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.sku_code'),
                                hintText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.para_650_tab'),
                              ),
                              validator: (value) =>
                                  (value?.trim().isEmpty ?? true)
                                  ? AppStrings.of(context)
                                        .lookup('s4.lib.pharmacy.sku_required')
                                  : null,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            flex: 2,
                            child: TextFormField(
                              controller: displayCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.display_name'),
                                hintText: AppStrings.of(context).lookup(
                                  's4.lib.pharmacy.paracetamol_650_mg_tablet',
                                ),
                              ),
                              validator: (value) =>
                                  (value?.trim().isEmpty ?? true)
                                  ? AppStrings.of(context).lookup(
                                      's4.lib.pharmacy.display_name_required',
                                    )
                                  : null,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: TextFormField(
                              controller: genericCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.generic_name'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: brandCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.brand_name'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: manufacturerCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.manufacturer'),
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: TextFormField(
                              controller: formCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.form'),
                                hintText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.tablet_hint'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: strengthCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.strength'),
                                hintText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.650_mg'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: unitCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.unit_label'),
                                hintText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.tablet_hint'),
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: TextFormField(
                              controller: packCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.pack_size'),
                                hintText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.10_tablets_strip'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: DropdownButtonFormField<String?>(
                              initialValue: scheduleClass,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('theatre.tab.schedule'),
                              ),
                              items: const [
                                DropdownMenuItem<String?>(
                                  value: null,
                                  child: AppText('s4.lib.pharmacy.none'),
                                ),
                                DropdownMenuItem(
                                  value: 'OTC',
                                  child: AppText('s4.lib.pharmacy.otc'),
                                ),
                                DropdownMenuItem(value: 'H', child: Text('H')),
                                DropdownMenuItem(
                                  value: 'H1',
                                  child: AppText('s4.lib.pharmacy.h1'),
                                ),
                                DropdownMenuItem(
                                  value: 'X',
                                  child: AppText('s4.lib.pharmacy.x'),
                                ),
                              ],
                              onChanged: submitting
                                  ? null
                                  : (value) => setSheetState(() {
                                      scheduleClass = value;
                                      if (value == 'X') isNarcotic = true;
                                    }),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: TextFormField(
                              controller: reorderLevelCtrl,
                              keyboardType: TextInputType.number,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.reorder_level'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: reorderQtyCtrl,
                              keyboardType: TextInputType.number,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(context)
                                    .lookup('s4.lib.pharmacy.reorder_quantity'),
                              ),
                            ),
                          ),
                        ],
                      ),
                      SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        value: isColdChain,
                        title: const AppText('s4.lib.pharmacy.cold_chain_item'),
                        onChanged: submitting
                            ? null
                            : (value) =>
                                  setSheetState(() => isColdChain = value),
                      ),
                      SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        value: isNarcotic,
                        title: const AppText(
                          's4.lib.pharmacy.controlled_narcotic_item',
                        ),
                        onChanged: submitting
                            ? null
                            : (value) =>
                                  setSheetState(() => isNarcotic = value),
                      ),
                      const SizedBox(height: 18),
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton.icon(
                          onPressed: submitting ? null : submit,
                          icon: submitting
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.save_outlined),
                          label: Text(
                            AppStrings.of(context).lookup(
                              submitting
                                  ? 's4.lib.pharmacy.saving'
                                  : 's4.lib.pharmacy.save_inventory_item',
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      );

      if (saved == true) {
        _snack(inventoryItemAddedMessage);
        await _loadInventory();
      }
    } finally {
      skuCtrl.dispose();
      displayCtrl.dispose();
      genericCtrl.dispose();
      brandCtrl.dispose();
      manufacturerCtrl.dispose();
      formCtrl.dispose();
      strengthCtrl.dispose();
      unitCtrl.dispose();
      packCtrl.dispose();
      reorderLevelCtrl.dispose();
      reorderQtyCtrl.dispose();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD
  // ═══════════════════════════════════════════════════════════════════════════

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final tabs = <Tab>[
      if (_canWorkPharmacyOrders) ...[
        Tab(text: '${s.pharmacyTabNew} (${_newOrders.length})'),
        Tab(text: '${s.pharmacyTabActive} (${_activeOrders.length})'),
        Tab(text: '${s.pharmacyTabDone} (${_completedOrders.length})'),
      ],
      if (_canViewWardIndents) Tab(text: s.lookup('ward_indent.tab')),
      Tab(
        text: s.format('s4.dynamic.pharmacy.formulary_count', {
          'count': _catalog.length,
        }),
      ),
      if (_canViewInventory)
        Tab(
          text: s.format('s4.dynamic.pharmacy.inventory_count', {
            'count': _inventoryItems.length,
          }),
        ),
    ];
    final tabViews = <Widget>[
      if (_canWorkPharmacyOrders) ...[
        _buildOrderTab(_newOrders, s.pharmacyEmptyNew),
        _buildOrderTab(_activeOrders, s.pharmacyEmptyActive),
        _buildOrderTab(_completedOrders, s.pharmacyEmptyDone),
      ],
      if (_canViewWardIndents)
        WardIndentWorkbench(
          rawRole: _rawRole,
          role: _role,
          initialIndentId: widget.initialIndentId,
        ),
      _buildFormularyTab(),
      if (_canViewInventory) _buildInventoryTab(),
    ];
    final wardIndentTabIndex = _canWorkPharmacyOrders ? 3 : 0;
    final initialTabIndex =
        widget.initialTab == 'ward-indents' && _canViewWardIndents
        ? wardIndentTabIndex
        : 0;
    final summaryText = _canWorkPharmacyOrders
        ? s.format('s4.dynamic.pharmacy.orders_summary', {
            'newCount': _newOrders.length,
            'activeCount': _activeOrders.length,
            'formularyCount': _catalog.length,
          })
        : s.format('s4.dynamic.pharmacy.inventory_summary', {
            'inventoryCount': _inventoryItems.length,
            'expiryCount': _expiryAlerts.length,
            'formularyCount': _catalog.length,
          });

    return StaffScaffold(
      title: _role == StaffRole.storesPurchaseIncharge
          ? s.lookup('s4.lib.pharmacy.inventory_and_purchase')
          : s.pharmacyTitle,
      body: Column(
        children: [
          // Header
          Container(
            margin: const EdgeInsets.all(12),
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [Color(0xFFE65100), Color(0xFFFF8F00)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              children: [
                const Icon(Icons.medication, color: Colors.white, size: 36),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.pharmacyQueueTitle,
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 16,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        summaryText,
                        style: const TextStyle(
                          color: Colors.white70,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.refresh, color: Colors.white),
                  tooltip: s.actionRefresh,
                  onPressed: () {
                    if (_canWorkPharmacyOrders) _loadOrders();
                    _loadCatalog();
                    if (_canViewInventory) _loadInventory();
                  },
                ),
                if (_canWorkPharmacyOrders) ...[
                  const SizedBox(width: 4),
                  ElevatedButton.icon(
                    onPressed: () => context.push('/pharmacy/counter-sale'),
                    icon: const Icon(
                      Icons.point_of_sale,
                      color: Color(0xFFE65100),
                    ),
                    label: const AppText('s4.lib.counter_sale.open'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppTheme.cardSurface,
                      foregroundColor: const Color(0xFFE65100),
                      minimumSize: const Size(0, 38),
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                    ),
                  ),
                ],
              ],
            ),
          ),

          Expanded(
            child: DefaultTabController(
              key: ValueKey(
                'pharmacy-tabs-${tabViews.length}-$_rawRole-'
                '${widget.initialTab ?? ''}',
              ),
              length: tabViews.length,
              initialIndex: initialTabIndex,
              child: Column(
                children: [
                  TabBar(
                    labelColor: const Color(0xFFE65100),
                    unselectedLabelColor: Colors.grey,
                    indicatorColor: const Color(0xFFE65100),
                    isScrollable: true,
                    tabs: tabs,
                  ),
                  Expanded(child: TabBarView(children: tabViews)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildOrderTab(List<dynamic> orders, String emptyMsg) {
    final s = AppStrings.of(context);
    if (!_canWorkPharmacyOrders) {
      return EmptyState(
        icon: Icons.lock_outline,
        title: s.lookup(
          's4.lib.pharmacy.pharmacy_dispensing_workflow_is_handled_by_pharm',
        ),
      );
    }
    if (_loading) return const SkeletonList();
    if (_error != null) {
      return ErrorState(message: _error!, onRetry: _loadOrders);
    }
    return _buildOrderList(orders, emptyMsg);
  }

  Widget _buildFormularyTab() {
    return RefreshIndicator(
      onRefresh: _loadCatalog,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(
                        Icons.inventory_2_outlined,
                        color: Color(0xFFE65100),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: AppText(
                          's4.lib.pharmacy.shared_pharmacy_formulary',
                          style: TextStyle(
                            color: AppTheme.textPrimary,
                            fontWeight: FontWeight.w700,
                            fontSize: 16,
                          ),
                        ),
                      ),
                      if (_canManageFormulary)
                        ElevatedButton.icon(
                          onPressed: () => _openCatalogEditor(),
                          icon: const Icon(Icons.add),
                          label: const AppText(
                            's4.lib.pharmacy.add_formulary_drug',
                          ),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFFE65100),
                            foregroundColor: Colors.white,
                            minimumSize: const Size(0, 38),
                            padding: const EdgeInsets.symmetric(horizontal: 12),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  AppText(
                    _canManageFormulary
                        ? 's4.lib.pharmacy.catalog_shared_copy'
                        : 's4.lib.pharmacy.catalog_shared_limited_copy',
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _catalogSearchCtrl,
                          decoration: InputDecoration(
                            labelText: AppStrings.of(context)
                                .lookup('s4.lib.pharmacy.search_formulary'),
                            hintText: AppStrings.of(context).lookup(
                              's4.lib.pharmacy.drug_generic_or_strength',
                            ),
                            prefixIcon: const ExcludeSemantics(
                              child: Icon(Icons.search),
                            ),
                          ),
                          textInputAction: TextInputAction.search,
                          onSubmitted: (_) => _loadCatalog(),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton.filledTonal(
                        tooltip: AppStrings.of(context).lookup('action.search'),
                        onPressed: () => _loadCatalog(),
                        icon: const Icon(Icons.search),
                      ),
                      if (_catalogSearchCtrl.text.isNotEmpty) ...[
                        const SizedBox(width: 4),
                        IconButton(
                          tooltip: AppStrings.of(context)
                              .lookup('patient_records.clear_tooltip'),
                          onPressed: () {
                            _catalogSearchCtrl.clear();
                            _loadCatalog(search: '');
                          },
                          icon: const Icon(Icons.clear),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          if (_catalogLoading)
            const SizedBox(
              height: 320,
              child: SkeletonList(itemCount: 3, itemHeight: 76),
            )
          else if (_catalogError != null)
            SizedBox(
              height: 280,
              child: ErrorState(message: _catalogError!, onRetry: _loadCatalog),
            )
          else if (_catalog.isEmpty)
            SizedBox(
              height: 260,
              child: EmptyState(
                icon: Icons.inventory_2_outlined,
                title: AppStrings.of(context)
                    .lookup('s4.lib.pharmacy.no_formulary_drugs_found'),
              ),
            )
          else
            ..._catalog.map(_buildCatalogCard),
        ],
      ),
    );
  }

  Widget _buildInventoryTab() {
    return RefreshIndicator(
      onRefresh: _loadInventory,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(
                        Icons.warehouse_outlined,
                        color: Color(0xFFE65100),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: AppText(
                          's4.lib.pharmacy.inventory_and_purchase_oversight',
                          style: TextStyle(
                            color: AppTheme.textPrimary,
                            fontWeight: FontWeight.w700,
                            fontSize: 16,
                          ),
                        ),
                      ),
                      if (_canManageInventory) ...[
                        OutlinedButton.icon(
                          onPressed: _runExpiryScan,
                          icon: const Icon(Icons.history_toggle_off_outlined),
                          label: const AppText(
                            's4.lib.pharmacy.run_expiry_scan',
                          ),
                        ),
                        const SizedBox(width: 8),
                        ElevatedButton.icon(
                          onPressed: _openInventoryItemEditor,
                          icon: const Icon(Icons.add),
                          label: const AppText('s4.lib.pharmacy.add_item'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFFE65100),
                            foregroundColor: Colors.white,
                            minimumSize: const Size(0, 38),
                            padding: const EdgeInsets.symmetric(horizontal: 12),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 6),
                  AppText(
                    's4.lib.pharmacy.stores_purchase_can_maintain_the_drug_master_sto',
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _inventorySearchCtrl,
                          decoration: InputDecoration(
                            labelText: AppStrings.of(context)
                                .lookup('s4.lib.pharmacy.search_inventory'),
                            hintText: AppStrings.of(context).lookup(
                              's4.lib.pharmacy.sku_drug_brand_or_generic',
                            ),
                            prefixIcon: const ExcludeSemantics(
                              child: Icon(Icons.search),
                            ),
                          ),
                          textInputAction: TextInputAction.search,
                          onSubmitted: (_) => _loadInventory(),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton.filledTonal(
                        tooltip: AppStrings.of(context).lookup('action.search'),
                        onPressed: () => _loadInventory(),
                        icon: const Icon(Icons.search),
                      ),
                      if (_inventorySearchCtrl.text.isNotEmpty) ...[
                        const SizedBox(width: 4),
                        IconButton(
                          tooltip: AppStrings.of(context)
                              .lookup('patient_records.clear_tooltip'),
                          onPressed: () {
                            _inventorySearchCtrl.clear();
                            _loadInventory(search: '');
                          },
                          icon: const Icon(Icons.clear),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          if (_inventoryLoading)
            const SizedBox(
              height: 320,
              child: SkeletonList(itemCount: 3, itemHeight: 76),
            )
          else if (_inventoryError != null)
            SizedBox(
              height: 280,
              child: ErrorState(
                message: _inventoryError!,
                onRetry: _loadInventory,
              ),
            )
          else ...[
            if (_expiryAlerts.isNotEmpty) ...[
              Padding(
                padding: const EdgeInsets.only(left: 4, bottom: 6),
                child: AppText(
                  's4.lib.pharmacy.expiry_alerts',
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              ..._expiryAlerts.take(8).map(_buildExpiryAlertCard),
              const SizedBox(height: 8),
            ],
            Padding(
              padding: const EdgeInsets.only(left: 4, bottom: 6),
              child: AppText(
                's4.lib.pharmacy.inventory_items',
                style: TextStyle(
                  color: AppTheme.textPrimary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            if (_inventoryItems.isEmpty)
              SizedBox(
                height: 260,
                child: EmptyState(
                  icon: Icons.warehouse_outlined,
                  title: AppStrings.of(context)
                      .lookup('s4.lib.pharmacy.no_inventory_items_found'),
                ),
              )
            else
              ..._inventoryItems.map(_buildInventoryItemCard),
          ],
        ],
      ),
    );
  }

  Widget _buildInventoryItemCard(Map<String, dynamic> item) {
    final s = AppStrings.of(context);
    final name =
        item['display_name']?.toString() ??
        s.lookup('s4.lib.pharmacy.unnamed_item');
    final sku = item['sku_code']?.toString() ?? '';
    final generic = item['generic_name']?.toString() ?? '';
    final strength = item['strength']?.toString() ?? '';
    final schedule = item['schedule_class']?.toString() ?? '-';
    final reorder = item['reorder_level']?.toString() ?? '-';
    final unit =
        item['unit_label']?.toString() ?? s.lookup('s4.lib.pharmacy.unit_each');
    final status = item['status']?.toString().toUpperCase() ?? 'ACTIVE';

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          children: [
            Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(
                color: const Color(0xFFE65100).withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Icon(
                Icons.inventory_2_outlined,
                color: Color(0xFFE65100),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              flex: 3,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  if ([sku, generic, strength].any((value) => value.isNotEmpty))
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        [
                          if (sku.isNotEmpty) sku,
                          if (generic.isNotEmpty) generic,
                          if (strength.isNotEmpty) strength,
                        ].join(' • '),
                        style: TextStyle(
                          color: AppTheme.textSecondary,
                          fontSize: 12,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            Expanded(
              child: _CatalogMetric(
                label: s.lookup('s4.lib.pharmacy.metric_unit'),
                value: unit,
              ),
            ),
            Expanded(
              child: _CatalogMetric(
                label: s.lookup('s4.lib.pharmacy.metric_schedule'),
                value: schedule,
              ),
            ),
            Expanded(
              child: _CatalogMetric(
                label: s.lookup('s4.lib.pharmacy.metric_reorder'),
                value: reorder,
              ),
            ),
            _buildStatusChip(status),
          ],
        ),
      ),
    );
  }

  Widget _buildExpiryAlertCard(Map<String, dynamic> item) {
    final s = AppStrings.of(context);
    final name =
        item['display_name']?.toString() ??
        s.lookup('s4.lib.pharmacy.unnamed_item');
    final batch =
        item['batch_number']?.toString() ??
        item['lot_number']?.toString() ??
        '-';
    final bucket = _expiryBucketLabel(s, item['bucket']);
    final days = item['days_to_expiry']?.toString() ?? '-';
    final qty = item['remaining_quantity']?.toString() ?? '-';

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          children: [
            Icon(
              Icons.warning_amber_outlined,
              color: AppTheme.warningOnSurface,
            ),
            const SizedBox(width: 12),
            Expanded(
              flex: 3,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    s.format('s4.dynamic.pharmacy.batch', {'batch': batch}),
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: _CatalogMetric(
                label: s.lookup('s4.lib.pharmacy.metric_bucket'),
                value: bucket,
              ),
            ),
            Expanded(
              child: _CatalogMetric(
                label: s.lookup('s4.lib.pharmacy.metric_days'),
                value: days,
              ),
            ),
            Expanded(
              child: _CatalogMetric(
                label: s.lookup('s4.lib.pharmacy.metric_qty'),
                value: qty,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCatalogCard(Map<String, dynamic> item) {
    final s = AppStrings.of(context);
    final name =
        item['name']?.toString() ?? s.lookup('s4.lib.pharmacy.unnamed_drug');
    final generic = item['generic_name']?.toString() ?? '';
    final category =
        item['category']?.toString() ??
        s.lookup('s4.lib.pharmacy.category_other');
    final pack = item['pack_size']?.toString() ?? '';
    final stock = item['stock'] ?? item['stock_quantity'] ?? 0;
    final unitPrice = item['unit_price'] ?? item['price'];
    final available =
        item['is_available'] != false && item['in_stock'] != false;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          children: [
            Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(
                color: const Color(0xFFE65100).withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Icon(
                Icons.medication_liquid_outlined,
                color: Color(0xFFE65100),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              flex: 3,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  if (generic.isNotEmpty || pack.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        [
                          if (generic.isNotEmpty) generic,
                          if (pack.isNotEmpty) pack,
                        ].join(' • '),
                        style: TextStyle(
                          color: AppTheme.textSecondary,
                          fontSize: 12,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            Expanded(
              child: _CatalogMetric(
                label: s.lookup('s4.lib.pharmacy.metric_category'),
                value: category,
              ),
            ),
            Expanded(
              child: _CatalogMetric(
                label: s.lookup('s4.lib.pharmacy.metric_stock'),
                value: stock.toString(),
                valueColor: available
                    ? AppTheme.successOnSurface
                    : AppTheme.warningOnSurface,
              ),
            ),
            Expanded(
              child: _CatalogMetric(
                label: s.lookup('s4.lib.pharmacy.metric_unit_price'),
                value: unitPrice == null ? '-' : '₹$unitPrice',
              ),
            ),
            _buildStatusChip(available ? 'AVAILABLE' : 'UNAVAILABLE'),
            if (_canManageFormulary) ...[
              const SizedBox(width: 8),
              IconButton(
                tooltip: AppStrings.of(context)
                    .lookup('s4.lib.pharmacy.edit_formulary_drug'),
                onPressed: () => _openCatalogEditor(item),
                icon: const Icon(Icons.edit_outlined),
              ),
              IconButton(
                tooltip: AppStrings.of(context)
                    .lookup('s4.lib.pharmacy.remove_from_formulary_2'),
                onPressed: () => _removeCatalogItem(item),
                icon: Icon(
                  Icons.delete_outline,
                  color: AppTheme.errorOnSurface,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildOrderList(List<dynamic> orders, String emptyMsg) {
    if (orders.isEmpty) {
      return RefreshIndicator(
        onRefresh: _loadOrders,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            SizedBox(
              height: MediaQuery.sizeOf(context).height * 0.5,
              child: EmptyState(
                icon: Icons.medication_outlined,
                title: emptyMsg,
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadOrders,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: orders.length,
        itemBuilder: (ctx, i) => _buildOrderCard(orders[i]),
      ),
    );
  }

  Widget _buildOrderCard(Map<String, dynamic> order) {
    final s = AppStrings.of(context);
    final status = order['status'] ?? '';
    final orderNum = order['order_number'] ?? '#${order['id']}';
    final patientName =
        order['patient_name'] ?? s.lookup('s4.lib.pharmacy.unknown_patient');
    final phone = order['phone'] ?? order['delivery_phone'] ?? '';
    final deliveryType = order['delivery_type'] ?? 'delivery';
    final slaBreach = order['sla_breached'] == true;
    final minsSincePlaced = (order['mins_since_placed'] as num?)?.round() ?? 0;
    final fundingRecovery = PharmacyFundingRecovery.from(
      order['funding_recovery'],
    );

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: slaBreach
            ? const BorderSide(color: Colors.red, width: 2)
            : BorderSide.none,
      ),
      elevation: 1,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header row
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  orderNum,
                  style: const TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 15,
                  ),
                ),
                _buildStatusChip(status),
              ],
            ),
            const SizedBox(height: 8),

            // Patient info
            Row(
              children: [
                const Icon(Icons.person, size: 16, color: Colors.grey),
                const SizedBox(width: 4),
                Text(patientName, style: const TextStyle(fontSize: 14)),
                const Spacer(),
                if (phone.isNotEmpty)
                  GestureDetector(
                    onTap: () => launchUrl(Uri.parse('tel:$phone')),
                    child: Row(
                      children: [
                        const Icon(
                          Icons.phone,
                          size: 14,
                          color: Color(0xFFE65100),
                        ),
                        const SizedBox(width: 4),
                        Text(
                          phone,
                          style: const TextStyle(
                            color: Color(0xFFE65100),
                            fontSize: 13,
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 6),

            // Delivery type + time
            Row(
              children: [
                Icon(
                  deliveryType == 'counter'
                      ? Icons.point_of_sale
                      : deliveryType == 'pickup'
                      ? Icons.store
                      : Icons.delivery_dining,
                  size: 14,
                  color: Colors.grey,
                ),
                const SizedBox(width: 4),
                Text(
                  deliveryType == 'counter'
                      ? s.lookup('med03.pharmacy.delivery_type_counter')
                      : deliveryType == 'pickup'
                      ? s.pharmacyDeliveryTypePickup
                      : s.pharmacyDeliveryTypeDelivery,
                  style: TextStyle(color: Colors.grey.shade600, fontSize: 12),
                ),
                const Spacer(),
                if (slaBreach)
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: Colors.red.shade50,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      s.format('s4.dynamic.pharmacy.sla_breach_minutes', {
                        'minutes': minsSincePlaced,
                      }),
                      style: TextStyle(
                        color: Colors.red.shade700,
                        fontSize: 11,
                      ),
                    ),
                  )
                else if (_isNewStatus(status))
                  Text(
                    s.format('s4.dynamic.pharmacy.minutes_ago', {
                      'minutes': minsSincePlaced,
                    }),
                    style: TextStyle(color: Colors.grey.shade500, fontSize: 12),
                  ),
              ],
            ),

            // Order note
            if (order['order_note'] != null &&
                order['order_note'].toString().isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                '📝 ${order['order_note']}',
                style: const TextStyle(fontSize: 13),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ],

            // Total cost (for confirmed+)
            if (order['total_amount'] != null) ...[
              const SizedBox(height: 6),
              Text(
                s.format('s4.dynamic.pharmacy.total_amount', {
                  'amount': order['total_amount'],
                }),
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 14,
                ),
              ),
            ],

            if (fundingRecovery != null) ...[
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: Colors.orange.shade50,
                  border: Border.all(color: Colors.orange.shade200),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.account_balance_outlined,
                      color: Colors.orange.shade900,
                    ),
                    const SizedBox(width: 8),
                    Expanded(child: Text(fundingRecovery.summary(s))),
                    if (_canOpenBillingDesk && fundingRecovery.deepLink != null)
                      TextButton(
                        key: ValueKey(
                          'pharmacy-funding-recovery-${fundingRecovery.taskId}',
                        ),
                        onPressed: () => _openFundingRecovery(fundingRecovery),
                        child: Text(
                          s.lookup('med03.pharmacy.recovery.open_billing_desk'),
                        ),
                      ),
                  ],
                ),
              ),
            ],

            const SizedBox(height: 12),

            // Action buttons
            _buildActions(order),
          ],
        ),
      ),
    );
  }

  Widget _buildActions(Map<String, dynamic> order) {
    final s = AppStrings.of(context);
    final status = order['status'];
    final facilityRecoveryRequired =
        order['facility_recovery_required'] == true;
    final lineIdentityRecoveryRequired =
        order['line_identity_recovery_required'] == true;
    final recoveryBlocked =
        facilityRecoveryRequired || lineIdentityRecoveryRequired;
    final fundingRecovery = PharmacyFundingRecovery.from(
      order['funding_recovery'],
    );
    final stockIssueBlocked =
        recoveryBlocked || (fundingRecovery?.blocksStockIssue ?? false);

    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        if (facilityRecoveryRequired)
          _ActionBtn(
            label: s.lookup('med03.pharmacy.assign_facility'),
            icon: Icons.local_pharmacy_outlined,
            color: AppTheme.warningAmber,
            onTap: () => _assignFacility(order),
          ),
        if (!facilityRecoveryRequired &&
            lineIdentityRecoveryRequired &&
            _canManageFormulary)
          _ActionBtn(
            label: s.lookup('med03.pharmacy.resolve_line_identities'),
            icon: Icons.account_tree_outlined,
            color: AppTheme.warningAmber,
            onTap: () => _resolveLineIdentities(order),
          ),
        if (!facilityRecoveryRequired &&
            lineIdentityRecoveryRequired &&
            !_canManageFormulary)
          Text(
            s.lookup('med03.pharmacy.line_identity_admin_required'),
            style: TextStyle(color: Colors.orange.shade800),
          ),
        if (!recoveryBlocked && _isNewStatus(status))
          _ActionBtn(
            label: s.pharmacyViewConfirm,
            icon: Icons.check_circle_outline,
            color: AppTheme.primaryBlue,
            onTap: () => _confirmOrder(order),
          ),
        if (!recoveryBlocked &&
            status == 'CONFIRMED' &&
            !_verificationCleared(order) &&
            _canPerformClinicalVerification)
          _ActionBtn(
            label: s.lookup('med03.pharmacy.verify_order'),
            icon: Icons.fact_check_outlined,
            color: Colors.indigo,
            onTap: () => _verifyOrder(order),
          ),
        if (!recoveryBlocked &&
            status == 'CONFIRMED' &&
            _verificationCleared(order) &&
            order['delivery_type']?.toString() != 'counter')
          _ActionBtn(
            label: s.pharmacyStartPreparing,
            icon: Icons.medication,
            color: AppTheme.warningAmber,
            onTap: () => _markPreparing(order),
          ),
        if (!stockIssueBlocked &&
            _verificationCleared(order) &&
            order['delivery_type']?.toString() == 'counter' &&
            (status == 'CONFIRMED' || status == 'PARTIALLY_DISPENSED'))
          _ActionBtn(
            label: s.lookup(
              status == 'PARTIALLY_DISPENSED'
                  ? 'med03.pharmacy.dispense_remainder'
                  : 'med03.pharmacy.complete_counter_dispense',
            ),
            icon: Icons.point_of_sale,
            color: AppTheme.successGreen,
            onTap: () => _completeCounterDispense(order),
          ),
        if (!stockIssueBlocked &&
            _verificationCleared(order) &&
            (status == 'CONFIRMED' ||
                status == 'PREPARING' ||
                status == 'READY' ||
                status == 'PARTIALLY_DISPENSED'))
          _ActionBtn(
            label: s.lookup('s4.lib.pharmacy.substitute'),
            icon: Icons.swap_horiz,
            color: Colors.deepPurple,
            onTap: () => DispenseSubstitutionSheet.show(
              context,
              orderId: (order['id'] as num).toInt(),
              canOpenBillingDesk: _canOpenBillingDesk,
              onDispensed: _loadOrders,
            ),
          ),
        if (!recoveryBlocked && (status == 'PREPARING' || status == 'READY'))
          _ActionBtn(
            label: s.pharmacyDispatch,
            icon: Icons.delivery_dining,
            color: Colors.teal,
            onTap: () => _dispatchOrder(order),
          ),
        if (!stockIssueBlocked &&
            status == 'DISPATCHED' &&
            _role == StaffRole.pharmacyIncharge)
          _ActionBtn(
            label: s.pharmacyMarkDelivered,
            icon: Icons.done_all,
            color: AppTheme.successGreen,
            onTap: () => _markDelivered(order),
          ),
        if (!recoveryBlocked &&
            ![
              'DISPENSED',
              'DELIVERED',
              'UNAVAILABLE',
              'CANCELLED',
            ].contains(status))
          _ActionBtn(
            label: s.lookup('med03.pharmacy.mark_unavailable'),
            icon: Icons.inventory_2_outlined,
            color: AppTheme.warningAmber,
            onTap: () => _markUnavailable(order),
          ),
        if (!recoveryBlocked &&
            ![
              'DISPENSED',
              'DELIVERED',
              'UNAVAILABLE',
              'CANCELLED',
            ].contains(status))
          _ActionBtn(
            label: s.actionCancel,
            icon: Icons.cancel_outlined,
            color: AppTheme.errorRed,
            onTap: () => _cancelOrder(order),
          ),
      ],
    );
  }

  Widget _buildStatusChip(String status) {
    final s = AppStrings.of(context);
    final (color, label) = switch (status) {
      'PENDING' => (Colors.orange, s.pharmacyStatusPlaced),
      'PLACED' => (Colors.orange, s.pharmacyStatusPlaced),
      'CONFIRMED' => (AppTheme.primaryBlue, s.pharmacyStatusConfirmed),
      'PREPARING' => (AppTheme.warningAmber, s.pharmacyStatusPreparing),
      'READY' => (Colors.teal, s.pharmacyStatusPreparing),
      'DISPATCHED' => (Colors.teal, s.pharmacyStatusDispatched),
      'DELIVERED' => (AppTheme.successGreen, s.pharmacyStatusDelivered),
      'PARTIALLY_DISPENSED' => (
        AppTheme.warningAmber,
        s.lookup('med03.pharmacy.status_partially_dispensed'),
      ),
      'DISPENSED' => (
        AppTheme.successGreen,
        s.lookup('med03.pharmacy.status_dispensed'),
      ),
      'CANCELLED' => (AppTheme.errorRed, s.pharmacyStatusCancelled),
      'AVAILABLE' => (
        AppTheme.successGreen,
        s.lookup('s4.lib.pharmacy.available'),
      ),
      'UNAVAILABLE' => (
        AppTheme.warningAmber,
        s.lookup('s4.lib.pharmacy.unavailable'),
      ),
      'ACTIVE' => (
        AppTheme.successGreen,
        s.lookup('med03.pharmacy.inventory_status.active'),
      ),
      'INACTIVE' => (
        Colors.grey,
        s.lookup('med03.pharmacy.inventory_status.inactive'),
      ),
      'QUARANTINED' => (
        AppTheme.warningAmber,
        s.lookup('med03.pharmacy.inventory_status.quarantined'),
      ),
      _ => (Colors.grey, s.lookup('med03.pharmacy.inventory_status.unknown')),
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _ManualConfirmationLine {
  int? catalogId;
  final TextEditingController quantityController = TextEditingController(
    text: '1',
  );

  void dispose() => quantityController.dispose();
}

class _ControlledDeliverySelection {
  const _ControlledDeliverySelection({
    required this.allocations,
    this.employeeId,
    this.password,
  });

  final List<_ControlledDeliveryBatchAllocation> allocations;
  final String? employeeId;
  final String? password;
}

class _ControlledDeliveryBatchAllocation {
  const _ControlledDeliveryBatchAllocation({
    required this.batchId,
    required this.quantity,
    required this.label,
  });

  final int batchId;
  final num quantity;
  final String label;
}

class _CatalogMetric extends StatelessWidget {
  final String label;
  final String value;
  final Color? valueColor;

  const _CatalogMetric({
    required this.label,
    required this.value,
    this.valueColor,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: TextStyle(color: AppTheme.textSecondary, fontSize: 11),
          ),
          const SizedBox(height: 2),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: valueColor ?? AppTheme.textPrimary,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionBtn extends StatelessWidget {
  final String label;
  final IconData icon;
  final Color color;
  final VoidCallback onTap;

  const _ActionBtn({
    required this.label,
    required this.icon,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: onTap,
      icon: Icon(icon, size: 16, color: color),
      label: Text(label, style: TextStyle(color: color, fontSize: 12)),
      style: OutlinedButton.styleFrom(
        side: BorderSide(color: color.withValues(alpha: 0.4)),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      ),
    );
  }
}
