import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/config/api_config.dart';
import '../../../core/services/attendance_api_service.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class DisputeScreen extends StatefulWidget {
  const DisputeScreen({super.key});
  @override
  State<DisputeScreen> createState() => _DisputeScreenState();
}

class _DisputeScreenState extends State<DisputeScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  List<dynamic> _myDisputes = [];
  bool _loading = true;

  // Submit form state
  DateTime? _disputeDate;
  String _disputeType = 'missed_checkin';
  final _descriptionCtrl = TextEditingController();
  String? _requestedCheckIn;
  String? _requestedCheckOut;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadDisputes();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _descriptionCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadDisputes() async {
    setState(() => _loading = true);
    try {
      final staffId = await ApiConfig.getStaffId();
      if (staffId != null) {
        final disputes = await AttendanceApiService.getMyDisputes(staffId);
        if (mounted) setState(() => _myDisputes = disputes);
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _submitDispute() async {
    final s = AppStrings.of(context);
    if (_disputeDate == null || _descriptionCtrl.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.disputeRequiredError),
          backgroundColor: Colors.red,
        ),
      );
      return;
    }
    setState(() => _submitting = true);
    try {
      final staffId = await ApiConfig.getStaffId();
      await AttendanceApiService.submitDispute(
        staffId: staffId!,
        date: DateFormat('yyyy-MM-dd').format(_disputeDate!),
        disputeType: _disputeType,
        description: _descriptionCtrl.text.trim(),
        requestedCheckIn: _requestedCheckIn,
        requestedCheckOut: _requestedCheckOut,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.disputeSubmittedSuccess),
            backgroundColor: Colors.green,
            duration: const Duration(seconds: 4),
          ),
        );
        _descriptionCtrl.clear();
        setState(() {
          _disputeDate = null;
          _requestedCheckIn = null;
          _requestedCheckOut = null;
        });
        _tabController.animateTo(1);
        _loadDisputes();
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
        title: Text(s.disputeTitle),
        actions: const [LogoutAction()],
        backgroundColor: const Color(0xFF007A64),
        foregroundColor: Colors.white,
        bottom: TabBar(
          controller: _tabController,
          labelColor: Colors.white,
          indicatorColor: Colors.white,
          tabs: [
            Tab(text: s.disputeTabSubmit),
            Tab(text: '${s.disputeTabMy} (${_myDisputes.length})'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [_buildSubmitTab(), _buildMyDisputesTab()],
      ),
    );
  }

  Widget _buildSubmitTab() {
    final s = AppStrings.of(context);
    final disputeTypes = {
      'missed_checkin': s.disputeTypeMissedCheckin,
      'missed_checkout': s.disputeTypeMissedCheckout,
      'wrong_time': s.disputeTypeWrongTime,
      'app_failure': s.disputeTypeAppFailure,
      'other': s.disputeTypeOther,
    };

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.blue.shade50,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Colors.blue.shade200),
            ),
            child: Row(
              children: [
                const Icon(Icons.info_outline, color: Colors.blue, size: 18),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    s.disputeIntro,
                    style: const TextStyle(fontSize: 12, color: Colors.blue),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Text(s.disputeDateLabel, style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          InkWell(
            onTap: () async {
              final d = await showDatePicker(
                context: context,
                initialDate: DateTime.now().subtract(const Duration(days: 1)),
                firstDate: DateTime.now().subtract(const Duration(days: 30)),
                lastDate: DateTime.now(),
              );
              if (d != null) setState(() => _disputeDate = d);
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
                    _disputeDate != null
                        ? DateFormat('d MMMM yyyy').format(_disputeDate!)
                        : s.disputeSelectDate,
                    style: TextStyle(
                      color: _disputeDate != null
                          ? Colors.black
                          : Colors.grey.shade600,
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          Text(
            s.disputeIssueTypeLabel,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: _disputeType,
            decoration: const InputDecoration(border: OutlineInputBorder()),
            items: disputeTypes.entries
                .map(
                  (e) => DropdownMenuItem(value: e.key, child: Text(e.value)),
                )
                .toList(),
            onChanged: (v) => setState(() => _disputeType = v!),
          ),
          const SizedBox(height: 16),
          Text(
            s.disputeDescriptionLabel,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _descriptionCtrl,
            decoration: InputDecoration(
              hintText: s.disputeDescriptionHint,
              border: const OutlineInputBorder(),
            ),
            maxLines: 4,
          ),
          const SizedBox(height: 16),
          Text(
            s.disputeCorrectTimes,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 4),
          Text(
            s.disputeCorrectTimesHint,
            style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: _timePicker(
                  s.disputeCheckIn,
                  _requestedCheckIn,
                  (t) => setState(() => _requestedCheckIn = t),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _timePicker(
                  s.disputeCheckOut,
                  _requestedCheckOut,
                  (t) => setState(() => _requestedCheckOut = t),
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton(
              onPressed: _submitting ? null : _submitDispute,
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
                      s.disputeSubmitButton,
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

  Widget _timePicker(String label, String? value, Function(String?) onPick) {
    return InkWell(
      onTap: () async {
        final base = _disputeDate ?? DateTime.now();
        final t = await showTimePicker(
          context: context,
          initialTime: TimeOfDay.now(),
        );
        if (t != null) {
          final dt = DateTime(
            base.year,
            base.month,
            base.day,
            t.hour,
            t.minute,
          );
          onPick(DateFormat('yyyy-MM-dd HH:mm:ss').format(dt));
        }
      },
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          border: Border.all(color: Colors.grey.shade400),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            const Icon(Icons.access_time, size: 16, color: Colors.grey),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                value != null && value.length >= 16
                    ? value.substring(11, 16)
                    : label,
                style: TextStyle(
                  color: value != null ? Colors.black : Colors.grey.shade600,
                  fontSize: 13,
                ),
              ),
            ),
            if (value != null)
              GestureDetector(
                onTap: () => onPick(null),
                child: const Icon(Icons.clear, size: 14, color: Colors.grey),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildMyDisputesTab() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_myDisputes.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.check_circle_outline,
              size: 48,
              color: Colors.grey.shade400,
            ),
            const SizedBox(height: 8),
            Text(
              AppStrings.of(context).disputeEmpty,
              style: TextStyle(color: Colors.grey.shade600),
            ),
          ],
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(8),
      itemCount: _myDisputes.length,
      itemBuilder: (ctx, i) {
        final d = _myDisputes[i] as Map<String, dynamic>;
        final status = d['status'] as String? ?? 'pending';
        final statusColor = status == 'approved'
            ? Colors.green
            : status == 'rejected'
            ? Colors.red
            : Colors.orange;

        return Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        d['date'] as String? ?? '',
                        style: const TextStyle(fontWeight: FontWeight.bold),
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 3,
                      ),
                      decoration: BoxDecoration(
                        color: statusColor.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: statusColor),
                      ),
                      child: Text(
                        status.toUpperCase(),
                        style: TextStyle(
                          fontSize: 10,
                          color: statusColor,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  (d['dispute_type'] as String? ?? '')
                      .replaceAll('_', ' ')
                      .toUpperCase(),
                  style: TextStyle(
                    fontSize: 11,
                    color: Colors.grey.shade600,
                    letterSpacing: 0.5,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  d['description'] as String? ?? '',
                  style: const TextStyle(fontSize: 13),
                ),
                if (d['reviewer_comment'] != null) ...[
                  const SizedBox(height: 6),
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: statusColor.withValues(alpha: 0.08),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      'HR: ${d['reviewer_comment']}',
                      style: TextStyle(
                        fontSize: 12,
                        color: statusColor.withValues(alpha: 0.8),
                        fontStyle: FontStyle.italic,
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}
