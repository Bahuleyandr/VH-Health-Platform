// Prescriptions tab — self-contained widget with its own state and data fetching
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/core/utils/document_opener.dart';
import 'package:vhhealth/generated/app_localizations.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/your_health/widgets/prescription_countdown_widget.dart';

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
    // Direct ApiClient.get bypasses the ApiClient.cachedGet wrapper
    // whose ConnectivityService.isOnline gate was falsely tripping on
    // an otherwise-online device — the same session calls /prescriptions
    // /patient/my from dashboard polling without issue. cachedGet's
    // offline-first behaviour wasn't earning its keep here (no useful
    // cache available, and the false-offline error masked a working
    // prescription). Finding
    // 2026-05-10-walk-in-opd-patient-prescriptions-false-offline.
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get('/prescriptions/patient/my');
      if (!mounted) return;
      if (response.isSuccess) {
        setState(() => _prescriptions = response.dataAsList());
      } else {
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
              child: const Text('Retry'),
            ),
          ],
        ),
      );
    }
    if (_prescriptions.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.medication_outlined,
              size: 56,
              color: cs.onSurfaceVariant,
            ),
            const SizedBox(height: 16),
            Text(
              AppLocalizations.of(context)!.yourHealthPrescriptionsEmpty,
              style: theme.textTheme.titleMedium?.copyWith(color: cs.onSurface),
            ),
            const SizedBox(height: 8),
            Text(
              AppLocalizations.of(context)!.yourHealthPrescriptionsEmptyHint,
              style: TextStyle(color: cs.onSurfaceVariant),
            ),
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
          final rx = Map<String, dynamic>.from(_prescriptions[i] as Map);
          final pharmacyState = _pharmacyState(rx);
          final meds = rx['medications'] as List? ?? [];
          final createdAt = rx['created_at'] != null
              ? DateFormat(
                  'dd MMM yyyy',
                ).format(DateTime.parse(rx['created_at']).toLocal())
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
                    // Countdown ring replaces the default avatar when we can
                    // derive a duration from the prescription data; otherwise
                    // we fall back to the standard medication icon.
                    Builder(
                      builder: (_) {
                        final rxMap = Map<String, dynamic>.from(rx as Map);
                        final days = PrescriptionCountdown.parseDurationDays(
                          rxMap,
                        );
                        final startStr =
                            rxMap['created_at'] ?? rxMap['issued_at'];
                        DateTime? start;
                        if (startStr != null) {
                          try {
                            start = DateTime.parse(
                              startStr.toString(),
                            ).toLocal();
                          } catch (_) {}
                        }
                        if (days != null && start != null) {
                          return PrescriptionCountdown(
                            startDate: start,
                            durationDays: days,
                          );
                        }
                        return CircleAvatar(
                          backgroundColor: cs.primary.withValues(alpha: 0.1),
                          child: Icon(
                            Icons.medication,
                            color: cs.primary,
                            size: 22,
                          ),
                        );
                      },
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            rx['prescription_number'] ?? '',
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'Dr. ${rx['doctor_name'] ?? ''} • ${rx['doctor_specialization'] ?? ''}',
                            style: TextStyle(
                              fontSize: 12,
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            '${meds.length} medicines • $createdAt',
                            style: TextStyle(
                              fontSize: 12,
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (rx['pharmacy_opted'] == true)
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: pharmacyState.color.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Text(
                          pharmacyState.label,
                          style: TextStyle(
                            fontSize: 10,
                            color: pharmacyState.color,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      )
                    else
                      Icon(Icons.chevron_right, color: cs.onSurfaceVariant),
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
    final theme = Theme.of(context);
    final pharmacyState = _pharmacyState(rx);
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
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
                  color: theme.colorScheme.outlineVariant,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(
              rx['prescription_number'] ?? '',
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 4),
            Text(
              'Dr. ${rx['doctor_name'] ?? ''} • ${rx['doctor_specialization'] ?? ''}',
              style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
            ),
            if (rx['created_at'] != null)
              Text(
                DateFormat(
                  'dd MMM yyyy, hh:mm a',
                ).format(DateTime.parse(rx['created_at']).toLocal()),
                style: TextStyle(
                  fontSize: 12,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            const SizedBox(height: 16),
            if (rx['diagnosis'] != null &&
                rx['diagnosis'].toString().isNotEmpty) ...[
              const Text(
                'Diagnosis',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
              ),
              const SizedBox(height: 4),
              Text(rx['diagnosis']),
              const SizedBox(height: 16),
            ],
            if (rx['id'] != null)
              _SafetyContextBanner(prescriptionId: rx['id'] as int),
            const Text(
              'Medications',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
            ),
            const SizedBox(height: 8),
            ...meds.asMap().entries.map((e) {
              final m = e.value;
              return Container(
                margin: const EdgeInsets.only(bottom: 8),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerLow,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: theme.colorScheme.outlineVariant),
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
                            color: const Color(
                              0xFF00838F,
                            ).withValues(alpha: 0.1),
                            shape: BoxShape.circle,
                          ),
                          child: Text(
                            '${e.key + 1}',
                            style: const TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.bold,
                              color: Color(0xFF00838F),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            m['name'] ?? '',
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${m['dosage'] ?? ''} • ${m['frequency'] ?? ''} • ${m['duration'] ?? ''} • ${m['route'] ?? 'Oral'}',
                      style: TextStyle(
                        fontSize: 12,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    if (m['instructions'] != null &&
                        m['instructions'].toString().isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          '\u{1F4DD} ${m['instructions']}',
                          style: const TextStyle(
                            fontSize: 12,
                            fontStyle: FontStyle.italic,
                          ),
                        ),
                      ),
                  ],
                ),
              );
            }),
            if (rx['follow_up_date'] != null) ...[
              const SizedBox(height: 16),
              Row(
                children: [
                  const Icon(
                    Icons.calendar_today,
                    size: 16,
                    color: Color(0xFF00838F),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    'Follow-up: ${DateFormat('dd MMM yyyy').format(DateTime.parse(rx['follow_up_date']))}',
                    style: const TextStyle(fontWeight: FontWeight.w500),
                  ),
                ],
              ),
              if (rx['follow_up_notes'] != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4, left: 22),
                  child: Text(
                    rx['follow_up_notes'],
                    style: TextStyle(
                      fontSize: 12,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
            ],
            if (rx['clinical_notes'] != null &&
                rx['clinical_notes'].toString().isNotEmpty) ...[
              const SizedBox(height: 16),
              Text(
                AppLocalizations.of(ctx)!.yourHealthClinicalNotes,
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 14,
                ),
              ),
              const SizedBox(height: 4),
              Text(rx['clinical_notes']),
            ],
            const SizedBox(height: 20),

            // PDF Download
            if (rx['pdf_url'] != null)
              OutlinedButton.icon(
                onPressed: () => DocumentOpener.openFromUrl(
                  context,
                  rx['pdf_url'],
                  filename: 'prescription.pdf',
                ),
                icon: const Icon(Icons.picture_as_pdf, size: 18),
                label: Text(AppLocalizations.of(ctx)!.yourHealthDownloadPdf),
              ),

            const SizedBox(height: 10),

            // Order Medicines button
            if (rx['pharmacy_opted'] != true)
              ElevatedButton.icon(
                onPressed: () {
                  Navigator.pop(ctx);
                  _showOrderMedicinesSheet(rx);
                },
                icon: const Icon(
                  Icons.shopping_cart,
                  color: Colors.white,
                  size: 18,
                ),
                label: Text(AppLocalizations.of(ctx)!.yourHealthOrderMedicines),
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF00838F),
                  padding: const EdgeInsets.symmetric(vertical: 12),
                ),
              )
            else
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: pharmacyState.color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  children: [
                    Icon(
                      pharmacyState.icon,
                      color: pharmacyState.color,
                      size: 20,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            pharmacyState.label,
                            style: TextStyle(
                              color: pharmacyState.color,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            pharmacyState.detail,
                            style: TextStyle(
                              color: theme.colorScheme.onSurfaceVariant,
                              fontSize: 12,
                            ),
                          ),
                        ],
                      ),
                    ),
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
    final theme = Theme.of(context);
    String deliveryType = 'delivery';
    final addressCtrl = TextEditingController();
    final phoneCtrl = TextEditingController(text: widget.phone);
    bool ordering = false;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) {
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
                  Text(
                    AppLocalizations.of(ctx)!.yourHealthOrderMedicines,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'From prescription ${rx['prescription_number']}',
                    style: TextStyle(
                      color: theme.colorScheme.onSurfaceVariant,
                      fontSize: 13,
                    ),
                  ),
                  const SizedBox(height: 16),

                  // Medicine list
                  ...meds.map(
                    (m) => Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.medication,
                            size: 16,
                            color: Color(0xFF00838F),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              m['name'] ?? '',
                              style: const TextStyle(fontSize: 13),
                            ),
                          ),
                          Text(
                            'x${m['quantity'] ?? 1}',
                            style: TextStyle(
                              color: theme.colorScheme.onSurfaceVariant,
                              fontSize: 12,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),

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
                                      'delivery_address': addressCtrl.text
                                          .trim(),
                                    'delivery_phone': phoneCtrl.text.trim(),
                                  },
                                );
                                if (ctx.mounted) Navigator.pop(ctx);
                                if (response.isSuccess) {
                                  final orderNum =
                                      response.data?['order_number'] ?? '';
                                  if (mounted) {
                                    ScaffoldMessenger.of(context).showSnackBar(
                                      SnackBar(
                                        content: Text(
                                          '\u2705 Order placed! $orderNum',
                                        ),
                                        backgroundColor: Colors.green,
                                      ),
                                    );
                                    _fetchPrescriptions(); // refresh
                                  }
                                } else {
                                  if (mounted) {
                                    ScaffoldMessenger.of(context).showSnackBar(
                                      SnackBar(
                                        content: Text(
                                          response.message ??
                                              'Failed to place order',
                                        ),
                                        backgroundColor: Colors.red,
                                      ),
                                    );
                                  }
                                }
                              } catch (e) {
                                if (ctx.mounted) Navigator.pop(ctx);
                                if (mounted) {
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    SnackBar(
                                      content: Text('Error: $e'),
                                      backgroundColor: Colors.red,
                                    ),
                                  );
                                }
                              }
                            },
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF00838F),
                        padding: const EdgeInsets.symmetric(vertical: 14),
                      ),
                      child: ordering
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(
                                color: Colors.white,
                                strokeWidth: 2,
                              ),
                            )
                          : Text(
                              AppLocalizations.of(ctx)!.yourHealthPlaceOrder,
                              style: const TextStyle(color: Colors.white),
                            ),
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  _PharmacyPrescriptionState _pharmacyState(Map<String, dynamic> rx) {
    final rawOrderStatus =
        (rx['pharmacy_order_status'] ?? rx['pharmacy_status'] ?? '')
            .toString()
            .trim()
            .toUpperCase();
    final rawPayment =
        (rx['pharmacy_payment_status'] ?? rx['payment_status'] ?? '')
            .toString()
            .trim()
            .toLowerCase();
    final orderNumber = (rx['pharmacy_order_number'] ?? '').toString().trim();
    final optType = (rx['pharmacy_opt_type'] ?? '').toString().trim();
    final isPartial = _truthy(rx['pharmacy_partial_dispense']);
    final amount = rx['pharmacy_amount_collected'];
    final total = rx['pharmacy_total_amount'];

    String paidText() {
      if (rawPayment.isEmpty) return '';
      final base = rawPayment == 'paid'
          ? 'Paid'
          : rawPayment == 'pending'
          ? 'Payment pending'
          : _titleCase(rawPayment);
      if (amount == null && total == null) return base;
      final parts = <String>[];
      if (amount != null) parts.add('collected ₹$amount');
      if (total != null) parts.add('total ₹$total');
      return '$base (${parts.join(', ')})';
    }

    final detailParts = <String>[
      if (orderNumber.isNotEmpty) orderNumber,
      if (optType.isNotEmpty) optType,
      if (paidText().isNotEmpty) paidText(),
    ];

    switch (rawOrderStatus) {
      case 'DISPENSED':
      case 'DELIVERED':
        return _PharmacyPrescriptionState(
          label: isPartial ? 'Partially dispensed' : 'Dispensed',
          detail: detailParts.isEmpty
              ? 'Medicines dispensed by pharmacy'
              : detailParts.join(' • '),
          color: Colors.teal,
          icon: Icons.verified_outlined,
        );
      case 'READY':
        return _PharmacyPrescriptionState(
          label: 'Ready',
          detail: detailParts.isEmpty
              ? 'Medicines ready at pharmacy'
              : detailParts.join(' • '),
          color: Colors.indigo,
          icon: Icons.inventory_2_outlined,
        );
      case 'PREPARING':
      case 'CONFIRMED':
      case 'DISPATCHED':
      case 'PENDING':
        return _PharmacyPrescriptionState(
          label: _titleCase(rawOrderStatus),
          detail: detailParts.isEmpty
              ? 'Pharmacy order in progress'
              : detailParts.join(' • '),
          color: Colors.green,
          icon: Icons.local_pharmacy_outlined,
        );
      case 'CANCELLED':
        return _PharmacyPrescriptionState(
          label: 'Cancelled',
          detail: detailParts.isEmpty
              ? 'Pharmacy order was cancelled'
              : detailParts.join(' • '),
          color: Colors.red,
          icon: Icons.cancel_outlined,
        );
      default:
        return _PharmacyPrescriptionState(
          label: 'Ordered',
          detail: detailParts.isEmpty
              ? 'Medicines ordered via pharmacy'
              : detailParts.join(' • '),
          color: Colors.green,
          icon: Icons.check_circle_outline,
        );
    }
  }

  bool _truthy(Object? value) =>
      value == true || value?.toString().toLowerCase() == 'true';

  String _titleCase(String value) {
    final clean = value.replaceAll('_', ' ').trim().toLowerCase();
    if (clean.isEmpty) return value;
    return clean
        .split(RegExp(r'\s+'))
        .map(
          (part) => part.isEmpty
              ? part
              : '${part[0].toUpperCase()}${part.substring(1)}',
        )
        .join(' ');
  }
}

class _PharmacyPrescriptionState {
  const _PharmacyPrescriptionState({
    required this.label,
    required this.detail,
    required this.color,
    required this.icon,
  });

  final String label;
  final String detail;
  final Color color;
  final IconData icon;
}

/// Inline banner on the Rx detail sheet surfacing CDS context fetched from
/// `/prescriptions/:id/safety`. Shows allergy warnings against the patient's
/// profile and — when a clinician has overridden a blocker — the recorded
/// reason, so the patient has visibility into prescribing decisions.
class _SafetyContextBanner extends StatefulWidget {
  const _SafetyContextBanner({required this.prescriptionId});
  final int prescriptionId;

  @override
  State<_SafetyContextBanner> createState() => _SafetyContextBannerState();
}

class _SafetyContextBannerState extends State<_SafetyContextBanner> {
  late Future<Map<String, dynamic>?> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<Map<String, dynamic>?> _load() async {
    try {
      final resp = await ApiClient.get(
        '/prescriptions/${widget.prescriptionId}/safety',
      );
      if (resp.isSuccess) return resp.dataAsMap();
    } catch (_) {
      /* silent — banner is best-effort */
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Map<String, dynamic>?>(
      future: _future,
      builder: (ctx, snap) {
        final data = snap.data;
        if (data == null) return const SizedBox.shrink();
        final warnings = (data['warnings'] as List?) ?? const [];
        final overrides = (data['overrides'] as List?) ?? const [];
        if (warnings.isEmpty && overrides.isEmpty) {
          return const SizedBox.shrink();
        }

        final theme = Theme.of(ctx);
        return Container(
          margin: const EdgeInsets.only(bottom: 16),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: theme.colorScheme.errorContainer.withValues(alpha: 0.3),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: theme.colorScheme.error.withValues(alpha: 0.4),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    Icons.health_and_safety,
                    color: theme.colorScheme.error,
                    size: 18,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    AppLocalizations.of(ctx)!.yourHealthSafetyNotes,
                    style: theme.textTheme.labelLarge?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              for (final w in warnings)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text(
                    '• ${(w as Map)['message'] ?? ''}',
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
              if (overrides.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(
                  AppLocalizations.of(ctx)!.yourHealthClinicianOverride,
                  style: theme.textTheme.labelMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                for (final o in overrides)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      '• ${(o as Map)['reason'] ?? ''}',
                      style: const TextStyle(
                        fontSize: 13,
                        fontStyle: FontStyle.italic,
                      ),
                    ),
                  ),
              ],
            ],
          ),
        );
      },
    );
  }
}
