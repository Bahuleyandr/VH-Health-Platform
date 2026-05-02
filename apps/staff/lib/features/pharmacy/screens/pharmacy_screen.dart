import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/pharmacy_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

class PharmacyScreen extends StatefulWidget {
  const PharmacyScreen({super.key});

  @override
  State<PharmacyScreen> createState() => _PharmacyScreenState();
}

class _PharmacyScreenState extends State<PharmacyScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  List<dynamic> _allOrders = [];
  bool _loading = true;
  String? _error;

  // Delivery tracking
  Timer? _locationTimer;
  int? _trackingOrderId;
  bool _sharingLocation = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _loadOrders();
  }

  @override
  void dispose() {
    _stopLocationSharing();
    _tabController.dispose();
    super.dispose();
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

  void _stopLocationSharing() {
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
    if (mounted) setState(() {});
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

  List<dynamic> get _newOrders =>
      _allOrders.where((o) => o['status'] == 'PLACED').toList();

  List<dynamic> get _activeOrders => _allOrders
      .where(
        (o) => ['CONFIRMED', 'PREPARING', 'DISPATCHED'].contains(o['status']),
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

  Future<void> _confirmOrder(Map<String, dynamic> order) async {
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
                    'Confirm ${order['order_number'] ?? ''}',
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close),
                    tooltip: 'Close',
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
                      child: const Center(child: Text('No preview')),
                    ),
                  ),
                ),
              ],

              if (order['order_note'] != null &&
                  order['order_note'].toString().isNotEmpty) ...[
                const SizedBox(height: 12),
                Text(
                  'Patient Note: ${order['order_note']}',
                  style: const TextStyle(fontStyle: FontStyle.italic),
                ),
              ],

              const SizedBox(height: 16),
              TextField(
                controller: itemsController,
                maxLines: 3,
                decoration: InputDecoration(
                  labelText: 'Items (one per line: name, qty, price)',
                  hintText: 'Dolo 650, 2, 60\nPan 40, 1, 95',
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
                  labelText: 'Total Cost (₹)',
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
                  label: const Text('Confirm Order'),
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
      _snack('Order confirmed');
      _loadOrders();
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _markPreparing(Map<String, dynamic> order) async {
    try {
      await PharmacyApiService.markPharmacyPreparing(order['id']);
      _snack('Marked as preparing');
      _loadOrders();
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _dispatchOrder(Map<String, dynamic> order) async {
    final personCtrl = TextEditingController();
    final phoneCtrl = TextEditingController();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Dispatch Order'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: personCtrl,
              decoration: const InputDecoration(
                labelText: 'Delivery Person Name',
                prefixIcon: ExcludeSemantics(child: Icon(Icons.person)),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: phoneCtrl,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                labelText: 'Delivery Person Phone',
                prefixIcon: ExcludeSemantics(child: Icon(Icons.phone)),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Dispatch'),
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
      _snack('Order dispatched');
      _startLocationSharing(order['id']);
      _loadOrders();
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _markDelivered(Map<String, dynamic> order) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Mark Delivered?'),
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
            child: const Text('Yes, Delivered'),
          ),
        ],
      ),
    );

    if (confirm != true) return;

    try {
      await PharmacyApiService.markPharmacyDelivered(order['id']);
      _stopLocationSharing();
      _snack('Marked as delivered');
      _loadOrders();
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  Future<void> _cancelOrder(Map<String, dynamic> order) async {
    final reasonCtrl = TextEditingController();
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cancel Order?'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Cancel order ${order['order_number']}?'),
            const SizedBox(height: 12),
            TextField(
              controller: reasonCtrl,
              decoration: const InputDecoration(
                labelText: 'Reason for cancellation',
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
            child: const Text(
              'Cancel Order',
              style: TextStyle(color: Colors.white),
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
      _snack('Order cancelled');
      _loadOrders();
    } catch (e) {
      _snack(e.toString(), isError: true);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD
  // ═══════════════════════════════════════════════════════════════════════════

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Pharmacy Orders',
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
                      const Text(
                        'Pharmacy Queue',
                        style: TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 16,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${_newOrders.length} new • ${_activeOrders.length} active',
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
                  tooltip: 'Refresh orders',
                  onPressed: _loadOrders,
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
              Tab(text: 'New (${_newOrders.length})'),
              Tab(text: 'Active (${_activeOrders.length})'),
              Tab(text: 'Done (${_completedOrders.length})'),
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
                          child: const Text('Retry'),
                        ),
                      ],
                    ),
                  )
                : TabBarView(
                    controller: _tabController,
                    children: [
                      _buildOrderList(_newOrders, 'No new orders'),
                      _buildOrderList(_activeOrders, 'No active orders'),
                      _buildOrderList(_completedOrders, 'No completed orders'),
                    ],
                  ),
          ),
        ],
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
                  deliveryType == 'pickup' ? 'Pickup' : 'Delivery',
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
                else if (status == 'PLACED')
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
    final status = order['status'];

    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        if (status == 'PLACED')
          _ActionBtn(
            label: 'View & Confirm',
            icon: Icons.check_circle_outline,
            color: AppTheme.primaryBlue,
            onTap: () => _confirmOrder(order),
          ),
        if (status == 'CONFIRMED')
          _ActionBtn(
            label: 'Start Preparing',
            icon: Icons.medication,
            color: AppTheme.warningAmber,
            onTap: () => _markPreparing(order),
          ),
        if (status == 'PREPARING')
          _ActionBtn(
            label: 'Dispatch',
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
                    '📍 Sharing location...',
                    style: TextStyle(
                      fontSize: 12,
                      color: Colors.green.shade700,
                    ),
                  ),
                ],
              ),
            ),
          _ActionBtn(
            label: 'Mark Delivered',
            icon: Icons.done_all,
            color: AppTheme.successGreen,
            onTap: () => _markDelivered(order),
          ),
        ],
        if (!['DELIVERED', 'CANCELLED'].contains(status))
          _ActionBtn(
            label: 'Cancel',
            icon: Icons.cancel_outlined,
            color: AppTheme.errorRed,
            onTap: () => _cancelOrder(order),
          ),
      ],
    );
  }

  Widget _buildStatusChip(String status) {
    final (color, label) = switch (status) {
      'PLACED' => (Colors.orange, 'Placed'),
      'CONFIRMED' => (AppTheme.primaryBlue, 'Confirmed'),
      'PREPARING' => (AppTheme.warningAmber, 'Preparing'),
      'DISPATCHED' => (Colors.teal, 'Dispatched'),
      'DELIVERED' => (AppTheme.successGreen, 'Delivered'),
      'CANCELLED' => (AppTheme.errorRed, 'Cancelled'),
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
