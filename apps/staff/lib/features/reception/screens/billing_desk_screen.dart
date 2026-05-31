import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/services/billing_api_service.dart';
import '../../../core/services/patient_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../widgets/billing_payment_dialog.dart';

class BillingDeskScreen extends StatefulWidget {
  final String? prefillPatientUid;
  final String? prefillPatientName;
  final String? prefillPatientPhone;

  const BillingDeskScreen({
    super.key,
    this.prefillPatientUid,
    this.prefillPatientName,
    this.prefillPatientPhone,
  });

  @override
  State<BillingDeskScreen> createState() => _BillingDeskScreenState();
}

class _BillingDeskScreenState extends State<BillingDeskScreen> {
  final _searchCtrl = TextEditingController();
  Timer? _searchDebounce;

  bool _lookupBusy = false;
  bool _invoiceBusy = false;
  bool _actionBusy = false;
  String? _error;
  List<Map<String, dynamic>> _patientMatches = const [];
  Map<String, dynamic>? _selectedPatient;
  List<Map<String, dynamic>> _invoices = const [];

  @override
  void initState() {
    super.initState();
    final uid = widget.prefillPatientUid;
    if (uid != null && uid.trim().isNotEmpty) {
      _selectedPatient = {
        'uid': uid,
        if (widget.prefillPatientName != null)
          'name': widget.prefillPatientName,
        if (widget.prefillPatientPhone != null)
          'phone': widget.prefillPatientPhone,
      };
      _searchCtrl.text = _patientLabel(_selectedPatient!);
      _loadInvoices();
    }
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  void _queuePatientLookup(String value) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(
      const Duration(milliseconds: 280),
      () => _searchPatients(value),
    );
  }

  Future<void> _searchPatients(String value) async {
    final query = value.trim();
    if (query.length < 2) {
      setState(() {
        _patientMatches = const [];
        _error = null;
      });
      return;
    }
    setState(() {
      _lookupBusy = true;
      _error = null;
    });
    try {
      final matches = await PatientApiService.search(query, limit: 12);
      if (!mounted) return;
      setState(() {
        _patientMatches = matches;
        _lookupBusy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _lookupBusy = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _selectPatient(Map<String, dynamic> patient) async {
    setState(() {
      _selectedPatient = patient;
      _patientMatches = const [];
      _searchCtrl.text = _patientLabel(patient);
    });
    await _loadInvoices();
  }

  Future<void> _loadInvoices() async {
    final uid = _selectedPatient?['uid']?.toString();
    if (uid == null || uid.isEmpty) return;
    setState(() {
      _invoiceBusy = true;
      _error = null;
    });
    try {
      final invoices = await BillingApiService.listInvoices(
        patientUid: uid,
        limit: 30,
      );
      if (!mounted) return;
      setState(() {
        _invoices = invoices;
        _invoiceBusy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _invoiceBusy = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _createDraftInvoice() async {
    final patient = _selectedPatient;
    final uid = patient?['uid']?.toString();
    if (uid == null || uid.isEmpty) return;
    setState(() => _actionBusy = true);
    try {
      await BillingApiService.createDraftInvoice(
        patientUid: uid,
        patientName: patient?['name']?.toString(),
        patientPhone: patient?['phone']?.toString(),
        invoiceType: 'OP',
        department: 'Front Office',
        notes: 'Front office draft invoice',
      );
      await _loadInvoices();
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Draft invoice created')));
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
  }

  Future<void> _issueInvoice(Map<String, dynamic> invoice) async {
    final id = int.tryParse(invoice['id']?.toString() ?? '');
    if (id == null) return;
    setState(() => _actionBusy = true);
    try {
      await BillingApiService.issueInvoice(id);
      await _loadInvoices();
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Invoice issued')));
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _actionBusy = false);
    }
  }

  Future<void> _collectInvoicePayment(Map<String, dynamic> invoice) async {
    final collected = await showBillingPaymentDialog(
      context: context,
      invoice: invoice,
    );
    if (!collected || !mounted) return;
    await _loadInvoices();
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('Payment collected')));
  }

  String _patientLabel(Map<String, dynamic> patient) {
    final hn = patient['hospital_number']?.toString();
    final name = patient['name']?.toString();
    final phone = patient['phone']?.toString();
    return [
      if (hn != null && hn.isNotEmpty) hn,
      if (name != null && name.isNotEmpty) name,
      if (phone != null && phone.isNotEmpty) phone,
    ].join(' - ');
  }

  num _sumDue() => _invoices.fold<num>(
    0,
    (sum, invoice) => sum + billingInvoiceAmountDue(invoice),
  );

  String _money(dynamic value) => billingMoney(value);

  @override
  Widget build(BuildContext context) {
    final selected = _selectedPatient;
    return StaffScaffold(
      title: 'Billing Desk',
      body: RefreshIndicator(
        onRefresh: _loadInvoices,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth >= 940;
            return ListView(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
              children: [
                _buildHeader(),
                const SizedBox(height: 12),
                if (_error != null) ...[
                  _InlineAlert(message: _error!, color: AppTheme.errorRed),
                  const SizedBox(height: 12),
                ],
                if (wide)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(child: _buildPatientPanel()),
                      const SizedBox(width: 12),
                      Expanded(flex: 2, child: _buildInvoicePanel(selected)),
                    ],
                  )
                else ...[
                  _buildPatientPanel(),
                  const SizedBox(height: 12),
                  _buildInvoicePanel(selected),
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildHeader() {
    return _Surface(
      child: Wrap(
        spacing: 12,
        runSpacing: 12,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: AppTheme.primaryBlue.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(Icons.receipt_long, color: AppTheme.primaryBlue),
          ),
          ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 220, maxWidth: 460),
            child: Text(
              'Billing Desk',
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
          ),
          _Metric(
            icon: Icons.receipt_long_outlined,
            label: 'Invoices',
            value: '${_invoices.length}',
            color: AppTheme.primaryBlue,
          ),
          _Metric(
            icon: Icons.payments_outlined,
            label: 'Due',
            value: _money(_sumDue()),
            color: AppTheme.warningAmber,
          ),
          IconButton.filledTonal(
            tooltip: 'Refresh',
            onPressed: _loadInvoices,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
    );
  }

  Widget _buildPatientPanel() {
    final selected = _selectedPatient;
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionTitle(icon: Icons.manage_search, title: 'Patient'),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _searchCtrl,
                  onChanged: _queuePatientLookup,
                  onSubmitted: _searchPatients,
                  decoration: InputDecoration(
                    labelText: 'Hospital ID / phone / name',
                    prefixIcon: const Icon(Icons.search),
                    suffixIcon: _lookupBusy
                        ? const Padding(
                            padding: EdgeInsets.all(12),
                            child: SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          )
                        : null,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              IconButton.filledTonal(
                tooltip: 'Search',
                onPressed: () => _searchPatients(_searchCtrl.text),
                icon: const Icon(Icons.search),
              ),
            ],
          ),
          if (selected != null) ...[
            const SizedBox(height: 10),
            _PatientCard(patient: selected, selected: true, onTap: () {}),
          ],
          if (_patientMatches.isNotEmpty) ...[
            const SizedBox(height: 10),
            ..._patientMatches.map(
              (patient) => Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _PatientCard(
                  patient: patient,
                  onTap: () => _selectPatient(patient),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildInvoicePanel(Map<String, dynamic>? selected) {
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.receipt,
            title: 'Invoices',
            trailing: selected == null
                ? null
                : FilledButton.icon(
                    onPressed: _actionBusy ? null : _createDraftInvoice,
                    icon: _actionBusy
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.add),
                    label: const Text('Draft OP'),
                  ),
          ),
          const SizedBox(height: 10),
          if (selected == null)
            const _EmptyLine(
              icon: Icons.person_search,
              text: 'Select a patient',
            )
          else if (_invoiceBusy)
            const LinearProgressIndicator(minHeight: 2)
          else if (_invoices.isEmpty)
            const _EmptyLine(
              icon: Icons.receipt_long,
              text: 'No invoices found',
            )
          else
            ..._invoices.map(_invoiceTile),
        ],
      ),
    );
  }

  Widget _invoiceTile(Map<String, dynamic> invoice) {
    final id = invoice['invoice_number'] ?? '#${invoice['id']}';
    final status = invoice['status']?.toString().toUpperCase() ?? 'DRAFT';
    final isDraft = status == 'DRAFT';
    final due = billingInvoiceAmountDue(invoice);
    final canCollect = billingInvoiceCanCollect(invoice);
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.backgroundGrey,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Row(
        children: [
          CircleAvatar(
            backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.12),
            child: const Icon(Icons.receipt_long_outlined),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  id.toString(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w800),
                ),
                Text(
                  '${invoice['invoice_type'] ?? 'OP'} - $status',
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                _money(due),
                style: const TextStyle(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 6),
              if (isDraft)
                SizedBox(
                  height: 34,
                  child: OutlinedButton.icon(
                    onPressed: _actionBusy
                        ? null
                        : () => _issueInvoice(invoice),
                    icon: const Icon(Icons.publish_outlined, size: 16),
                    label: const Text('Issue'),
                  ),
                ),
              if (canCollect)
                SizedBox(
                  height: 34,
                  child: FilledButton.icon(
                    onPressed: _actionBusy
                        ? null
                        : () => _collectInvoicePayment(invoice),
                    icon: const Icon(Icons.payments_outlined, size: 16),
                    label: const Text('Collect'),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Surface extends StatelessWidget {
  final Widget child;

  const _Surface({required this.child});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: child,
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final IconData icon;
  final String title;
  final Widget? trailing;

  const _SectionTitle({required this.icon, required this.title, this.trailing});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, color: AppTheme.primaryBlue),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            title,
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
        ),
        ?trailing,
      ],
    );
  }
}

class _Metric extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color color;

  const _Metric({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minWidth: 132),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, color: color),
          const SizedBox(width: 8),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                    color: color,
                  ),
                ),
                Text(label, style: TextStyle(color: AppTheme.textSecondary)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _PatientCard extends StatelessWidget {
  final Map<String, dynamic> patient;
  final bool selected;
  final VoidCallback onTap;

  const _PatientCard({
    required this.patient,
    required this.onTap,
    this.selected = false,
  });

  @override
  Widget build(BuildContext context) {
    final name = patient['name']?.toString() ?? 'Patient';
    final phone = patient['phone']?.toString();
    final hn = patient['hospital_number']?.toString();
    return Material(
      color: selected
          ? AppTheme.primaryBlue.withValues(alpha: 0.08)
          : Colors.transparent,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Row(
            children: [
              CircleAvatar(
                backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.14),
                child: const Icon(Icons.person_outline),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w800),
                    ),
                    Text(
                      [
                        if (hn != null && hn.isNotEmpty) hn,
                        if (phone != null && phone.isNotEmpty) phone,
                      ].join(' - '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right),
            ],
          ),
        ),
      ),
    );
  }
}

class _EmptyLine extends StatelessWidget {
  final IconData icon;
  final String text;

  const _EmptyLine({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Icon(icon, color: AppTheme.textSecondary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: TextStyle(color: AppTheme.textSecondary)),
          ),
        ],
      ),
    );
  }
}

class _InlineAlert extends StatelessWidget {
  final String message;
  final Color color;

  const _InlineAlert({required this.message, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Row(
        children: [
          Icon(Icons.info_outline, color: color),
          const SizedBox(width: 8),
          Expanded(child: Text(message)),
        ],
      ),
    );
  }
}
