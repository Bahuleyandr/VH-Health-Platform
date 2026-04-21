// src/middleware/identityValidator.js

export function validateUID(req, res, next) {
  const userRole = req.user?.role;
  if (userRole === 'ADMIN') {return next();} // ✅ Superuser override

  const explicitUid = req.body?.uid || req.query?.uid || req.params?.uid;
  const uid = explicitUid || req.user?.uid;
  if (!uid || typeof uid !== 'string' || uid.length < 6) {
    return res.status(400).json({ error: 'Missing or invalid UID' });
  }
  next();
}

export function validatePhone(req, res, next) {
  const userRole = req.user?.role;
  if (userRole === 'ADMIN') {return next();} // ✅ Superuser override

  const explicitPhone =
    req.body?.phone ||
    req.body?.phoneNumber ||
    req.query?.phone ||
    req.query?.phoneNumber ||
    req.params?.phone ||
    req.params?.phoneNumber;
  const phone = explicitPhone || req.user?.phone;

  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ error: 'Missing or invalid phone number' });
  }
  next();
}
