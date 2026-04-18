@echo off
setlocal

set APK_OUTPUT_DIR=output
set BUILD_LOG=build-log.txt

ECHO.
ECHO ====================================================
ECHO Step 1: Killing all known Java/Gradle/IDE processes...
ECHO ====================================================
taskkill /F /IM java.exe /T > nul 2>&1
taskkill /F /IM gradle.exe /T > nul 2>&1
taskkill /F /IM studio64.exe /T > nul 2>&1
taskkill /F /IM code.exe /T > nul 2>&1

timeout /t 2 /nobreak > nul

ECHO.
ECHO =======================================
ECHO Step 2: Forcibly deleting /build folder
ECHO =======================================
IF EXIST "build" (
    rmdir /s /q "build"
    ECHO ✅ Deleted /build
) ELSE (
    ECHO ℹ️  No /build folder found
)

ECHO.
ECHO ==================================================
ECHO Step 3: Building the project (clean build, no tests)
ECHO ==================================================
cd android
call gradlew.bat clean build -x test -x lint > "../%BUILD_LOG%" 2>&1
IF ERRORLEVEL 1 (
    ECHO ❌ Gradle build failed. Check %BUILD_LOG% for details.
    cd ..
    exit /b 1
)

ECHO.
ECHO ==========================================
ECHO Step 4: Copying APK to \output folder
ECHO ==========================================
cd ..
IF NOT EXIST "%APK_OUTPUT_DIR%" (
    mkdir "%APK_OUTPUT_DIR%"
)

set APK_PATH=android\app\build\outputs\apk\release\app-release.apk
IF EXIST "%APK_PATH%" (
    copy /Y "%APK_PATH%" "%APK_OUTPUT_DIR%\app-release.apk" > nul
    ECHO ✅ APK copied to "%APK_OUTPUT_DIR%\app-release.apk"
) ELSE (
    ECHO ⚠️ APK not found. You may need to build with `assembleRelease`
)

ECHO.
ECHO ✅ Build complete!
ECHO Log file: %BUILD_LOG%
