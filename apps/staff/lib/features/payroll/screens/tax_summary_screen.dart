import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/services/hr_api_service.dart';

class TaxSummaryScreen extends StatefulWidget {
  const TaxSummaryScreen({super.key});

  @override
  State<TaxSummaryScreen> createState() => _TaxSummaryScreenState();
}

class _TaxSummaryScreenState extends State<TaxSummaryScreen> {
  Map<String, dynamic>? _summary;
  bool _loading = true;
  String? _error;
  String _selectedFY = '';

  // Build list of last 3 financial years
  List<String> get _fyOptions {
    final now = DateTime.now();
    // Current FY: if month >= April (4), FY is currentYear-nextYear; else prevYear-currentYear
    final currentFYStart = now.month >= 4 ? now.year : now.year - 1;
    return List.generate(3, (i) {
      final start = currentFYStart - i;
      final end = (start + 1) % 100;
      return '$start-${end.toString().padLeft(2, '0')}';
    });
  }

  @override
  void initState() {
    super.initState();
    _selectedFY = _fyOptions.first;
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await HrApiService.getMyTaxSummary(fy: _selectedFY);
      if (mounted) setState(() => _summary = data);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _downloadPDF() async {
    final pdfUrl = _summary?['pdf_url'] as String?;
    if (pdfUrl == null || pdfUrl.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('PDF not available yet'),
          backgroundColor: Colors.orange,
        ),
      );
      return;
    }
    final uri = Uri.parse(pdfUrl);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFE0F5F6),
      appBar: AppBar(
        title: const Text('Annual Tax Summary'),
        backgroundColor: const Color(0xFF007A64),
        foregroundColor: Colors.white,
        actions: [
          if (_summary != null && _summary!['pdf_url'] != null)
            IconButton(
              icon: const Icon(Icons.download_outlined),
              onPressed: _downloadPDF,
              tooltip: 'Download PDF',
            ),
        ],
      ),
      body: Column(
        children: [
          // FY Selector
          Container(
            color: const Color(0xFF007A64).withValues(alpha: 0.08),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Row(
              children: [
                const Text(
                  'Financial Year:',
                  style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: DropdownButtonHideUnderline(
                    child: DropdownButton<String>(
                      value: _selectedFY,
                      isDense: true,
                      items: _fyOptions
                          .map((fy) => DropdownMenuItem(
                                value: fy,
                                child: Text('FY $fy'),
                              ))
                          .toList(),
                      onChanged: (fy) {
                        if (fy != null && fy != _selectedFY) {
                          setState(() => _selectedFY = fy);
                          _load();
                        }
                      },
                    ),
                  ),
                ),
              ],
            ),
          ),

          // Body
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator(color: Color(0xFF007A64)))
                : _error != null
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(Icons.error_outline, size: 48, color: Colors.red.shade300),
                              const SizedBox(height: 12),
                              Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: Colors.red)),
                              const SizedBox(height: 16),
                              ElevatedButton(
                                onPressed: _load,
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: const Color(0xFF007A64),
                                  foregroundColor: Colors.white,
                                ),
                                child: const Text('Retry'),
                              ),
                            ],
                          ),
                        ),
                      )
                    : _summary == null
                        ? const Center(child: Text('No data'))
                        : _buildBody(),
          ),
        ],
      ),
    );
  }

  Widget _buildBody() {
    final s = _summary!;
    final fmt = NumberFormat('#,##,##0.00');

    String fmtAmt(dynamic v) => '₹${fmt.format(double.tryParse(v?.toString() ?? '0') ?? 0)}';

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // ─── Summary Cards ──────────────────────────────────────────────
          Row(
            children: [
              Expanded(
                child: _SummaryCard(
                  label: 'Total Gross',
                  value: fmtAmt(s['total_gross']),
                  icon: Icons.trending_up,
                  color: const Color(0xFF007A64),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _SummaryCard(
                  label: 'Total Net',
                  value: fmtAmt(s['total_net']),
                  icon: Icons.account_balance_wallet_outlined,
                  color: Colors.blue.shade700,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: _SummaryCard(
                  label: 'Taxable Income',
                  value: fmtAmt(s['taxable_income']),
                  icon: Icons.calculate_outlined,
                  color: Colors.orange.shade700,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _SummaryCard(
                  label: 'Tax Payable',
                  value: fmtAmt(s['tax_payable']),
                  icon: Icons.receipt_long_outlined,
                  color: Colors.red.shade700,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            '${s['months_included'] ?? 0} payslips included in FY $_selectedFY',
            style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
          ),
          const SizedBox(height: 16),

          // ─── Earnings Breakdown ─────────────────────────────────────────
          _DetailCard(
            title: '💰 Earnings Breakdown',
            rows: [
              if ((double.tryParse(s['total_basic']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('Basic Salary', fmtAmt(s['total_basic'])),
              if ((double.tryParse(s['total_hra']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('HRA', fmtAmt(s['total_hra'])),
              if ((double.tryParse(s['total_da']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('DA', fmtAmt(s['total_da'])),
              if ((double.tryParse(s['total_special_allowance']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('Special Allowance', fmtAmt(s['total_special_allowance'])),
              if ((double.tryParse(s['total_transport_allowance']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('Transport Allowance', fmtAmt(s['total_transport_allowance'])),
              if ((double.tryParse(s['total_medical_allowance']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('Medical Allowance', fmtAmt(s['total_medical_allowance'])),
              if ((double.tryParse(s['total_overtime']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('Overtime Pay', fmtAmt(s['total_overtime'])),
              if ((double.tryParse(s['total_bonus']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('Bonus', fmtAmt(s['total_bonus'])),
              if ((double.tryParse(s['total_arrears']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('Arrears', fmtAmt(s['total_arrears'])),
              _DetailRow('Total Gross', fmtAmt(s['total_gross']), isBold: true),
            ],
          ),

          // ─── Deductions Breakdown ────────────────────────────────────────
          _DetailCard(
            title: '📉 Deductions Breakdown',
            rows: [
              if ((double.tryParse(s['total_pf']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('Provident Fund (PF)', fmtAmt(s['total_pf'])),
              if ((double.tryParse(s['total_esi']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('ESI', fmtAmt(s['total_esi'])),
              if ((double.tryParse(s['total_professional_tax']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('Professional Tax', fmtAmt(s['total_professional_tax'])),
              if ((double.tryParse(s['total_tds']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('TDS Deducted', fmtAmt(s['total_tds'])),
              if ((double.tryParse(s['total_advance_deductions']?.toString() ?? '0') ?? 0) > 0)
                _DetailRow('Salary Advance Deductions', fmtAmt(s['total_advance_deductions'])),
              _DetailRow('Total Deductions', fmtAmt(s['total_deductions']), isBold: true),
            ],
          ),

          // ─── Tax Computation ─────────────────────────────────────────────
          _DetailCard(
            title: '🧾 Tax Computation (New Regime)',
            rows: [
              _DetailRow('Total Gross Income', fmtAmt(s['total_gross'])),
              _DetailRow('Less: Provident Fund', '- ${fmtAmt(s['total_pf'])}'),
              _DetailRow('Less: Professional Tax', '- ${fmtAmt(s['total_professional_tax'])}'),
              const _DetailRow('Less: Standard Deduction', '- ₹50,000'),
              _DetailRow('Taxable Income', fmtAmt(s['taxable_income']), isBold: true),
              _DetailRow('Tax Payable (incl. 4% cess)', fmtAmt(s['tax_payable']), isBold: true),
            ],
          ),

          // ─── Disclaimer ──────────────────────────────────────────────────
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            margin: const EdgeInsets.only(top: 4),
            decoration: BoxDecoration(
              color: Colors.amber.shade50,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: Colors.amber.shade300),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.warning_amber_outlined, color: Colors.amber.shade700, size: 18),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'This is indicative only, calculated under the New Tax Regime (FY $_selectedFY slabs). '
                    'Actual Form 16 will be issued by your employer at the end of the financial year.',
                    style: TextStyle(fontSize: 11, color: Colors.amber.shade900),
                  ),
                ),
              ],
            ),
          ),

          if (_summary?['pdf_url'] != null) ...[
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              height: 52,
              child: ElevatedButton.icon(
                onPressed: _downloadPDF,
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF007A64),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                icon: const Icon(Icons.download_outlined, color: Colors.white),
                label: const Text(
                  'Download Form 16 PDF',
                  style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 15),
                ),
              ),
            ),
          ],
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

class _SummaryCard extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;
  final Color color;

  const _SummaryCard({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, color: color, size: 18),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    label,
                    style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              value,
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.bold,
                color: color,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DetailRow {
  final String label;
  final String value;
  final bool isBold;

  const _DetailRow(this.label, this.value, {this.isBold = false});
}

class _DetailCard extends StatelessWidget {
  final String title;
  final List<_DetailRow> rows;

  const _DetailCard({required this.title, required this.rows});

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      elevation: 1,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
            const Divider(height: 16),
            ...rows.map((row) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      row.label,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: row.isBold ? FontWeight.bold : FontWeight.normal,
                        color: Colors.grey.shade700,
                      ),
                    ),
                  ),
                  Text(
                    row.value,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: row.isBold ? FontWeight.bold : FontWeight.normal,
                      color: row.isBold ? Colors.black87 : Colors.grey.shade800,
                    ),
                  ),
                ],
              ),
            )),
          ],
        ),
      ),
    );
  }
}
