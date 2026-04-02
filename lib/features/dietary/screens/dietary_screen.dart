import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/services/api_client.dart';
import '../../../core/theme/app_theme.dart';

class DietaryScreen extends StatefulWidget {
  const DietaryScreen({super.key});

  @override
  State<DietaryScreen> createState() => _DietaryScreenState();
}

class _DietaryScreenState extends State<DietaryScreen> {
  List<Map<String, dynamic>> _orders = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _fetchOrders();
  }

  Future<void> _fetchOrders() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get('/dietary/orders');
      if (response.success) {
        final data = response.data;
        final list = data is List
            ? data
            : (data is Map ? data['orders'] ?? [] : []);
        _orders = List<Map<String, dynamic>>.from(
          (list as List).map((o) => o is Map<String, dynamic> ? o : <String, dynamic>{}),
        );
      } else {
        _error = response.message ?? 'Failed to load dietary orders';
      }
    } catch (e) {
      _error = 'Could not connect to server';
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _markAsServed(String orderId) async {
    try {
      final response = await ApiClient.patch(
        '/dietary/orders/$orderId',
        body: {'status': 'served'},
      );
      if (mounted) {
        if (response.success) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Order marked as served'),
              backgroundColor: AppTheme.successGreen,
            ),
          );
          _fetchOrders();
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(response.message ?? 'Failed to update order'),
              backgroundColor: AppTheme.errorRed,
            ),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Could not update order'),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  Future<void> _showCreateOrderDialog() async {
    final formKey = GlobalKey<FormState>();
    final patientNameCtrl = TextEditingController();
    final patientIdCtrl = TextEditingController();
    final restrictionsCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    String? dietType;
    String? mealTime;

    const dietTypes = [
      'Regular',
      'Diabetic',
      'Low Sodium',
      'Liquid',
      'Soft',
      'Pureed',
      'NPO',
      'Renal',
      'Cardiac',
      'Gluten Free',
    ];

    const mealTimes = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];

    final result = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New Dietary Order'),
        content: SingleChildScrollView(
          child: Form(
            key: formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextFormField(
                  controller: patientNameCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Patient Name',
                    prefixIcon: Icon(Icons.person_outline),
                  ),
                  validator: (v) =>
                      (v == null || v.trim().isEmpty) ? 'Required' : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: patientIdCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Patient ID / Bed Number',
                    prefixIcon: Icon(Icons.badge_outlined),
                  ),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  value: dietType,
                  decoration: const InputDecoration(
                    labelText: 'Diet Type',
                    prefixIcon: Icon(Icons.restaurant_menu),
                  ),
                  items: dietTypes
                      .map((t) => DropdownMenuItem(value: t, child: Text(t)))
                      .toList(),
                  onChanged: (v) => dietType = v,
                  validator: (v) => v == null ? 'Select diet type' : null,
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  value: mealTime,
                  decoration: const InputDecoration(
                    labelText: 'Meal Time',
                    prefixIcon: Icon(Icons.access_time),
                  ),
                  items: mealTimes
                      .map((t) => DropdownMenuItem(value: t, child: Text(t)))
                      .toList(),
                  onChanged: (v) => mealTime = v,
                  validator: (v) => v == null ? 'Select meal time' : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: restrictionsCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Restrictions / Allergies',
                    prefixIcon: Icon(Icons.warning_amber_outlined),
                  ),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: notesCtrl,
                  maxLines: 2,
                  decoration: const InputDecoration(
                    labelText: 'Notes',
                    prefixIcon: Icon(Icons.notes),
                  ),
                ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () {
              if (formKey.currentState!.validate()) {
                Navigator.pop(ctx, true);
              }
            },
            style: ElevatedButton.styleFrom(
              backgroundColor: AppTheme.primaryTeal,
              foregroundColor: Colors.white,
            ),
            child: const Text('Create'),
          ),
        ],
      ),
    );

    if (result == true && mounted) {
      try {
        final response = await ApiClient.post('/dietary/orders', body: {
          'patientName': patientNameCtrl.text.trim(),
          'patientId': patientIdCtrl.text.trim(),
          'dietType': dietType,
          'mealTime': mealTime,
          'restrictions': restrictionsCtrl.text.trim(),
          'notes': notesCtrl.text.trim(),
        });
        if (mounted) {
          if (response.success) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text('Dietary order created'),
                backgroundColor: AppTheme.successGreen,
              ),
            );
            _fetchOrders();
          } else {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(response.message ?? 'Failed to create order'),
                backgroundColor: AppTheme.errorRed,
              ),
            );
          }
        }
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Could not create order'),
              backgroundColor: AppTheme.errorRed,
            ),
          );
        }
      }
    }

    patientNameCtrl.dispose();
    patientIdCtrl.dispose();
    restrictionsCtrl.dispose();
    notesCtrl.dispose();
  }

  IconData _mealIcon(String? mealTime) {
    switch (mealTime?.toLowerCase()) {
      case 'breakfast':
        return Icons.free_breakfast;
      case 'lunch':
        return Icons.lunch_dining;
      case 'dinner':
        return Icons.dinner_dining;
      case 'snack':
        return Icons.cookie;
      default:
        return Icons.restaurant;
    }
  }

  Color _statusColor(String? status) {
    switch (status?.toLowerCase()) {
      case 'served':
        return AppTheme.successGreen;
      case 'preparing':
        return const Color(0xFFF9A825);
      case 'cancelled':
        return AppTheme.errorRed;
      default:
        return AppTheme.primaryBlue;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        title: const Text('Dietary Management'),
        backgroundColor: AppTheme.primaryTeal,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _fetchOrders,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _showCreateOrderDialog,
        backgroundColor: AppTheme.primaryTeal,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add),
        label: const Text('New Order'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? _buildError()
              : _orders.isEmpty
                  ? _buildEmpty()
                  : RefreshIndicator(
                      onRefresh: _fetchOrders,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _orders.length,
                        itemBuilder: (context, index) =>
                            _buildOrderCard(_orders[index]),
                      ),
                    ),
    );
  }

  Widget _buildError() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.error_outline, size: 48, color: AppTheme.errorRed),
          const SizedBox(height: 16),
          Text(_error!, style: const TextStyle(color: AppTheme.textSecondary)),
          const SizedBox(height: 16),
          ElevatedButton.icon(
            onPressed: _fetchOrders,
            icon: const Icon(Icons.refresh),
            label: const Text('Retry'),
          ),
        ],
      ),
    );
  }

  Widget _buildEmpty() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.restaurant_menu, size: 64, color: Colors.grey.shade400),
          const SizedBox(height: 16),
          const Text(
            'No dietary orders',
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.bold,
              color: AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            'Tap the button below to create a new order',
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ],
      ),
    );
  }

  Widget _buildOrderCard(Map<String, dynamic> order) {
    final patientName = (order['patientName'] ?? order['patient']?['name'] ?? 'Patient').toString();
    final dietType = (order['dietType'] ?? order['diet'] ?? '').toString();
    final mealTime = (order['mealTime'] ?? order['meal'] ?? '').toString();
    final restrictions = (order['restrictions'] ?? order['allergies'] ?? '').toString();
    final status = (order['status'] ?? 'pending').toString();
    final orderId = (order['id'] ?? order['_id'] ?? '').toString();
    final notes = (order['notes'] ?? '').toString();
    final createdAt = order['createdAt'] ?? order['created_at'] ?? '';
    final isServed = status.toLowerCase() == 'served';
    final color = _statusColor(status);

    String timeStr = '';
    if (createdAt.toString().isNotEmpty) {
      try {
        final dt = DateTime.parse(createdAt.toString());
        timeStr = DateFormat('d MMM, HH:mm').format(dt);
      } catch (_) {}
    }

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: color.withValues(alpha: 0.3)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header row
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(_mealIcon(mealTime), color: color, size: 22),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        patientName,
                        style: const TextStyle(
                          fontWeight: FontWeight.w600,
                          fontSize: 15,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        [if (dietType.isNotEmpty) dietType, if (mealTime.isNotEmpty) mealTime]
                            .join(' - '),
                        style: const TextStyle(
                          fontSize: 13,
                          color: AppTheme.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(
                    status[0].toUpperCase() + status.substring(1),
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: color,
                    ),
                  ),
                ),
              ],
            ),

            // Restrictions
            if (restrictions.isNotEmpty) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  const Icon(Icons.warning_amber, size: 14, color: Color(0xFFF9A825)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      restrictions,
                      style: const TextStyle(
                        fontSize: 12,
                        color: Color(0xFFF9A825),
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ],
              ),
            ],

            // Notes
            if (notes.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                notes,
                style: const TextStyle(fontSize: 12, color: AppTheme.textSecondary),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ],

            // Footer
            const SizedBox(height: 10),
            Row(
              children: [
                if (timeStr.isNotEmpty)
                  Text(
                    timeStr,
                    style: const TextStyle(fontSize: 11, color: AppTheme.textSecondary),
                  ),
                const Spacer(),
                if (!isServed && orderId.isNotEmpty)
                  TextButton.icon(
                    onPressed: () => _markAsServed(orderId),
                    icon: const Icon(Icons.check_circle_outline, size: 16),
                    label: const Text('Mark Served'),
                    style: TextButton.styleFrom(
                      foregroundColor: AppTheme.successGreen,
                      textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
