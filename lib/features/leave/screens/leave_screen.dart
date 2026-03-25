import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/config/api_config.dart';
import '../../../core/services/staff_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

class LeaveScreen extends StatefulWidget {
  const LeaveScreen({super.key});

  @override
  State<LeaveScreen> createState() => _LeaveScreenState();
}

class _LeaveScreenState extends State<LeaveScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  Map<String, dynamic>? _leaveBalance;
  List<dynamic> _myLeaves = [];
  List<dynamic> _replacementRequests = [];
  bool _loading = true;
  String? _error;

  // Apply form state
  String _leaveType = 'annual';
  DateTime? _startDate;
  DateTime? _endDate;
  final _reasonCtrl = TextEditingController();
  List<dynamic> _staffList = [];
  String? _selectedReplacementId;
  String? _selectedReplacementName;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _loadAll();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _reasonCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadAll() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final staffId = await ApiConfig.getStaffId();
      if (staffId == null) {
        setState(() {
          _error = 'Staff ID not found';
          _loading = false;
        });
        return;
      }

      final results = await Future.wait([
        StaffApiService.getLeaveBalance(staffId)
            .catchError((_) => <String, dynamic>{}),
        StaffApiService.getMyLeaves(staffId)
            .catchError((_) => <String, dynamic>{'leaves': []}),
        StaffApiService.getReplacementRequests()
            .catchError((_) => <dynamic>[]),
        StaffApiService.getStaffList().catchError((_) => <dynamic>[]),
      ]);

      if (mounted) {
        setState(() {
          _leaveBalance = results[0] as Map<String, dynamic>?;
          final leavesResult = results[1] as Map<String, dynamic>;
          _myLeaves = leavesResult['leaves'] as List? ??
              leavesResult['data'] as List? ??
              leavesResult['applications'] as List? ??
              leavesResult['history'] as List? ??
              [];
          _replacementRequests = results[2] as List<dynamic>;
          _staffList = results[3] as List<dynamic>;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString().replaceFirst('Exception: ', '');
          _loading = false;
        });
      }
    }
  }

  Future<void> _submitLeave() async {
    if (_startDate == null || _endDate == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Please select dates'),
        backgroundColor: Colors.red,
      ));
      return;
    }
    if (_reasonCtrl.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Please provide a reason'),
        backgroundColor: Colors.red,
      ));
      return;
    }

    setState(() => _submitting = true);
    try {
      final staffId = await ApiConfig.getStaffId();
      await StaffApiService.applyForLeaveWithReplacement(
        staffId: staffId!,
        leaveType: _leaveType,
        startDate: DateFormat('yyyy-MM-dd').format(_startDate!),
        endDate: DateFormat('yyyy-MM-dd').format(_endDate!),
        reason: _reasonCtrl.text.trim(),
        replacementStaffId: _selectedReplacementId,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('✅ Leave application submitted'),
          backgroundColor: Colors.green,
        ));
        _reasonCtrl.clear();
        setState(() {
          _startDate = null;
          _endDate = null;
          _selectedReplacementId = null;
          _selectedReplacementName = null;
        });
        _tabController.animateTo(1);
        _loadAll();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: Colors.red,
        ));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Leave Management',
      showBottomNav: false,
      body: Column(
        children: [
          if (_leaveBalance != null) _buildBalanceCard(),
          TabBar(
            controller: _tabController,
            labelColor: AppTheme.primaryColor,
            indicatorColor: AppTheme.primaryColor,
            tabs: [
              const Tab(text: 'Apply'),
              Tab(text: 'My Leaves (${_myLeaves.length})'),
              Tab(text: 'Requests (${_replacementRequests.length})'),
            ],
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : TabBarView(
                    controller: _tabController,
                    children: [
                      _buildApplyTab(),
                      _buildMyLeavesTab(),
                      _buildReplacementRequestsTab(),
                    ],
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildBalanceCard() {
    final balance = _leaveBalance ?? {};
    // Support both nested balances list and flat keys
    final balances =
        balance['balances'] as List? ?? balance['leaveBalances'] as List? ?? [];

    if (balances.isNotEmpty) {
      return Container(
        color: AppTheme.primaryColor,
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Leave Balance',
                style: TextStyle(color: Colors.white70, fontSize: 12)),
            const SizedBox(height: 8),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: balances.map<Widget>((b) {
                  final type = b['leave_type'] ?? b['type'] ?? '—';
                  final remaining = b['remaining'] ?? b['balance'] ?? 0;
                  final total = b['total'] ?? b['allocated'] ?? 0;
                  return Container(
                    margin: const EdgeInsets.only(right: 10),
                    padding: const EdgeInsets.symmetric(
                        horizontal: 14, vertical: 8),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Column(
                      children: [
                        Text('$remaining/$total',
                            style: const TextStyle(
                                color: Colors.white,
                                fontWeight: FontWeight.bold,
                                fontSize: 16)),
                        Text(type.toString().replaceAll('_', ' '),
                            style: const TextStyle(
                                color: Colors.white70, fontSize: 11)),
                      ],
                    ),
                  );
                }).toList(),
              ),
            ),
          ],
        ),
      );
    }

    // Flat format
    return Container(
      padding: const EdgeInsets.all(12),
      color: AppTheme.primaryColor.withValues(alpha: 0.1),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _balanceItem(
              'Annual', balance['annual'] ?? balance['annual_leave'] ?? '-'),
          _balanceItem('Sick', balance['sick'] ?? balance['sick_leave'] ?? '-'),
          _balanceItem(
              'Casual', balance['casual'] ?? balance['casual_leave'] ?? '-'),
          _balanceItem('Used', balance['used'] ?? '-'),
        ],
      ),
    );
  }

  Widget _balanceItem(String label, dynamic value) {
    return Column(children: [
      Text('$value',
          style: const TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.bold,
              color: Color(0xFF007A64))),
      Text(label,
          style: const TextStyle(fontSize: 11, color: Colors.grey)),
    ]);
  }

  Widget _buildApplyTab() {
    final leaveTypes = [
      'annual',
      'sick',
      'casual',
      'emergency',
      'maternity',
      'paternity',
      'unpaid',
    ];
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Leave type
          const Text('Leave Type',
              style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            value: _leaveType,
            decoration: const InputDecoration(border: OutlineInputBorder()),
            items: leaveTypes
                .map((t) => DropdownMenuItem(
                    value: t,
                    child: Text(t[0].toUpperCase() + t.substring(1))))
                .toList(),
            onChanged: (v) => setState(() => _leaveType = v!),
          ),
          const SizedBox(height: 16),

          // Date range
          const Text('Dates',
              style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                  child: _datePicker('Start Date', _startDate,
                      (d) => setState(() => _startDate = d))),
              const SizedBox(width: 12),
              Expanded(
                  child: _datePicker('End Date', _endDate,
                      (d) => setState(() => _endDate = d))),
            ],
          ),
          if (_startDate != null && _endDate != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                '${_endDate!.difference(_startDate!).inDays + 1} day(s)',
                style: TextStyle(color: AppTheme.primaryColor, fontSize: 12),
              ),
            ),
          const SizedBox(height: 16),

          // Reason
          const Text('Reason',
              style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          TextField(
            controller: _reasonCtrl,
            decoration: const InputDecoration(
                hintText: 'Brief reason for leave',
                border: OutlineInputBorder()),
            maxLines: 3,
          ),
          const SizedBox(height: 16),

          // Replacement staff
          const Text('Replacement Staff (Optional)',
              style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Text('Select a colleague to cover for you',
              style:
                  TextStyle(fontSize: 12, color: Colors.grey.shade600)),
          const SizedBox(height: 8),
          InkWell(
            onTap: () => _showStaffPicker(),
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                  border: Border.all(color: Colors.grey.shade400),
                  borderRadius: BorderRadius.circular(8)),
              child: Row(
                children: [
                  const Icon(Icons.person_add_outlined,
                      size: 18, color: Colors.grey),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _selectedReplacementName ??
                          'Tap to select replacement',
                      style: TextStyle(
                          color: _selectedReplacementName != null
                              ? Colors.black
                              : Colors.grey.shade600),
                    ),
                  ),
                  if (_selectedReplacementName != null)
                    GestureDetector(
                      onTap: () => setState(() {
                        _selectedReplacementId = null;
                        _selectedReplacementName = null;
                      }),
                      child: const Icon(Icons.clear,
                          size: 16, color: Colors.grey),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 24),

          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton(
              onPressed: _submitting ? null : _submitLeave,
              style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.primaryColor,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12))),
              child: _submitting
                  ? const CircularProgressIndicator(
                      color: Colors.white, strokeWidth: 2)
                  : const Text('Submit Leave Application',
                      style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                          color: Colors.white)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _datePicker(
      String label, DateTime? date, Function(DateTime) onPick) {
    return InkWell(
      onTap: () async {
        final picked = await showDatePicker(
          context: context,
          initialDate: date ?? DateTime.now(),
          firstDate: DateTime.now(),
          lastDate: DateTime.now().add(const Duration(days: 365)),
        );
        if (picked != null) onPick(picked);
      },
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
            border: Border.all(color: Colors.grey.shade400),
            borderRadius: BorderRadius.circular(8)),
        child: Row(
          children: [
            const Icon(Icons.calendar_today,
                size: 16, color: Colors.grey),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                date != null
                    ? DateFormat('d MMM').format(date)
                    : label,
                style: TextStyle(
                    color: date != null
                        ? Colors.black
                        : Colors.grey.shade600,
                    fontSize: 13),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showStaffPicker() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Select Replacement Staff'),
        content: SizedBox(
          width: double.maxFinite,
          height: 300,
          child: _staffList.isEmpty
              ? const Center(child: Text('No staff available'))
              : ListView.builder(
                  itemCount: _staffList.length,
                  itemBuilder: (c, i) {
                    final staff =
                        _staffList[i] as Map<String, dynamic>;
                    final name = staff['name'] as String? ??
                        staff['full_name'] as String? ??
                        'Unknown';
                    final id =
                        (staff['id'] ?? staff['user_id']).toString();
                    return ListTile(
                      leading:
                          CircleAvatar(child: Text(name[0].toUpperCase())),
                      title: Text(name),
                      subtitle:
                          Text(staff['department'] as String? ?? ''),
                      onTap: () {
                        setState(() {
                          _selectedReplacementId = id;
                          _selectedReplacementName = name;
                        });
                        Navigator.pop(ctx);
                      },
                    );
                  },
                ),
        ),
      ),
    );
  }

  Widget _buildMyLeavesTab() {
    if (_myLeaves.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.event_note, size: 48, color: Colors.grey.shade400),
            const SizedBox(height: 12),
            Text('No leave applications',
                style: TextStyle(color: Colors.grey.shade600)),
          ],
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.all(8),
      itemCount: _myLeaves.length,
      itemBuilder: (ctx, i) {
        final leave = _myLeaves[i] as Map<String, dynamic>;
        final status = leave['status'] as String? ?? 'pending';
        final statusColor = status == 'approved'
            ? Colors.green
            : status == 'rejected'
                ? Colors.red
                : Colors.orange;
        final leaveType =
            (leave['leave_type'] ?? leave['type'] ?? 'Leave').toString();
        return Card(
          child: ListTile(
            title: Text(
                '${leaveType.toUpperCase().replaceAll('_', ' ')} LEAVE'),
            subtitle: Text(
              '${leave['start_date'] ?? ''} to ${leave['end_date'] ?? ''}'
              '${leave['reason'] != null ? '\n${leave['reason']}' : ''}',
            ),
            isThreeLine: leave['reason'] != null,
            trailing: Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: statusColor)),
              child: Text(status.toUpperCase(),
                  style: TextStyle(
                      color: statusColor,
                      fontSize: 11,
                      fontWeight: FontWeight.bold)),
            ),
          ),
        );
      },
    );
  }

  Widget _buildReplacementRequestsTab() {
    if (_replacementRequests.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.swap_horiz, size: 48, color: Colors.grey.shade400),
            const SizedBox(height: 8),
            Text('No pending replacement requests',
                style: TextStyle(color: Colors.grey.shade600)),
          ],
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(8),
      itemCount: _replacementRequests.length,
      itemBuilder: (ctx, i) {
        final req = _replacementRequests[i] as Map<String, dynamic>;
        final requesterName =
            req['requester_name'] as String? ?? 'Unknown';
        final dates = req['dates'] as String? ?? '';
        final status = req['status'] as String? ?? 'pending';
        final isPending = status == 'pending';

        return Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  const Icon(Icons.person, size: 16),
                  const SizedBox(width: 4),
                  Text(requesterName,
                      style:
                          const TextStyle(fontWeight: FontWeight.bold)),
                  const Spacer(),
                  if (!isPending)
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                          color: status == 'accepted'
                              ? Colors.green.shade100
                              : Colors.red.shade100,
                          borderRadius: BorderRadius.circular(8)),
                      child: Text(
                        status.toUpperCase(),
                        style: TextStyle(
                            fontSize: 10,
                            color: status == 'accepted'
                                ? Colors.green.shade700
                                : Colors.red.shade700,
                            fontWeight: FontWeight.bold),
                      ),
                    ),
                ]),
                const SizedBox(height: 4),
                Text('Requesting coverage for: $dates',
                    style: TextStyle(
                        fontSize: 12, color: Colors.grey.shade600)),
                if (req['requester_message'] != null) ...[
                  const SizedBox(height: 4),
                  Text('"${req['requester_message']}"',
                      style: const TextStyle(
                          fontStyle: FontStyle.italic, fontSize: 12)),
                ],
                if (isPending) ...[
                  const SizedBox(height: 12),
                  Row(children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => _respondToReplacement(
                            req['id'].toString(), 'declined'),
                        style: OutlinedButton.styleFrom(
                            foregroundColor: Colors.red,
                            side:
                                const BorderSide(color: Colors.red)),
                        child: const Text('Decline'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: ElevatedButton(
                        onPressed: () => _respondToReplacement(
                            req['id'].toString(), 'accepted'),
                        style: ElevatedButton.styleFrom(
                            backgroundColor: AppTheme.primaryColor),
                        child: const Text('Accept',
                            style: TextStyle(color: Colors.white)),
                      ),
                    ),
                  ]),
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _respondToReplacement(
      String requestId, String status) async {
    try {
      await StaffApiService.respondToReplacement(
          requestId: requestId, status: status);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(status == 'accepted'
              ? '✅ Request accepted'
              : '❌ Request declined'),
          backgroundColor:
              status == 'accepted' ? Colors.green : Colors.red,
        ));
        _loadAll();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content:
              Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: Colors.red,
        ));
      }
    }
  }
}
