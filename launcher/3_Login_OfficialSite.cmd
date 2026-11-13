@echo off
rem STEP 3: log in to the Wonder+ official site admin (tick "keep me logged in" to last about 2 weeks).
call "%~dp0_common.cmd"
call "%REPO%\scripts\wp-relogin.cmd"
