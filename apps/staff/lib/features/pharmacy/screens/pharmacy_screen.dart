import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/pharmacy_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

class PharmacyScreen extends StatefulWidget {
  const PharmacyScreen({super.key});

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
  final TextEditingController _catalogSearchCtrl = TextEditingController();
  final TextEditingController _inventorySearchCtrl = TextEditingController();

  // Delivery tracking
  Timer? _locationTimer;
  int? _trackingOrderId;
  bool _sharingLocation = false;

  @override
  void initState() {
    super.initState();
    _loadRole();
    _loadCatalog();
    _loadInventory();
  }

  @override
  void dispose() {
    _stopLocationSharing(notify: false);
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

  bool get _canViewInventory =>
      _role == StaffRole.pharmacy ||
      _role == StaffRole.pharmacyIncharge ||
      _role == StaffRole.storesPurchaseIncharge ||
      _role.isAdminTier;

  bool get _canManageInventory =>
      _role == StaffRole.pharmacyIncharge ||
      _role == StaffRole.storesPurchaseIncharge ||
      _role.isAdminTier;

  Future<void> _loadRole() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    if (!mounted) return;
    setState(() {
      _role = role;
      if (!_canWorkPharmacyOrders) _loading = false;
    });
    if (_canWorkPharmacyOrders) {
      await _loadOrders();
    }
  }

  void _startLocationSharing(int orderId) {
    _stopLocationSharing();
    _trackingOrderId = orderId;
    _sharingLocation = true;
    if (mounted) setState(() {});

    // Send immediately, then every 30s
    _sendLocation();
    _locationTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (!_sharingLocation) {
        _stopLocationSharing();
        return;
      }
      _sendLocation();
    });
  }

  void _stopLocationSharing({bool notify = true}) {
    _locationTimer?.cancel();
    _locationTimer = null;
    if (_trackingOrderId != null && _sharingLocation) {
      MedicalApiService.stopDeliveryTracking(
        orderType: 'pharmacy',
        orderId: _trackingOrderId!,
      ).catchError((_) {});
    }
    _trackingOrderId = null;
    _sharingLocation = false;
    if (notify && mounted) setState(() {});
  }

  Future<void> _sendLocation() async {
    if (_trackingOrderId == null) return;
    try {
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 10),
        ),
      );
      await MedicalApiService.updateDeliveryLocation(
        orderType: 'pharmacy',
        orderId: _trackingOrderId!,
        lat: pos.latitude,
        lng: pos.longitude,
        accuracy: pos.accuracy,
        speed: pos.speed * 3.6, // m/s to km/h
        heading: pos.heading,
      );
    } catch (e) {
      // silent fail — don't block workflow
    }
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
    if (!_canViewInventory && _role != StaffRole.general) return;
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
        ].contains(o['status']),
      )
      .toList();

  List<dynamic> get _completedOrders => _allOrders
      .where((o) => ['DELIVERED', 'CANCELLED'].contains(o['status']))
      .toList();

  void _snack(String msg, {bool isError = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: isError ? AppTheme.errorRed : AppTheme.successGreen,
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  Future<void> _createOrder() async {
    final formKey = GlobalKey<FormState>();
    final phoneCtrl = TextEditingController();
    final noteCtrl = TextEditingController();
    var urgent = false;
    var submitting = false;

    try {
      final created = await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        builder: (ctx) => StatefulBuilder(
          builder: (ctx, setSheetState) {
            Future<void> submit() async {
              if (!formKey.currentState!.validate()) return;
              setSheetState(() => submitting = true);
              try {
                await PharmacyApiService.placePharmacyOrder(
                  phone: phoneCtrl.text.trim(),
                  orderNote: noteCtrl.text.trim(),
                  urgent: urgent,
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
                          const Expanded(
                            child: AppText(
                              's4.lib.pharmacy.create_pharmacy_order',
                              style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          IconButton(
                            icon: const Icon(Icons.close),
                            tooltip: AppStrings.of(
                              context,
                            ).lookup('action.close'),
                            onPressed: submitting
                                ? null
                                : () => Navigator.pop(ctx, false),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: phoneCtrl,
                        keyboardType: TextInputType.phone,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('reception_counter.patient.phone'),
                          hintText: AppStrings.of(
                            context,
                          ).lookup('s4.lib.pharmacy.10_digit_mobile_number'),
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.phone_outlined),
                          ),
                        ),
                        validator: (value) {
                          final digits = (value ?? '').replaceAll(
                            RegExp(r'\D'),
                            '',
                          );
                          return digits.length < 10
                              ? 'Enter a valid phone number'
                              : null;
                        },
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: noteCtrl,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('s4.lib.pharmacy.order_note'),
                          hintText: AppStrings.of(context).lookup(
                            's4.lib.pharmacy.medicine_names_dose_quantity_or_rx_note',
                          ),
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.medication_outlined),
                          ),
                          alignLabelWithHint: true,
                        ),
                        minLines: 3,
                        maxLines: 5,
                        validator: (value) => (value?.trim().isEmpty ?? true)
                            ? 'Order note is required'
                            : null,
                      ),
                      const SizedBox(height: 8),
                      SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        value: urgent,
                        title: const AppText('s4.lib.pharmacy.mark_urgent'),
                        onChanged: submitting
                            ? null
                            : (value) => setSheetState(() => urgent = value),
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
                                    color: Colors.white,
                                  ),
                                )
                              : const Icon(Icons.add, color: Colors.white),
                          label: Text(
                            submitting ? 'Creating...' : 'Create Order',
                          ),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFFE65100),
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(vertical: 14),
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

      if (created == true) {
        _snack('Pharmacy order created');
        _loadOrders();
      }
    } finally {
      phoneCtrl.dispose();
      noteCtrl.dispose();
    }
  }

  Future<void> _confirmOrder(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    final itemsController = TextEditingController();
    final costController = TextEditingController();
    final notesController = TextEditingController();

    final confirmed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Padding(
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
                    onPressed: () => Navigator.pop(ctx, false),
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
              TextField(
                controller: itemsController,
                maxLines: 3,
                decoration: InputDecoration(
                  labelText: s.pharmacyItemsLabel,
                  hintText: s.pharmacyItemsHint,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: costController,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  labelText: s.pharmacyTotalCostLabel,
                  prefixText: '₹ ',
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: notesController,
                decoration: InputDecoration(
                  labelText: AppStrings.of(
                    context,
                  ).lookup('appt_queue.notes_optional'),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: () => Navigator.pop(ctx, true),
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
    );

    if (confirmed != true) return;

    // Parse items
    final itemLines = itemsController.text.trim().split('\n');
    final items = itemLines.where((l) => l.trim().isNotEmpty).map((line) {
      final parts = line.split(',').map((s) => s.trim()).toList();
      return {
        'name': parts.isNotEmpty ? parts[0] : '',
        'qty': parts.length > 1 ? int.tryParse(parts[1]) ?? 1 : 1,
        'price': parts.length > 2 ? double.tryParse(parts[2]) ?? 0 : 0,
      };
    }).toList();

    try {
      await PharmacyApiService.confirmPharmacyOrder(order['id'], {
        'items_list': items,
        'total_cost': double.tryParse(costController.text) ?? 0,
        'confirmation_notes': notesController.text.trim(),
      });
      _snack(s.pharmacyOrderConfirmedToast);
      _loadOrders();
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _markPreparing(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    try {
      await PharmacyApiService.markPharmacyPreparing(order['id']);
      _snack(s.pharmacyMarkPreparingToast);
      _loadOrders();
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _dispatchOrder(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    final personCtrl = TextEditingController();
    final phoneCtrl = TextEditingController();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.pharmacyDispatchDialog),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: personCtrl,
              decoration: InputDecoration(
                labelText: s.pharmacyDeliveryPersonName,
                prefixIcon: const ExcludeSemantics(child: Icon(Icons.person)),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: phoneCtrl,
              keyboardType: TextInputType.phone,
              decoration: InputDecoration(
                labelText: s.pharmacyDeliveryPersonPhone,
                prefixIcon: const ExcludeSemantics(child: Icon(Icons.phone)),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(s.actionCancel),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(s.pharmacyDispatch),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    try {
      await PharmacyApiService.dispatchPharmacyOrder(order['id'], {
        'delivery_person': personCtrl.text.trim(),
        'delivery_person_phone': phoneCtrl.text.trim(),
      });
      _snack(s.pharmacyOrderDispatchedToast);
      _startLocationSharing(order['id']);
      _loadOrders();
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _markDelivered(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.pharmacyMarkDeliveredDialog),
        content: Text(
          'Confirm that order ${order['order_number']} has been delivered.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const AppText('bed_board.no_filtered_prefix'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(s.pharmacyMarkDeliveredYes),
          ),
        ],
      ),
    );

    if (confirm != true) return;

    try {
      await PharmacyApiService.markPharmacyDelivered(order['id']);
      _stopLocationSharing();
      _snack(s.pharmacyOrderDeliveredToast);
      _loadOrders();
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _cancelOrder(Map<String, dynamic> order) async {
    final s = AppStrings.of(context);
    final reasonCtrl = TextEditingController();
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
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
              controller: reasonCtrl,
              decoration: InputDecoration(
                labelText: s.pharmacyCancellationReason,
              ),
              maxLines: 2,
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const AppText('bed_board.no_filtered_prefix'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
            child: Text(
              s.pharmacyCancelDialog,
              style: const TextStyle(color: Colors.white),
            ),
          ),
        ],
      ),
    );

    if (confirm != true) return;

    try {
      await PharmacyApiService.cancelPharmacyOrder(
        order['id'],
        reasonCtrl.text.trim(),
      );
      _snack(s.pharmacyOrderCancelledToast);
      _loadOrders();
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _openCatalogEditor([Map<String, dynamic>? item]) async {
    if (!_canManageFormulary) {
      _snack(
        'Only Pharmacy Incharge or Admin can change the formulary',
        isError: true,
      );
      return;
    }

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
                              item == null
                                  ? 'Add Formulary Drug'
                                  : 'Edit Formulary Drug',
                              style: TextStyle(
                                color: AppTheme.textPrimary,
                                fontSize: 18,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                          IconButton(
                            tooltip: AppStrings.of(
                              context,
                            ).lookup('action.close'),
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
                          hintText: AppStrings.of(
                            context,
                          ).lookup('s4.lib.pharmacy.paracetamol_650_mg'),
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.medication_outlined),
                          ),
                        ),
                        validator: (value) => (value?.trim().isEmpty ?? true)
                            ? 'Drug name is required'
                            : null,
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: TextFormField(
                              controller: genericCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.generic_name'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: categoryCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('vitals_chart.category'),
                                hintText: 'analgesic',
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
                                hintText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.10_tablets_strip'),
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
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.unit_price'),
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
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.manufacturer'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: stockCtrl,
                              keyboardType: TextInputType.number,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.stock_quantity'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: reorderCtrl,
                              keyboardType: TextInputType.number,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.reorder_level'),
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
                          label: Text(submitting ? 'Saving...' : 'Save Drug'),
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
        _snack(item == null ? 'Drug added to formulary' : 'Drug updated');
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
        'Only Pharmacy Incharge or Admin can remove formulary drugs',
        isError: true,
      );
      return;
    }

    final rawId = item['id'];
    final id = rawId is int ? rawId : int.tryParse(rawId?.toString() ?? '');
    if (id == null) {
      _snack('Could not identify formulary item', isError: true);
      return;
    }

    final name = item['name']?.toString() ?? 'this drug';
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const AppText('s4.lib.pharmacy.remove_from_formulary'),
        content: Text(
          '$name will be hidden from OP/IP prescribing suggestions and the pharmacy formulary list.',
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
      _snack('Drug removed from formulary');
      await _loadCatalog();
    } catch (e) {
      _snack(e.toString().replaceFirst('Exception: ', ''), isError: true);
    }
  }

  Future<void> _runExpiryScan() async {
    if (!_canManageInventory) {
      _snack(
        'Only Stores/Purchase, Pharmacy Incharge, or Admin can run expiry scans',
        isError: true,
      );
      return;
    }
    try {
      await PharmacyApiService.runExpiryScan();
      _snack('Expiry scan completed');
      await _loadInventory();
    } catch (e) {
      _snack(e.toString().replaceFirst('Exception: ', ''), isError: true);
    }
  }

  Future<void> _openInventoryItemEditor() async {
    if (!_canManageInventory) {
      _snack(
        'Only Stores/Purchase, Pharmacy Incharge, or Admin can add inventory items',
        isError: true,
      );
      return;
    }

    final formKey = GlobalKey<FormState>();
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
                            tooltip: AppStrings.of(
                              context,
                            ).lookup('action.close'),
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
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.sku_code'),
                                hintText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.para_650_tab'),
                              ),
                              validator: (value) =>
                                  (value?.trim().isEmpty ?? true)
                                  ? 'SKU code is required'
                                  : null,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            flex: 2,
                            child: TextFormField(
                              controller: displayCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.display_name'),
                                hintText: AppStrings.of(context).lookup(
                                  's4.lib.pharmacy.paracetamol_650_mg_tablet',
                                ),
                              ),
                              validator: (value) =>
                                  (value?.trim().isEmpty ?? true)
                                  ? 'Display name is required'
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
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.generic_name'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: brandCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.brand_name'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: manufacturerCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.manufacturer'),
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
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.form'),
                                hintText: 'tablet',
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: strengthCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.strength'),
                                hintText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.650_mg'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: unitCtrl,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.unit_label'),
                                hintText: 'tablet',
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
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.pack_size'),
                                hintText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.10_tablets_strip'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: DropdownButtonFormField<String?>(
                              initialValue: scheduleClass,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('theatre.tab.schedule'),
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
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.reorder_level'),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: reorderQtyCtrl,
                              keyboardType: TextInputType.number,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(
                                  context,
                                ).lookup('s4.lib.pharmacy.reorder_quantity'),
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
                            submitting ? 'Saving...' : 'Save Inventory Item',
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
        _snack('Inventory item added');
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
      _buildFormularyTab(),
      if (_canViewInventory) _buildInventoryTab(),
    ];
    final summaryText = _canWorkPharmacyOrders
        ? '${_newOrders.length} new • ${_activeOrders.length} active • ${_catalog.length} formulary'
        : '${_inventoryItems.length} inventory items • ${_expiryAlerts.length} expiry alerts • ${_catalog.length} formulary';

    return StaffScaffold(
      title: _role == StaffRole.storesPurchaseIncharge
          ? 'Inventory & Purchase'
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
                    onPressed: _createOrder,
                    icon: const Icon(Icons.add, color: Color(0xFFE65100)),
                    label: const AppText('lab_bookings.tab.new'),
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
              length: tabViews.length,
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
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: AppText(
            's4.lib.pharmacy.pharmacy_dispensing_workflow_is_handled_by_pharm',
            textAlign: TextAlign.center,
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ),
      );
    }
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(_error!, style: const TextStyle(color: Colors.red)),
            const SizedBox(height: 12),
            ElevatedButton(onPressed: _loadOrders, child: Text(s.actionRetry)),
          ],
        ),
      );
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
                          label: const AppText('s4.lib.prescriptions.add_drug'),
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
                  Text(
                    _canManageFormulary
                        ? 'OP prescriptions, IP drug charts, and pharmacy use this same backend catalog.'
                        : 'OP prescriptions, IP drug charts, and pharmacy use this same backend catalog. Changes are limited to Pharmacy Incharge/Admin.',
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
                            labelText: AppStrings.of(
                              context,
                            ).lookup('s4.lib.pharmacy.search_formulary'),
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
                          tooltip: AppStrings.of(
                            context,
                          ).lookup('patient_records.clear_tooltip'),
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
            const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_catalogError != null)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  children: [
                    Icon(Icons.error_outline, color: AppTheme.errorOnSurface),
                    const SizedBox(height: 8),
                    Text(
                      _catalogError!,
                      style: TextStyle(color: AppTheme.errorOnSurface),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 12),
                    OutlinedButton.icon(
                      onPressed: () => _loadCatalog(),
                      icon: const Icon(Icons.refresh),
                      label: const AppText('action.retry'),
                    ),
                  ],
                ),
              ),
            )
          else if (_catalog.isEmpty)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Center(
                  child: AppText(
                    's4.lib.pharmacy.no_formulary_drugs_found',
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                ),
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
                            labelText: AppStrings.of(
                              context,
                            ).lookup('s4.lib.pharmacy.search_inventory'),
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
                          tooltip: AppStrings.of(
                            context,
                          ).lookup('patient_records.clear_tooltip'),
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
            const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_inventoryError != null)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  children: [
                    Icon(Icons.error_outline, color: AppTheme.errorOnSurface),
                    const SizedBox(height: 8),
                    Text(
                      _inventoryError!,
                      style: TextStyle(color: AppTheme.errorOnSurface),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 12),
                    OutlinedButton.icon(
                      onPressed: () => _loadInventory(),
                      icon: const Icon(Icons.refresh),
                      label: const AppText('action.retry'),
                    ),
                  ],
                ),
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
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Center(
                    child: AppText(
                      's4.lib.pharmacy.no_inventory_items_found',
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                  ),
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
    final name = item['display_name']?.toString() ?? 'Unnamed item';
    final sku = item['sku_code']?.toString() ?? '';
    final generic = item['generic_name']?.toString() ?? '';
    final strength = item['strength']?.toString() ?? '';
    final schedule = item['schedule_class']?.toString() ?? '-';
    final reorder = item['reorder_level']?.toString() ?? '-';
    final unit = item['unit_label']?.toString() ?? 'each';
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
              child: _CatalogMetric(label: 'Unit', value: unit),
            ),
            Expanded(
              child: _CatalogMetric(label: 'Schedule', value: schedule),
            ),
            Expanded(
              child: _CatalogMetric(label: 'Reorder', value: reorder),
            ),
            _buildStatusChip(status),
          ],
        ),
      ),
    );
  }

  Widget _buildExpiryAlertCard(Map<String, dynamic> item) {
    final name = item['display_name']?.toString() ?? 'Unnamed item';
    final batch =
        item['batch_number']?.toString() ??
        item['lot_number']?.toString() ??
        '-';
    final bucket = item['bucket']?.toString() ?? '-';
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
                    'Batch $batch',
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: _CatalogMetric(label: 'Bucket', value: bucket),
            ),
            Expanded(
              child: _CatalogMetric(label: 'Days', value: days),
            ),
            Expanded(
              child: _CatalogMetric(label: 'Qty', value: qty),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCatalogCard(Map<String, dynamic> item) {
    final name = item['name']?.toString() ?? 'Unnamed drug';
    final generic = item['generic_name']?.toString() ?? '';
    final category = item['category']?.toString() ?? 'other';
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
              child: _CatalogMetric(label: 'Category', value: category),
            ),
            Expanded(
              child: _CatalogMetric(
                label: 'Stock',
                value: stock.toString(),
                valueColor: available
                    ? AppTheme.successOnSurface
                    : AppTheme.warningOnSurface,
              ),
            ),
            Expanded(
              child: _CatalogMetric(
                label: 'Unit price',
                value: unitPrice == null ? '-' : '₹$unitPrice',
              ),
            ),
            _buildStatusChip(available ? 'AVAILABLE' : 'UNAVAILABLE'),
            if (_canManageFormulary) ...[
              const SizedBox(width: 8),
              IconButton(
                tooltip: AppStrings.of(
                  context,
                ).lookup('s4.lib.pharmacy.edit_formulary_drug'),
                onPressed: () => _openCatalogEditor(item),
                icon: const Icon(Icons.edit_outlined),
              ),
              IconButton(
                tooltip: AppStrings.of(
                  context,
                ).lookup('s4.lib.pharmacy.remove_from_formulary_2'),
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
      return Center(
        child: Text(
          emptyMsg,
          style: TextStyle(color: Colors.grey.shade500, fontSize: 15),
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
    final patientName = order['patient_name'] ?? 'Unknown';
    final phone = order['phone'] ?? order['delivery_phone'] ?? '';
    final deliveryType = order['delivery_type'] ?? 'delivery';
    final slaBreach = order['sla_breached'] == true;
    final minsSincePlaced = (order['mins_since_placed'] as num?)?.round() ?? 0;

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
                  deliveryType == 'pickup'
                      ? Icons.store
                      : Icons.delivery_dining,
                  size: 14,
                  color: Colors.grey,
                ),
                const SizedBox(width: 4),
                Text(
                  deliveryType == 'pickup'
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
                      '⚠ SLA breach (${minsSincePlaced}m)',
                      style: TextStyle(
                        color: Colors.red.shade700,
                        fontSize: 11,
                      ),
                    ),
                  )
                else if (_isNewStatus(status))
                  Text(
                    '${minsSincePlaced}m ago',
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
            if (order['total_cost'] != null) ...[
              const SizedBox(height: 6),
              Text(
                'Total: ₹${order['total_cost']}',
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 14,
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

    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        if (_isNewStatus(status))
          _ActionBtn(
            label: s.pharmacyViewConfirm,
            icon: Icons.check_circle_outline,
            color: AppTheme.primaryBlue,
            onTap: () => _confirmOrder(order),
          ),
        if (status == 'CONFIRMED')
          _ActionBtn(
            label: s.pharmacyStartPreparing,
            icon: Icons.medication,
            color: AppTheme.warningAmber,
            onTap: () => _markPreparing(order),
          ),
        if (status == 'PREPARING' || status == 'READY')
          _ActionBtn(
            label: s.pharmacyDispatch,
            icon: Icons.delivery_dining,
            color: Colors.teal,
            onTap: () => _dispatchOrder(order),
          ),
        if (status == 'DISPATCHED') ...[
          if (_sharingLocation && _trackingOrderId == order['id'])
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: Colors.green.shade50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.green.shade200),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.my_location,
                    size: 14,
                    color: Colors.green.shade700,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    s.labBookingsSharingLocation,
                    style: TextStyle(
                      fontSize: 12,
                      color: Colors.green.shade700,
                    ),
                  ),
                ],
              ),
            ),
          _ActionBtn(
            label: s.pharmacyMarkDelivered,
            icon: Icons.done_all,
            color: AppTheme.successGreen,
            onTap: () => _markDelivered(order),
          ),
        ],
        if (!['DELIVERED', 'CANCELLED'].contains(status))
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
      'CANCELLED' => (AppTheme.errorRed, s.pharmacyStatusCancelled),
      'AVAILABLE' => (AppTheme.successGreen, 'Available'),
      'UNAVAILABLE' => (AppTheme.warningAmber, 'Unavailable'),
      _ => (Colors.grey, status),
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
