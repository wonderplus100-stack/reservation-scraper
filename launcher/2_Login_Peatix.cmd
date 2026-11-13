@echo off
rem STEP 2: log in to the two Peatix accounts (email code needed). Make sure the account name matches.
call "%~dp0_common.cmd"
call "%REPO%\scripts\peatix-relogin.cmd"
