// lib/features/maternity/screens/partograph_entry_screen.dart
//
// Partograph entry — Sprint 7. Filed every 30 minutes during labour
// by the midwife. Hits POST /api/v1/maternity/partograph; backend
// computes WHO alert/action line flags from active phase start +
// dilation slope.

import 'package:flutter/material.dart';
import 'package:vhhealth_staff/core/services/api_client.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

class PartographEntryScreen extends StatefulWidget {
  const PartographEntryScreen({super.key, required this.laborAdmissionId});
  final int laborAdmissionId;

  @override
  State<PartographEntryScreen> createState() => _PartographEntryScreenState();
}

class _PartographEntryScreenState extends State<PartographEntryScreen> {
  final _formKey = GlobalKey<FormState>();

  // Maternal vitals
  final _bpSysCtrl = TextEditingController();
  final _bpDiaCtrl = TextEditingController();
  final _pulseCtrl = TextEditingController();
  final _tempCtrl = TextEditingController();
  final _urineCtrl = TextEditingController();
  String? _urineProtein;
  String? _urineAcetone;

  // Labour progress
  final _cervixCtrl = TextEditingController();
  final _descentCtrl = TextEditingController();
  final _ctxCountCtrl = TextEditingController();
  final _ctxDurCtrl = TextEditingController();
  String? _ctxIntensity;

  // Fetal status
  final _fhrCtrl = TextEditingController();
  String? _decel;
  String? _amniotic;
  String? _moulding;

  // Drugs / fluids
  final _oxytocinCtrl = TextEditingController();
  final _oxytocinDropsCtrl = TextEditingController();
  final _drugsCtrl = TextEditingController();
  final _ivCtrl = TextEditingController();

  final _notesCtrl = TextEditingController();

  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [
      _bpSysCtrl,
      _bpDiaCtrl,
      _pulseCtrl,
      _tempCtrl,
      _urineCtrl,
      _cervixCtrl,
      _descentCtrl,
      _ctxCountCtrl,
      _ctxDurCtrl,
      _fhrCtrl,
      _oxytocinCtrl,
      _oxytocinDropsCtrl,
      _drugsCtrl,
      _ivCtrl,
      _notesCtrl,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  num? _num(TextEditingController c) {
    final s = c.text.trim();
    if (s.isEmpty) return null;
    return num.tryParse(s);
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final response = await ApiClient.post(
        '/maternity/partograph',
        body: {
          'labor_admission_id': widget.laborAdmissionId,
          'bp_systolic': _num(_bpSysCtrl),
          'bp_diastolic': _num(_bpDiaCtrl),
          'pulse_bpm': _num(_pulseCtrl),
          'temperature_c': _num(_tempCtrl),
          'urine_output_ml': _num(_urineCtrl),
          'urine_protein': _urineProtein,
          'urine_acetone': _urineAcetone,
          'cervix_dilation_cm': _num(_cervixCtrl),
          'descent_fifths_above_brim': _num(_descentCtrl),
          'contractions_per_10min': _num(_ctxCountCtrl),
          'contractions_duration_sec': _num(_ctxDurCtrl),
          'contractions_intensity': _ctxIntensity,
          'fetal_heart_rate_bpm': _num(_fhrCtrl),
          'fetal_decel': _decel,
          'amniotic_fluid': _amniotic,
          'moulding': _moulding,
          'oxytocin_units_l': _num(_oxytocinCtrl),
          'oxytocin_drops_min': _num(_oxytocinDropsCtrl),
          'drugs_given': _drugsCtrl.text.trim().isEmpty
              ? null
              : _drugsCtrl.text.trim(),
          'iv_fluids': _ivCtrl.text.trim().isEmpty ? null : _ivCtrl.text.trim(),
          'notes': _notesCtrl.text.trim().isEmpty
              ? null
              : _notesCtrl.text.trim(),
        }..removeWhere((_, v) => v == null),
      );
      if (!mounted) return;
      if (response.isSuccess) {
        final data = response.dataAsMap();
        final onAction = data['on_action_line'] == true;
        final onAlert = data['on_alert_line'] == true;
        final s = AppStrings.of(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              onAction
                  ? s.partographSavedActionLine
                  : onAlert
                  ? s.partographSavedAlertLine
                  : s.partographSaved,
            ),
            backgroundColor: onAction
                ? Colors.red[700]
                : onAlert
                ? Colors.amber[700]
                : null,
          ),
        );
        Navigator.of(context).pop(true);
      } else {
        setState(() {
          _saving = false;
          _error = response.message ?? 'Save failed';
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = e.toString();
      });
    }
  }

  Widget _section(String title, List<Widget> children) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              style: Theme.of(
                context,
              ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            ...children,
          ],
        ),
      ),
    );
  }

  Widget _numField(TextEditingController c, String label, {String? hint}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: TextFormField(
        controller: c,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        decoration: InputDecoration(
          labelText: label,
          helperText: hint,
          border: const OutlineInputBorder(),
          isDense: true,
        ),
      ),
    );
  }

  Widget _enumField(
    String label,
    String? value,
    List<String> opts,
    ValueChanged<String?> onChanged,
  ) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: DropdownButtonFormField<String>(
        initialValue: value,
        decoration: InputDecoration(
          labelText: label,
          border: const OutlineInputBorder(),
          isDense: true,
        ),
        items: opts
            .map((o) => DropdownMenuItem(value: o, child: Text(o)))
            .toList(),
        onChanged: onChanged,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(s.partographEntryTitle)),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(12),
          children: [
            _section(s.partographSectionLabourProgress, [
              _numField(
                _cervixCtrl,
                s.partographCervixDilation,
                hint: s.partographCervixDilationHint,
              ),
              _numField(_descentCtrl, s.partographDescent),
              _numField(_ctxCountCtrl, s.partographCtxPer10min),
              _numField(_ctxDurCtrl, s.partographCtxDuration),
              _enumField(
                s.partographCtxIntensity,
                _ctxIntensity,
                [
                  s.partographCtxWeak,
                  s.partographCtxModerate,
                  s.partographCtxStrong,
                ],
                (v) => setState(() => _ctxIntensity = v),
              ),
            ]),
            const SizedBox(height: 8),
            _section(s.partographSectionFetalStatus, [
              _numField(_fhrCtrl, s.partographFhr),
              _enumField(s.partographDecelerations, _decel, [
                s.partographDecelNone,
                s.partographDecelEarly,
                s.partographDecelLate,
                s.partographDecelVariable,
              ], (v) => setState(() => _decel = v)),
              _enumField(
                s.partographAmnioticFluid,
                _amniotic,
                const [
                  'intact_membranes',
                  'clear',
                  'meconium_thin',
                  'meconium_thick',
                  'blood',
                ],
                (v) => setState(() => _amniotic = v),
              ),
              _enumField(s.partographMoulding, _moulding, const [
                '0',
                '1+',
                '2+',
                '3+',
              ], (v) => setState(() => _moulding = v)),
            ]),
            const SizedBox(height: 8),
            _section(s.partographSectionMaternalVitals, [
              Row(
                children: [
                  Expanded(
                    child: _numField(_bpSysCtrl, s.partographBpSystolic),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _numField(_bpDiaCtrl, s.partographBpDiastolic),
                  ),
                ],
              ),
              _numField(_pulseCtrl, s.partographPulse),
              _numField(_tempCtrl, s.partographTemperature),
              _numField(_urineCtrl, s.partographUrineOutput),
              _enumField(
                s.partographUrineProtein,
                _urineProtein,
                const ['nil', 'trace', '1+', '2+', '3+'],
                (v) => setState(() => _urineProtein = v),
              ),
              _enumField(
                s.partographUrineAcetone,
                _urineAcetone,
                const ['nil', 'trace', '1+', '2+', '3+'],
                (v) => setState(() => _urineAcetone = v),
              ),
            ]),
            const SizedBox(height: 8),
            _section(s.partographSectionDrugsFluids, [
              _numField(_oxytocinCtrl, s.partographOxytocin),
              _numField(_oxytocinDropsCtrl, s.partographOxytocinDrops),
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: TextFormField(
                  controller: _drugsCtrl,
                  decoration: InputDecoration(
                    labelText: s.partographOtherDrugs,
                    border: const OutlineInputBorder(),
                    isDense: true,
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: TextFormField(
                  controller: _ivCtrl,
                  decoration: InputDecoration(
                    labelText: s.partographIvFluids,
                    border: const OutlineInputBorder(),
                    isDense: true,
                  ),
                ),
              ),
            ]),
            const SizedBox(height: 8),
            TextFormField(
              controller: _notesCtrl,
              maxLines: 3,
              decoration: InputDecoration(
                labelText: s.partographNotes,
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 16),
            if (_error != null) ...[
              Card(
                color: Theme.of(context).colorScheme.errorContainer,
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(_error!),
                ),
              ),
              const SizedBox(height: 8),
            ],
            FilledButton.icon(
              onPressed: _saving ? null : _submit,
              icon: _saving
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.save),
              label: Text(_saving ? s.partographSaving : s.partographSaveEntry),
            ),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }
}
