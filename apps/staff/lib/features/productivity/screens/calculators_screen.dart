// lib/features/productivity/screens/calculators_screen.dart
//
// Clinical calculators (Sprint 8). 13 calculators served by
// /api/v1/productivity/calculators/<name>. Forms are field-driven so
// adding a new calculator on the backend means adding a single entry
// to _calculators here.

import 'package:flutter/material.dart';
import 'package:vhhealth_staff/core/services/api_client.dart';

class CalculatorField {
  const CalculatorField({
    required this.name,
    required this.label,
    this.kind = 'number',
    this.options,
    this.hint,
  });
  final String name;
  final String label;

  /// number | bool | enum
  final String kind;
  final List<String>? options;
  final String? hint;
}

class CalculatorDef {
  const CalculatorDef({
    required this.endpoint,
    required this.title,
    required this.subtitle,
    required this.fields,
  });
  final String endpoint;
  final String title;
  final String subtitle;
  final List<CalculatorField> fields;
}

const _calculators = <CalculatorDef>[
  CalculatorDef(
    endpoint: 'bmi',
    title: 'BMI',
    subtitle: 'Body mass index — WHO bands',
    fields: [
      CalculatorField(name: 'weight_kg', label: 'Weight (kg)'),
      CalculatorField(name: 'height_cm', label: 'Height (cm)'),
    ],
  ),
  CalculatorDef(
    endpoint: 'bsaMosteller',
    title: 'BSA (Mosteller)',
    subtitle: 'Body surface area for chemo dosing',
    fields: [
      CalculatorField(name: 'weight_kg', label: 'Weight (kg)'),
      CalculatorField(name: 'height_cm', label: 'Height (cm)'),
    ],
  ),
  CalculatorDef(
    endpoint: 'crClCockcroftGault',
    title: 'CrCl (Cockcroft-Gault)',
    subtitle: 'Renal clearance estimate',
    fields: [
      CalculatorField(name: 'age', label: 'Age (yr)'),
      CalculatorField(name: 'weight_kg', label: 'Weight (kg)'),
      CalculatorField(
        name: 'serum_creatinine_mg_dl',
        label: 'Serum creatinine (mg/dL)',
      ),
      CalculatorField(
        name: 'sex',
        label: 'Sex',
        kind: 'enum',
        options: ['male', 'female'],
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'cha2ds2Vasc',
    title: 'CHA₂DS₂-VASc',
    subtitle: 'Stroke risk in non-valvular AF',
    fields: [
      CalculatorField(name: 'age', label: 'Age (yr)'),
      CalculatorField(
        name: 'sex',
        label: 'Sex',
        kind: 'enum',
        options: ['male', 'female'],
      ),
      CalculatorField(
        name: 'congestive_hf',
        label: 'Congestive HF',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'hypertension',
        label: 'Hypertension',
        kind: 'bool',
      ),
      CalculatorField(name: 'diabetes', label: 'Diabetes', kind: 'bool'),
      CalculatorField(
        name: 'prior_stroke_tia',
        label: 'Prior stroke / TIA',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'vascular_disease',
        label: 'Vascular disease (MI / PAD / aortic plaque)',
        kind: 'bool',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'hasBled',
    title: 'HAS-BLED',
    subtitle: 'Major bleeding risk on anticoagulation',
    fields: [
      CalculatorField(
        name: 'hypertension_uncontrolled',
        label: 'Uncontrolled hypertension (SBP > 160)',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'abnormal_renal',
        label: 'Abnormal renal function',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'abnormal_liver',
        label: 'Abnormal liver function',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'prior_stroke',
        label: 'Prior stroke',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'prior_bleed',
        label: 'Prior major bleed',
        kind: 'bool',
      ),
      CalculatorField(name: 'labile_inr', label: 'Labile INR', kind: 'bool'),
      CalculatorField(name: 'age_over_65', label: 'Age > 65', kind: 'bool'),
      CalculatorField(
        name: 'drugs_predisposing_bleed',
        label: 'Drugs that predispose to bleeding',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'alcohol_excess',
        label: 'Alcohol excess',
        kind: 'bool',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'wellsPe',
    title: 'Wells PE',
    subtitle: 'Pulmonary embolism probability',
    fields: [
      CalculatorField(
        name: 'clinical_signs_dvt',
        label: 'Clinical signs of DVT',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'pe_most_likely_diagnosis',
        label: 'PE is the most likely diagnosis',
        kind: 'bool',
      ),
      CalculatorField(name: 'hr_over_100', label: 'HR > 100', kind: 'bool'),
      CalculatorField(
        name: 'immobilisation_or_recent_surgery',
        label: 'Immobilisation / recent surgery',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'prior_dvt_or_pe',
        label: 'Prior DVT / PE',
        kind: 'bool',
      ),
      CalculatorField(name: 'hemoptysis', label: 'Haemoptysis', kind: 'bool'),
      CalculatorField(
        name: 'malignancy',
        label: 'Malignancy (active)',
        kind: 'bool',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'wellsDvt',
    title: 'Wells DVT',
    subtitle: 'Deep vein thrombosis probability',
    fields: [
      CalculatorField(
        name: 'active_cancer',
        label: 'Active cancer',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'paralysis_paresis_recent_immob',
        label: 'Paralysis / paresis / recent immobilisation',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'bedridden_3d_or_surgery_4w',
        label: 'Bedridden ≥3d or surgery within 4w',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'tenderness_along_deep_veins',
        label: 'Tenderness along deep veins',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'entire_leg_swollen',
        label: 'Entire leg swollen',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'calf_swelling_3cm',
        label: 'Calf swelling > 3cm vs other',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'pitting_edema_symptomatic_leg',
        label: 'Pitting oedema (symptomatic leg)',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'collateral_superficial_veins',
        label: 'Collateral superficial veins',
        kind: 'bool',
      ),
      CalculatorField(name: 'prior_dvt', label: 'Prior DVT', kind: 'bool'),
      CalculatorField(
        name: 'alternative_dx_at_least_as_likely',
        label: 'Alternative dx at least as likely',
        kind: 'bool',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'qsofa',
    title: 'qSOFA',
    subtitle: 'Bedside sepsis screen (≥2 = high risk)',
    fields: [
      CalculatorField(name: 'rr_over_22', label: 'RR > 22', kind: 'bool'),
      CalculatorField(
        name: 'altered_mentation',
        label: 'Altered mentation (GCS < 15)',
        kind: 'bool',
      ),
      CalculatorField(name: 'sbp_under_100', label: 'SBP < 100', kind: 'bool'),
    ],
  ),
  CalculatorDef(
    endpoint: 'gcs',
    title: 'GCS',
    subtitle: 'Glasgow Coma Scale',
    fields: [
      CalculatorField(
        name: 'eye',
        label: 'Eye opening',
        kind: 'enum',
        options: ['1', '2', '3', '4'],
        hint: '1 none · 2 to pain · 3 to voice · 4 spontaneous',
      ),
      CalculatorField(
        name: 'verbal',
        label: 'Verbal response',
        kind: 'enum',
        options: ['1', '2', '3', '4', '5'],
        hint: '1 none · 2 sounds · 3 words · 4 confused · 5 oriented',
      ),
      CalculatorField(
        name: 'motor',
        label: 'Motor response',
        kind: 'enum',
        options: ['1', '2', '3', '4', '5', '6'],
        hint:
            '1 none · 2 extension · 3 flexion · 4 withdraws · 5 localises · 6 obeys',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'meld',
    title: 'MELD',
    subtitle: 'Liver disease severity',
    fields: [
      CalculatorField(name: 'creatinine_mg_dl', label: 'Creatinine (mg/dL)'),
      CalculatorField(name: 'bilirubin_mg_dl', label: 'Bilirubin (mg/dL)'),
      CalculatorField(name: 'inr', label: 'INR'),
      CalculatorField(
        name: 'on_dialysis',
        label: 'On dialysis (≥2 sessions/wk)',
        kind: 'bool',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'anionGap',
    title: 'Anion Gap',
    subtitle: 'Na − (Cl + HCO₃) — normal 8–12',
    fields: [
      CalculatorField(name: 'na', label: 'Sodium (mEq/L)'),
      CalculatorField(name: 'cl', label: 'Chloride (mEq/L)'),
      CalculatorField(name: 'hco3', label: 'Bicarbonate (mEq/L)'),
    ],
  ),
  CalculatorDef(
    endpoint: 'correctedCalcium',
    title: 'Corrected Ca²⁺',
    subtitle: 'Albumin-adjusted calcium (Payne)',
    fields: [
      CalculatorField(name: 'calcium_mg_dl', label: 'Calcium (mg/dL)'),
      CalculatorField(name: 'albumin_g_dl', label: 'Albumin (g/dL)'),
    ],
  ),
  CalculatorDef(
    endpoint: 'apgar',
    title: 'Apgar',
    subtitle: 'Newborn score (each 0–2)',
    fields: [
      CalculatorField(
        name: 'appearance',
        label: 'Appearance',
        kind: 'enum',
        options: ['0', '1', '2'],
        hint: '0 blue/pale · 1 acrocyanotic · 2 pink',
      ),
      CalculatorField(
        name: 'pulse',
        label: 'Pulse',
        kind: 'enum',
        options: ['0', '1', '2'],
        hint: '0 absent · 1 < 100 · 2 ≥ 100',
      ),
      CalculatorField(
        name: 'grimace',
        label: 'Grimace (reflex irritability)',
        kind: 'enum',
        options: ['0', '1', '2'],
      ),
      CalculatorField(
        name: 'activity',
        label: 'Activity (muscle tone)',
        kind: 'enum',
        options: ['0', '1', '2'],
      ),
      CalculatorField(
        name: 'respiration',
        label: 'Respiration',
        kind: 'enum',
        options: ['0', '1', '2'],
        hint: '0 absent · 1 weak/irregular · 2 strong cry',
      ),
    ],
  ),
];

class CalculatorsScreen extends StatelessWidget {
  const CalculatorsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Clinical Calculators')),
      body: ListView.separated(
        padding: const EdgeInsets.all(12),
        itemCount: _calculators.length,
        separatorBuilder: (_, _) => const SizedBox(height: 8),
        itemBuilder: (_, i) {
          final c = _calculators[i];
          return Card(
            clipBehavior: Clip.antiAlias,
            child: ListTile(
              title: Text(c.title),
              subtitle: Text(c.subtitle),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => CalculatorDetailScreen(calculator: c),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class CalculatorDetailScreen extends StatefulWidget {
  const CalculatorDetailScreen({super.key, required this.calculator});
  final CalculatorDef calculator;

  @override
  State<CalculatorDetailScreen> createState() =>
      CalculatorDefDetailScreenState();
}

class CalculatorDefDetailScreenState extends State<CalculatorDetailScreen> {
  final Map<String, TextEditingController> _controllers = {};
  final Map<String, String?> _enumValues = {};
  final Map<String, bool> _boolValues = {};
  bool _computing = false;
  String? _error;
  Map<String, dynamic>? _result;

  @override
  void initState() {
    super.initState();
    for (final f in widget.calculator.fields) {
      if (f.kind == 'number') {
        _controllers[f.name] = TextEditingController();
      } else if (f.kind == 'bool') {
        _boolValues[f.name] = false;
      }
    }
  }

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  Map<String, dynamic> _collectInputs() {
    final body = <String, dynamic>{};
    for (final f in widget.calculator.fields) {
      switch (f.kind) {
        case 'number':
          final s = _controllers[f.name]?.text.trim() ?? '';
          if (s.isNotEmpty) {
            final n = num.tryParse(s);
            body[f.name] = n ?? s;
          }
        case 'bool':
          body[f.name] = _boolValues[f.name] ?? false;
        case 'enum':
          final v = _enumValues[f.name];
          if (v != null) {
            // Cast numeric-looking enum values to int for GCS / Apgar.
            final asInt = int.tryParse(v);
            body[f.name] = asInt ?? v;
          }
      }
    }
    return body;
  }

  Future<void> _compute() async {
    setState(() {
      _computing = true;
      _error = null;
      _result = null;
    });
    try {
      final response = await ApiClient.post(
        '/productivity/calculators/${widget.calculator.endpoint}',
        body: _collectInputs(),
      );
      if (!mounted) return;
      if (response.isSuccess) {
        setState(() {
          _result = response.dataAsMap();
          _computing = false;
        });
      } else {
        setState(() {
          _error = response.failureMessage('Calculation failed');
          _computing = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _computing = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(widget.calculator.title)),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            widget.calculator.subtitle,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
          const SizedBox(height: 16),
          ...widget.calculator.fields.map(_buildField),
          const SizedBox(height: 24),
          FilledButton.icon(
            onPressed: _computing ? null : _compute,
            icon: _computing
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.calculate),
            label: Text(_computing ? 'Calculating…' : 'Calculate'),
          ),
          const SizedBox(height: 16),
          if (_error != null)
            Card(
              color: theme.colorScheme.errorContainer,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  _error!,
                  style: TextStyle(color: theme.colorScheme.onErrorContainer),
                ),
              ),
            ),
          if (_result != null) _buildResult(theme),
        ],
      ),
    );
  }

  Widget _buildField(CalculatorField f) {
    switch (f.kind) {
      case 'bool':
        return SwitchListTile(
          title: Text(f.label),
          value: _boolValues[f.name] ?? false,
          onChanged: (v) => setState(() => _boolValues[f.name] = v),
        );
      case 'enum':
        return Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: DropdownButtonFormField<String>(
            initialValue: _enumValues[f.name],
            decoration: InputDecoration(
              labelText: f.label,
              helperText: f.hint,
              border: const OutlineInputBorder(),
            ),
            items: (f.options ?? const [])
                .map((o) => DropdownMenuItem(value: o, child: Text(o)))
                .toList(),
            onChanged: (v) => setState(() => _enumValues[f.name] = v),
          ),
        );
      case 'number':
      default:
        return Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: TextField(
            controller: _controllers[f.name],
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(
              labelText: f.label,
              helperText: f.hint,
              border: const OutlineInputBorder(),
            ),
          ),
        );
    }
  }

  Widget _buildResult(ThemeData theme) {
    final r = _result!;
    final result = r['result'];
    final interpretation = r['interpretation']?.toString();
    final band = r['band']?.toString() ?? r['stage']?.toString();
    return Card(
      color: theme.colorScheme.primaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Result', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              result is Map ? _fmtMap(result) : '$result',
              style: theme.textTheme.headlineMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            if (band != null) ...[
              const SizedBox(height: 4),
              Text(
                band.replaceAll('_', ' '),
                style: theme.textTheme.titleSmall,
              ),
            ],
            if (interpretation != null) ...[
              const SizedBox(height: 8),
              Text(interpretation, style: theme.textTheme.bodyMedium),
            ],
          ],
        ),
      ),
    );
  }

  String _fmtMap(Map m) {
    return m.entries.map((e) => '${e.key} = ${e.value}').join('  ');
  }
}
