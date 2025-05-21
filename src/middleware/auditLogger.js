// src/middleware/auditLogger.js

export function auditLogger(req, res, next) {
  const uid = req.user?.uid || 'UNKNOWN';
  const role = req.user?.role || 'ANONYMOUS';
  const ip = req.ip || req.connection?.remoteAddress;

  console.log(`[AUDIT] ${req.method} ${req.originalUrl} | UID: ${uid} | Role: ${role} | IP: ${ip}`);
  next();
}
