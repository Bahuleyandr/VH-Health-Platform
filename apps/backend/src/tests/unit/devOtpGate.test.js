// Item 4 (auth-hygiene audit §5): the dev-OTP bypass (generateOTP() -> fixed
// '123456') must require an EXPLICIT opt-in (ALLOW_DEV_OTP=true) on top of a
// non-production NODE_ENV, and must NEVER activate under NODE_ENV=production.
//
// OTP_CONFIG.devMode is computed from process.env at import time, so each case
// is exercised in a fresh child process with a controlled environment.
import { spawnSync } from 'child_process';

const node = process.execPath;

// Prints OTP_CONFIG.devMode (the dev-OTP gate) for the given environment.
function devModeFor(extraEnv = {}) {
  const result = spawnSync(
    node,
    [
      '--input-type=module',
      '-e',
      "import('./src/config/otpConfig.js').then(m => { process.stdout.write(String(m.OTP_CONFIG.devMode)); });",
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ...extraEnv,
      },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(`otpConfig import failed: ${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

describe('dev-OTP bypass gate (OTP_CONFIG.devMode)', () => {
  it('is OFF in development when ALLOW_DEV_OTP is unset (no accidental activation)', () => {
    expect(devModeFor({ NODE_ENV: 'development' })).toBe('false');
  });

  it('is OFF in development when ALLOW_DEV_OTP=false', () => {
    expect(devModeFor({ NODE_ENV: 'development', ALLOW_DEV_OTP: 'false' })).toBe('false');
  });

  it('is ON only when development AND ALLOW_DEV_OTP=true (explicit opt-in)', () => {
    expect(devModeFor({ NODE_ENV: 'development', ALLOW_DEV_OTP: 'true' })).toBe('true');
  });

  it('is OFF in test env even with ALLOW_DEV_OTP unset', () => {
    expect(devModeFor({ NODE_ENV: 'test' })).toBe('false');
  });

  it('can NEVER be ON under NODE_ENV=production, even if ALLOW_DEV_OTP=true', () => {
    expect(devModeFor({ NODE_ENV: 'production', ALLOW_DEV_OTP: 'true' })).toBe('false');
  });
});
