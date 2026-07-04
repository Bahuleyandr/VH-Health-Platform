import 'dart:convert';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/delivery_tracking_card.dart';
import 'package:vhhealth/features/pharmacy/widgets/order_status_widgets.dart';
import 'package:vhhealth/generated/app_localizations.dart';

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
    final theme = Theme.of(context);
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
                    color: theme.colorScheme.outlineVariant,
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
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  PharmacyStatusChip(status: order['status'] ?? 'PENDING'),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                _formatDate(order['created_at']),
                style: TextStyle(
                  color: theme.colorScheme.onSurfaceVariant,
                  fontSize: 13,
                ),
              ),

              const SizedBox(height: 20),

              // Status tracker
              PharmacyStatusTracker(status: order['status'] ?? 'PENDING'),

              const SizedBox(height: 20),

              // Prescription photo
              if (order['prescription_photo_url'] != null) ...[
                const Text(
                  'Prescription',
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold),
                ),
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
                        child: Icon(Icons.broken_image, size: 40),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
              ],

              // Order note
              if (order['order_note'] != null &&
                  order['order_note'].toString().isNotEmpty) ...[
                Text(
                  AppLocalizations.of(context)!.pharmacyOrderNote,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 4),
                Text(order['order_note']),
                const SizedBox(height: 16),
              ],

              // Items list \u2014 surfaces the dispensed medication schedule
              // (route + frequency + duration + instructions per item) so
              // the patient / caregiver can safely administer multi-drug
              // regimens at home. Each field renders only when populated;
              // legacy orders that only carry name + qty + price keep
              // their old compact look.
              if (itemsList.isNotEmpty) ...[
                const Text(
                  'Items',
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 8),
                ...itemsList.map((item) {
                  final scheduleParts = <String>[
                    if (item is Map &&
                        item['dose'] != null &&
                        '${item['dose']}'.isNotEmpty)
                      '${item['dose']}',
                    if (item is Map &&
                        item['route'] != null &&
                        '${item['route']}'.isNotEmpty)
                      '${item['route']}',
                    if (item is Map &&
                        item['frequency'] != null &&
                        '${item['frequency']}'.isNotEmpty)
                      '${item['frequency']}',
                    if (item is Map &&
                        item['duration'] != null &&
                        '${item['duration']}'.isNotEmpty)
                      '${item['duration']}',
                  ];
                  final instructions = item is Map
                      ? item['instructions']
                      : null;
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Expanded(
                              child: Text(
                                '${item is Map ? (item['name'] ?? '') : ''} x${item is Map ? (item['qty'] ?? 1) : 1}',
                                style: const TextStyle(
                                  fontWeight: FontWeight.w500,
                                ),
                              ),
                            ),
                            if (item is Map && item['price'] != null)
                              Text(
                                '\u20B9${item['price']}',
                                style: const TextStyle(
                                  fontWeight: FontWeight.w500,
                                ),
                              ),
                          ],
                        ),
                        if (scheduleParts.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(
                              scheduleParts.join(' \u2022 '),
                              style: TextStyle(
                                fontSize: 12,
                                color: Theme.of(
                                  context,
                                ).colorScheme.onSurfaceVariant,
                              ),
                            ),
                          ),
                        if (instructions != null &&
                            '$instructions'.trim().isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(
                              '$instructions',
                              style: TextStyle(
                                fontSize: 12,
                                fontStyle: FontStyle.italic,
                                color: Theme.of(
                                  context,
                                ).colorScheme.onSurfaceVariant,
                              ),
                            ),
                          ),
                      ],
                    ),
                  );
                }),
                const Divider(),
              ],

              // Total
              if (order['total_cost'] != null) ...[
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text(
                      'Total',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    Text(
                      '\u20B9${order['total_cost']}',
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
              ],

              // Delivery info
              if (order['delivery_type'] == 'delivery') ...[
                const Divider(),
                Text(
                  AppLocalizations.of(context)!.pharmacyDeliveryInfo,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.bold,
                  ),
                ),
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
    final theme = Theme.of(context);
    if (_isLoadingOrders) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_orders.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.receipt_long,
              size: 64,
              color: theme.colorScheme.outlineVariant,
            ),
            const SizedBox(height: 16),
            Text(
              AppLocalizations.of(context)!.pharmacyOrdersEmpty,
              style: TextStyle(
                fontSize: 16,
                color: theme.colorScheme.onSurfaceVariant,
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              AppLocalizations.of(context)!.pharmacyOrdersEmptyHint,
              style: TextStyle(
                fontSize: 13,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
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
