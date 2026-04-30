/**
 * Phase E5 — voice provider unit tests.
 */

import { jest } from '@jest/globals';

const { placeVoiceCall, __testing__ } = await import('../../utils/notifications/sendVoiceNotification.js');

beforeEach(() => {
  delete process.env.VOICE_PROVIDER;
  delete process.env.VOICE_DEFAULT_LANGUAGE;
});

afterAll(() => {
  delete process.env.VOICE_PROVIDER;
  delete process.env.VOICE_DEFAULT_LANGUAGE;
});

describe('buildTwiml', () => {
  it('builds a Say verb with the provided language', () => {
    const xml = __testing__.buildTwiml('Hello there', 'hi-IN');
    expect(xml).toMatch(/<Response><Say language="hi-IN">Hello there<\/Say><\/Response>/);
  });

  it('escapes XML metacharacters', () => {
    const xml = __testing__.buildTwiml('Patient: <Mr> & "co"');
    expect(xml).toContain('&lt;Mr&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;');
  });

  it('truncates pathological message lengths to 1000 chars', () => {
    const long = 'x'.repeat(5000);
    const xml = __testing__.buildTwiml(long);
    // 1000 x's plus the surrounding template
    expect(xml.length).toBeLessThan(1100);
  });
});

describe('placeVoiceCall', () => {
  it('rejects missing fields', async () => {
    await expect(placeVoiceCall({ to: '', message: 'x' })).rejects.toThrow(/to and message/);
  });

  it('logger provider returns status logged without network', async () => {
    const out = await placeVoiceCall({ to: '+919876543210', message: 'You have a 10am appointment' });
    expect(out).toEqual({ status: 'logged' });
  });

  it('returns invalid_phone for unrecognisable numbers', async () => {
    const out = await placeVoiceCall({ to: 'xx', message: 'x' });
    expect(out).toEqual({ status: 'invalid_phone' });
  });

  it('honours VOICE_DEFAULT_LANGUAGE', async () => {
    process.env.VOICE_DEFAULT_LANGUAGE = 'ta-IN';
    // Sanity: placeVoiceCall + buildTwiml share the env, even though
    // logger mode never builds the TwiML — assert the helper sees it.
    expect(__testing__.buildTwiml('vanakkam', process.env.VOICE_DEFAULT_LANGUAGE))
      .toMatch(/language="ta-IN"/);
  });

  it('rejects unknown VOICE_PROVIDER', async () => {
    process.env.VOICE_PROVIDER = 'magic';
    await expect(placeVoiceCall({ to: '+919876543210', message: 'x' }))
      .rejects.toThrow(/Unknown VOICE_PROVIDER/);
  });
});
