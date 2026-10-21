@echo off
REM ================================================================
REM  UPDATE.BAT — Run on PRODUCTION server for code updates
REM  Expects new release already copied to DEPLOY_DIR.
REM  Stops services, runs migrations, restarts services (API,
REM  Frontend, and the Cloudflare Tunnel), then health-checks both
REM  the LAN endpoints and the public tunnel URL.
REM  Frontend: 192.168.1.9:3008  |  Backend: 192.168.1.9:4008
REM  Public  : https://rfq.njorocanning.co.ke
REM  Run as Administrator.
REM ================================================================
setlocal enabledelayedexpansion

REM === AUTO-DETECT PATHS (script is in deploy\ folder) ===
set "NSSM_PATH=C:\FactoryTrack\API\nssm.exe"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"

pushd "%~dp0.."
set "DEPLOY_DIR=%CD%"
popd
set "BACKEND_DIR=%DEPLOY_DIR%\backend"
set "LOG_DIR=%DEPLOY_DIR%\logs"
set "LOG_ARCHIVE_DIR=%LOG_DIR%\archive"

set "SERVICE_API=FactoryTrack-MTS-API"
set "SERVICE_FRONTEND=FactoryTrack-MTS-Frontend"
set "SERVICE_TUNNEL=CloudflaredRFQ"
set "API_PORT=4008"
set "FRONTEND_PORT=3008"
set "SERVER_IP=192.168.1.9"
set "PUBLIC_URL=https://rfq.njorocanning.co.ke"

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Run as Administrator.
    pause
    exit /b 1
)

echo.
echo ==============================================================
echo   Material Traceability System — UPDATE (Production Server)
echo   Frontend: %SERVER_IP%:%FRONTEND_PORT%  Backend: %SERVER_IP%:%API_PORT%
echo   Public  : %PUBLIC_URL%
echo   %DATE% %TIME%
echo ==============================================================
echo.

REM === VERIFY RELEASE FILES ===
echo [1/5] Verifying release files...
if not exist "%BACKEND_DIR%\src\index.js" (
    echo [ERROR] Release files not found at %BACKEND_DIR%
    echo        Copy the new release\backend folder first.
    pause
    exit /b 1
)
echo       Release files present.
echo.

REM === STOP SERVICES ===
echo [2/5] Stopping services...
"%NSSM_PATH%" stop %SERVICE_API% >nul 2>&1
"%NSSM_PATH%" stop %SERVICE_FRONTEND% >nul 2>&1
sc.exe stop %SERVICE_TUNNEL% >nul 2>&1
timeout /t 3 /nobreak >nul
echo       Services stopped (API, Frontend, Cloudflare Tunnel).
echo.

REM === ARCHIVE OLD LOGS ===
REM NSSM appends to the same stdout/stderr files on every restart, so without
REM this step the view-logs script would show a mix of old and new output.
REM We move (not delete) the old logs into a timestamped archive folder, then
REM let NSSM create fresh empty log files when the services start back up.
echo [3/6] Archiving previous logs...
if not exist "%LOG_ARCHIVE_DIR%" mkdir "%LOG_ARCHIVE_DIR%" >nul 2>&1

REM Build a sortable timestamp (yyyy-MM-dd_HH-mm-ss) that works regardless of locale
for /f "usebackq delims=" %%T in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'"`) do set "TS=%%T"

for %%F in (api-stdout.log api-stderr.log frontend-stdout.log frontend-stderr.log) do (
    if exist "%LOG_DIR%\%%F" (
        move /y "%LOG_DIR%\%%F" "%LOG_ARCHIVE_DIR%\%%~nF_%TS%%%~xF" >nul 2>&1
    )
)
echo       Old logs moved to %LOG_ARCHIVE_DIR%
echo.

REM === RUN MIGRATIONS ===
echo [4/6] Running database migrations...
pushd "%BACKEND_DIR%"
"%NODE_EXE%" src/db/migrate.js >"%LOG_DIR%\migration.log" 2>&1
if %errorlevel% neq 0 (
    echo [WARN] Migration may have failed. Check %LOG_DIR%\migration.log
) else (
    echo       Migrations applied.
)
popd
echo.

REM === RESTART SERVICES ===
echo [5/6] Starting services...
"%NSSM_PATH%" start %SERVICE_API% >nul 2>&1
"%NSSM_PATH%" start %SERVICE_FRONTEND% >nul 2>&1
timeout /t 5 /nobreak >nul

"%NSSM_PATH%" status %SERVICE_API% 2>nul | findstr /i "SERVICE_RUNNING" >nul
if %errorlevel% equ 0 (
    echo       API service is RUNNING.
) else (
    echo [WARN] API service may not have started. Check logs.
)

"%NSSM_PATH%" status %SERVICE_FRONTEND% 2>nul | findstr /i "SERVICE_RUNNING" >nul
if %errorlevel% equ 0 (
    echo       Frontend service is RUNNING.
) else (
    echo [WARN] Frontend service may not have started. Check logs.
)

REM Start the Cloudflare Tunnel AFTER the API is confirmed up, so it isn't
REM forwarding traffic to a not-yet-ready origin.
sc.exe start %SERVICE_TUNNEL% >nul 2>&1
timeout /t 4 /nobreak >nul

sc.exe query %SERVICE_TUNNEL% | findstr /i "RUNNING" >nul
if %errorlevel% equ 0 (
    echo       Cloudflare Tunnel (%SERVICE_TUNNEL%) is RUNNING.
) else (
    echo [WARN] Cloudflare Tunnel may not have started. Check: sc.exe query %SERVICE_TUNNEL%
)
echo.

REM === HEALTH CHECKS ===
echo [6/6] Health checks:
timeout /t 2 /nobreak >nul
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://%SERVER_IP%:%API_PORT%/api/health' -UseBasicParsing -TimeoutSec 10; Write-Host '  API (LAN)      :' $r.Content } catch { Write-Host '  API (LAN)      : may still be starting...' }"
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://%SERVER_IP%:%FRONTEND_PORT%/' -UseBasicParsing -TimeoutSec 10; Write-Host '  Frontend (LAN) : Status' $r.StatusCode 'OK' } catch { Write-Host '  Frontend (LAN) : may still be starting...' }"
powershell -Command "try { $r = Invoke-WebRequest -Uri '%PUBLIC_URL%/api/health' -UseBasicParsing -TimeoutSec 15; Write-Host '  API (Public)   :' $r.Content } catch { Write-Host '  API (Public)   : tunnel may still be starting, or DNS/propagation delay...' }"
echo.
echo === Update complete ===
echo   Backend  (LAN)    : http://%SERVER_IP%:%API_PORT%
echo   Frontend (LAN)    : http://%SERVER_IP%:%FRONTEND_PORT%
echo   Public (Tunnel)   : %PUBLIC_URL%
echo.
echo   NOTE: If you deployed a frontend change, remember to purge the
echo   Cloudflare cache (dashboard -^> Caching -^> Purge Everything) —
echo   static assets are cached 7 days at the edge and won't refresh
echo   for visitors until purged.
echo.

pause
endlocal