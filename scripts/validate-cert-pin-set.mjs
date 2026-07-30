#!/usr/bin/env node

import { Buffer } from 'node:buffer';

const OWNER_APPROVED_CLOCK_SKEW_SECONDS = 300;

function fail(message) {
  process.stderr.write(`release security configuration invalid: ${message}\n`);
  process.exitCode = 1;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return '';
  return process.argv[index + 1].trim();
}

function validatePin(pin) {
  if (!pin.startsWith('sha256/')) return false;
  const encoded = pin.slice('sha256/'.length);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return false;
  try {
    const decoded = Buffer.from(encoded, 'base64');
    return (
      decoded.length === 32 && decoded.toString('base64') === encoded
    );
  } catch {
    return false;
  }
}

const rawPins = argument('--pins');
const rawClockSkew = argument('--clock-skew-seconds');
const pins = rawPins
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const distinctPins = new Set(pins);

if (pins.length === 0) {
  fail('--pins is required');
} else if (pins.some(pin => !validatePin(pin))) {
  fail('every pin must be sha256/<canonical base64 SHA-256>');
} else if (distinctPins.size < 2) {
  fail('at least two distinct current/next pins are required');
}

if (!/^[1-9][0-9]*$/.test(rawClockSkew)) {
  fail('--clock-skew-seconds must be a positive integer');
} else if (Number(rawClockSkew) !== OWNER_APPROVED_CLOCK_SKEW_SECONDS) {
  fail(
    `--clock-skew-seconds must equal the owner-approved ${OWNER_APPROVED_CLOCK_SKEW_SECONDS}`,
  );
}

if (process.exitCode !== 1) {
  process.stdout.write(
    `release security configuration valid: ${distinctPins.size} distinct pins, ${rawClockSkew}s clock skew\n`,
  );
}
