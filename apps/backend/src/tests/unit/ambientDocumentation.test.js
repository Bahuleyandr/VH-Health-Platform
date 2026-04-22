import { normalizeTranscriptSegments } from '../../services/ai/ambientDocumentationService.js';

describe('normalizeTranscriptSegments', () => {
  it('rejects invalid speaker labels', () => {
    const out = normalizeTranscriptSegments([
      { speaker: 'doctor', text: 'good morning', start: 0, end: 2 },
      { speaker: 'stranger', text: 'leak', start: 2, end: 4 },
    ]);
    expect(out.segments.length).toBe(1);
    expect(out.segments[0].speaker).toBe('doctor');
  });

  it('drops empty-text segments', () => {
    const out = normalizeTranscriptSegments([
      { speaker: 'patient', text: '', start: 0, end: 1 },
      { speaker: 'patient', text: 'I have a cough', start: 1, end: 3 },
    ]);
    expect(out.segments.length).toBe(1);
  });

  it('computes per-speaker talk time and distinct speaker count', () => {
    const out = normalizeTranscriptSegments([
      { speaker: 'doctor', text: 'hello', start: 0, end: 2 },
      { speaker: 'patient', text: 'chest pain', start: 2, end: 5 },
      { speaker: 'doctor', text: 'let me listen', start: 5, end: 8 },
      { speaker: 'caregiver', text: 'he was dizzy this morning', start: 8, end: 11 },
    ]);
    expect(out.speaker_count).toBe(3);
    expect(Math.round(out.talk_time.doctor)).toBe(5);
    expect(Math.round(out.talk_time.patient)).toBe(3);
    expect(Math.round(out.talk_time.caregiver)).toBe(3);
    expect(Math.round(out.total_duration_seconds)).toBe(11);
  });

  it('caps segment count at MAX_SEGMENTS', () => {
    const many = Array.from({ length: 700 }, (_, i) => ({
      speaker: 'doctor',
      text: `line ${i}`,
      start: i,
      end: i + 1,
    }));
    const out = normalizeTranscriptSegments(many);
    expect(out.segments.length).toBe(500);
  });

  it('tolerates missing start/end and non-finite numerics', () => {
    const out = normalizeTranscriptSegments([
      { speaker: 'doctor', text: 'hi' },
      { speaker: 'patient', text: 'hi back', start: 'abc', end: NaN },
    ]);
    expect(out.segments.length).toBe(2);
    expect(out.segments[0].start_seconds).toBe(0);
    expect(Number.isFinite(out.segments[1].start_seconds)).toBe(true);
  });

  it('returns empty structure on null input', () => {
    const out = normalizeTranscriptSegments(null);
    expect(out.segments).toEqual([]);
    expect(out.speaker_count).toBe(0);
    expect(out.total_duration_seconds).toBe(0);
  });

  it('accepts the start_seconds shorthand used by many STT providers', () => {
    const out = normalizeTranscriptSegments([
      { speaker: 'doctor', text: 'open your mouth', start_seconds: 10, end_seconds: 12 },
    ]);
    expect(out.segments[0].start_seconds).toBe(10);
    expect(out.segments[0].end_seconds).toBe(12);
    expect(out.segments[0].duration_seconds).toBe(2);
  });
});
