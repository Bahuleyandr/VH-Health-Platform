import 'dart:convert';
import 'dart:math';

/// Generates RFC-4122 v4 UUIDs for use as `Idempotency-Key` header values.
///
/// Kept dependency-free on purpose: the offline queue lives in `vhhealth_core`
/// and we don't want to pull the `uuid` package into the shared package's
/// dependency surface just to mint a stable key. A cryptographically strong
/// [Random.secure] source (falls back to a non-secure [Random] only if the
/// platform can't provide one) backs the 122 random bits.
///
/// The key is generated **once per logical write** — at offline-enqueue time,
/// or once before the in-process retry loop — and reused across every retry /
/// redrain so the backend `idempotency_keys` substrate de-duplicates replays
/// instead of creating duplicate orders / vitals / notes.
class IdempotencyKey {
  IdempotencyKey._();

  static final Random _rng = _initRng();

  static Random _initRng() {
    try {
      return Random.secure();
    } catch (_) {
      // Some constrained platforms lack a secure RNG; the key only needs to be
      // collision-resistant per (tenant,user,path), not cryptographically
      // unguessable, so a plain RNG is an acceptable fallback.
      return Random();
    }
  }

  /// Returns a fresh RFC-4122 version-4 UUID, e.g.
  /// `3f2504e0-4f89-41d3-9a0c-0305e82c3301`. The character set is a subset of
  /// the backend's allowed `[A-Za-z0-9_-:.]` idempotency-key pattern.
  static String generate() {
    final bytes = List<int>.generate(16, (_) => _rng.nextInt(256));
    // Set version (4) and variant (RFC 4122) bits.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-'
        '${hex.substring(20)}';
  }
}

/// Holds one `Idempotency-Key` for the life of a single logical write attempt.
///
/// The header only prevents duplicates if the SAME key is resent on a retry. A
/// freshly generated key per button press is worse than sending none at all: a
/// double-tap then mints two keys and the server runs the operation twice,
/// which is precisely what routes mounted with
/// `requireIdempotencyKey({ required: true })` exist to stop.
///
/// [keyFor] returns a stable key while the request payload is unchanged, so a
/// double-tap or a transport retry replays the first result. [reset] ends the
/// attempt so the *next* deliberate write is a genuinely separate one rather
/// than being swallowed as a replay.
///
/// ```dart
/// final _sendAttempt = IdempotencyAttempt('staff-message-send');
/// ...
/// await MessagingApiService.sendDirect(
///   ...,
///   idempotencyKey: _sendAttempt.keyFor(payload),
/// );
/// _sendAttempt.reset(); // only after the send succeeded
/// ```
class IdempotencyAttempt {
  IdempotencyAttempt(this.scope);

  /// Human-readable prefix, kept inside the backend's `[A-Za-z0-9_-:.]` set so
  /// the resulting key is legible in `idempotency_keys` during triage.
  final String scope;

  String? _identity;
  String? _key;

  static final RegExp _unsafe = RegExp(r'[^A-Za-z0-9_\-.]');

  /// The key for an attempt whose identity is [payload] (JSON-encoded).
  ///
  /// The payload must be the request body: the backend hashes the body and
  /// answers 422 when a key is replayed against different content, so a key
  /// bound to a stale payload would fail rather than replay.
  String keyFor(Object? payload) {
    final identity = jsonEncode(payload);
    if (_key == null || _identity != identity) {
      _identity = identity;
      final prefix = scope.replaceAll(_unsafe, '-');
      _key = '$prefix:${IdempotencyKey.generate()}';
    }
    return _key!;
  }

  /// Forget the current attempt. Call after the write has concluded.
  void reset() {
    _identity = null;
    _key = null;
  }

  /// The open attempt's key, or null when no attempt is open.
  String? get current => _key;
}
