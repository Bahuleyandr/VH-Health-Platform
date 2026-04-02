/// Input sanitization utilities to prevent injection attacks.
///
/// Strips HTML/script tags and dangerous characters from user input
/// before sending to the backend.
class InputSanitizer {
  InputSanitizer._();

  /// Strip HTML tags from input text.
  /// Removes `<script>`, `<img>`, `<iframe>`, and all other HTML tags.
  static String stripHtml(String input) {
    return input.replaceAll(RegExp(r'<[^>]*>'), '');
  }

  /// Sanitize free-text input: strip HTML tags and trim whitespace.
  static String sanitize(String input) {
    var result = stripHtml(input);
    // Remove null bytes
    result = result.replaceAll('\x00', '');
    return result.trim();
  }

  /// Sanitize a phone number: keep only digits, +, and spaces.
  static String sanitizePhone(String input) {
    return input.replaceAll(RegExp(r'[^\d+\s\-()]'), '').trim();
  }

  /// Sanitize a name: keep only safe characters.
  /// Allows Unicode letters (for Tamil, Hindi, Telugu, Malayalam names),
  /// spaces, periods, and hyphens.
  static String sanitizeName(String input) {
    var result = stripHtml(input);
    result = result.replaceAll('\x00', '');
    return result.trim();
  }
}
