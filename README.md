# VH Health Backend

The backend API for the VH Health mobile and staff applications.  
This service powers appointment bookings, health records management, pharmacy orders, SOS alerts, and staff management.

---

## ✅ Project Status

- **Stage**: Local Development ✅ Fully Verified
- **Version**: v1.0.0
- **Next Step**: Deploy to Render and validate with Postman against cloud APIs

---

## ✅ Features Overview

### 🟢 Patient API
| Method | Endpoint                                        | Description                           |
|------|-------------------------------------------------|---------------------------------------|
| POST  | `/api/v1/request-otp`                            | Send OTP to patient phone number      |
| POST  | `/api/v1/verify-otp`                             | Verify OTP and authenticate user      |
| GET   | `/api/v1/users/:phoneNumber`                     | Fetch user profile by phone number    |
| POST  | `/api/v1/users`                                  | Create or update user profile         |
| GET   | `/api/v1/doctors`                                | List all doctors                      |
| GET   | `/api/v1/departments-with-doctors`               | List all departments and doctors      |
| POST  | `/api/v1/appointments`                           | Book an appointment                   |
| GET   | `/api/v1/appointments/:phoneNumber`              | Get appointments by phone number      |
| POST  | `/api/v1/investigations`                         | Request an investigation              |
| GET   | `/api/v1/investigations/:phoneNumber`            | Get investigation requests            |
| POST  | `/api/v1/pharmacy-orders`                        | Upload pharmacy prescription          |
| GET   | `/api/v1/pharmacy-orders/:phoneNumber`           | Get pharmacy orders                   |
| POST  | `/api/v1/health-records`                         | Upload health record                  |
| GET   | `/api/v1/health-records/:phoneNumber`            | Get health records                    |
| POST  | `/api/v1/feedback`                               | Submit feedback                       |
| POST  | `/api/v1/sos-alert`                              | Send SOS alert with location          |

### 🟢 Staff API
| Method | Endpoint                                        | Description                           |
|------|-------------------------------------------------|---------------------------------------|
| GET   | `/api/v1/staff/attendance`                       | Get staff attendance records          |
| POST  | `/api/v1/staff/attendance`                       | Mark staff attendance                 |
| GET   | `/api/v1/staff/roll-call`                        | Get staff roll-call records           |
| GET   | `/api/v1/consultations/:phoneNumber`             | Get patient consultations             |
| POST  | `/api/v1/staff/consultations`                    | Upload patient consultation document  |
| POST  | `/api/v1/staff/investigations`                   | Upload investigation result           |
| POST  | `/api/v1/staff/pharmacy-orders`                  | Update pharmacy order status          |

### 🟢 Admin API
| Method | Endpoint                                        | Description                           |
|------|-------------------------------------------------|---------------------------------------|
| POST  | `/api/v1/admin/departments`                      | Add or update a department            |
| DELETE| `/api/v1/admin/departments/:departmentId`        | Delete a department                   |
| POST  | `/api/v1/admin/doctors`                          | Add or update a doctor                |
| DELETE| `/api/v1/admin/doctors/:doctorId`                | Delete a doctor                       |

### 🟢 System Health & Version
| Method | Endpoint                                        | Description                           |
|------|-------------------------------------------------|---------------------------------------|
| GET   | `/api/v1/health`                                 | Check system health                   |
| GET   | `/api/v1/app-version`                            | Get current app version information   |

---

## ✅ Example Request Payloads

### 📌 **Submit Feedback**
```json
{
  "phoneNumber": "9876543210",
  "rating": 5,
  "comment": "Excellent service!"
}
📌 Book Appointment
json
Copy code
{
  "phone": "9876543210",
  "doctor_name": "Dr. John Doe",
  "date": "2025-05-15",
  "time": "10:00 AM"
}
📌 Upload Pharmacy Order (Patient)
json
Copy code
{
  "phone": "9876543210",
  "order_file": "prescription.jpg"
}
📌 Fulfill Pharmacy Order (Staff)
json
Copy code
{
  "phone": "9876543210",
  "order_id": "1",
  "status": "fulfilled",
  "notes": "Delivered to patient address"
}
📌 Upload Investigation Result (Staff)
json
Copy code
{
  "phone": "9876543210",
  "test_name": "Blood Test",
  "result_file": "blood_test_results.pdf"
}
📌 Send SOS Alert
json
Copy code
{
  "phone": "9876543210",
  "latitude": "13.0827",
  "longitude": "80.2707"
}
✅ Environment Configuration (.env Example)
bash
Copy code
API_KEY=vhhealth123
API_BASE_URL=https://your-render-domain.onrender.com/api/v1
DATABASE_URL=postgresql://vh_health_user:yourpassword@dpg-your-db-url.render.com/vh_health
ALLOWED_ORIGINS=https://yourapp.com,https://admin.yourapp.com
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100
PORT=5000
✅ Deployment Steps
Ensure .env is configured for Render.

Push code to GitHub.

Trigger deploy on Render.

Test all routes again on Render URL.

✅ Local Development
Run locally with:

bash
Copy code
npm install
npm start
Access local API at:

bash
Copy code
http://localhost:5000/api/v1
✅ Contributors
Backend Developer: Bahuleyan

Project: VH Health