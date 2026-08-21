import 'dart:async';

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/config/api_config.dart';
import '../../../core/services/leave_api_service.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/api_error_messages.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/success_toast.dart';
import '../../../l10n/app_strings.dart';
import '../../attendance/screens/overtime_screen.dart';
import '../../attendance/screens/dispute_screen.dart';

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
  // ignore: unused_field
  String? _error;
  String _searchQuery = '';

  List<dynamic> get _filteredMyLeaves {
    final q = _searchQuery.trim().toLowerCase();
    if (q.isEmpty) return _myLeaves;
    return _myLeaves.where((l) {
      final m = l as Map<String, dynamic>;
      final type = (m['leave_type']?.toString() ?? m['type']?.toString() ?? '')
          .toLowerCase();
      final status = (m['status']?.toString() ?? '').toLowerCase();
      return type.contains(q) || status.contains(q);
    }).toList();
  }

  // Apply form state
  String _leaveType = 'annual';
  DateTime? _startDate;
  DateTime? _endDate;
  final _reasonCtrl = TextEditingController();
  List<dynamic> _staffList = [];
  String? _selectedReplacementId;
  String? _selectedReplacementName;
  bool _submitting = false;
  String? _applyValidationError;

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
        LeaveApiService.getLeaveBalance(staffId)
            .catchError((_) => <String, dynamic>{}),
        LeaveApiService.getMyLeaves(staffId)
            .catchError((_) => <String, dynamic>{'leaves': []}),
        LeaveApiService.getReplacementRequests().catchError((_) => <dynamic>[]),
        HrApiService.getStaffList().catchError((_) => <dynamic>[]),
      ]);

      if (mounted) {
        setState(() {
          _leaveBalance = results[0] as Map<String, dynamic>?;
          final leavesResult = results[1] as Map<String, dynamic>;
          _myLeaves =
              leavesResult['leaves'] as List? ??
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
          _error = localizedApiErrorFromRaw(AppStrings.of(context), e);
          _loading = false;
        });
      }
    }
  }

  Future<void> _submitLeave() async {
    if (_submitting) return;
    final s = AppStrings.of(context);
    if (_startDate == null || _endDate == null) {
      setState(() => _applyValidationError = s.leaveSelectDatesError);
      return;
    }
    if (_reasonCtrl.text.trim().isEmpty) {
      setState(() => _applyValidationError = s.leaveProvideReasonError);
      return;
    }

    setState(() {
      _submitting = true;
      _applyValidationError = null;
    });
    try {
      final staffId = await ApiConfig.getStaffId();
      await LeaveApiService.applyForLeaveWithReplacement(
        staffId: staffId!,
        leaveType: _leaveType,
        startDate: DateFormat('yyyy-MM-dd').format(_startDate!),
        endDate: DateFormat('yyyy-MM-dd').format(_endDate!),
        reason: _reasonCtrl.text.trim(),
        replacementStaffId: _selectedReplacementId,
      );
      if (mounted) {
        SuccessToast.show(context, AppStrings.of(context).leaveSubmitted);
        _reasonCtrl.clear();
        setState(() {
          _startDate = null;
          _endDate = null;
          _selectedReplacementId = null;
          _selectedReplacementName = null;
        });
        _tabController.animateTo(1);
        unawaited(_loadAll());
      }
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, e.toString());
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  void _submitLeaveWhenNewline(String value) {
    if (!value.contains('\n')) return;
    final cleaned = value.replaceAll(RegExp(r'\s*\n\s*'), ' ');
    _reasonCtrl.value = TextEditingValue(
      text: cleaned,
      selection: TextSelection.collapsed(offset: cleaned.length),
    );
    _submitLeave();
  }

  void _clearApplyValidationError() {
    if (_applyValidationError == null) return;
    setState(() => _applyValidationError = null);
  }

  void _onReasonChanged(String value) {
    _clearApplyValidationError();
    _submitLeaveWhenNewline(value);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.leaveTitle,
      showBottomNav: false,
      body: Column(
        children: [
          if (_leaveBalance != null) _buildBalanceCard(),
          TabBar(
            controller: _tabController,
            labelColor: AppTheme.primaryBlue,
            indicatorColor: AppTheme.primaryBlue,
            tabs: [
              Tab(text: s.leaveTabApply),
              Tab(text: '${s.leaveTabMyLeaves} (${_myLeaves.length})'),
              Tab(
                text: '${s.leaveTabRequests} (${_replacementRequests.length})',
              ),
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
    final s = AppStrings.of(context);
    final balance = _leaveBalance ?? {};
    // Support both nested balances list and flat keys
    final balances =
        balance['balances'] as List? ?? balance['leaveBalances'] as List? ?? [];

    if (balances.isNotEmpty) {
      return Container(
        color: AppTheme.primaryBlue,
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.leaveBalanceHeader,
              style: const TextStyle(color: Colors.white70, fontSize: 12),
            ),
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
                      horizontal: 14,
                      vertical: 8,
                    ),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Column(
                      children: [
                        Text(
                          '$remaining/$total',
                          style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.bold,
                            fontSize: 16,
                          ),
                        ),
                        Text(
                          type.toString().replaceAll('_', ' '),
                          style: const TextStyle(
                            color: Colors.white70,
                            fontSize: 11,
                          ),
                        ),
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
      color: AppTheme.primaryBlue.withValues(alpha: 0.1),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _balanceItem(
            s.leaveTypeAnnual,
            balance['annual'] ?? balance['annual_leave'] ?? '-',
          ),
          _balanceItem(
            s.leaveTypeSick,
            balance['sick'] ?? balance['sick_leave'] ?? '-',
          ),
          _balanceItem(
            s.leaveTypeCasual,
            balance['casual'] ?? balance['casual_leave'] ?? '-',
          ),
          _balanceItem(s.leaveBalanceUsed, balance['used'] ?? '-'),
        ],
      ),
    );
  }

  Widget _balanceItem(String label, dynamic value) {
    return Column(
      children: [
        Text(
          '$value',
          style: const TextStyle(
            fontSize: 20,
            fontWeight: FontWeight.bold,
            color: Color(0xFF007A64),
          ),
        ),
        Text(label, style: const TextStyle(fontSize: 11, color: Colors.grey)),
      ],
    );
  }

  Widget _buildApplyTab() {
    final s = AppStrings.of(context);
    final validationError = _applyValidationError;
    final leaveTypes = <_LeaveTypeOption>[
      _LeaveTypeOption('annual', s.leaveTypeAnnual),
      _LeaveTypeOption('sick', s.leaveTypeSick),
      _LeaveTypeOption('casual', s.leaveTypeCasual),
      _LeaveTypeOption('emergency', s.leaveTypeEmergency),
      _LeaveTypeOption('maternity', s.leaveTypeMaternity),
      _LeaveTypeOption('paternity', s.leaveTypePaternity),
      _LeaveTypeOption('unpaid', s.leaveTypeUnpaid),
    ];
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: FocusTraversalGroup(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Leave type
            Text(
              s.leaveLeaveTypeLabel,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              initialValue: _leaveType,
              decoration: const InputDecoration(border: OutlineInputBorder()),
              items: leaveTypes
                  .map(
                    (t) =>
                        DropdownMenuItem(value: t.code, child: Text(t.label)),
                  )
                  .toList(),
              onChanged: (v) => setState(() => _leaveType = v!),
            ),
            const SizedBox(height: 16),

            // Date range
            Text(
              s.leaveDatesLabel,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: _datePicker(
                    s.leaveStartDate,
                    _startDate,
                    (d) => setState(() {
                      _startDate = d;
                      _applyValidationError = null;
                    }),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _datePicker(
                    s.leaveEndDate,
                    _endDate,
                    (d) => setState(() {
                      _endDate = d;
                      _applyValidationError = null;
                    }),
                  ),
                ),
              ],
            ),
            if (validationError == s.leaveSelectDatesError)
              _inlineFormError(validationError!),
            if (_startDate != null && _endDate != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  s.leaveDayCount(_endDate!.difference(_startDate!).inDays + 1),
                  style: const TextStyle(
                    color: AppTheme.primaryBlue,
                    fontSize: 12,
                  ),
                ),
              ),
            const SizedBox(height: 16),

            // Reason
            Text(
              s.leaveReasonLabel,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _reasonCtrl,
              keyboardType: TextInputType.text,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _submitLeave(),
              onChanged: _onReasonChanged,
              decoration: InputDecoration(
                hintText: s.leaveReasonHint,
                border: const OutlineInputBorder(),
              ),
              maxLines: 3,
            ),
            if (validationError == s.leaveProvideReasonError)
              _inlineFormError(validationError!),
            const SizedBox(height: 16),

            // Replacement staff
            Text(
              s.leaveReplacementStaffLabel,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 4),
            Text(
              s.leaveReplacementStaffHint,
              style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
            ),
            const SizedBox(height: 8),
            InkWell(
              onTap: () => _showStaffPicker(),
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.grey.shade400),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  children: [
                    const Icon(
                      Icons.person_add_outlined,
                      size: 18,
                      color: Colors.grey,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _selectedReplacementName ?? s.leaveReplacementStaffPick,
                        style: TextStyle(
                          color: _selectedReplacementName != null
                              ? Colors.black
                              : Colors.grey.shade600,
                        ),
                      ),
                    ),
                    if (_selectedReplacementName != null)
                      GestureDetector(
                        onTap: () => setState(() {
                          _selectedReplacementId = null;
                          _selectedReplacementName = null;
                        }),
                        child: const Icon(
                          Icons.clear,
                          size: 16,
                          color: Colors.grey,
                        ),
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
                  backgroundColor: AppTheme.primaryBlue,
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
                        s.leaveSubmitButton,
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                          color: Colors.white,
                        ),
                      ),
              ),
            ),
            const SizedBox(height: 12),
            Card(
              child: ListTile(
                leading: const Icon(
                  Icons.timer_outlined,
                  color: Color(0xFF007A64),
                ),
                title: Text(
                  s.leaveOvertimeTitle,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
                subtitle: Text(s.leaveOvertimeSubtitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute(builder: (_) => const OvertimeScreen()),
                ),
              ),
            ),
            Card(
              child: ListTile(
                leading: const Icon(
                  Icons.report_problem_outlined,
                  color: Colors.orange,
                ),
                title: Text(
                  s.leaveDisputeTitle,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
                subtitle: Text(s.leaveDisputeSubtitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute(builder: (_) => const DisputeScreen()),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _datePicker(String label, DateTime? date, Function(DateTime) onPick) {
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
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            const Icon(Icons.calendar_today, size: 16, color: Colors.grey),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                date != null ? DateFormat('d MMM').format(date) : label,
                style: TextStyle(
                  color: date != null ? Colors.black : Colors.grey.shade600,
                  fontSize: 13,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _inlineFormError(String message) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.error_outline, size: 16, color: AppTheme.errorRed),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(color: AppTheme.errorRed, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }

  void _showStaffPicker() {
    final s = AppStrings.of(context);
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.leaveSelectReplacement),
        content: SizedBox(
          width: double.maxFinite,
          height: 300,
          child: _staffList.isEmpty
              ? Center(child: Text(s.leaveNoStaffAvailable))
              : ListView.builder(
                  itemCount: _staffList.length,
                  itemBuilder: (c, i) {
                    final staff = _staffList[i] as Map<String, dynamic>;
                    final name =
                        staff['name'] as String? ??
                        staff['full_name'] as String? ??
                        'Unknown';
                    final id = (staff['id'] ?? staff['user_id']).toString();
                    return ListTile(
                      leading: CircleAvatar(child: Text(name[0].toUpperCase())),
                      title: Text(name),
                      subtitle: Text(staff['department'] as String? ?? ''),
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
    final s = AppStrings.of(context);
    final filtered = _filteredMyLeaves;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: TextField(
            decoration: InputDecoration(
              hintText: s.leaveSearchByTypeHint,
              prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              filled: true,
              fillColor: AppTheme.surfaceWhite,
            ),
            onChanged: (v) => setState(() => _searchQuery = v),
          ),
        ),
        Expanded(
          child: filtered.isEmpty
              ? Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.event_note,
                        size: 48,
                        color: Colors.grey.shade400,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        _searchQuery.trim().isEmpty
                            ? s.leaveNoApplications
                            : s.noMatchesFor(_searchQuery),
                        style: TextStyle(color: Colors.grey.shade600),
                      ),
                    ],
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.all(8),
                  itemCount: filtered.length,
                  itemBuilder: (ctx, i) {
                    final leave = filtered[i] as Map<String, dynamic>;
                    final status = (leave['status'] as String? ?? 'pending')
                        .toLowerCase();
                    final statusColor = status == 'approved'
                        ? Colors.green
                        : status == 'rejected'
                        ? Colors.red
                        : Colors.orange;
                    final leaveType =
                        (leave['leave_type'] ?? leave['type'] ?? 'Leave')
                            .toString();
                    return Card(
                      child: ListTile(
                        title: Text(
                          '${leaveType.toUpperCase().replaceAll('_', ' ')} LEAVE',
                        ),
                        subtitle: Text(
                          '${leave['start_date'] ?? ''} to ${leave['end_date'] ?? ''}'
                          '${leave['reason'] != null ? '\n${leave['reason']}' : ''}',
                        ),
                        isThreeLine: leave['reason'] != null,
                        trailing: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 4,
                          ),
                          decoration: BoxDecoration(
                            color: statusColor.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: statusColor),
                          ),
                          child: Text(
                            status.toUpperCase(),
                            style: TextStyle(
                              color: statusColor,
                              fontSize: 11,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ),
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }

  String _formatReplacementDates(dynamic rawDates) {
    if (rawDates == null) return '';
    if (rawDates is Map) {
      final start = rawDates['start_date'] ?? rawDates['start'];
      final end = rawDates['end_date'] ?? rawDates['end'];
      if (start != null && end != null) return '$start to $end';
      return rawDates.values.whereType<String>().join(', ');
    }

    final text = rawDates.toString();
    if (text.trim().isEmpty) return '';
    try {
      final decoded = jsonDecode(text);
      if (decoded is Map) {
        final start = decoded['start_date'] ?? decoded['start'];
        final end = decoded['end_date'] ?? decoded['end'];
        if (start != null && end != null) return '$start to $end';
      }
    } catch (_) {
      // Legacy rows may store plain text dates; show those unchanged.
    }
    return text;
  }

  Widget _buildReplacementRequestsTab() {
    final s = AppStrings.of(context);
    if (_replacementRequests.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.swap_horiz, size: 48, color: Colors.grey.shade400),
            const SizedBox(height: 8),
            Text(
              s.leaveNoReplacementRequests,
              style: TextStyle(color: Colors.grey.shade600),
            ),
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
            req['requester_name'] as String? ?? s.leaveRequesterUnknown;
        final dates = _formatReplacementDates(req['dates']);
        final status = (req['status'] as String? ?? 'pending').toLowerCase();
        final isPending = status == 'pending';

        return Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.person, size: 16),
                    const SizedBox(width: 4),
                    Text(
                      requesterName,
                      style: const TextStyle(fontWeight: FontWeight.bold),
                    ),
                    const Spacer(),
                    if (!isPending)
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: status == 'accepted'
                              ? Colors.green.shade100
                              : Colors.red.shade100,
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          status.toUpperCase(),
                          style: TextStyle(
                            fontSize: 10,
                            color: status == 'accepted'
                                ? Colors.green.shade700
                                : Colors.red.shade700,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  '${s.leaveRequestingCoverageFor} $dates',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                ),
                if (req['requester_message'] != null) ...[
                  const SizedBox(height: 4),
                  Text(
                    '"${req['requester_message']}"',
                    style: const TextStyle(
                      fontStyle: FontStyle.italic,
                      fontSize: 12,
                    ),
                  ),
                ],
                if (isPending) ...[
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () => _respondToReplacement(
                            req['id'].toString(),
                            'declined',
                          ),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: Colors.red,
                            side: const BorderSide(color: Colors.red),
                          ),
                          child: Text(s.leaveDeclineAction),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: ElevatedButton(
                          onPressed: () => _respondToReplacement(
                            req['id'].toString(),
                            'accepted',
                          ),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppTheme.primaryBlue,
                          ),
                          child: Text(
                            s.leaveAcceptAction,
                            style: const TextStyle(color: Colors.white),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _respondToReplacement(String requestId, String status) async {
    final s = AppStrings.of(context);
    try {
      await LeaveApiService.respondToReplacement(
        requestId: requestId,
        status: status,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              status == 'accepted'
                  ? s.leaveRequestAccepted
                  : s.leaveRequestDeclined,
            ),
            backgroundColor: status == 'accepted' ? Colors.green : Colors.red,
          ),
        );
        unawaited(_loadAll());
      }
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, e.toString());
      }
    }
  }
}

class _LeaveTypeOption {
  final String code;
  final String label;
  const _LeaveTypeOption(this.code, this.label);
}
