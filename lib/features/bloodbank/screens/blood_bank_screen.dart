import 'package:flutter/material.dart';
import '../../../core/services/api_client.dart';
import '../../../core/theme/app_theme.dart';

class BloodBankScreen extends StatefulWidget {
  const BloodBankScreen({super.key});

  @override
  State<BloodBankScreen> createState() => _BloodBankScreenState();
}

class _BloodBankScreenState extends State<BloodBankScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  // Inventory
  List<Map<String, dynamic>> _inventory = [];
  bool _loadingInventory = true;
  String? _inventoryError;

  // Request form
  final _requestFormKey = GlobalKey<FormState>();
  String? _requestBloodType;
  final _unitsController = TextEditingController();
  final _reasonController = TextEditingController();
  final _patientNameController = TextEditingController();
  bool _submittingRequest = false;

  static const List<String> _bloodTypes = [
    'A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-',
  ];

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _fetchInventory();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _unitsController.dispose();
    _reasonController.dispose();
    _patientNameController.dispose();
    super.dispose();
  }

  Future<void> _fetchInventory() async {
    setState(() {
      _loadingInventory = true;
      _inventoryError = null;
    });
    try {
      final response = await ApiClient.get('/blood-bank/inventory');
      if (response.success) {
        final data = response.data;
        final list = data is List
            ? data
            : (data is Map ? data['inventory'] ?? data['items'] ?? [] : []);
        _inventory = List<Map<String, dynamic>>.from(
          (list as List).map((i) => i is Map<String, dynamic> ? i : <String, dynamic>{}),
        );
      } else {
        _inventoryError = response.message ?? 'Failed to load inventory';
      }
    } catch (e) {
      _inventoryError = 'Could not connect to server';
    } finally {
      if (mounted) setState(() => _loadingInventory = false);
    }
  }

  Future<void> _submitRequest() async {
    if (!_requestFormKey.currentState!.validate()) return;
    setState(() => _submittingRequest = true);
    try {
      final response = await ApiClient.post('/blood-bank/request', body: {
        'bloodType': _requestBloodType,
        'units': int.tryParse(_unitsController.text) ?? 1,
        'reason': _reasonController.text.trim(),
        'patientName': _patientNameController.text.trim(),
      });
      if (mounted) {
        if (response.success) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Blood request submitted successfully'),
              backgroundColor: AppTheme.successGreen,
            ),
          );
          _requestFormKey.currentState!.reset();
          _unitsController.clear();
          _reasonController.clear();
          _patientNameController.clear();
          setState(() => _requestBloodType = null);
          _fetchInventory();
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(response.message ?? 'Request failed'),
              backgroundColor: AppTheme.errorRed,
            ),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Could not submit request'),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submittingRequest = false);
    }
  }

  Color _stockColor(int units) {
    if (units < 5) return AppTheme.errorRed;
    if (units < 10) return const Color(0xFFF9A825);
    return AppTheme.successGreen;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        title: const Text('Blood Bank'),
        backgroundColor: AppTheme.errorRed,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _fetchInventory,
          ),
        ],
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: Colors.white,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white60,
          tabs: const [
            Tab(text: 'Inventory'),
            Tab(text: 'Requests'),
            Tab(text: 'Donations'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _buildInventoryTab(),
          _buildRequestsTab(),
          _buildDonationsTab(),
        ],
      ),
    );
  }

  Widget _buildInventoryTab() {
    if (_loadingInventory) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_inventoryError != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 48, color: AppTheme.errorRed),
            const SizedBox(height: 16),
            Text(_inventoryError!, style: const TextStyle(color: AppTheme.textSecondary)),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _fetchInventory,
              icon: const Icon(Icons.refresh),
              label: const Text('Retry'),
            ),
          ],
        ),
      );
    }

    // If API returned data, use it; otherwise show placeholder cards for all types
    final displayItems = _inventory.isNotEmpty
        ? _inventory
        : _bloodTypes
            .map((t) => <String, dynamic>{'bloodType': t, 'units': 0})
            .toList();

    return RefreshIndicator(
      onRefresh: _fetchInventory,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Stock level legend
          Row(
            children: [
              _legendDot(AppTheme.successGreen, '>= 10 units'),
              const SizedBox(width: 12),
              _legendDot(const Color(0xFFF9A825), '5-9 units'),
              const SizedBox(width: 12),
              _legendDot(AppTheme.errorRed, '< 5 units'),
            ],
          ),
          const SizedBox(height: 16),

          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2,
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              childAspectRatio: 1.4,
            ),
            itemCount: displayItems.length,
            itemBuilder: (context, index) {
              final item = displayItems[index];
              final type = (item['bloodType'] ?? item['type'] ?? '?').toString();
              final units = item['units'] ?? item['quantity'] ?? 0;
              final intUnits = units is int ? units : int.tryParse(units.toString()) ?? 0;
              final color = _stockColor(intUnits);

              return Container(
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: color.withValues(alpha: 0.4)),
                  boxShadow: [
                    BoxShadow(
                      color: color.withValues(alpha: 0.1),
                      blurRadius: 8,
                      offset: const Offset(0, 2),
                    ),
                  ],
                ),
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Row(
                      children: [
                        Icon(Icons.bloodtype, color: color, size: 22),
                        const SizedBox(width: 8),
                        Text(
                          type,
                          style: TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.bold,
                            color: color,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      '$intUnits units',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                        color: color,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      intUnits < 5
                          ? 'Critical low'
                          : intUnits < 10
                              ? 'Low stock'
                              : 'Adequate',
                      style: TextStyle(fontSize: 11, color: color),
                    ),
                  ],
                ),
              );
            },
          ),
        ],
      ),
    );
  }

  Widget _buildRequestsTab() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Form(
        key: _requestFormKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Request Blood',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.bold,
                color: AppTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 16),

            // Patient name
            TextFormField(
              controller: _patientNameController,
              decoration: InputDecoration(
                labelText: 'Patient Name',
                prefixIcon: const Icon(Icons.person_outline),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                filled: true,
                fillColor: Colors.white,
              ),
              validator: (v) =>
                  (v == null || v.trim().isEmpty) ? 'Patient name is required' : null,
            ),
            const SizedBox(height: 14),

            // Blood type dropdown
            DropdownButtonFormField<String>(
              value: _requestBloodType,
              decoration: InputDecoration(
                labelText: 'Blood Type',
                prefixIcon: const Icon(Icons.bloodtype_outlined),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                filled: true,
                fillColor: Colors.white,
              ),
              items: _bloodTypes
                  .map((t) => DropdownMenuItem(value: t, child: Text(t)))
                  .toList(),
              onChanged: (v) => setState(() => _requestBloodType = v),
              validator: (v) => v == null ? 'Select blood type' : null,
            ),
            const SizedBox(height: 14),

            // Units
            TextFormField(
              controller: _unitsController,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                labelText: 'Units Required',
                prefixIcon: const Icon(Icons.numbers),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                filled: true,
                fillColor: Colors.white,
              ),
              validator: (v) {
                if (v == null || v.trim().isEmpty) return 'Units required';
                final n = int.tryParse(v.trim());
                if (n == null || n < 1) return 'Enter a valid number';
                return null;
              },
            ),
            const SizedBox(height: 14),

            // Reason
            TextFormField(
              controller: _reasonController,
              maxLines: 3,
              decoration: InputDecoration(
                labelText: 'Reason / Notes',
                prefixIcon: const Padding(
                  padding: EdgeInsets.only(bottom: 40),
                  child: Icon(Icons.notes),
                ),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                filled: true,
                fillColor: Colors.white,
              ),
            ),
            const SizedBox(height: 20),

            SizedBox(
              width: double.infinity,
              height: 48,
              child: ElevatedButton.icon(
                onPressed: _submittingRequest ? null : _submitRequest,
                icon: _submittingRequest
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : const Icon(Icons.send),
                label: Text(_submittingRequest ? 'Submitting...' : 'Submit Request'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.errorRed,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDonationsTab() {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.volunteer_activism, size: 64, color: AppTheme.errorRed),
            SizedBox(height: 16),
            Text(
              'Donation Records',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.bold,
                color: AppTheme.textPrimary,
              ),
            ),
            SizedBox(height: 8),
            Text(
              'View and manage blood donation records.\nThis section will display donation history and upcoming donation drives.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      ),
    );
  }

  Widget _legendDot(Color color, String label) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Text(label, style: const TextStyle(fontSize: 11, color: AppTheme.textSecondary)),
      ],
    );
  }
}
