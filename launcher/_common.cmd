@echo off
rem Shared settings for the launcher scripts. The system folder is created by 1_Setup.cmd.
rem To use another location, create repo-path.txt next to these files with the folder path on one line.
set "REPO=%USERPROFILE%\Downloads\wonder-plus-reservation-scraper"
if exist "%~dp0repo-path.txt" set /p REPO=<"%~dp0repo-path.txt"
set "NODE=C:\Program Files\nodejs\node.exe"
