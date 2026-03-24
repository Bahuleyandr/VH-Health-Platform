import 'package:go_router/go_router.dart';

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/utils/permissions_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/core/theme/theme_colors.dart';

class PharmacyScreen extends StatefulWidget {
  final String phone;
  const PharmacyScreen({super.key, required this.phone});

  @override
  State<PharmacyScreen> createState() => _PharmacyScreenState();
}

class _PharmacyScreenState extends State<PharmacyScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  final _formKey = GlobalKey<FormState>();
  final _addressController = TextEditingController();
  final _phoneController = TextEditingController();

  File? _file;
  String? _fileName;
  bool _isSubmitting = false;
  late final bool _isGuest;

  // Order history
  List<dynamic> _orders = [];
  bool _isLoadingOrders = true;

  static const _pharmacyPhoneNumber = '+919999999999';

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _isGuest = widget.phone.toLowerCase() == 'guest' || widget.phone.trim().isEmpty;
    _phoneController.text = _isGuest ? '' : widget.phone;
    _fetchOrders();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _addressController.dispose();
    _phoneController.dispose();
    super.dispose();
  }

  // ── Fetch order history ────────────────────────────────────────
  Future<void> _fetchOrders() async {
    try {
      final uid = FirebaseAuth.instance.currentUser?.uid;
      if (uid == null) {
        setState(() => _isLoadingOrders = false);
        return;
      }

      final uri = Uri.parse('${ApiConfig.baseUrl}/pharmacy-orders/orders/uid/$uid');
      final res = await http.get(uri, headers: await ApiConfig.authenticatedAuthHeaders())
          .timeout(const Duration(seconds: 10));

      if (!mounted) return;

      if (res.statusCode == 200) {
        final body = jsonDecode(res.body);
        final data = body['data'] ?? body ?? [];
        setState(() {
          _orders = data is List ? data : [];
          _isLoadingOrders = false;
        });
      } else {
        setState(() => _isLoadingOrders = false);
      }
    } catch (_) {
      if (mounted) setState(() => _isLoadingOrders = false);
    }
  }

  // ── Request refill from past order ─────────────────────────────
  Future<void> _requestRefill(Map<String, dynamic> order) async {
    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Request Refill'),
        content: Text(
          'Request a refill for this order?\n\n'
          '${order['order_note'] ?? 'Previous prescription order'}',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Request')),
        ],
      ),
    );

    if (confirmed != true || !mounted) return;

    setState(() => _isSubmitting = true);

    try {
      final phone = order['phone']?.toString() ?? widget.phone;
      final body = {
        'phone': phone,
        'order_note': 'REFILL: ${order['order_note'] ?? 'Refill request'}',
        if (order['file_key'] != null) 'file_key': order['file_key'],
      };

      final res = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/pharmacy-orders/orders'),
        headers: await ApiConfig.authenticatedHeaders(),
        body: jsonEncode(body),
      );

      if (res.statusCode == 200 || res.statusCode == 201) {
        messenger.showSnackBar(SnackBar(
          content: const Text('Refill requested! Pharmacy will confirm.'),
          backgroundColor: theme.colorScheme.primary,
          behavior: SnackBarBehavior.floating,
        ));
        _fetchOrders(); // Refresh list
      } else {
        final msg = (jsonDecode(res.body)['message'] ?? 'Refill request failed').toString();
        messenger.showSnackBar(SnackBar(
          content: Text(msg),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ));
      }
    } catch (_) {
      messenger.showSnackBar(SnackBar(
        content: const Text('Network error. Try again.'),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  // ── File picker / upload / submit (existing logic) ─────────────

  Future<bool> _ensurePickerPermissions() async {
    const needs = [Permission.photos, Permission.storage];
    for (final p in needs) {
      if (!await PermissionsService.ensurePermission(context, p)) return false;
    }
    return true;
  }

  Future<void> _pickFile() async {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final messenger = ScaffoldMessenger.of(context);

    if (!await _ensurePickerPermissions()) {
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.pharmacyPermissionsRequired),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
      return;
    }

    try {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['pdf', 'jpg', 'jpeg', 'png'],
      );
      if (result?.files.single.path != null) {
        setState(() {
          _file = File(result!.files.single.path!);
          _fileName = result.files.single.name;
        });
      }
    } catch (_) {
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.pharmacyFilePickerError),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    }
  }

  Future<void> _submit() async {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final messenger = ScaffoldMessenger.of(context);

    if (!_formKey.currentState!.validate() || _file == null) {
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.pharmacyFormAndFileRequired),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
      return;
    }

    setState(() => _isSubmitting = true);
    String? fileKey;

    try {
      final uploadHeaders = await ApiConfig.authenticatedAuthHeaders();
      final req = http.MultipartRequest(
        'POST',
        Uri.parse('${ApiConfig.baseUrl}/upload'),
      )
        ..headers.addAll(uploadHeaders)
        ..files.add(await http.MultipartFile.fromPath('file', _file!.path, filename: _fileName));

      final res = await http.Response.fromStream(await req.send());
      if (res.statusCode == 200) {
        final decoded = jsonDecode(res.body);
        fileKey = decoded['data']?['storageKey'] ?? decoded['storageKey'];
        if (fileKey == null) throw Exception('key missing');
      } else {
        throw Exception('upload failed');
      }
    } catch (_) {
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.pharmacyUploadFailed),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
      setState(() => _isSubmitting = false);
      return;
    }

    try {
      final apiRes = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/pharmacy-orders/orders'),
        headers: await ApiConfig.authenticatedHeaders(),
        body: jsonEncode({
          'phone': _phoneController.text.trim(),
          'order_note': _addressController.text.trim(),
          'file_key': fileKey,
        }),
      );

      if (apiRes.statusCode == 200) {
        messenger.showSnackBar(SnackBar(
          content: Text(l10n.pharmacyConfirmationNote),
          backgroundColor: theme.colorScheme.primary,
          behavior: SnackBarBehavior.floating,
        ));
        _fetchOrders(); // Refresh orders
        _tabController.animateTo(1); // Switch to history tab
        setState(() {
          _file = null;
          _fileName = null;
          _addressController.clear();
        });
      } else {
        final msg = (jsonDecode(apiRes.body)['message'] ?? l10n.pharmacySubmissionFailed).toString();
        messenger.showSnackBar(SnackBar(
          content: Text(msg),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ));
      }
    } catch (_) {
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.networkError),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  Future<void> _callPharmacy() async {
    final uri = Uri.parse('tel:$_pharmacyPhoneNumber');
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);

    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(l10n.pharmacyCallFailed),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    }
  }

  Future<void> _triggerSOS() async {
    final l10n = AppLocalizations.of(context)!;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(l10n.authSosTriggered),
      backgroundColor: Theme.of(context).colorScheme.error,
      behavior: SnackBarBehavior.floating,
    ));
    await SOSService.triggerSOS();
  }

  // ── Status helpers ─────────────────────────────────────────────
  Color _statusColor(String? status) {
    switch (status?.toLowerCase()) {
      case 'pending': return Colors.orange;
      case 'processing': return Colors.blue;
      case 'ready': return Colors.teal;
      case 'completed': return Colors.green;
      case 'cancelled': return Colors.red;
      default: return Colors.grey;
    }
  }

  IconData _statusIcon(String? status) {
    switch (status?.toLowerCase()) {
      case 'pending': return Icons.hourglass_empty;
      case 'processing': return Icons.sync;
      case 'ready': return Icons.check_circle_outline;
      case 'completed': return Icons.done_all;
      case 'cancelled': return Icons.cancel_outlined;
      default: return Icons.help_outline;
    }
  }

  bool _canRefill(String? status) {
    final s = status?.toLowerCase() ?? '';
    return s == 'completed' || s == 'ready';
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final isDarkMode = theme.brightness == Brightness.dark;

    return FeatureScreenScaffold(
      title: l10n.pharmacyTitle,
      icon: Icons.local_pharmacy_outlined,
      color: FeatureScreenScaffold.featureColors['pharmacy']!,
      heroTag: 'pharmacy',
      floatingActionButton: FloatingActionButton(
        onPressed: _triggerSOS,
        tooltip: l10n.authSosTooltip,
        backgroundColor: Colors.red,
        child: const Icon(Icons.favorite_border_outlined),
      ),
      child: Column(
        children: [
          TabBar(
            controller: _tabController,
            tabs: const [
              Tab(text: 'New Order', icon: Icon(Icons.add_shopping_cart)),
              Tab(text: 'My Orders', icon: Icon(Icons.history)),
            ],
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                // Tab 1: New Order (existing form)
                _buildNewOrderTab(l10n, theme, cs, isDarkMode),
                // Tab 2: Order History
                _buildOrderHistoryTab(theme, cs),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildNewOrderTab(AppLocalizations l10n, ThemeData theme, ColorScheme cs, bool isDarkMode) {
    return Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
            decoration: BoxDecoration(
              color: cs.primaryContainer.withAlpha(isDarkMode ? 102 : 178),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(
              l10n.pharmacyInfoBanner,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: cs.onPrimaryContainer,
                fontWeight: FontWeight.w500,
              ),
              textAlign: TextAlign.center,
            ),
          ),
          const SizedBox(height: 20),

          if (_isGuest) ...[
            TextFormField(
              controller: _phoneController,
              keyboardType: TextInputType.phone,
              decoration: InputDecoration(
                labelText: l10n.pharmacyPhoneNumberLabel,
                hintText: l10n.pharmacyPhoneNumberHint,
                prefixIcon: Icon(Icons.phone_outlined, color: cs.primary),
              ),
              validator: (v) =>
                  v == null || v.trim().length != 10
                      ? l10n.pharmacyPhoneNumberValidationInvalid
                      : null,
            ),
            const SizedBox(height: 16),
          ],

          ElevatedButton.icon(
            onPressed: _isSubmitting ? null : _pickFile,
            icon: const Icon(Icons.upload_file_outlined),
            label: Text(
              _file == null
                  ? l10n.pharmacyUploadPrescriptionButton
                  : '${l10n.fileSelected}: $_fileName',
              overflow: TextOverflow.ellipsis,
            ),
            style: ElevatedButton.styleFrom(
              backgroundColor: cs.secondaryContainer,
              foregroundColor: cs.onSecondaryContainer,
            ),
          ),
          if (_fileName != null)
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                icon: Icon(Icons.close, size: 16, color: cs.error),
                label: Text(
                  l10n.fileClearSelection,
                  style: theme.textTheme.bodySmall?.copyWith(color: cs.error),
                ),
                onPressed: _isSubmitting
                    ? null
                    : () => setState(() {
                          _file = null;
                          _fileName = null;
                        }),
              ),
            ),
          const SizedBox(height: 16),

          TextFormField(
            controller: _addressController,
            minLines: 3,
            maxLines: 5,
            decoration: InputDecoration(
              labelText: l10n.pharmacyDeliveryAddressLabel,
              hintText: l10n.pharmacyDeliveryAddressHint,
              prefixIcon: Padding(
                padding: const EdgeInsets.only(bottom: 40),
                child: Icon(Icons.home_outlined, color: cs.primary),
              ),
              alignLabelWithHint: true,
            ),
            validator: (v) => v == null || v.trim().isEmpty
                ? l10n.pharmacyDeliveryAddressValidationRequired
                : null,
          ),
          const SizedBox(height: 24),

          ElevatedButton(
            onPressed: _isSubmitting ? null : _submit,
            child: _isSubmitting
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(strokeWidth: 2.5),
                  )
                : Text(l10n.pharmacySubmitOrderButton),
          ),
          const SizedBox(height: 16),

          Center(
            child: TextButton.icon(
              icon: Icon(Icons.call_outlined, color: cs.primary),
              label: Text(
                l10n.pharmacyCallButton,
                style: theme.textTheme.labelLarge?.copyWith(color: cs.primary),
              ),
              onPressed: _isSubmitting ? null : _callPharmacy,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildOrderHistoryTab(ThemeData theme, ColorScheme cs) {
    if (_isLoadingOrders) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_orders.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.inventory_2_outlined, size: 64, color: cs.onSurface.withValues(alpha: 0.3)),
            const SizedBox(height: 16),
            Text(
              'No orders yet',
              style: theme.textTheme.titleMedium?.copyWith(
                color: cs.onSurface.withValues(alpha: 0.5),
              ),
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => _tabController.animateTo(0),
              child: const Text('Place your first order'),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchOrders,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _orders.length,
        itemBuilder: (_, i) {
          final order = _orders[i] as Map<String, dynamic>;
          final status = order['status']?.toString() ?? 'pending';
          final note = order['order_note']?.toString() ?? '';
          final createdAt = order['created_at']?.toString();
          final color = _statusColor(status);

          String dateStr = '';
          if (createdAt != null) {
            try {
              final dt = DateTime.parse(createdAt).toLocal();
              dateStr = DateFormat('dd MMM yyyy, h:mm a').format(dt);
            } catch (_) {
              dateStr = createdAt;
            }
          }

          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: ListTile(
              leading: CircleAvatar(
                backgroundColor: color.withValues(alpha: 0.15),
                child: Icon(_statusIcon(status), color: color, size: 20),
              ),
              title: Text(
                note.length > 60 ? '${note.substring(0, 60)}...' : note,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (dateStr.isNotEmpty)
                    Text(dateStr, style: theme.textTheme.bodySmall),
                  const SizedBox(height: 4),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      status.toUpperCase(),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: color,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ],
              ),
              trailing: _canRefill(status)
                  ? IconButton(
                      icon: const Icon(Icons.replay),
                      tooltip: 'Request Refill',
                      onPressed: _isSubmitting ? null : () => _requestRefill(order),
                    )
                  : null,
              isThreeLine: true,
            ),
          );
        },
      ),
    );
  }
}
