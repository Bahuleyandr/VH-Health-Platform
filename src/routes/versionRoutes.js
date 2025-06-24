// src/routes/versionRoutes.js
import express from 'express';
import { success } from '../utils/responseHelper.js';
import { wrapRoutes } from '../config/routeWrapper.js';
import fs from 'fs';
import path from 'path';

const versionRouter = express.Router();

// Read package.json for version info
let packageInfo = { version: '1.0.0', name: 'vh-health-backend' };
try {
  const packagePath = path.resolve('package.json');
  packageInfo = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
} catch (err) {
  console.warn('Could not read package.json for version info');
}

wrapRoutes(
  versionRouter,
  [],
  {
    get: [
      [
        '/',
        (req, res) => {
          const versionInfo = {
            name: packageInfo.name,
            version: packageInfo.version,
            apiVersion: 'v1',
            buildDate: process.env.BUILD_DATE || new Date().toISOString().split('T')[0],
            environment: process.env.NODE_ENV || 'development',
            nodeVersion: process.version,
            uptime: Math.floor(process.uptime()),
            features: [
              'User Management',
              'Appointment Booking', 
              'Health Records',
              'Emergency SOS',
              'File Upload',
              'Analytics',
              'RBAC',
              'Firebase Auth',
              'OTP System'
            ],
            endpoints: {
              health: '/api/v1/health',
              docs: '/api-docs',
              version: '/api/v1/version'
            },
            lastUpdated: '2025-06-24',
            message: `${packageInfo.name} v${packageInfo.version} - Healthcare API`
          };

          success(res, versionInfo, 'Version information retrieved');
        }
      ],

      // 🏥 API Capabilities
      [
        '/capabilities',
        (req, res) => {
          const capabilities = {
            authentication: {
              methods: ['OTP', 'Firebase', 'JWT'],
              roles: ['ADMIN', 'DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'LAB_STAFF', 'PATIENT'],
              features: ['Multi-factor auth', 'Role-based access', 'Session management']
            },
            modules: {
              userManagement: { enabled: true, version: '1.0' },
              appointments: { enabled: true, version: '1.0' },
              healthRecords: { enabled: true, version: '1.0' },
              investigations: { enabled: true, version: '1.0' },
              pharmacy: { enabled: true, version: '1.0' },
              emergencySOS: { enabled: true, version: '1.0' },
              fileUploads: { enabled: true, version: '1.0' },
              analytics: { enabled: true, version: '1.0' },
              notifications: { enabled: true, version: '1.0' }
            },
            integrations: {
              firebase: { enabled: !!process.env.FIREBASE_PROJECT_ID },
              cloudStorage: { enabled: !!process.env.CF_R2_BUCKET },
              pushNotifications: { enabled: true },
              virusScanning: { enabled: !!process.env.CLAMAV_API_URL }
            },
            limits: {
              fileUploadSize: '10MB',
              dailyOTPLimit: 10,
              rateLimits: 'Role-based'
            }
          };

          success(res, capabilities, 'API capabilities retrieved');
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);