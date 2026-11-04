@echo off
rem Rebuilds the native Cloud Files host and starts the app from source with a separate TEST profile.
rem The real profile (Documents\AMGRCLONE) and its Dropbox accounts are not touched.
setlocal
cd /d "%~dp0.."
echo Close AMG rclone UI first: tray icon - Exit. The running app locks native\bin\amg-cloud.exe.
echo.
pause
tasklist /FI "IMAGENAME eq amg-cloud.exe" | find /I "amg-cloud.exe" >nul && (echo amg-cloud.exe is still running. Exit the app from the tray and try again. & goto fail)

echo == Building the native host (Visual Studio 2022 C++ build tools + Windows SDK)
call npm.cmd run build:native || goto fail

set CLOUDLANE_TEST_DATA=%USERPROFILE%\AMGRCLONE-TEST
echo.
echo == Starting from source with the test profile: %CLOUDLANE_TEST_DATA%
call npm.cmd start || goto fail
exit /b 0

:fail
echo.
echo Stopped. Send a screenshot of this window to Claude.
pause
exit /b 1
