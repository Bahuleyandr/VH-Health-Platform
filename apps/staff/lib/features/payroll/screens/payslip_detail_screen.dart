import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class PayslipDetailScreen extends StatefulWidget {
  final String payslipId;
  final String monthLabel;

  const PayslipDetailScreen({
    super.key,
    required this.payslipId,
    required this.monthLabel,
  });

  @override
  State<PayslipDetailScreen> createState() => _PayslipDetailScreenState();
}

class _PayslipDetailScreenState extends State<PayslipDetailScreen> {
  Map<String, dynamic>? _payslip;
  bool _loading = true;
  String? _error;
  bool _downloadingPdf = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await HrApiService.getPayslipDetail(widget.payslipId);
      if (mounted) setState(() => _payslip = data);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _downloadPDF() async {
    final s = AppStrings.of(context);
    final pdfUrl = _payslip?['pdf_url'] as String?;
    if (pdfUrl == null || pdfUrl.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.payrollDetailPdfNotAvailable),
            backgroundColor: Colors.orange,
          ),
        );
      }
      return;
    }

    setState(() => _downloadingPdf = true);
    try {
      final uri = Uri.parse(pdfUrl);
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri, mode: LaunchMode.externalApplication);
      } else {
        throw Exception('Cannot open URL');
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              '${s.payrollDetailPdfFailedPrefix} ${e.toString().replaceFirst('Exception: ', '')}',
            ),
            backgroundColor: Colors.red,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _downloadingPdf = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: const Color(0xFFE0F5F6),
      appBar: AppBar(
        title: Text('${s.payrollDetailTitlePrefix} — ${widget.monthLabel}'),
        backgroundColor: const Color(0xFF007A64),
        foregroundColor: Colors.white,
        actions: [
          if (_payslip != null && _payslip!['pdf_key'] != null)
            _downloadingPdf
                ? const Padding(
                    padding: EdgeInsets.all(16),
                    child: SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    ),
                  )
                : IconButton(
                    icon: const Icon(Icons.download_outlined),
                    onPressed: _downloadPDF,
                    tooltip: s.payrollDetailDownloadPdf,
                  ),
          const LogoutAction(),
        ],
      ),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: Color(0xFF007A64)),
            )
          : _error != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.error_outline,
                      size: 48,
                      color: Colors.red.shade300,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      _error!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Colors.red),
                    ),
                    const SizedBox(height: 16),
                    ElevatedButton(
                      onPressed: _load,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF007A64),
                        foregroundColor: Colors.white,
                      ),
                      child: Text(s.actionRetry),
                    ),
                  ],
                ),
              ),
            )
          : _payslip == null
          ? Center(child: Text(s.payrollDetailNotFound))
          : _buildBody(),
    );
  }

  Widget _buildBody() {
    final s = AppStrings.of(context);
    final p = _payslip!;
    final fmt = NumberFormat('#,##,##0.00');
    final hasPDF = p['pdf_key'] != null;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          // ─── Net Pay Hero ───────────────────────────────────────────────
          Card(
            color: const Color(0xFF007A64),
            elevation: 4,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
            ),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                children: [
                  Text(
                    s.payrollPayslipNetPay,
                    style: const TextStyle(color: Colors.white70, fontSize: 13),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    '₹${fmt.format(p['net_salary'] ?? 0)}',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 34,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    widget.monthLabel,
                    style: const TextStyle(color: Colors.white70, fontSize: 13),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),

          // ─── FEATURE 2: Revision note banner ────────────────────────────
          if (p['revision_note'] != null &&
              (p['revision_note'] as String).isNotEmpty) ...[
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              margin: const EdgeInsets.only(bottom: 12),
              decoration: BoxDecoration(
                color: const Color(0xFFE8F5F3),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: const Color(0xFF007A64).withValues(alpha: 0.4),
                ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.info_outline,
                    color: Color(0xFF007A64),
                    size: 18,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      p['revision_note'] as String,
                      style: const TextStyle(
                        fontSize: 12,
                        color: Color(0xFF007A64),
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],

          // ─── Attendance ─────────────────────────────────────────────────
          _Section(
            title: s.payrollDetailAttendanceHeader,
            rows: [
              _Row(s.payrollDetailWorkingDays, '${p['total_working_days'] ?? 0}'),
              _Row(s.payrollDetailDaysPresent, '${p['days_present'] ?? 0}', isGood: true),
              _Row(
                s.payrollDetailDaysAbsent,
                '${p['days_absent'] ?? 0}',
                isBad: (p['days_absent'] as num? ?? 0) > 0,
              ),
              // FEATURE 5: LOP line item
              if ((p['lop_days'] as num? ?? 0) > 0)
                _Row(s.payrollDetailLopDays, '${p['lop_days']}', isBad: true),
              _Row(s.payrollDetailLeaveDays, '${p['days_leave'] ?? 0}'),
              _Row(
                s.payrollDetailOvertimeHours,
                '${(p['overtime_hours'] as num?)?.toStringAsFixed(1) ?? '0.0'} hrs',
              ),
            ],
          ),

          // ─── Earnings ───────────────────────────────────────────────────
          _Section(
            title: s.payrollDetailEarningsHeader,
            rows: [
              if ((p['basic_earned'] as num? ?? 0) > 0)
                _Row(s.payrollDetailBasic, '₹${fmt.format(p['basic_earned'])}'),
              if ((p['hra_earned'] as num? ?? 0) > 0)
                _Row(s.payrollDetailHra, '₹${fmt.format(p['hra_earned'])}'),
              if ((p['da_earned'] as num? ?? 0) > 0)
                _Row(s.payrollDetailDa, '₹${fmt.format(p['da_earned'])}'),
              if ((p['special_allowance_earned'] as num? ?? 0) > 0)
                _Row(
                  s.payrollDetailSpecialAllowance,
                  '₹${fmt.format(p['special_allowance_earned'])}',
                ),
              if ((p['transport_allowance_earned'] as num? ?? 0) > 0)
                _Row(
                  s.payrollDetailTransportAllowance,
                  '₹${fmt.format(p['transport_allowance_earned'])}',
                ),
              if ((p['medical_allowance_earned'] as num? ?? 0) > 0)
                _Row(
                  s.payrollDetailMedicalAllowance,
                  '₹${fmt.format(p['medical_allowance_earned'])}',
                ),
              if ((p['overtime_pay'] as num? ?? 0) > 0)
                _Row(s.payrollDetailOvertimePay, '₹${fmt.format(p['overtime_pay'])}'),
              if ((p['bonus_this_month'] as num? ?? 0) > 0)
                _Row(s.payrollDetailBonus, '₹${fmt.format(p['bonus_this_month'])}'),
              // FEATURE 4: Arrears
              if ((p['arrears_amount'] as num? ?? 0) > 0)
                _Row(
                  s.payrollDetailArrears,
                  '₹${fmt.format(p['arrears_amount'])}',
                  isGood: true,
                ),
              _Row(
                s.payrollDetailGrossSalary,
                '₹${fmt.format(p['gross_salary'] ?? 0)}',
                isBold: true,
                color: const Color(0xFF007A64),
              ),
            ],
          ),

          // ─── Deductions ─────────────────────────────────────────────────
          _Section(
            title: s.payrollDetailDeductionsHeader,
            rows: [
              // FEATURE 5: LOP deduction
              if ((p['lop_days'] as num? ?? 0) > 0)
                _Row(
                  '${s.payrollDetailLopDeduction} (${p['lop_days']})',
                  '₹${fmt.format(p['lop_deduction'] ?? 0)}',
                  isBad: true,
                ),
              if ((p['pf_employee'] as num? ?? 0) > 0)
                _Row(s.payrollDetailPfEmployee, '₹${fmt.format(p['pf_employee'])}'),
              if ((p['esi_employee'] as num? ?? 0) > 0)
                _Row(s.payrollDetailEsi, '₹${fmt.format(p['esi_employee'])}'),
              if ((p['professional_tax'] as num? ?? 0) > 0)
                _Row(
                  s.payrollDetailProfessionalTax,
                  '₹${fmt.format(p['professional_tax'])}',
                ),
              if ((p['tds'] as num? ?? 0) > 0)
                _Row(s.payrollDetailTds, '₹${fmt.format(p['tds'])}'),
              // FEATURE 3: Advance deduction
              if ((p['advance_deduction'] as num? ?? 0) > 0)
                _Row(
                  s.payrollDetailAdvanceDeduction,
                  '₹${fmt.format(p['advance_deduction'])}',
                  isBad: true,
                ),
              _Row(
                s.payrollDetailTotalDeductions,
                '₹${fmt.format(p['total_deductions'] ?? 0)}',
                isBold: true,
                color: Colors.red.shade700,
              ),
            ],
          ),

          // ─── PDF Download ────────────────────────────────────────────────
          if (hasPDF) ...[
            const SizedBox(height: 4),
            SizedBox(
              width: double.infinity,
              height: 52,
              child: ElevatedButton.icon(
                onPressed: _downloadingPdf ? null : _downloadPDF,
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF007A64),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
                icon: _downloadingPdf
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : const Icon(Icons.download_outlined, color: Colors.white),
                label: Text(
                  _downloadingPdf ? s.payrollDetailOpening : s.payrollDetailPdfDownloadButton,
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.bold,
                    fontSize: 15,
                  ),
                ),
              ),
            ),
          ] else ...[
            const SizedBox(height: 4),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Colors.orange.shade50,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Colors.orange.shade200),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.info_outline,
                    color: Colors.orange.shade700,
                    size: 18,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      s.payrollDetailPdfBeingGenerated,
                      style: TextStyle(
                        fontSize: 12,
                        color: Colors.orange.shade700,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

class _Row {
  final String label;
  final String value;
  final bool isBold;
  final bool isGood;
  final bool isBad;
  final Color? color;

  const _Row(
    this.label,
    this.value, {
    this.isBold = false,
    this.isGood = false,
    this.isBad = false,
    this.color,
  });
}

class _Section extends StatelessWidget {
  final String title;
  final List<_Row> rows;

  const _Section({required this.title, required this.rows});

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
            Text(
              title,
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
            ),
            const Divider(height: 16),
            ...rows.map(
              (row) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        row.label,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: row.isBold
                              ? FontWeight.bold
                              : FontWeight.normal,
                          color: Colors.grey.shade700,
                        ),
                      ),
                    ),
                    Text(
                      row.value,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: row.isBold
                            ? FontWeight.bold
                            : FontWeight.normal,
                        color:
                            row.color ??
                            (row.isBold
                                ? Colors.black87
                                : row.isGood
                                ? Colors.green.shade700
                                : row.isBad
                                ? Colors.red.shade500
                                : Colors.black87),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
