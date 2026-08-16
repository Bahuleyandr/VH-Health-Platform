import 'package:flutter/material.dart';

import '../../../core/services/pharmacy_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';

typedef CounterSaleItemSearcher =
    Future<List<Map<String, dynamic>>> Function({String? search});
typedef CounterSaleCreator =
    Future<Map<String, dynamic>> Function({
      required List<Map<String, dynamic>> lines,
      String? patientUid,
      String? customerName,
      String? customerPhone,
      Map<String, dynamic>? rx,
      Map<String, dynamic>? witness,
      required String paymentMode,
      String? paymentReference,
      String? notes,
    });
typedef CounterSaleLister =
    Future<List<Map<String, dynamic>>> Function({String? status, String? date});
typedef CounterSaleVoider =
    Future<Map<String, dynamic>> Function(String id, String reason);

const _kPaymentModes = [
  'CASH',
  'CARD',
  'UPI',
  'NETBANKING',
  'CHEQUE',
  'DD',
  'WALLET',
];
const _kScheduled = {'H', 'H1', 'X'};

class _CartLine {
  _CartLine(this.item, this.quantity);
  final Map<String, dynamic> item;
  double quantity;

  int get itemId => (item['id'] as num).toInt();
  String get name => (item['display_name'] ?? '').toString();
  String? get scheduleClass => item['schedule_class']?.toString();
  bool get isNarcotic => item['is_narcotic'] == true;
  bool get isScheduled =>
      isNarcotic || _kScheduled.contains(scheduleClass ?? '');
  bool get isWitnessed => isNarcotic || scheduleClass == 'X';
  double? get unitPrice => (item['fefo_unit_price'] as num?)?.toDouble();
  String? get batchNumber => item['fefo_batch_number']?.toString();
  String? get expiry {
    final raw = item['fefo_expiry_date']?.toString();
    if (raw == null || raw.isEmpty) return null;
    return raw.split('T').first;
  }
}

/// Walk-in pharmacy point-of-sale: item search with FEFO batch/expiry/MRP
/// preview, cart, patient-or-walk-in customer capture, prescription fields
/// for Schedule H/H1/X items (witness for X/narcotic), pay-at-counter, and a
/// same-day void with reason on the recent-sales tab. The backend owns
/// pricing, allocation and schedule enforcement — this screen only captures.
class CounterSaleScreen extends StatefulWidget {
  const CounterSaleScreen({
    super.key,
    this.searchItems,
    this.createSale,
    this.listSales,
    this.voidSale,
  });

  final CounterSaleItemSearcher? searchItems;
  final CounterSaleCreator? createSale;
  final CounterSaleLister? listSales;
  final CounterSaleVoider? voidSale;

  @override
  State<CounterSaleScreen> createState() => _CounterSaleScreenState();
}

class _CounterSaleScreenState extends State<CounterSaleScreen> {
  final _searchCtrl = TextEditingController();
  final _customerNameCtrl = TextEditingController();
  final _customerPhoneCtrl = TextEditingController();
  final _patientUidCtrl = TextEditingController();
  final _rxDoctorCtrl = TextEditingController();
  final _rxRefCtrl = TextEditingController();
  final _witnessUidCtrl = TextEditingController();
  final _witnessNameCtrl = TextEditingController();
  final _paymentRefCtrl = TextEditingController();

  List<Map<String, dynamic>> _results = const [];
  final List<_CartLine> _cart = [];
  bool _searching = false;
  bool _selling = false;
  bool _walkIn = true;
  String _paymentMode = 'CASH';

  List<Map<String, dynamic>> _recent = const [];
  bool _recentLoading = false;

  @override
  void initState() {
    super.initState();
    _loadRecent();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    _customerNameCtrl.dispose();
    _customerPhoneCtrl.dispose();
    _patientUidCtrl.dispose();
    _rxDoctorCtrl.dispose();
    _rxRefCtrl.dispose();
    _witnessUidCtrl.dispose();
    _witnessNameCtrl.dispose();
    _paymentRefCtrl.dispose();
    super.dispose();
  }

  bool get _needsRx => _cart.any((l) => l.isScheduled);
  bool get _needsWitness => _cart.any((l) => l.isWitnessed);

  double get _estimatedTotal =>
      _cart.fold(0, (sum, line) => sum + (line.unitPrice ?? 0) * line.quantity);

  void _snack(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: error ? Colors.red.shade700 : null,
      ),
    );
  }

  Future<void> _runSearch() async {
    final q = _searchCtrl.text.trim();
    setState(() => _searching = true);
    try {
      final searcher =
          widget.searchItems ?? PharmacyApiService.getCounterSaleItems;
      final items = await searcher(search: q.isEmpty ? null : q);
      if (!mounted) return;
      setState(() => _results = items);
    } catch (e) {
      _snack('$e', error: true);
    } finally {
      if (mounted) setState(() => _searching = false);
    }
  }

  Future<void> _addToCart(Map<String, dynamic> item) async {
    final s = AppStrings.of(context);
    final qtyCtrl = TextEditingController(text: '1');
    final qty = await showDialog<double>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(item['display_name']?.toString() ?? ''),
        content: TextField(
          controller: qtyCtrl,
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(
            labelText: s.lookup('s4.lib.counter_sale.quantity'),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () =>
                Navigator.pop(ctx, double.tryParse(qtyCtrl.text.trim())),
            child: Text(s.lookup('s4.lib.counter_sale.quantity')),
          ),
        ],
      ),
    );
    if (qty == null || qty <= 0) return;
    setState(() {
      final existing = _cart.where(
        (l) => l.itemId == (item['id'] as num).toInt(),
      );
      if (existing.isNotEmpty) {
        existing.first.quantity += qty;
      } else {
        _cart.add(_CartLine(item, qty));
      }
    });
  }

  Future<void> _sell() async {
    final s = AppStrings.of(context);
    if (_cart.isEmpty || _selling) return;
    setState(() => _selling = true);
    try {
      final creator = widget.createSale ?? PharmacyApiService.createCounterSale;
      final rxDoctor = _rxDoctorCtrl.text.trim();
      final rxRef = _rxRefCtrl.text.trim();
      final witnessUid = _witnessUidCtrl.text.trim();
      final witnessName = _witnessNameCtrl.text.trim();
      final result = await creator(
        lines: _cart
            .map((l) => {'inventory_item_id': l.itemId, 'quantity': l.quantity})
            .toList(),
        patientUid: _walkIn ? null : _patientUidCtrl.text.trim(),
        customerName: _walkIn ? _customerNameCtrl.text.trim() : null,
        customerPhone: _walkIn && _customerPhoneCtrl.text.trim().isNotEmpty
            ? _customerPhoneCtrl.text.trim()
            : null,
        rx: _needsRx
            ? {
                if (rxDoctor.isNotEmpty) 'doctor_name': rxDoctor,
                if (rxRef.isNotEmpty) 'reference': rxRef,
              }
            : null,
        witness: _needsWitness
            ? {
                if (witnessUid.isNotEmpty) 'uid': witnessUid,
                if (witnessName.isNotEmpty) 'name': witnessName,
              }
            : null,
        paymentMode: _paymentMode,
        paymentReference: _paymentRefCtrl.text.trim().isEmpty
            ? null
            : _paymentRefCtrl.text.trim(),
      );
      final invoice = result['invoice'];
      final invoiceNumber = invoice is Map
          ? (invoice['invoice_number']?.toString() ?? '—')
          : '—';
      _snack(s.format('s4.lib.counter_sale.sold', {'invoice': invoiceNumber}));
      setState(() {
        _cart.clear();
        _rxDoctorCtrl.clear();
        _rxRefCtrl.clear();
        _witnessUidCtrl.clear();
        _witnessNameCtrl.clear();
        _paymentRefCtrl.clear();
        _customerNameCtrl.clear();
        _customerPhoneCtrl.clear();
        _patientUidCtrl.clear();
      });
      await _loadRecent();
      await _runSearch();
    } catch (e) {
      _snack('$e', error: true);
    } finally {
      if (mounted) setState(() => _selling = false);
    }
  }

  Future<void> _loadRecent() async {
    setState(() => _recentLoading = true);
    try {
      final lister = widget.listSales ?? PharmacyApiService.listCounterSales;
      final sales = await lister();
      if (!mounted) return;
      setState(() => _recent = sales);
    } catch (_) {
      // Recent list is decorative for the seller; failures stay silent here.
    } finally {
      if (mounted) setState(() => _recentLoading = false);
    }
  }

  Future<void> _voidSale(Map<String, dynamic> sale) async {
    final s = AppStrings.of(context);
    final reasonCtrl = TextEditingController();
    final reason = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.lookup('s4.lib.counter_sale.void_action')),
        content: TextField(
          controller: reasonCtrl,
          autofocus: true,
          decoration: InputDecoration(
            labelText: s.lookup('s4.lib.counter_sale.void_reason'),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, reasonCtrl.text.trim()),
            child: Text(s.lookup('s4.lib.counter_sale.void_action')),
          ),
        ],
      ),
    );
    if (reason == null || reason.isEmpty) return;
    try {
      final voider = widget.voidSale ?? PharmacyApiService.voidCounterSale;
      await voider(sale['id'].toString(), reason);
      _snack(s.lookup('s4.lib.counter_sale.voided'));
      await _loadRecent();
    } catch (e) {
      _snack('$e', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: Text(s.lookup('s4.lib.counter_sale.title')),
          bottom: TabBar(
            tabs: [
              Tab(text: s.lookup('s4.lib.counter_sale.sell_tab')),
              Tab(text: s.lookup('s4.lib.counter_sale.recent_tab')),
            ],
          ),
        ),
        body: TabBarView(children: [_buildSellTab(s), _buildRecentTab(s)]),
      ),
    );
  }

  Widget _buildSellTab(AppStrings s) {
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        _buildSearchSection(s),
        const SizedBox(height: 12),
        _buildCartSection(s),
        const SizedBox(height: 12),
        _buildCustomerSection(s),
        if (_needsRx) ...[const SizedBox(height: 12), _buildRxSection(s)],
        if (_needsWitness) ...[
          const SizedBox(height: 12),
          _buildWitnessSection(s),
        ],
        const SizedBox(height: 12),
        _buildPaymentSection(s),
        const SizedBox(height: 16),
        FilledButton.icon(
          key: const ValueKey('counter-sale-sell'),
          onPressed: _cart.isEmpty || _selling ? null : _sell,
          icon: _selling
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.point_of_sale),
          label: Text(s.lookup('s4.lib.counter_sale.sell')),
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
        ),
        const SizedBox(height: 24),
      ],
    );
  }

  Widget _buildSearchSection(AppStrings s) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              key: const ValueKey('counter-sale-search'),
              controller: _searchCtrl,
              onSubmitted: (_) => _runSearch(),
              decoration: InputDecoration(
                hintText: s.lookup('s4.lib.counter_sale.search_hint'),
                prefixIcon: const Icon(Icons.search),
                suffixIcon: _searching
                    ? const Padding(
                        padding: EdgeInsets.all(12),
                        child: SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    : IconButton(
                        icon: const Icon(Icons.arrow_forward),
                        onPressed: _runSearch,
                      ),
              ),
            ),
            ..._results.take(8).map((item) {
              final inStock = ((item['in_stock_quantity'] as num?) ?? 0)
                  .toDouble();
              final schedule = item['schedule_class']?.toString();
              final price = (item['fefo_unit_price'] as num?)?.toDouble();
              final expiry = item['fefo_expiry_date']
                  ?.toString()
                  .split('T')
                  .first;
              return ListTile(
                dense: true,
                title: Text(item['display_name']?.toString() ?? ''),
                subtitle: Text(
                  [
                    if (inStock > 0)
                      s.format('s4.lib.counter_sale.in_stock', {
                        'count': inStock.toStringAsFixed(0),
                      })
                    else
                      s.lookup('s4.lib.counter_sale.out_of_stock'),
                    if (expiry != null && item['fefo_batch_number'] != null)
                      s.format('s4.lib.counter_sale.batch_line', {
                        'batch': item['fefo_batch_number'].toString(),
                        'expiry': expiry,
                      }),
                  ].join(' · '),
                ),
                leading: schedule != null || item['is_narcotic'] == true
                    ? Chip(
                        label: Text(
                          item['is_narcotic'] == true ? 'X' : schedule ?? '',
                          style: const TextStyle(fontSize: 11),
                        ),
                        backgroundColor: Colors.red.shade50,
                        visualDensity: VisualDensity.compact,
                      )
                    : null,
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (price != null) Text('₹${price.toStringAsFixed(2)}'),
                    IconButton(
                      icon: const Icon(Icons.add_circle_outline),
                      onPressed: inStock > 0 ? () => _addToCart(item) : null,
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

  Widget _buildCartSection(AppStrings s) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: _cart.isEmpty
            ? Text(
                s.lookup('s4.lib.counter_sale.cart_empty'),
                style: TextStyle(color: Colors.grey.shade600),
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ..._cart.map(
                    (line) => ListTile(
                      dense: true,
                      title: Text(line.name),
                      subtitle: Text(
                        [
                          if (line.batchNumber != null && line.expiry != null)
                            s.format('s4.lib.counter_sale.batch_line', {
                              'batch': line.batchNumber!,
                              'expiry': line.expiry!,
                            }),
                          if (line.scheduleClass != null || line.isNarcotic)
                            'Schedule ${line.isNarcotic ? 'X' : line.scheduleClass}',
                        ].join(' · '),
                      ),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            '× ${line.quantity.toStringAsFixed(line.quantity.truncateToDouble() == line.quantity ? 0 : 2)}',
                          ),
                          if (line.unitPrice != null)
                            Padding(
                              padding: const EdgeInsets.only(left: 8),
                              child: Text(
                                '₹${(line.unitPrice! * line.quantity).toStringAsFixed(2)}',
                              ),
                            ),
                          IconButton(
                            icon: const Icon(Icons.delete_outline),
                            onPressed: () => setState(() => _cart.remove(line)),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const Divider(),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Text(
                          s.lookup('s4.lib.counter_sale.estimated_total'),
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                      Text(
                        '₹${_estimatedTotal.toStringAsFixed(2)}',
                        style: const TextStyle(fontWeight: FontWeight.bold),
                      ),
                    ],
                  ),
                ],
              ),
      ),
    );
  }

  Widget _buildCustomerSection(AppStrings s) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SegmentedButton<bool>(
              segments: [
                ButtonSegment(
                  value: true,
                  label: Text(s.lookup('s4.lib.counter_sale.walk_in')),
                ),
                ButtonSegment(
                  value: false,
                  label: Text(
                    s.lookup('s4.lib.counter_sale.registered_patient'),
                  ),
                ),
              ],
              selected: {_walkIn},
              onSelectionChanged: (v) => setState(() => _walkIn = v.first),
            ),
            const SizedBox(height: 8),
            if (_walkIn) ...[
              TextField(
                key: const ValueKey('counter-sale-customer-name'),
                controller: _customerNameCtrl,
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.counter_sale.customer_name'),
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _customerPhoneCtrl,
                keyboardType: TextInputType.phone,
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.counter_sale.customer_phone'),
                ),
              ),
            ] else
              TextField(
                controller: _patientUidCtrl,
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.counter_sale.patient_uid'),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildRxSection(AppStrings s) {
    return Card(
      key: const ValueKey('counter-sale-rx'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              s.lookup('s4.lib.counter_sale.rx_section'),
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _rxDoctorCtrl,
              decoration: InputDecoration(
                labelText: s.lookup('s4.lib.counter_sale.rx_doctor'),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _rxRefCtrl,
              decoration: InputDecoration(
                labelText: s.lookup('s4.lib.counter_sale.rx_reference'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildWitnessSection(AppStrings s) {
    return Card(
      key: const ValueKey('counter-sale-witness'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              s.lookup('s4.lib.counter_sale.witness_section'),
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _witnessUidCtrl,
              decoration: InputDecoration(
                labelText: s.lookup('s4.lib.counter_sale.witness_uid'),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _witnessNameCtrl,
              decoration: InputDecoration(
                labelText: s.lookup('s4.lib.counter_sale.witness_name'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPaymentSection(AppStrings s) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DropdownButtonFormField<String>(
              key: const ValueKey('counter-sale-payment-mode'),
              initialValue: _paymentMode,
              decoration: InputDecoration(
                labelText: s.lookup('s4.lib.counter_sale.payment_mode'),
              ),
              items: _kPaymentModes
                  .map((m) => DropdownMenuItem(value: m, child: Text(m)))
                  .toList(),
              onChanged: (v) => setState(() => _paymentMode = v ?? 'CASH'),
            ),
            if (_paymentMode == 'CASH')
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  s.lookup('s4.lib.counter_sale.cash_drawer_hint'),
                  style: TextStyle(fontSize: 12, color: Colors.orange.shade800),
                ),
              )
            else ...[
              const SizedBox(height: 8),
              TextField(
                controller: _paymentRefCtrl,
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.counter_sale.payment_reference'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildRecentTab(AppStrings s) {
    if (_recentLoading && _recent.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_recent.isEmpty) {
      return Center(child: Text(s.lookup('s4.lib.counter_sale.no_recent')));
    }
    return RefreshIndicator(
      onRefresh: _loadRecent,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _recent.length,
        itemBuilder: (context, index) {
          final sale = _recent[index];
          final status = (sale['status'] ?? '').toString();
          final invoiceNumber = sale['invoice_number']?.toString();
          final total = (sale['total_amount'] as num?)?.toDouble() ?? 0;
          final who =
              sale['customer_name']?.toString() ??
              sale['patient_uid']?.toString() ??
              '';
          final statusColor = switch (status) {
            'COMPLETED' => AppTheme.successGreen,
            'VOIDED' => Colors.grey,
            _ => Colors.red.shade400,
          };
          return Card(
            child: ListTile(
              title: Text('${invoiceNumber ?? '#${sale['id']}'} · $who'),
              subtitle: Text(
                '₹${total.toStringAsFixed(2)} · ${sale['payment_mode'] ?? ''}',
              ),
              leading: Chip(
                label: Text(status, style: const TextStyle(fontSize: 11)),
                backgroundColor: statusColor.withValues(alpha: 0.15),
                visualDensity: VisualDensity.compact,
              ),
              trailing: status == 'COMPLETED'
                  ? TextButton(
                      key: ValueKey('counter-sale-void-${sale['id']}'),
                      onPressed: () => _voidSale(sale),
                      child: Text(s.lookup('s4.lib.counter_sale.void_action')),
                    )
                  : null,
            ),
          );
        },
      ),
    );
  }
}
