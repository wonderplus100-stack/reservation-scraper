@echo off
rem Double-click when the dashboard says the official-site (WordPress) login has expired.
rem Chrome opens: just log in; it detects the booking list by itself and then fetches.
cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" scripts\wp-manual-login.mjs
echo.
echo === Fetching official-site bookings ===
"C:\Program Files\nodejs\node.exe" run.mjs --only=wpBookings
echo.
pause
