// lib/core/utils/safe_filename.dart

/// Reduce an untrusted file name to a single, safe path segment that cannot
/// escape the directory it will be joined onto.
///
/// Server-supplied file names and storage keys (e.g. `file_key`, `storageKey`,
/// a Content-Disposition name) are attacker-influenceable. Joining them
/// straight onto the cache/temp directory — `File('$dir/$name')` — allows path
/// traversal (`../`, absolute paths, `\` segments), so raw PHI bytes could be
/// written OUTSIDE the app sandbox or overwrite app files, and a crafted name
/// could redirect a later cache read.
///
/// This guarantees the result:
///   * contains NO path separator (`/` or `\`) — always a direct child of the
///     target directory, so `../` can never traverse;
///   * is never `.`, `..`, or empty (the residual traversal / no-op cases);
///   * keeps only filesystem-safe characters; and
///   * is length-bounded, preserving a short trailing extension so the OS
///     viewer still recognises the file type.
///
/// Separators are REPLACED (not stripped to a basename) so that two distinct
/// keys sharing a basename — e.g. `2026/06/report.pdf` vs `2026/05/report.pdf`
/// — stay distinct and don't collide in the cache.
String safeFileName(String? raw, {String fallback = 'file'}) {
  var name = (raw ?? '').trim();
  if (name.isEmpty) return fallback;

  // Neutralise BOTH path separators so the result is a single segment.
  name = name.replaceAll(RegExp(r'[\\/]+'), '_');

  // Drop null bytes + control characters (0x00–0x1F, 0x7F).
  name = name.replaceAll(RegExp(r'[\x00-\x1f\x7f]'), '');

  // Collapse any remaining filesystem/shell-hostile characters.
  name = name.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');

  // Strip leading dots: turns the residual traversal/no-op cases (`.`, `..`,
  // and hidden-file names) into a plain name. With separators already gone,
  // this is the only way `..` could still name the parent directory.
  name = name.replaceAll(RegExp(r'^\.+'), '');

  // Bound the length, keeping a short trailing extension when present.
  const maxLen = 150;
  if (name.length > maxLen) {
    final dot = name.lastIndexOf('.');
    name = (dot > 0 && name.length - dot <= 12)
        ? name.substring(0, maxLen - (name.length - dot)) + name.substring(dot)
        : name.substring(0, maxLen);
  }

  return name.isEmpty ? fallback : name;
}
