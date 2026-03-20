import 'package:go_router/go_router.dart';

import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class AskADoubtScreen extends StatefulWidget {
  final String phone;
  const AskADoubtScreen({super.key, required this.phone});

  @override
  State<AskADoubtScreen> createState() => _AskADoubtScreenState();
}

class _AskADoubtScreenState extends State<AskADoubtScreen> {
  final _formKey = GlobalKey<FormState>();
  final _questionController = TextEditingController();
  final _phoneController = TextEditingController();

  late final bool _isGuest;
  bool _isSubmitting = false;

  @override
  void initState() {
    super.initState();
    _isGuest = widget.phone.toLowerCase() == 'guest' || widget.phone.trim().isEmpty;
    _phoneController.text = _isGuest ? '' : widget.phone;
  }

  @override
  void dispose() {
    _questionController.dispose();
    _phoneController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate() || _isSubmitting) return;

    final loc = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);

    setState(() => _isSubmitting = true);

    try {
      final res = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/feedback'),
        headers: ApiConfig.jsonHeaders,
        body: jsonEncode({
          'phone': _phoneController.text.trim(),
          'question': _questionController.text.trim(),
        }),
      );

      setState(() => _isSubmitting = false);
      if (!mounted) return;

      if (res.statusCode == 200) {
        messenger.showSnackBar(SnackBar(
          content: Text(loc.feedbackSuccess),
          backgroundColor: Theme.of(context).colorScheme.primary,
          behavior: SnackBarBehavior.floating,
        ));
        context.pop();
      } else {
        var msg = loc.feedbackFailed;
        try {
          final body = jsonDecode(res.body);
          if (body['message'] != null) msg = body['message'];
        } catch (_) {}
        messenger.showSnackBar(SnackBar(
          content: Text(msg),
          backgroundColor: Theme.of(context).colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ));
      }
    } catch (_) {
      if (!mounted) return;
      setState(() => _isSubmitting = false);
      messenger.showSnackBar(SnackBar(
        content: Text(loc.networkError),
        backgroundColor: Theme.of(context).colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    }
  }

  void _triggerSOS() {
    final loc = AppLocalizations.of(context)!;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(loc.authSosTriggered),
      backgroundColor: Theme.of(context).colorScheme.error,
      behavior: SnackBarBehavior.floating,
    ));
  }

  @override
  Widget build(BuildContext context) {
    final loc = AppLocalizations.of(context)!;
    final color = FeatureScreenScaffold.featureColors['ask-a-doubt']!;

    return FeatureScreenScaffold(
      title: loc.askDoubt,
      icon: Icons.support_agent_outlined,
      color: color,
      heroTag: 'ask-a-doubt',
      floatingActionButton: FloatingActionButton(
        onPressed: _triggerSOS,
        tooltip: loc.authSosTooltip,
        backgroundColor: Colors.red,
        child: const Icon(Icons.sos_outlined),
      ),
      child: Form(
        key: _formKey,
        child: ListView(
          shrinkWrap: true,
          physics: const AlwaysScrollableScrollPhysics(), 
          padding: const EdgeInsets.all(16),
          children: [
            if (_isGuest) ...[
              TextFormField(
                controller: _phoneController,
                keyboardType: TextInputType.phone,
                decoration: InputDecoration(labelText: loc.authPhoneNumber),
                validator: (v) => v == null || v.trim().length != 10
                    ? loc.enterValidPhone
                    : null,
              ),
              const SizedBox(height: 16),
            ],
            TextFormField(
              controller: _questionController,
              minLines: 3,
              maxLines: 5,
              textInputAction: TextInputAction.newline,
              decoration: InputDecoration(
                labelText: loc.feedbackPlaceholder,
                hintText: loc.feedbackHint,
                alignLabelWithHint: true,
              ),
              validator: (v) => v == null || v.trim().isEmpty
                  ? loc.questionCannotBeEmpty
                  : null,
            ),
            const SizedBox(height: 24),
            ElevatedButton(
              onPressed: _isSubmitting ? null : _submit,
              child: _isSubmitting
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2.5),
                    )
                  : Text(loc.submit),
            ),
          ],
        ),
      ),
    );
  }
}
