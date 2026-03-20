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
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadBalance();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadBalance() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final staffId = await ApiConfig.getStaffId();
      if (staffId != null) {
        final balance = await StaffApiService.getLeaveBalance(staffId);
        if (mounted) setState(() => _leaveBalance = balance);
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Leave Management',
      currentIndex: 2,
      showBottomNav: true,
      body: Column(
        children: [
          // Balance card
          if (_leaveBalance != null) _buildBalanceCard(),

          // Tabs
          Container(
            color: Colors.white,
            child: TabBar(
              controller: _tabController,
              labelColor: AppTheme.primaryBlue,
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: AppTheme.primaryBlue,
              tabs: const [
                Tab(text: 'Apply Leave'),
                Tab(text: 'History'),
              ],
            ),
          ),

          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _ApplyLeaveTab(onApplied: _loadBalance),
                _LeaveHistoryTab(leaveBalance: _leaveBalance),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildBalanceCard() {
    final balances = _leaveBalance?['balances'] as List? ??
        _leaveBalance?['leaveBalances'] as List? ??
        [];

    return Container(
      color: AppTheme.primaryBlue,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Leave Balance',
              style: TextStyle(color: Colors.white70, fontSize: 12)),
          const SizedBox(height: 8),
          if (balances.isEmpty)
            const Text('No balance info available',
                style: TextStyle(color: Colors.white60))
          else
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: balances.map<Widget>((b) {
                  final type = b['leave_type'] ?? b['type'] ?? '—';
                  final remaining = b['remaining'] ?? b['balance'] ?? 0;
                  final total = b['total'] ?? b['allocated'] ?? 0;
                  return Container(
                    margin: const EdgeInsets.only(right: 10),
                    padding:
                        const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                    decoration: BoxDecoration(
                      color: Colors.white.withOpacity(0.15),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Column(
                      children: [
                        Text(
                          '$remaining/$total',
                          style: const TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.bold,
                              fontSize: 16),
                        ),
                        Text(
                          type.toString().replaceAll('_', ' '),
                          style: const TextStyle(
                              color: Colors.white70, fontSize: 11),
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
}

class _ApplyLeaveTab extends StatefulWidget {
  final VoidCallback onApplied;
  const _ApplyLeaveTab({required this.onApplied});

  @override
  State<_ApplyLeaveTab> createState() => _ApplyLeaveTabState();
}

class _ApplyLeaveTabState extends State<_ApplyLeaveTab> {
  final _formKey = GlobalKey<FormState>();
  String? _leaveType;
  DateTime? _startDate;
  DateTime? _endDate;
  final _reasonCtrl = TextEditingController();
  final _emergencyCtrl = TextEditingController();
  bool _submitting = false;

  static const _leaveTypes = [
    'CASUAL_LEAVE',
    'SICK_LEAVE',
    'ANNUAL_LEAVE',
    'MATERNITY_LEAVE',
    'PATERNITY_LEAVE',
    'UNPAID_LEAVE',
    'EMERGENCY_LEAVE',
  ];

  @override
  void dispose() {
    _reasonCtrl.dispose();
    _emergencyCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickDate(bool isStart) async {
    final picked = await showDatePicker(
      context: context,
      initialDate: DateTime.now().add(const Duration(days: 1)),
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 365)),
    );
    if (picked != null) {
      setState(() {
        if (isStart) {
          _startDate = picked;
          if (_endDate != null && _endDate!.isBefore(picked)) _endDate = null;
        } else {
          _endDate = picked;
        }
      });
    }
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    if (_startDate == null || _endDate == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content: Text('Please select start and end dates'),
            backgroundColor: AppTheme.warningAmber),
      );
      return;
    }

    setState(() => _submitting = true);
    try {
      final staffId = await ApiConfig.getStaffId();
      if (staffId == null) throw Exception('Staff ID not found');

      await StaffApiService.applyLeave(
        staffId: staffId,
        leaveType: _leaveType!,
        startDate: DateFormat('yyyy-MM-dd').format(_startDate!),
        endDate: DateFormat('yyyy-MM-dd').format(_endDate!),
        reason: _reasonCtrl.text.trim(),
        emergencyContact: _emergencyCtrl.text.trim().isEmpty
            ? null
            : _emergencyCtrl.text.trim(),
      );

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('✅ Leave application submitted successfully'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _formKey.currentState!.reset();
        setState(() {
          _leaveType = null;
          _startDate = null;
          _endDate = null;
        });
        widget.onApplied();
      }
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: AppTheme.errorRed,
        ),
      );
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 8),

            // Leave type
            DropdownButtonFormField<String>(
              value: _leaveType,
              decoration: const InputDecoration(
                labelText: 'Leave Type',
                prefixIcon: Icon(Icons.category_outlined),
              ),
              items: _leaveTypes
                  .map((t) => DropdownMenuItem(
                        value: t,
                        child: Text(t.replaceAll('_', ' ')),
                      ))
                  .toList(),
              onChanged: (v) => setState(() => _leaveType = v),
              validator: (v) => v == null ? 'Select leave type' : null,
            ),
            const SizedBox(height: 16),

            // Date pickers
            Row(
              children: [
                Expanded(
                  child: _DateField(
                    label: 'Start Date',
                    date: _startDate,
                    onTap: () => _pickDate(true),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _DateField(
                    label: 'End Date',
                    date: _endDate,
                    onTap: () => _pickDate(false),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),

            // Duration display
            if (_startDate != null && _endDate != null)
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppTheme.primaryBlue.withOpacity(0.05),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                      color: AppTheme.primaryBlue.withOpacity(0.2)),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.info_outline,
                        color: AppTheme.primaryBlue, size: 16),
                    const SizedBox(width: 8),
                    Text(
                      '${_endDate!.difference(_startDate!).inDays + 1} day(s) leave',
                      style: const TextStyle(
                          color: AppTheme.primaryBlue,
                          fontWeight: FontWeight.w500),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: 16),

            TextFormField(
              controller: _reasonCtrl,
              decoration: const InputDecoration(
                labelText: 'Reason',
                hintText: 'Describe the reason for leave...',
                prefixIcon: Icon(Icons.description_outlined),
                alignLabelWithHint: true,
              ),
              maxLines: 3,
              validator: (v) =>
                  (v == null || v.trim().isEmpty) ? 'Reason is required' : null,
            ),
            const SizedBox(height: 16),

            TextFormField(
              controller: _emergencyCtrl,
              decoration: const InputDecoration(
                labelText: 'Emergency Contact (optional)',
                hintText: 'Phone number or name',
                prefixIcon: Icon(Icons.contact_phone_outlined),
              ),
              keyboardType: TextInputType.phone,
            ),
            const SizedBox(height: 24),

            ElevatedButton.icon(
              onPressed: _submitting ? null : _submit,
              icon: _submitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                          color: Colors.white, strokeWidth: 2))
                  : const Icon(Icons.send, color: Colors.white),
              label: Text(_submitting ? 'Submitting...' : 'Apply for Leave'),
            ),
          ],
        ),
      ),
    );
  }
}

class _DateField extends StatelessWidget {
  final String label;
  final DateTime? date;
  final VoidCallback onTap;

  const _DateField(
      {required this.label, required this.date, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: const Color(0xFFB0BEC5)),
        ),
        child: Row(
          children: [
            const Icon(Icons.calendar_today_outlined,
                size: 16, color: AppTheme.textSecondary),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                date != null
                    ? DateFormat('d MMM yyyy').format(date!)
                    : label,
                style: TextStyle(
                  color: date != null
                      ? AppTheme.textPrimary
                      : AppTheme.textSecondary,
                  fontSize: 13,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LeaveHistoryTab extends StatelessWidget {
  final Map<String, dynamic>? leaveBalance;

  const _LeaveHistoryTab({this.leaveBalance});

  @override
  Widget build(BuildContext context) {
    final history = leaveBalance?['history'] as List? ??
        leaveBalance?['applications'] as List? ??
        [];

    if (history.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.event_note, size: 48, color: AppTheme.textSecondary),
            SizedBox(height: 12),
            Text('No leave history found',
                style: TextStyle(color: AppTheme.textSecondary)),
          ],
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: history.length,
      itemBuilder: (context, i) {
        final item = history[i];
        final type =
            item['leave_type']?.toString().replaceAll('_', ' ') ?? '—';
        final status = item['status']?.toString() ?? 'PENDING';
        final startDate = item['start_date']?.toString() ?? '';
        final endDate = item['end_date']?.toString() ?? '';
        final reason = item['reason']?.toString() ?? '';

        final statusColor = switch (status.toUpperCase()) {
          'APPROVED' => AppTheme.successGreen,
          'REJECTED' => AppTheme.errorRed,
          _ => AppTheme.warningAmber,
        };

        return Card(
          margin: const EdgeInsets.only(bottom: 8),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(type,
                        style: const TextStyle(
                            fontWeight: FontWeight.bold,
                            color: AppTheme.textPrimary)),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: statusColor.withOpacity(0.1),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(
                        status,
                        style: TextStyle(
                            color: statusColor,
                            fontSize: 12,
                            fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text('$startDate → $endDate',
                    style: const TextStyle(
                        color: AppTheme.textSecondary, fontSize: 12)),
                if (reason.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(reason,
                        style: const TextStyle(
                            color: AppTheme.textSecondary, fontSize: 12)),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}
