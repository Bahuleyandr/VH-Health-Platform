import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:vhhealth/core/config/api_config.dart';

class MyBookingsScreen extends StatefulWidget {
  const MyBookingsScreen({super.key});

  @override
  State<MyBookingsScreen> createState() => _MyBookingsScreenState();
}

class _MyBookingsScreenState extends State<MyBookingsScreen> {
  List<dynamic> _bookings = [];
  bool _loading = true;
  String? _error;

  static const _statusOrder = [
    'BOOKED',
    'CONFIRMED',
    'DISPATCHED',
    'COLLECTED',
    'PROCESSING',
    'RESULT_READY',
  ];

  static const _statusLabels = {
    'BOOKED': 'Booked',
    'CONFIRMED': 'Confirmed',
    'DISPATCHED': 'Collector Dispatched',
    'COLLECTED': 'Samples Collected',
    'PROCESSING': 'Processing',
    'RESULT_READY': 'Results Ready',
  };

  static const _statusIcons = {
    'BOOKED': Icons.bookmark_added,
    'CONFIRMED': Icons.check_circle_outline,
    'DISPATCHED': Icons.directions_car,
    'COLLECTED': Icons.science,
    'PROCESSING': Icons.hourglass_top,
    'RESULT_READY': Icons.assignment_turned_in,
  };

  @override
  void initState() {
    super.initState();
    _fetchBookings();
  }

  Future<void> _fetchBookings() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final res = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/investigations/bookings/my'),
        headers: headers,
      );
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        setState(() {
          _bookings = data['data'] is List ? data['data'] : [];
          _loading = false;
        });
      } else {
        setState(() {
          _error = 'Failed to load bookings';
          _loading = false;
        });
      }
    } catch (e) {
      setState(() {
        _error = 'Error: ${e.toString()}';
        _loading = false;
      });
    }
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'BOOKED':
        return Colors.orange;
      case 'CONFIRMED':
        return Colors.blue;
      case 'DISPATCHED':
        return Colors.indigo;
      case 'COLLECTED':
        return Colors.purple;
      case 'PROCESSING':
        return Colors.amber.shade700;
      case 'RESULT_READY':
        return Colors.green;
      default:
        return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
            const SizedBox(height: 16),
            FilledButton(onPressed: _fetchBookings, child: const Text('Retry')),
          ],
        ),
      );
    }

    if (_bookings.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.science_outlined,
                size: 64, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(height: 16),
            Text('No bookings yet',
                style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text('Book an investigation to get started',
                style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant)),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchBookings,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _bookings.length,
        itemBuilder: (context, i) => _buildBookingCard(_bookings[i], theme),
      ),
    );
  }

  Widget _buildBookingCard(Map<String, dynamic> booking, ThemeData theme) {
    final status = booking['status'] ?? 'BOOKED';
    final statusIdx = _statusOrder.indexOf(status);
    final testDetails = booking['test_details'] as List<dynamic>?;
    final customTests = booking['custom_test_names'] as String?;
    final collectionType = booking['collection_type'] ?? 'home';
    final createdAt = booking['created_at'] != null
        ? DateFormat('d MMM yyyy, h:mm a')
            .format(DateTime.parse(booking['created_at']).toLocal())
        : '';

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header row
            Row(
              children: [
                Expanded(
                  child: Text(
                    booking['booking_number'] ?? 'Pending',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: _statusColor(status).withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    _statusLabels[status] ?? status,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: _statusColor(status),
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(createdAt, style: theme.textTheme.bodySmall),

            const SizedBox(height: 12),

            // Tests
            if (testDetails != null && testDetails.isNotEmpty)
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: testDetails.map<Widget>((t) {
                  return Chip(
                    label: Text(t['name'] ?? '', style: const TextStyle(fontSize: 11)),
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                  );
                }).toList(),
              ),
            if (customTests != null && customTests.isNotEmpty)
              Text('Tests: $customTests', style: theme.textTheme.bodySmall),
            if (booking['slip_photo_key'] != null)
              Row(
                children: [
                  const Icon(Icons.photo, size: 14),
                  const SizedBox(width: 4),
                  Text('Prescription slip attached',
                      style: theme.textTheme.bodySmall),
                ],
              ),

            const SizedBox(height: 12),

            // Collection type + cost
            Row(
              children: [
                Icon(
                  collectionType == 'home'
                      ? Icons.home
                      : Icons.local_hospital,
                  size: 16,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 4),
                Text(
                  collectionType == 'home' ? 'Home Collection' : 'Walk-in',
                  style: theme.textTheme.bodySmall,
                ),
                const Spacer(),
                if (booking['final_cost'] != null ||
                    booking['estimated_cost'] != null)
                  Text(
                    '₹${booking['final_cost'] ?? booking['estimated_cost']}',
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                      color: theme.colorScheme.primary,
                    ),
                  ),
              ],
            ),

            const SizedBox(height: 12),

            // Status tracker
            _buildStatusTracker(statusIdx, theme),

            // Download result button
            if (status == 'RESULT_READY' && booking['result_file_url'] != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: FilledButton.icon(
                  onPressed: () async {
                    final url = Uri.parse(booking['result_file_url']);
                    if (await canLaunchUrl(url)) {
                      await launchUrl(url,
                          mode: LaunchMode.externalApplication);
                    }
                  },
                  icon: const Icon(Icons.download),
                  label: const Text('Download Result'),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildStatusTracker(int currentIdx, ThemeData theme) {
    return SizedBox(
      height: 40,
      child: Row(
        children: List.generate(_statusOrder.length, (i) {
          final done = i <= currentIdx;
          final isLast = i == _statusOrder.length - 1;
          return Expanded(
            child: Row(
              children: [
                Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      done
                          ? Icons.check_circle
                          : Icons.radio_button_unchecked,
                      size: 18,
                      color: done
                          ? theme.colorScheme.primary
                          : theme.colorScheme.outline,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      _statusOrder[i].substring(0, 3),
                      style: TextStyle(
                        fontSize: 8,
                        color: done
                            ? theme.colorScheme.primary
                            : theme.colorScheme.outline,
                        fontWeight: done ? FontWeight.bold : FontWeight.normal,
                      ),
                    ),
                  ],
                ),
                if (!isLast)
                  Expanded(
                    child: Container(
                      height: 2,
                      color: i < currentIdx
                          ? theme.colorScheme.primary
                          : theme.colorScheme.outline.withValues(alpha: 0.3),
                    ),
                  ),
              ],
            ),
          );
        }),
      ),
    );
  }
}
