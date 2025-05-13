# VH Health Backend API

Comprehensive API for managing patients, appointments, health records, investigations, pharmacy orders, and feedback for VH Health.

---

## 🛠️ Tech Stack

- **Node.js + Express.js**  
  Scalable backend framework with structured routing and middleware support.
- **PostgreSQL**  
  Relational database management system with schema-based data storage.
- **Swagger UI**  
  Live API documentation at `/api-docs`.
- **Helmet**  
  HTTP headers security hardening.
- **CORS Configuration**  
  Restricted to allowed origins via `ALLOWED_ORIGINS` environment variable.
- **Rate Limiting**  
  Prevents abuse by limiting requests per IP.
- **API Key Validation**  
  Protects API access using `x-api-key` header.
- **Winston Logger**  
  Structured logging for requests and errors.
- **Sentry Integration**  
  Error tracking and monitoring with Sentry.
- **Input Validators**  
  Request validation using `express-validator`.

---

## 🚀 Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/vh-health-backend.git
cd vh-health-backend
