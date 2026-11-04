@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if exist "%~dp0publish\AMG rclone UI.exe" (
  start "" "%~dp0publish\AMG rclone UI.exe"
  exit /b
)
call npm.cmd start
if errorlevel 1 pause
