@echo off
REM ================================================================
REM  BUILD.BAT — Run on DEV machine
REM  Builds React frontend, assembles a complete release folder
REM  ready to copy to the production server.
REM  Frontend + API are served from the SAME Express origin in
REM  production (see backend/src/index.js: express.static + catch-all),
REM  so the API URL is now RELATIVE ("/api") instead of a hardcoded
REM  LAN IP. This means the same build works correctly whether it's
REM  reached via LAN (192.168.1.9:4008), the Cloudflare tunnel
REM  (https://rfq.njorocanning.co.ke), or any future domain — no
REM  rebuild needed when the access URL changes.
REM ================================================================
setlocal enabledelayedexpansion

REM === CONFIGURATION ===
set "API_PORT=4008"
set "FRONTEND_PORT=3008"
set "SERVER_IP=192.168.1.9"

set "SOURCE_DIR=%~dp0.."
set "RELEASE_DIR=%SOURCE_DIR%\release"
set "RELEASE_BACKEND=%RELEASE_DIR%\backend"
set "RELEASE_DEPLOY=%RELEASE_DIR%\deploy"

echo.
echo ==============================================================
echo   Material Traceability System — BUILD (Dev Machine)
echo   Target: Frontend %SERVER_IP%:%FRONTEND_PORT%  API %SERVER_IP%:%API_PORT%
echo   %DATE% %TIME%
echo ==============================================================
echo.

REM === CHECK NODE/NPM ===
echo [1/6] Checking prerequisites...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found in PATH.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo        Node.js .......... %%v
for /f "tokens=*" %%v in ('npm --version') do echo        npm .............. %%v
echo.

REM === CLEAN PREVIOUS RELEASE ===
echo [2/6] Cleaning previous release folder...
if exist "%RELEASE_DIR%" rmdir /s /q "%RELEASE_DIR%"
mkdir "%RELEASE_DIR%"
mkdir "%RELEASE_BACKEND%"
mkdir "%RELEASE_DEPLOY%"
echo        %RELEASE_DIR% created.
echo.

REM === BUILD FRONTEND ===
echo [3/6] Building React frontend (production)...
pushd "%SOURCE_DIR%\frontend"

echo        Installing frontend dependencies...
call npm install --legacy-peer-deps >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Frontend npm install failed.
    popd
    pause
    exit /b 1
)

echo        Running production build...
set "GENERATE_SOURCEMAP=false"
REM RELATIVE API URL — works on LAN, via the Cloudflare tunnel, or any
REM domain, since the browser resolves "/api" against whatever origin
REM served the page. Do NOT hardcode SERVER_IP here anymore.
set "REACT_APP_API_URL=/api"
REM Skip CRA's ESLint pass during build — a peer-version mismatch from
REM --legacy-peer-deps currently makes react-hooks/exhaustive-deps
REM unresolvable ("Definition for rule ... was not found"), which CRA
REM treats as a hard build failure rather than a warning. This only
REM disables the lint check for this build; transpilation/bundling are
REM unaffected. Remove this line once the plugin version conflict in
REM frontend/node_modules is resolved (see: npm ls eslint-plugin-react-hooks).
set "DISABLE_ESLINT_PLUGIN=true"
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Frontend build failed. See output above.
    popd
    pause
    exit /b 1
)
popd
echo        Frontend built (API URL: /api — relative to serving origin).
echo.

REM === COPY BACKEND SOURCE ===
echo [4/6] Assembling backend...
robocopy "%SOURCE_DIR%\backend\src" "%RELEASE_BACKEND%\src" /MIR /NFL /NDL /NJH /NJS >nul
copy /y "%SOURCE_DIR%\backend\package.json" "%RELEASE_BACKEND%\package.json" >nul
if exist "%SOURCE_DIR%\backend\package-lock.json" copy /y "%SOURCE_DIR%\backend\package-lock.json" "%RELEASE_BACKEND%\package-lock.json" >nul

REM Copy frontend build into backend/public
robocopy "%SOURCE_DIR%\frontend\build" "%RELEASE_BACKEND%\public" /MIR /NFL /NDL /NJH /NJS >nul

REM Copy production .env template
copy /y "%SOURCE_DIR%\deploy\.env.production" "%RELEASE_BACKEND%\.env" >nul

echo        Backend + frontend static files assembled.
echo.

REM === INSTALL PRODUCTION DEPENDENCIES ===
echo [5/6] Installing production dependencies...
pushd "%RELEASE_BACKEND%"
call npm install --omit=dev >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Backend npm install failed.
    popd
    pause
    exit /b 1
)
popd
echo        node_modules ready (production only).
echo.

REM === COPY DEPLOY SCRIPTS ===
echo [6/6] Copying deployment scripts...
copy /y "%SOURCE_DIR%\deploy\install.bat" "%RELEASE_DEPLOY%\install.bat" >nul
copy /y "%SOURCE_DIR%\deploy\update.bat" "%RELEASE_DEPLOY%\update.bat" >nul
copy /y "%SOURCE_DIR%\deploy\service.bat" "%RELEASE_DEPLOY%\service.bat" >nul
copy /y "%SOURCE_DIR%\deploy\uninstall.bat" "%RELEASE_DEPLOY%\uninstall.bat" >nul
copy /y "%SOURCE_DIR%\deploy\view-logs.bat" "%RELEASE_DEPLOY%\view-logs.bat" >nul
echo        Scripts copied.
echo.

echo ==============================================================
echo   BUILD COMPLETE
echo ==============================================================
echo.
echo   Release folder : %RELEASE_DIR%
echo     backend\       — API source + node_modules + .env
echo     backend\public — React production build (relative /api URL)
echo     deploy\        — Server install/update/service scripts
echo.
echo   NEXT STEPS:
echo   1. Copy the entire "release" folder to the production server
echo      at C:\FactoryTrack\MaterialTraceability
echo   2. On the server, run: deploy\install.bat  (first time)
echo      or:                  deploy\update.bat   (code updates)
echo   3. If serving via Cloudflare Tunnel, purge the Cloudflare
echo      cache (dashboard -^> Caching -^> Purge Everything) after
echo      every deploy, since static assets are cached 7 days.
echo.
echo ==============================================================

pause
endlocal