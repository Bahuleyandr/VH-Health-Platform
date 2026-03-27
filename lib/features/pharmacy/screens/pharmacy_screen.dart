import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/widgets/delivery_tracking_card.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

class PharmacyScreen extends StatefulWidget {
  final String phone;
  const PharmacyScreen({super.key, required this.phone});

  @override
  State<PharmacyScreen> createState() => _PharmacyScreenState();
}

class _PharmacyScreenState extends State<PharmacyScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  // ── Order Form ──
  final _noteController = TextEditingController();
  final _addressController = TextEditingController();
  final _landmarkController = TextEditingController();
  final _phoneController = TextEditingController();

  File? _prescriptionPhoto;
  String? _prescriptionName;
  bool _isSubmitting = false;
  String _deliveryType = 'delivery'; // 'delivery' | 'pickup'

  // ── My Orders ──
  List<dynamic> _orders = [];
  bool _isLoadingOrders = true;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _phoneController.text = widget.phone;
    _fetchOrders();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _noteController.dispose();
    _addressController.dispose();
    _landmarkController.dispose();
    _phoneController.dispose();
    super.dispose();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PICK PRESCRIPTION PHOTO
  // ═══════════════════════════════════════════════════════════════════════════

  Future<void> _pickPrescription(ImageSource source) async {
    final picker = ImagePicker();
    final picked = await picker.pickImage(
      source: source,
      maxWidth: 1920,
      maxHeight: 1920,
      imageQuality: 85,
    );
    if (picked != null && mounted) {
      setState(() {
        _prescriptionPhoto = File(picked.path);
        _prescriptionName = picked.name;
      });
    }
  }

  void _showImageSourcePicker() {
    showModalBottomSheet(
      context: context,
      builder: (ctx) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.camera_alt, color: Color(0xFF7E57C2)),
              title: const Text('Take Photo'),
              onTap: () {
                Navigator.pop(ctx);
                _pickPrescription(ImageSource.camera);
              },
            ),
            ListTile(
              leading: const Icon(Icons.photo_library, color: Color(0xFF7E57C2)),
              title: const Text('Choose from Gallery'),
              onTap: () {
                Navigator.pop(ctx);
                _pickPrescription(ImageSource.gallery);
              },
            ),
          ],
        ),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLACE ORDER
  // ═══════════════════════════════════════════════════════════════════════════

  Future<void> _placeOrder() async {
    if (_prescriptionPhoto == null && _noteController.text.trim().isEmpty) {
      _showSnack('Please upload a prescription or describe your order', isError: true);
      return;
    }

    setState(() => _isSubmitting = true);

    try {
      final headers = await ApiConfig.authenticatedAuthHeaders();
      final uri = Uri.parse('${ApiConfig.baseUrl}/pharmacy-orders/orders/place');
      final req = http.MultipartRequest('POST', uri);
      req.headers.addAll(headers);

      // Add prescription photo
      if (_prescriptionPhoto != null) {
        req.files.add(await http.MultipartFile.fromPath(
          'prescription',
          _prescriptionPhoto!.path,
          filename: _prescriptionName ?? 'prescription.jpg',
        ));
      }

      // Add form fields
      if (_noteController.text.trim().isNotEmpty) {
        req.fields['order_note'] = _noteController.text.trim();
      }
      req.fields['delivery_type'] = _deliveryType;
      if (_deliveryType == 'delivery') {
        if (_addressController.text.trim().isNotEmpty) {
          req.fields['delivery_address'] = _addressController.text.trim();
        }
        if (_landmarkController.text.trim().isNotEmpty) {
          req.fields['delivery_landmark'] = _landmarkController.text.trim();
        }
        if (_phoneController.text.trim().isNotEmpty) {
          req.fields['delivery_phone'] = _phoneController.text.trim();
        }
      }

      final streamed = await req.send().timeout(const Duration(seconds: 30));
      final body = await streamed.stream.bytesToString();

      if (!mounted) return;

      if (streamed.statusCode >= 200 && streamed.statusCode < 300) {
        final data = jsonDecode(body);
        final orderNumber = data['data']?['order_number'] ?? '';

        _showSnack('Order placed! $orderNumber');

        // Reset form
        setState(() {
          _prescriptionPhoto = null;
          _prescriptionName = null;
          _noteController.clear();
          _addressController.clear();
          _landmarkController.clear();
          _deliveryType = 'delivery';
        });

        // Show success dialog
        _showOrderPlacedDialog(orderNumber);

        // Switch to orders tab and refresh
        _tabController.animateTo(1);
        _fetchOrders();
      } else {
        final data = jsonDecode(body);
        _showSnack(data['message'] ?? 'Failed to place order', isError: true);
      }
    } catch (e) {
      if (mounted) {
        _showSnack('Error: ${e.toString().replaceFirst("Exception: ", "")}', isError: true);
      }
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  void _showOrderPlacedDialog(String orderNumber) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Row(
          children: [
            Icon(Icons.check_circle, color: Colors.green, size: 28),
            SizedBox(width: 8),
            Text('Order Placed!'),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (orderNumber.isNotEmpty)
              Text('Order Number: $orderNumber',
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            const SizedBox(height: 12),
            const Text(
              'Our pharmacist will review your prescription and confirm your order shortly. '
              'You\'ll receive a notification with the total cost.',
              style: TextStyle(color: Colors.grey),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FETCH ORDERS
  // ═══════════════════════════════════════════════════════════════════════════

  Future<void> _fetchOrders() async {
    try {
      final uri = Uri.parse('${ApiConfig.baseUrl}/pharmacy-orders/orders/my');
      final res = await http
          .get(uri, headers: await ApiConfig.authenticatedAuthHeaders())
          .timeout(const Duration(seconds: 10));

      if (!mounted) return;

      if (res.statusCode == 200) {
        final body = jsonDecode(res.body);
        setState(() {
          _orders = body['data'] ?? [];
          _isLoadingOrders = false;
        });
      } else {
        setState(() => _isLoadingOrders = false);
      }
    } catch (e) {
      if (mounted) setState(() => _isLoadingOrders = false);
    }
  }

  void _showSnack(String msg, {bool isError = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: isError ? Colors.red.shade700 : Colors.green.shade700,
    ));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD
  // ═══════════════════════════════════════════════════════════════════════════

  @override
  Widget build(BuildContext context) {
    return FeatureScreenScaffold(
      title: 'Pharmacy',
      icon: Icons.local_pharmacy,
      color: const Color(0xFFD1C4E9),
      child: Column(
        children: [
          TabBar(
            controller: _tabController,
            labelColor: const Color(0xFF7E57C2),
            unselectedLabelColor: Colors.grey,
            indicatorColor: const Color(0xFF7E57C2),
            tabs: const [
              Tab(icon: Icon(Icons.add_shopping_cart), text: 'Order'),
              Tab(icon: Icon(Icons.receipt_long), text: 'My Orders'),
            ],
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _buildOrderTab(),
                _buildMyOrdersTab(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TAB 1: ORDER MEDICINES
  // ═══════════════════════════════════════════════════════════════════════════

  Widget _buildOrderTab() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Prescription upload
          const Text('Upload Prescription',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),

          GestureDetector(
            onTap: _showImageSourcePicker,
            child: Container(
              width: double.infinity,
              height: _prescriptionPhoto != null ? 200 : 120,
              decoration: BoxDecoration(
                color: Colors.grey.shade100,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: const Color(0xFF7E57C2).withValues(alpha: 0.3),
                  width: 2,
                  style: BorderStyle.solid,
                ),
              ),
              child: _prescriptionPhoto != null
                  ? Stack(
                      children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.file(_prescriptionPhoto!,
                              width: double.infinity,
                              height: 200,
                              fit: BoxFit.cover),
                        ),
                        Positioned(
                          top: 8,
                          right: 8,
                          child: GestureDetector(
                            onTap: () => setState(() {
                              _prescriptionPhoto = null;
                              _prescriptionName = null;
                            }),
                            child: Container(
                              padding: const EdgeInsets.all(4),
                              decoration: const BoxDecoration(
                                color: Colors.red,
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(Icons.close,
                                  color: Colors.white, size: 16),
                            ),
                          ),
                        ),
                      ],
                    )
                  : const Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.camera_alt,
                            size: 36, color: Color(0xFF7E57C2)),
                        SizedBox(height: 8),
                        Text('Tap to upload prescription',
                            style: TextStyle(color: Colors.grey)),
                        Text('Camera or Gallery',
                            style:
                                TextStyle(color: Colors.grey, fontSize: 12)),
                      ],
                    ),
            ),
          ),

          const SizedBox(height: 16),

          // OR describe order
          const Text('Or Describe Your Order',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
          const SizedBox(height: 8),
          TextField(
            controller: _noteController,
            maxLines: 3,
            decoration: InputDecoration(
              hintText: 'e.g., Dolo 650 - 2 strips, Pan 40 - 1 strip...',
              border:
                  OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            ),
          ),

          const SizedBox(height: 20),

          // Delivery preference
          const Text('Delivery Preference',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: _DeliveryOption(
                  icon: Icons.delivery_dining,
                  label: 'Home Delivery',
                  selected: _deliveryType == 'delivery',
                  onTap: () => setState(() => _deliveryType = 'delivery'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _DeliveryOption(
                  icon: Icons.store,
                  label: 'Pickup',
                  selected: _deliveryType == 'pickup',
                  onTap: () => setState(() => _deliveryType = 'pickup'),
                ),
              ),
            ],
          ),

          // Delivery address fields
          if (_deliveryType == 'delivery') ...[
            const SizedBox(height: 16),
            TextField(
              controller: _addressController,
              maxLines: 2,
              decoration: InputDecoration(
                labelText: 'Delivery Address',
                hintText: 'House/Flat, Street, Area...',
                prefixIcon: const Icon(Icons.location_on),
                border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _landmarkController,
              decoration: InputDecoration(
                labelText: 'Landmark (optional)',
                hintText: 'Near...',
                prefixIcon: const Icon(Icons.place),
                border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _phoneController,
              keyboardType: TextInputType.phone,
              decoration: InputDecoration(
                labelText: 'Contact Phone',
                prefixIcon: const Icon(Icons.phone),
                border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
            ),
          ],

          const SizedBox(height: 24),

          // Place Order button
          SizedBox(
            width: double.infinity,
            height: 50,
            child: ElevatedButton.icon(
              onPressed: _isSubmitting ? null : _placeOrder,
              icon: _isSubmitting
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                          color: Colors.white, strokeWidth: 2))
                  : const Icon(Icons.shopping_cart_checkout,
                      color: Colors.white),
              label: Text(
                _isSubmitting ? 'Placing Order...' : 'Place Order',
                style:
                    const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF7E57C2),
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
            ),
          ),

          const SizedBox(height: 32),
        ],
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TAB 2: MY ORDERS
  // ═══════════════════════════════════════════════════════════════════════════

  Widget _buildMyOrdersTab() {
    if (_isLoadingOrders) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_orders.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.receipt_long, size: 64, color: Colors.grey.shade300),
            const SizedBox(height: 16),
            Text('No orders yet',
                style: TextStyle(
                    fontSize: 16,
                    color: Colors.grey.shade500,
                    fontWeight: FontWeight.w500)),
            const SizedBox(height: 8),
            Text('Place your first order from the Order tab',
                style:
                    TextStyle(fontSize: 13, color: Colors.grey.shade400)),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchOrders,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _orders.length,
        itemBuilder: (ctx, i) => _OrderCard(
          order: _orders[i],
          onTap: () => _showOrderDetail(_orders[i]),
        ),
      ),
    );
  }

  void _showOrderDetail(Map<String, dynamic> order) {
    final items = order['items_list'];
    final List<dynamic> itemsList = items is List
        ? items
        : (items is String ? (jsonDecode(items) as List) : []);

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => DraggableScrollableSheet(
        initialChildSize: 0.7,
        maxChildSize: 0.9,
        minChildSize: 0.4,
        expand: false,
        builder: (ctx, scrollCtrl) => SingleChildScrollView(
          controller: scrollCtrl,
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Handle
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: Colors.grey.shade300,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 16),

              // Order number + status
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    order['order_number'] ?? '#${order['id']}',
                    style: const TextStyle(
                        fontSize: 18, fontWeight: FontWeight.bold),
                  ),
                  _StatusChip(status: order['status'] ?? 'PLACED'),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                _formatDate(order['created_at']),
                style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
              ),

              const SizedBox(height: 20),

              // Status tracker
              _StatusTracker(status: order['status'] ?? 'PLACED'),

              const SizedBox(height: 20),

              // Prescription photo
              if (order['prescription_photo_url'] != null) ...[
                const Text('Prescription',
                    style:
                        TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                const SizedBox(height: 8),
                ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Image.network(
                    order['prescription_photo_url'],
                    height: 200,
                    width: double.infinity,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => Container(
                      height: 100,
                      color: Colors.grey.shade200,
                      child: const Center(
                          child: Icon(Icons.broken_image, size: 40)),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
              ],

              // Order note
              if (order['order_note'] != null &&
                  order['order_note'].toString().isNotEmpty) ...[
                const Text('Order Note',
                    style:
                        TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                const SizedBox(height: 4),
                Text(order['order_note']),
                const SizedBox(height: 16),
              ],

              // Items list
              if (itemsList.isNotEmpty) ...[
                const Text('Items',
                    style:
                        TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                const SizedBox(height: 8),
                ...itemsList.map((item) => Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                              child: Text(
                                  '${item['name']} x${item['qty'] ?? 1}')),
                          Text('₹${item['price'] ?? '-'}',
                              style:
                                  const TextStyle(fontWeight: FontWeight.w500)),
                        ],
                      ),
                    )),
                const Divider(),
              ],

              // Total
              if (order['total_cost'] != null) ...[
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text('Total',
                        style: TextStyle(
                            fontSize: 16, fontWeight: FontWeight.bold)),
                    Text('₹${order['total_cost']}',
                        style: const TextStyle(
                            fontSize: 16, fontWeight: FontWeight.bold)),
                  ],
                ),
                const SizedBox(height: 16),
              ],

              // Delivery info
              if (order['delivery_type'] == 'delivery') ...[
                const Divider(),
                const Text('Delivery Info',
                    style:
                        TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                const SizedBox(height: 8),
                if (order['delivery_address'] != null)
                  _InfoRow(Icons.location_on, order['delivery_address']),
                if (order['delivery_phone'] != null)
                  _InfoRow(Icons.phone, order['delivery_phone']),
              ],

              // Delivery tracking card (when dispatched)
              if (order['status'] == 'DISPATCHED') ...[
                const SizedBox(height: 12),
                DeliveryTrackingCard(
                  orderType: 'pharmacy',
                  orderId: order['id'],
                  dispatchedAt: order['dispatched_at']?.toString(),
                ),
              ],

              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }

  String _formatDate(dynamic dateStr) {
    if (dateStr == null) return '';
    try {
      final dt = DateTime.parse(dateStr.toString());
      return DateFormat('dd MMM yyyy, hh:mm a').format(dt);
    } catch (_) {
      return dateStr.toString();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WIDGETS
// ═══════════════════════════════════════════════════════════════════════════════

class _DeliveryOption extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _DeliveryOption({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: BoxDecoration(
          color: selected
              ? const Color(0xFF7E57C2).withValues(alpha: 0.1)
              : Colors.grey.shade100,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: selected ? const Color(0xFF7E57C2) : Colors.grey.shade300,
            width: selected ? 2 : 1,
          ),
        ),
        child: Column(
          children: [
            Icon(icon,
                color: selected ? const Color(0xFF7E57C2) : Colors.grey,
                size: 28),
            const SizedBox(height: 4),
            Text(label,
                style: TextStyle(
                    color: selected ? const Color(0xFF7E57C2) : Colors.grey,
                    fontWeight: selected ? FontWeight.bold : FontWeight.normal,
                    fontSize: 13)),
          ],
        ),
      ),
    );
  }
}

class _OrderCard extends StatelessWidget {
  final Map<String, dynamic> order;
  final VoidCallback onTap;

  const _OrderCard({required this.order, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final status = order['status'] ?? 'PLACED';
    final orderNum = order['order_number'] ?? '#${order['id']}';
    final date = order['created_at'];
    final cost = order['total_cost'];

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      elevation: 1,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(orderNum,
                      style: const TextStyle(
                          fontWeight: FontWeight.bold, fontSize: 15)),
                  _StatusChip(status: status),
                ],
              ),
              const SizedBox(height: 8),
              // Mini status tracker
              _MiniStatusTracker(status: status),
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  if (date != null)
                    Text(_formatCardDate(date),
                        style: TextStyle(
                            color: Colors.grey.shade600, fontSize: 12)),
                  if (cost != null)
                    Text('₹$cost',
                        style: const TextStyle(
                            fontWeight: FontWeight.bold,
                            color: Color(0xFF7E57C2))),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _formatCardDate(dynamic d) {
    try {
      return DateFormat('dd MMM, hh:mm a').format(DateTime.parse(d.toString()));
    } catch (_) {
      return '';
    }
  }
}

class _StatusChip extends StatelessWidget {
  final String status;
  const _StatusChip({required this.status});

  @override
  Widget build(BuildContext context) {
    final (color, label) = switch (status.toUpperCase()) {
      'PLACED' => (Colors.orange, 'Placed'),
      'CONFIRMED' => (Colors.blue, 'Confirmed'),
      'PREPARING' => (Colors.amber.shade700, 'Preparing'),
      'DISPATCHED' => (Colors.teal, 'Dispatched'),
      'DELIVERED' => (Colors.green, 'Delivered'),
      'CANCELLED' => (Colors.red, 'Cancelled'),
      _ => (Colors.grey, status),
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(label,
          style: TextStyle(
              color: color, fontSize: 12, fontWeight: FontWeight.w600)),
    );
  }
}

class _MiniStatusTracker extends StatelessWidget {
  final String status;
  const _MiniStatusTracker({required this.status});

  @override
  Widget build(BuildContext context) {
    if (status.toUpperCase() == 'CANCELLED') {
      return Row(
        children: [
          Icon(Icons.cancel, color: Colors.red.shade400, size: 16),
          const SizedBox(width: 4),
          Text('Order Cancelled',
              style: TextStyle(color: Colors.red.shade400, fontSize: 12)),
        ],
      );
    }

    const steps = ['PLACED', 'CONFIRMED', 'PREPARING', 'DISPATCHED', 'DELIVERED'];
    final currentIdx = steps.indexOf(status.toUpperCase());

    return Row(
      children: List.generate(steps.length * 2 - 1, (i) {
        if (i.isOdd) {
          // Connector line
          final stepIdx = i ~/ 2;
          return Expanded(
            child: Container(
              height: 2,
              color: stepIdx < currentIdx
                  ? const Color(0xFF7E57C2)
                  : Colors.grey.shade300,
            ),
          );
        }
        final stepIdx = i ~/ 2;
        final done = stepIdx <= currentIdx;
        return Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: done ? const Color(0xFF7E57C2) : Colors.grey.shade300,
          ),
        );
      }),
    );
  }
}

class _StatusTracker extends StatelessWidget {
  final String status;
  const _StatusTracker({required this.status});

  @override
  Widget build(BuildContext context) {
    if (status.toUpperCase() == 'CANCELLED') {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.red.shade50,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: [
            Icon(Icons.cancel, color: Colors.red.shade400, size: 32),
            const SizedBox(width: 12),
            const Text('Order Cancelled',
                style: TextStyle(
                    color: Colors.red,
                    fontWeight: FontWeight.bold,
                    fontSize: 16)),
          ],
        ),
      );
    }

    const steps = [
      ('PLACED', 'Order Placed', Icons.receipt_long),
      ('CONFIRMED', 'Confirmed', Icons.check_circle),
      ('PREPARING', 'Preparing', Icons.medication),
      ('DISPATCHED', 'Dispatched', Icons.delivery_dining),
      ('DELIVERED', 'Delivered', Icons.done_all),
    ];
    final currentIdx =
        steps.indexWhere((s) => s.$1 == status.toUpperCase());

    return Column(
      children: List.generate(steps.length, (i) {
        final (_, label, icon) = steps[i];
        final done = i <= currentIdx;
        final current = i == currentIdx;

        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Column(
              children: [
                Container(
                  width: 28,
                  height: 28,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: done
                        ? const Color(0xFF7E57C2)
                        : Colors.grey.shade200,
                  ),
                  child: Icon(icon,
                      size: 16,
                      color: done ? Colors.white : Colors.grey.shade400),
                ),
                if (i < steps.length - 1)
                  Container(
                    width: 2,
                    height: 24,
                    color: i < currentIdx
                        ? const Color(0xFF7E57C2)
                        : Colors.grey.shade200,
                  ),
              ],
            ),
            const SizedBox(width: 12),
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(label,
                  style: TextStyle(
                    fontWeight: current ? FontWeight.bold : FontWeight.normal,
                    color: done ? Colors.black87 : Colors.grey.shade400,
                    fontSize: 14,
                  )),
            ),
          ],
        );
      }),
    );
  }
}

class _InfoRow extends StatelessWidget {
  final IconData icon;
  final String text;
  const _InfoRow(this.icon, this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: [
          Icon(icon, size: 16, color: Colors.grey.shade600),
          const SizedBox(width: 8),
          Expanded(
              child: Text(text,
                  style: TextStyle(color: Colors.grey.shade700, fontSize: 13))),
        ],
      ),
    );
  }
}
