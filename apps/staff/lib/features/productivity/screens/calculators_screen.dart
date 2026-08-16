// lib/features/productivity/screens/calculators_screen.dart
//
// Clinical calculators (Sprint 8). 13 calculators served by
// /api/v1/productivity/calculators/<name>. Forms are field-driven so
// adding a new calculator on the backend means adding a single entry
// to _calculators here.

import 'package:flutter/material.dart';
import 'package:vhhealth_staff/core/services/api_client.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

class CalculatorField {
  const CalculatorField({
    required this.name,
    required this.labelKey,
    this.kind = 'number',
    this.options,
    this.hintKey,
  });
  final String name;
  final String labelKey;

  /// number | bool | enum
  final String kind;
  final List<String>? options;
  final String? hintKey;
}

class CalculatorDef {
  const CalculatorDef({
    required this.endpoint,
    required this.titleKey,
    required this.subtitleKey,
    required this.fields,
  });
  final String endpoint;
  final String titleKey;
  final String subtitleKey;
  final List<CalculatorField> fields;
}

const _calculators = <CalculatorDef>[
  CalculatorDef(
    endpoint: 'bmi',
    titleKey: 's4.calculators.bmi.title',
    subtitleKey: 's4.calculators.bmi.subtitle',
    fields: [
      CalculatorField(
        name: 'weight_kg',
        labelKey: 's4.calculators.field.weight_kg.label',
      ),
      CalculatorField(
        name: 'height_cm',
        labelKey: 's4.calculators.field.height_cm.label',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'bsaMosteller',
    titleKey: 's4.calculators.bsaMosteller.title',
    subtitleKey: 's4.calculators.bsaMosteller.subtitle',
    fields: [
      CalculatorField(
        name: 'weight_kg',
        labelKey: 's4.calculators.field.weight_kg.label',
      ),
      CalculatorField(
        name: 'height_cm',
        labelKey: 's4.calculators.field.height_cm.label',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'crClCockcroftGault',
    titleKey: 's4.calculators.crClCockcroftGault.title',
    subtitleKey: 's4.calculators.crClCockcroftGault.subtitle',
    fields: [
      CalculatorField(name: 'age', labelKey: 's4.calculators.field.age.label'),
      CalculatorField(
        name: 'weight_kg',
        labelKey: 's4.calculators.field.weight_kg.label',
      ),
      CalculatorField(
        name: 'serum_creatinine_mg_dl',
        labelKey: 's4.calculators.field.serum_creatinine_mg_dl.label',
      ),
      CalculatorField(
        name: 'sex',
        labelKey: 's4.calculators.field.sex.label',
        kind: 'enum',
        options: ['male', 'female'],
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'cha2ds2Vasc',
    titleKey: 's4.calculators.cha2ds2Vasc.title',
    subtitleKey: 's4.calculators.cha2ds2Vasc.subtitle',
    fields: [
      CalculatorField(name: 'age', labelKey: 's4.calculators.field.age.label'),
      CalculatorField(
        name: 'sex',
        labelKey: 's4.calculators.field.sex.label',
        kind: 'enum',
        options: ['male', 'female'],
      ),
      CalculatorField(
        name: 'congestive_hf',
        labelKey: 's4.calculators.field.congestive_hf.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'hypertension',
        labelKey: 's4.calculators.field.hypertension.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'diabetes',
        labelKey: 's4.calculators.field.diabetes.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'prior_stroke_tia',
        labelKey: 's4.calculators.field.prior_stroke_tia.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'vascular_disease',
        labelKey: 's4.calculators.field.vascular_disease.label',
        kind: 'bool',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'hasBled',
    titleKey: 's4.calculators.hasBled.title',
    subtitleKey: 's4.calculators.hasBled.subtitle',
    fields: [
      CalculatorField(
        name: 'hypertension_uncontrolled',
        labelKey: 's4.calculators.field.hypertension_uncontrolled.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'abnormal_renal',
        labelKey: 's4.calculators.field.abnormal_renal.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'abnormal_liver',
        labelKey: 's4.calculators.field.abnormal_liver.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'prior_stroke',
        labelKey: 's4.calculators.field.prior_stroke.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'prior_bleed',
        labelKey: 's4.calculators.field.prior_bleed.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'labile_inr',
        labelKey: 's4.calculators.field.labile_inr.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'age_over_65',
        labelKey: 's4.calculators.field.age_over_65.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'drugs_predisposing_bleed',
        labelKey: 's4.calculators.field.drugs_predisposing_bleed.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'alcohol_excess',
        labelKey: 's4.calculators.field.alcohol_excess.label',
        kind: 'bool',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'wellsPe',
    titleKey: 's4.calculators.wellsPe.title',
    subtitleKey: 's4.calculators.wellsPe.subtitle',
    fields: [
      CalculatorField(
        name: 'clinical_signs_dvt',
        labelKey: 's4.calculators.field.clinical_signs_dvt.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'pe_most_likely_diagnosis',
        labelKey: 's4.calculators.field.pe_most_likely_diagnosis.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'hr_over_100',
        labelKey: 's4.calculators.field.hr_over_100.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'immobilisation_or_recent_surgery',
        labelKey: 's4.calculators.field.immobilisation_or_recent_surgery.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'prior_dvt_or_pe',
        labelKey: 's4.calculators.field.prior_dvt_or_pe.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'hemoptysis',
        labelKey: 's4.calculators.field.hemoptysis.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'malignancy',
        labelKey: 's4.calculators.field.malignancy.label',
        kind: 'bool',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'wellsDvt',
    titleKey: 's4.calculators.wellsDvt.title',
    subtitleKey: 's4.calculators.wellsDvt.subtitle',
    fields: [
      CalculatorField(
        name: 'active_cancer',
        labelKey: 's4.calculators.field.active_cancer.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'paralysis_paresis_recent_immob',
        labelKey: 's4.calculators.field.paralysis_paresis_recent_immob.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'bedridden_3d_or_surgery_4w',
        labelKey: 's4.calculators.field.bedridden_3d_or_surgery_4w.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'tenderness_along_deep_veins',
        labelKey: 's4.calculators.field.tenderness_along_deep_veins.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'entire_leg_swollen',
        labelKey: 's4.calculators.field.entire_leg_swollen.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'calf_swelling_3cm',
        labelKey: 's4.calculators.field.calf_swelling_3cm.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'pitting_edema_symptomatic_leg',
        labelKey: 's4.calculators.field.pitting_edema_symptomatic_leg.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'collateral_superficial_veins',
        labelKey: 's4.calculators.field.collateral_superficial_veins.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'prior_dvt',
        labelKey: 's4.calculators.field.prior_dvt.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'alternative_dx_at_least_as_likely',
        labelKey:
            's4.calculators.field.alternative_dx_at_least_as_likely.label',
        kind: 'bool',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'qsofa',
    titleKey: 's4.calculators.qsofa.title',
    subtitleKey: 's4.calculators.qsofa.subtitle',
    fields: [
      CalculatorField(
        name: 'rr_over_22',
        labelKey: 's4.calculators.field.rr_over_22.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'altered_mentation',
        labelKey: 's4.calculators.field.altered_mentation.label',
        kind: 'bool',
      ),
      CalculatorField(
        name: 'sbp_under_100',
        labelKey: 's4.calculators.field.sbp_under_100.label',
        kind: 'bool',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'gcs',
    titleKey: 's4.calculators.gcs.title',
    subtitleKey: 's4.calculators.gcs.subtitle',
    fields: [
      CalculatorField(
        name: 'eye',
        labelKey: 's4.calculators.field.eye.label',
        kind: 'enum',
        options: ['1', '2', '3', '4'],
        hintKey: 's4.calculators.field.eye.hint',
      ),
      CalculatorField(
        name: 'verbal',
        labelKey: 's4.calculators.field.verbal.label',
        kind: 'enum',
        options: ['1', '2', '3', '4', '5'],
        hintKey: 's4.calculators.field.verbal.hint',
      ),
      CalculatorField(
        name: 'motor',
        labelKey: 's4.calculators.field.motor.label',
        kind: 'enum',
        options: ['1', '2', '3', '4', '5', '6'],
        hintKey: 's4.calculators.field.motor.hint',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'meld',
    titleKey: 's4.calculators.meld.title',
    subtitleKey: 's4.calculators.meld.subtitle',
    fields: [
      CalculatorField(
        name: 'creatinine_mg_dl',
        labelKey: 's4.calculators.field.creatinine_mg_dl.label',
      ),
      CalculatorField(
        name: 'bilirubin_mg_dl',
        labelKey: 's4.calculators.field.bilirubin_mg_dl.label',
      ),
      CalculatorField(name: 'inr', labelKey: 's4.calculators.field.inr.label'),
      CalculatorField(
        name: 'on_dialysis',
        labelKey: 's4.calculators.field.on_dialysis.label',
        kind: 'bool',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'anionGap',
    titleKey: 's4.calculators.anionGap.title',
    subtitleKey: 's4.calculators.anionGap.subtitle',
    fields: [
      CalculatorField(name: 'na', labelKey: 's4.calculators.field.na.label'),
      CalculatorField(name: 'cl', labelKey: 's4.calculators.field.cl.label'),
      CalculatorField(
        name: 'hco3',
        labelKey: 's4.calculators.field.hco3.label',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'correctedCalcium',
    titleKey: 's4.calculators.correctedCalcium.title',
    subtitleKey: 's4.calculators.correctedCalcium.subtitle',
    fields: [
      CalculatorField(
        name: 'calcium_mg_dl',
        labelKey: 's4.calculators.field.calcium_mg_dl.label',
      ),
      CalculatorField(
        name: 'albumin_g_dl',
        labelKey: 's4.calculators.field.albumin_g_dl.label',
      ),
    ],
  ),
  CalculatorDef(
    endpoint: 'apgar',
    titleKey: 's4.calculators.apgar.title',
    subtitleKey: 's4.calculators.apgar.subtitle',
    fields: [
      CalculatorField(
        name: 'appearance',
        labelKey: 's4.calculators.field.appearance.label',
        kind: 'enum',
        options: ['0', '1', '2'],
        hintKey: 's4.calculators.field.appearance.hint',
      ),
      CalculatorField(
        name: 'pulse',
        labelKey: 's4.calculators.field.pulse.label',
        kind: 'enum',
        options: ['0', '1', '2'],
        hintKey: 's4.calculators.field.pulse.hint',
      ),
      CalculatorField(
        name: 'grimace',
        labelKey: 's4.calculators.field.grimace.label',
        kind: 'enum',
        options: ['0', '1', '2'],
      ),
      CalculatorField(
        name: 'activity',
        labelKey: 's4.calculators.field.activity.label',
        kind: 'enum',
        options: ['0', '1', '2'],
      ),
      CalculatorField(
        name: 'respiration',
        labelKey: 's4.calculators.field.respiration.label',
        kind: 'enum',
        options: ['0', '1', '2'],
        hintKey: 's4.calculators.field.respiration.hint',
      ),
    ],
  ),
];

class CalculatorsScreen extends StatelessWidget {
  const CalculatorsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const AppText('s4.lib.calculators.clinical_calculators'),
      ),
      body: ListView.separated(
        padding: const EdgeInsets.all(12),
        itemCount: _calculators.length,
        separatorBuilder: (_, _) => const SizedBox(height: 8),
        itemBuilder: (_, i) {
          final c = _calculators[i];
          return Card(
            clipBehavior: Clip.antiAlias,
            child: ListTile(
              title: Text(s.lookup(c.titleKey)),
              subtitle: Text(s.lookup(c.subtitleKey)),
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
          _error = response.failureMessage(
            AppStrings.of(context)
                .lookup('s4.lib.calculators.calculation_failed'),
          );
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
    final s = AppStrings.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(s.lookup(widget.calculator.titleKey))),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            s.lookup(widget.calculator.subtitleKey),
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
            label: Text(
              s.lookup(
                _computing
                    ? 's4.lib.calculators.calculating'
                    : 's4.lib.calculators.calculate',
              ),
            ),
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
          title: Text(AppStrings.of(context).lookup(f.labelKey)),
          value: _boolValues[f.name] ?? false,
          onChanged: (v) => setState(() => _boolValues[f.name] = v),
        );
      case 'enum':
        return Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: DropdownButtonFormField<String>(
            initialValue: _enumValues[f.name],
            decoration: InputDecoration(
              labelText: AppStrings.of(context).lookup(f.labelKey),
              helperText: f.hintKey == null
                  ? null
                  : AppStrings.of(context).lookup(f.hintKey!),
              border: const OutlineInputBorder(),
            ),
            items: (f.options ?? const [])
                .map(
                  (o) => DropdownMenuItem(
                    value: o,
                    child: Text(_optionLabel(AppStrings.of(context), f, o)),
                  ),
                )
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
              labelText: AppStrings.of(context).lookup(f.labelKey),
              helperText: f.hintKey == null
                  ? null
                  : AppStrings.of(context).lookup(f.hintKey!),
              border: const OutlineInputBorder(),
            ),
          ),
        );
    }
  }

  String _optionLabel(AppStrings s, CalculatorField field, String value) {
    final key = 's4.calculators.option.${field.name}.$value';
    final label = s.lookup(key);
    return label == key ? value : label;
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
            AppText(
              's4.lib.calculators.result',
              style: theme.textTheme.titleMedium,
            ),
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
