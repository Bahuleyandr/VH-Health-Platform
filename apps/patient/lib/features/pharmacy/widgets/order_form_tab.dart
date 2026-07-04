import 'dart:io';

import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';

import 'package:vhhealth/core/offline/patient_cache_invalidation.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/input_sanitizer.dart';
import 'package:vhhealth/features/pharmacy/widgets/order_status_widgets.dart';

class OrderFormTab extends StatefulWidget {
  final String phone;
  final VoidCallback onOrderPlaced;

  const OrderFormTab({
    super.key,
    required this.phone,
    required this.onOrderPlaced,
  });

  @override
  State<OrderFormTab> createState() => _OrderFormTabState();
}

class _OrderFormTabState extends State<OrderFormTab> {
  final _noteController = TextEditingController();
  final _addressController = TextEditingController();
  final _landmarkController = TextEditingController();
  final _phoneController = TextEditingController();

  File? _prescriptionPhoto;
  String? _prescriptionName;
  String? _prescriptionError;
  bool _isSubmitting = false;
  String _deliveryType = 'delivery'; // 'delivery' | 'pickup'

  @override
  void initState() {
    super.initState();
    _phoneController.text = widget.phone;
    _noteController.addListener(_clearPrescriptionErrorIfSatisfied);
  }

  @override
  void dispose() {
    _noteController.removeListener(_clearPrescriptionErrorIfSatisfied);
    _noteController.dispose();
    _addressController.dispose();
    _landmarkController.dispose();
    _phoneController.dispose();
    super.dispose();
  }

  void _clearPrescriptionErrorIfSatisfied() {
    if (_prescriptionError == null) return;
    if (_prescriptionPhoto == null && _noteController.text.trim().isEmpty) {
      return;
    }
    if (!mounted) return;
    setState(() => _prescriptionError = null);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PICK PRESCRIPTION PHOTO
  // ═══════════════════════════════════════════════════════════════════════════

  Future<void> _pickPrescription(ImageSource source) async {
    final l = AppLocalizations.of(context)!;
    final picker = ImagePicker();
    final picked = await picker.pickImage(
      source: source,
      maxWidth: 1920,
      maxHeight: 1920,
      imageQuality: 85,
    );
    if (picked != null && mounted) {
      final file = File(picked.path);
      final sizeBytes = await file.length();
      const maxSizeBytes = 10 * 1024 * 1024; // 10 MB
      if (sizeBytes > maxSizeBytes) {
        if (mounted) {
          setState(() => _prescriptionError = l.pharmacyFileTooLarge);
        }
        return;
      }
      setState(() {
        _prescriptionPhoto = file;
        _prescriptionName = picked.name;
        _prescriptionError = null;
      });
    }
  }

  void _showImageSourcePicker() {
    final l = AppLocalizations.of(context)!;
    showModalBottomSheet(
      context: context,
      builder: (ctx) {
        final colors = Theme.of(ctx).colorScheme;
        return SafeArea(
          child: Wrap(
            children: [
              ListTile(
                leading: Icon(Icons.camera_alt, color: colors.secondary),
                title: Text(l.pharmacyTakePhoto),
                onTap: () {
                  Navigator.pop(ctx);
                  _pickPrescription(ImageSource.camera);
                },
              ),
              ListTile(
                leading: Icon(Icons.photo_library, color: colors.secondary),
                title: Text(l.pharmacyChooseFromGallery),
                onTap: () {
                  Navigator.pop(ctx);
                  _pickPrescription(ImageSource.gallery);
                },
              ),
            ],
          ),
        );
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLACE ORDER
  // ═══════════════════════════════════════════════════════════════════════════

  Future<void> _placeOrder() async {
    if (_isSubmitting) return;

    final l = AppLocalizations.of(context)!;
    if (_prescriptionPhoto == null && _noteController.text.trim().isEmpty) {
      setState(() {
        _prescriptionError = l.pharmacyPrescriptionOrDescriptionRequired;
      });
      return;
    }

    setState(() {
      _isSubmitting = true;
      _prescriptionError = null;
    });

    try {
      // Build multipart files list
      final List<http.MultipartFile> files = [];
      if (_prescriptionPhoto != null) {
        files.add(
          await http.MultipartFile.fromPath(
            'prescription',
            _prescriptionPhoto!.path,
            filename: _prescriptionName ?? 'prescription.jpg',
          ),
        );
      }

      // Build form fields
      final Map<String, String> fields = {'delivery_type': _deliveryType};
      if (_noteController.text.trim().isNotEmpty) {
        fields['order_note'] = InputSanitizer.sanitize(
          _noteController.text.trim(),
        );
      }
      if (_deliveryType == 'delivery') {
        if (_addressController.text.trim().isNotEmpty) {
          fields['delivery_address'] = InputSanitizer.sanitize(
            _addressController.text.trim(),
          );
        }
        if (_landmarkController.text.trim().isNotEmpty) {
          fields['delivery_landmark'] = InputSanitizer.sanitize(
            _landmarkController.text.trim(),
          );
        }
        if (_phoneController.text.trim().isNotEmpty) {
          fields['delivery_phone'] = InputSanitizer.sanitizePhone(
            _phoneController.text.trim(),
          );
        }
      }

      final response = await ApiClient.multipart(
        '/pharmacy-orders/orders/place',
        fields: fields,
        files: files,
      );

      if (!mounted) return;

      if (response.isSuccess) {
        await PatientCacheInvalidation.afterPharmacyOrderMutation();
        if (!mounted) return;
        final orderNumber = response.data?['order_number'] ?? '';

        _showSnack(l.pharmacyOrderPlacedToast(orderNumber.toString()));

        // Reset form
        setState(() {
          _prescriptionPhoto = null;
          _prescriptionName = null;
          _prescriptionError = null;
          _noteController.clear();
          _addressController.clear();
          _landmarkController.clear();
          _deliveryType = 'delivery';
        });

        // Show success dialog
        _showOrderPlacedDialog(orderNumber);

        // Notify parent to switch tabs and refresh orders
        widget.onOrderPlaced();
      } else {
        _showSnack(
          response.failureMessage(l.pharmacyPlaceOrderFailed),
          isError: true,
        );
      }
    } catch (e) {
      if (mounted) {
        _showSnack(l.pharmacyPlaceOrderFailed, isError: true);
      }
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  void _showOrderPlacedDialog(String orderNumber) {
    final l = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Row(
          children: [
            Icon(
              Icons.check_circle,
              color: theme.colorScheme.tertiary,
              size: 28,
            ),
            const SizedBox(width: 8),
            Text(l.pharmacyOrderPlacedTitle),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (orderNumber.isNotEmpty)
              Text(
                l.pharmacyOrderNumber(orderNumber),
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 16,
                ),
              ),
            const SizedBox(height: 12),
            Text(
              l.pharmacyOrderPlacedBody,
              style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(l.commonOkButton),
          ),
        ],
      ),
    );
  }

  void _showSnack(String msg, {bool isError = false}) {
    if (!mounted) return;
    final colors = Theme.of(context).colorScheme;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: isError ? colors.error : colors.tertiary,
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD
  // ═══════════════════════════════════════════════════════════════════════════

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final hasPrescriptionError = _prescriptionError != null;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Prescription upload
          Text(
            l.pharmacyUploadHeading,
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),

          GestureDetector(
            onTap: _showImageSourcePicker,
            child: Container(
              width: double.infinity,
              height: _prescriptionPhoto != null ? 200 : 120,
              decoration: BoxDecoration(
                color: colors.surfaceContainerHighest.withValues(alpha: 0.45),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: hasPrescriptionError
                      ? colors.error
                      : colors.secondary.withValues(alpha: 0.35),
                  width: 2,
                  style: BorderStyle.solid,
                ),
              ),
              child: _prescriptionPhoto != null
                  ? Stack(
                      children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.file(
                            _prescriptionPhoto!,
                            width: double.infinity,
                            height: 200,
                            fit: BoxFit.cover,
                          ),
                        ),
                        Positioned(
                          top: 8,
                          right: 8,
                          child: GestureDetector(
                            onTap: () => setState(() {
                              _prescriptionPhoto = null;
                              _prescriptionName = null;
                              _prescriptionError = null;
                            }),
                            child: Container(
                              padding: const EdgeInsets.all(4),
                              decoration: BoxDecoration(
                                color: colors.error,
                                shape: BoxShape.circle,
                              ),
                              child: Icon(
                                Icons.close,
                                color: colors.onError,
                                size: 16,
                              ),
                            ),
                          ),
                        ),
                      ],
                    )
                  : Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          Icons.camera_alt,
                          size: 36,
                          color: colors.secondary,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          l.pharmacyTapToUpload,
                          style: TextStyle(color: colors.onSurfaceVariant),
                        ),
                        Text(
                          l.pharmacyCameraOrGallery,
                          style: TextStyle(
                            color: colors.onSurfaceVariant,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
            ),
          ),
          if (hasPrescriptionError) ...[
            const SizedBox(height: 8),
            Text(
              _prescriptionError!,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
          ],

          const SizedBox(height: 16),

          // OR describe order
          Text(
            l.pharmacyOrDescribe,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _noteController,
            maxLines: 3,
            decoration: InputDecoration(
              hintText: l.pharmacyOrderNoteHint,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 14,
                vertical: 12,
              ),
            ),
          ),

          const SizedBox(height: 20),

          // Delivery preference
          Text(
            l.pharmacyDeliveryPreference,
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: PharmacyDeliveryOption(
                  icon: Icons.delivery_dining,
                  label: l.pharmacyHomeDelivery,
                  selected: _deliveryType == 'delivery',
                  onTap: () => setState(() => _deliveryType = 'delivery'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: PharmacyDeliveryOption(
                  icon: Icons.store,
                  label: l.pharmacyPickup,
                  selected: _deliveryType == 'pickup',
                  onTap: () => setState(() => _deliveryType = 'pickup'),
                ),
              ),
            ],
          ),

          // Delivery address fields
          if (_deliveryType == 'delivery') ...[
            const SizedBox(height: 16),
            TextField(
              controller: _addressController,
              maxLines: 2,
              decoration: InputDecoration(
                labelText: l.pharmacyDeliveryAddressLabel,
                hintText: l.pharmacyDeliveryAddressHint,
                prefixIcon: const Icon(Icons.location_on),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _landmarkController,
              decoration: InputDecoration(
                labelText: l.pharmacyLandmarkOptional,
                hintText: l.pharmacyLandmarkHint,
                prefixIcon: const Icon(Icons.place),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _phoneController,
              keyboardType: TextInputType.phone,
              decoration: InputDecoration(
                labelText: l.pharmacyPhoneNumberLabel,
                prefixIcon: const Icon(Icons.phone),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
            ),
          ],

          const SizedBox(height: 24),

          // Place Order button
          SizedBox(
            width: double.infinity,
            height: 50,
            child: ElevatedButton.icon(
              onPressed: _isSubmitting ? null : _placeOrder,
              icon: _isSubmitting
                  ? SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        color: colors.onSecondary,
                        strokeWidth: 2,
                      ),
                    )
                  : Icon(
                      Icons.shopping_cart_checkout,
                      color: colors.onSecondary,
                    ),
              label: Text(
                _isSubmitting
                    ? l.pharmacyPlacingOrderButton
                    : l.pharmacyPlaceOrderButton,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                ),
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: colors.secondary,
                foregroundColor: colors.onSecondary,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
            ),
          ),

          const SizedBox(height: 32),
        ],
      ),
    );
  }
}
