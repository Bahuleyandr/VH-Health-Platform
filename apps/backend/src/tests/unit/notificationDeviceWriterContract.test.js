import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

describe('notification-device writer wiring', () => {
  it('routes every current user-device token claim through the handoff adapter', () => {
    const routes = readSource('routes/deviceRoutes.js');
    const firebaseAuth = readSource('services/auth/firebaseAuthService.js');

    expect(routes).toMatch(/registerNotificationDevice\(/);
    expect(routes).toMatch(/rotateNotificationDeviceToken\(/);
    expect(routes).not.toMatch(/INSERT INTO user_devices \([\s\S]{0,500}fcm_token/i);
    expect(routes).not.toMatch(/UPDATE user_devices\s+SET fcm_token\s*=\s*\$\d/i);

    expect(firebaseAuth).toMatch(/registerNotificationDevice\(/);
    expect(firebaseAuth).not.toMatch(/INSERT INTO user_devices \([\s\S]{0,500}fcm_token/i);
    expect(firebaseAuth).not.toMatch(/UPDATE user_devices\s+SET fcm_token\s*=\s*\$\d/i);
  });

  it('allows token revocation but never conflates staff device-trust secrets with FCM ownership', () => {
    const invalidTokenCleanup = readSource('utils/notifications/sendPushNotification.js');
    const userCleanup = readSource('services/user/userService.js');
    const codeBlue = readSource('utils/websocket/realtimeEmitter.js');

    expect(invalidTokenCleanup).toMatch(/UPDATE user_devices[\s\S]{0,120}SET fcm_token = NULL/i);
    expect(userCleanup).toMatch(/UPDATE user_devices[\s\S]{0,120}SET fcm_token = NULL/i);
    expect(codeBlue).toMatch(/FROM user_devices/i);
    expect(codeBlue).not.toMatch(/FROM staff_devices/i);
  });
});
