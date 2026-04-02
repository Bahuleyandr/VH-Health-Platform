import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

class RefillScreen extends StatefulWidget {
  final String phone;
  const RefillScreen({super.key, required this.phone});

  @override
  State<RefillScreen> createState() => _RefillScreenState();
}

class _RefillScreenState extends State<RefillScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _prescriptions = [];

  // Track refill request status per prescription id
  final Map<String, String> _refillStatus = {};

  @override
  void initState() {
    super.initState();
    _fetchPrescriptions();
  }

  Future<void> _fetchPrescriptions() async {
    setState(() {
      _loading = true;
      _error = null;
      _refillStatus.clear();
    });
    try {
      final response = await ApiClient.get('/prescriptions/patient/my');
      if (!mounted) return;
      if (response.isSuccess) {
        final list = response.dataAsList();
        setState(() {
          _prescriptions = list.cast<Map<String, dynamic>>();
          _loading = false;
        });
      } else {
        setState(() {
          _error = response.message ?? 'Failed to load prescriptions';
          _loading = false;
        });
      }
    } catch (e) {
      if (kDebugMode) debugPrint('RefillScreen: fetch error: $e');
      if (mounted) {
        setState(() {
          _error = 'Failed to load prescriptions';
          _loading = false;
        });
      }
    }
  }

  Future<void> _requestRefill(Map<String, dynamic> prescription) async {
    final id = (prescription['_id'] as String?) ?? (prescription['id']?.toString());
    if (id == null || id.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Prescription ID not found')),
        );
      }
      return;
    }
    final medName = prescription['medicationName'] as String? ??
        prescription['name'] as String? ??
        'this medication';

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Request Refill'),
        content: Text('Request a refill for $medName?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Request Refill'),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) return;

    setState(() => _refillStatus[id] = 'submitting');

    try {
      final response = await ApiClient.post('/prescriptions/$id/refill');
      if (!mounted) return;

      if (response.isSuccess) {
        setState(() => _refillStatus[id] = 'submitted');
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Refill requested for $medName')),
        );
      } else {
        setState(() => _refillStatus[id] = 'error');
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(response.message ?? 'Failed to request refill')),
        );
      }
    } catch (e) {
      if (kDebugMode) debugPrint('RefillScreen: refill error: $e');
      if (mounted) {
        setState(() => _refillStatus[id] = 'error');
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to request refill. Please try again.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return FeatureScreenScaffold(
      title: 'Prescription Refills',
      icon: Icons.medication,
      color: const Color(0xFF81D4FA),
      child: _buildBody(),
    );
  }

  Widget _buildBody() {
    final theme = Theme.of(context);

    if (_loading) {
      return const SizedBox(
        height: 200,
        child: Center(child: CircularProgressIndicator()),
      );
    }

    if (_error != null) {
      return SizedBox(
        height: 200,
        child: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.error_outline, size: 48, color: theme.colorScheme.error),
              const SizedBox(height: 12),
              Text(_error!, style: theme.textTheme.bodyMedium),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: _fetchPrescriptions,
                icon: const Icon(Icons.refresh),
                label: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    if (_prescriptions.isEmpty) {
      return SizedBox(
        height: 200,
        child: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.medication_outlined, size: 48, color: Colors.grey.shade400),
              const SizedBox(height: 12),
              Text('No active prescriptions', style: theme.textTheme.bodyMedium),
              const SizedBox(height: 8),
              Text(
                'Your prescriptions from consultations will appear here.',
                style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Active Prescriptions',
          style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 4),
        Text(
          'Tap "Request Refill" to ask your doctor for a renewal.',
          style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey),
        ),
        const SizedBox(height: 16),
        ListView.separated(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: _prescriptions.length,
          separatorBuilder: (_, __) => const SizedBox(height: 12),
          itemBuilder: (context, index) {
            return _PrescriptionRefillCard(
              prescription: _prescriptions[index],
              refillStatus: _refillStatus[
                  _prescriptions[index]['_id'] as String? ??
                      _prescriptions[index]['id'] as String? ??
                      ''],
              onRequestRefill: () => _requestRefill(_prescriptions[index]),
            );
          },
        ),
      ],
    );
  }
}

class _PrescriptionRefillCard extends StatelessWidget {
  final Map<String, dynamic> prescription;
  final String? refillStatus;
  final VoidCallback onRequestRefill;

  const _PrescriptionRefillCard({
    required this.prescription,
    this.refillStatus,
    required this.onRequestRefill,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final medName = prescription['medicationName'] as String? ??
        prescription['name'] as String? ??
        'Unknown Medication';
    final dosage = prescription['dosage'] as String? ?? '';
    final lastFilledRaw = prescription['lastFilledDate'] as String? ??
        prescription['createdAt'] as String? ??
        '';
    final status = prescription['status'] as String? ?? 'active';

    String lastFilled = lastFilledRaw;
    try {
      if (lastFilledRaw.isNotEmpty) {
        final dt = DateTime.parse(lastFilledRaw);
        lastFilled = DateFormat('MMM dd, yyyy').format(dt);
      }
    } catch (_) {}

    final isSubmitting = refillStatus == 'submitting';
    final isSubmitted = refillStatus == 'submitted';
    final hasError = refillStatus == 'error';

    return Card(
      elevation: 1,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.medication, color: const Color(0xFF42A5F5), size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    medName,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                _StatusChip(status: status),
              ],
            ),
            if (dosage.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                'Dosage: $dosage',
                style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey.shade700),
              ),
            ],
            if (lastFilled.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                'Last filled: $lastFilled',
                style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey.shade600),
              ),
            ],
            const SizedBox(height: 12),
            if (isSubmitted)
              Chip(
                avatar: const Icon(Icons.check_circle, color: Colors.green, size: 18),
                label: const Text('Refill Requested'),
                backgroundColor: Colors.green.shade50,
              )
            else
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: isSubmitting ? null : onRequestRefill,
                  icon: isSubmitting
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Icon(
                          hasError ? Icons.refresh : Icons.replay,
                          size: 18,
                        ),
                  label: Text(
                    isSubmitting
                        ? 'Requesting...'
                        : hasError
                            ? 'Retry Refill Request'
                            : 'Request Refill',
                  ),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: const Color(0xFF42A5F5),
                    side: const BorderSide(color: Color(0xFF42A5F5)),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  final String status;
  const _StatusChip({required this.status});

  @override
  Widget build(BuildContext context) {
    Color color;
    switch (status.toLowerCase()) {
      case 'active':
        color = Colors.green;
        break;
      case 'expired':
        color = Colors.red;
        break;
      default:
        color = Colors.grey;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withAlpha(26),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withAlpha(77)),
      ),
      child: Text(
        status.toUpperCase(),
        style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: color),
      ),
    );
  }
}
