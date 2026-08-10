import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:url_launcher/url_launcher.dart';

/// Sanitise a server-provided file name for the local filesystem.
String safeLocalAttachmentFileName(String value) {
  final trimmed = value.trim().isEmpty ? 'attachment' : value.trim();
  final safe = trimmed
      .replaceAll(RegExp(r'[<>:"/\\|?*\x00-\x1F]'), '_')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  return safe.isEmpty ? 'attachment' : safe;
}

/// Save the downloaded attachment bytes under the downloads directory and
/// open the file with the platform handler. Returns the saved path so the
/// caller can show it.
Future<String?> saveAndOpenAttachment({
  required String fileName,
  required String contentType,
  required List<int> bytes,
}) async {
  final baseDir =
      await getDownloadsDirectory() ?? await getTemporaryDirectory();
  final dir = Directory(
    p.join(baseDir.path, 'VH Health Staff', 'message-attachments'),
  );
  await dir.create(recursive: true);
  final baseName = safeLocalAttachmentFileName(fileName);
  var candidate = File(p.join(dir.path, baseName));
  if (await candidate.exists()) {
    final ext = p.extension(baseName);
    final stem = p.basenameWithoutExtension(baseName);
    var i = 1;
    while (await candidate.exists()) {
      candidate = File(p.join(dir.path, '$stem ($i)$ext'));
      i += 1;
    }
  }
  final saved = await candidate.writeAsBytes(bytes, flush: true);

  final uri = Uri.file(saved.path);
  if (await canLaunchUrl(uri)) {
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  } else if (Platform.isWindows) {
    await Process.start('explorer.exe', [saved.path]);
  }
  return saved.path;
}
