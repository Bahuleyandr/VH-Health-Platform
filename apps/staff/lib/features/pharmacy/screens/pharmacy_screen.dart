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

class _PharmacyScreenState extends State<PharmacyScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  List<dynamic> _allOrders = [];
  List<Map<String, dynamic>> _catalog = [];
  bool _loading = true;
  bool _catalogLoading = false;
  String? _error;
  String? _catalogError;
  StaffRole _role = StaffRole.general;
  final TextEditingController _catalogSearchCtrl = TextEditingController();

  // Delivery tracking
  Timer? _locationTimer;
  int? _trackingOrderId;
  bool _sharingLocation = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);
    _loadRole();
    _loadOrders();
    _loadCatalog();
  }

  @override
  void dispose() {
    _stopLocationSharing(notify: false);
    _catalogSearchCtrl.dispose();
    _tabController.dispose();
    super.dispose();
  }

  bool get _canManageFormulary =>
      _role == StaffRole.pharmacyIncharge || _role.isAdminTier;

  Future<void> _loadRole() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    if (!mounted) return;
    setState(() => _role = role);
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
                            child: Text(
                              'Create Pharmacy Order',
                              style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          IconButton(
                            icon: const Icon(Icons.close),
                            tooltip: 'Close',
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
                        decoration: const InputDecoration(
                          labelText: 'Patient phone',
                          hintText: '10-digit mobile number',
                          prefixIcon: ExcludeSemantics(
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
                        decoration: const InputDecoration(
                          labelText: 'Order note',
                          hintText:
                              'Medicine names, dose, quantity, or Rx note',
                          prefixIcon: ExcludeSemantics(
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
                        title: const Text('Mark urgent'),
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
                  labelText: 'Notes (optional)',
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
            child: const Text('No'),
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
            Text('Cancel order ${order['order_number']}?'),
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
            child: const Text('No'),
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
                            tooltip: 'Close',
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
                        decoration: const InputDecoration(
                          labelText: 'Drug name with strength',
                          hintText: 'Paracetamol 650 mg',
                          prefixIcon: ExcludeSemantics(
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
                              decoration: const InputDecoration(
                                labelText: 'Generic name',
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: categoryCtrl,
                              decoration: const InputDecoration(
                                labelText: 'Category',
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
                              decoration: const InputDecoration(
                                labelText: 'Pack / strength note',
                                hintText: '10 tablets / strip',
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
                              decoration: const InputDecoration(
                                labelText: 'Unit price',
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
                              decoration: const InputDecoration(
                                labelText: 'Manufacturer',
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: stockCtrl,
                              keyboardType: TextInputType.number,
                              decoration: const InputDecoration(
                                labelText: 'Stock quantity',
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: reorderCtrl,
                              keyboardType: TextInputType.number,
                              decoration: const InputDecoration(
                                labelText: 'Reorder level',
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        value: requiresPrescription,
                        title: const Text('Prescription required'),
                        onChanged: submitting
                            ? null
                            : (value) => setSheetState(
                                () => requiresPrescription = value,
                              ),
                      ),
                      SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        value: inStock,
                        title: const Text('Available in formulary'),
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
        title: const Text('Remove from formulary?'),
        content: Text(
          '$name will be hidden from OP/IP prescribing suggestions and the pharmacy formulary list.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          ElevatedButton.icon(
            onPressed: () => Navigator.pop(ctx, true),
            icon: const Icon(Icons.delete_outline),
            label: const Text('Remove'),
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

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD
  // ═══════════════════════════════════════════════════════════════════════════

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.pharmacyTitle,
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
                        '${_newOrders.length} new • ${_activeOrders.length} active • ${_catalog.length} formulary',
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
                    _loadOrders();
                    _loadCatalog();
                  },
                ),
                const SizedBox(width: 4),
                ElevatedButton.icon(
                  onPressed: _createOrder,
                  icon: const Icon(Icons.add, color: Color(0xFFE65100)),
                  label: const Text('New'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.cardSurface,
                    foregroundColor: const Color(0xFFE65100),
                    minimumSize: const Size(0, 38),
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                  ),
                ),
              ],
            ),
          ),

          TabBar(
            controller: _tabController,
            labelColor: const Color(0xFFE65100),
            unselectedLabelColor: Colors.grey,
            indicatorColor: const Color(0xFFE65100),
            tabs: [
              Tab(text: '${s.pharmacyTabNew} (${_newOrders.length})'),
              Tab(text: '${s.pharmacyTabActive} (${_activeOrders.length})'),
              Tab(text: '${s.pharmacyTabDone} (${_completedOrders.length})'),
              Tab(text: 'Formulary (${_catalog.length})'),
            ],
          ),

          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                ? Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          _error!,
                          style: const TextStyle(color: Colors.red),
                        ),
                        const SizedBox(height: 12),
                        ElevatedButton(
                          onPressed: _loadOrders,
                          child: Text(s.actionRetry),
                        ),
                      ],
                    ),
                  )
                : TabBarView(
                    controller: _tabController,
                    children: [
                      _buildOrderList(_newOrders, s.pharmacyEmptyNew),
                      _buildOrderList(_activeOrders, s.pharmacyEmptyActive),
                      _buildOrderList(_completedOrders, s.pharmacyEmptyDone),
                      _buildFormularyTab(),
                    ],
                  ),
          ),
        ],
      ),
    );
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
                        child: Text(
                          'Shared Pharmacy Formulary',
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
                          label: const Text('Add Drug'),
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
                          decoration: const InputDecoration(
                            labelText: 'Search formulary',
                            hintText: 'Drug, generic, or strength',
                            prefixIcon: ExcludeSemantics(
                              child: Icon(Icons.search),
                            ),
                          ),
                          textInputAction: TextInputAction.search,
                          onSubmitted: (_) => _loadCatalog(),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton.filledTonal(
                        tooltip: 'Search',
                        onPressed: () => _loadCatalog(),
                        icon: const Icon(Icons.search),
                      ),
                      if (_catalogSearchCtrl.text.isNotEmpty) ...[
                        const SizedBox(width: 4),
                        IconButton(
                          tooltip: 'Clear search',
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
                      label: const Text('Retry'),
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
                  child: Text(
                    'No formulary drugs found',
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
                tooltip: 'Edit formulary drug',
                onPressed: () => _openCatalogEditor(item),
                icon: const Icon(Icons.edit_outlined),
              ),
              IconButton(
                tooltip: 'Remove from formulary',
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
