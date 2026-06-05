import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class InvestmentDeclarationScreen extends StatefulWidget {
  const InvestmentDeclarationScreen({super.key});

  @override
  State<InvestmentDeclarationScreen> createState() =>
      _InvestmentDeclarationScreenState();
}

class _InvestmentDeclarationScreenState
    extends State<InvestmentDeclarationScreen> {
  final _formKey = GlobalKey<FormState>();
  bool _loading = false;
  bool _submitting = false;
  List<dynamic> _declarations = [];

  // FY
  late String _selectedFY;

  // 80C controllers
  final _ppf = TextEditingController();
  final _epfVol = TextEditingController();
  final _elss = TextEditingController();
  final _lic = TextEditingController();
  final _nsc = TextEditingController();
  final _homeLoanPrincipal = TextEditingController();
  final _tuition = TextEditingController();
  final _other80c = TextEditingController();

  // 80D controllers
  final _hiSelf = TextEditingController();
  final _hiParents = TextEditingController();

  // Other deductions
  final _nps = TextEditingController();
  final _homeLoanInterest = TextEditingController();
  final _eduLoanInterest = TextEditingController();

  // Rent
  final _rentMonthly = TextEditingController();
  bool _rentReceipt = false;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    final m = now.month;
    final y = now.year;
    _selectedFY = m >= 4
        ? '$y-${(y + 1).toString().substring(2)}'
        : '${y - 1}-${y.toString().substring(2)}';
    _loadDeclarations();

    // Add listeners for live totals
    for (final c in _allControllers) {
      c.addListener(() => setState(() {}));
    }
  }

  List<TextEditingController> get _allControllers => [
    _ppf,
    _epfVol,
    _elss,
    _lic,
    _nsc,
    _homeLoanPrincipal,
    _tuition,
    _other80c,
    _hiSelf,
    _hiParents,
    _nps,
    _homeLoanInterest,
    _eduLoanInterest,
    _rentMonthly,
  ];

  @override
  void dispose() {
    for (final c in _allControllers) {
      c.dispose();
    }
    super.dispose();
  }

  double _val(TextEditingController c) =>
      double.tryParse(c.text.replaceAll(',', '')) ?? 0.0;

  double get _total80C {
    final raw =
        _val(_ppf) +
        _val(_epfVol) +
        _val(_elss) +
        _val(_lic) +
        _val(_nsc) +
        _val(_homeLoanPrincipal) +
        _val(_tuition) +
        _val(_other80c);
    return raw.clamp(0.0, 150000.0);
  }

  double get _total80D {
    final self = _val(_hiSelf).clamp(0.0, 25000.0);
    final parents = _val(_hiParents).clamp(0.0, 25000.0);
    return self + parents;
  }

  double get _npsDeduction => _val(_nps).clamp(0.0, 50000.0);
  double get _homeLoanInterestDeduction =>
      _val(_homeLoanInterest).clamp(0.0, 200000.0);
  double get _totalDeductions =>
      _total80C +
      _total80D +
      _npsDeduction +
      _homeLoanInterestDeduction +
      _val(_eduLoanInterest);

  List<String> get _fyOptions {
    final now = DateTime.now();
    final m = now.month;
    final y = now.year;
    return List.generate(3, (i) {
      final yr = m >= 4 ? y - i : y - 1 - i;
      return '$yr-${(yr + 1).toString().substring(2)}';
    });
  }

  Future<void> _loadDeclarations() async {
    setState(() {
      _loading = true;
    });
    try {
      final list = await HrApiService.getMyDeclarations();
      if (mounted) {
        setState(() {
          _declarations = list;
        });
        // Pre-fill if current FY declaration exists
        final existing = list.firstWhere(
          (d) => d['financial_year'] == _selectedFY,
          orElse: () => null,
        );
        if (existing != null) _prefill(existing);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: Colors.red.shade600,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _prefill(Map<String, dynamic> d) {
    void set(TextEditingController c, dynamic v) =>
        c.text = v != null && v != '0' && v != '0.00' ? '$v' : '';
    set(_ppf, d['ppf']);
    set(_epfVol, d['epf_voluntary']);
    set(_elss, d['elss']);
    set(_lic, d['lic_premium']);
    set(_nsc, d['nsc']);
    set(_homeLoanPrincipal, d['home_loan_principal']);
    set(_tuition, d['tuition_fees']);
    set(_other80c, d['other_80c']);
    set(_hiSelf, d['health_insurance_self']);
    set(_hiParents, d['health_insurance_parents']);
    set(_nps, d['nps_contribution']);
    set(_homeLoanInterest, d['home_loan_interest']);
    set(_eduLoanInterest, d['education_loan_interest']);
    set(_rentMonthly, d['rent_paid_monthly']);
    _rentReceipt = d['rent_receipt_provided'] == true;
    setState(() {});
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _submitting = true);
    try {
      await HrApiService.submitInvestmentDeclaration({
        'financial_year': _selectedFY,
        'ppf': _val(_ppf),
        'epf_voluntary': _val(_epfVol),
        'elss': _val(_elss),
        'lic_premium': _val(_lic),
        'nsc': _val(_nsc),
        'home_loan_principal': _val(_homeLoanPrincipal),
        'tuition_fees': _val(_tuition),
        'other_80c': _val(_other80c),
        'health_insurance_self': _val(_hiSelf),
        'health_insurance_parents': _val(_hiParents),
        'education_loan_interest': _val(_eduLoanInterest),
        'rent_paid_monthly': _val(_rentMonthly),
        'rent_receipt_provided': _rentReceipt,
        'home_loan_interest': _val(_homeLoanInterest),
        'nps_contribution': _val(_nps),
      });
      if (mounted) {
        final s = AppStrings.of(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.payrollDeclarationSubmittedSuccess),
            backgroundColor: const Color(0xFF007A64),
          ),
        );
        _loadDeclarations();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: Colors.red.shade600,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Widget _section(String title, List<Widget> fields) {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(12),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.04),
            blurRadius: 6,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: const Color(0xFF007A64).withValues(alpha: 0.08),
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(12),
                topRight: Radius.circular(12),
              ),
            ),
            child: Row(
              children: [
                const Icon(
                  Icons.label_outline,
                  size: 16,
                  color: Color(0xFF007A64),
                ),
                const SizedBox(width: 8),
                Text(
                  title,
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF007A64),
                    fontSize: 14,
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
            child: Column(children: fields),
          ),
        ],
      ),
    );
  }

  Widget _field(
    String label,
    TextEditingController controller, {
    String? hint,
    double? max,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: TextFormField(
        controller: controller,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[\d.]'))],
        decoration: InputDecoration(
          labelText: label,
          hintText: hint ?? '0',
          prefixText: '₹ ',
          suffixText: max != null ? '(max ₹${_fmtK(max)})' : null,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 12,
            vertical: 10,
          ),
          isDense: true,
        ),
        style: const TextStyle(fontSize: 14),
      ),
    );
  }

  String _fmtK(double v) {
    if (v >= 100000) return '${(v / 100000).toStringAsFixed(0)}L';
    if (v >= 1000) return '${(v / 1000).toStringAsFixed(0)}k';
    return v.toStringAsFixed(0);
  }

  String _fmtCurrency(double v) {
    return '₹${v.toStringAsFixed(0).replaceAllMapped(RegExp(r'(\d)(?=(\d{2})+(?!\d))'), (m) => '${m[1]},')}';
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.payrollDeclarationTitle),
        backgroundColor: const Color(0xFF007A64),
        foregroundColor: Colors.white,
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: DropdownButtonHideUnderline(
              child: DropdownButton<String>(
                value: _selectedFY,
                dropdownColor: AppTheme.cardSurface,
                style: TextStyle(
                  color: AppTheme.textPrimary,
                  fontWeight: FontWeight.w500,
                ),
                iconEnabledColor: Colors.white,
                selectedItemBuilder: (context) => _fyOptions
                    .map(
                      (fy) => Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          'FY $fy',
                          style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                    )
                    .toList(),
                items: _fyOptions
                    .map(
                      (fy) =>
                          DropdownMenuItem(value: fy, child: Text('FY $fy')),
                    )
                    .toList(),
                onChanged: (fy) {
                  if (fy == null) return;
                  setState(() => _selectedFY = fy);
                  final existing = _declarations.firstWhere(
                    (d) => d['financial_year'] == fy,
                    orElse: () => null,
                  );
                  if (existing != null) _prefill(existing);
                },
              ),
            ),
          ),
          const LogoutAction(),
        ],
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            // Totals summary card
            Container(
              padding: const EdgeInsets.all(16),
              margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF007A64), Color(0xFF00A685)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.payrollDeclarationEstimatedDeductions,
                    style: const TextStyle(color: Colors.white70, fontSize: 12),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceAround,
                    children: [
                      _TotalChip(
                        label: '80C (max ₹1.5L)',
                        value: _fmtCurrency(_total80C),
                        cap: _total80C >= 150000,
                      ),
                      _TotalChip(label: '80D', value: _fmtCurrency(_total80D)),
                      _TotalChip(
                        label: 'NPS',
                        value: _fmtCurrency(_npsDeduction),
                      ),
                    ],
                  ),
                  const Divider(color: Colors.white24, height: 20),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        s.payrollDeclarationTotalDeductions,
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      Text(
                        _fmtCurrency(_totalDeductions),
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 18,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),

            _section(s.payrollDeclarationSection80c, [
              _field(s.payrollDeclarationFieldPpf, _ppf),
              _field(s.payrollDeclarationFieldEpf, _epfVol),
              _field(s.payrollDeclarationFieldElss, _elss),
              _field(s.payrollDeclarationFieldLic, _lic),
              _field(s.payrollDeclarationFieldNsc, _nsc),
              _field(
                s.payrollDeclarationFieldHomeLoanPrincipal,
                _homeLoanPrincipal,
              ),
              _field(s.payrollDeclarationFieldTuition, _tuition),
              _field(s.payrollDeclarationFieldOther80c, _other80c),
            ]),

            _section(s.payrollDeclarationSection80d, [
              _field(s.payrollDeclarationFieldHiSelf, _hiSelf, max: 25000),
              _field(
                s.payrollDeclarationFieldHiParents,
                _hiParents,
                max: 25000,
              ),
            ]),

            _section(s.payrollDeclarationSectionOther, [
              _field(s.payrollDeclarationFieldNps, _nps, max: 50000),
              _field(
                s.payrollDeclarationFieldHomeLoanInterest,
                _homeLoanInterest,
                max: 200000,
              ),
              _field(s.payrollDeclarationFieldEduLoan, _eduLoanInterest),
            ]),

            _section(s.payrollDeclarationSectionRent, [
              _field(s.payrollDeclarationFieldRentMonthly, _rentMonthly),
              SwitchListTile(
                value: _rentReceipt,
                onChanged: (v) => setState(() => _rentReceipt = v),
                title: Text(
                  s.payrollDeclarationRentReceipts,
                  style: const TextStyle(fontSize: 14),
                ),
                activeThumbColor: const Color(0xFF007A64),
                contentPadding: EdgeInsets.zero,
              ),
            ]),

            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: _submitting ? null : _submit,
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF007A64),
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
                child: _submitting
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : Text(
                        s.payrollDeclarationSubmitButton,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
              ),
            ),
            const SizedBox(height: 24),

            if (_declarations.isNotEmpty) ...[
              Text(
                s.payrollDeclarationPastTitle,
                style: const TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: 16,
                ),
              ),
              const SizedBox(height: 8),
              ..._declarations.map((d) => _DeclarationCard(d: d)),
            ],
          ],
        ),
      ),
    );
  }
}

class _TotalChip extends StatelessWidget {
  final String label;
  final String value;
  final bool cap;
  const _TotalChip({
    required this.label,
    required this.value,
    this.cap = false,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(
          value,
          style: TextStyle(
            color: cap ? Colors.amber.shade300 : Colors.white,
            fontWeight: FontWeight.bold,
            fontSize: 15,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          label,
          style: const TextStyle(color: Colors.white70, fontSize: 10),
        ),
      ],
    );
  }
}

class _DeclarationCard extends StatelessWidget {
  final Map<String, dynamic> d;
  const _DeclarationCard({required this.d});

  Color get _statusColor {
    switch (d['status']) {
      case 'approved':
        return Colors.green;
      case 'submitted':
        return Colors.blue;
      case 'locked':
        return Colors.purple;
      default:
        return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        title: Text(
          'FY ${d['financial_year']}',
          style: const TextStyle(fontWeight: FontWeight.w600),
        ),
        subtitle: Text(
          'Submitted: ${d['submitted_at'] != null ? d['submitted_at'].toString().split('T')[0] : '—'}',
        ),
        trailing: Chip(
          label: Text(
            d['status'] ?? '—',
            style: const TextStyle(fontSize: 11, color: Colors.white),
          ),
          backgroundColor: _statusColor,
          padding: EdgeInsets.zero,
          materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      ),
    );
  }
}
