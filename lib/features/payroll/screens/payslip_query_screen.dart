import 'package:flutter/material.dart';
import '../../../core/services/staff_api_service.dart';

class PayslipQueryScreen extends StatefulWidget {
  const PayslipQueryScreen({super.key});

  @override
  State<PayslipQueryScreen> createState() => _PayslipQueryScreenState();
}

class _PayslipQueryScreenState extends State<PayslipQueryScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Payslip Queries'),
        backgroundColor: const Color(0xFF007A64),
        foregroundColor: Colors.white,
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: Colors.white,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white70,
          tabs: const [
            Tab(text: 'My Queries'),
            Tab(text: 'Raise Query'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: const [
          _MyQueriesTab(),
          _RaiseQueryTab(),
        ],
      ),
    );
  }
}

// ─── Tab 1: My Queries ────────────────────────────────────────────────────────

class _MyQueriesTab extends StatefulWidget {
  const _MyQueriesTab();

  @override
  State<_MyQueriesTab> createState() => _MyQueriesTabState();
}

class _MyQueriesTabState extends State<_MyQueriesTab> {
  List<dynamic> _queries = [];
  bool _loading = true;
  String? _error;
  int? _expanded;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final list = await StaffApiService.getMyPayslipQueries();
      if (mounted) setState(() => _queries = list);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'open': return Colors.orange;
      case 'in_review': return Colors.blue;
      case 'resolved': return Colors.green;
      default: return Colors.grey;
    }
  }

  static const _months = [
    '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Text(_error!, style: const TextStyle(color: Colors.red)),
        TextButton(onPressed: _load, child: const Text('Retry')),
      ]));
    }
    if (_queries.isEmpty) {
      return const Center(child: Text('No queries raised yet', style: TextStyle(color: Colors.grey)));
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _queries.length,
        itemBuilder: (context, i) {
          final q = _queries[i] as Map<String, dynamic>;
          final isExpanded = _expanded == q['id'];
          final month = q['month'] as int? ?? 1;
          final year = q['year'] as int? ?? 0;
          final replies = q['replies'] as List? ?? [];
          final status = q['status'] as String? ?? 'open';

          return Card(
            margin: const EdgeInsets.only(bottom: 8),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(10),
              side: BorderSide(color: isExpanded ? const Color(0xFF007A64) : Colors.transparent),
            ),
            child: Column(
              children: [
                ListTile(
                  onTap: () => setState(() => _expanded = isExpanded ? null : (q['id'] as int)),
                  title: Text(q['subject'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                  subtitle: Text(
                    '${_months[month]} $year · ${q['category'] ?? 'general'}',
                    style: const TextStyle(fontSize: 12),
                  ),
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    Chip(
                      label: Text(status, style: const TextStyle(fontSize: 11, color: Colors.white)),
                      backgroundColor: _statusColor(status),
                      padding: EdgeInsets.zero,
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    Icon(isExpanded ? Icons.expand_less : Icons.expand_more, color: Colors.grey),
                  ]),
                ),
                if (isExpanded) ...[
                  const Divider(height: 1),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(q['description'] ?? '', style: const TextStyle(fontSize: 13, color: Colors.black87)),
                        if (replies.isNotEmpty) ...[
                          const SizedBox(height: 12),
                          const Text('Replies', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12)),
                          const SizedBox(height: 6),
                          ...replies.map((r) {
                            final isStaff = (r['author_role'] ?? '') == 'STAFF';
                            return Align(
                              alignment: isStaff ? Alignment.centerRight : Alignment.centerLeft,
                              child: Container(
                                margin: const EdgeInsets.only(bottom: 6),
                                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.7),
                                decoration: BoxDecoration(
                                  color: isStaff
                                      ? const Color(0xFF007A64).withOpacity(0.1)
                                      : Colors.grey.shade100,
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      r['author_role'] ?? '',
                                      style: TextStyle(
                                        fontSize: 10,
                                        fontWeight: FontWeight.w600,
                                        color: isStaff ? const Color(0xFF007A64) : Colors.grey.shade600,
                                      ),
                                    ),
                                    const SizedBox(height: 2),
                                    Text(r['message'] ?? '', style: const TextStyle(fontSize: 13)),
                                  ],
                                ),
                              ),
                            );
                          }),
                        ],
                      ],
                    ),
                  ),
                ],
              ],
            ),
          );
        },
      ),
    );
  }
}

// ─── Tab 2: Raise Query ───────────────────────────────────────────────────────

class _RaiseQueryTab extends StatefulWidget {
  const _RaiseQueryTab();

  @override
  State<_RaiseQueryTab> createState() => _RaiseQueryTabState();
}

class _RaiseQueryTabState extends State<_RaiseQueryTab> {
  final _formKey = GlobalKey<FormState>();
  List<dynamic> _payslips = [];
  bool _loading = true;
  bool _submitting = false;

  int? _selectedPayslipId;
  String _category = 'general';
  final _subject = TextEditingController();
  final _description = TextEditingController();

  static const _categories = [
    'general', 'basic_salary', 'hra', 'deductions', 'overtime', 'advance', 'tds', 'pf', 'other'
  ];

  @override
  void initState() {
    super.initState();
    _loadPayslips();
  }

  @override
  void dispose() {
    _subject.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _loadPayslips() async {
    setState(() => _loading = true);
    try {
      final list = await StaffApiService.getMyPayslips(months: 3);
      if (mounted) setState(() => _payslips = list);
    } catch (e) { debugPrint('payslip_query_screen.dart: $e'); } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  static const _months = [
    '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    if (_selectedPayslipId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please select a payslip'), backgroundColor: Colors.orange),
      );
      return;
    }
    setState(() => _submitting = true);
    try {
      await StaffApiService.raisePayslipQuery({
        'payslip_id': _selectedPayslipId,
        'subject': _subject.text.trim(),
        'description': _description.text.trim(),
        'category': _category,
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Query raised successfully!'), backgroundColor: Color(0xFF007A64)),
        );
        _formKey.currentState!.reset();
        _subject.clear();
        _description.clear();
        setState(() { _selectedPayslipId = null; _category = 'general'; });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.toString().replaceFirst('Exception: ', '')), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Raise a Payslip Query', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            const SizedBox(height: 16),

            // Payslip selector
            const Text('Select Payslip *', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
            const SizedBox(height: 6),
            DropdownButtonFormField<int>(
              initialValue: _selectedPayslipId,
              decoration: InputDecoration(
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                hintText: 'Choose payslip',
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                isDense: true,
              ),
              items: _payslips.map<DropdownMenuItem<int>>((p) {
                final m = p['month'] as int? ?? 1;
                final y = p['year'] as int? ?? 0;
                return DropdownMenuItem(
                  value: p['id'] as int,
                  child: Text('${_months[m]} $y — ₹${(double.tryParse(p['net_salary']?.toString() ?? '0') ?? 0).toStringAsFixed(0)}'),
                );
              }).toList(),
              onChanged: (v) => setState(() => _selectedPayslipId = v),
            ),
            const SizedBox(height: 14),

            // Category
            const Text('Category *', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
            const SizedBox(height: 6),
            DropdownButtonFormField<String>(
              initialValue: _category,
              decoration: InputDecoration(
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                isDense: true,
              ),
              items: _categories.map((c) => DropdownMenuItem(value: c, child: Text(c.replaceAll('_', ' ')))).toList(),
              onChanged: (v) => setState(() => _category = v ?? 'general'),
            ),
            const SizedBox(height: 14),

            // Subject
            TextFormField(
              controller: _subject,
              decoration: InputDecoration(
                labelText: 'Subject *',
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                isDense: true,
              ),
              validator: (v) => (v == null || v.trim().isEmpty) ? 'Subject is required' : null,
            ),
            const SizedBox(height: 14),

            // Description
            TextFormField(
              controller: _description,
              maxLines: 4,
              decoration: InputDecoration(
                labelText: 'Description *',
                alignLabelWithHint: true,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              ),
              validator: (v) => (v == null || v.trim().isEmpty) ? 'Description is required' : null,
            ),
            const SizedBox(height: 20),

            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: _submitting ? null : _submit,
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF007A64),
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                ),
                child: _submitting
                    ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Text('Submit Query', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
