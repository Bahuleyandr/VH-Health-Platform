import upload from './uploadRoutes.js';
import debug from './debugRoutes.js';
import users from './userRoutes.js';
import lookup from './lookupRoutes.js';
import auth from './authRoutes.js';
import firebaseAuth from './firebaseAuthRoutes.js';
import departments from './departmentRoutes.js';
import doctors from './doctorRoutes.js';
import appointments from './appointmentRoutes.js';
import healthRecords from './recordRoutes.js';
import investigations from './investigationRoutes.js';
import pharmacy from './pharmacyRoutes.js';
import feedback from './feedbackRoutes.js';
import otp from './otpRoutes.js';
import version from './versionRoutes.js';
import health from './healthRoutes.js';
import sos from './sosRoutes.js';
import devices from './deviceRoutes.js'; // ✅ Newly added

export default {
  auth,
  firebaseAuth,
  upload,
  debug,
  users,
  lookup,
  departments,
  doctors,
  appointments,
  healthRecords,
  investigations,
  pharmacy,
  feedback,
  otp,
  version,
  health,
  sos,
  devices,
};
