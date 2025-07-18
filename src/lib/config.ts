// lib/config.ts - Configuration file
export const config = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL || 'https://vh-health-backend.onrender.com',
  appName: process.env.NEXT_PUBLIC_APP_NAME || 'Healthcare Admin',
  
  // API endpoints
  endpoints: {
    auth: {
      login: '/api/v1/auth/admin/login',
      profile: '/api/v1/auth/admin/profile',
      logout: '/api/v1/auth/admin/logout',
    },
    users: {
      dashboard: '/api/v1/users/dashboard',
      list: '/api/v1/users',
      detail: (id: string) => `/api/v1/users/${id}`,
    },
    doctors: {
      list: '/api/v1/doctors',
      detail: (id: string) => `/api/v1/doctors/${id}`,
    },
  },
  
  // Storage keys
  storage: {
    authToken: 'authToken',
    userProfile: 'userProfile',
  },
  
  // Request timeouts
  timeouts: {
    default: 30000, // 30 seconds
    upload: 120000, // 2 minutes
  },
};