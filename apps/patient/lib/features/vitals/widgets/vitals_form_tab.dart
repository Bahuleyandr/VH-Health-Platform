// Log Vitals tab — the form half of VitalsScreen. Extracted from the
// former god-screen so the screen file stays a thin tab coordinator.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/offline/patient_cache_invalidation.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/health_sync_service.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';
import 'package:vhhealth_core/clinical/vital_plausibility.dart';

VitalPlausibilityIssue? patientVitalsFieldIssue(
  String? raw,
  String field, {
  required bool integer,
  bool fahrenheit = false,
}) {
  return vitalPlausibilityIssue(
    raw ?? '',
    field,
    integer: integer,
    fahrenheit: fahrenheit,
  );
}

class VitalsFormTab extends StatefulWidget {
  final VoidCallback onSubmitted;
  const VitalsFormTab({super.key, required this.onSubmitted});

  @override
  State<VitalsFormTab> createState() => _VitalsFormTabState();
}

class _VitalsFormTabState extends State<VitalsFormTab> {
  final _formKey = GlobalKey<FormState>();
  final _systolicCtrl = TextEditingController();
  final _diastolicCtrl = TextEditingController();
  final _heartRateCtrl = TextEditingController();
  final _temperatureCtrl = TextEditingController();
  final _bloodSugarCtrl = TextEditingController();
  final _weightCtrl = TextEditingController();
  final _spo2Ctrl = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _systolicCtrl.dispose();
    _diastolicCtrl.dispose();
    _heartRateCtrl.dispose();
    _temperatureCtrl.dispose();
    _bloodSugarCtrl.dispose();
    _weightCtrl.dispose();
    _spo2Ctrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    final l = AppLocalizations.of(context)!;

    setState(() => _submitting = true);
    try {
      final body = <String, dynamic>{};
      if (_systolicCtrl.text.isNotEmpty && _diastolicCtrl.text.isNotEmpty) {
        body['bloodPressure'] = {
          'systolic': int.parse(_systolicCtrl.text),
          'diastolic': int.parse(_diastolicCtrl.text),
        };
      }
      if (_heartRateCtrl.text.isNotEmpty) {
        body['heartRate'] = int.parse(_heartRateCtrl.text);
      }
      if (_temperatureCtrl.text.isNotEmpty) {
        body['temperature'] = double.parse(_temperatureCtrl.text);
        // The field collects °F; declare the unit so the backend converts to
        // canonical °C. A unitless payload is treated as °C and a real °F
        // reading (e.g. 98.6) fails the 30–45 °C plausibility band, losing the
        // record. Mirrors the staff vitals-chart contract.
        body['temperature_unit'] = 'F';
      }
      if (_bloodSugarCtrl.text.isNotEmpty) {
        body['bloodSugar'] = int.parse(_bloodSugarCtrl.text);
      }
      if (_weightCtrl.text.isNotEmpty) {
        body['weight'] = double.parse(_weightCtrl.text);
      }
      if (_spo2Ctrl.text.isNotEmpty) {
        body['spO2'] = int.parse(_spo2Ctrl.text);
      }

      if (body.isEmpty) {
        if (mounted) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(LiveRegionSnackBar.build(message: l.vitalsAtLeastOne));
        }
        return;
      }

      final response = await ApiClient.post(
        '/health/patient/vitals',
        body: body,
      );
      if (!mounted) return;

      if (response.isSuccess) {
        await PatientCacheInvalidation.afterVitalsMutation();
        if (!mounted) return;
        // Mirror into HealthKit / Health Connect so the entry shows up alongside
        // wearable data. Fire-and-forget; backend is the source of truth.
        unawaited(
          HealthSyncService.instance.writeVitalsToHealthStore(
            heartRate: body['heartRate'] as int?,
            spO2: body['spO2'] as int?,
            weight: body['weight'] as double?,
            // HealthKit / Health Connect BODY_TEMPERATURE is canonical °C; the
            // form collects °F, so convert for the mirror. The backend POST
            // above still receives °F + the temperature_unit hint. Single
            // explicit conversion here — no double-convert downstream.
            temperature: body['temperature'] is num
                ? ((body['temperature'] as num).toDouble() - 32) * 5 / 9
                : null,
            systolic: body['bloodPressure'] is Map
                ? (body['bloodPressure'] as Map)['systolic'] as int?
                : null,
            diastolic: body['bloodPressure'] is Map
                ? (body['bloodPressure'] as Map)['diastolic'] as int?
                : null,
            bloodGlucose: body['bloodSugar'] as int?,
          ),
        );

        ScaffoldMessenger.of(context).showSnackBar(
          LiveRegionSnackBar.build(message: l.vitalsRecordedSuccess),
        );
        _formKey.currentState!.reset();
        _systolicCtrl.clear();
        _diastolicCtrl.clear();
        _heartRateCtrl.clear();
        _temperatureCtrl.clear();
        _bloodSugarCtrl.clear();
        _weightCtrl.clear();
        _spo2Ctrl.clear();
        widget.onSubmitted();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          LiveRegionSnackBar.build(
            message: response.failureMessage(l.vitalsRecordFailed),
          ),
        );
      }
    } catch (e) {
      if (kDebugMode) debugPrint('VitalsFormTab: submit error: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          LiveRegionSnackBar.build(message: l.vitalsRecordFailedRetry),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Widget _numericFieldSemantics({
    required String label,
    required Widget child,
  }) {
    return Semantics(
      container: true,
      label: label,
      textField: true,
      child: child,
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final l = AppLocalizations.of(context)!;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              l.vitalsLogHeading,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              l.vitalsLogSubheading,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),

            // Blood Pressure
            Text(l.vitalsBloodPressure, style: theme.textTheme.labelLarge),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: _numericFieldSemantics(
                    label: '${l.vitalsSystolic}, mmHg',
                    child: TextFormField(
                      controller: _systolicCtrl,
                      keyboardType: TextInputType.number,
                      decoration: InputDecoration(
                        labelText: l.vitalsSystolic,
                        suffixText: 'mmHg',
                        border: const OutlineInputBorder(),
                      ),
                      validator: (v) {
                        return patientVitalsFieldIssue(
                                  v,
                                  'systolic_bp',
                                  integer: true,
                                ) ==
                                null
                            ? null
                            : l.vitalsInvalidValue;
                      },
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _numericFieldSemantics(
                    label: '${l.vitalsDiastolic}, mmHg',
                    child: TextFormField(
                      controller: _diastolicCtrl,
                      keyboardType: TextInputType.number,
                      decoration: InputDecoration(
                        labelText: l.vitalsDiastolic,
                        suffixText: 'mmHg',
                        border: const OutlineInputBorder(),
                      ),
                      validator: (v) {
                        return patientVitalsFieldIssue(
                                  v,
                                  'diastolic_bp',
                                  integer: true,
                                ) ==
                                null
                            ? null
                            : l.vitalsInvalidValue;
                      },
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),

            // Heart Rate
            _numericFieldSemantics(
              label: '${l.vitalsHeartRate}, bpm',
              child: TextFormField(
                controller: _heartRateCtrl,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  labelText: l.vitalsHeartRate,
                  suffixText: 'bpm',
                  prefixIcon: const Icon(Icons.favorite_border),
                  border: const OutlineInputBorder(),
                ),
                validator: (v) {
                  return patientVitalsFieldIssue(
                            v,
                            'heart_rate',
                            integer: true,
                          ) ==
                          null
                      ? null
                      : l.vitalsHeartRateRange;
                },
              ),
            ),
            const SizedBox(height: 16),

            // Temperature
            _numericFieldSemantics(
              label: '${l.vitalsTemperature}, °F',
              child: TextFormField(
                controller: _temperatureCtrl,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                decoration: InputDecoration(
                  labelText: l.vitalsTemperature,
                  suffixText: '°F',
                  prefixIcon: const Icon(Icons.thermostat),
                  border: const OutlineInputBorder(),
                ),
                validator: (v) {
                  return patientVitalsFieldIssue(
                            v,
                            'temperature',
                            integer: false,
                            fahrenheit: true,
                          ) ==
                          null
                      ? null
                      : l.vitalsTemperatureRange;
                },
              ),
            ),
            const SizedBox(height: 16),

            // Blood Sugar
            _numericFieldSemantics(
              label: '${l.vitalsBloodSugar}, mg/dL',
              child: TextFormField(
                controller: _bloodSugarCtrl,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  labelText: l.vitalsBloodSugar,
                  suffixText: 'mg/dL',
                  prefixIcon: const Icon(Icons.water_drop_outlined),
                  border: const OutlineInputBorder(),
                ),
                validator: (v) {
                  return patientVitalsFieldIssue(
                            v,
                            'blood_glucose',
                            integer: true,
                          ) ==
                          null
                      ? null
                      : l.vitalsBloodSugarRange;
                },
              ),
            ),
            const SizedBox(height: 16),

            // Weight
            _numericFieldSemantics(
              label: '${l.vitalsWeight}, kg',
              child: TextFormField(
                controller: _weightCtrl,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                decoration: InputDecoration(
                  labelText: l.vitalsWeight,
                  suffixText: 'kg',
                  prefixIcon: const Icon(Icons.monitor_weight_outlined),
                  border: const OutlineInputBorder(),
                ),
                validator: (v) {
                  if (v != null && v.isNotEmpty) {
                    final n = double.tryParse(v);
                    if (n == null || n < 1 || n > 300) {
                      return l.vitalsWeightRange;
                    }
                  }
                  return null;
                },
              ),
            ),
            const SizedBox(height: 16),

            // SpO2
            _numericFieldSemantics(
              label: '${l.vitalsSpO2}, %',
              child: TextFormField(
                controller: _spo2Ctrl,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  labelText: l.vitalsSpO2,
                  suffixText: '%',
                  prefixIcon: const Icon(Icons.air),
                  border: const OutlineInputBorder(),
                ),
                validator: (v) {
                  return patientVitalsFieldIssue(v, 'spo2', integer: true) ==
                          null
                      ? null
                      : l.vitalsSpo2Range;
                },
              ),
            ),
            const SizedBox(height: 24),

            // Submit
            FilledButton.icon(
              onPressed: _submitting ? null : _submit,
              icon: _submitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.check),
              label: Text(
                _submitting ? l.vitalsSubmitting : l.vitalsRecordButton,
              ),
              style: FilledButton.styleFrom(
                backgroundColor: colors.error,
                foregroundColor: colors.onError,
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
