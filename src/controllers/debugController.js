import { success } from '../utils/responseHelper.js';

export async function getDebugInfo(req, res) {
  const user = req.user || {};
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  const info = {
    env: process.env.NODE_ENV || 'development',
    user: {
      uid: user.uid || null,
      role: user.role || 'anonymous',
      ip
    },
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime() / 60)}m ${Math.floor(process.uptime() % 60)}s`,
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB'
    }
  };

  return success(res, info, 'Debug info retrieved');
}
