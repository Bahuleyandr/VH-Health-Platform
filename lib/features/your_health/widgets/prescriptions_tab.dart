// Prescriptions tab — self-contained widget with its own state and data fetching
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:vhhealth/core/services/api_client.dart';

class PrescriptionsTab extends StatefulWidget {
  final String phone;

  const PrescriptionsTab({super.key, required this.phone});

  @override
  State<PrescriptionsTab> createState() => _PrescriptionsTabState();
}

class _PrescriptionsTabState extends State<PrescriptionsTab> {
  List<dynamic> _prescriptions = [];
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _fetchPrescriptions();
  }

  Future<void> _fetchPrescriptions() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get('/prescriptions/patient/my');
      if (response.isSuccess && mounted) {
        setState(() => _prescriptions = response.dataAsList());
      } else if (mounted) {
        setState(() => _error = response.message ?? 'Failed');
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.error_outline, size: 40, color: cs.error),
            const SizedBox(height: 8),
            Text(_error!, style: TextStyle(color: cs.onSurfaceVariant)),
            TextButton(
                onPressed: _fetchPrescriptions,
                child: const Text('Retry')),
          ],
        ),
      );
    }
    if (_prescriptions.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.medication_outlined,
                size: 56, color: cs.onSurfaceVariant),
            const SizedBox(height: 16),
            Text('No prescriptions yet',
                style: theme.textTheme.titleMedium
                    ?.copyWith(color: cs.onSurface)),
            const SizedBox(height: 8),
            Text('Your doctor prescriptions will appear here',
                style: TextStyle(color: cs.onSurfaceVariant)),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _fetchPrescriptions,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _prescriptions.length,
        itemBuilder: (_, i) {
          final rx = _prescriptions[i];
          final meds = rx['medications'] as List? ?? [];
          final createdAt = rx['created_at'] != null
              ? DateFormat('dd MMM yyyy')
                  .format(DateTime.parse(rx['created_at']).toLocal())
              : '';
          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () => _showPrescriptionDetail(rx),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Row(
                  children: [
                    CircleAvatar(
                      backgroundColor: cs.primary.withOpacity(0.1),
                      child: Icon(Icons.medication,
                          color: cs.primary, size: 22),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(rx['prescription_number'] ?? '',
                              style: theme.textTheme.titleSmall
                                  ?.copyWith(fontWeight: FontWeight.bold)),
                          const SizedBox(height: 2),
                          Text(
                              'Dr. ${rx['doctor_name'] ?? ''} • ${rx['doctor_specialization'] ?? ''}',
                              style: TextStyle(
                                  fontSize: 12,
                                  color: cs.onSurfaceVariant)),
                          const SizedBox(height: 2),
                          Text('${meds.length} medicines • $createdAt',
                              style: TextStyle(
                                  fontSize: 12,
                                  color: cs.onSurfaceVariant)),
                        ],
                      ),
                    ),
                    if (rx['pharmacy_opted'] == true)
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 4),
                        decoration: BoxDecoration(
                          color: Colors.green.shade50,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: const Text('Ordered',
                            style: TextStyle(
                                fontSize: 10, color: Colors.green)),
                      )
                    else
                      Icon(Icons.chevron_right,
                          color: cs.onSurfaceVariant),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  void _showPrescriptionDetail(Map<String, dynamic> rx) {
    final meds = rx['medications'] as List? ?? [];
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.75,
        maxChildSize: 0.95,
        builder: (_, scrollCtrl) => ListView(
          controller: scrollCtrl,
          padding: const EdgeInsets.all(20),
          children: [
            Center(
              child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                      color: Colors.grey[300],
                      borderRadius: BorderRadius.circular(2))),
            ),
            const SizedBox(height: 16),
            Text(rx['prescription_number'] ?? '',
                style: const TextStyle(
                    fontSize: 20, fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            Text(
                'Dr. ${rx['doctor_name'] ?? ''} • ${rx['doctor_specialization'] ?? ''}',
                style: TextStyle(color: Colors.grey[600])),
            if (rx['created_at'] != null)
              Text(
                  DateFormat('dd MMM yyyy, hh:mm a')
                      .format(DateTime.parse(rx['created_at']).toLocal()),
                  style:
                      TextStyle(fontSize: 12, color: Colors.grey[500])),
            const SizedBox(height: 16),
            if (rx['diagnosis'] != null &&
                rx['diagnosis'].toString().isNotEmpty) ...[
              const Text('Diagnosis',
                  style: TextStyle(
                      fontWeight: FontWeight.bold, fontSize: 14)),
              const SizedBox(height: 4),
              Text(rx['diagnosis']),
              const SizedBox(height: 16),
            ],
            const Text('Medications',
                style: TextStyle(
                    fontWeight: FontWeight.bold, fontSize: 14)),
            const SizedBox(height: 8),
            ...meds.asMap().entries.map((e) {
              final m = e.value;
              return Container(
                margin: const EdgeInsets.only(bottom: 8),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.grey[50],
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Colors.grey.shade200),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 22,
                          height: 22,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: const Color(0xFF00838F)
                                .withOpacity(0.1),
                            shape: BoxShape.circle,
                          ),
                          child: Text('${e.key + 1}',
                              style: const TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.bold,
                                  color: Color(0xFF00838F))),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(m['name'] ?? '',
                              style: const TextStyle(
                                  fontWeight: FontWeight.w600)),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                        '${m['dosage'] ?? ''} • ${m['frequency'] ?? ''} • ${m['duration'] ?? ''} • ${m['route'] ?? 'Oral'}',
                        style: TextStyle(
                            fontSize: 12, color: Colors.grey[600])),
                    if (m['instructions'] != null &&
                        m['instructions'].toString().isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text('\u{1F4DD} ${m['instructions']}',
                            style: const TextStyle(
                                fontSize: 12,
                                fontStyle: FontStyle.italic)),
                      ),
                  ],
                ),
              );
            }),
            if (rx['follow_up_date'] != null) ...[
              const SizedBox(height: 16),
              Row(
                children: [
                  const Icon(Icons.calendar_today,
                      size: 16, color: Color(0xFF00838F)),
                  const SizedBox(width: 6),
                  Text(
                      'Follow-up: ${DateFormat('dd MMM yyyy').format(DateTime.parse(rx['follow_up_date']))}',
                      style: const TextStyle(
                          fontWeight: FontWeight.w500)),
                ],
              ),
              if (rx['follow_up_notes'] != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4, left: 22),
                  child: Text(rx['follow_up_notes'],
                      style: TextStyle(
                          fontSize: 12, color: Colors.grey[600])),
                ),
            ],
            if (rx['clinical_notes'] != null &&
                rx['clinical_notes'].toString().isNotEmpty) ...[
              const SizedBox(height: 16),
              const Text('Clinical Notes',
                  style: TextStyle(
                      fontWeight: FontWeight.bold, fontSize: 14)),
              const SizedBox(height: 4),
              Text(rx['clinical_notes']),
            ],
            const SizedBox(height: 20),

            // PDF Download
            if (rx['pdf_url'] != null)
              OutlinedButton.icon(
                onPressed: () => launchUrl(Uri.parse(rx['pdf_url']),
                    mode: LaunchMode.externalApplication),
                icon: const Icon(Icons.picture_as_pdf, size: 18),
                label: const Text('Download PDF'),
              ),

            const SizedBox(height: 10),

            // Order Medicines button
            if (rx['pharmacy_opted'] != true)
              ElevatedButton.icon(
                onPressed: () {
                  Navigator.pop(ctx);
                  _showOrderMedicinesSheet(rx);
                },
                icon: const Icon(Icons.shopping_cart,
                    color: Colors.white, size: 18),
                label: const Text('Order Medicines'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF00838F),
                  padding: const EdgeInsets.symmetric(vertical: 12),
                ),
              )
            else
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.green.shade50,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.check_circle,
                        color: Colors.green, size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                        child: Text(
                            'Medicines ordered via pharmacy (${rx['pharmacy_opt_type'] ?? ''})',
                            style:
                                const TextStyle(color: Colors.green))),
                  ],
                ),
              ),

            const SizedBox(height: 30),
          ],
        ),
      ),
    );
  }

  void _showOrderMedicinesSheet(Map<String, dynamic> rx) {
    final meds = rx['medications'] as List? ?? [];
    String deliveryType = 'delivery';
    final addressCtrl = TextEditingController();
    final phoneCtrl = TextEditingController(text: widget.phone);
    bool ordering = false;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) {
        double totalEstimate = 0;
        for (final m in meds) {
          totalEstimate += (m['quantity'] ?? 1) * 50.0;
        }

        return Padding(
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
                const Text('Order Medicines',
                    style: TextStyle(
                        fontSize: 18, fontWeight: FontWeight.bold)),
                const SizedBox(height: 4),
                Text(
                    'From prescription ${rx['prescription_number']}',
                    style: TextStyle(
                        color: Colors.grey[600], fontSize: 13)),
                const SizedBox(height: 16),

                // Medicine list
                ...meds.map((m) => Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Row(
                        children: [
                          const Icon(Icons.medication,
                              size: 16, color: Color(0xFF00838F)),
                          const SizedBox(width: 8),
                          Expanded(
                              child: Text(m['name'] ?? '',
                                  style:
                                      const TextStyle(fontSize: 13))),
                          Text('x${m['quantity'] ?? 1}',
                              style: TextStyle(
                                  color: Colors.grey[600],
                                  fontSize: 12)),
                        ],
                      ),
                    )),

                const SizedBox(height: 16),

                // Delivery type
                Row(
                  children: [
                    Expanded(
                      child: ChoiceChip(
                        label: const Text('\u{1F3E0} Home Delivery'),
                        selected: deliveryType == 'delivery',
                        onSelected: (_) =>
                            setSheet(() => deliveryType = 'delivery'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: ChoiceChip(
                        label: const Text('\u{1F3E5} Pickup'),
                        selected: deliveryType == 'pickup',
                        onSelected: (_) =>
                            setSheet(() => deliveryType = 'pickup'),
                      ),
                    ),
                  ],
                ),

                if (deliveryType == 'delivery') ...[
                  const SizedBox(height: 12),
                  TextField(
                    controller: addressCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Delivery Address',
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                    maxLines: 2,
                  ),
                ],

                const SizedBox(height: 12),
                TextField(
                  controller: phoneCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Contact Phone',
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                  keyboardType: TextInputType.phone,
                ),

                const SizedBox(height: 20),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: ordering
                        ? null
                        : () async {
                            setSheet(() => ordering = true);
                            try {
                              final response = await ApiClient.post(
                                '/prescriptions/${rx['id']}/order-pharmacy',
                                body: {
                                  'delivery_type': deliveryType,
                                  if (deliveryType == 'delivery')
                                    'delivery_address':
                                        addressCtrl.text.trim(),
                                  'delivery_phone':
                                      phoneCtrl.text.trim(),
                                },
                              );
                              if (ctx.mounted) Navigator.pop(ctx);
                              if (response.isSuccess) {
                                final orderNum =
                                    response.data?['order_number'] ??
                                        '';
                                if (mounted) {
                                  ScaffoldMessenger.of(context)
                                      .showSnackBar(
                                    SnackBar(
                                      content: Text(
                                          '\u2705 Order placed! $orderNum'),
                                      backgroundColor: Colors.green,
                                    ),
                                  );
                                  _fetchPrescriptions(); // refresh
                                }
                              } else {
                                if (mounted) {
                                  ScaffoldMessenger.of(context)
                                      .showSnackBar(
                                    SnackBar(
                                      content: Text(response.message ??
                                          'Failed to place order'),
                                      backgroundColor: Colors.red,
                                    ),
                                  );
                                }
                              }
                            } catch (e) {
                              if (ctx.mounted) Navigator.pop(ctx);
                              if (mounted) {
                                ScaffoldMessenger.of(context)
                                    .showSnackBar(
                                  SnackBar(
                                      content: Text('Error: $e'),
                                      backgroundColor: Colors.red),
                                );
                              }
                            }
                          },
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF00838F),
                      padding:
                          const EdgeInsets.symmetric(vertical: 14),
                    ),
                    child: ordering
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                                color: Colors.white,
                                strokeWidth: 2))
                        : const Text('Place Order',
                            style: TextStyle(color: Colors.white)),
                  ),
                ),
              ],
            ),
          ),
        );
      }),
    );
  }
}
