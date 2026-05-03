// Hospital Documents tab — self-contained widget with its own state and data fetching
import 'package:flutter/material.dart';

import 'package:vhhealth/core/services/api_client.dart';
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
          _error = response.message ?? 'Failed to load records';
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
    final cs = Theme.of(context).colorScheme;

    if (_isLoading) {
      return Center(
        child: CircularProgressIndicator(
          valueColor: AlwaysStoppedAnimation(cs.primary),
        ),
      );
    }

    if (_error != null && _hospitalRecords.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              _error!,
              style: TextStyle(color: cs.error),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 12),
            ElevatedButton(
              onPressed: _fetchRecords,
              child: const Text('Retry'),
            ),
          ],
        ),
      );
    }

    if (_hospitalRecords.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(
                Icons.local_hospital_outlined,
                size: 64,
                color: Colors.grey,
              ),
              const SizedBox(height: 12),
              Text(
                AppLocalizations.of(context)!.recordsHospitalEmpty,
                style: const TextStyle(color: Colors.grey),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchRecords,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _hospitalRecords.length,
        itemBuilder: (_, i) => RecordCard(record: _hospitalRecords[i]),
      ),
    );
  }
}
