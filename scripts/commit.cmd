@echo off
rem Commits and pushes a change prepared by Claude.
rem The message is in .runtime\commit-message.txt (outside git); it is deleted after a successful push.
setlocal
cd /d "%~dp0.."
set MSG=.runtime\commit-message.txt
set UNTRACK=.runtime\untrack.txt
if not exist "%MSG%" (echo Nothing prepared: %MSG% is missing. & goto fail)

echo == Commit message:
type "%MSG%"
echo.

rem Files that .gitignore now excludes stop being tracked; they stay on disk.
git ls-files -ci --exclude-standard -z > "%UNTRACK%"
for %%A in ("%UNTRACK%") do if %%~zA GTR 0 git rm -r -q --cached --pathspec-from-file="%UNTRACK%" --pathspec-file-nul
del "%UNTRACK%"

git -c core.safecrlf=false add -A
echo == Changes:
git status --short
git -c core.safecrlf=false commit -q -F "%MSG%" || goto fail
git push || goto fail
del "%MSG%"
echo.
git log --oneline -3
echo.
echo Done.
pause
exit /b 0

:fail
echo.
echo Stopped. Send a screenshot of this window to Claude.
pause
exit /b 1
