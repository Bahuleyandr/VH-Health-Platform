// Log Vitals tab — the form half of VitalsScreen. Extracted from the
// former god-screen so the screen file stays a thin tab coordinator.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/health_sync_service.dart';

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
          ).showSnackBar(SnackBar(content: Text(l.vitalsAtLeastOne)));
        }
        return;
      }

      final response = await ApiClient.post(
        '/health/patient/vitals',
        body: body,
      );
      if (!mounted) return;

      if (response.isSuccess) {
        // Mirror into HealthKit / Health Connect so the entry shows up alongside
        // wearable data. Fire-and-forget; backend is the source of truth.
        unawaited(
          HealthSyncService.instance.writeVitalsToHealthStore(
            heartRate: body['heartRate'] as int?,
            spO2: body['spO2'] as int?,
            weight: body['weight'] as double?,
            temperature: body['temperature'] as double?,
            systolic: body['bloodPressure'] is Map
                ? (body['bloodPressure'] as Map)['systolic'] as int?
                : null,
            diastolic: body['bloodPressure'] is Map
                ? (body['bloodPressure'] as Map)['diastolic'] as int?
                : null,
            bloodGlucose: body['bloodSugar'] as int?,
          ),
        );

        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l.vitalsRecordedSuccess)));
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
          SnackBar(content: Text(response.message ?? l.vitalsRecordFailed)),
        );
      }
    } catch (e) {
      if (kDebugMode) debugPrint('VitalsFormTab: submit error: $e');
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l.vitalsRecordFailedRetry)));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
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
              style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey),
            ),
            const SizedBox(height: 16),

            // Blood Pressure
            Text(l.vitalsBloodPressure, style: theme.textTheme.labelLarge),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextFormField(
                    controller: _systolicCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'Systolic',
                      suffixText: 'mmHg',
                      border: OutlineInputBorder(),
                    ),
                    validator: (v) {
                      if (v != null && v.isNotEmpty) {
                        final n = int.tryParse(v);
                        if (n == null || n < 50 || n > 300) return 'Invalid';
                      }
                      return null;
                    },
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextFormField(
                    controller: _diastolicCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'Diastolic',
                      suffixText: 'mmHg',
                      border: OutlineInputBorder(),
                    ),
                    validator: (v) {
                      if (v != null && v.isNotEmpty) {
                        final n = int.tryParse(v);
                        if (n == null || n < 20 || n > 200) return 'Invalid';
                      }
                      return null;
                    },
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),

            // Heart Rate
            TextFormField(
              controller: _heartRateCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'Heart Rate',
                suffixText: 'bpm',
                prefixIcon: Icon(Icons.favorite_border),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                if (v != null && v.isNotEmpty) {
                  final n = int.tryParse(v);
                  if (n == null || n < 30 || n > 250) return 'Enter 30-250 bpm';
                }
                return null;
              },
            ),
            const SizedBox(height: 16),

            // Temperature
            TextFormField(
              controller: _temperatureCtrl,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: const InputDecoration(
                labelText: 'Temperature',
                suffixText: '°F',
                prefixIcon: Icon(Icons.thermostat),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                if (v != null && v.isNotEmpty) {
                  final n = double.tryParse(v);
                  if (n == null || n < 90 || n > 110) {
                    return 'Enter 90-110 °F';
                  }
                }
                return null;
              },
            ),
            const SizedBox(height: 16),

            // Blood Sugar
            TextFormField(
              controller: _bloodSugarCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'Blood Sugar',
                suffixText: 'mg/dL',
                prefixIcon: Icon(Icons.water_drop_outlined),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                if (v != null && v.isNotEmpty) {
                  final n = int.tryParse(v);
                  if (n == null || n < 20 || n > 600) {
                    return 'Enter 20-600 mg/dL';
                  }
                }
                return null;
              },
            ),
            const SizedBox(height: 16),

            // Weight
            TextFormField(
              controller: _weightCtrl,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: const InputDecoration(
                labelText: 'Weight',
                suffixText: 'kg',
                prefixIcon: Icon(Icons.monitor_weight_outlined),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                if (v != null && v.isNotEmpty) {
                  final n = double.tryParse(v);
                  if (n == null || n < 1 || n > 300) return 'Enter 1-300 kg';
                }
                return null;
              },
            ),
            const SizedBox(height: 16),

            // SpO2
            TextFormField(
              controller: _spo2Ctrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'SpO2',
                suffixText: '%',
                prefixIcon: Icon(Icons.air),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                if (v != null && v.isNotEmpty) {
                  final n = int.tryParse(v);
                  if (n == null || n < 50 || n > 100) return 'Enter 50-100%';
                }
                return null;
              },
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
              label: Text(_submitting ? 'Submitting...' : 'Record Vitals'),
              style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFFE57373),
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
