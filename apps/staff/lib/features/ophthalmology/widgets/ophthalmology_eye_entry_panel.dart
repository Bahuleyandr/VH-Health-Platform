import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../l10n/app_strings.dart';

typedef OphthalmologyExamSubmit = Future<void> Function(
  Map<String, dynamic> payload,
);

class OphthalmologyEyeEntryPanel extends StatefulWidget {
  final OphthalmologyExamSubmit onSubmit;

  const OphthalmologyEyeEntryPanel({super.key, required this.onSubmit});

  @override
  State<OphthalmologyEyeEntryPanel> createState() =>
      _OphthalmologyEyeEntryPanelState();
}

class _OphthalmologyEyeEntryPanelState
    extends State<OphthalmologyEyeEntryPanel> {
  final _patientUid = TextEditingController();
  final _odVaUnaided = TextEditingController();
  final _osVaUnaided = TextEditingController();
  final _odIop = TextEditingController();
  final _osIop = TextEditingController();
  final _odAnterior = TextEditingController();
  final _osAnterior = TextEditingController();
  final _diagnosis = TextEditingController();
  final _advice = TextEditingController();

  String _iopMethod = 'gat';
  bool _submitting = false;

  static const _iopMethods = ['gat', 'nct', 'icare', 'schiotz'];

  @override
  void dispose() {
    _patientUid.dispose();
    _odVaUnaided.dispose();
    _osVaUnaided.dispose();
    _odIop.dispose();
    _osIop.dispose();
    _odAnterior.dispose();
    _osAnterior.dispose();
    _diagnosis.dispose();
    _advice.dispose();
    super.dispose();
  }

  double? _numberOrNull(TextEditingController controller) {
    final text = controller.text.trim();
    if (text.isEmpty) return null;
    return double.tryParse(text);
  }

  void _putText(
    Map<String, dynamic> payload,
    String key,
    TextEditingController controller,
  ) {
    final text = controller.text.trim();
    if (text.isNotEmpty) payload[key] = text;
  }

  Future<void> _submit() async {
    if (_submitting) return;
    final payload = <String, dynamic>{
      'patient_uid': _patientUid.text.trim(),
      'exam_type': 'comprehensive',
    };
    _putText(payload, 'od_va_unaided', _odVaUnaided);
    _putText(payload, 'os_va_unaided', _osVaUnaided);
    final odIop = _numberOrNull(_odIop);
    final osIop = _numberOrNull(_osIop);
    if (odIop != null) payload['od_iop_mmhg'] = odIop;
    if (osIop != null) payload['os_iop_mmhg'] = osIop;
    if (odIop != null || osIop != null) payload['iop_method'] = _iopMethod;
    _putText(payload, 'od_anterior_segment', _odAnterior);
    _putText(payload, 'os_anterior_segment', _osAnterior);
    _putText(payload, 'diagnosis', _diagnosis);
    _putText(payload, 'advice', _advice);

    setState(() => _submitting = true);
    try {
      await widget.onSubmit(payload);
      if (mounted) {
        _odVaUnaided.clear();
        _osVaUnaided.clear();
        _odIop.clear();
        _osIop.clear();
        _odAnterior.clear();
        _osAnterior.clear();
        _diagnosis.clear();
        _advice.clear();
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final twoColumn = constraints.maxWidth >= 760;
            final fieldWidth = twoColumn
                ? (constraints.maxWidth - 24) / 2
                : constraints.maxWidth;
            return SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  AppText(
                    's4.lib.ophthalmology.new_exam',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 12),
                  _textField(
                    context,
                    key: const Key('ophtho_patient_uid'),
                    controller: _patientUid,
                    labelKey: 's4.lib.ophthalmology.patient_uid',
                  ),
                  const SizedBox(height: 16),
                  Wrap(
                    spacing: 24,
                    runSpacing: 14,
                    children: [
                      SizedBox(
                        width: fieldWidth,
                        child: _EyeColumn(
                          titleKey: 's4.lib.ophthalmology.right_eye',
                          children: [
                            _textField(
                              context,
                              key: const Key('ophtho_od_va'),
                              controller: _odVaUnaided,
                              labelKey: 's4.lib.ophthalmology.va_unaided',
                              hintKey: 's4.lib.ophthalmology.va_hint',
                            ),
                            const SizedBox(height: 10),
                            _numberField(
                              context,
                              key: const Key('ophtho_od_iop'),
                              controller: _odIop,
                              labelKey: 's4.lib.ophthalmology.iop_mmhg',
                            ),
                            const SizedBox(height: 10),
                            _textField(
                              context,
                              key: const Key('ophtho_od_anterior'),
                              controller: _odAnterior,
                              labelKey: 's4.lib.ophthalmology.anterior_segment',
                              maxLines: 2,
                            ),
                          ],
                        ),
                      ),
                      SizedBox(
                        width: fieldWidth,
                        child: _EyeColumn(
                          titleKey: 's4.lib.ophthalmology.left_eye',
                          children: [
                            _textField(
                              context,
                              key: const Key('ophtho_os_va'),
                              controller: _osVaUnaided,
                              labelKey: 's4.lib.ophthalmology.va_unaided',
                              hintKey: 's4.lib.ophthalmology.va_hint',
                            ),
                            const SizedBox(height: 10),
                            _numberField(
                              context,
                              key: const Key('ophtho_os_iop'),
                              controller: _osIop,
                              labelKey: 's4.lib.ophthalmology.iop_mmhg',
                            ),
                            const SizedBox(height: 10),
                            _textField(
                              context,
                              key: const Key('ophtho_os_anterior'),
                              controller: _osAnterior,
                              labelKey: 's4.lib.ophthalmology.anterior_segment',
                              maxLines: 2,
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  DropdownButtonFormField<String>(
                    initialValue: _iopMethod,
                    decoration: InputDecoration(
                      labelText: s.lookup('s4.lib.ophthalmology.iop_method'),
                    ),
                    items: _iopMethods
                        .map(
                          (method) => DropdownMenuItem(
                            value: method,
                            child: Text(
                              s.lookup('s4.lib.ophthalmology.iop.$method'),
                            ),
                          ),
                        )
                        .toList(),
                    onChanged: (value) {
                      if (value != null) setState(() => _iopMethod = value);
                    },
                  ),
                  const SizedBox(height: 14),
                  _textField(
                    context,
                    key: const Key('ophtho_diagnosis'),
                    controller: _diagnosis,
                    labelKey: 's4.lib.ophthalmology.diagnosis',
                    maxLines: 2,
                  ),
                  const SizedBox(height: 10),
                  _textField(
                    context,
                    key: const Key('ophtho_advice'),
                    controller: _advice,
                    labelKey: 's4.lib.ophthalmology.advice',
                    maxLines: 2,
                  ),
                  const SizedBox(height: 16),
                  Align(
                    alignment: Alignment.centerRight,
                    child: FilledButton.icon(
                      key: const Key('ophtho_submit_exam'),
                      onPressed: _submitting ? null : _submit,
                      icon: _submitting
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.visibility_outlined),
                      label: const AppText('s4.lib.ophthalmology.record_exam'),
                    ),
                  ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _textField(
    BuildContext context, {
    required Key key,
    required TextEditingController controller,
    required String labelKey,
    String? hintKey,
    int maxLines = 1,
  }) {
    final s = AppStrings.of(context);
    return TextField(
      key: key,
      controller: controller,
      maxLines: maxLines,
      decoration: InputDecoration(
        labelText: s.lookup(labelKey),
        hintText: hintKey == null ? null : s.lookup(hintKey),
        border: const OutlineInputBorder(),
      ),
    );
  }

  Widget _numberField(
    BuildContext context, {
    required Key key,
    required TextEditingController controller,
    required String labelKey,
  }) {
    final s = AppStrings.of(context);
    return TextField(
      key: key,
      controller: controller,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
      decoration: InputDecoration(
        labelText: s.lookup(labelKey),
        border: const OutlineInputBorder(),
      ),
    );
  }
}

class _EyeColumn extends StatelessWidget {
  final String titleKey;
  final List<Widget> children;

  const _EyeColumn({required this.titleKey, required this.children});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AppText(titleKey, style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 8),
        ...children,
      ],
    );
  }
}
