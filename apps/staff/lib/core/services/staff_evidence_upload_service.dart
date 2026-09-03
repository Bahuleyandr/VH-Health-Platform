import 'dart:io';

import 'api_client.dart';

class StaffEvidenceUpload {
  final String storageKey;
  final String? storageUrl;
  final String? fileName;
  final String? fileType;
  final int? fileSize;

  const StaffEvidenceUpload({
    required this.storageKey,
    this.storageUrl,
    this.fileName,
    this.fileType,
    this.fileSize,
  });

  factory StaffEvidenceUpload.fromJson(Map<String, dynamic> json) {
    final key = json['storageKey'] ?? json['storage_key'];
    if (key == null || key.toString().trim().isEmpty) {
      throw const FormatException('Upload response did not include storageKey');
    }
    final size = json['file_size'] ?? json['fileSize'];
    return StaffEvidenceUpload(
      storageKey: key.toString(),
      storageUrl: (json['storage_url'] ?? json['storageUrl'])?.toString(),
      fileName: (json['file_name'] ?? json['fileName'])?.toString(),
      fileType: (json['file_type'] ?? json['fileType'])?.toString(),
      fileSize: size is int ? size : int.tryParse(size?.toString() ?? ''),
    );
  }
}

class StaffEvidenceUploadService {
  StaffEvidenceUploadService._();

  static Future<StaffEvidenceUpload> upload(
    File file, {
    required String failureMessage,
  }) async {
    final response = await ApiClient.multipart(
      '/upload',
      fileBuilder: () async => [
        await ApiClient.multipartFileFromPath(
          'file',
          file.path,
          filename: _filenameFromPath(file.path),
        ),
      ],
      timeout: const Duration(seconds: 45),
    );

    if (!response.isSuccess) {
      throw Exception(response.failureMessage(failureMessage));
    }

    final payload = _extractPayload(response);
    try {
      return StaffEvidenceUpload.fromJson(payload);
    } on FormatException catch (e) {
      throw Exception(e.message);
    }
  }

  static Map<String, dynamic> _extractPayload(ApiResponse response) {
    if (response.data is Map) {
      return Map<String, dynamic>.from(response.data as Map);
    }
    if (response.raw is Map) {
      final raw = Map<String, dynamic>.from(response.raw as Map);
      final data = raw['data'];
      if (data is Map) return Map<String, dynamic>.from(data);
      return raw;
    }
    throw Exception('Photo upload response was not understood');
  }

  static String _filenameFromPath(String path) {
    final normalized = path.replaceAll('\\', '/');
    final name = normalized.split('/').last.trim();
    return name.isEmpty ? 'evidence.jpg' : name;
  }
}
