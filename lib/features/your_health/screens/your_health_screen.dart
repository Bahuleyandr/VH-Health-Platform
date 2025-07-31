// Refactored your_health_screen.dart using FeatureScreenScaffold
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';
import 'package:permission_handler/permission_handler.dart';

import 'package:vhhealth/core/utils/cache_file_utils.dart';
import 'package:vhhealth/core/offline/record_cache_manager.dart';
import 'package:vhhealth/core/utils/permissions_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/l10n/app_localizations_ext.dart';

class YourHealthScreen extends StatefulWidget {
  final String phone;
  const YourHealthScreen({super.key, required this.phone});

  @override
  State<YourHealthScreen> createState() => _YourHealthScreenState();
}

class _YourHealthScreenState extends State<YourHealthScreen> {
  List<dynamic> records = [];
  bool _isLoading = true;
  String _selectedType = 'All';
  bool _newestFirst = true;
  late final bool _isGuest;
  late final Color _color;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final raw = ModalRoute.of(context)?.settings.arguments;
    final args = raw is Map ? raw : <String, dynamic>{};
    _color = args['color'] ?? FeatureScreenScaffold.featureColors['your-health']!;
    if (args['defaultFilter'] == 'Investigation') {
      _selectedType = 'Investigation';
    }
    _isGuest = widget.phone.trim().isEmpty || widget.phone.toLowerCase() == 'guest';
    _isGuest ? setState(() => _isLoading = false) : _fetchRecords();
  }

  Future<void> _fetchRecords() async {
    if (!mounted) return;
    setState(() => _isLoading = true);

    final uri = Uri.parse(
      'https://vh-health-backend.onrender.com/api/v1/health-records/${widget.phone}'
      '${_selectedType == 'All' ? '' : '?type=${_selectedType.toLowerCase()}'}',
    );

    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;

    try {
      final resp = await http.get(uri, headers: {'x-api-key': 'vhhealth123'});
      if (!mounted) return;

      if (resp.statusCode == 200) {
        final data = jsonDecode(resp.body) as List<dynamic>;
        await RecordCacheManager.saveManifest(widget.phone, data);
        if (!mounted) return;
        setState(() {
          records = _newestFirst ? data : data.reversed.toList();
          _isLoading = false;
        });
      } else {
        _tryLoadFromCache(messenger, theme, l10n.recordsLoadFailed);
      }
    } catch (_) {
      _tryLoadFromCache(messenger, theme, l10n.networkError);
    }
  }

  Future<void> _tryLoadFromCache(
    ScaffoldMessengerState messenger,
    ThemeData theme,
    String errorMsg,
  ) async {
    final cached = await RecordCacheManager.loadManifest(widget.phone);
    final l10n = AppLocalizations.of(context)!;

    if (!mounted) return;
    if (cached != null && cached.isNotEmpty) {
      setState(() {
        records = _newestFirst ? cached : cached.reversed.toList();
        _isLoading = false;
      });
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.recordsShowingOffline),
        backgroundColor: theme.colorScheme.tertiary,
        behavior: SnackBarBehavior.floating,
      ));
    } else {
      setState(() => _isLoading = false);
      messenger.showSnackBar(SnackBar(
        content: Text(errorMsg),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    }
  }

  void _onTypeChanged(String? type) {
    if (type != null && type != _selectedType) {
      setState(() => _selectedType = type);
      _fetchRecords();
    }
  }

  void _toggleSort() {
    if (records.isEmpty) return;
    setState(() {
      _newestFirst = !_newestFirst;
      records = records.reversed.toList();
    });
  }

  Future<void> _downloadIfSafe(String fileKey) async {
    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;

    final granted = await PermissionsService.ensurePermission(
      context,
      Permission.photos,
    );
    if (!granted) {
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.downloadPermissionDenied),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
      return;
    }

    final url = Uri.parse('https://vh-health-backend.onrender.com/api/v1/uploads/$fileKey');

    try {
      final resp = await http.get(url, headers: {'x-api-key': 'vhhealth123'});
      if (!mounted) return;

      if (resp.statusCode == 200) {
        final data = jsonDecode(resp.body);
        if (data['quarantined'] == true) {
          messenger.showSnackBar(SnackBar(
            content: Text(l10n.fileQuarantined),
            backgroundColor: theme.colorScheme.error,
            behavior: SnackBarBehavior.floating,
          ));
          return;
        }

        final downloadUrl = data['storage_url'] as String?;
        if (downloadUrl == null || downloadUrl.isEmpty) throw Exception();

        final fileName = fileKey.split('/').last;
        final file = await CacheFileUtils.downloadAndCacheFile(fileName, downloadUrl);

        if (file != null) {
          await CacheFileUtils.openCachedFile(file.path);
        } else {
          throw Exception();
        }
      } else {
        throw Exception();
      }
    } catch (_) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.fileCouldNotOpen),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final dateFmt = DateFormat.yMMMd(Localizations.localeOf(context).toString());

    return FeatureScreenScaffold(
      title: l10n.yourHealthTitle,
      icon: Icons.monitor_heart_outlined, // ✅ valid alternative icon
      color: _color,
      heroTag: 'yourHealth',
      child: _isGuest
          ? _buildGuestView(theme, cs, l10n)
          : _buildRecordsView(theme, cs, dateFmt, l10n),
    );
  }

  Widget _buildGuestView(ThemeData theme, ColorScheme cs, AppLocalizations l10n) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.lock_outline, size: 60, color: cs.onSurface.withAlpha(153)), // 60% opacity
            const SizedBox(height: 16),
            Text(
              l10n.yourHealthLoginToView,
              style: theme.textTheme.titleMedium?.copyWith(color: cs.onSurfaceVariant),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            ElevatedButton.icon(
              icon: const Icon(Icons.arrow_back_outlined),
              label: Text(l10n.backToDashboard),
              onPressed: () => Navigator.of(context).pop(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRecordsView(
    ThemeData theme,
    ColorScheme cs,
    DateFormat df,
    AppLocalizations l10n,
  ) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: DropdownButtonFormField<String>(
            value: _selectedType,
            decoration: InputDecoration(labelText: l10n.yourHealthFilterByType),
            onChanged: _onTypeChanged,
            items: const ['All', 'Consultation', 'Investigation', 'Report']
                .map((type) => DropdownMenuItem(
                      value: type,
                      child: Text(
                        l10n.recordTypeLabel(type),
                        style: theme.textTheme.bodyLarge?.copyWith(
                          color: _selectedType == type ? cs.primary : cs.onSurface,
                        ),
                      ),
                    ))
                .toList(),
          ),
        ),
        Align(
          alignment: Alignment.centerRight,
          child: Padding(
            padding: const EdgeInsets.only(right: 16.0),
            child: IconButton(
              tooltip: _newestFirst ? l10n.yourHealthSortOldest : l10n.yourHealthSortNewest,
              icon: Icon(
                _newestFirst ? Icons.arrow_downward_outlined : Icons.arrow_upward_outlined,
                color: cs.onSurface,
              ),
              onPressed: _toggleSort,
            ),
          ),
        ),
        Expanded(
          child: _isLoading
              ? Center(child: CircularProgressIndicator(valueColor: AlwaysStoppedAnimation(cs.primary)))
              : records.isEmpty
                  ? Center(child: Text(l10n.yourHealthNoRecords))
                  : ListView.builder(
                      itemCount: records.length,
                      itemBuilder: (_, i) {
                        final item = records[i];
                        final type = item['type']?.toString() ?? 'Record';
                        final fileKey = item['file_key']?.toString() ?? '';

                        DateTime? uploaded;
                        if (item['uploaded_at'] != null) {
                          try {
                            uploaded = DateTime.parse(item['uploaded_at']).toLocal();
                          } catch (_) {}
                        }

                        return Card(
                          child: ListTile(
                            leading: Icon(_iconFor(type), color: cs.primary),
                            title: Text(l10n.recordTypeLabel(type)),
                            subtitle: Text(
                              '${l10n.yourHealthUploaded}: '
                              '${uploaded != null ? df.format(uploaded) : l10n.notAvailable}',
                            ),
                            trailing: IconButton(
                              icon: const Icon(Icons.download_for_offline_outlined),
                              onPressed: fileKey.isNotEmpty ? () => _downloadIfSafe(fileKey) : null,
                            ),
                          ),
                        );
                      },
                    ),
        ),
      ],
    );
  }

  IconData _iconFor(String t) {
    switch (t.toLowerCase()) {
      case 'consultation':
        return Icons.medical_services_outlined;
      case 'investigation':
        return Icons.biotech_outlined;
      case 'report':
        return Icons.assessment_outlined;
      default:
        return Icons.insert_drive_file_outlined;
    }
  }
}