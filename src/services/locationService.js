// src/services/locationService.js
import db from '../config/database.js';
import { calculateDistance } from '../utils/geoUtils.js';

export const findNearbyEmergencyServices = async (latitude, longitude, radius = 25) => {
  const hospitals = await findNearbyHospitals(latitude, longitude, radius);
  const pharmacies = await findNearbyPharmacies(latitude, longitude, 10);
  const bloodBanks = await findNearbyBloodBanks(latitude, longitude, radius);

  return { hospitals, pharmacies, bloodBanks };
};

export const findNearbyHospitals = async (latitude, longitude, radius) => {
  const result = await db.query(`
    SELECT 
      id, name, phone as hospital_phone, address, website,
      latitude as hosp_lat, longitude as hosp_lon,
      emergency_services, trauma_center, specialties,
      beds_available, ambulance_available, contact_person,
      operating_hours, emergency_contact
    FROM hospitals 
    WHERE emergency_services = true
      AND status = 'active'
    ORDER BY 
      (6371 * acos(cos(radians($1)) * cos(radians(latitude)) * 
      cos(radians(longitude) - radians($2)) + sin(radians($1)) * 
      sin(radians(latitude)))) ASC
    LIMIT 5
  `, [latitude, longitude]);

  return result.rows.map(hospital => ({
    ...hospital,
    distance_km: parseFloat(calculateDistance(
      latitude, longitude, 
      hospital.hosp_lat, hospital.hosp_lon
    ).toFixed(1)),
    estimated_travel_time_minutes: Math.round(calculateDistance(
      latitude, longitude, 
      hospital.hosp_lat, hospital.hosp_lon
    ) * 2)
  })).filter(h => h.distance_km <= radius);
};

// ... other location methods