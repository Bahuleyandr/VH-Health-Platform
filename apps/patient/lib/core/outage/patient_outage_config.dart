import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth_core/config/tenant_config.dart';

const patientOutageFacilityContactToken = '[facility contact number]';

@immutable
class PatientOutageCommunication {
  const PatientOutageCommunication({
    required this.revision,
    required this.messages,
    required this.facilityContactNumber,
  });

  static const supportedLocales = <String>{'en', 'hi', 'ta', 'te', 'ml'};
  static const _maxPayloadBytes = 16 * 1024;
  static const _maxSafeRevision = 9007199254740991;
  static const _allowedKeys = <String>{
    'revision',
    'messages',
    'facility_contact_number',
  };
  static final _contactPattern = RegExp(r'^\+?[0-9][0-9 ()-]{2,63}$');

  final int revision;
  final Map<String, String> messages;
  final String facilityContactNumber;

  static PatientOutageCommunication? tryParse(Object? value) {
    if (value is! Map) return null;
    final raw = Map<String, dynamic>.from(value);
    if (utf8.encode(jsonEncode(raw)).length > _maxPayloadBytes) return null;
    if (!setEquals(raw.keys.toSet(), _allowedKeys)) return null;

    final revision = raw['revision'];
    final contact = raw['facility_contact_number'];
    final messagesRaw = raw['messages'];
    if (revision is! int || revision <= 0 || revision > _maxSafeRevision) {
      return null;
    }
    if (contact is! String ||
        contact.trim() != contact ||
        !_contactPattern.hasMatch(contact)) {
      return null;
    }
    if (messagesRaw is! Map) return null;
    final messageMap = Map<String, dynamic>.from(messagesRaw);
    if (!setEquals(messageMap.keys.toSet(), supportedLocales)) return null;

    final messages = <String, String>{};
    for (final locale in supportedLocales) {
      final message = messageMap[locale];
      if (message is! String ||
          message.isEmpty ||
          message.length > 2000 ||
          message.trim() != message ||
          patientOutageFacilityContactToken.allMatches(message).length != 1) {
        return null;
      }
      messages[locale] = message;
    }

    return PatientOutageCommunication(
      revision: revision,
      messages: Map.unmodifiable(messages),
      facilityContactNumber: contact,
    );
  }

  String? localizedMessage(String languageCode) => messages[languageCode];

  Map<String, dynamic> toJson() => {
    'revision': revision,
    'messages': messages,
    'facility_contact_number': facilityContactNumber,
  };
}

class PatientOutageConfigStore extends ChangeNotifier {
  PatientOutageConfigStore._();

  static final PatientOutageConfigStore instance = PatientOutageConfigStore._();
  static const _snapshotKeys = <String>{'source', 'communication'};

  PatientOutageCommunication? _current;
  bool _loaded = false;

  PatientOutageCommunication? get current => _current;
  bool get isLoaded => _loaded;

  String get _storageKey =>
      'vh.c_d12.operational_copy.v1.${TenantConfig.cacheNamespace}';

  Future<void> load() async {
    if (_loaded) return;
    final preferences = await SharedPreferences.getInstance();
    final encoded = preferences.getString(_storageKey);
    PatientOutageCommunication? loaded;
    if (encoded != null) {
      try {
        final decoded = jsonDecode(encoded);
        if (decoded is Map) {
          final envelope = Map<String, dynamic>.from(decoded);
          if (setEquals(envelope.keys.toSet(), _snapshotKeys) &&
              envelope['source'] == ApiConfig.baseUrl) {
            loaded = PatientOutageCommunication.tryParse(
              envelope['communication'],
            );
          }
        }
      } catch (_) {
        loaded = null;
      }
    }
    _current = loaded;
    _loaded = true;
    notifyListeners();
  }

  Future<bool> accept(Object? value) async {
    await load();
    final candidate = PatientOutageCommunication.tryParse(value);
    if (candidate == null ||
        (_current != null && candidate.revision <= _current!.revision)) {
      return false;
    }

    final encoded = jsonEncode({
      'source': ApiConfig.baseUrl,
      'communication': candidate.toJson(),
    });
    final preferences = await SharedPreferences.getInstance();
    final stored = await preferences.setString(_storageKey, encoded);
    if (!stored) return false;

    _current = candidate;
    notifyListeners();
    return true;
  }

  @visibleForTesting
  Future<void> resetForTesting() async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.remove(_storageKey);
    _current = null;
    _loaded = false;
  }

  @visibleForTesting
  void resetMemoryForTesting() {
    _current = null;
    _loaded = false;
  }
}
