# VHHealth — Testing Checklist

Last updated: 2026-03-27

**Test patient:** Rajesh Kumar, phone: 9876543210
**Test admin:** phone: 9100000002
**Test receptionist:** phone: 9100000001
**Test pharmacist:** phone: 9100000004
**Test lab tech:** phone: 9100000005

---

## 1. PATIENT APP

### 1.1 Authentication
- [ ] Open app → splash screen loads
- [ ] Login with OTP (Firebase) → phone: 9876543210
- [ ] Profile setup screen appears (first time) or dashboard loads
- [ ] Logout and re-login works

### 1.2 Dashboard
- [ ] Feature grid shows: Appointments, Records, Pharmacy, Investigations, Departments, etc.
- [ ] Smart widgets show: active pharmacy order card, upcoming appointment card
- [ ] Appointment polling shows next appointment info at top
- [ ] SOS button visible and functional

### 1.3 Appointments
- [ ] Tap Appointments → shows Book + My Appointments tabs
- [ ] Contact banner shows appointment phone numbers (tap to call)
- [ ] Select Department → shows list of 20 departments
- [ ] Select Doctor → shows doctor cards with specialization, fee, "Available Today" badge
- [ ] Tap doctor → detail sheet with bio, qualifications, schedule
- [ ] Select Date → slot picker shows 30-min slots (available=teal, taken=gray)
- [ ] Book appointment → success message with "SCHEDULED" status
- [ ] My Appointments tab → shows all 3 test appointments (SCHEDULED, CONFIRMED, COMPLETED)
- [ ] CONFIRMED appointment shows token number
- [ ] COMPLETED appointment shows "View Prescription" button
- [ ] Cancel button on SCHEDULED appointment works

### 1.4 Your Health / Records
- [ ] Tap Your Health → 5 tabs load (Health Records, Hospital Docs, My Uploads, Consultations, Summary)
- [ ] Hospital Docs tab → shows prescription from completed appointment
- [ ] My Uploads → "Upload" FAB works (camera/gallery picker)
- [ ] Upload a test document → appears in list
- [ ] Swipe to delete works
- [ ] Download/view document opens URL

### 1.5 Pharmacy
- [ ] Tap Pharmacy → Order Medicines + My Orders tabs
- [ ] Upload prescription photo (camera/gallery)
- [ ] Choose "Home Delivery" → enter address
- [ ] Place Order → shows order number PHR-2026-XXXX
- [ ] My Orders → shows test order with status PLACED
- [ ] Status tracker dots visible (PLACED highlighted)

### 1.6 Investigations
- [ ] Tap Investigations → My Bookings + Upload + Results tabs
- [ ] Contact banner shows home sample collection numbers
- [ ] My Bookings → shows test booking (BOOKED) with status tracker
- [ ] "Book Investigation" button → BookInvestigationScreen
- [ ] Search test catalog → shows 24 tests grouped by category
- [ ] Select tests → running cost total updates
- [ ] Choose Home Collection → enter address + time slot
- [ ] Book → success with INV-2026-XXXX number
- [ ] OR upload prescription slip photo instead of selecting tests

### 1.7 Departments
- [ ] Shows 20 departments with doctor count badges
- [ ] Search bar filters by name/specialization
- [ ] Expand department → shows doctor cards
- [ ] Tap doctor → detail bottom sheet with full profile
- [ ] "Book Appointment" button navigates to appointments with doctor pre-selected

### 1.8 Calendar
- [ ] Shows appointment events (teal dots)
- [ ] Shows pharmacy order events (purple dots)
- [ ] Shows investigation booking events (orange dots)
- [ ] Tap a date → shows event details below

### 1.9 Notifications
- [ ] Shows notification list
- [ ] Tap notification → navigates to relevant screen (appointment/pharmacy/investigation)

### 1.10 Profile
- [ ] Profile edit → shows all fields (name, email, birthday, gender, blood group, address, allergies, emergency contact, insurance)
- [ ] All fields pre-filled from backend
- [ ] Save changes → success

### 1.11 About Us
- [ ] Contact action bar: Appointments, Home Sample, Ambulance, Navigate
- [ ] Tap phone numbers → opens dialer
- [ ] Tap Navigate → opens Google Maps
- [ ] Markdown content renders correctly

### 1.12 Prescriptions
- [ ] Your Health → Prescriptions tab shows test e-prescription (RX-2026-XXXX)
- [ ] Tap → detail: medications table, vitals, diagnosis, follow-up
- [ ] "Download PDF" button works
- [ ] "Order Medicines" → shows items with prices → place pharmacy order

---

## 2. STAFF APP

### 2.1 Authentication
- [ ] Login with employee credentials
- [ ] Dashboard/hub screen loads with feature cards

### 2.2 Appointment Queue
- [ ] Today's Queue tab → shows today's CONFIRMED appointment (token #3, Rajesh Kumar, 14:30)
- [ ] Pending tab → shows tomorrow's SCHEDULED appointment (no token yet)
- [ ] Tap "Call & Confirm" → confirmation sheet with date/time/notes
- [ ] Confirm → patient gets push notification + SMS
- [ ] After confirming, mark as Complete
- [ ] "Create e-Prescription" prompt appears after completion

### 2.3 E-Prescription Entry
- [ ] Search patient by phone → finds Rajesh Kumar
- [ ] Vitals section: enter BP, pulse, temp, SpO2, weight
- [ ] Add medications: type "Eco" → type-ahead suggests "Ecosprin 75"
- [ ] Set frequency (OD), duration (continuous), route (oral), instructions
- [ ] Add 2-3 medicines
- [ ] Set follow-up date
- [ ] Submit → RX-2026-XXXX generated
- [ ] Optional: take photo of handwritten prescription

### 2.4 Pharmacy Orders
- [ ] New Orders tab → shows test PLACED order
- [ ] Tap to view prescription photo / order note
- [ ] "View & Confirm" → enter items + cost → confirm
- [ ] "Start Preparing" button → "Dispatch" → enter delivery person + phone
- [ ] "Mark Delivered" → patient notified

### 2.5 Lab Bookings
- [ ] New Bookings tab → shows test BOOKED investigation
- [ ] View tests selected
- [ ] "Call & Confirm" → confirm with cost
- [ ] "Dispatch Collector" → enter collector phone
- [ ] GPS tracking starts (location sharing indicator)
- [ ] "Mark Collected" → "Start Processing" → "Upload Result" (PDF)

### 2.6 Investigations (existing)
- [ ] Upload Result tab → search by phone, select test type, enter result
- [ ] File attach button works (file_picker)
- [ ] Pending tab → shows pending investigations
- [ ] Start/Complete buttons work

### 2.7 Attendance
- [ ] Check-in (GPS geofenced — need to be near hospital)
- [ ] Calendar shows attendance for month
- [ ] Break tracking
- [ ] Check-out

### 2.8 Housekeeping
- [ ] Select zone → submit cleaning log with photo
- [ ] Raise request → tracked with SLA

---

## 3. ADMIN PORTAL (https://admin.vhhealth.app)

### 3.1 Authentication
- [ ] Login page loads → Admin tab
- [ ] Login as admin (9100000002)
- [ ] Staff tab → login as staff (9100000001)
- [ ] Role-based redirect: admin sees full nav, staff sees "My Work" only

### 3.2 Dashboard
- [ ] Admin home: system stats, recent activity
- [ ] System Health Monitor cards: DB (green), R2, Push, SMS, scheduler
- [ ] Notification backlog count
- [ ] Stuck orders count

### 3.3 Appointments Page
- [ ] Overview tab: summary cards (total, confirmed, completed, pending, no-shows)
- [ ] SLA metrics: avg response time, breach count
- [ ] Pending confirmation list with SLA countdown
- [ ] "Confirm" button inline works
- [ ] All Appointments tab: filterable table, actions work
- [ ] Walk-in button → register walk-in patient
- [ ] Doctor Queue tab: filter by doctor, shows slot availability
- [ ] Prescriptions tab: shows test e-prescription with medication table
- [ ] Documents tab
- [ ] Audit Trail tab

### 3.4 Investigations Page
- [ ] Overview (SLA dashboard)
- [ ] All Investigations tab
- [ ] Test Catalog → 24 tests grouped by category
- [ ] Add/edit test works
- [ ] Lab Bookings tab → shows test booking
- [ ] Confirm/dispatch/collect/process/result buttons per status

### 3.5 Pharmacy Page
- [ ] Overview (SLA dashboard): placed/confirmed/dispatched/delivered counts
- [ ] Orders tab → shows test order, action buttons
- [ ] Catalog tab → 125 medicines, grouped by category
- [ ] Add/edit medicine works
- [ ] Stock quantity and reorder alerts

### 3.6 Payroll Page
- [ ] Payroll Runs tab
- [ ] Salary Config tab
- [ ] Salary Revisions tab
- [ ] Tools tab (CSV export, PF/ESI registers, leave encashment)
- [ ] Compliance tab (F&F, gratuity, declarations, payslip queries, bulk revisions, calendar)
- [ ] Payroll Comparison page (📊 button)

### 3.7 Housekeeping Page
- [ ] Dashboard tab: stats, SLA, top staff
- [ ] Cleaning Logs tab: verify/flag buttons
- [ ] Requests tab: assign, verify, new request
- [ ] Zones tab: add/edit zones
- [ ] Staff Performance tab

### 3.8 Attendance & HR
- [ ] Attendance dashboard
- [ ] Leave approvals
- [ ] Shifts management
- [ ] Incidents page
- [ ] Grievances page

### 3.9 Audit Pages
- [ ] System Audit → Live Feed, Log Search, User History
- [ ] Report Audit
- [ ] Attendance Audit

### 3.10 Department & Doctor Management
- [ ] Departments → 20 departments listed, add/edit/deactivate
- [ ] Doctors → 20 doctors with schedule badges
- [ ] Edit doctor → schedule editor (day toggle + time)
- [ ] Consultation fee editable
- [ ] Deactivate works (doesn't delete)

### 3.11 Staff Self-Service Pages (login as staff)
- [ ] My Appointments → today's queue
- [ ] My Attendance → calendar view
- [ ] My Leave → apply, history
- [ ] My Payslips → list, download PDF
- [ ] My Replacements → view, create
- [ ] Upload Prescription → select appointment, upload

### 3.12 Route Protection
- [ ] Staff role → can't access /dashboard/payroll (redirects to /dashboard)
- [ ] Staff role → can't access /dashboard/users
- [ ] HR role → can access leave-approvals, incidents, grievances
- [ ] HR role → can't access /dashboard/settings

---

## 4. BACKEND VERIFICATION

### 4.1 Service Health
- [ ] `systemctl is-active vhhealth-backend.service` → active
- [ ] `curl http://localhost:5000/health` → responds
- [ ] Test data visible: `docker exec vhhealth-db psql -U vhhealth -d vhhealth -c "SELECT COUNT(*) FROM appointments WHERE phone='9876543210'"` → 3

### 4.2 Key Endpoints
- [ ] GET /api/v1/departments/departments-with-doctors → returns 20 departments with doctors
- [ ] GET /api/v1/appointments/slots?doctor_id=1&date=2026-03-28 → returns slot grid
- [ ] GET /api/v1/pharmacy/catalog → returns 125 medicines
- [ ] GET /api/v1/investigations/catalog → returns 24 tests
- [ ] GET /api/v1/system/health → returns service status

### 4.3 Cron Jobs
- [ ] Check logs: `journalctl -u vhhealth-backend.service --since "1 hour ago" | grep Scheduler`
- [ ] Notification retry running every 5 min
- [ ] Stuck order escalation running every 30 min

---

## 5. INFRASTRUCTURE

- [ ] Backend: https://api.vhhealth.app responds
- [ ] Admin: https://admin.vhhealth.app loads login page
- [ ] Nginx config correct
- [ ] Cloudflare tunnel active
- [ ] PostgreSQL Docker container running
- [ ] R2 bucket accessible (test upload)

---

## Test Credentials Summary

| Role | Phone | Use For |
|------|-------|---------|
| Patient | 9876543210 | Patient app testing |
| Receptionist | 9100000001 | Staff app + portal (My Work) |
| Admin | 9100000002 | Admin portal (full access) |
| HR | 9100000003 | Portal HR features |
| Pharmacist | 9100000004 | Staff app pharmacy + portal |
| Lab Tech | 9100000005 | Staff app investigations + portal |
| Dr. Thillai Vallal | 9000000001 | Doctor portal view |
