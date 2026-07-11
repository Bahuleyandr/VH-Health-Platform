import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth_core/services/realtime_client.dart';

import '../../../core/config/api_config.dart';
import '../../../core/services/stemi_pathway_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';
import '../services/cath_lab_api_service.dart';

typedef CathLabCaseLoader =
    Future<List<CathLabCaseSummary>> Function(DateTime date);
typedef StemiActivationLoader = Future<List<StemiActivationSummary>> Function();
typedef StemiActivationAcknowledger = Future<void> Function(int activationId);
typedef CathLabRealtimeEventStreamFactory =
    Stream<RealtimeEvent> Function(String channel);
typedef CathLabClock = DateTime Function();

class CathLabScreen extends StatefulWidget {
  const CathLabScreen({
    super.key,
    this.loadCases,
    this.loadStemiActivations,
    this.acknowledgeStemiActivation,
    this.realtimeEvents,
    this.now,
    this.currentStaffUid,
  });

  final CathLabCaseLoader? loadCases;
  final StemiActivationLoader? loadStemiActivations;
  final StemiActivationAcknowledger? acknowledgeStemiActivation;
  final CathLabRealtimeEventStreamFactory? realtimeEvents;
  final CathLabClock? now;
  final String? currentStaffUid;

  @override
  State<CathLabScreen> createState() => _CathLabScreenState();
}

class _CathLabScreenState extends State<CathLabScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  DateTime _selectedDate = DateTime.now();
  bool _loading = true;
  String? _error;
  List<CathLabCaseSummary> _cases = const [];
  bool _stemiLoading = true;
  String? _stemiError;
  List<StemiActivationSummary> _stemiActivations = const [];
  final Set<int> _acknowledgingStemiIds = <int>{};
  StreamSubscription<RealtimeEvent>? _stemiSub;
  Timer? _stemiRefreshDebounce;
  Timer? _clockTicker;
  String? _currentStaffUid;

  String get _dateLabel => DateFormat('dd MMM yyyy').format(_selectedDate);
  DateTime get _now => widget.now?.call() ?? DateTime.now();

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 5, vsync: this);
    _loadCases();
    unawaited(_loadStemiActivations());
    _currentStaffUid = widget.currentStaffUid;
    if (_currentStaffUid == null) unawaited(_loadCurrentStaffUid());
    unawaited(_attachStemiRealtime());
    _clockTicker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _stemiActivations.isNotEmpty) setState(() {});
    });
  }

  @override
  void dispose() {
    _stemiSub?.cancel();
    _stemiRefreshDebounce?.cancel();
    _clockTicker?.cancel();
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadCurrentStaffUid() async {
    final uid = await ApiConfig.getStaffUid() ?? await ApiConfig.getStaffId();
    if (!mounted) return;
    setState(() => _currentStaffUid = uid);
  }

  Future<void> _attachStemiRealtime() async {
    try {
      final injectedEvents = widget.realtimeEvents;
      if (injectedEvents != null) {
        _stemiSub = injectedEvents(
          'staff:code-stemi',
        ).listen(_handleStemiRealtimeNudge);
        return;
      }
      final realtime = RealtimeClient.instance;
      await realtime.connect();
      if (!mounted) return;
      _stemiSub = realtime
          .events('staff:code-stemi')
          .listen(_handleStemiRealtimeNudge);
    } catch (_) {
      // The persisted activation list remains available when realtime is down.
    }
  }

  void _handleStemiRealtimeNudge(RealtimeEvent _) {
    _stemiRefreshDebounce?.cancel();
    _stemiRefreshDebounce = Timer(const Duration(milliseconds: 400), () {
      if (mounted) {
        unawaited(_loadStemiActivations(showLoading: false));
      }
    });
  }

  Future<bool> _loadStemiActivations({bool showLoading = true}) async {
    if (mounted && showLoading) {
      setState(() {
        _stemiLoading = true;
        _stemiError = null;
      });
    }
    try {
      final loader =
          widget.loadStemiActivations ??
          StemiPathwayApiService.listActiveActivations;
      final activations = await loader();
      validateStemiActivationSummaries(activations);
      if (!mounted) return false;
      setState(() {
        _stemiActivations = activations;
        _stemiLoading = false;
        _stemiError = null;
      });
      return true;
    } catch (_) {
      if (!mounted) return false;
      final s = AppStrings.of(context);
      setState(() {
        _stemiError = s.lookup('s4.lib.cath_lab.stemi.load_failed');
        _stemiLoading = false;
      });
      return false;
    }
  }

  Future<void> _acknowledgeStemi(StemiActivationSummary activation) async {
    if (_acknowledgingStemiIds.contains(activation.id)) return;
    setState(() => _acknowledgingStemiIds.add(activation.id));
    final s = AppStrings.of(context);
    try {
      final acknowledge = widget.acknowledgeStemiActivation;
      if (acknowledge == null) {
        await StemiPathwayApiService.acknowledgeActivation(activation.id);
      } else {
        await acknowledge(activation.id);
      }
      final refreshed = await _loadStemiActivations(showLoading: false);
      if (!refreshed && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.lookup('s4.lib.cath_lab.stemi.ack_refresh_failed')),
          ),
        );
      }
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.lookup('s4.lib.cath_lab.stemi.ack_failed'))),
      );
    } finally {
      if (mounted) {
        setState(() => _acknowledgingStemiIds.remove(activation.id));
      }
    }
  }

  Future<void> _loadCases({bool showLoading = true}) async {
    if (mounted && showLoading) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final loader = widget.loadCases ?? CathLabApiService.fetchCasesForDate;
      final cases = await loader(_selectedDate);
      if (!mounted) return;
      setState(() {
        _cases = cases;
        _loading = false;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _selectedDate,
      firstDate: DateTime.now().subtract(const Duration(days: 90)),
      lastDate: DateTime.now().add(const Duration(days: 180)),
    );
    if (picked == null || picked == _selectedDate) return;
    setState(() => _selectedDate = picked);
    await _loadCases();
  }

  Future<void> _refreshCases() => _loadCases(showLoading: false);

  Future<void> _refreshWorkbench() async {
    await Future.wait([
      _loadCases(showLoading: false),
      _loadStemiActivations(showLoading: false),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.lookup('s4.lib.cath_lab.cath_lab')),
        actions: [
          IconButton(
            tooltip: s.lookup('theatre.pick_date'),
            icon: const Icon(Icons.calendar_today),
            onPressed: _pickDate,
          ),
          IconButton(
            tooltip: s.actionRefresh,
            icon: const Icon(Icons.refresh),
            onPressed: _refreshWorkbench,
          ),
          const LogoutAction(),
        ],
        bottom: TabBar(
          controller: _tabController,
          isScrollable: true,
          indicatorColor: Colors.white,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white70,
          tabs: [
            Tab(text: s.lookup('s4.lib.cath_lab.tab.schedule')),
            Tab(text: s.lookup('s4.lib.cath_lab.readiness')),
            Tab(text: s.lookup('s4.lib.cath_lab.tab.procedure')),
            Tab(text: s.lookup('s4.lib.cath_lab.tab.dose')),
            Tab(text: s.lookup('s4.lib.cath_lab.tab.post_orders')),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _buildScheduleTab(),
          _buildBody(_buildReadinessTab),
          _buildBody(_buildProcedureTab),
          _buildBody(_buildDoseTab),
          _buildBody(_buildPostOrdersTab),
        ],
      ),
    );
  }

  Widget _buildBody(Widget Function(List<CathLabCaseSummary> cases) builder) {
    if (_error != null) {
      return ErrorState(message: _error!, onRetry: () => _loadCases());
    }
    if (_loading) return const SkeletonList();
    return RefreshIndicator(onRefresh: _refreshCases, child: builder(_cases));
  }

  Widget _buildScheduleTab() {
    final s = AppStrings.of(context);
    return RefreshIndicator(
      onRefresh: _refreshWorkbench,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          _IncomingStemiSection(
            activations: _stemiActivations,
            loading: _stemiLoading,
            error: _stemiError,
            now: _now,
            currentStaffUid: _currentStaffUid,
            acknowledgingIds: _acknowledgingStemiIds,
            onRetry: () => _loadStemiActivations(),
            onAcknowledge: _acknowledgeStemi,
          ),
          const SizedBox(height: 20),
          Text(
            s.lookup('s4.lib.cath_lab.tab.schedule'),
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 10),
          if (_error != null)
            SizedBox(
              height: 260,
              child: ErrorState(message: _error!, onRetry: () => _loadCases()),
            )
          else if (_loading)
            const SizedBox(
              height: 300,
              child: SkeletonList(itemCount: 3, padding: EdgeInsets.zero),
            )
          else if (_cases.isEmpty)
            SizedBox(
              height: 260,
              child: EmptyState(
                icon: Icons.event_busy_outlined,
                title: s.lookup('s4.lib.cath_lab.no_cases'),
                body: _dateLabel,
              ),
            )
          else
            for (final cathCase in _cases)
              _CathLabCaseCard(cathCase: cathCase, dateLabel: _dateLabel),
        ],
      ),
    );
  }

  Widget _buildReadinessTab(List<CathLabCaseSummary> cases) {
    if (cases.isEmpty) return _emptyState(Icons.checklist_rtl_outlined);
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: cases.length,
      itemBuilder: (context, index) => _ReadinessCard(cathCase: cases[index]),
    );
  }

  Widget _buildProcedureTab(List<CathLabCaseSummary> cases) {
    if (cases.isEmpty) return _emptyState(Icons.monitor_heart_outlined);
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: cases.length,
      itemBuilder: (context, index) => _StageCard(
        cathCase: cases[index],
        icon: Icons.monitor_heart_outlined,
        title: 's4.lib.cath_lab.procedure_logs',
        countKey: 's4.lib.cath_lab.procedure_logs_count',
        count: cases[index].procedureCount,
        emptyKey: 's4.lib.cath_lab.procedure_pending',
        extraKey: 's4.lib.cath_lab.device_links_count',
        extraCount: cases[index].deviceLinkCount,
      ),
    );
  }

  Widget _buildDoseTab(List<CathLabCaseSummary> cases) {
    if (cases.isEmpty) return _emptyState(Icons.science_outlined);
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: cases.length,
      itemBuilder: (context, index) => _StageCard(
        cathCase: cases[index],
        icon: Icons.science_outlined,
        title: 's4.lib.cath_lab.dose_records',
        countKey: 's4.lib.cath_lab.dose_records_count',
        count: cases[index].doseRecordCount,
        emptyKey: 's4.lib.cath_lab.dose_pending',
      ),
    );
  }

  Widget _buildPostOrdersTab(List<CathLabCaseSummary> cases) {
    if (cases.isEmpty) return _emptyState(Icons.assignment_turned_in_outlined);
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: cases.length,
      itemBuilder: (context, index) => _StageCard(
        cathCase: cases[index],
        icon: Icons.assignment_turned_in_outlined,
        title: 's4.lib.cath_lab.post_orders',
        countKey: 's4.lib.cath_lab.post_orders_count',
        count: cases[index].activePostOrderCount,
        emptyKey: 's4.lib.cath_lab.post_orders_pending',
      ),
    );
  }

  Widget _emptyState(IconData icon) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        SizedBox(
          height: MediaQuery.sizeOf(context).height * 0.55,
          child: EmptyState(
            icon: icon,
            title: AppStrings.of(context).lookup('s4.lib.cath_lab.no_cases'),
            body: _dateLabel,
          ),
        ),
      ],
    );
  }
}

class _IncomingStemiSection extends StatelessWidget {
  const _IncomingStemiSection({
    required this.activations,
    required this.loading,
    required this.error,
    required this.now,
    required this.currentStaffUid,
    required this.acknowledgingIds,
    required this.onRetry,
    required this.onAcknowledge,
  });

  final List<StemiActivationSummary> activations;
  final bool loading;
  final String? error;
  final DateTime now;
  final String? currentStaffUid;
  final Set<int> acknowledgingIds;
  final VoidCallback onRetry;
  final ValueChanged<StemiActivationSummary> onAcknowledge;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(Icons.monitor_heart_outlined, color: AppTheme.errorRed),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                s.lookup('s4.lib.cath_lab.stemi.incoming'),
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  color: AppTheme.errorRed,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ),
            IconButton(
              tooltip: s.actionRefresh,
              onPressed: loading ? null : onRetry,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        if (error != null && activations.isNotEmpty)
          Card(
            color: AppTheme.warningAmber.withValues(alpha: 0.08),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  const Icon(
                    Icons.warning_amber_outlined,
                    color: AppTheme.warningAmber,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(s.lookup('s4.lib.cath_lab.stemi.stale')),
                  ),
                  TextButton(onPressed: onRetry, child: Text(s.actionRetry)),
                ],
              ),
            ),
          ),
        if (loading && activations.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 18),
            child: Center(child: CircularProgressIndicator()),
          )
        else if (error != null && activations.isEmpty)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  const Icon(Icons.error_outline, color: AppTheme.errorRed),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(s.lookup('s4.lib.cath_lab.stemi.load_failed')),
                  ),
                  TextButton(onPressed: onRetry, child: Text(s.actionRetry)),
                ],
              ),
            ),
          )
        else if (activations.isEmpty)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  const Icon(
                    Icons.check_circle_outline,
                    color: AppTheme.successGreen,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(s.lookup('s4.lib.cath_lab.stemi.empty')),
                  ),
                ],
              ),
            ),
          )
        else
          for (final activation in activations)
            _StemiActivationCard(
              activation: activation,
              now: now,
              currentStaffUid: currentStaffUid,
              acknowledging: acknowledgingIds.contains(activation.id),
              onAcknowledge: () => onAcknowledge(activation),
            ),
      ],
    );
  }
}

class _StemiActivationCard extends StatelessWidget {
  const _StemiActivationCard({
    required this.activation,
    required this.now,
    required this.currentStaffUid,
    required this.acknowledging,
    required this.onAcknowledge,
  });

  final StemiActivationSummary activation;
  final DateTime now;
  final String? currentStaffUid;
  final bool acknowledging;
  final VoidCallback onAcknowledge;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final currentAck = activation.acknowledgementFor(currentStaffUid);
    final canAcknowledge = currentAck != null && !currentAck.isAcknowledged;
    final patient = activation.patientName.isNotEmpty
        ? activation.patientName
        : activation.patientUid.isEmpty
        ? s.lookup('s4.lib.cath_lab.unknown_patient')
        : _shortIdentifier(activation.patientUid);
    return Card(
      key: ValueKey('stemi-activation-${activation.id}'),
      margin: const EdgeInsets.only(top: 10),
      color: AppTheme.errorRed.withValues(alpha: 0.035),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                CircleAvatar(
                  backgroundColor: AppTheme.errorRed.withValues(alpha: 0.14),
                  foregroundColor: AppTheme.errorRed,
                  child: const Icon(Icons.monitor_heart_outlined),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        patient,
                        style: Theme.of(context).textTheme.titleMedium
                            ?.copyWith(fontWeight: FontWeight.w800),
                      ),
                      if (activation.activatedAt != null)
                        Text(
                          s.format('s4.lib.cath_lab.stemi.activated_at', {
                            'time': DateFormat(
                              'dd MMM yyyy, HH:mm',
                            ).format(activation.activatedAt!),
                          }),
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                    ],
                  ),
                ),
                _StatusChip(
                  label: _stemiStatusLabel(s, activation.status),
                  color: _stemiStatusColor(activation.status),
                ),
              ],
            ),
            if (activation.cathLabCaseId != null) ...[
              const SizedBox(height: 10),
              Text(
                s.format('s4.lib.cath_lab.stemi.cath_case', {
                  'id': activation.cathLabCaseId,
                }),
                style: TextStyle(color: AppTheme.textSecondary),
              ),
            ],
            const SizedBox(height: 14),
            for (final ruleCode in _stemiClockRuleCodes)
              _StemiClockRow(
                label: _stemiClockLabel(s, ruleCode),
                activation: activation,
                clock: activation.slaFor(ruleCode),
                now: now,
              ),
            const Divider(height: 28),
            Text(
              s.lookup('s4.lib.cath_lab.stemi.team'),
              style: const TextStyle(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            if (activation.teamAcknowledgements.isEmpty)
              Text(
                s.lookup('s4.lib.cath_lab.stemi.team_empty'),
                style: TextStyle(color: AppTheme.textSecondary),
              )
            else
              for (final acknowledgement in activation.teamAcknowledgements)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Row(
                    children: [
                      Icon(
                        acknowledgement.isAcknowledged
                            ? Icons.check_circle
                            : Icons.schedule_outlined,
                        size: 18,
                        color: acknowledgement.isAcknowledged
                            ? AppTheme.successGreen
                            : AppTheme.warningAmber,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          '${_acknowledgementName(acknowledgement)} · '
                          '${_stemiRoleLabel(s, acknowledgement.roleCode)}',
                        ),
                      ),
                      Text(
                        acknowledgement.isAcknowledged
                            ? s.lookup('s4.lib.cath_lab.stemi.acknowledged')
                            : s.lookup('s4.lib.cath_lab.stemi.pending'),
                        style: TextStyle(
                          color: acknowledgement.isAcknowledged
                              ? AppTheme.successGreen
                              : AppTheme.warningAmber,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                ),
            if (canAcknowledge) ...[
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton.icon(
                  key: ValueKey('stemi-ack-${activation.id}'),
                  onPressed: acknowledging ? null : onAcknowledge,
                  icon: acknowledging
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.campaign_outlined),
                  label: Text(
                    s.lookup(
                      acknowledging
                          ? 's4.lib.cath_lab.stemi.acknowledging'
                          : 's4.lib.cath_lab.stemi.ack',
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _StemiClockRow extends StatelessWidget {
  const _StemiClockRow({
    required this.label,
    required this.activation,
    required this.clock,
    required this.now,
  });

  final String label;
  final StemiActivationSummary activation;
  final StemiSlaClock? clock;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final unavailable = clock == null;
    final clockStartPending = clock?.clockStartPending ?? false;
    final targetsPending =
        activation.targetsPending || (clock?.targetsPending ?? false);
    final elapsedLabel = unavailable || clockStartPending
        ? '--:--:--'
        : _formatElapsed(clock!.elapsedAt(now));
    final state = unavailable
        ? s.lookup('s4.lib.cath_lab.stemi.clock_unavailable')
        : clockStartPending
        ? s.lookup('s4.lib.cath_lab.stemi.door_time_pending')
        : targetsPending
        ? s.lookup('s4.lib.cath_lab.stemi.targets_pending')
        : _stemiSlaLabel(s, clock?.status);
    final color = unavailable
        ? AppTheme.errorRed
        : clockStartPending || targetsPending
        ? AppTheme.warningAmber
        : _stemiSlaColor(clock?.status);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Icon(Icons.timer_outlined, size: 18, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          Text(
            elapsedLabel,
            style: TextStyle(
              color: color,
              fontFeatures: const [FontFeature.tabularFigures()],
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 104,
            child: Text(
              state,
              textAlign: TextAlign.end,
              style: TextStyle(
                color: color,
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CathLabCaseCard extends StatelessWidget {
  const _CathLabCaseCard({required this.cathCase, required this.dateLabel});

  final CathLabCaseSummary cathCase;
  final String dateLabel;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final time = cathCase.plannedStartAt == null
        ? s.lookup('s4.lib.cath_lab.time_not_set')
        : DateFormat('hh:mm a').format(cathCase.plannedStartAt!);
    final room = cathCase.labRoom.isEmpty
        ? s.lookup('s4.lib.cath_lab.room_unassigned')
        : cathCase.labRoom;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    cathCase.requestedProcedure.isEmpty
                        ? s.lookup('s4.lib.cath_lab.procedure_not_set')
                        : cathCase.requestedProcedure,
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                _StatusChip(
                  label: _statusLabel(s, cathCase.status),
                  color: _statusColor(cathCase.status),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                _InfoPill(
                  icon: Icons.person_outline,
                  label: _patientLabel(s, cathCase),
                ),
                _InfoPill(icon: Icons.access_time, label: '$time - $dateLabel'),
                _InfoPill(icon: Icons.meeting_room_outlined, label: room),
                _InfoPill(
                  icon: Icons.priority_high_outlined,
                  label: _urgencyLabel(s, cathCase.urgency),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ReadinessCard extends StatelessWidget {
  const _ReadinessCard({required this.cathCase});

  final CathLabCaseSummary cathCase;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final color = cathCase.readinessComplete
        ? AppTheme.successGreen
        : AppTheme.warningAmber;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _CaseHeader(cathCase: cathCase),
            const SizedBox(height: 14),
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: LinearProgressIndicator(
                value: cathCase.readinessProgress,
                minHeight: 8,
                color: color,
                backgroundColor: color.withValues(alpha: 0.16),
              ),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Icon(
                  cathCase.readinessComplete
                      ? Icons.verified_outlined
                      : Icons.pending_actions_outlined,
                  color: color,
                  size: 18,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    cathCase.readinessComplete
                        ? s.lookup('s4.lib.cath_lab.ready_for_procedure')
                        : s.lookup('s4.lib.cath_lab.readiness_blocking'),
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Text(
                  s.format('s4.lib.cath_lab.readiness_clear', {
                    'cleared': cathCase.readinessCleared,
                    'total': cathCase.readinessTotal,
                  }),
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _StageCard extends StatelessWidget {
  const _StageCard({
    required this.cathCase,
    required this.icon,
    required this.title,
    required this.countKey,
    required this.count,
    required this.emptyKey,
    this.extraKey,
    this.extraCount,
  });

  final CathLabCaseSummary cathCase;
  final IconData icon;
  final String title;
  final String countKey;
  final int count;
  final String emptyKey;
  final String? extraKey;
  final int? extraCount;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final hasEvidence = count > 0;
    final color = hasEvidence ? AppTheme.successGreen : AppTheme.warningAmber;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _CaseHeader(cathCase: cathCase),
            const SizedBox(height: 14),
            Row(
              children: [
                CircleAvatar(
                  backgroundColor: color.withValues(alpha: 0.15),
                  foregroundColor: color,
                  child: Icon(icon),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.lookup(title),
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        hasEvidence
                            ? s.format(countKey, {'count': count})
                            : s.lookup(emptyKey),
                        style: TextStyle(color: AppTheme.textSecondary),
                      ),
                    ],
                  ),
                ),
                if (extraKey != null && extraCount != null)
                  _StatusChip(
                    label: s.format(extraKey!, {'count': extraCount}),
                    color: AppTheme.primaryBlue,
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _CaseHeader extends StatelessWidget {
  const _CaseHeader({required this.cathCase});

  final CathLabCaseSummary cathCase;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                cathCase.requestedProcedure.isEmpty
                    ? s.lookup('s4.lib.cath_lab.procedure_not_set')
                    : cathCase.requestedProcedure,
                style: TextStyle(
                  color: AppTheme.textPrimary,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                _patientLabel(s, cathCase),
                style: TextStyle(color: AppTheme.textSecondary),
              ),
            ],
          ),
        ),
        const SizedBox(width: 10),
        _StatusChip(
          label: _statusLabel(s, cathCase.status),
          color: _statusColor(cathCase.status),
        ),
      ],
    );
  }
}

class _InfoPill extends StatelessWidget {
  const _InfoPill({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 16, color: AppTheme.textSecondary),
        const SizedBox(width: 5),
        Text(label, style: TextStyle(color: AppTheme.textSecondary)),
      ],
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
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

const _stemiClockRuleCodes = <String>[
  'stemi_door_to_ecg',
  'stemi_door_to_lab',
  'stemi_door_to_balloon',
];

String _stemiClockLabel(AppStrings s, String ruleCode) {
  return switch (ruleCode) {
    'stemi_door_to_ecg' => s.lookup('s4.lib.cath_lab.stemi.clock.door_to_ecg'),
    'stemi_door_to_lab' => s.lookup('s4.lib.cath_lab.stemi.clock.door_to_lab'),
    'stemi_door_to_balloon' => s.lookup(
      's4.lib.cath_lab.stemi.clock.door_to_balloon',
    ),
    _ => s.lookup('label.no_data'),
  };
}

String _stemiStatusLabel(AppStrings s, String status) {
  final key = 's4.lib.cath_lab.stemi.status.${status.toLowerCase()}';
  final label = s.lookup(key);
  return label == key ? _titleize(status) : label;
}

Color _stemiStatusColor(String status) {
  return switch (status.toLowerCase()) {
    'activated' || 'lab_notified' => AppTheme.errorRed,
    'in_lab' => AppTheme.primaryBlue,
    'device_deployed' || 'completed' => AppTheme.successGreen,
    'stood_down' => Colors.grey,
    _ => AppTheme.warningAmber,
  };
}

String _stemiSlaLabel(AppStrings s, String? status) {
  return switch (status?.toLowerCase()) {
    'active' => s.lookup('s4.lib.cath_lab.stemi.sla.active'),
    'completed' => s.lookup('s4.lib.cath_lab.stemi.sla.completed'),
    'breached' => s.lookup('s4.lib.cath_lab.stemi.sla.breached'),
    'escalated' => s.lookup('s4.lib.cath_lab.stemi.sla.escalated'),
    'cancelled' => s.lookup('s4.lib.cath_lab.stemi.sla.cancelled'),
    _ => s.lookup('s4.lib.cath_lab.stemi.pending'),
  };
}

Color _stemiSlaColor(String? status) {
  return switch (status?.toLowerCase()) {
    'completed' => AppTheme.successGreen,
    'breached' || 'escalated' => AppTheme.errorRed,
    'active' => AppTheme.warningAmber,
    _ => Colors.grey,
  };
}

String _formatElapsed(Duration duration) {
  final hours = duration.inHours.toString().padLeft(2, '0');
  final minutes = duration.inMinutes.remainder(60).toString().padLeft(2, '0');
  final seconds = duration.inSeconds.remainder(60).toString().padLeft(2, '0');
  return '$hours:$minutes:$seconds';
}

String _acknowledgementName(StemiTeamAcknowledgement acknowledgement) {
  if (acknowledgement.staffName.isNotEmpty) return acknowledgement.staffName;
  return _shortIdentifier(acknowledgement.staffUid);
}

String _stemiRoleLabel(AppStrings s, String roleCode) {
  final key = switch (roleCode.trim().toLowerCase()) {
    'cath_lab_staff' => 'role.display.cath_lab_staff',
    'cath_lab_incharge' => 'role.display.cath_lab_incharge',
    _ => null,
  };
  if (key == null) return _titleize(roleCode);
  return s.lookup(key);
}

String _shortIdentifier(String value) {
  final text = value.trim();
  if (text.length <= 8) return text;
  return '${text.substring(0, 8)}...';
}

Color _statusColor(String status) {
  return switch (status.toLowerCase()) {
    'ready' || 'completed' => AppTheme.successGreen,
    'in_progress' => AppTheme.primaryBlue,
    'readiness_pending' || 'scheduled' => AppTheme.warningAmber,
    'cancelled' => AppTheme.errorRed,
    _ => Colors.grey,
  };
}

String _patientLabel(AppStrings s, CathLabCaseSummary cathCase) {
  if (cathCase.patientName.isNotEmpty) return cathCase.patientName;
  if (cathCase.patientUid.isEmpty) {
    return s.lookup('s4.lib.cath_lab.unknown_patient');
  }
  final uid = cathCase.patientUid;
  return uid.length > 8 ? '${uid.substring(0, 8)}...' : uid;
}

String _statusLabel(AppStrings s, String status) {
  final key = 's4.lib.cath_lab.status.${status.toLowerCase()}';
  final label = s.lookup(key);
  return label == key ? _titleize(status) : label;
}

String _urgencyLabel(AppStrings s, String urgency) {
  final key = 's4.lib.cath_lab.urgency.${urgency.toLowerCase()}';
  final label = s.lookup(key);
  return label == key ? _titleize(urgency) : label;
}

String _titleize(String value) {
  final text = value.replaceAll('_', ' ').trim();
  if (text.isEmpty) return '-';
  return text
      .split(' ')
      .map((part) {
        if (part.isEmpty) return part;
        return '${part[0].toUpperCase()}${part.substring(1)}';
      })
      .join(' ');
}
