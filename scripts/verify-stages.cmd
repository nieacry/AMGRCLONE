@echo off
setlocal
cd /d "%~dp0.."
title AMG rclone UI - stage 1-4 verification
if not exist "native\bin\amg-cloud.exe" (
  echo The helper is not built. Run scripts\test-build.cmd first.
  pause
  exit /b 1
)
echo Running the stage 1-4 check on a local test folder. Dropbox is not touched.
echo.
node scripts\verify-stages.mjs
echo.
echo Send the report file named above (in the .runtime folder) to Claude.
pause
