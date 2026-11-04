@echo off
rem Builds the version from package.json and publishes it on GitHub Releases.
rem Safe to run again after a failure: finished steps are skipped.
setlocal EnableDelayedExpansion
cd /d "%~dp0.."
for /f "usebackq delims=" %%V in (`node -p "require('./package.json').version"`) do set VER=%%V
set TAG=v%VER%
set ZIP=versions\AMG-rclone-UI-%VER%-win-x64.zip
set NOTES=docs\releases\%VER%.md
echo == AMG rclone UI %VER%
if not exist "%NOTES%" (echo Release notes %NOTES% are missing. & goto fail)

echo == 1/5 Checking that this folder matches GitHub
git fetch -q origin || goto fail
set DIRTY=
for /f "delims=" %%L in ('git status --porcelain') do set DIRTY=1
if defined DIRTY (echo There are uncommitted changes. Run scripts\commit.cmd first. & git status --short & goto fail)
for /f %%H in ('git rev-parse HEAD') do set LOCAL=%%H
for /f %%H in ('git rev-parse origin/main') do set REMOTE=%%H
if not "%LOCAL%"=="%REMOTE%" (echo This folder and GitHub differ. Run scripts\commit.cmd or git pull first. & goto fail)

if exist "%ZIP%" (
  echo == 2/5 Already built: %ZIP%
) else (
  echo == 2/5 Tests
  call npm.cmd test || goto fail
  echo == 3/5 Building helper, app and ZIP. Close AMG rclone UI started from this folder first.
  call npm.cmd run release:stage || goto fail
  call npm.cmd run release:publish || goto fail
)
if not exist "%ZIP%" (echo The ZIP was not created. & goto fail)

echo == 4/5 Tag %TAG%
git rev-parse -q --verify "refs/tags/%TAG%" >nul || (git tag -a "%TAG%" -m "AMG rclone UI %VER%" || goto fail)
git push -q origin "%TAG%" || goto fail

echo == 5/5 GitHub Release
where gh >nul 2>nul || goto manual
gh auth status >nul 2>nul || (echo GitHub CLI is installed but not signed in. Run: gh auth login & goto manual)
gh release view "%TAG%" >nul 2>nul && (
  gh release upload "%TAG%" "%ZIP%" "%ZIP%.sha256" --clobber || goto fail
) || (
  gh release create "%TAG%" "%ZIP%" "%ZIP%.sha256" --title "AMG rclone UI %VER%" --notes-file "%NOTES%" || goto fail
)
echo.
echo Published: https://github.com/nieacry/AMGRCLONE/releases/tag/%TAG%
pause
exit /b 0

:manual
echo.
echo GitHub CLI (gh) is not available, so the last step is manual:
echo   1. The browser opens a new release for tag %TAG%.
echo   2. Title: AMG rclone UI %VER%
echo   3. Description: paste the text from Notepad (it opens with %NOTES%).
echo   4. Drag in the ZIP and its .sha256 from the Explorer window, then Publish release.
start "" "https://github.com/nieacry/AMGRCLONE/releases/new?tag=%TAG%"
start "" notepad "%NOTES%"
explorer /select,"%CD%\%ZIP%"
pause
exit /b 0

:fail
echo.
echo Stopped. Send a screenshot of this window to Claude.
pause
exit /b 1
