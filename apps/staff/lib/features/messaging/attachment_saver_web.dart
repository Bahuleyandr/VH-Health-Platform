import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

/// Web variant: hand the bytes to the browser as a Blob download. The
/// browser decides where the file lands, so there is no local path to
/// report — return null and let the caller show a "download started" note.
Future<String?> saveAndOpenAttachment({
  required String fileName,
  required String contentType,
  required List<int> bytes,
}) async {
  final blob = web.Blob(
    [Uint8List.fromList(bytes).toJS].toJS,
    web.BlobPropertyBag(
      type: contentType.isEmpty ? 'application/octet-stream' : contentType,
    ),
  );
  final url = web.URL.createObjectURL(blob);
  try {
    final anchor = web.HTMLAnchorElement()
      ..href = url
      ..download = fileName.trim().isEmpty ? 'attachment' : fileName.trim();
    web.document.body?.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    web.URL.revokeObjectURL(url);
  }
  return null;
}
