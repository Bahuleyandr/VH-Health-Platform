import 'dart:convert';

import 'auth_service.dart';
import 'secure_blob.dart';
import 'secure_storage.dart';

/// Encrypted-at-rest cache of a patient's due MAR doses, so the bedside flow can
/// run the 5-rights check offline (see mar_five_rights.dart). Keyed by the
/// current staff id + patient so a shared ward device never serves one nurse
/// another's cached snapshot. Read-only snapshot: the server stays authoritative;
/// on drain the queued administer is re-verified server-side.
class MarOfflineCache {
  static final SecureBlobCodec _codec = SecureBlobCodec(
    'mar_offline_cache_aes_key',
  );

  static Future<String> _key(String patientUid) async {
    final staffId = await AuthService.getStaffId();
    return 'mar_cache:${staffId ?? "anon"}:$patientUid';
  }

  /// Persist the patient's due-dose rows (from GET /clinical/mar/due or
  /// /clinical/mar/patient/{uid}). Overwrites the prior snapshot.
  static Future<void> cacheDueDoses(
    String patientUid,
    List<Map<String, dynamic>> doses,
  ) async {
    final envelope = {
      'cached_at': DateTime.now().toUtc().toIso8601String(),
      'doses': doses,
    };
    final blob = await _codec.seal(jsonEncode(envelope));
    await VHSecureStorage.instance.write(
      key: await _key(patientUid),
      value: blob,
    );
  }

  static Future<Map<String, dynamic>?> _readEnvelope(String patientUid) async {
    final blob = await VHSecureStorage.instance.read(
      key: await _key(patientUid),
    );
    if (blob == null) return null;
    try {
      return jsonDecode(await _codec.open(blob)) as Map<String, dynamic>;
    } catch (_) {
      return null; // corrupt/key-rotated → treat as no cache
    }
  }

  static Future<List<Map<String, dynamic>>> getCachedDoses(
    String patientUid,
  ) async {
    final env = await _readEnvelope(patientUid);
    if (env == null) return const [];
    return (env['doses'] as List).cast<Map<String, dynamic>>();
  }

  static Future<Map<String, dynamic>?> getCachedDose(
    String patientUid,
    int maId,
  ) async {
    for (final d in await getCachedDoses(patientUid)) {
      if (d['id'] == maId) return d;
    }
    return null;
  }

  static Future<DateTime?> cachedAt(String patientUid) async {
    final env = await _readEnvelope(patientUid);
    final s = env?['cached_at'] as String?;
    return s == null ? null : DateTime.tryParse(s);
  }
}
