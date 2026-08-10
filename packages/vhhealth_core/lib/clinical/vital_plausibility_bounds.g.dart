// GENERATED CODE - DO NOT EDIT.
// Source: apps/backend/src/utils/clinical/{vitalPlausibility,icuPlausibility}.js
// Regenerate: node scripts/generate-vital-bounds.mjs

// dart format off

class VitalPlausibilityBound {
  const VitalPlausibilityBound({
    required this.min,
    required this.max,
    required this.unit,
    required this.integer,
  });

  final num min;
  final num max;
  final String unit;
  final bool integer;
}

const String vitalPlausibilitySourceSha256 = '42cd269a4f15f2703d704fba17ff15106824bd49e1d91045a69c6c1e6f883b6d';

const Map<String, VitalPlausibilityBound> vitalPlausibilityBounds = {
  'heart_rate': VitalPlausibilityBound(
    min: 0,
    max: 300,
    unit: 'bpm',
    integer: false,
  ),
  'systolic_bp': VitalPlausibilityBound(
    min: 0,
    max: 300,
    unit: 'mmHg',
    integer: false,
  ),
  'diastolic_bp': VitalPlausibilityBound(
    min: 0,
    max: 200,
    unit: 'mmHg',
    integer: false,
  ),
  'temperature': VitalPlausibilityBound(
    min: 12,
    max: 45,
    unit: '°C',
    integer: false,
  ),
  'spo2': VitalPlausibilityBound(
    min: 0,
    max: 100,
    unit: '%',
    integer: false,
  ),
  'respiratory_rate': VitalPlausibilityBound(
    min: 0,
    max: 120,
    unit: '/min',
    integer: false,
  ),
  'blood_glucose': VitalPlausibilityBound(
    min: 0,
    max: 1500,
    unit: 'mg/dL',
    integer: false,
  ),
  'o2_flow_rate': VitalPlausibilityBound(
    min: 0,
    max: 80,
    unit: 'L/min',
    integer: false,
  ),
};

const Map<String, VitalPlausibilityBound> icuFlowsheetPlausibilityBounds = {
  'hr': VitalPlausibilityBound(
    min: 0,
    max: 300,
    unit: 'bpm',
    integer: true,
  ),
  'sbp': VitalPlausibilityBound(
    min: 0,
    max: 300,
    unit: 'mmHg',
    integer: true,
  ),
  'dbp': VitalPlausibilityBound(
    min: 0,
    max: 200,
    unit: 'mmHg',
    integer: true,
  ),
  'spo2': VitalPlausibilityBound(
    min: 0,
    max: 100,
    unit: '%',
    integer: true,
  ),
  'rr': VitalPlausibilityBound(
    min: 0,
    max: 120,
    unit: '/min',
    integer: true,
  ),
  'temp_c': VitalPlausibilityBound(
    min: 12,
    max: 45,
    unit: '°C',
    integer: false,
  ),
  'map': VitalPlausibilityBound(
    min: 0,
    max: 250,
    unit: 'mmHg',
    integer: true,
  ),
  'cvp': VitalPlausibilityBound(
    min: -10,
    max: 60,
    unit: 'cmH2O',
    integer: true,
  ),
  'cap_refill_sec': VitalPlausibilityBound(
    min: 0,
    max: 30,
    unit: 's',
    integer: false,
  ),
  'gcs_eye': VitalPlausibilityBound(
    min: 1,
    max: 4,
    unit: '',
    integer: true,
  ),
  'gcs_verbal': VitalPlausibilityBound(
    min: 1,
    max: 5,
    unit: '',
    integer: true,
  ),
  'gcs_motor': VitalPlausibilityBound(
    min: 1,
    max: 6,
    unit: '',
    integer: true,
  ),
  'pupils_left_size_mm': VitalPlausibilityBound(
    min: 0,
    max: 12,
    unit: 'mm',
    integer: false,
  ),
  'pupils_right_size_mm': VitalPlausibilityBound(
    min: 0,
    max: 12,
    unit: 'mm',
    integer: false,
  ),
  'fio2_pct': VitalPlausibilityBound(
    min: 21,
    max: 100,
    unit: '%',
    integer: true,
  ),
  'peep_cmh2o': VitalPlausibilityBound(
    min: 0,
    max: 40,
    unit: 'cmH2O',
    integer: false,
  ),
  'tidal_volume_ml': VitalPlausibilityBound(
    min: 0,
    max: 2000,
    unit: 'mL',
    integer: true,
  ),
  'resp_rate_set': VitalPlausibilityBound(
    min: 0,
    max: 80,
    unit: '/min',
    integer: true,
  ),
  'airway_pressure_peak': VitalPlausibilityBound(
    min: 0,
    max: 120,
    unit: 'cmH2O',
    integer: true,
  ),
  'airway_pressure_plateau': VitalPlausibilityBound(
    min: 0,
    max: 120,
    unit: 'cmH2O',
    integer: true,
  ),
  'pf_ratio': VitalPlausibilityBound(
    min: 0,
    max: 700,
    unit: '',
    integer: true,
  ),
  'noradrenaline_mcg_kg_min': VitalPlausibilityBound(
    min: 0,
    max: 10,
    unit: 'mcg/kg/min',
    integer: false,
  ),
  'adrenaline_mcg_kg_min': VitalPlausibilityBound(
    min: 0,
    max: 10,
    unit: 'mcg/kg/min',
    integer: false,
  ),
  'vasopressin_units_hr': VitalPlausibilityBound(
    min: 0,
    max: 10,
    unit: 'units/hr',
    integer: false,
  ),
  'dobutamine_mcg_kg_min': VitalPlausibilityBound(
    min: 0,
    max: 40,
    unit: 'mcg/kg/min',
    integer: false,
  ),
  'propofol_mcg_kg_min': VitalPlausibilityBound(
    min: 0,
    max: 300,
    unit: 'mcg/kg/min',
    integer: false,
  ),
  'midazolam_mg_hr': VitalPlausibilityBound(
    min: 0,
    max: 50,
    unit: 'mg/hr',
    integer: false,
  ),
  'fentanyl_mcg_hr': VitalPlausibilityBound(
    min: 0,
    max: 1000,
    unit: 'mcg/hr',
    integer: false,
  ),
  'insulin_units_hr': VitalPlausibilityBound(
    min: 0,
    max: 100,
    unit: 'units/hr',
    integer: false,
  ),
  'iv_fluids_ml': VitalPlausibilityBound(
    min: 0,
    max: 5000,
    unit: 'mL',
    integer: true,
  ),
  'oral_intake_ml': VitalPlausibilityBound(
    min: 0,
    max: 3000,
    unit: 'mL',
    integer: true,
  ),
  'blood_products_ml': VitalPlausibilityBound(
    min: 0,
    max: 5000,
    unit: 'mL',
    integer: true,
  ),
  'urine_output_ml': VitalPlausibilityBound(
    min: 0,
    max: 3000,
    unit: 'mL',
    integer: true,
  ),
  'drain_output_ml': VitalPlausibilityBound(
    min: 0,
    max: 5000,
    unit: 'mL',
    integer: true,
  ),
  'ng_aspirate_ml': VitalPlausibilityBound(
    min: 0,
    max: 3000,
    unit: 'mL',
    integer: true,
  ),
  'stool_count': VitalPlausibilityBound(
    min: 0,
    max: 20,
    unit: '',
    integer: true,
  ),
};

// dart format on
