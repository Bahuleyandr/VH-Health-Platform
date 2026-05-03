import 'dart:io';

import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';

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
  bool _isSubmitting = false;
  String _deliveryType = 'delivery'; // 'delivery' | 'pickup'

  @override
  void initState() {
    super.initState();
    _phoneController.text = widget.phone;
  }

  @override
  void dispose() {
    _noteController.dispose();
    _addressController.dispose();
    _landmarkController.dispose();
    _phoneController.dispose();
    super.dispose();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PICK PRESCRIPTION PHOTO
  // ═══════════════════════════════════════════════════════════════════════════

  Future<void> _pickPrescription(ImageSource source) async {
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
          _showSnack('File too large. Maximum size is 10 MB.', isError: true);
        }
        return;
      }
      setState(() {
        _prescriptionPhoto = file;
        _prescriptionName = picked.name;
      });
    }
  }

  void _showImageSourcePicker() {
    final l = AppLocalizations.of(context)!;
    showModalBottomSheet(
      context: context,
      builder: (ctx) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.camera_alt, color: Color(0xFF7E57C2)),
              title: Text(l.pharmacyTakePhoto),
              onTap: () {
                Navigator.pop(ctx);
                _pickPrescription(ImageSource.camera);
              },
            ),
            ListTile(
              leading: const Icon(
                Icons.photo_library,
                color: Color(0xFF7E57C2),
              ),
              title: Text(l.pharmacyChooseFromGallery),
              onTap: () {
                Navigator.pop(ctx);
                _pickPrescription(ImageSource.gallery);
              },
            ),
          ],
        ),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLACE ORDER
  // ═══════════════════════════════════════════════════════════════════════════

  Future<void> _placeOrder() async {
    if (_prescriptionPhoto == null && _noteController.text.trim().isEmpty) {
      _showSnack(
        'Please upload a prescription or describe your order',
        isError: true,
      );
      return;
    }

    setState(() => _isSubmitting = true);

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
        final orderNumber = response.data?['order_number'] ?? '';

        _showSnack('Order placed! $orderNumber');

        // Reset form
        setState(() {
          _prescriptionPhoto = null;
          _prescriptionName = null;
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
        _showSnack(response.message ?? 'Failed to place order', isError: true);
      }
    } catch (e) {
      if (mounted) {
        _showSnack(
          'Error: ${e.toString().replaceFirst("Exception: ", "")}',
          isError: true,
        );
      }
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  void _showOrderPlacedDialog(String orderNumber) {
    final l = AppLocalizations.of(context)!;
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Row(
          children: [
            const Icon(Icons.check_circle, color: Colors.green, size: 28),
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
                'Order Number: $orderNumber',
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 16,
                ),
              ),
            const SizedBox(height: 12),
            Text(
              l.pharmacyOrderPlacedBody,
              style: const TextStyle(color: Colors.grey),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  void _showSnack(String msg, {bool isError = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: isError ? Colors.red.shade700 : Colors.green.shade700,
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD
  // ═══════════════════════════════════════════════════════════════════════════

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
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
                color: Colors.grey.shade100,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: const Color(0xFF7E57C2).withValues(alpha: 0.3),
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
                            }),
                            child: Container(
                              padding: const EdgeInsets.all(4),
                              decoration: const BoxDecoration(
                                color: Colors.red,
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(
                                Icons.close,
                                color: Colors.white,
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
                        const Icon(
                          Icons.camera_alt,
                          size: 36,
                          color: Color(0xFF7E57C2),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          l.pharmacyTapToUpload,
                          style: const TextStyle(color: Colors.grey),
                        ),
                        Text(
                          l.pharmacyCameraOrGallery,
                          style: const TextStyle(
                            color: Colors.grey,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
            ),
          ),

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
              hintText: 'e.g., Dolo 650 - 2 strips, Pan 40 - 1 strip...',
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
                  label: 'Home Delivery',
                  selected: _deliveryType == 'delivery',
                  onTap: () => setState(() => _deliveryType = 'delivery'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: PharmacyDeliveryOption(
                  icon: Icons.store,
                  label: 'Pickup',
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
                labelText: 'Delivery Address',
                hintText: 'House/Flat, Street, Area...',
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
                labelText: 'Landmark (optional)',
                hintText: 'Near...',
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
                labelText: 'Contact Phone',
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
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        color: Colors.white,
                        strokeWidth: 2,
                      ),
                    )
                  : const Icon(
                      Icons.shopping_cart_checkout,
                      color: Colors.white,
                    ),
              label: Text(
                _isSubmitting ? 'Placing Order...' : 'Place Order',
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                ),
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF7E57C2),
                foregroundColor: Colors.white,
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
