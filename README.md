# VH Health Backend API

A robust and modular Node.js API for managing users, appointments, records, investigations, pharmacy orders, and feedback for VH Health.

---

## 🛠️ Tech Stack

- **Node.js + Express.js**  
  Scalable API framework with modular route and controller structure.
- **PostgreSQL**  
  Managed relational database for secure data storage.
- **Swagger UI**  
  Live API documentation at `/api-docs`.
- **Helmet**  
  HTTP headers security hardening.
- **CORS Middleware**  
  Origin restriction via `ALLOWED_ORIGINS` environment variable.
- **Rate Limiting Middleware**  
  Request limiting per IP to prevent abuse.
- **API Key Middleware**  
  Secures access using `x-api-key` header.
- **Winston + Morgan Logging**  
  Structured console and file logging with daily rotation and HTTP request tracking.
- **Environment Validation**  
  Ensures all required environment variables are defined at startup.
- **Input Validators**  
  Validates request bodies using `express-validator`.
- **Modular Structure**  
  Organized into `routes`, `controllers`, `middleware`, and `utils` folders for maintainability.

---

## 🚀 Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/vh-health-backend.git
cd vh-health-backend
2. Install Dependencies
bash
Copy code
npm install
3. Environment Variables Setup
Create a .env file in the root with the following keys:

env
Copy code
API_KEY=your_api_key_here
DATABASE_URL=your_postgres_url_here
ALLOWED_ORIGINS=https://yourapp.com,https://admin.yourapp.com
PORT=5000
4. Running the Application
Local Development
bash
Copy code
npm start
Access the API
Swagger Documentation: http://localhost:5000/api-docs

Health Check: http://localhost:5000/api/v1/health

🗂️ Project Structure
lua
Copy code
src/
├── controllers/
├── middleware/
├── routes/
├── utils/
├── logging/
├── validateEnv.js
├── responseHelper.js
logs/
├── error.log
├── combined.log
.gitignore
package.json
README.md
🛡️ Production Notes
Environment Variables: Ensure .env is properly configured on your production server.

Port Configuration: Uses PORT from .env or defaults to 5000.

Rate Limiting: Stricter limits apply in production mode.

Logging: Logs are rotated daily and stored in /logs.

API Security: Requires x-api-key header matching your API_KEY.

📖 API Documentation
Visit /api-docs after starting the server to explore the API via Swagger UI.

👨‍💻 Contributing
Fork the repository.

Create your feature branch (git checkout -b feature-name).

Commit your changes (git commit -m 'Add new feature').

Push to the branch (git push origin feature-name).

Open a Pull Request.