import { normalizeTranscriptSegments } from '../../services/ai/ambientDocumentationService.js';
import {
  normalizeDiarizationPayload,
  resolveAmbientDiarization,
  segmentRawTranscriptBySpeakerHints,
} from '../../services/ai/ambientDiarizationService.js';

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

describe('ambient diarization adapter', () => {
  it('normalizes Deepgram-style utterances', () => {
    const segments = normalizeDiarizationPayload({
      results: {
        utterances: [
          { speaker: 0, transcript: 'How are you feeling?', start: 0.2, end: 2.1 },
          { speaker: 1, transcript: 'My breathing is better.', start: 2.4, end: 5.2 },
        ],
      },
    });
    expect(segments).toHaveLength(2);
    expect(segments[0].speaker).toBe('doctor');
    expect(segments[1].speaker).toBe('patient');
    expect(segments[1].start_seconds).toBe(2.4);
  });

  it('normalizes Azure conversation transcription phrases', () => {
    const segments = normalizeDiarizationPayload({
      recognizedPhrases: [
        {
          SpeakerId: 'Guest-2',
          OffsetInTicks: 20_000_000,
          DurationInTicks: 30_000_000,
          NBest: [{ Display: 'I had chest pain last night.' }],
        },
      ],
    });
    expect(segments).toHaveLength(1);
    expect(segments[0].speaker).toBe('patient');
    expect(segments[0].start_seconds).toBe(2);
    expect(segments[0].end_seconds).toBe(5);
  });

  it('segments speaker-labelled raw transcripts', () => {
    const segments = segmentRawTranscriptBySpeakerHints([
      'Doctor: Any fever?',
      'Patient: No fever today.',
      'Caregiver: He slept well.',
    ].join('\n'));
    expect(segments.map((segment) => segment.speaker)).toEqual(['doctor', 'patient', 'caregiver']);
    expect(segments[1].text).toBe('No fever today.');
  });

  it('falls back to raw transcript when provider payload is empty', async () => {
    const result = await resolveAmbientDiarization({
      diarizationPayload: { results: { utterances: [] } },
      rawTranscript: 'Patient: Cough is reduced.',
      provider: 'deepgram',
    });
    expect(result.status).toBe('completed');
    expect(result.provider).toBe('deepgram');
    expect(result.source).toBe('diarization_payload');
    expect(result.segments[0].speaker).toBe('patient');
  });

  it('returns a structured skip when no transcript source exists', async () => {
    const result = await resolveAmbientDiarization();
    expect(result.status).toBe('skipped');
    expect(result.provider).toBe('none');
    expect(result.segments).toEqual([]);
    expect(result.reason).toBe('diarization_provider_not_configured');
  });
});
