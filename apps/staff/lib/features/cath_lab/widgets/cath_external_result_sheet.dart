import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';
import '../models/cath_readiness_models.dart';
import 'cath_readiness_formatting.dart';

/// Bottom sheet that captures ONE outside-lab value for one readiness item.
///
/// It pops a [CathExternalResultDraft]; it never calls the API itself, so the
/// panel that opened it owns the idempotency key and the failure message.
///
/// The two item kinds submit different bodies, and the backend enforces the
/// difference: a serology item takes a token from
/// [cathReadinessSerologyValues] (matched case-insensitively against the
/// route's `QUALITATIVE_TOKENS`), a quantitative item takes a finite,
/// non-negative `value_numeric` — validated here as well, because a 400 that
/// the sheet could have prevented costs the operator the whole form.
class CathExternalResultSheet extends StatefulWidget {
  const CathExternalResultSheet({
    super.key,
    required this.itemCode,
    this.today,
  });

  final String itemCode;

  /// Injectable "today" for tests. Defaults to the device's local date, which
  /// is the ward's date on a deployment running in the hospital's timezone.
  final DateTime? today;

  static Future<CathExternalResultDraft?> show(
    BuildContext context, {
    required String itemCode,
    DateTime? today,
  }) {
    return showModalBottomSheet<CathExternalResultDraft>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) =>
          CathExternalResultSheet(itemCode: itemCode, today: today),
    );
  }

  @override
  State<CathExternalResultSheet> createState() =>
      _CathExternalResultSheetState();
}

class _CathExternalResultSheetState extends State<CathExternalResultSheet> {
  final _formKey = GlobalKey<FormState>();
  final _valueController = TextEditingController();
  final _unitController = TextEditingController();
  final _labController = TextEditingController();
  final _reportRefController = TextEditingController();
  final _notesController = TextEditingController();
  late DateTime _observedOn;
  late DateTime _latestAllowed;

  /// The serology dropdown's value is a WIRE token, not a label: the sheet
  /// localises what is shown and sends this unchanged.
  String _serologyValue = 'Non-reactive';

  bool get _isSerology => cathReadinessSerologyItems.contains(widget.itemCode);

  @override
  void initState() {
    super.initState();
    final now = widget.today ?? DateTime.now();
    _latestAllowed = DateTime(now.year, now.month, now.day);
    _observedOn = _latestAllowed;
    _unitController.text = cathReadinessDefaultUnits[widget.itemCode] ?? '';
  }

  @override
  void dispose() {
    _valueController.dispose();
    _unitController.dispose();
    _labController.dispose();
    _reportRefController.dispose();
    _notesController.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _observedOn,
      firstDate: DateTime(_latestAllowed.year - 5),
      // The backend refuses a future report date against the ward's clinical
      // day, so the picker cannot offer one.
      lastDate: _latestAllowed,
    );
    if (picked == null || !mounted) return;
    setState(
      () => _observedOn = DateTime(picked.year, picked.month, picked.day),
    );
  }

  void _save() {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final unit = _unitController.text.trim();
    final numeric = _isSerology
        ? null
        : double.tryParse(_valueController.text.trim());
    Navigator.of(context).pop(
      CathExternalResultDraft(
        item: widget.itemCode,
        // A quantitative entry sends the number BOTH ways: `value_numeric` is
        // what the freshness and criticality rules read, `value_text` is what
        // the ward sees on the row.
        valueText: _isSerology ? _serologyValue : _valueController.text.trim(),
        valueNumeric: numeric,
        unit: _isSerology || unit.isEmpty ? null : unit,
        observedOn: cathReadinessDate(_observedOn),
        externalLabName: _labController.text.trim(),
        externalReportRef: _reportRefController.text.trim().isEmpty
            ? null
            : _reportRefController.text.trim(),
        notes: _notesController.text.trim().isEmpty
            ? null
            : _notesController.text.trim(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: SingleChildScrollView(
        child: Form(
          key: _formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                s.format('s4.lib.cath_lab.readiness.external_title', {
                  'item': cathReadinessItemLabel(s, widget.itemCode),
                }),
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                s.lookup('s4.lib.cath_lab.readiness.external_unverified_hint'),
                style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
              ),
              const SizedBox(height: 14),
              if (_isSerology) _serologyField(s) else ..._quantitativeFields(s),
              const SizedBox(height: 12),
              _dateField(s),
              const SizedBox(height: 12),
              TextFormField(
                key: const ValueKey('cath-external-lab'),
                controller: _labController,
                decoration: InputDecoration(
                  labelText: s.lookup(
                    's4.lib.cath_lab.readiness.external_lab_name',
                  ),
                ),
                validator: (value) => (value ?? '').trim().isEmpty
                    ? s.lookup('s4.lib.cath_lab.readiness.lab_name_required')
                    : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                key: const ValueKey('cath-external-report-ref'),
                controller: _reportRefController,
                decoration: InputDecoration(
                  labelText: s.lookup(
                    's4.lib.cath_lab.readiness.external_report_ref',
                  ),
                ),
              ),
              const SizedBox(height: 12),
              TextFormField(
                key: const ValueKey('cath-external-notes'),
                controller: _notesController,
                maxLines: 2,
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.cath_lab.readiness.notes'),
                ),
              ),
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: Text(s.actionCancel),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    key: const ValueKey('cath-external-save'),
                    onPressed: _save,
                    child: Text(s.actionSave),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _serologyField(AppStrings s) {
    return DropdownButtonFormField<String>(
      key: const ValueKey('cath-external-value-select'),
      initialValue: _serologyValue,
      decoration: InputDecoration(
        labelText: s.lookup('s4.lib.cath_lab.readiness.external_value'),
      ),
      items: [
        for (final value in cathReadinessSerologyValues)
          DropdownMenuItem<String>(
            value: value,
            child: Text(cathReadinessSerologyLabel(s, value)),
          ),
      ],
      onChanged: (value) =>
          setState(() => _serologyValue = value ?? _serologyValue),
    );
  }

  List<Widget> _quantitativeFields(AppStrings s) {
    return [
      TextFormField(
        key: const ValueKey('cath-external-value'),
        controller: _valueController,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
        decoration: InputDecoration(
          labelText: s.lookup('s4.lib.cath_lab.readiness.external_value'),
        ),
        validator: (value) {
          final parsed = double.tryParse((value ?? '').trim());
          if (parsed == null || !parsed.isFinite || parsed < 0) {
            return s.lookup('s4.lib.cath_lab.readiness.value_invalid');
          }
          return null;
        },
      ),
      const SizedBox(height: 12),
      TextFormField(
        key: const ValueKey('cath-external-unit'),
        controller: _unitController,
        decoration: InputDecoration(
          labelText: s.lookup('s4.lib.cath_lab.readiness.unit'),
        ),
      ),
    ];
  }

  Widget _dateField(AppStrings s) {
    return InkWell(
      key: const ValueKey('cath-external-date'),
      onTap: _pickDate,
      child: InputDecorator(
        decoration: InputDecoration(
          labelText: s.lookup('s4.lib.cath_lab.readiness.observed_on'),
          suffixIcon: const Icon(Icons.calendar_today_outlined, size: 18),
        ),
        child: Text(cathReadinessDate(_observedOn)),
      ),
    );
  }
}
