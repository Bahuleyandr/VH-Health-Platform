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
