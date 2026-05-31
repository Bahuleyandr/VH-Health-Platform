import { validationResult } from 'express-validator';

const { deviceTypeValidator } = await import('../../validators/auth/authValidator.js');

async function validateDeviceType(deviceType) {
  const req = { body: {} };
  if (deviceType !== undefined) req.body.deviceType = deviceType;
  await deviceTypeValidator.run(req);
  return validationResult(req);
}

describe('deviceTypeValidator', () => {
  it('accepts all supported staff/admin device classes', async () => {
    for (const deviceType of ['mobile', 'tablet', 'desktop', 'web']) {
      const result = await validateDeviceType(deviceType);
      expect(result.isEmpty()).toBe(true);
    }
  });

  it('keeps deviceType optional for older clients', async () => {
    const result = await validateDeviceType(undefined);
    expect(result.isEmpty()).toBe(true);
  });

  it('rejects unsupported device classes with a clear message', async () => {
    const result = await validateDeviceType('kiosk');
    expect(result.isEmpty()).toBe(false);
    expect(result.array()[0].msg).toBe(
      'deviceType must be one of: mobile, tablet, desktop, web',
    );
  });
});
