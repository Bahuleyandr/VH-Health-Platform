import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_strings.dart';
import '../providers/clinical_inbox_provider.dart';
import '../services/clinical_inbox_api_service.dart';
import '../services/hr_api_service.dart';
import 'online_only_action_state.dart';

typedef MarPrescriberLoader = Future<List<MarPrescriberOption>> Function();

const Set<String> _handoffOperatorRoles = {'ADMIN', 'SUPER_ADMIN'};
const Set<String> _prescriberRoles = {
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
};
final RegExp _uuidPattern = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);

@visibleForTesting
bool canHandoffMarMedicationException(String role, ClinicalInboxTask task) {
  return _handoffOperatorRoles.contains(role.trim().toUpperCase()) &&
      task.isMarMedicationException &&
      task.assignedToUid.isNotEmpty;
}

class MarPrescriberOption {
  const MarPrescriberOption({
    required this.uid,
    required this.name,
    required this.role,
  });

  final String uid;
  final String name;
  final String role;
}

Future<List<MarPrescriberOption>> loadActiveMarPrescribers() async {
  final byUid = <String, MarPrescriberOption>{};
  for (final role in _prescriberRoles) {
    var page = 1;
    while (true) {
      final rows = await HrApiService.getStaffList(
        role: role,
        active: true,
        page: page,
        limit: 100,
        suppressErrors: false,
      );
      for (final raw in rows.whereType<Map>()) {
        final row = raw.cast<String, dynamic>();
        final uid = '${row['uid'] ?? ''}'.trim();
        final rowRole = '${row['role'] ?? ''}'.trim().toUpperCase();
        final active = row['is_active'] ?? row['isActive'];
        if (!_uuidPattern.hasMatch(uid) ||
            !_prescriberRoles.contains(rowRole) ||
            active == false) {
          continue;
        }
        final name = '${row['name'] ?? row['fullName'] ?? uid}'.trim();
        byUid[uid] = MarPrescriberOption(
          uid: uid,
          name: name.isEmpty ? uid : name,
          role: rowRole,
        );
      }
      if (rows.length < 100) break;
      page += 1;
    }
  }
  final options = byUid.values.toList(growable: false);
  options.sort((left, right) {
    final byName = left.name.toLowerCase().compareTo(right.name.toLowerCase());
    return byName != 0 ? byName : left.uid.compareTo(right.uid);
  });
  return options;
}

class MarMedicationExceptionHandoffSheet extends StatefulWidget {
  const MarMedicationExceptionHandoffSheet({
    required this.task,
    required this.loadActivePrescribers,
  });

  final ClinicalInboxTask task;
  final MarPrescriberLoader loadActivePrescribers;

  @override
  State<MarMedicationExceptionHandoffSheet> createState() =>
      _MarMedicationExceptionHandoffSheetState();
}

class _MarMedicationExceptionHandoffSheetState
    extends State<MarMedicationExceptionHandoffSheet> {
  final _formKey = GlobalKey<FormState>();
  final _reasonController = TextEditingController();
  List<MarPrescriberOption> _prescribers = const [];
  late String _expectedPrescriberUid;
  String? _selectedPrescriberUid;
  String? _loadError;
  String? _commandError;
  bool _loading = true;
  bool _confirmed = false;
  bool _submitting = false;
  bool _noLongerActionable = false;

  @override
  void initState() {
    super.initState();
    _expectedPrescriberUid = widget.task.assignedToUid;
    unawaited(_loadPrescribers());
  }

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  Future<void> _loadPrescribers() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final loaded = await widget.loadActivePrescribers();
      if (!mounted) return;
      setState(() {
        _prescribers = loaded
            .where((prescriber) => prescriber.uid != _expectedPrescriberUid)
            .toList(growable: false);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loadError = AppStrings.of(context)
            .lookup('clinical_inbox.mar_handoff.prescribers_failed');
      });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _submit() async {
    final strings = AppStrings.of(context);
    if (!OnlineOnlyActionGuard.require(
      context,
      message: strings.lookup('clinical_inbox.mar_handoff.requires_connection'),
    )) {
      return;
    }
    if (!(_formKey.currentState?.validate() ?? false) || !_confirmed) {
      setState(() {});
      return;
    }
    final targetPrescriberUid = _selectedPrescriberUid;
    if (targetPrescriberUid == null) return;
    setState(() {
      _submitting = true;
      _commandError = null;
    });
    try {
      final currentTask = context
          .read<ClinicalInboxProvider>()
          .tasks
          .firstWhere(
            (candidate) => candidate.id == widget.task.id,
            orElse: () => widget.task,
          );
      final receipt = await context
          .read<ClinicalInboxProvider>()
          .handoffMarMedicationException(
            task: currentTask,
            expectedPrescriberUid: _expectedPrescriberUid,
            targetPrescriberUid: targetPrescriberUid,
            reason: _reasonController.text,
          );
      if (!mounted) return;
      Navigator.pop(context, receipt);
    } on MarMedicationExceptionHandoffException catch (error) {
      if (!mounted) return;
      if (error.requiresRefresh) {
        final refreshedTasks = context
            .read<ClinicalInboxProvider>()
            .tasks
            .where(
              (candidate) =>
                  candidate.id == widget.task.id &&
                  candidate.isMarMedicationException &&
                  candidate.assignedToUid.isNotEmpty,
            )
            .toList(growable: false);
        final refreshed = refreshedTasks.isEmpty ? null : refreshedTasks.first;
        if (refreshed == null) {
          setState(() {
            _noLongerActionable = true;
            _confirmed = false;
            _commandError = strings.lookup(
              'clinical_inbox.mar_handoff.no_longer_actionable',
            );
          });
        } else {
          setState(() {
            _expectedPrescriberUid = refreshed.assignedToUid;
            if (_selectedPrescriberUid == _expectedPrescriberUid) {
              _selectedPrescriberUid = null;
            }
            _confirmed = false;
            _commandError = strings.lookup(
              'clinical_inbox.mar_handoff.stale_owner',
            );
          });
          await _loadPrescribers();
        }
      } else {
        setState(() {
          _commandError = strings.format('clinical_inbox.mar_handoff.failed', {
            'reason': error.message,
          });
        });
      }
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _commandError = strings.format('clinical_inbox.mar_handoff.failed', {
          'reason': error.toString(),
        });
      });
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: SingleChildScrollView(
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  strings.lookup('clinical_inbox.mar_handoff.title'),
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 8),
                Text(strings.lookup('clinical_inbox.mar_handoff.body')),
                const SizedBox(height: 16),
                _HandoffDetailLine(
                  label: strings.lookup('clinical_inbox.mar_handoff.case_id'),
                  value: widget.task.relatedResourceId,
                ),
                _HandoffDetailLine(
                  label: strings.lookup(
                    'clinical_inbox.mar_handoff.current_prescriber',
                  ),
                  value: _expectedPrescriberUid,
                ),
                if (_loading)
                  const Center(child: CircularProgressIndicator())
                else if (_loadError != null) ...[
                  Text(
                    _loadError!,
                    key: const Key('mar-handoff-prescriber-load-error'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                  TextButton(
                    key: const Key('mar-handoff-prescriber-retry'),
                    onPressed: _loadPrescribers,
                    child: Text(strings.actionRetry),
                  ),
                ] else if (_prescribers.isEmpty)
                  Text(
                    strings.lookup('clinical_inbox.mar_handoff.no_prescribers'),
                  )
                else
                  DropdownButtonFormField<String>(
                    key: ValueKey(
                      'mar-handoff-prescriber:$_expectedPrescriberUid',
                    ),
                    initialValue: _selectedPrescriberUid,
                    isExpanded: true,
                    decoration: InputDecoration(
                      labelText: strings.lookup(
                        'clinical_inbox.mar_handoff.target_prescriber',
                      ),
                      border: const OutlineInputBorder(),
                    ),
                    items: [
                      for (final prescriber in _prescribers)
                        DropdownMenuItem(
                          value: prescriber.uid,
                          child: Text(
                            '${prescriber.name} (${prescriber.role})',
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                    validator: (value) => value == null
                        ? strings.lookup(
                            'clinical_inbox.mar_handoff.prescriber_required',
                          )
                        : null,
                    onChanged: _submitting || _noLongerActionable
                        ? null
                        : (value) => setState(() {
                            _selectedPrescriberUid = value;
                            _confirmed = false;
                            _commandError = null;
                          }),
                  ),
                const SizedBox(height: 12),
                TextFormField(
                  key: const Key('mar-handoff-reason'),
                  controller: _reasonController,
                  enabled: !_submitting && !_noLongerActionable,
                  minLines: 2,
                  maxLines: 5,
                  maxLength: 500,
                  decoration: InputDecoration(
                    labelText: strings.lookup(
                      'clinical_inbox.mar_handoff.reason',
                    ),
                    hintText: strings.lookup(
                      'clinical_inbox.mar_handoff.reason_hint',
                    ),
                    border: const OutlineInputBorder(),
                  ),
                  validator: (value) {
                    final length = value?.trim().length ?? 0;
                    return length < 5
                        ? strings.lookup(
                            'clinical_inbox.mar_handoff.reason_required',
                          )
                        : null;
                  },
                  onChanged: (_) => setState(() {
                    _confirmed = false;
                    _commandError = null;
                  }),
                ),
                CheckboxListTile(
                  key: const Key('mar-handoff-confirmation'),
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: _confirmed,
                  onChanged: _submitting || _noLongerActionable
                      ? null
                      : (value) => setState(() => _confirmed = value == true),
                  title: Text(
                    strings.lookup('clinical_inbox.mar_handoff.confirmation'),
                  ),
                  subtitle: !_confirmed && !_noLongerActionable
                      ? Text(
                          strings.lookup(
                            'clinical_inbox.mar_handoff.confirmation_required',
                          ),
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        )
                      : null,
                ),
                if (_commandError != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    _commandError!,
                    key: const Key('mar-handoff-command-error'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: OnlineOnlyActionState(
                    builder: (context, isOnline, offlineMessage) =>
                        FilledButton.icon(
                          key: const Key('mar-handoff-submit'),
                          onPressed:
                              _submitting ||
                                  _loading ||
                                  _loadError != null ||
                                  _prescribers.isEmpty ||
                                  _noLongerActionable ||
                                  !isOnline
                              ? null
                              : _submit,
                          icon: _submitting
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.person_pin_outlined),
                          label: Text(
                            strings.lookup(
                              _submitting
                                  ? 'clinical_inbox.mar_handoff.submitting'
                                  : 'clinical_inbox.mar_handoff.submit',
                            ),
                          ),
                        ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _HandoffDetailLine extends StatelessWidget {
  const _HandoffDetailLine({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              label,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }
}
