/**
 * Unit test for the morgan access-log URL redaction (audit 2026-06-18 §4
 * Observability): morgan's stock `combined` format logs the raw `:url`
 * including the query string, so opaque secret params (?api_key=, ?token=,
 * ?access_token=) rode into the HTTP access log untouched — phiRedactionFormat
 * does not catch opaque key=value secrets. The logger now installs a custom
 * morgan `url` token that runs redactSensitiveQueryParams first.
 */

import { EventEmitter } from 'events';
import logger from '../../logging/logger.js';

describe('morgan access-log URL redaction', () => {
  it('exposes a morganSafeUrlToken that redacts secret query params', () => {
    expect(typeof logger.morganSafeUrlToken).toBe('function');

    const req = { originalUrl: '/api/v1/auth/firebase/verify?api_key=supersecret123&page=2' };
    const out = logger.morganSafeUrlToken(req, {});

    expect(out).not.toContain('supersecret123');
    expect(out).toContain('api_key=[REDACTED]');
    // non-sensitive params survive for correlation
    expect(out).toContain('page=2');
  });

  it('redacts token / access_token too and preserves the path', () => {
    const req = { originalUrl: '/x?token=aaa&access_token=bbb&note_type=progress' };
    const out = logger.morganSafeUrlToken(req, {});

    expect(out).not.toContain('aaa');
    expect(out).not.toContain('bbb');
    expect(out).toContain('token=[REDACTED]');
    expect(out).toContain('access_token=[REDACTED]');
    expect(out).toContain('note_type=progress');
    expect(out.startsWith('/x?')).toBe(true);
  });

  it('falls back to req.url and leaves param-free URLs intact', () => {
    expect(logger.morganSafeUrlToken({ url: '/api/v1/users/me' }, {})).toBe('/api/v1/users/me');
  });

  it('produces an access-log line through the morgan middleware without leaking the secret', (done) => {
    // Drive a fake request/response through the configured morgan middleware
    // and capture what gets written to the winston http stream.
    const captured = [];
    const origWrite = logger.stream.write;
    logger.stream.write = (msg) => { captured.push(msg); };

    const req = {
      method: 'GET',
      url: '/api/v1/records?api_key=leakme',
      originalUrl: '/api/v1/records?api_key=leakme',
      headers: { 'user-agent': 'jest', referer: '' },
      httpVersionMajor: 1,
      httpVersionMinor: 1,
      socket: { remoteAddress: '127.0.0.1' },
      ip: '127.0.0.1',
    };
    // Real EventEmitter so morgan's on-finished (ee-first) can add/remove
    // listeners exactly as it does for a genuine ServerResponse.
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      getHeader: () => undefined,
      setHeader: () => {},
      finished: false,
      writableEnded: false,
      headersSent: true,
    });

    logger.morganMiddleware(req, res, () => {
      // morgan logs on the response 'finish' event.
      res.writableEnded = true;
      res.finished = true;
      res.emit('finish');
      // give the immediate flush a tick
      setImmediate(() => {
        logger.stream.write = origWrite;
        const line = captured.join('\n');
        expect(line).not.toContain('leakme');
        expect(line).toContain('[REDACTED]');
        done();
      });
    });
  });
});
