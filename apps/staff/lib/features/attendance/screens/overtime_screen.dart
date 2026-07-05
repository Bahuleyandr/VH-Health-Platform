import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/services/attendance_api_service.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class OvertimeScreen extends StatefulWidget {
  const OvertimeScreen({super.key});
  @override
  State<OvertimeScreen> createState() => _OvertimeScreenState();
}

String _overtimeStatusLabel(AppStrings s, String status) {
  switch (status) {
    case 'approved':
      return s.overtimeStatusApproved;
    case 'rejected':
      return s.overtimeStatusRejected;
    case 'pending':
      return s.overtimeStatusPending;
    default:
      return status;
  }
}

String _overtimeTypeLabel(AppStrings s, String type) {
  switch (type) {
    case 'comp_time':
      return s.overtimeTypeCompTime;
    case 'payment':
      return s.overtimeTypePayment;
    default:
      return type;
  }
}

class _OvertimeScreenState extends State<OvertimeScreen>
    with SingleTickerProviderStateMixin {
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
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final list = await AttendanceApiService.getMyOvertimeRequests();
      if (mounted) setState(() => _requests = list);
    } catch (e) {
      debugPrint('overtime_screen.dart: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _submit() async {
    final s = AppStrings.of(context);
    if (_date == null || _reason.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.overtimeRequiredError),
          backgroundColor: Colors.red,
        ),
      );
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
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.overtimeSubmittedSuccess),
            backgroundColor: Colors.green,
          ),
        );
        setState(() {
          _date = null;
          _reason = '';
          _hours = 1.0;
        });
        _tabController.animateTo(1);
        _load();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: Colors.red,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.overtimeTitle),
        actions: const [LogoutAction()],
        backgroundColor: const Color(0xFF007A64),
        foregroundColor: Colors.white,
        bottom: TabBar(
          controller: _tabController,
          labelColor: Colors.white,
          indicatorColor: Colors.white,
          tabs: [
            Tab(text: s.overtimeTabRequest),
            Tab(
              text: s.attendanceTabWithCount(s.overtimeTabMy, _requests.length),
            ),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [_buildRequestTab(), _buildHistoryTab()],
      ),
    );
  }

  Widget _buildRequestTab() {
    final s = AppStrings.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            s.disputeDateLabel,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          InkWell(
            onTap: () async {
              final d = await showDatePicker(
                context: context,
                initialDate: DateTime.now(),
                firstDate: DateTime.now().subtract(const Duration(days: 14)),
                lastDate: DateTime.now(),
              );
              if (d != null) setState(() => _date = d);
            },
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                border: Border.all(color: Colors.grey.shade400),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  const Icon(
                    Icons.calendar_today,
                    size: 16,
                    color: Colors.grey,
                  ),
                  const SizedBox(width: 8),
                  Text(
                    _date != null
                        ? DateFormat('d MMMM yyyy').format(_date!)
                        : s.disputeSelectDate,
                    style: TextStyle(
                      color: _date != null
                          ? Colors.black
                          : Colors.grey.shade600,
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: Text(
                  s.overtimeExtraHoursLabel,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
              Text(
                '${_hours.toStringAsFixed(1)} ${s.overtimeHoursSuffix}',
                style: const TextStyle(
                  color: Color(0xFF007A64),
                  fontWeight: FontWeight.bold,
                  fontSize: 16,
                ),
              ),
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
          Text(
            s.overtimeTypeLabel,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: _type,
            decoration: const InputDecoration(border: OutlineInputBorder()),
            items: [
              DropdownMenuItem(
                value: 'comp_time',
                child: Text(s.overtimeTypeCompTime),
              ),
              DropdownMenuItem(
                value: 'payment',
                child: Text(s.overtimeTypePayment),
              ),
            ],
            onChanged: (v) => setState(() => _type = v!),
          ),
          const SizedBox(height: 16),
          Text(
            s.overtimeReasonLabel,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          TextField(
            decoration: InputDecoration(
              hintText: s.overtimeReasonHint,
              border: const OutlineInputBorder(),
            ),
            maxLines: 3,
            onChanged: (v) => _reason = v,
          ),
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton(
              onPressed: _submitting ? null : _submit,
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF007A64),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              child: _submitting
                  ? const CircularProgressIndicator(
                      color: Colors.white,
                      strokeWidth: 2,
                    )
                  : Text(
                      s.overtimeSubmitButton,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: Colors.white,
                      ),
                    ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildHistoryTab() {
    final s = AppStrings.of(context);
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_requests.isEmpty) {
      return Center(
        child: Text(
          s.overtimeEmpty,
          style: TextStyle(color: Colors.grey.shade600),
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.all(8),
      itemCount: _requests.length,
      itemBuilder: (ctx, i) {
        final r = _requests[i] as Map<String, dynamic>;
        final status = r['status'] as String? ?? 'pending';
        final statusColor = status == 'approved'
            ? Colors.green
            : status == 'rejected'
            ? Colors.red
            : Colors.orange;
        final hours = r['extra_hours'] as num? ?? 0;
        final type = _overtimeTypeLabel(s, r['type'] as String? ?? '');
        return Card(
          child: ListTile(
            title: Text(r['date'] as String? ?? ''),
            subtitle: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.overtimeHoursAndType(hours.toString(), type)),
                if ((r['reason'] as String? ?? '').isNotEmpty)
                  Text(
                    r['reason'] as String,
                    style: TextStyle(color: Colors.grey.shade600, fontSize: 12),
                  ),
                if (r['rejection_reason'] != null)
                  Text(
                    s.overtimeRejectedReason(r['rejection_reason'].toString()),
                    style: const TextStyle(color: Colors.red, fontSize: 12),
                  ),
              ],
            ),
            isThreeLine: true,
            trailing: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: statusColor.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: statusColor),
              ),
              child: Text(
                _overtimeStatusLabel(s, status).toUpperCase(),
                style: TextStyle(
                  fontSize: 10,
                  color: statusColor,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
