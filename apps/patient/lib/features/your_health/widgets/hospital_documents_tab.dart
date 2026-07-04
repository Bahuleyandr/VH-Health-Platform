// Hospital Documents tab — self-contained widget with its own state and data fetching
import 'package:flutter/material.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/features/portal/screens/discharge_summaries_screen.dart';
import 'package:vhhealth/features/your_health/widgets/record_card.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class HospitalDocumentsTab extends StatefulWidget {
  const HospitalDocumentsTab({super.key});

  @override
  State<HospitalDocumentsTab> createState() => _HospitalDocumentsTabState();
}

class _HospitalDocumentsTabState extends State<HospitalDocumentsTab> {
  List<Map<String, dynamic>> _hospitalRecords = [];
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _fetchRecords();
  }

  Future<void> _fetchRecords() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final response = await ApiClient.get('/appointments/patient/records/all');
      if (!mounted) return;

      if (response.isSuccess) {
        final data = response.dataAsMap();
        final hospitalRaw = (data['hospital_records'] as List?) ?? [];
        setState(() {
          _hospitalRecords = hospitalRaw
              .map((j) => Map<String, dynamic>.from(j as Map))
              .toList();
          _isLoading = false;
        });
      } else {
        setState(() {
          _error = response.failureMessage('Failed to load records');
          _isLoading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return DefaultTabController(
      length: 2,
      child: Column(
        children: [
          TabBar(
            tabs: [
              Tab(text: l10n.yourHealthHospitalRecordsTab),
              Tab(text: l10n.dischargeSummariesTab),
            ],
          ),
          Expanded(
            child: TabBarView(
              children: [
                _HospitalRecordsPane(
                  isLoading: _isLoading,
                  error: _error,
                  records: _hospitalRecords,
                  onRetry: _fetchRecords,
                ),
                const DischargeSummariesList(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _HospitalRecordsPane extends StatelessWidget {
  const _HospitalRecordsPane({
    required this.isLoading,
    required this.error,
    required this.records,
    required this.onRetry,
  });

  final bool isLoading;
  final String? error;
  final List<Map<String, dynamic>> records;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRetry,
      child: DataStateBuilder<Map<String, dynamic>>(
        isLoading: isLoading,
        error: error,
        data: records,
        onRetry: onRetry,
        emptyIcon: Icons.local_hospital_outlined,
        emptyTitle: AppLocalizations.of(context)!.recordsHospitalEmpty,
        emptySubtitle: AppLocalizations.of(
          context,
        )!.recordsHospitalEmptySubtitle,
        builder: (context, records) => ListView.builder(
          padding: const EdgeInsets.all(12),
          itemCount: records.length,
          itemBuilder: (_, i) => RecordCard(record: records[i]),
        ),
      ),
    );
  }
}
