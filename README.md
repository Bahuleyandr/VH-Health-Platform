VH Health – Patient‑centric Flutter App

VH Health is a cross‑platform mobile application built with Flutter. It serves as a digital companion for patients, allowing them to authenticate securely, view and manage their health records, request appointments, order medicines, request investigations, ask questions, and explore hospital departments and doctors. The project is structured into cohesive feature modules and uses provider‑based state management, Firebase authentication and a REST‑ful backend to deliver a smooth user experience.



Contents

Key Features



Screens \& Workflows



Architecture \& Project Structure



Setup \& Installation



Configuration \& Environment



Contributing



License



Key Features

The app offers a comprehensive set of features tailored for patients and guests:



Phone‑based authentication with optional guest access. Users can sign in via OTP using Firebase Auth. The login form validates Indian phone numbers and either sends an OTP or allows the user to continue as a guest. The OTP success handler persists user data and navigates to the profile setup or dashboard depending on whether a user is new or existing

GitHub

.



Profile setup. First‑time users enter personal details such as name, gender, email, birthday, anniversary and can upload a profile picture. Data is sent to the backend through BackendApiService.saveUserProfile and users can also skip the form

GitHub

.



Health record viewer with offline caching. Authenticated users can fetch health‑record manifests from the backend. Records can be filtered (all/consultation/investigation/report), sorted by date, and downloaded. Records are persisted locally via RecordCacheManager.saveManifest() so they remain available offline and are loaded if network requests fail

GitHub

.



Appointment requests with calendar integration. Patients can request appointments by choosing a department and optionally selecting a doctor. Requests are posted to the backend, and upon success the app either automatically adds a calendar event or prompts the user to sync the appointment via addEventToCalendar()

GitHub

.



Pharmacy orders. Users upload prescriptions (images or PDFs) and provide a delivery address. The file is uploaded via a multipart request; upon success an order API call is made to /pharmacy

GitHub

. Users can also call the pharmacy directly.



Investigation requests \& report viewing. Patients can request lab tests by entering a test name and uploading relevant files. The file is uploaded and then an investigation request is submitted

GitHub

. A “View reports” button navigates to the health record screen filtered to investigations.



Ask‑a‑Doubt (feedback). Users can submit questions or feedback. A simple form posts the question and phone number to the backend and provides success/failure notifications

GitHub

.



Departments \& doctor directory. The app retrieves departments and their doctors from the backend. Each department expands to show doctors with names, intros and profile pictures. Tapping “Book” forwards the user to the appointment screen prefilled with the selected doctor

GitHub

GitHub

.



Trivia \& About pages. The trivia page displays randomized health facts and allows users to refresh them. The about page uses a Markdown renderer to show rich, localized content.



SOS emergency service. An SOS button appears in many screens. When triggered, it sends the user’s phone number and location to an SOS API endpoint and opens the phone dialer to call the configured emergency number

GitHub

.



Customization: themes, localization, notifications. A global ThemeProvider supports light/dark mode, adjustable font sizes and dynamic accent colors stored via SharedPreferences

GitHub

. LanguageProvider loads and sets supported languages (English, Tamil, Hindi, Telugu, Malayalam)

GitHub

. NotificationProvider fetches unread notifications from the backend and exposes a simple API to mark them as read

GitHub

.



Screens \& Workflows

Authentication \& Onboarding

Login Screen. The login form collects a 10‑digit phone number and sends an OTP via Firebase. Guests can bypass login. A “SOS” floating button is always accessible for emergencies.



OTP Verification. Once the OTP widget is displayed, users enter the received code. On success, the app checks secure storage to determine if the user is new and redirects accordingly

GitHub

.



Profile Setup. New users enter personal details and optionally upload a photo. Information is validated (e.g., email format) before submission

GitHub

.



Dashboard \& Main Tabs

After authentication, users land on the dashboard with a bottom navigation bar. Tabs include:



Your Health: Displays a list of health records with filters, sorting and offline support. Users can download files if permissions are granted

GitHub

.



Appointments: Presents a form to request appointments and optionally add them to the user’s device calendar

GitHub

.



Pharmacy: Allows uploading prescriptions and placing medicine orders

GitHub

.



Investigations: Used to request lab tests; after submitting, users can view investigation reports in the health record module

GitHub

.



Ask a Doubt: Lets users send questions/feedback to the support team

GitHub

.



Trivia: Shows rotating fun health facts and a button to generate a new fact.



Departments: Lists departments and doctors loaded from the backend; users can expand a department and book a doctor directly

GitHub

GitHub

.



About Us: Renders a Markdown page with information about the hospital and the app.



Settings \& Localization

The settings page allows users to toggle dark/light/system themes, adjust font size, choose a dynamic accent color and change the app’s language. These preferences persist via SharedPreferences

GitHub

GitHub

.



Architecture \& Project Structure

The repository follows a modular structure inspired by the feature‑first approach:



bash

Copy code

lib/

├── app/                 # Core application wiring (main entry point \& routes)

│   ├── app.dart         # Root widget with providers and MaterialApp

│   └── routes.dart      # Centralised route map for all screens

├── core/                # Infrastructure, providers and reusable utilities

│   ├── providers/       # ThemeProvider, LanguageProvider, NotificationProvider

│   ├── services/        # SOSService, SharedPrefsService, BackendApiService, etc.

│   ├── utils/           # CacheFileUtils, CalendarUtils, permissions helpers

│   ├── offline/         # RecordCacheManager for offline manifest caching:contentReference\[oaicite:24]{index=24}

│   └── widgets/         # Reusable UI widgets (FeatureScreenScaffold, phone input, etc.)

├── features/            # Individual features, each in its own folder

│   ├── auth/            # Login \& OTP widgets

│   ├── profile/         # Profile setup screen and helpers

│   ├── your\_health/     # Health record listing and download logic

│   ├── appointments/    # Appointment request form:contentReference\[oaicite:25]{index=25}

│   ├── pharmacy/        # Prescription upload \& ordering:contentReference\[oaicite:26]{index=26}

│   ├── investigations/  # Lab test requests:contentReference\[oaicite:27]{index=27}

│   ├── feedback/        # Ask‑a‑Doubt screen:contentReference\[oaicite:28]{index=28}

│   ├── departments/     # Departments \& doctor listing:contentReference\[oaicite:29]{index=29}

│   ├── trivia/          # Trivia facts display

│   └── about/           # About page with Markdown content

├── generated/           # Localization files generated via flutter\_gen

└── l10n/                # AppLocalizations extensions and translation strings



assets/

└── images/              # Icons and background images used in the UI

State Management \& Services

Provider is used for reactive state: ThemeProvider handles theme and font settings, LanguageProvider manages the current locale and lists available languages

GitHub

, and NotificationProvider fetches unread notification counts from the backend

GitHub

.



Backend API communication is performed via the http and dio packages. Endpoints are defined in each feature and share a common API key. Sensitive API keys should ideally be moved to environment variables or secure storage.



Offline caching uses RecordCacheManager and CacheFileUtils to cache manifests and downloaded files to the device for offline use

GitHub

GitHub

.



Calendar integration is provided through the add\_2\_calendar package; events are added via a small utility function

GitHub

.



Firebase is configured via firebase\_options.dart (generated by FlutterFire). Firebase Auth is used for phone‑number sign‑in, and tokens are optionally sent to backend endpoints.



Localization uses the intl and flutter\_localizations packages; messages are defined in ARB files and generated into AppLocalizations. The app supports English, Tamil, Hindi, Telugu and Malayalam.



SOSService obtains the user’s location (via geolocator) and posts it along with the phone number to the backend while also launching the phone dialer

GitHub

.



Setup \& Installation

Prerequisites

Flutter 3.8+ – install via the official guides and ensure flutter doctor shows no issues.



A configured Firebase project. Use flutterfire configure to generate firebase\_options.dart, google-services.json (Android) and GoogleService-Info.plist (iOS). Update the bundle identifiers to match your own application ID.



For iOS builds, Xcode with a valid provisioning profile is required.



Getting Started

Clone the repository:



bash

Copy code

git clone https://github.com/Bahuleyandr/VH-health.git

cd VH-health

Install dependencies:



bash

Copy code

flutter pub get

Configure Firebase:



Run flutterfire configure and follow the prompts.



Place google-services.json in android/app/ and GoogleService-Info.plist in ios/Runner/.



Set environment variables / API keys:



The API key (vhhealth123) and base URLs are currently hard‑coded. For production builds, extract them into a secure file (e.g. .env using the flutter\_dotenv package) and reference them in your code.



Run the app:



bash

Copy code

flutter run                # deploys to a connected device or emulator

flutter run -d chrome      # optional, to run on web (experimental)

Building for release:



For Android: flutter build apk or flutter build appbundle.



For iOS: flutter build ios – ensure you have an Apple Developer account and proper signing setup.



Configuration \& Environment

Backend endpoints \& API key

All backend calls use the base URL https://vh-health-backend.onrender.com/api/v1 and an API key header (x‑api‑key). Hard‑coding secrets in source code is not recommended for production. Consider using a secrets manager or .env file and injecting them via build scripts. For example:



dart

Copy code

// lib/core/config/env.dart (create this file)

const String apiBaseUrl = String.fromEnvironment('API\_BASE\_URL', defaultValue: 'https://vh-health-backend.onrender.com/api/v1');

const String apiKey     = String.fromEnvironment('API\_KEY', defaultValue: 'vhhealth123');

and then supply --dart-define=API\_BASE\_URL=... --dart-define=API\_KEY=... when building.



Firebase options

firebase\_options.dart is generated by FlutterFire and should not be committed to public version control with secrets. Keep the file local and add it to .gitignore. The code uses DefaultFirebaseOptions.currentPlatform to initialize Firebase

GitHub

.



Permissions \& Platform Requirements

The app requests various permissions: location (for SOS), storage/photos (for downloading files and picking prescriptions), and calendar (for adding events). iOS requires updates to Info.plist with usage descriptions for these permissions.



Contributing

Contributions are welcome! To propose a change:



Fork the repository and create a new branch (e.g. feature/your-feature).



Make your changes, ensuring that the Dart analyzer reports no issues (flutter analyze) and that tests (if any) pass.



Update documentation and localization strings where appropriate.



Submit a pull request with a clear description of your changes and reference any relevant issues.



Code Style

The project follows the standard Flutter style as enforced by the flutter\_lints package. Use meaningful names, document public APIs, and avoid hard‑coding strings where localization is appropriate. Keep functions small and widgets stateless where possible.



License

This project is released under the MIT License. This permissive licence allows you to use, copy, modify and distribute the software for any purpose, provided that the original copyright notice and licence text are included in all copies and substantial portions of the software. The software is provided “as is”, without warranty of any kind, express or implied, and is not intended to replace professional medical advice or establish a doctor‑patient relationship.



A copy of the full MIT License text is included in the LICENSE file. By using this software you agree to the terms of that licence.

