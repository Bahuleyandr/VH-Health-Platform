import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/offline/patient_cache_invalidation.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

class RefillScreen extends StatefulWidget {
  const RefillScreen({super.key});

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
          _error = response.failureMessage('Failed to load prescriptions');
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
    final l = AppLocalizations.of(context)!;
    final id =
        (prescription['_id'] as String?) ?? (prescription['id']?.toString());
    if (id == null || id.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l.refillPrescriptionIdMissing)));
      }
      return;
    }
    final medName =
        prescription['medicationName'] as String? ??
        prescription['name'] as String? ??
        'this medication';

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.refillConfirmTitle),
        content: Text(l.refillConfirmBody(medName)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(l.commonCancelButton),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(l.refillRequestButton),
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
        await PatientCacheInvalidation.afterRefillMutation();
        if (!mounted) return;
        setState(() => _refillStatus[id] = 'submitted');
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l.refillRequested(medName))));
      } else {
        setState(() => _refillStatus[id] = 'error');
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(response.failureMessage(l.refillRequestFailed)),
          ),
        );
      }
    } catch (e) {
      if (kDebugMode) debugPrint('RefillScreen: refill error: $e');
      if (mounted) {
        setState(() => _refillStatus[id] = 'error');
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l.refillRequestRetry)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: l.refillTitle,
      icon: Icons.medication,
      color: colors.secondary,
      child: _buildBody(),
    );
  }

  Widget _buildBody() {
    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;

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
              Icon(
                Icons.error_outline,
                size: 48,
                color: theme.colorScheme.error,
              ),
              const SizedBox(height: 12),
              Text(_error!, style: theme.textTheme.bodyMedium),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: _fetchPrescriptions,
                icon: const Icon(Icons.refresh),
                label: Text(l.familyRetryButton),
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
              Icon(
                Icons.medication_outlined,
                size: 48,
                color: theme.colorScheme.outlineVariant,
              ),
              const SizedBox(height: 12),
              Text(l.refillNoActive, style: theme.textTheme.bodyMedium),
              const SizedBox(height: 8),
              Text(
                l.refillNoActiveHint,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
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
          l.refillActivePrescriptions,
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.bold,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          l.refillHint,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 16),
        ListView.separated(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: _prescriptions.length,
          separatorBuilder: (_, _) => const SizedBox(height: 12),
          itemBuilder: (context, index) {
            return _PrescriptionRefillCard(
              prescription: _prescriptions[index],
              refillStatus:
                  _refillStatus[(_prescriptions[index]['_id'] as String?) ??
                      _prescriptions[index]['id']?.toString() ??
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
    final colors = theme.colorScheme;
    final l = AppLocalizations.of(context)!;
    final medName =
        prescription['medicationName'] as String? ??
        prescription['name'] as String? ??
        'Unknown Medication';
    final dosage = prescription['dosage'] as String? ?? '';
    final lastFilledRaw =
        prescription['lastFilledDate'] as String? ??
        prescription['createdAt'] as String? ??
        '';
    final status = prescription['status'] as String? ?? 'active';

    String lastFilled = lastFilledRaw;
    try {
      if (lastFilledRaw.isNotEmpty) {
        final dt = DateTime.parse(lastFilledRaw);
        lastFilled = DateFormat('MMM dd, yyyy').format(dt);
      }
    } catch (e) {
      debugPrint('Refill date parse error: $e');
    }

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
                Icon(Icons.medication, color: colors.secondary, size: 20),
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
                style: theme.textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
            if (lastFilled.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                'Last filled: $lastFilled',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
            const SizedBox(height: 12),
            if (isSubmitted)
              Chip(
                avatar: Icon(
                  Icons.check_circle,
                  color: colors.tertiary,
                  size: 18,
                ),
                label: Text(l.refillRequestedHeading),
                backgroundColor: colors.tertiaryContainer,
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
                      : Icon(hasError ? Icons.refresh : Icons.replay, size: 18),
                  label: Text(
                    isSubmitting
                        ? l.refillRequesting
                        : hasError
                        ? l.refillRetry
                        : l.refillRequestButton,
                  ),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: colors.secondary,
                    side: BorderSide(color: colors.secondary),
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
    final colors = Theme.of(context).colorScheme;
    Color color;
    switch (status.toLowerCase()) {
      case 'active':
        color = colors.tertiary;
        break;
      case 'expired':
        color = colors.error;
        break;
      default:
        color = colors.onSurfaceVariant;
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
        style: TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.bold,
          color: color,
        ),
      ),
    );
  }
}
