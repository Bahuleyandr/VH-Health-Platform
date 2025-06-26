// src/config/sosConfig.js

export const EMERGENCY_CONTACTS = {
  ambulance: process.env.AMBULANCE_NUMBER || '108',
  police: process.env.POLICE_NUMBER || '100',
  fire: process.env.FIRE_NUMBER || '101',
  hospital: process.env.HOSPITAL_EMERGENCY || '+91-9876543210',
  mentalHealth: process.env.MENTAL_HEALTH_HELPLINE || '9152987821',
  womenHelpline: process.env.WOMEN_HELPLINE || '1091',
  childHelpline: process.env.CHILD_HELPLINE || '1098'
};

export const SOS_SEVERITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

export const RESPONSE_TIMES = {
  critical: { target: 5, max: 10 },
  high: { target: 15, max: 30 },
  medium: { target: 30, max: 60 },
  low: { target: 60, max: 120 }
};

export const ESCALATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes