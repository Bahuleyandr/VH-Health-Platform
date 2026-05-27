# Windows Update Packages

The Staff app has two Windows update paths:

- local hands-on updates on this PC use a stable per-user install directory;
- formal pilot/hospital packages use MSIX/App Installer with stable package
  identity `com.vhhealth.staff`.

## Local Hands-On Updates Without Reinstall

Use this path for day-to-day bug fixes while testing locally:

```powershell
.\scripts\update-local-staff-windows-app.ps1
```

That command builds the Windows release, stops the running Staff app, overwrites
the installed app files under:

```text
%LOCALAPPDATA%\Programs\VH Health Staff
```

Then it refreshes the Start Menu shortcut and relaunches Staff. This updates the
app binaries in place; it does not delete the app's local settings/storage.

For a quick copy/relaunch after a build has already completed:

```powershell
.\scripts\update-local-staff-windows-app.ps1 -SkipBuild
```

## MSIX Pilot Updates

From the repository root, create a formal App Installer/MSIX package:

```powershell
.\scripts\build-staff-windows-update.ps1
```

To install the local test-signed MSIX package, run PowerShell as Administrator:

```powershell
.\scripts\build-staff-windows-update.ps1 -Install -Launch
```

That command:

- bumps `apps/staff/pubspec.yaml` from `major.minor.patch+build` to the next
  patch/build version;
- runs `dart pub get`;
- runs `flutter analyze --no-fatal-infos`;
- builds a signed MSIX/App Installer package;
- trusts the local test certificate when `-Install` is used;
- installs it over the current Staff app package; and
- launches the installed app.

The first MSIX install is a one-time transition from the raw Flutter
`vhhealth_staff.exe` build. After that, rerunning the script with a higher
version updates the same installed app and should keep the app's local
settings/storage. On local developer machines the MSIX test certificate requires
elevated trust; for no-admin local testing, use
`update-local-staff-windows-app.ps1`.

## Version Rule

MSIX update detection uses `major.minor.patch.0`. Flutter build metadata after
`+` is not enough on its own. For example, `1.0.2+3` updates over `1.0.1+2`,
but `1.0.1+3` does not update over `1.0.1+2`.

To set an exact version:

```powershell
.\scripts\build-staff-windows-update.ps1 -Version 1.0.2+3 -Install -Launch
```

To rebuild the current version without changing `pubspec.yaml`:

```powershell
.\scripts\build-staff-windows-update.ps1 -NoVersionBump
```

## Backend Target

By default the script builds against the local hands-on backend:

```text
http://127.0.0.1:5206/api/v1
```

For staging or a hospital pilot, pass the release values:

```powershell
.\scripts\build-staff-windows-update.ps1 `
  -BaseUrl "https://<host>/api/v1" `
  -ApiKey "<release-smoke-api-key>" `
  -PublishFolder "\\server\VHHealthStaffUpdates"
```

## Production Signing

The local package uses the MSIX test certificate for hands-on testing, and the
script imports it into the current user's trusted people certificate store when
`-Install` is used. Before a hospital rollout, replace that with a
hospital-controlled code-signing certificate or Microsoft Store signing. The
package identity must remain stable or Windows will treat the build as a
separate app.
