@echo off
rem Stage 0 in one double-click: git identity (this repo only), stage0.ps1 -Apply, push to GitHub.
setlocal
cd /d "%~dp0.."
set REPO_URL=https://github.com/nieacry/AMGRCLONE.git

where git >nul 2>&1 || (echo git is not installed: https://git-scm.com/download/win & goto fail)

rem Identity is set for this repository only, and only if none is configured yet.
git config user.name >nul 2>&1 || git config user.name "nieacry"
git config user.email >nul 2>&1 || git config user.email "nieacry@gmail.com"

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stage0.ps1 -Apply
if errorlevel 1 goto fail

echo.
echo == GitHub: %REPO_URL%
git remote get-url origin >nul 2>&1 || git remote add origin %REPO_URL%

rem Never overwrite anything that is already on GitHub.
set REMOTE_HAS_MAIN=
for /f %%h in ('git ls-remote --heads origin main') do set REMOTE_HAS_MAIN=1
if defined REMOTE_HAS_MAIN (
  echo The GitHub repository already has a main branch ^(for example a README created on the site^).
  echo Nothing was pushed. Tell Claude, and we will merge it safely.
  goto fail
)

git push -u origin main
if errorlevel 1 goto fail
git push origin --tags
if errorlevel 1 goto fail

echo.
echo Stage 0 done: https://github.com/nieacry/AMGRCLONE
pause
exit /b 0

:fail
echo.
echo Stopped. Send a screenshot of this window to Claude.
pause
exit /b 1
