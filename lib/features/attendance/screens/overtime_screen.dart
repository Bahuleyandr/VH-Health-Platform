import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/services/attendance_api_service.dart';

class OvertimeScreen extends StatefulWidget {
  const OvertimeScreen({super.key});
  @override
  State<OvertimeScreen> createState() => _OvertimeScreenState();
}

class _OvertimeScreenState extends State<OvertimeScreen> with SingleTickerProviderStateMixin {
  late TabController _tabController;
  List<dynamic> _requests = [];
  bool _loading = true;

  DateTime? _date;
  double _hours = 1.0;
  String _reason = '';
  String _type = 'comp_time';
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _load();
  }

  @override
  void dispose() { _tabController.dispose(); super.dispose(); }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final list = await AttendanceApiService.getMyOvertimeRequests();
      if (mounted) setState(() => _requests = list);
    } catch (e) { debugPrint('overtime_screen.dart: $e'); } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _submit() async {
    if (_date == null || _reason.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Date and reason required'), backgroundColor: Colors.red));
      return;
    }
    setState(() => _submitting = true);
    try {
      await AttendanceApiService.requestOvertime(
        date: DateFormat('yyyy-MM-dd').format(_date!),
        extraHours: _hours,
        reason: _reason.trim(),
        type: _type,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('✅ Overtime request submitted'), backgroundColor: Colors.green));
        setState(() { _date = null; _reason = ''; _hours = 1.0; });
        _tabController.animateTo(1);
        _load();
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString().replaceFirst('Exception: ', '')), backgroundColor: Colors.red));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Overtime Requests'),
        backgroundColor: const Color(0xFF007A64),
        foregroundColor: Colors.white,
        bottom: TabBar(controller: _tabController, labelColor: Colors.white, indicatorColor: Colors.white,
          tabs: [const Tab(text: 'Request'), Tab(text: 'My Requests (${_requests.length})')]),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [_buildRequestTab(), _buildHistoryTab()],
      ),
    );
  }

  Widget _buildRequestTab() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Date', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          InkWell(
            onTap: () async {
              final d = await showDatePicker(context: context, initialDate: DateTime.now(), firstDate: DateTime.now().subtract(const Duration(days: 14)), lastDate: DateTime.now());
              if (d != null) setState(() => _date = d);
            },
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(border: Border.all(color: Colors.grey.shade400), borderRadius: BorderRadius.circular(8)),
              child: Row(children: [
                const Icon(Icons.calendar_today, size: 16, color: Colors.grey),
                const SizedBox(width: 8),
                Text(_date != null ? DateFormat('d MMMM yyyy').format(_date!) : 'Select date', style: TextStyle(color: _date != null ? Colors.black : Colors.grey.shade600)),
              ]),
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              const Expanded(child: Text('Extra Hours', style: TextStyle(fontWeight: FontWeight.w600))),
              Text('${_hours.toStringAsFixed(1)} hrs', style: const TextStyle(color: Color(0xFF007A64), fontWeight: FontWeight.bold, fontSize: 16)),
            ],
          ),
          Slider(
            value: _hours,
            min: 0.5,
            max: 8.0,
            divisions: 15,
            activeColor: const Color(0xFF007A64),
            onChanged: (v) => setState(() => _hours = (v * 2).round() / 2),
          ),
          const SizedBox(height: 16),
          const Text('Type', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: _type,
            decoration: const InputDecoration(border: OutlineInputBorder()),
            items: const [
              DropdownMenuItem(value: 'comp_time', child: Text('Compensatory Time Off')),
              DropdownMenuItem(value: 'payment', child: Text('Overtime Payment')),
            ],
            onChanged: (v) => setState(() => _type = v!),
          ),
          const SizedBox(height: 16),
          const Text('Reason', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          TextField(
            decoration: const InputDecoration(hintText: 'Why did you work overtime?', border: OutlineInputBorder()),
            maxLines: 3,
            onChanged: (v) => _reason = v,
          ),
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton(
              onPressed: _submitting ? null : _submit,
              style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF007A64), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
              child: _submitting ? const CircularProgressIndicator(color: Colors.white, strokeWidth: 2)
                  : const Text('Submit Overtime Request', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.white)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildHistoryTab() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_requests.isEmpty) return Center(child: Text('No overtime requests', style: TextStyle(color: Colors.grey.shade600)));
    return ListView.builder(
      padding: const EdgeInsets.all(8),
      itemCount: _requests.length,
      itemBuilder: (ctx, i) {
        final r = _requests[i] as Map<String, dynamic>;
        final status = r['status'] as String? ?? 'pending';
        final statusColor = status == 'approved' ? Colors.green : status == 'rejected' ? Colors.red : Colors.orange;
        final hours = r['extra_hours'] as num? ?? 0;
        final type = (r['type'] as String? ?? '').replaceAll('_', ' ');
        return Card(
          child: ListTile(
            title: Text(r['date'] as String? ?? ''),
            subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${hours}h · $type'),
              if ((r['reason'] as String? ?? '').isNotEmpty) Text(r['reason'] as String, style: TextStyle(color: Colors.grey.shade600, fontSize: 12)),
              if (r['rejection_reason'] != null) Text('Rejected: ${r['rejection_reason']}', style: const TextStyle(color: Colors.red, fontSize: 12)),
            ]),
            isThreeLine: true,
            trailing: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(color: statusColor.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(10), border: Border.all(color: statusColor)),
              child: Text(status.toUpperCase(), style: TextStyle(fontSize: 10, color: statusColor, fontWeight: FontWeight.bold)),
            ),
          ),
        );
      },
    );
  }
}
