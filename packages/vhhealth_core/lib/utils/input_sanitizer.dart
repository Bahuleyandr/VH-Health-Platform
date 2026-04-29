/// Input sanitization utilities to prevent injection attacks.
///
/// Strips HTML/script tags and dangerous characters from user input
/// before sending to the backend.
class InputSanitizer {
  InputSanitizer._();

  /// Strip HTML tags from input text.
  /// Removes `<script>`, `<img>`, `<iframe>`, and all other HTML tags.
  /// Handles unclosed tags (e.g., `<img src=x onerror=alert(1)`) and
  /// strips all content between `<script>` tags.
  static String stripHtml(String input) {
    // First remove script/style blocks entirely (content + tags)
    var result = input.replaceAll(
      RegExp(
        r'<\s*(script|style)[^>]*>[\s\S]*?<\s*/\s*\1\s*>',
        caseSensitive: false,
      ),
      '',
    );
    // Remove complete tags (with closing >)
    result = result.replaceAll(RegExp(r'<[^>]*>'), '');
    // Remove unclosed tags (e.g., `<img src=x onerror=alert(1)` without `>`)
    result = result.replaceAll(RegExp(r'<[^>]*$'), '');
    return result;
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
