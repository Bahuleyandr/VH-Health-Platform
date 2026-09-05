import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';
import '../models/cath_readiness_models.dart';
import 'cath_consumable_formatting.dart';
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

  /// The report date. Starts NULL and stays null until the operator picks one:
  /// this field feeds the freshness rule that decides whether the item counts
  /// as available at all, so defaulting it to today would let a form filled in
  /// with nothing but a lab name assert that an outside result was reported
  /// today.
  DateTime? _observedOn;
  late DateTime _latestAllowed;

  /// The serology dropdown's value is a WIRE token, not a label: the sheet
  /// localises what is shown and sends this unchanged.
  ///
  /// It starts NULL and has no default. A pre-selected "Non-reactive" turns an
  /// operator who only typed the outside lab's name into the author of a
  /// negative HIV / HBsAg / HCV result on this patient's record.
  String? _serologyValue;

  bool get _isSerology => cathReadinessSerologyItems.contains(widget.itemCode);

  @override
  void initState() {
    super.initState();
    final now = widget.today ?? DateTime.now();
    _latestAllowed = DateTime(now.year, now.month, now.day);
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

  Future<void> _pickDate(FormFieldState<DateTime> field) async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _observedOn ?? _latestAllowed,
      firstDate: DateTime(_latestAllowed.year - 5),
      // The backend refuses a future report date against the ward's clinical
      // day, so the picker cannot offer one.
      lastDate: _latestAllowed,
    );
    if (picked == null || !mounted) return;
    final chosen = DateTime(picked.year, picked.month, picked.day);
    setState(() => _observedOn = chosen);
    field.didChange(chosen);
  }

  void _save() {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    // Both are guaranteed by the validators the line above just ran; the local
    // copies make that guarantee explicit rather than asserting it twice.
    final observedOn = _observedOn;
    final serology = _serologyValue;
    if (observedOn == null) return;
    if (_isSerology && serology == null) return;
    final numeric = _isSerology
        ? null
        : double.tryParse(_valueController.text.trim());
    Navigator.of(context).pop(
      CathExternalResultDraft(
        item: widget.itemCode,
        // A quantitative entry sends the number BOTH ways: `value_numeric` is
        // what the freshness and criticality rules read, `value_text` is what
        // the ward sees on the row — and it is rendered from the PARSED
        // number, so `9.40` and `09.4` cannot land on the record as two
        // different-looking haemoglobins.
        valueText: _isSerology
            ? serology!
            : (numeric == null
                  ? _valueController.text.trim()
                  : cathFormatQuantity(numeric)),
        valueNumeric: numeric,
        unit: _isSerology ? null : cathNullableText(_unitController.text),
        observedOn: cathReadinessWireDate(observedOn),
        externalLabName: _labController.text.trim(),
        externalReportRef: cathNullableText(_reportRefController.text),
        notes: cathNullableText(_notesController.text),
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
      hint: Text(s.lookup('s4.lib.cath_lab.readiness.external.select_result')),
      items: [
        for (final value in cathReadinessSerologyValues)
          DropdownMenuItem<String>(
            value: value,
            child: Text(cathReadinessSerologyLabel(s, value)),
          ),
      ],
      // There is no safe default for a blood-borne marker, so the form does
      // not save until a human has chosen one.
      validator: (value) => value == null
          ? s.lookup('s4.lib.cath_lab.readiness.result_required')
          : null,
      onChanged: (value) => setState(() => _serologyValue = value),
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
    return FormField<DateTime>(
      initialValue: _observedOn,
      // The report date drives the freshness rule behind auto-pass, so it is
      // a required entry rather than a prefilled convenience.
      validator: (value) => value == null
          ? s.lookup('s4.lib.cath_lab.readiness.date_required')
          : null,
      builder: (field) {
        final chosen = _observedOn;
        return InkWell(
          key: const ValueKey('cath-external-date'),
          onTap: () => _pickDate(field),
          child: InputDecorator(
            decoration: InputDecoration(
              labelText: s.lookup('s4.lib.cath_lab.readiness.observed_on'),
              errorText: field.errorText,
              suffixIcon: const Icon(Icons.calendar_today_outlined, size: 18),
            ),
            child: Text(
              chosen == null
                  ? s.lookup('s4.lib.cath_lab.readiness.external.select_date')
                  : cathReadinessDisplayDate(chosen),
              style: chosen == null
                  ? TextStyle(color: AppTheme.textSecondary)
                  : null,
            ),
          ),
        );
      },
    );
  }
}
