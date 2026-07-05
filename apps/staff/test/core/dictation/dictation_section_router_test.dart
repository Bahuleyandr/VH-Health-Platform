import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/dictation/dictation_section_router.dart';

void main() {
  const router = DictationSectionRouter();

  Map<DictationSection, String> route(
    String transcript, {
    DictationSection fallback = DictationSection.history,
  }) {
    return router.route(transcript, fallbackSection: fallback).sections;
  }

  test('routes no-keyword transcript to the focused fallback field', () {
    expect(route('fever since morning'), {
      DictationSection.history: 'fever since morning',
    });
  });

  test('routes unmatched prefix before first keyword to fallback', () {
    expect(route('looks tired chief complaint fever'), {
      DictationSection.history: 'looks tired',
      DictationSection.chiefComplaint: 'fever',
    });
  });

  test('splits chief complaint and history', () {
    expect(route('chief complaint cough history three days'), {
      DictationSection.chiefComplaint: 'cough',
      DictationSection.history: 'three days',
    });
  });

  test('splits examination diagnosis and plan', () {
    expect(route('examination chest clear diagnosis viral URTI plan fluids'), {
      DictationSection.examination: 'chest clear',
      DictationSection.diagnosis: 'viral URTI',
      DictationSection.plan: 'fluids',
    });
  });

  test('routes advice separately from plan', () {
    expect(route('plan paracetamol advice review if breathless'), {
      DictationSection.plan: 'paracetamol',
      DictationSection.advice: 'review if breathless',
    });
  });

  test('recognizes repeated sections and joins them deterministically', () {
    expect(route('history fever history vomiting plan ORS plan zinc'), {
      DictationSection.history: 'fever\nvomiting',
      DictationSection.plan: 'ORS\nzinc',
    });
  });

  test('prefers longer overlapping keyword phrases', () {
    expect(route('chief complaints headache and nausea'), {
      DictationSection.chiefComplaint: 'headache and nausea',
    });
  });

  test('does not match English keywords inside longer words', () {
    expect(route('the planarian sample is unrelated'), {
      DictationSection.history: 'the planarian sample is unrelated',
    });
  });

  test('does not match diagnosis inside a longer word', () {
    expect(route('diagnosismarker should stay in fallback'), {
      DictationSection.history: 'diagnosismarker should stay in fallback',
    });
  });

  test('accepts common exam shorthand', () {
    expect(route('o/e abdomen soft dx gastritis rx PPI'), {
      DictationSection.examination: 'abdomen soft',
      DictationSection.diagnosis: 'gastritis',
      DictationSection.plan: 'PPI',
    });
  });

  test('handles punctuation after section labels', () {
    expect(route('history: fever, examination - throat red; plan: gargle'), {
      DictationSection.history: 'fever',
      DictationSection.examination: 'throat red',
      DictationSection.plan: 'gargle',
    });
  });

  test('recognizes Hindi chief complaint and history keywords', () {
    expect(route('मुख्य शिकायत बुखार इतिहास दो दिन'), {
      DictationSection.chiefComplaint: 'बुखार',
      DictationSection.history: 'दो दिन',
    });
  });

  test('recognizes Hindi examination diagnosis and plan keywords', () {
    expect(route('जांच छाती साफ निदान वायरल योजना आराम'), {
      DictationSection.examination: 'छाती साफ',
      DictationSection.diagnosis: 'वायरल',
      DictationSection.plan: 'आराम',
    });
  });

  test('recognizes Hindi advice keyword', () {
    expect(route('योजना दवा सलाह तीन दिन बाद दिखाएं'), {
      DictationSection.plan: 'दवा',
      DictationSection.advice: 'तीन दिन बाद दिखाएं',
    });
  });

  test('does not match Hindi keyword inside a longer token', () {
    expect(route('इतिहासकार से मिली जानकारी'), {
      DictationSection.history: 'इतिहासकार से मिली जानकारी',
    });
  });

  test('routes all content to supplied fallback when no keywords exist', () {
    expect(
      route('continue oxygen monitoring', fallback: DictationSection.plan),
      {DictationSection.plan: 'continue oxygen monitoring'},
    );
  });

  test('returns empty map for blank transcript', () {
    expect(route('   '), isEmpty);
  });
}
