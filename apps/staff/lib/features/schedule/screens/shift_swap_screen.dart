import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

/// Shift-for-shift swaps + on-call roster (backend migration 682).
///
/// One screen, capability-layered:
///  - every roster staff member: propose a swap (own published shift vs a
///    colleague's), answer incoming proposals, watch request status, and see
///    their own on-call stints plus who is on call right now;
///  - department request reviewers additionally get the approval queue;
///  - department roster managers additionally get on-call stint management.
/// Reviewer/manager sections appear when the corresponding department API
/// call succeeds and stay hidden on 403, mirroring backend authority.
class ShiftSwapScreen extends StatefulWidget {
  const ShiftSwapScreen({super.key});

  @override
  State<ShiftSwapScreen> createState() => _ShiftSwapScreenState();
}

class _ShiftSwapScreenState extends State<ShiftSwapScreen> {
  bool _loading = true;
  bool _busy = false;
  String? _myUid;
  String? _department;

  List<Map<String, dynamic>> _myAssignments = [];
  List<Map<String, dynamic>> _candidates = [];
  List<Map<String, dynamic>> _mySwaps = [];
  List<Map<String, dynamic>> _approvals = [];
  bool _isReviewer = false;
  List<Map<String, dynamic>> _myOnCall = [];
  List<Map<String, dynamic>> _onCallNow = [];
  List<Map<String, dynamic>> _departmentOnCall = [];
  bool _isOnCallManager = false;

  int? _selectedMyAssignmentId;
  int? _selectedCandidateAssignmentId;
  final _reasonController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  List<Map<String, dynamic>> _asMapList(dynamic value) {
    if (value is! List) return [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
  }

  String _asText(dynamic value, {String fallback = '-'}) {
    final text = value?.toString().trim();
    return text == null || text.isEmpty ? fallback : text;
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final role = StaffRole.fromString(await ApiConfig.getRole());
    final department = role.rosterDepartment;
    final myUid = (await ApiConfig.getStaffUid())?.toLowerCase();

    final today = DateTime.now();
    final horizon = today.add(const Duration(days: 30));
    String dateText(DateTime d) => DateFormat('yyyy-MM-dd').format(d);

    List<Map<String, dynamic>> myAssignments = [];
    List<Map<String, dynamic>> candidates = [];
    List<Map<String, dynamic>> mySwaps = [];
    List<Map<String, dynamic>> approvals = [];
    var isReviewer = false;
    List<Map<String, dynamic>> myOnCall = [];
    List<Map<String, dynamic>> onCallNow = [];
    List<Map<String, dynamic>> departmentOnCall = [];
    var isOnCallManager = false;

    try {
      myAssignments = _asMapList(
        await HrApiService.getMyRosterAssignments(
          startDate: dateText(today),
          endDate: dateText(horizon),
        ),
      );
    } catch (_) {}
    try {
      candidates = _asMapList(await HrApiService.getShiftSwapCandidates());
    } catch (_) {}
    try {
      mySwaps = _asMapList(await HrApiService.getMyShiftSwaps());
    } catch (_) {}
    if (department != null) {
      try {
        approvals = _asMapList(
          await HrApiService.getDepartmentShiftSwaps(department: department),
        );
        isReviewer = true;
      } catch (_) {}
      try {
        departmentOnCall = _asMapList(
          await HrApiService.getDepartmentOnCall(department: department),
        );
        isOnCallManager = true;
      } catch (_) {}
    }
    try {
      myOnCall = _asMapList(await HrApiService.getMyOnCallAssignments());
    } catch (_) {}
    try {
      onCallNow = _asMapList(
        await HrApiService.getWhoIsOnCallNow(department: department),
      );
    } catch (_) {}

    if (!mounted) return;
    setState(() {
      _myUid = myUid;
      _department = department;
      _myAssignments = myAssignments;
      _candidates = candidates;
      _mySwaps = mySwaps;
      _approvals = approvals;
      _isReviewer = isReviewer;
      _myOnCall = myOnCall;
      _onCallNow = onCallNow;
      _departmentOnCall = departmentOnCall;
      _isOnCallManager = isOnCallManager;
      if (!_myAssignments.any(
        (row) => row['assignment_id'] == _selectedMyAssignmentId,
      )) {
        _selectedMyAssignmentId = null;
      }
      if (!_candidates.any(
        (row) => row['assignment_id'] == _selectedCandidateAssignmentId,
      )) {
        _selectedCandidateAssignmentId = null;
      }
      _loading = false;
    });
  }

  void _toast(String message, {bool isError = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: isError ? AppTheme.errorRed : null,
      ),
    );
  }

  Future<void> _runAction(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
      await _load();
    } catch (e) {
      _toast(e.toString().replaceFirst('Exception: ', ''), isError: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _propose() async {
    final s = AppStrings.of(context);
    final mine = _selectedMyAssignmentId;
    final theirs = _selectedCandidateAssignmentId;
    if (mine == null || theirs == null) return;
    await _runAction(() async {
      await HrApiService.proposeShiftSwap(
        requesterAssignmentId: mine,
        counterpartyAssignmentId: theirs,
        reason: _reasonController.text.trim().isEmpty
            ? null
            : _reasonController.text.trim(),
      );
      _reasonController.clear();
      _toast(s.lookup('s4.lib.shift_swap.submitted'));
    });
  }

  String _shiftLine({
    required dynamic date,
    required dynamic shift,
    dynamic who,
  }) {
    final base = '${_asText(shift)} · ${_asText(date)}';
    final name = who == null ? '' : _asText(who, fallback: '');
    return name.isEmpty ? base : '$name — $base';
  }

  // ─── Widgets ──────────────────────────────────────────────────────────────

  Widget _sectionTitle(String text) {
    return Padding(
      padding: const EdgeInsets.only(top: 16, bottom: 8),
      child: Text(
        text,
        style: TextStyle(
          color: AppTheme.textPrimary,
          fontSize: 16,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }

  Widget _buildProposeCard(AppStrings s) {
    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.lookup('s4.lib.shift_swap.propose_title'),
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontSize: 18,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 12),
            if (_myAssignments.isEmpty)
              Text(
                s.lookup('s4.lib.shift_swap.no_own_shifts'),
                style: TextStyle(color: AppTheme.textSecondary),
              )
            else
              DropdownButtonFormField<int>(
                initialValue: _selectedMyAssignmentId,
                isExpanded: true,
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.shift_swap.my_shift'),
                  prefixIcon: const Icon(Icons.badge_outlined),
                ),
                items: _myAssignments
                    .map(
                      (row) => DropdownMenuItem<int>(
                        value: row['assignment_id'] as int?,
                        child: Text(
                          _shiftLine(
                            date: row['roster_date'],
                            shift: row['shift_label'],
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    )
                    .toList(),
                onChanged: _busy
                    ? null
                    : (value) =>
                          setState(() => _selectedMyAssignmentId = value),
              ),
            const SizedBox(height: 12),
            if (_candidates.isEmpty)
              Text(
                s.lookup('s4.lib.shift_swap.no_candidates'),
                style: TextStyle(color: AppTheme.textSecondary),
              )
            else
              DropdownButtonFormField<int>(
                initialValue: _selectedCandidateAssignmentId,
                isExpanded: true,
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.shift_swap.their_shift'),
                  prefixIcon: const Icon(Icons.group_outlined),
                ),
                items: _candidates
                    .map(
                      (row) => DropdownMenuItem<int>(
                        value: row['assignment_id'] as int?,
                        child: Text(
                          _shiftLine(
                            date: row['roster_date'],
                            shift: row['shift_label'],
                            who: row['staff_name'],
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    )
                    .toList(),
                onChanged: _busy
                    ? null
                    : (value) => setState(
                        () => _selectedCandidateAssignmentId = value,
                      ),
              ),
            const SizedBox(height: 12),
            TextField(
              controller: _reasonController,
              maxLines: 2,
              decoration: InputDecoration(
                labelText: s.lookup('s4.lib.shift_swap.reason_label'),
                prefixIcon: const Icon(Icons.notes_outlined),
              ),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed:
                    _busy ||
                        _selectedMyAssignmentId == null ||
                        _selectedCandidateAssignmentId == null
                    ? null
                    : _propose,
                icon: const Icon(Icons.swap_horiz),
                label: Text(s.lookup('s4.lib.shift_swap.submit')),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'approved':
        return AppTheme.successOnSurface;
      case 'rejected':
      case 'counterparty_declined':
      case 'cancelled':
      case 'expired':
        return AppTheme.errorRed;
      default:
        return AppTheme.warningOnSurface;
    }
  }

  Widget _buildSwapTile(AppStrings s, Map<String, dynamic> swap) {
    final status = _asText(swap['status']);
    final swapId = swap['id'] as int?;
    final incoming =
        _myUid != null &&
        swap['counterparty_uid']?.toString().toLowerCase() == _myUid;
    final outgoing =
        _myUid != null &&
        swap['requester_uid']?.toString().toLowerCase() == _myUid;
    final live = status == 'proposed' || status == 'counterparty_accepted';

    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  incoming ? Icons.call_received : Icons.call_made,
                  size: 18,
                  color: AppTheme.primaryBlue,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    incoming
                        ? '${s.lookup('s4.lib.shift_swap.incoming_badge')}: ${_asText(swap['requester_name'])}'
                        : _asText(swap['counterparty_name']),
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                _StatusPill(label: status, color: _statusColor(status)),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              '${_shiftLine(date: swap['requester_roster_date'], shift: swap['requester_shift_label'])}'
              '  ⇄  '
              '${_shiftLine(date: swap['counterparty_roster_date'], shift: swap['counterparty_shift_label'])}',
              style: TextStyle(color: AppTheme.textSecondary, fontSize: 13),
            ),
            if (_asText(swap['reason'], fallback: '').isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  _asText(swap['reason']),
                  style: TextStyle(
                    color: AppTheme.textSecondary,
                    fontSize: 12,
                    fontStyle: FontStyle.italic,
                  ),
                ),
              ),
            if (swapId != null && live && (incoming || outgoing))
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Wrap(
                  spacing: 8,
                  children: [
                    if (incoming && status == 'proposed') ...[
                      FilledButton(
                        onPressed: _busy
                            ? null
                            : () => _runAction(
                                () async => HrApiService.respondShiftSwap(
                                  swapId: swapId,
                                  decision: 'accept',
                                ),
                              ),
                        child: Text(s.lookup('s4.lib.shift_swap.accept')),
                      ),
                      OutlinedButton(
                        onPressed: _busy
                            ? null
                            : () => _runAction(
                                () async => HrApiService.respondShiftSwap(
                                  swapId: swapId,
                                  decision: 'decline',
                                ),
                              ),
                        child: Text(s.lookup('s4.lib.shift_swap.decline')),
                      ),
                    ],
                    if (outgoing)
                      OutlinedButton(
                        onPressed: _busy
                            ? null
                            : () => _runAction(
                                () async => HrApiService.cancelShiftSwap(
                                  swapId: swapId,
                                ),
                              ),
                        child: Text(
                          s.lookup('s4.lib.shift_swap.cancel_request'),
                        ),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildApprovalTile(AppStrings s, Map<String, dynamic> swap) {
    final status = _asText(swap['status']);
    final swapId = swap['id'] as int?;
    final actionable =
        status == 'counterparty_accepted' || status == 'proposed';
    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    '${_asText(swap['requester_name'])} ⇄ ${_asText(swap['counterparty_name'])}',
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                _StatusPill(label: status, color: _statusColor(status)),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              '${_shiftLine(date: swap['requester_roster_date'], shift: swap['requester_shift_label'])}'
              '  ⇄  '
              '${_shiftLine(date: swap['counterparty_roster_date'], shift: swap['counterparty_shift_label'])}',
              style: TextStyle(color: AppTheme.textSecondary, fontSize: 13),
            ),
            if (swapId != null && actionable)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Wrap(
                  spacing: 8,
                  children: [
                    if (status == 'counterparty_accepted')
                      FilledButton(
                        onPressed: _busy
                            ? null
                            : () => _runAction(
                                () async => HrApiService.reviewShiftSwap(
                                  swapId: swapId,
                                  decision: 'approved',
                                ),
                              ),
                        child: Text(s.lookup('s4.lib.shift_swap.approve')),
                      ),
                    OutlinedButton(
                      onPressed: _busy
                          ? null
                          : () => _runAction(
                              () async => HrApiService.reviewShiftSwap(
                                swapId: swapId,
                                decision: 'rejected',
                              ),
                            ),
                      child: Text(s.lookup('s4.lib.shift_swap.reject')),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  String _formatStamp(dynamic value) {
    if (value == null) return '-';
    try {
      return DateFormat(
        'd MMM HH:mm',
      ).format(DateTime.parse(value.toString()).toLocal());
    } catch (_) {
      return value.toString();
    }
  }

  Widget _buildOnCallTile(
    AppStrings s,
    Map<String, dynamic> row, {
    bool manageable = false,
  }) {
    final id = row['id'] as int?;
    return Card(
      color: AppTheme.cardSurface,
      child: ListTile(
        leading: const Icon(
          Icons.phone_in_talk_outlined,
          color: AppTheme.primaryBlue,
        ),
        title: Text(
          '${_asText(row['staff_name'], fallback: _asText(row['staff_role']))}'
          ' · T${_asText(row['tier'], fallback: '1')}',
          style: TextStyle(
            color: AppTheme.textPrimary,
            fontWeight: FontWeight.w700,
          ),
        ),
        subtitle: Text(
          '${_asText(row['department'])}'
          '${_asText(row['specialty'], fallback: '').isEmpty ? '' : ' · ${_asText(row['specialty'])}'}\n'
          '${_formatStamp(row['start_at'])} → ${_formatStamp(row['end_at'])}',
          style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
        ),
        isThreeLine: true,
        trailing: manageable && id != null && row['is_active'] == true
            ? TextButton(
                onPressed: _busy
                    ? null
                    : () {
                        final endedMessage = s.lookup(
                          's4.lib.shift_swap.on_call_ended',
                        );
                        _runAction(() async {
                          await HrApiService.endOnCallAssignment(
                            assignmentId: id,
                          );
                          _toast(endedMessage);
                        });
                      },
                child: Text(s.lookup('s4.lib.shift_swap.end_on_call')),
              )
            : null,
      ),
    );
  }

  Future<void> _openAddOnCallSheet() async {
    final s = AppStrings.of(context);
    final department = _department;
    if (department == null) return;

    List<Map<String, dynamic>> staffPool = [];
    try {
      final snapshot = await HrApiService.getRosterBoard(
        department: department,
        rosterDate: DateFormat('yyyy-MM-dd').format(DateTime.now()),
      );
      staffPool = _asMapList(snapshot['staff']);
    } catch (e) {
      _toast(e.toString().replaceFirst('Exception: ', ''), isError: true);
      return;
    }
    if (!mounted || staffPool.isEmpty) return;

    int? staffId;
    var tier = 1;
    var start = DateTime.now();
    var end = DateTime.now().add(const Duration(hours: 12));

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => StatefulBuilder(
        builder: (sheetContext, setSheetState) {
          Future<void> pickStamp({required bool isEnd}) async {
            final initial = isEnd ? end : start;
            final date = await showDatePicker(
              context: sheetContext,
              initialDate: initial,
              firstDate: DateTime.now().subtract(const Duration(days: 1)),
              lastDate: DateTime.now().add(const Duration(days: 90)),
            );
            if (date == null || !sheetContext.mounted) return;
            final time = await showTimePicker(
              context: sheetContext,
              initialTime: TimeOfDay.fromDateTime(initial),
            );
            if (time == null) return;
            final stamp = DateTime(
              date.year,
              date.month,
              date.day,
              time.hour,
              time.minute,
            );
            setSheetState(() {
              if (isEnd) {
                end = stamp;
              } else {
                start = stamp;
                if (!end.isAfter(start)) {
                  end = start.add(const Duration(hours: 12));
                }
              }
            });
          }

          return Padding(
            padding: EdgeInsets.only(
              left: 16,
              right: 16,
              top: 16,
              bottom: MediaQuery.of(sheetContext).viewInsets.bottom + 16,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  s.lookup('s4.lib.shift_swap.add_on_call'),
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontSize: 18,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<int>(
                  initialValue: staffId,
                  isExpanded: true,
                  decoration: InputDecoration(
                    labelText: s.lookup('s4.lib.shift_swap.staff_label'),
                  ),
                  items: staffPool
                      .map(
                        (row) => DropdownMenuItem<int>(
                          value: row['id'] as int?,
                          child: Text(
                            _asText(row['name']),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: (value) => setSheetState(() => staffId = value),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<int>(
                  initialValue: tier,
                  decoration: InputDecoration(
                    labelText: s.lookup('s4.lib.shift_swap.tier_label'),
                  ),
                  items: const [1, 2, 3]
                      .map(
                        (value) => DropdownMenuItem<int>(
                          value: value,
                          child: Text('T$value'),
                        ),
                      )
                      .toList(),
                  onChanged: (value) => setSheetState(() => tier = value ?? 1),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => pickStamp(isEnd: false),
                        icon: const Icon(Icons.schedule),
                        label: Text(
                          '${s.lookup('s4.lib.shift_swap.start_label')}: '
                          '${DateFormat('d MMM HH:mm').format(start)}',
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => pickStamp(isEnd: true),
                        icon: const Icon(Icons.schedule_outlined),
                        label: Text(
                          '${s.lookup('s4.lib.shift_swap.end_label')}: '
                          '${DateFormat('d MMM HH:mm').format(end)}',
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: staffId == null
                        ? null
                        : () => Navigator.of(sheetContext).pop(),
                    child: Text(s.lookup('s4.lib.shift_swap.create')),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );

    if (staffId == null) return;
    await _runAction(() async {
      await HrApiService.createOnCallAssignment(
        department: department,
        staffId: staffId!,
        tier: tier,
        startAt: start.toUtc().toIso8601String(),
        endAt: end.toUtc().toIso8601String(),
      );
      _toast(s.lookup('s4.lib.shift_swap.on_call_created'));
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.lookup('s4.lib.shift_swap.title')),
        actions: [
          IconButton(
            tooltip: s.lookup('action.refresh'),
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _buildProposeCard(s),
                  _sectionTitle(s.lookup('s4.lib.shift_swap.my_swaps')),
                  if (_mySwaps.isEmpty)
                    Card(
                      color: AppTheme.cardSurface,
                      child: Padding(
                        padding: const EdgeInsets.all(18),
                        child: Text(
                          s.lookup('s4.lib.shift_swap.no_swaps_yet'),
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      ),
                    )
                  else
                    ..._mySwaps.map((swap) => _buildSwapTile(s, swap)),
                  if (_isReviewer && _approvals.isNotEmpty) ...[
                    _sectionTitle(
                      s.lookup('s4.lib.shift_swap.approvals_title'),
                    ),
                    ..._approvals
                        .where(
                          (swap) =>
                              _myUid == null ||
                              (swap['requester_uid']
                                          ?.toString()
                                          .toLowerCase() !=
                                      _myUid &&
                                  swap['counterparty_uid']
                                          ?.toString()
                                          .toLowerCase() !=
                                      _myUid),
                        )
                        .map((swap) => _buildApprovalTile(s, swap)),
                  ],
                  _sectionTitle(s.lookup('s4.lib.shift_swap.my_on_call')),
                  if (_myOnCall.isEmpty)
                    Card(
                      color: AppTheme.cardSurface,
                      child: Padding(
                        padding: const EdgeInsets.all(18),
                        child: Text(
                          s.lookup('s4.lib.shift_swap.no_on_call'),
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      ),
                    )
                  else
                    ..._myOnCall.map((row) => _buildOnCallTile(s, row)),
                  _sectionTitle(s.lookup('s4.lib.shift_swap.on_call_now')),
                  if (_onCallNow.isEmpty)
                    Card(
                      color: AppTheme.cardSurface,
                      child: Padding(
                        padding: const EdgeInsets.all(18),
                        child: Text(
                          s.lookup('s4.lib.shift_swap.no_one_on_call'),
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      ),
                    )
                  else
                    ..._onCallNow.map((row) => _buildOnCallTile(s, row)),
                  if (_isOnCallManager) ...[
                    _sectionTitle(s.lookup('s4.lib.shift_swap.manage_on_call')),
                    ..._departmentOnCall.map(
                      (row) => _buildOnCallTile(s, row, manageable: true),
                    ),
                    const SizedBox(height: 8),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton.icon(
                        onPressed: _busy ? null : _openAddOnCallSheet,
                        icon: const Icon(Icons.add),
                        label: Text(s.lookup('s4.lib.shift_swap.add_on_call')),
                      ),
                    ),
                  ],
                ],
              ),
            ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String label;
  final Color color;

  const _StatusPill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        border: Border.all(color: color.withValues(alpha: 0.35)),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
