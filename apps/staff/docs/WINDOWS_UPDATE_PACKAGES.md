# Windows Update Packages

The Staff app has two Windows update paths:

- local hands-on updates on this PC use a stable `C:\Dev\Tools` install directory;
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
C:\Dev\Tools\VH Health Staff
```

Then it refreshes the Start Menu shortcut and relaunches Staff. This updates the
app binaries in place; it does not delete the app's local settings/storage.

The script first uses `flutter` from PATH. On a fresh developer PC where PATH is
not set yet, it also looks upward from the repo for
`Tools\flutter\bin\flutter.bat` (for example `C:\Dev\Tools\flutter\bin`).

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

By default, generated MSIX/App Installer files are written under:

```text
C:\Dev\Tools\VH Health Staff Updates
```

The first MSIX install is a one-time transition from the raw Flutter
`vhhealth_staff.exe` build. After that, rerunning the script with a higher
version updates the same installed app and should keep the app's local
settings/storage. On local developer machines the MSIX test certificate requires
elevated trust; for no-admin local testing, use
`update-local-staff-windows-app.ps1`.

Like the local update script, the MSIX builder can use a repo-ancestor
`Tools\flutter\bin` SDK when Flutter/Dart are not on PATH.

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

By default the update scripts build against the stable DalekDefender hands-on
backend:

```text
https://dalekdefender.hippocampus-monitor.ts.net:8444/api/v1
```

Because that backend validates a real staff API key, set `VH_API_KEY` or pass
`-ApiKey` before building against the default target. The scripts refuse to
pair the DalekDefender URL with the local dev key, because that produces an app
that can log in but then fails protected routes such as HR Dashboard.

For raw local backend development, pass the local URL explicitly:

```powershell
.\scripts\update-local-staff-windows-app.ps1 `
  -BaseUrl "http://127.0.0.1:5206/api/v1" `
  -ApiKey "vhhealth-local-api-key"
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
