import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth_core/vhhealth_core.dart'
    show SignaturePadController, SignaturePadField;

import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/features/settings/models/record_access_grant.dart';
import 'package:vhhealth/features/settings/services/record_access_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class RecordAccessScreen extends StatelessWidget {
  const RecordAccessScreen({
    super.key,
    this.repository = const ApiRecordAccessRepository(),
  });

  final RecordAccessRepository repository;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: l10n.recordAccessTitle,
      icon: Icons.manage_accounts_outlined,
      color: colors.primary,
      child: RecordAccessBody(repository: repository),
    );
  }
}

class RecordAccessBody extends StatefulWidget {
  const RecordAccessBody({super.key, required this.repository});

  final RecordAccessRepository repository;

  @override
  State<RecordAccessBody> createState() => _RecordAccessBodyState();
}

class _RecordAccessBodyState extends State<RecordAccessBody> {
  List<RecordAccessGrant> _grantedByMe = const [];
  List<HeldRecordAccessGrant> _heldByMe = const [];
  bool _isLoading = true;
  bool _isSaving = false;
  String? _error;
  String? _staleLabel;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _fetch();
    });
  }

  Future<void> _fetch() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _error = null;
    });
    final l10n = AppLocalizations.of(context)!;
    try {
      final page = await widget.repository.listGrants();
      if (!mounted) return;
      setState(() {
        _grantedByMe = page.grantedByMe;
        _heldByMe = page.heldByMe;
        _staleLabel = page.staleLabel;
        _isLoading = false;
      });
      page.onFresh
          ?.then((fresh) {
            if (!mounted) return;
            setState(() {
              _grantedByMe = fresh.grantedByMe;
              _heldByMe = fresh.heldByMe;
              _staleLabel = null;
            });
          })
          .catchError((Object e) {
            debugPrint('Record access background refresh failed: $e');
          });
    } catch (e) {
      debugPrint('Record access fetch failed: $e');
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _error = l10n.recordAccessLoadFailed;
      });
    }
  }

  Future<void> _openGrantSheet() async {
    final request = await showModalBottomSheet<_GrantRequest>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _GrantAccessSheet(),
    );
    if (request == null || !mounted) return;

    final l10n = AppLocalizations.of(context)!;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l10n.recordAccessGrantConfirmTitle),
        content: Text(l10n.recordAccessGrantConfirmBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(l10n.commonCancelButton),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(l10n.recordAccessGrantButton),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    setState(() => _isSaving = true);
    try {
      await widget.repository.createGrant(
        proxyUid: request.proxyUid,
        relationship: request.relationship,
        scope: request.scope,
        consentMethod: request.consentMethod,
        signaturePngBytes: request.signaturePngBytes,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l10n.recordAccessGrantSuccess)));
      await _fetch();
    } catch (e) {
      debugPrint('Record access grant failed: $e');
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l10n.recordAccessGrantFailed)));
    } finally {
      if (mounted) setState(() => _isSaving = false);
    }
  }

  Future<void> _confirmRevoke(RecordAccessGrant grant) async {
    final l10n = AppLocalizations.of(context)!;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l10n.recordAccessRevokeConfirmTitle),
        content: Text(l10n.recordAccessRevokeConfirmBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(l10n.commonCancelButton),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
            ),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(l10n.recordAccessRevokeButton),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    setState(() => _isSaving = true);
    try {
      await widget.repository.revokeGrant(
        grant.id,
        reason: l10n.recordAccessRevokedByPatient,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l10n.recordAccessRevokeSuccess)));
      await _fetch();
    } catch (e) {
      debugPrint('Record access revoke failed: $e');
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l10n.recordAccessRevokeFailed)));
    } finally {
      if (mounted) setState(() => _isSaving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final items = <_RecordAccessSection>[
      if (_grantedByMe.isNotEmpty) _RecordAccessSection.granted(_grantedByMe),
      if (_heldByMe.isNotEmpty) _RecordAccessSection.held(_heldByMe),
    ];

    return Stack(
      children: [
        Column(
          children: [
            OfflineBanner(staleLabel: _staleLabel),
            _ConsentHeader(onGrant: _isSaving ? null : _openGrantSheet),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _fetch,
                child: _buildGrantList(items, l10n),
              ),
            ),
          ],
        ),
        if (_isSaving)
          Positioned.fill(
            child: ColoredBox(
              color: Colors.black.withValues(alpha: 0.08),
              child: const Center(child: CircularProgressIndicator()),
            ),
          ),
      ],
    );
  }

  Widget _buildGrantList(
    List<_RecordAccessSection> items,
    AppLocalizations l10n,
  ) {
    if (_isLoading || _error != null || items.isEmpty) {
      return LayoutBuilder(
        builder: (context, constraints) {
          return SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            child: SizedBox(
              height: math.max(constraints.maxHeight, 320),
              child: DataStateBuilder<_RecordAccessSection>(
                isLoading: _isLoading,
                error: _error,
                data: items,
                onRetry: _fetch,
                emptyIcon: Icons.manage_accounts_outlined,
                emptyTitle: l10n.recordAccessEmptyTitle,
                emptySubtitle: l10n.recordAccessEmptySubtitle,
                builder: (_, _) => const SizedBox.shrink(),
              ),
            ),
          );
        },
      );
    }

    return DataStateBuilder<_RecordAccessSection>(
      isLoading: false,
      error: null,
      data: items,
      onRetry: _fetch,
      emptyIcon: Icons.manage_accounts_outlined,
      emptyTitle: l10n.recordAccessEmptyTitle,
      emptySubtitle: l10n.recordAccessEmptySubtitle,
      builder: (context, sections) {
        return ListView.builder(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 24),
          itemCount: sections.length,
          itemBuilder: (context, index) {
            final section = sections[index];
            return section.when(
              granted: (grants) => _GrantedByMeSection(
                grants: grants,
                onRevoke: _isSaving ? null : _confirmRevoke,
              ),
              held: (grants) => _HeldByMeSection(grants: grants),
            );
          },
        );
      },
    );
  }
}

class _ConsentHeader extends StatelessWidget {
  const _ConsentHeader({required this.onGrant});

  final VoidCallback? onGrant;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l10n = AppLocalizations.of(context)!;

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: cs.primaryContainer.withValues(alpha: 0.55),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: cs.primary.withValues(alpha: 0.18)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.privacy_tip_outlined, color: cs.primary),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    l10n.recordAccessConsentTitle,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              l10n.recordAccessConsentBody,
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 12),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: FilledButton.icon(
                onPressed: onGrant,
                icon: const Icon(Icons.person_add_alt_1_outlined),
                label: Text(l10n.recordAccessGrantButton),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _GrantedByMeSection extends StatelessWidget {
  const _GrantedByMeSection({required this.grants, required this.onRevoke});

  final List<RecordAccessGrant> grants;
  final Future<void> Function(RecordAccessGrant grant)? onRevoke;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return _SectionCard(
      title: l10n.recordAccessGrantedByMeTitle,
      child: Column(
        children: [
          for (var i = 0; i < grants.length; i++) ...[
            _GrantedGrantTile(grant: grants[i], onRevoke: onRevoke),
            if (i != grants.length - 1) const Divider(height: 1),
          ],
        ],
      ),
    );
  }
}

class _HeldByMeSection extends StatelessWidget {
  const _HeldByMeSection({required this.grants});

  final List<HeldRecordAccessGrant> grants;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return _SectionCard(
      title: l10n.recordAccessHeldByMeTitle,
      child: Column(
        children: [
          for (var i = 0; i < grants.length; i++) ...[
            _HeldGrantTile(grant: grants[i]),
            if (i != grants.length - 1) const Divider(height: 1),
          ],
        ],
      ),
    );
  }
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 8, 4, 8),
            child: Text(
              title,
              style: theme.textTheme.labelLarge?.copyWith(
                color: theme.colorScheme.primary,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          Card(
            margin: EdgeInsets.zero,
            clipBehavior: Clip.antiAlias,
            child: child,
          ),
        ],
      ),
    );
  }
}

class _GrantedGrantTile extends StatelessWidget {
  const _GrantedGrantTile({required this.grant, required this.onRevoke});

  final RecordAccessGrant grant;
  final Future<void> Function(RecordAccessGrant grant)? onRevoke;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l10n = AppLocalizations.of(context)!;
    final active = grant.isActive;
    return ListTile(
      key: ValueKey('record-access-grant-${grant.id}'),
      leading: CircleAvatar(
        backgroundColor: active
            ? cs.primaryContainer
            : cs.surfaceContainerHighest,
        foregroundColor: active ? cs.primary : cs.onSurfaceVariant,
        child: Icon(active ? Icons.verified_user_outlined : Icons.block),
      ),
      title: Text(_proxyTitle(context, grant.proxyUid, grant.relationship)),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${l10n.recordAccessStatus}: ${_statusLabel(context, grant.status)}',
            ),
            Text(
              '${l10n.recordAccessScope}: ${_scopeLabel(context, grant.scope)}',
            ),
            if (grant.grantedAt != null)
              Text(
                '${l10n.recordAccessGranted}: ${_formatDate(context, grant.grantedAt!)}',
              ),
            if (grant.expiresAt != null)
              Text(
                '${l10n.recordAccessExpires}: ${_formatDate(context, grant.expiresAt!)}',
              ),
            if (grant.revokedAt != null)
              Text(
                '${l10n.recordAccessRevoked}: ${_formatDate(context, grant.revokedAt!)}',
              ),
          ],
        ),
      ),
      trailing: active
          ? TextButton(
              onPressed: onRevoke == null ? null : () => onRevoke!(grant),
              child: Text(l10n.recordAccessRevokeButton),
            )
          : null,
    );
  }
}

class _HeldGrantTile extends StatelessWidget {
  const _HeldGrantTile({required this.grant});

  final HeldRecordAccessGrant grant;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;
    return ListTile(
      key: ValueKey('record-access-held-${grant.id}'),
      leading: CircleAvatar(
        backgroundColor: theme.colorScheme.secondaryContainer,
        foregroundColor: theme.colorScheme.secondary,
        child: const Icon(Icons.folder_shared_outlined),
      ),
      title: Text(_proxyTitle(context, grant.patientUid, grant.relationship)),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${l10n.recordAccessStatus}: ${_statusLabel(context, grant.status)}',
            ),
            Text(
              '${l10n.recordAccessScope}: ${_scopeLabel(context, grant.scope)}',
            ),
            if (grant.grantedAt != null)
              Text(
                '${l10n.recordAccessGranted}: ${_formatDate(context, grant.grantedAt!)}',
              ),
            if (grant.expiresAt != null)
              Text(
                '${l10n.recordAccessExpires}: ${_formatDate(context, grant.expiresAt!)}',
              ),
          ],
        ),
      ),
    );
  }
}

class _GrantAccessSheet extends StatefulWidget {
  const _GrantAccessSheet();

  @override
  State<_GrantAccessSheet> createState() => _GrantAccessSheetState();
}

class _GrantAccessSheetState extends State<_GrantAccessSheet> {
  final _formKey = GlobalKey<FormState>();
  final _proxyUidController = TextEditingController();
  final _relationshipController = TextEditingController();
  final _signatureController = SignaturePadController();
  String _consentMethod = 'written';
  final Set<String> _scope = {'results', 'claim_documents'};

  @override
  void dispose() {
    _proxyUidController.dispose();
    _relationshipController.dispose();
    _signatureController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + bottom),
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  l10n.recordAccessGrantSheetTitle,
                  style: Theme.of(
                    context,
                  ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 8),
                Text(l10n.recordAccessGrantSheetBody),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _proxyUidController,
                  decoration: InputDecoration(
                    labelText: l10n.recordAccessProxyUidLabel,
                    helperText: l10n.recordAccessProxyUidHelper,
                  ),
                  textInputAction: TextInputAction.next,
                  validator: (value) {
                    final text = value?.trim() ?? '';
                    if (text.isEmpty) return l10n.recordAccessProxyUidRequired;
                    if (!_uuidRegex.hasMatch(text)) {
                      return l10n.recordAccessProxyUidInvalid;
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _relationshipController,
                  decoration: InputDecoration(
                    labelText: l10n.recordAccessRelationshipLabel,
                    helperText: l10n.recordAccessRelationshipHelper,
                  ),
                  textInputAction: TextInputAction.done,
                  validator: (value) {
                    final text = value?.trim() ?? '';
                    return text.isEmpty
                        ? l10n.recordAccessRelationshipRequired
                        : null;
                  },
                ),
                const SizedBox(height: 16),
                Text(
                  l10n.recordAccessScope,
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _scope.contains('results'),
                  onChanged: null,
                  title: Text(l10n.recordAccessScopeResults),
                  subtitle: Text(l10n.recordAccessScopeResultsSubtitle),
                ),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _scope.contains('claim_documents'),
                  onChanged: (value) {
                    setState(() {
                      if (value == true) {
                        _scope.add('claim_documents');
                      } else {
                        _scope.remove('claim_documents');
                      }
                    });
                  },
                  title: Text(l10n.recordAccessScopeClaimDocuments),
                  subtitle: Text(l10n.recordAccessScopeClaimDocumentsSubtitle),
                ),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  initialValue: _consentMethod,
                  decoration: InputDecoration(
                    labelText: l10n.recordAccessConsentMethodLabel,
                  ),
                  items: [
                    DropdownMenuItem(
                      value: 'otp',
                      child: Text(l10n.recordAccessConsentMethodOtp),
                    ),
                    DropdownMenuItem(
                      value: 'written',
                      child: Text(l10n.recordAccessConsentMethodWritten),
                    ),
                    DropdownMenuItem(
                      value: 'verbal_documented',
                      child: Text(l10n.recordAccessConsentMethodVerbal),
                    ),
                    DropdownMenuItem(
                      value: 'guardian_minor',
                      child: Text(l10n.recordAccessConsentMethodGuardian),
                    ),
                  ],
                  onChanged: (value) {
                    if (value != null) setState(() => _consentMethod = value);
                  },
                ),
                const SizedBox(height: 16),
                SignaturePadField(
                  controller: _signatureController,
                  label: l10n.recordAccessSignatureLabel,
                  clearLabel: l10n.recordAccessSignatureClear,
                  emptyHint: l10n.recordAccessSignatureHint,
                ),
                const SizedBox(height: 20),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => Navigator.of(context).pop(),
                        child: Text(l10n.commonCancelButton),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton(
                        onPressed: _submit,
                        child: Text(l10n.recordAccessContinueButton),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final l10n = AppLocalizations.of(context)!;
    final signaturePngBytes = await _signatureController.toPngBytes();
    if (signaturePngBytes == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.recordAccessSignatureRequired)),
      );
      return;
    }
    if (!mounted) return;
    Navigator.of(context).pop(
      _GrantRequest(
        proxyUid: _proxyUidController.text.trim(),
        relationship: _relationshipController.text.trim(),
        scope: _scope.toList(growable: false),
        consentMethod: _consentMethod,
        signaturePngBytes: signaturePngBytes,
      ),
    );
  }
}

class _GrantRequest {
  const _GrantRequest({
    required this.proxyUid,
    required this.relationship,
    required this.scope,
    required this.consentMethod,
    required this.signaturePngBytes,
  });

  final String proxyUid;
  final String relationship;
  final List<String> scope;
  final String consentMethod;
  final Uint8List signaturePngBytes;
}

class _RecordAccessSection {
  const _RecordAccessSection._({this.granted, this.held});

  factory _RecordAccessSection.granted(List<RecordAccessGrant> grants) =>
      _RecordAccessSection._(granted: grants);

  factory _RecordAccessSection.held(List<HeldRecordAccessGrant> grants) =>
      _RecordAccessSection._(held: grants);

  final List<RecordAccessGrant>? granted;
  final List<HeldRecordAccessGrant>? held;

  T when<T>({
    required T Function(List<RecordAccessGrant>) granted,
    required T Function(List<HeldRecordAccessGrant>) held,
  }) {
    final grantedList = this.granted;
    if (grantedList != null) return granted(grantedList);
    return held(this.held ?? const []);
  }
}

final _uuidRegex = RegExp(
  r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
);

String _proxyTitle(BuildContext context, String uid, String? relationship) {
  final l10n = AppLocalizations.of(context)!;
  final rel = relationship?.trim();
  if (rel != null && rel.isNotEmpty) return rel;
  final suffix = uid.length >= 8 ? uid.substring(0, 8) : uid;
  return '${l10n.recordAccessProxyFallback} $suffix';
}

String _scopeLabel(BuildContext context, List<String> scope) {
  final l10n = AppLocalizations.of(context)!;
  if (scope.isEmpty) return l10n.recordAccessScopeResults;
  return scope
      .map((item) {
        switch (item) {
          case 'results':
            return l10n.recordAccessScopeResults;
          case 'claim_documents':
            return l10n.recordAccessScopeClaimDocuments;
          default:
            return item;
        }
      })
      .join(', ');
}

String _statusLabel(BuildContext context, String status) {
  final l10n = AppLocalizations.of(context)!;
  switch (status.toLowerCase()) {
    case 'active':
      return l10n.recordAccessStatusActive;
    case 'revoked':
      return l10n.recordAccessStatusRevoked;
    default:
      return status;
  }
}

String _formatDate(BuildContext context, DateTime date) {
  final locale = Localizations.localeOf(context).toLanguageTag();
  return DateFormat.yMMMd(locale).add_jm().format(date.toLocal());
}
