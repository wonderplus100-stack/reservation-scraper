@echo off
rem STEP 1 (first time only): download the system from GitHub, install parts, register the scheduled tasks.
rem Needs: Git and Node.js (LTS) installed, Google Chrome installed. See the guide file (the .txt next to this).
call "%~dp0_common.cmd"
where git >nul 2>nul || (echo Git is not installed. Install Git for Windows first, then run this again. & pause & exit /b 1)
where node >nul 2>nul || (echo Node.js is not installed. Install Node.js LTS first, then run this again. & pause & exit /b 1)

if exist "%REPO%\.git" (
  echo The system folder already exists. Updating it to the latest version...
  git -C "%REPO%" pull --ff-only
) else (
  echo Downloading the system to %REPO% ...
  git clone https://github.com/wonderplus100-stack/reservation-scraper.git "%REPO%"
)
if errorlevel 1 (echo Download failed. Check the internet connection. & pause & exit /b 1)

cd /d "%REPO%"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-new-pc.ps1"

echo.
echo NEXT: put the settings file (.env) from the OLD PC into this folder (copy it by USB or a password manager):
echo   %REPO%\.env
echo Then run 2_Login_Peatix.cmd and 3_Login_OfficialSite.cmd.
pause
