import 'package:flutter/material.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

/// Vitals Entry screen — for Nursing Staff to record patient vitals.
/// TODO: Integrate with backend when /staff/nursing/vitals endpoint is available.
class VitalsScreen extends StatefulWidget {
  const VitalsScreen({super.key});

  @override
  State<VitalsScreen> createState() => _VitalsScreenState();
}

class _VitalsScreenState extends State<VitalsScreen> {
  final _formKey = GlobalKey<FormState>();
  final _phoneCtrl = TextEditingController();
  final _bpSysCtrl = TextEditingController(); // Systolic
  final _bpDiaCtrl = TextEditingController(); // Diastolic
  final _tempCtrl = TextEditingController();
  final _pulseCtrl = TextEditingController();
  final _spo2Ctrl = TextEditingController();
  final _weightCtrl = TextEditingController();
  final _notesCtrl = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _bpSysCtrl.dispose();
    _bpDiaCtrl.dispose();
    _tempCtrl.dispose();
    _pulseCtrl.dispose();
    _spo2Ctrl.dispose();
    _weightCtrl.dispose();
    _notesCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _submitting = true);
    try {
      // TODO: Call backend API when endpoint is ready.
      // Example:
      // await StaffApiService.recordVitals(
      //   phone: _phoneCtrl.text.trim(),
      //   bloodPressure: '${_bpSysCtrl.text}/${_bpDiaCtrl.text}',
      //   temperature: double.tryParse(_tempCtrl.text),
      //   pulse: int.tryParse(_pulseCtrl.text),
      //   spo2: double.tryParse(_spo2Ctrl.text),
      //   weight: double.tryParse(_weightCtrl.text),
      //   notes: _notesCtrl.text.trim(),
      // );

      // Simulate success for now
      await Future.delayed(const Duration(milliseconds: 600));
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('✅ Vitals recorded successfully'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _formKey.currentState!.reset();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Vitals Entry',
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFFC62828), Color(0xFFE53935)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(14),
              ),
              child: const Row(
                children: [
                  Icon(Icons.monitor_heart, color: Colors.white, size: 36),
                  SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Record Patient Vitals',
                          style: TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.bold,
                              fontSize: 16),
                        ),
                        SizedBox(height: 2),
                        Text(
                          'Enter vitals by patient phone number',
                          style: TextStyle(color: Colors.white70, fontSize: 12),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            // Info banner (API not yet available)
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppTheme.warningAmber.withOpacity(0.08),
                borderRadius: BorderRadius.circular(8),
                border:
                    Border.all(color: AppTheme.warningAmber.withOpacity(0.3)),
              ),
              child: const Row(
                children: [
                  Icon(Icons.info_outline, color: AppTheme.warningAmber, size: 18),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Backend integration coming soon. Data is previewed locally only.',
                      style: TextStyle(
                          color: AppTheme.warningAmber, fontSize: 12),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            Form(
              key: _formKey,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Patient phone
                  TextFormField(
                    controller: _phoneCtrl,
                    keyboardType: TextInputType.phone,
                    decoration: const InputDecoration(
                      labelText: 'Patient Phone Number',
                      hintText: '+91 XXXXX XXXXX',
                      prefixIcon: Icon(Icons.phone_outlined),
                    ),
                    validator: (v) {
                      if (v == null || v.trim().isEmpty)
                        return 'Phone is required';
                      if (v.trim().length < 10)
                        return 'Enter valid phone number';
                      return null;
                    },
                  ),
                  const SizedBox(height: 20),

                  // Section: Blood Pressure
                  _SectionHeader(
                    icon: Icons.favorite,
                    label: 'Blood Pressure',
                    color: const Color(0xFFC62828),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(
                        child: TextFormField(
                          controller: _bpSysCtrl,
                          keyboardType: TextInputType.number,
                          decoration: const InputDecoration(
                            labelText: 'Systolic',
                            hintText: 'e.g. 120',
                            suffixText: 'mmHg',
                          ),
                          validator: (v) {
                            if (v == null || v.isEmpty) return null; // optional
                            final n = int.tryParse(v);
                            if (n == null || n < 60 || n > 300)
                              return 'Invalid';
                            return null;
                          },
                        ),
                      ),
                      const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 10),
                        child: Text('/', style: TextStyle(fontSize: 24)),
                      ),
                      Expanded(
                        child: TextFormField(
                          controller: _bpDiaCtrl,
                          keyboardType: TextInputType.number,
                          decoration: const InputDecoration(
                            labelText: 'Diastolic',
                            hintText: 'e.g. 80',
                            suffixText: 'mmHg',
                          ),
                          validator: (v) {
                            if (v == null || v.isEmpty) return null;
                            final n = int.tryParse(v);
                            if (n == null || n < 30 || n > 200)
                              return 'Invalid';
                            return null;
                          },
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),

                  // Temperature
                  _SectionHeader(
                    icon: Icons.thermostat,
                    label: 'Temperature',
                    color: const Color(0xFFE65100),
                  ),
                  const SizedBox(height: 10),
                  TextFormField(
                    controller: _tempCtrl,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                      labelText: 'Temperature',
                      hintText: 'e.g. 98.6',
                      suffixText: '°F',
                      prefixIcon: Icon(Icons.thermostat_outlined),
                    ),
                    validator: (v) {
                      if (v == null || v.isEmpty) return null;
                      final n = double.tryParse(v);
                      if (n == null || n < 90 || n > 115) return 'Invalid';
                      return null;
                    },
                  ),
                  const SizedBox(height: 20),

                  // Pulse & SpO2
                  _SectionHeader(
                    icon: Icons.speed,
                    label: 'Pulse & Oxygen Saturation',
                    color: const Color(0xFF0097A7),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(
                        child: TextFormField(
                          controller: _pulseCtrl,
                          keyboardType: TextInputType.number,
                          decoration: const InputDecoration(
                            labelText: 'Pulse',
                            hintText: 'e.g. 72',
                            suffixText: 'bpm',
                            prefixIcon: Icon(Icons.speed_outlined),
                          ),
                          validator: (v) {
                            if (v == null || v.isEmpty) return null;
                            final n = int.tryParse(v);
                            if (n == null || n < 20 || n > 250)
                              return 'Invalid';
                            return null;
                          },
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: TextFormField(
                          controller: _spo2Ctrl,
                          keyboardType:
                              const TextInputType.numberWithOptions(decimal: true),
                          decoration: const InputDecoration(
                            labelText: 'SpO₂',
                            hintText: 'e.g. 98',
                            suffixText: '%',
                            prefixIcon: Icon(Icons.air_outlined),
                          ),
                          validator: (v) {
                            if (v == null || v.isEmpty) return null;
                            final n = double.tryParse(v);
                            if (n == null || n < 50 || n > 100)
                              return 'Invalid';
                            return null;
                          },
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),

                  // Weight
                  _SectionHeader(
                    icon: Icons.monitor_weight,
                    label: 'Weight',
                    color: const Color(0xFF2E7D32),
                  ),
                  const SizedBox(height: 10),
                  TextFormField(
                    controller: _weightCtrl,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                      labelText: 'Weight',
                      hintText: 'e.g. 70.5',
                      suffixText: 'kg',
                      prefixIcon: Icon(Icons.monitor_weight_outlined),
                    ),
                    validator: (v) {
                      if (v == null || v.isEmpty) return null;
                      final n = double.tryParse(v);
                      if (n == null || n < 1 || n > 500) return 'Invalid';
                      return null;
                    },
                  ),
                  const SizedBox(height: 20),

                  // Notes
                  TextFormField(
                    controller: _notesCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Nurse Notes (optional)',
                      hintText: 'Any observations or concerns...',
                      prefixIcon: Icon(Icons.notes_outlined),
                      alignLabelWithHint: true,
                    ),
                    maxLines: 3,
                  ),
                  const SizedBox(height: 24),

                  ElevatedButton.icon(
                    onPressed: _submitting ? null : _submit,
                    icon: _submitting
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                                color: Colors.white, strokeWidth: 2))
                        : const Icon(Icons.save, color: Colors.white),
                    label: Text(_submitting ? 'Saving...' : 'Save Vitals'),
                    style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFFC62828)),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;

  const _SectionHeader({
    required this.icon,
    required this.label,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: 8),
        Text(
          label,
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.bold,
            color: color,
          ),
        ),
      ],
    );
  }
}
