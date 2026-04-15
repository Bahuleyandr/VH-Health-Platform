import 'dart:convert';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/delivery_tracking_card.dart';
import 'package:vhhealth/features/pharmacy/widgets/order_status_widgets.dart';

class OrderListTab extends StatefulWidget {
  const OrderListTab({super.key});

  @override
  State<OrderListTab> createState() => OrderListTabState();
}

class OrderListTabState extends State<OrderListTab> {
  List<dynamic> _orders = [];
  bool _isLoadingOrders = true;

  @override
  void initState() {
    super.initState();
    _fetchOrders();
  }

  /// Public method so the parent can trigger a refresh after placing an order.
  Future<void> refresh() => _fetchOrders();

  // ═══════════════════════════════════════════════════════════════════════════
  // FETCH ORDERS
  // ═══════════════════════════════════════════════════════════════════════════

  Future<void> _fetchOrders() async {
    try {
      final response = await ApiClient.get(
        '/pharmacy-orders/orders/my',
        timeout: const Duration(seconds: 10),
      );

      if (!mounted) return;

      if (response.isSuccess) {
        setState(() {
          _orders = response.data ?? [];
          _isLoadingOrders = false;
        });
      } else {
        setState(() => _isLoadingOrders = false);
      }
    } catch (e) {
      if (mounted) setState(() => _isLoadingOrders = false);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ORDER DETAIL BOTTOM SHEET
  // ═══════════════════════════════════════════════════════════════════════════

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
                  PharmacyStatusChip(status: order['status'] ?? 'PLACED'),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                _formatDate(order['created_at']),
                style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
              ),

              const SizedBox(height: 20),

              // Status tracker
              PharmacyStatusTracker(status: order['status'] ?? 'PLACED'),

              const SizedBox(height: 20),

              // Prescription photo
              if (order['prescription_photo_url'] != null) ...[
                const Text('Prescription',
                    style:
                        TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                const SizedBox(height: 8),
                ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: CachedNetworkImage(
                    imageUrl: order['prescription_photo_url'],
                    height: 200,
                    width: double.infinity,
                    fit: BoxFit.cover,
                    placeholder: (context, _) => Container(
                      height: 200,
                      color: Theme.of(context).colorScheme.surfaceContainerLow,
                      child: const Center(
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                    errorWidget: (context, _, _) => Container(
                      height: 100,
                      color: Theme.of(context).colorScheme.surfaceContainerLow,
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
                          Text('\u20B9${item['price'] ?? '-'}',
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
                    Text('\u20B9${order['total_cost']}',
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
                  PharmacyInfoRow(Icons.location_on, order['delivery_address']),
                if (order['delivery_phone'] != null)
                  PharmacyInfoRow(Icons.phone, order['delivery_phone']),
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
    } catch (e) {
      debugPrint('Order list date format failed: $e');
      return dateStr.toString();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD
  // ═══════════════════════════════════════════════════════════════════════════

  @override
  Widget build(BuildContext context) {
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
        itemBuilder: (ctx, i) => PharmacyOrderCard(
          order: _orders[i],
          onTap: () => _showOrderDetail(_orders[i]),
        ),
      ),
    );
  }
}
