@echo off
rem STEP 4: safe check. Reads data and builds the whitekey entry list. It does NOT enter anything into whitekey.
call "%~dp0_common.cmd"
cd /d "%REPO%"
echo --- Official site bookings ---
"%NODE%" run.mjs --only=wpBookings
echo --- Entry list preview (no input is made) ---
"%NODE%" scripts\whitekey-plan.mjs
echo.
echo If the numbers look right, run 5_Start_AutoRun.cmd.
pause
