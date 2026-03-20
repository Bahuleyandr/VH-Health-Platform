import 'package:flutter/material.dart';
import '../../../core/services/staff_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

class PharmacyScreen extends StatefulWidget {
  const PharmacyScreen({super.key});

  @override
  State<PharmacyScreen> createState() => _PharmacyScreenState();
}

class _PharmacyScreenState extends State<PharmacyScreen> {
  // In a real implementation, a GET endpoint would list pharmacy orders.
  // Currently the backend only exposes PUT /staff/pharmacy/orders.
  // We show an update UI where staff enter order details manually.

  final _formKey = GlobalKey<FormState>();
  final _phoneCtrl = TextEditingController();
  final _orderIdCtrl = TextEditingController();
  final _notesCtrl = TextEditingController();
  String? _status;
  bool _submitting = false;

  static const _statuses = [
    'PROCESSING',
    'READY_FOR_PICKUP',
    'DISPENSED',
    'CANCELLED',
  ];

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _orderIdCtrl.dispose();
    _notesCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _submitting = true);
    try {
      await StaffApiService.updatePharmacyOrder(
        phone: _phoneCtrl.text.trim(),
        orderId: _orderIdCtrl.text.trim(),
        status: _status!,
        notes: _notesCtrl.text.trim().isEmpty ? null : _notesCtrl.text.trim(),
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('✅ Pharmacy order updated successfully'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _formKey.currentState!.reset();
        setState(() => _status = null);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Pharmacy Orders',
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header info
            Container(
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
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Pharmacy Order Update',
                          style: TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.bold,
                              fontSize: 16),
                        ),
                        SizedBox(height: 2),
                        Text(
                          'Update the status of pending pharmacy orders',
                          style: TextStyle(color: Colors.white70, fontSize: 12),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            const Text(
              'Update Order Status',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.bold,
                color: AppTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 12),

            Form(
              key: _formKey,
              child: Column(
                children: [
                  TextFormField(
                    controller: _phoneCtrl,
                    keyboardType: TextInputType.phone,
                    decoration: const InputDecoration(
                      labelText: 'Patient Phone Number',
                      hintText: '+91 XXXXX XXXXX',
                      prefixIcon: Icon(Icons.phone_outlined),
                    ),
                    validator: (v) {
                      if (v == null || v.trim().isEmpty)
                        return 'Phone is required';
                      if (v.trim().length < 10)
                        return 'Enter valid phone number';
                      return null;
                    },
                  ),
                  const SizedBox(height: 14),

                  TextFormField(
                    controller: _orderIdCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Order ID',
                      hintText: 'e.g. ORD-2024-001',
                      prefixIcon: Icon(Icons.receipt_long_outlined),
                    ),
                    validator: (v) =>
                        (v == null || v.trim().isEmpty)
                            ? 'Order ID is required'
                            : null,
                  ),
                  const SizedBox(height: 14),

                  DropdownButtonFormField<String>(
                    value: _status,
                    decoration: const InputDecoration(
                      labelText: 'New Status',
                      prefixIcon: Icon(Icons.update),
                    ),
                    items: _statuses
                        .map((s) => DropdownMenuItem(
                              value: s,
                              child: _StatusOption(status: s),
                            ))
                        .toList(),
                    onChanged: (v) => setState(() => _status = v),
                    validator: (v) =>
                        v == null ? 'Select a status' : null,
                  ),
                  const SizedBox(height: 14),

                  TextFormField(
                    controller: _notesCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Notes (optional)',
                      hintText: 'e.g. Items partially dispensed...',
                      prefixIcon: Icon(Icons.notes_outlined),
                      alignLabelWithHint: true,
                    ),
                    maxLines: 2,
                  ),
                  const SizedBox(height: 24),

                  ElevatedButton.icon(
                    onPressed: _submitting ? null : _submit,
                    icon: _submitting
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                                color: Colors.white, strokeWidth: 2))
                        : const Icon(Icons.update, color: Colors.white),
                    label: Text(_submitting
                        ? 'Updating...'
                        : 'Update Pharmacy Order'),
                    style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFFE65100)),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 32),

            // Status legend
            const Text(
              'Status Guide',
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.bold,
                color: AppTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 8),
            ..._statuses.map((s) => _StatusLegendItem(status: s)),
          ],
        ),
      ),
    );
  }
}

class _StatusOption extends StatelessWidget {
  final String status;
  const _StatusOption({required this.status});

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(status);
    return Row(
      children: [
        Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(shape: BoxShape.circle, color: color),
        ),
        const SizedBox(width: 8),
        Text(status.replaceAll('_', ' ')),
      ],
    );
  }
}

class _StatusLegendItem extends StatelessWidget {
  final String status;
  const _StatusLegendItem({required this.status});

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(status);
    final desc = switch (status) {
      'PROCESSING' => 'Order is being prepared',
      'READY_FOR_PICKUP' => 'Patient can collect their order',
      'DISPENSED' => 'Medications have been given to the patient',
      'CANCELLED' => 'Order has been cancelled',
      _ => '',
    };

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            margin: const EdgeInsets.only(top: 5),
            width: 10,
            height: 10,
            decoration:
                BoxDecoration(shape: BoxShape.circle, color: color),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  status.replaceAll('_', ' '),
                  style: TextStyle(
                      fontWeight: FontWeight.w600,
                      color: color,
                      fontSize: 13),
                ),
                Text(desc,
                    style: const TextStyle(
                        color: AppTheme.textSecondary, fontSize: 12)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

Color _statusColor(String status) => switch (status) {
      'PROCESSING' => AppTheme.warningAmber,
      'READY_FOR_PICKUP' => AppTheme.primaryBlue,
      'DISPENSED' => AppTheme.successGreen,
      'CANCELLED' => AppTheme.errorRed,
      _ => AppTheme.textSecondary,
    };
