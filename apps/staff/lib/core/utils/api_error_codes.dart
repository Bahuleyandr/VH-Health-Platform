import 'package:vhhealth_core/models/api_response.dart';

const clinicalWriteDesktopOnlyCode = 'CLINICAL_WRITE_DESKTOP_ONLY';
const deviceTypeMissingCode = 'DEVICE_TYPE_MISSING';

String? apiErrorCodeFromRaw(dynamic raw) {
  if (raw is ApiResponse) return raw.code;
  if (raw is Map) {
    final code = raw['code'] ?? raw['error_code'];
    final text = code?.toString().trim();
    return text == null || text.isEmpty ? null : text;
  }
  final text = raw?.toString() ?? '';
  if (text.contains(clinicalWriteDesktopOnlyCode)) {
    return clinicalWriteDesktopOnlyCode;
  }
  if (text.contains(deviceTypeMissingCode)) return deviceTypeMissingCode;
  return null;
}

bool isDeviceTypeWriteGateCode(String? code) {
  return code == clinicalWriteDesktopOnlyCode || code == deviceTypeMissingCode;
}
