@echo off
rem Double-click when the dashboard says the Peatix login has expired.
rem A browser opens: log in with the emailed code, then press Enter in this window.
rem Runs for both Peatix accounts, then fetches Peatix so the dashboard updates.
cd /d "%~dp0.."
echo.
echo === 1/2: Wonder Plus ===
"C:\Program Files\nodejs\node.exe" scripts\peatix-manual-login.mjs "Wonder Plus"
echo.
echo === 2/2: Jua Party ===
"C:\Program Files\nodejs\node.exe" scripts\peatix-manual-login.mjs "Jua Party"
echo.
echo === Fetching Peatix ===
"C:\Program Files\nodejs\node.exe" run.mjs --only=peatix
echo.
pause
