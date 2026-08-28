@echo off
REM Double-click launcher (Windows).
REM Sets everything up on first run, then opens the Playwright GUI.
cd /d "%~dp0"

echo ============================================
echo   CivicChain screen-driver
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed. Grab the LTS installer from:
  echo     https://nodejs.org
  echo then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing Playwright ^(a minute or two^)...
  call npm install
)

echo Making sure the test browser is present...
call npx playwright install chromium

if not exist .env (
  copy .env.example .env >nul
  echo.
  echo ^>^> Created .env - open it and set BASE_URL to your site's address,
  echo    then run this again. ^(Right-click .env, Open With, Notepad.^)
  echo.
  pause
  exit /b 0
)

echo.
echo Opening the test runner. Click a test, watch it drive.
echo Close that window when you're done.
echo.
call npm run test:ui
