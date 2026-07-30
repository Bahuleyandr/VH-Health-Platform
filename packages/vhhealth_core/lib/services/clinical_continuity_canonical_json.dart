import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

class ClinicalContinuityCanonicalLimits {
  final int maxDepth;
  final int maxNodes;
  final int maxUtf8Bytes;

  const ClinicalContinuityCanonicalLimits({
    this.maxDepth = 64,
    this.maxNodes = 100000,
    this.maxUtf8Bytes = 2 * 1024 * 1024,
  });
}

class ClinicalContinuityCanonicalizationException implements Exception {
  final String code;

  const ClinicalContinuityCanonicalizationException(this.code);

  @override
  String toString() => 'ClinicalContinuityCanonicalizationException: $code';
}

/// Strict JSON parsing plus RFC 8785/JCS serialization.
///
/// Dart's stock JSON decoder intentionally accepts duplicate object names by
/// keeping the last value. A signed clinical artifact cannot use that
/// ambiguity, so this parser rejects duplicates before canonicalization.
class ClinicalContinuityCanonicalJson {
  ClinicalContinuityCanonicalJson._();

  static Object? parse(
    Uint8List bytes, {
    ClinicalContinuityCanonicalLimits limits =
        const ClinicalContinuityCanonicalLimits(),
  }) {
    if (bytes.length > limits.maxUtf8Bytes) {
      throw const ClinicalContinuityCanonicalizationException(
        'CANONICAL_BYTE_LIMIT',
      );
    }
    final source = utf8.decode(bytes, allowMalformed: false);
    return _StrictJsonParser(source, limits).parse();
  }

  static String canonicalize(
    Object? value, {
    ClinicalContinuityCanonicalLimits limits =
        const ClinicalContinuityCanonicalLimits(),
  }) {
    final writer = _CanonicalWriter(limits);
    writer.write(value, 0);
    return writer.finish();
  }

  static Uint8List canonicalBytes(
    Object? value, {
    ClinicalContinuityCanonicalLimits limits =
        const ClinicalContinuityCanonicalLimits(),
  }) => Uint8List.fromList(utf8.encode(canonicalize(value, limits: limits)));
}

class _StrictJsonParser {
  final String source;
  final ClinicalContinuityCanonicalLimits limits;
  int _offset = 0;
  int _nodes = 0;

  _StrictJsonParser(this.source, this.limits);

  Object? parse() {
    _skipWhitespace();
    final value = _value(0);
    _skipWhitespace();
    if (_offset != source.length) _fail('CANONICAL_INVALID_JSON');
    return value;
  }

  Object? _value(int depth) {
    _countNode();
    if (_offset >= source.length) _fail('CANONICAL_INVALID_JSON');
    return switch (source.codeUnitAt(_offset)) {
      0x7b => _object(depth),
      0x5b => _array(depth),
      0x22 => _string(),
      0x74 => _literal('true', true),
      0x66 => _literal('false', false),
      0x6e => _literal('null', null),
      _ => _number(),
    };
  }

  Map<String, Object?> _object(int depth) {
    _checkDepth(depth);
    _offset++;
    _skipWhitespace();
    final value = <String, Object?>{};
    if (_take(0x7d)) return value;
    while (true) {
      if (_offset >= source.length || source.codeUnitAt(_offset) != 0x22) {
        _fail('CANONICAL_INVALID_JSON');
      }
      final key = _string();
      if (value.containsKey(key)) _fail('CANONICAL_DUPLICATE_KEY');
      _skipWhitespace();
      if (!_take(0x3a)) _fail('CANONICAL_INVALID_JSON');
      _skipWhitespace();
      value[key] = _value(depth + 1);
      _skipWhitespace();
      if (_take(0x7d)) return value;
      if (!_take(0x2c)) _fail('CANONICAL_INVALID_JSON');
      _skipWhitespace();
    }
  }

  List<Object?> _array(int depth) {
    _checkDepth(depth);
    _offset++;
    _skipWhitespace();
    final value = <Object?>[];
    if (_take(0x5d)) return value;
    while (true) {
      value.add(_value(depth + 1));
      _skipWhitespace();
      if (_take(0x5d)) return value;
      if (!_take(0x2c)) _fail('CANONICAL_INVALID_JSON');
      _skipWhitespace();
    }
  }

  String _string() {
    _offset++;
    final units = <int>[];
    while (_offset < source.length) {
      final unit = source.codeUnitAt(_offset++);
      if (unit == 0x22) {
        final result = String.fromCharCodes(units);
        _assertWellFormedUnicode(result);
        return result;
      }
      if (unit < 0x20) _fail('CANONICAL_INVALID_JSON');
      if (unit != 0x5c) {
        units.add(unit);
        continue;
      }
      if (_offset >= source.length) _fail('CANONICAL_INVALID_JSON');
      final escaped = source.codeUnitAt(_offset++);
      switch (escaped) {
        case 0x22:
        case 0x2f:
        case 0x5c:
          units.add(escaped);
        case 0x62:
          units.add(0x08);
        case 0x66:
          units.add(0x0c);
        case 0x6e:
          units.add(0x0a);
        case 0x72:
          units.add(0x0d);
        case 0x74:
          units.add(0x09);
        case 0x75:
          final first = _hexCodeUnit();
          if (first >= 0xd800 && first <= 0xdbff) {
            if (_offset + 2 > source.length ||
                source.codeUnitAt(_offset) != 0x5c ||
                source.codeUnitAt(_offset + 1) != 0x75) {
              _fail('CANONICAL_LONE_SURROGATE');
            }
            _offset += 2;
            final second = _hexCodeUnit();
            if (second < 0xdc00 || second > 0xdfff) {
              _fail('CANONICAL_LONE_SURROGATE');
            }
            units
              ..add(first)
              ..add(second);
          } else if (first >= 0xdc00 && first <= 0xdfff) {
            _fail('CANONICAL_LONE_SURROGATE');
          } else {
            units.add(first);
          }
        default:
          _fail('CANONICAL_INVALID_JSON');
      }
    }
    _fail('CANONICAL_INVALID_JSON');
  }

  int _hexCodeUnit() {
    if (_offset + 4 > source.length) _fail('CANONICAL_INVALID_JSON');
    var value = 0;
    for (var i = 0; i < 4; i++) {
      final unit = source.codeUnitAt(_offset++);
      final digit = switch (unit) {
        >= 0x30 && <= 0x39 => unit - 0x30,
        >= 0x41 && <= 0x46 => unit - 0x41 + 10,
        >= 0x61 && <= 0x66 => unit - 0x61 + 10,
        _ => -1,
      };
      if (digit < 0) _fail('CANONICAL_INVALID_JSON');
      value = value * 16 + digit;
    }
    return value;
  }

  Object _number() {
    final start = _offset;
    _take(0x2d);
    if (_take(0x30)) {
      if (_isDigit(_peek())) _fail('CANONICAL_INVALID_JSON');
    } else {
      if (!_isNonZeroDigit(_peek())) _fail('CANONICAL_INVALID_JSON');
      while (_isDigit(_peek())) {
        _offset++;
      }
    }
    var hasFractionOrExponent = false;
    if (_take(0x2e)) {
      hasFractionOrExponent = true;
      if (!_isDigit(_peek())) _fail('CANONICAL_INVALID_JSON');
      while (_isDigit(_peek())) {
        _offset++;
      }
    }
    final exponent = _peek();
    if (exponent == 0x65 || exponent == 0x45) {
      hasFractionOrExponent = true;
      _offset++;
      final sign = _peek();
      if (sign == 0x2b || sign == 0x2d) _offset++;
      if (!_isDigit(_peek())) _fail('CANONICAL_INVALID_JSON');
      while (_isDigit(_peek())) {
        _offset++;
      }
    }
    final token = source.substring(start, _offset);
    if (!hasFractionOrExponent) {
      final integer = int.tryParse(token);
      if (integer != null && integer.abs() <= 9007199254740991) {
        return integer;
      }
    }
    final value = double.tryParse(token);
    if (value == null || !value.isFinite) {
      _fail('CANONICAL_NON_FINITE_NUMBER');
    }
    return value;
  }

  T _literal<T>(String text, T value) {
    if (!source.startsWith(text, _offset)) _fail('CANONICAL_INVALID_JSON');
    _offset += text.length;
    return value;
  }

  void _countNode() {
    _nodes++;
    if (_nodes > limits.maxNodes) _fail('CANONICAL_NODE_LIMIT');
  }

  void _checkDepth(int depth) {
    if (depth > limits.maxDepth) _fail('CANONICAL_DEPTH_LIMIT');
  }

  void _skipWhitespace() {
    while (_offset < source.length) {
      final unit = source.codeUnitAt(_offset);
      if (unit != 0x20 && unit != 0x09 && unit != 0x0a && unit != 0x0d) {
        return;
      }
      _offset++;
    }
  }

  bool _take(int unit) {
    if (_peek() != unit) return false;
    _offset++;
    return true;
  }

  int _peek() => _offset < source.length ? source.codeUnitAt(_offset) : -1;

  static bool _isDigit(int unit) => unit >= 0x30 && unit <= 0x39;
  static bool _isNonZeroDigit(int unit) => unit >= 0x31 && unit <= 0x39;

  Never _fail(String code) {
    throw ClinicalContinuityCanonicalizationException(code);
  }
}

class _CanonicalWriter {
  final ClinicalContinuityCanonicalLimits limits;
  final StringBuffer _buffer = StringBuffer();
  int _nodes = 0;
  int _bytes = 0;

  _CanonicalWriter(this.limits);

  void write(Object? value, int depth) {
    _nodes++;
    if (_nodes > limits.maxNodes) _fail('CANONICAL_NODE_LIMIT');
    switch (value) {
      case null:
        _append('null');
      case bool():
        _append(value ? 'true' : 'false');
      case int():
        _append(value.toString());
      case double():
        if (!value.isFinite) _fail('CANONICAL_NON_FINITE_NUMBER');
        _append(_ecmaNumber(value));
      case String():
        _string(value);
      case List<Object?>():
        _containerDepth(depth);
        _append('[');
        for (var i = 0; i < value.length; i++) {
          if (i > 0) _append(',');
          write(value[i], depth + 1);
        }
        _append(']');
      case Map<Object?, Object?>():
        _containerDepth(depth);
        if (value.keys.any((key) => key is! String)) {
          _fail('CANONICAL_UNSUPPORTED_OBJECT');
        }
        final keys = value.keys.cast<String>().toList()..sort(_compareUtf16);
        _append('{');
        for (var i = 0; i < keys.length; i++) {
          if (i > 0) _append(',');
          _string(keys[i]);
          _append(':');
          write(value[keys[i]], depth + 1);
        }
        _append('}');
      default:
        _fail('CANONICAL_UNSUPPORTED_TYPE');
    }
  }

  String finish() => _buffer.toString();

  void _string(String value) {
    _assertWellFormedUnicode(value);
    final out = StringBuffer('"');
    for (final unit in value.codeUnits) {
      switch (unit) {
        case 0x22:
          out.write(r'\"');
        case 0x5c:
          out.write(r'\\');
        case 0x08:
          out.write(r'\b');
        case 0x09:
          out.write(r'\t');
        case 0x0a:
          out.write(r'\n');
        case 0x0c:
          out.write(r'\f');
        case 0x0d:
          out.write(r'\r');
        default:
          if (unit < 0x20) {
            out.write('\\u${unit.toRadixString(16).padLeft(4, '0')}');
          } else {
            out.writeCharCode(unit);
          }
      }
    }
    out.write('"');
    _append(out.toString());
  }

  void _append(String value) {
    _bytes += utf8.encode(value).length;
    if (_bytes > limits.maxUtf8Bytes) _fail('CANONICAL_BYTE_LIMIT');
    _buffer.write(value);
  }

  void _containerDepth(int depth) {
    if (depth > limits.maxDepth) _fail('CANONICAL_DEPTH_LIMIT');
  }

  Never _fail(String code) {
    throw ClinicalContinuityCanonicalizationException(code);
  }
}

int _compareUtf16(String left, String right) {
  final length = math.min(left.length, right.length);
  for (var i = 0; i < length; i++) {
    final comparison = left.codeUnitAt(i).compareTo(right.codeUnitAt(i));
    if (comparison != 0) return comparison;
  }
  return left.length.compareTo(right.length);
}

void _assertWellFormedUnicode(String value) {
  for (var index = 0; index < value.length; index++) {
    final unit = value.codeUnitAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++index >= value.length) {
        throw const ClinicalContinuityCanonicalizationException(
          'CANONICAL_LONE_SURROGATE',
        );
      }
      final next = value.codeUnitAt(index);
      if (next < 0xdc00 || next > 0xdfff) {
        throw const ClinicalContinuityCanonicalizationException(
          'CANONICAL_LONE_SURROGATE',
        );
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw const ClinicalContinuityCanonicalizationException(
        'CANONICAL_LONE_SURROGATE',
      );
    }
  }
}

String _ecmaNumber(double value) {
  if (value == 0) return '0';
  var text = value.toString().toLowerCase();
  final exponentIndex = text.indexOf('e');
  if (exponentIndex < 0) {
    return text.endsWith('.0') ? text.substring(0, text.length - 2) : text;
  }

  var mantissa = text.substring(0, exponentIndex);
  final exponent = int.parse(text.substring(exponentIndex + 1));
  if (mantissa.endsWith('.0')) {
    mantissa = mantissa.substring(0, mantissa.length - 2);
  }
  if (exponent >= -6 && exponent < 21) {
    final negative = mantissa.startsWith('-');
    final unsigned = negative ? mantissa.substring(1) : mantissa;
    final parts = unsigned.split('.');
    final digits = parts.join();
    final decimalAt = parts.first.length + exponent;
    final expanded = decimalAt <= 0
        ? '0.${'0' * -decimalAt}$digits'
        : decimalAt >= digits.length
        ? '$digits${'0' * (decimalAt - digits.length)}'
        : '${digits.substring(0, decimalAt)}.${digits.substring(decimalAt)}';
    return negative ? '-$expanded' : expanded;
  }
  return '$mantissa${exponent >= 0 ? 'e+' : 'e'}$exponent';
}
