import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';

/// Nurse-facing "due meds" list. Calls `GET /clinical/mar/due` and renders
/// one row per scheduled/held dose in a ±window around now. Tapping a row
/// pushes [MarScanScreen] with the `ma_id` — this is the entry point that
/// the MAR 5-rights scanner was missing (the scanner has always required a
/// `ma_id` in its constructor, but nothing upstream fed it one).
class DueMedsScreen extends StatefulWidget {
  const DueMedsScreen({super.key});

  @override
  State<DueMedsScreen> createState() => _DueMedsScreenState();
}

class _DueMedsScreenState extends State<DueMedsScreen> {
  List<Map<String, dynamic>> _rows = const [];
  bool _loading = true;
  String? _error;
  String _searchQuery = '';

  List<Map<String, dynamic>> get _filtered {
    final q = _searchQuery.trim().toLowerCase();
    if (q.isEmpty) return _rows;
    return _rows.where((r) {
      final patient = (r['patient_name']?.toString() ?? '').toLowerCase();
      final med = (r['medication_name']?.toString() ??
              r['medication']?.toString() ??
              r['drug_name']?.toString() ??
              '')
          .toLowerCase();
      return patient.contains(q) || med.contains(q);
    }).toList();
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final rows = await MedicalApiService.getDueMedications();
      if (!mounted) return;
      setState(() => _rows = rows);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Due Medications',
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: TextField(
              decoration: InputDecoration(
                hintText: 'Search by patient or medication…',
                prefixIcon: const Icon(Icons.search),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                filled: true,
                fillColor: Colors.white,
              ),
              onChanged: (v) => setState(() => _searchQuery = v),
            ),
          ),
          Expanded(
            child: RefreshIndicator(onRefresh: _load, child: _buildBody()),
          ),
        ],
      ),
    );
  }

  Widget _buildBody() {
    if (_loading && _rows.isEmpty) {
      return const SkeletonList();
    }
    if (_error != null && _rows.isEmpty) {
      return _errorView(_error!);
    }
    final rows = _filtered;
    if (rows.isEmpty) {
      if (_searchQuery.trim().isNotEmpty) {
        return ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            const SizedBox(height: 120),
            Center(
              child: Text(
                'No matches for "$_searchQuery"',
                style: const TextStyle(color: Colors.black54),
              ),
            ),
          ],
        );
      }
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [
          SizedBox(height: 80),
          EmptyState(
            icon: Icons.medication_outlined,
            title: 'No medications due',
            body: 'Tap a bed on the bed board to record vitals.',
          ),
        ],
      );
    }

    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: rows.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, i) =>
          _DueMedTile(row: rows[i], onTap: () => _openScanner(rows[i])),
    );
  }

  void _openScanner(Map<String, dynamic> row) {
    final idRaw = row['id'];
    final maId = idRaw is int ? idRaw : int.tryParse(idRaw?.toString() ?? '');
    if (maId == null) return;
    context.push('/mar/scan/$maId').then((_) {
      if (mounted) _load();
    });
  }

  Widget _errorView(String msg) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        const SizedBox(height: 60),
        ErrorState(
          message: msg.replaceFirst('Exception: ', ''),
          onRetry: _load,
        ),
      ],
    );
  }
}

class _DueMedTile extends StatelessWidget {
  const _DueMedTile({required this.row, required this.onTap});

  final Map<String, dynamic> row;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheduled = _parseTime(row['scheduled_time']);
    final minutesDelta = scheduled == null
        ? null
        : DateTime.now().difference(scheduled).inMinutes;

    final overdue = minutesDelta != null && minutesDelta > 0;
    final color = overdue ? AppTheme.errorRed : AppTheme.successGreen;
    final timeLabel = scheduled == null
        ? 'unscheduled'
        : _relativeLabel(minutesDelta!);

    final patientName = (row['patient_name'] as String?)?.trim();
    final bedNumber = (row['bed_number'] as String?)?.trim();
    final wardName = (row['ward_name'] as String?)?.trim();
    final med =
        (row['medication_name'] as String?)?.trim() ?? '(unnamed medication)';
    final dose = (row['dose'] as String?) ?? (row['dosage'] as String?) ?? '';
    final route = (row['route'] as String?) ?? '';
    final status = (row['status'] as String?) ?? '';

    final subtitle = <String>[
      if (dose.isNotEmpty) dose,
      if (route.isNotEmpty) route,
      if (status == 'held') 'HELD',
    ].join(' · ');

    final whoLine = <String>[
      patientName == null || patientName.isEmpty
          ? 'Unknown patient'
          : patientName,
      if (bedNumber != null && bedNumber.isNotEmpty) 'Bed $bedNumber',
      if (wardName != null && wardName.isNotEmpty) wardName,
    ].join(' · ');

    return ListTile(
      onTap: onTap,
      leading: CircleAvatar(
        backgroundColor: color.withValues(alpha: 0.15),
        child: Icon(overdue ? Icons.schedule : Icons.medication, color: color),
      ),
      title: Text(
        med,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (subtitle.isNotEmpty)
            Text(subtitle, style: const TextStyle(fontSize: 13)),
          Text(
            whoLine,
            style: const TextStyle(fontSize: 12, color: Colors.black54),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
      trailing: Text(
        timeLabel,
        style: TextStyle(
          color: color,
          fontWeight: FontWeight.w600,
          fontSize: 13,
        ),
      ),
    );
  }

  static DateTime? _parseTime(Object? v) {
    if (v == null) return null;
    try {
      return DateTime.parse(v.toString()).toLocal();
    } catch (_) {
      return null;
    }
  }

  static String _relativeLabel(int minutesDelta) {
    if (minutesDelta == 0) return 'now';
    final abs = minutesDelta.abs();
    final suffix = minutesDelta > 0 ? 'late' : 'in';
    final value = abs < 60
        ? '${abs}m'
        : '${(abs / 60).toStringAsFixed(abs % 60 == 0 ? 0 : 1)}h';
    return suffix == 'late' ? '$value late' : 'in $value';
  }
}
