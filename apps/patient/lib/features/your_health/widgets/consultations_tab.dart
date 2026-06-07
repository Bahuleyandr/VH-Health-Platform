import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class ConsultationsTab extends StatefulWidget {
  const ConsultationsTab({super.key});

  @override
  State<ConsultationsTab> createState() => _ConsultationsTabState();
}

class _ConsultationsTabState extends State<ConsultationsTab> {
  List<dynamic> _consultations = [];
  bool _isLoading = true;
  String? _error;
  String? _staleLabel;

  @override
  void initState() {
    super.initState();
    _fetchConsultations();
  }

  Future<void> _fetchConsultations() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final result = await ApiClient.cachedGet('/records/consultations/my');
      if (!mounted) return;
      _staleLabel = result.staleLabel;

      if (result.isSuccess) {
        final rawData = result.data;
        final List<dynamic> data = rawData is List
            ? rawData
            : (rawData is Map ? (rawData['records'] ?? rawData ?? []) : [])
                  as List<dynamic>;
        setState(() {
          _consultations = data;
          _isLoading = false;
        });
      } else {
        setState(() {
          _isLoading = false;
          _error = 'Failed to load consultations';
        });
      }
      // Listen for fresh data from background refresh
      result.onFresh?.then((fresh) {
        if (!mounted) return;
        if (fresh.isSuccess) {
          final rawData = fresh.data;
          final List<dynamic> data = rawData is List
              ? rawData
              : (rawData is Map ? (rawData['records'] ?? rawData ?? []) : [])
                    as List<dynamic>;
          setState(() {
            _staleLabel = null;
            _consultations = data;
          });
        }
      });
    } catch (e) {
      debugPrint('Consultations fetch failed: $e');
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _error = 'Network error';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l10n = AppLocalizations.of(context)!;
    final dateFmt = DateFormat.yMMMd(
      Localizations.localeOf(context).toString(),
    );

    if (_isLoading) {
      return Center(
        child: CircularProgressIndicator(
          valueColor: AlwaysStoppedAnimation(cs.primary),
        ),
      );
    }

    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, size: 48, color: cs.error),
            const SizedBox(height: 12),
            Text(
              _error!,
              style: theme.textTheme.bodyLarge?.copyWith(
                color: cs.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: _fetchConsultations,
              child: const Text('Retry'),
            ),
          ],
        ),
      );
    }

    if (_consultations.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.medical_services_outlined,
              size: 48,
              color: cs.onSurface.withAlpha(100),
            ),
            const SizedBox(height: 12),
            Text(
              l10n.consultationsEmpty,
              style: theme.textTheme.bodyLarge?.copyWith(
                color: cs.onSurfaceVariant,
              ),
            ),
          ],
        ),
      );
    }

    return Column(
      children: [
        OfflineBanner(staleLabel: _staleLabel),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _fetchConsultations,
            child: ListView.builder(
              padding: const EdgeInsets.all(12),
              itemCount: _consultations.length,
              itemBuilder: (_, i) {
                final c = _consultations[i];
                final doctor = c['doctor_name'] ?? c['doctor'] ?? '';
                final diagnosis = c['diagnosis'] ?? '';
                final notes = c['notes'] ?? c['description'] ?? '';
                DateTime? date;
                final dateStr =
                    c['date'] ?? c['consultation_date'] ?? c['created_at'];
                if (dateStr != null) {
                  try {
                    date = DateTime.parse(dateStr.toString()).toLocal();
                  } catch (e) {
                    debugPrint('Consultation date parse failed: $e');
                  }
                }

                return Card(
                  margin: const EdgeInsets.only(bottom: 10),
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Icon(
                              Icons.medical_services_outlined,
                              color: cs.primary,
                              size: 20,
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                doctor.isNotEmpty ? doctor : 'Consultation',
                                style: theme.textTheme.titleSmall?.copyWith(
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                            if (date != null)
                              Text(
                                dateFmt.format(date),
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: cs.onSurfaceVariant,
                                ),
                              ),
                          ],
                        ),
                        if (diagnosis.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '${l10n.consultationDiagnosis}: ',
                                style: theme.textTheme.bodySmall?.copyWith(
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              Expanded(
                                child: Text(
                                  diagnosis,
                                  style: theme.textTheme.bodySmall,
                                ),
                              ),
                            ],
                          ),
                        ],
                        if (notes.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          Text(
                            notes,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      ],
    );
  }
}
