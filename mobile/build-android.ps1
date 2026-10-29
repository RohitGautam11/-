# Builds the Android APK locally and places it where the website serves downloads.
# Requirements: JDK 21+ (JDK 25 works), Android SDK (ANDROID_HOME, or the default %LOCALAPPDATA%\Android\Sdk).
# Usage:  .\build-android.ps1                                  (app asks for the server on first launch)
#         .\build-android.ps1 -Url https://your-app.vercel.app (app opens that server directly)
param([string]$Url = "")

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
if (-not (Test-Path $env:ANDROID_HOME)) { throw "Android SDK not found. Install Android Studio first." }
if ($Url) { $env:VARTALAP_URL = $Url } else { Remove-Item Env:VARTALAP_URL -ErrorAction SilentlyContinue }

npm install
npx cap sync android

# gradlew.bat cannot handle non-ASCII folder names (वार्तालाप), so build from a copy in TEMP.
$work = Join-Path $env:TEMP "vartalap-android-build"
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory $work | Out-Null
Copy-Item -Recurse "android" (Join-Path $work "android")
Copy-Item -Recurse "node_modules" (Join-Path $work "node_modules")

Push-Location (Join-Path $work "android")
try {
  if ($env:ANDROID_KEYSTORE_PATH) {
    .\gradlew.bat assembleRelease
    $apk = "app\build\outputs\apk\release\app-release.apk"
  } else {
    Write-Warning "ANDROID_KEYSTORE_PATH not set - building a debug-signed APK (fine for testing, not for the Play Store)."
    .\gradlew.bat assembleDebug
    $apk = "app\build\outputs\apk\debug\app-debug.apk"
  }
  if ($LASTEXITCODE -ne 0) { throw "Gradle build failed." }
  $built = Join-Path (Get-Location) $apk
} finally {
  Pop-Location
}

$target = Join-Path $PSScriptRoot "..\public\downloads"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item $built (Join-Path $target "vartalap.apk") -Force
Write-Host "APK ready: public\downloads\vartalap.apk (served at /downloads/vartalap.apk)"
