import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import 'package:vhhealth/core/config/api_config.dart';

/// Reusable delivery tracking card for pharmacy orders and investigation bookings.
/// Shows ETA, distance, delivery person info, and a progress indicator.
class DeliveryTrackingCard extends StatefulWidget {
  final String orderType; // 'pharmacy' | 'investigation'
  final int orderId;
  final String? dispatchedAt;

  const DeliveryTrackingCard({
    super.key,
    required this.orderType,
    required this.orderId,
    this.dispatchedAt,
  });

  @override
  State<DeliveryTrackingCard> createState() => _DeliveryTrackingCardState();
}

class _DeliveryTrackingCardState extends State<DeliveryTrackingCard> {
  Timer? _refreshTimer;
  Map<String, dynamic>? _trackingData;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _fetchTracking();
    // Auto-refresh every 30 seconds
    _refreshTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      _fetchTracking();
    });
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }

  Future<void> _fetchTracking() async {
    try {
      final uri = Uri.parse(
          '${ApiConfig.baseUrl}/delivery/track/${widget.orderType}/${widget.orderId}');
      final res = await http
          .get(uri, headers: await ApiConfig.authenticatedAuthHeaders())
          .timeout(const Duration(seconds: 8));

      if (!mounted) return;

      if (res.statusCode == 200) {
        final body = jsonDecode(res.body);
        setState(() {
          _trackingData = body['data'];
          _loading = false;
        });
      } else {
        setState(() => _loading = false);
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  double _calculateProgress() {
    if (_trackingData == null || widget.dispatchedAt == null) return 0.0;

    final estimatedMins = _trackingData!['estimated_delivery_mins'];
    if (estimatedMins == null || estimatedMins == 0) return 0.0;

    final dispatched = DateTime.tryParse(widget.dispatchedAt!);
    if (dispatched == null) return 0.0;

    final elapsed = DateTime.now().toUtc().difference(dispatched.toUtc()).inMinutes;
    // Use original ETA estimate for progress (not the shrinking live ETA)
    final totalEstimate = elapsed + (estimatedMins as num).toInt();
    if (totalEstimate <= 0) return 0.0;

    return (elapsed / totalEstimate).clamp(0.0, 0.95);
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _trackingData == null) {
      return const SizedBox.shrink();
    }

    final data = _trackingData;
    if (data == null) return const SizedBox.shrink();

    final etaMins = data['estimated_delivery_mins'];
    final distanceKm = data['delivery_distance_km'];
    final deliveryPerson = data['delivery_person'];
    final deliveryPhone = data['delivery_person_phone'];
    final isActive = data['delivery_tracking_active'] == true;
    final progress = _calculateProgress();

    final theme = Theme.of(context);

    final label = widget.orderType == 'pharmacy'
        ? 'Delivery On The Way'
        : 'Collector On The Way';
    final icon = widget.orderType == 'pharmacy'
        ? Icons.delivery_dining
        : Icons.directions_car;

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [theme.colorScheme.primaryContainer.withAlpha(77), theme.colorScheme.primaryContainer.withAlpha(38)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: theme.colorScheme.primary.withAlpha(77)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Row(
            children: [
              Icon(icon, color: theme.colorScheme.primary, size: 24),
              const SizedBox(width: 8),
              Text(
                '🚗 $label',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                  color: theme.colorScheme.primary,
                ),
              ),
              const Spacer(),
              if (isActive)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: Colors.green.shade100,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.my_location, size: 12, color: Colors.green.shade700),
                      const SizedBox(width: 4),
                      Text('Live', style: TextStyle(fontSize: 11, color: Colors.green.shade700, fontWeight: FontWeight.bold)),
                    ],
                  ),
                ),
            ],
          ),

          const SizedBox(height: 12),

          // ETA and distance
          Row(
            children: [
              if (etaMins != null) ...[
                Icon(Icons.schedule, size: 18, color: Colors.teal.shade600),
                const SizedBox(width: 6),
                Text(
                  'Estimated arrival: ~$etaMins min',
                  style: TextStyle(fontSize: 14, color: Colors.teal.shade800),
                ),
              ],
              if (distanceKm != null) ...[
                const SizedBox(width: 16),
                Icon(Icons.straighten, size: 18, color: Colors.teal.shade600),
                const SizedBox(width: 6),
                Text(
                  '$distanceKm km',
                  style: TextStyle(fontSize: 14, color: Colors.teal.shade800),
                ),
              ],
            ],
          ),

          // Delivery person
          if (deliveryPerson != null || deliveryPhone != null) ...[
            const SizedBox(height: 12),
            Row(
              children: [
                Icon(Icons.person, size: 18, color: Colors.teal.shade600),
                const SizedBox(width: 6),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (deliveryPerson != null)
                        Text(deliveryPerson, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                      if (deliveryPhone != null)
                        Text(deliveryPhone, style: TextStyle(color: Colors.grey.shade600, fontSize: 13)),
                    ],
                  ),
                ),
                if (deliveryPhone != null)
                  IconButton(
                    icon: Icon(Icons.call, color: Colors.teal.shade700),
                    onPressed: () => launchUrl(Uri.parse('tel:$deliveryPhone')),
                    tooltip: 'Call',
                  ),
              ],
            ),
          ],

          const SizedBox(height: 16),

          // Progress bar
          Column(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: progress,
                  minHeight: 6,
                  backgroundColor: Colors.teal.shade100,
                  valueColor: AlwaysStoppedAnimation(Colors.teal.shade600),
                ),
              ),
              const SizedBox(height: 6),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('Hospital',
                      style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
                  Text('Your Location',
                      style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }
}
