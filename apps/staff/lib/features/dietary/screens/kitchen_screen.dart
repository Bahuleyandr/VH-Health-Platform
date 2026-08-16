import 'package:flutter/material.dart';

import '../../../core/services/dietary_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

typedef KitchenTicketLister = Future<List<Map<String, dynamic>>> Function({
  String? date,
  String? mealType,
  String? status,
  String? ward,
});
typedef KitchenSummaryFetcher = Future<Map<String, dynamic>> Function({
  String? date,
});
typedef KitchenTicketTransitioner = Future<Map<String, dynamic>> Function(
  String id,
  String status, {
  String? reason,
});
typedef KitchenGenerator = Future<Map<String, dynamic>> Function({
  String? date,
});

const _kMealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];

const _kKitchenNextAction = {
  'pending': 'preparing',
  'preparing': 'ready',
  'ready': 'dispatched',
};
const _kTrayNextAction = {'dispatched': 'delivered', 'delivered': 'collected'};

/// Kitchen board + ward tray tracking on top of diet orders. The kitchen tab
/// shows today's production summary (what to cook, by meal x diet type) and
/// progresses tickets pending → preparing → ready → dispatched; the trays tab
/// is the ward-side leg dispatched → delivered → collected. The backend owns
/// generation, uniqueness, and per-transition role gating — this screen only
/// captures.
class KitchenScreen extends StatefulWidget {
  const KitchenScreen({
    super.key,
    this.listTickets,
    this.fetchSummary,
    this.transitionTicket,
    this.generateTickets,
  });

  final KitchenTicketLister? listTickets;
  final KitchenSummaryFetcher? fetchSummary;
  final KitchenTicketTransitioner? transitionTicket;
  final KitchenGenerator? generateTickets;

  @override
  State<KitchenScreen> createState() => _KitchenScreenState();
}

class _KitchenScreenState extends State<KitchenScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs;

  List<Map<String, dynamic>> _tickets = const [];
  Map<String, dynamic>? _summary;
  bool _loading = true;
  String? _error;
  String? _mealFilter;
  bool _acting = false;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
    _load();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final lister = widget.listTickets ?? DietaryApiService.getMealTickets;
      final summarizer =
          widget.fetchSummary ?? DietaryApiService.getProductionSummary;
      final results = await Future.wait([lister(), summarizer()]);
      if (!mounted) return;
      setState(() {
        _tickets = results[0] as List<Map<String, dynamic>>;
        _summary = results[1] as Map<String, dynamic>;
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _snack(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: error ? AppTheme.errorRed : AppTheme.successGreen,
      ),
    );
  }

  Future<void> _transition(
    Map<String, dynamic> ticket,
    String toStatus, {
    String? reason,
  }) async {
    final s = AppStrings.of(context);
    setState(() => _acting = true);
    try {
      final transition =
          widget.transitionTicket ?? DietaryApiService.transitionTicket;
      await transition('${ticket['id']}', toStatus, reason: reason);
      _snack(
        s.format('s4.lib.kitchen.transition_done', {
          'status': _statusLabel(s, toStatus),
        }),
      );
      await _load();
    } catch (e) {
      _snack('$e', error: true);
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _cancelTicket(Map<String, dynamic> ticket) async {
    final s = AppStrings.of(context);
    var reason = '';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        final ds = AppStrings.of(ctx);
        return AlertDialog(
          title: Text(ds.lookup('s4.lib.kitchen.cancel_ticket')),
          content: TextField(
            key: const ValueKey('kitchen-cancel-reason'),
            onChanged: (v) => reason = v,
            decoration: InputDecoration(
              labelText: ds.lookup('s4.lib.kitchen.cancel_reason'),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: Text(ds.actionCancel),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(ds.lookup('s4.lib.kitchen.cancel_confirm')),
            ),
          ],
        );
      },
    );
    if (confirmed != true) return;
    if (reason.trim().isEmpty) {
      _snack(s.lookup('s4.lib.kitchen.cancel_reason_required'), error: true);
      return;
    }
    await _transition(ticket, 'cancelled', reason: reason.trim());
  }

  Future<void> _regenerate() async {
    final s = AppStrings.of(context);
    setState(() => _acting = true);
    try {
      final generator =
          widget.generateTickets ?? DietaryApiService.generateTickets;
      final result = await generator();
      _snack(
        s.format('s4.lib.kitchen.generated', {'count': result['created'] ?? 0}),
      );
      await _load();
    } catch (e) {
      _snack('$e', error: true);
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  String _statusLabel(AppStrings s, String status) =>
      s.lookup('s4.lib.kitchen.status_$status');

  String _mealLabel(AppStrings s, String meal) =>
      s.lookup('s4.lib.kitchen.meal_$meal');

  Color _statusColor(String status) {
    switch (status) {
      case 'pending':
        return const Color(0xFF757575);
      case 'preparing':
        return const Color(0xFFF9A825);
      case 'ready':
        return AppTheme.primaryBlue;
      case 'dispatched':
        return const Color(0xFF7B1FA2);
      case 'delivered':
        return AppTheme.successGreen;
      case 'collected':
        return AppTheme.primaryTeal;
      default:
        return AppTheme.errorRed;
    }
  }

  List<Map<String, dynamic>> get _kitchenTickets => _tickets
      .where(
        (t) =>
            const {'pending', 'preparing', 'ready'}.contains('${t['status']}'),
      )
      .where((t) => _mealFilter == null || '${t['meal_type']}' == _mealFilter)
      .toList();

  List<Map<String, dynamic>> get _trayTickets => _tickets
      .where(
        (t) => const {'dispatched', 'delivered'}.contains('${t['status']}'),
      )
      .toList();

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.lookup('s4.lib.kitchen.title')),
        backgroundColor: AppTheme.primaryTeal,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            key: const ValueKey('kitchen-generate'),
            icon: const Icon(Icons.playlist_add_check),
            tooltip: s.lookup('s4.lib.kitchen.generate'),
            onPressed: _acting ? null : _regenerate,
          ),
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: s.actionRefresh,
            onPressed: _load,
          ),
          const LogoutAction(),
        ],
        bottom: TabBar(
          controller: _tabs,
          indicatorColor: Colors.white,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white70,
          tabs: [
            Tab(text: s.lookup('s4.lib.kitchen.board_tab')),
            Tab(text: s.lookup('s4.lib.kitchen.trays_tab')),
          ],
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? _buildError(s)
          : TabBarView(
              controller: _tabs,
              children: [_buildBoardTab(s), _buildTraysTab(s)],
            ),
    );
  }

  Widget _buildError(AppStrings s) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.error_outline, size: 48, color: AppTheme.errorRed),
          const SizedBox(height: 12),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Text(
              _error!,
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ),
          const SizedBox(height: 12),
          ElevatedButton.icon(
            onPressed: _load,
            icon: const Icon(Icons.refresh),
            label: Text(s.actionRetry),
          ),
        ],
      ),
    );
  }

  Widget _buildBoardTab(AppStrings s) {
    final tickets = _kitchenTickets;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (_summary != null) _buildSummaryCard(s),
          const SizedBox(height: 12),
          _buildMealFilter(s),
          const SizedBox(height: 12),
          if (tickets.isEmpty)
            _buildEmpty(s, s.lookup('s4.lib.kitchen.board_empty'))
          else
            ...tickets.map((t) => _buildTicketCard(s, t, kitchen: true)),
        ],
      ),
    );
  }

  Widget _buildTraysTab(AppStrings s) {
    final tickets = _trayTickets;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (tickets.isEmpty)
            _buildEmpty(s, s.lookup('s4.lib.kitchen.trays_empty'))
          else
            ...tickets.map((t) => _buildTicketCard(s, t, kitchen: false)),
        ],
      ),
    );
  }

  Widget _buildEmpty(AppStrings s, String message) {
    return Padding(
      padding: const EdgeInsets.only(top: 64),
      child: Column(
        children: [
          Icon(Icons.soup_kitchen, size: 64, color: Colors.grey.shade400),
          const SizedBox(height: 12),
          Text(message, style: TextStyle(color: AppTheme.textSecondary)),
        ],
      ),
    );
  }

  Widget _buildSummaryCard(AppStrings s) {
    final byMeal = _summary?['byMeal'];
    if (byMeal is! Map) return const SizedBox.shrink();
    final serviceDate = '${_summary?['serviceDate'] ?? ''}';
    return Card(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(
                  Icons.soup_kitchen,
                  size: 20,
                  color: AppTheme.primaryTeal,
                ),
                const SizedBox(width: 8),
                Text(
                  s.lookup('s4.lib.kitchen.production_summary'),
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 15,
                  ),
                ),
                const Spacer(),
                Text(
                  serviceDate,
                  style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
                ),
              ],
            ),
            const SizedBox(height: 10),
            ..._kMealTypes.map((meal) {
              final entry = byMeal[meal];
              if (entry is! Map) return const SizedBox.shrink();
              final total = entry['total'] ?? 0;
              final byDiet = entry['by_diet_type'];
              final parts = byDiet is Map
                  ? byDiet.entries
                        .map((e) => '${e.key} ×${e.value}')
                        .join('  ·  ')
                  : '';
              return Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 92,
                      child: Text(
                        _mealLabel(s, meal),
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                    Text(
                      '$total',
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        parts,
                        style: TextStyle(
                          fontSize: 12,
                          color: AppTheme.textSecondary,
                        ),
                      ),
                    ),
                  ],
                ),
              );
            }),
          ],
        ),
      ),
    );
  }

  Widget _buildMealFilter(AppStrings s) {
    return Wrap(
      spacing: 8,
      children: [
        ChoiceChip(
          label: Text(s.lookup('s4.lib.kitchen.all_meals')),
          selected: _mealFilter == null,
          onSelected: (_) => setState(() => _mealFilter = null),
        ),
        ..._kMealTypes.map(
          (meal) => ChoiceChip(
            label: Text(_mealLabel(s, meal)),
            selected: _mealFilter == meal,
            onSelected: (_) => setState(() => _mealFilter = meal),
          ),
        ),
      ],
    );
  }

  Widget _buildTicketCard(
    AppStrings s,
    Map<String, dynamic> ticket, {
    required bool kitchen,
  }) {
    final status = '${ticket['status']}';
    final color = _statusColor(status);
    final mealType = '${ticket['meal_type']}';
    final selections = ticket['menu_selections'];
    final menuNames = selections is List
        ? selections
              .whereType<Map>()
              .map((m) => '${m['name']}')
              .where((n) => n.isNotEmpty)
              .join(', ')
        : '';
    final allergies = ticket['allergies'];
    final allergyText = allergies is List ? allergies.join(', ') : '';
    final next = kitchen
        ? _kKitchenNextAction[status]
        : _kTrayNextAction[status];

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: color.withValues(alpha: 0.3)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${ticket['patient_name'] ?? ticket['patient_uid'] ?? ''}',
                        style: const TextStyle(
                          fontWeight: FontWeight.w600,
                          fontSize: 15,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        [
                          _mealLabel(s, mealType),
                          '${ticket['diet_type'] ?? ''}',
                          if ((ticket['ward'] ?? '').toString().isNotEmpty)
                            '${ticket['ward']}'
                                '${(ticket['bed_number'] ?? '').toString().isNotEmpty ? ' · ${ticket['bed_number']}' : ''}',
                        ].where((p) => p.isNotEmpty).join('  —  '),
                        style: TextStyle(
                          fontSize: 13,
                          color: AppTheme.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(
                    _statusLabel(s, status),
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      color: color,
                    ),
                  ),
                ),
              ],
            ),
            if (menuNames.isNotEmpty) ...[
              const SizedBox(height: 8),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.restaurant_menu,
                    size: 14,
                    color: AppTheme.primaryTeal,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      menuNames,
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
                ],
              ),
            ] else if ((ticket['diet_spec'] ?? '').toString().isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                '${ticket['diet_spec']}',
                style: TextStyle(
                  fontSize: 12,
                  fontStyle: FontStyle.italic,
                  color: AppTheme.textSecondary,
                ),
              ),
            ],
            if (allergyText.isNotEmpty) ...[
              const SizedBox(height: 6),
              Row(
                children: [
                  const Icon(
                    Icons.warning_amber,
                    size: 14,
                    color: Color(0xFFF9A825),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      s.format('s4.lib.kitchen.allergies', {
                        'list': allergyText,
                      }),
                      style: const TextStyle(
                        fontSize: 12,
                        color: Color(0xFFF9A825),
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
            ],
            if ((ticket['special_instructions'] ?? '')
                .toString()
                .isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                '${ticket['special_instructions']}',
                style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
              ),
            ],
            const SizedBox(height: 8),
            Row(
              children: [
                if (kitchen)
                  TextButton.icon(
                    onPressed: _acting ? null : () => _cancelTicket(ticket),
                    icon: const Icon(Icons.cancel_outlined, size: 16),
                    label: Text(s.lookup('s4.lib.kitchen.cancel_ticket')),
                    style: TextButton.styleFrom(
                      foregroundColor: AppTheme.errorRed,
                      textStyle: const TextStyle(fontSize: 12),
                    ),
                  ),
                const Spacer(),
                if (next != null)
                  FilledButton.icon(
                    key: ValueKey('kitchen-next-${ticket['id']}'),
                    onPressed: _acting ? null : () => _transition(ticket, next),
                    icon: Icon(
                      next == 'delivered' || next == 'collected'
                          ? Icons.room_service
                          : Icons.arrow_forward,
                      size: 16,
                    ),
                    label: Text(
                      s.format('s4.lib.kitchen.mark_as', {
                        'status': _statusLabel(s, next),
                      }),
                    ),
                    style: FilledButton.styleFrom(
                      backgroundColor: _statusColor(next),
                      minimumSize: const Size(0, 36),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
