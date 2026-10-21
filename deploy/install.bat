@echo off
REM ================================================================
REM  INSTALL.BAT — Run on PRODUCTION server (first-time setup)
REM  Expects the release folder already copied to DEPLOY_DIR.
REM  Installs NSSM services, runs migrations, starts everything.
REM  Frontend: 192.168.1.9:3008  |  Backend: 192.168.1.9:4008
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

set "SERVICE_API=FactoryTrack-MTS-API"
set "SERVICE_FRONTEND=FactoryTrack-MTS-Frontend"
set "API_PORT=4008"
set "FRONTEND_PORT=3008"
set "SERVER_IP=192.168.1.9"

echo.
echo ==============================================================
echo   Material Traceability System — INSTALL (Production Server)
echo   Frontend : %SERVER_IP%:%FRONTEND_PORT%
echo   Backend  : %SERVER_IP%:%API_PORT%
echo   %DATE% %TIME%
echo ==============================================================
echo.

REM === CHECK ADMIN ===
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] This script must be run as Administrator.
    echo         Right-click and select "Run as administrator"
    pause
    exit /b 1
)

REM === CHECK PREREQUISITES ===
echo [1/6] Checking prerequisites...

if not exist "%NSSM_PATH%" (
    echo [ERROR] NSSM not found at: %NSSM_PATH%
    pause
    exit /b 1
)
echo        NSSM ............. OK

if not exist "%NODE_EXE%" (
    echo [ERROR] Node.js not found at: %NODE_EXE%
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('"%NODE_EXE%" --version') do echo        Node.js .......... %%v

if not exist "%BACKEND_DIR%\src\index.js" (
    echo [ERROR] Release files not found at %BACKEND_DIR%
    echo        Copy the release\backend folder to %BACKEND_DIR% first.
    pause
    exit /b 1
)
echo        Release files .... OK
echo.

REM === CREATE LOGS DIRECTORY ===
echo [2/7] Creating directories...
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
echo        %LOG_DIR%
echo.

REM === OPEN FIREWALL PORTS ===
echo [3/7] Configuring firewall rules...
netsh advfirewall firewall show rule name="MTS Frontend (%FRONTEND_PORT%)" >nul 2>&1
if %errorlevel% neq 0 (
    netsh advfirewall firewall add rule name="MTS Frontend (%FRONTEND_PORT%)" dir=in action=allow protocol=tcp localport=%FRONTEND_PORT% >nul
    echo        Firewall rule added: port %FRONTEND_PORT%
) else (
    echo        Firewall rule exists: port %FRONTEND_PORT%
)
netsh advfirewall firewall show rule name="MTS Backend API (%API_PORT%)" >nul 2>&1
if %errorlevel% neq 0 (
    netsh advfirewall firewall add rule name="MTS Backend API (%API_PORT%)" dir=in action=allow protocol=tcp localport=%API_PORT% >nul
    echo        Firewall rule added: port %API_PORT%
) else (
    echo        Firewall rule exists: port %API_PORT%
)
echo.

REM === CONFIGURE .ENV FOR PRODUCTION ===
echo [4/7] Configuring production environment...
pushd "%BACKEND_DIR%"

REM Ensure NODE_ENV=production
findstr /c:"NODE_ENV=production" .env >nul 2>&1
if %errorlevel% neq 0 (
    powershell -Command "(Get-Content '.env') -replace 'NODE_ENV=development','NODE_ENV=production' | Set-Content '.env'"
    echo        NODE_ENV set to production.
) else (
    echo        NODE_ENV already production.
)
popd
echo.

REM === RUN DATABASE MIGRATIONS ===
echo [5/7] Running database migrations...
pushd "%BACKEND_DIR%"
"%NODE_EXE%" src/db/migrate.js >"%LOG_DIR%\migration.log" 2>&1
if %errorlevel% neq 0 (
    echo [WARN] Migration may have failed. Check %LOG_DIR%\migration.log
) else (
    echo        Migrations applied successfully.
)
popd
echo.

REM === INSTALL NSSM SERVICES ===
echo [6/7] Installing NSSM services...

REM --- API Service ---
echo        Installing API service "%SERVICE_API%" (port %API_PORT%)...
"%NSSM_PATH%" status %SERVICE_API% >nul 2>&1
if %errorlevel% equ 0 (
    "%NSSM_PATH%" stop %SERVICE_API% >nul 2>&1
    timeout /t 2 /nobreak >nul
    "%NSSM_PATH%" set %SERVICE_API% Application "%NODE_EXE%" >nul
    "%NSSM_PATH%" set %SERVICE_API% AppParameters "src\index.js" >nul
    "%NSSM_PATH%" set %SERVICE_API% AppDirectory "%BACKEND_DIR%" >nul
) else (
    "%NSSM_PATH%" install %SERVICE_API% "%NODE_EXE%" "src\index.js" >nul
    "%NSSM_PATH%" set %SERVICE_API% AppDirectory "%BACKEND_DIR%" >nul
)

"%NSSM_PATH%" set %SERVICE_API% DisplayName "Material Traceability System API" >nul
"%NSSM_PATH%" set %SERVICE_API% Description "Njoro Canning Factory - Material Traceability REST API (Port %API_PORT%)" >nul
"%NSSM_PATH%" set %SERVICE_API% Start SERVICE_AUTO_START >nul
"%NSSM_PATH%" set %SERVICE_API% AppStdout "%LOG_DIR%\api-stdout.log" >nul
"%NSSM_PATH%" set %SERVICE_API% AppStderr "%LOG_DIR%\api-stderr.log" >nul
"%NSSM_PATH%" set %SERVICE_API% AppStdoutCreationDisposition 4 >nul
"%NSSM_PATH%" set %SERVICE_API% AppStderrCreationDisposition 4 >nul
"%NSSM_PATH%" set %SERVICE_API% AppRotateFiles 1 >nul
"%NSSM_PATH%" set %SERVICE_API% AppRotateBytes 5242880 >nul
"%NSSM_PATH%" set %SERVICE_API% AppExit Default Restart >nul
"%NSSM_PATH%" set %SERVICE_API% AppRestartDelay 5000 >nul
"%NSSM_PATH%" set %SERVICE_API% AppEnvironmentExtra "NODE_ENV=production" >nul
"%NSSM_PATH%" set %SERVICE_API% AppStopMethodSkip 0 >nul
"%NSSM_PATH%" set %SERVICE_API% AppStopMethodConsole 5000 >nul
"%NSSM_PATH%" set %SERVICE_API% AppStopMethodWindow 5000 >nul
"%NSSM_PATH%" set %SERVICE_API% AppStopMethodThreads 5000 >nul
echo        API service configured.

REM --- Frontend Service ---
echo        Installing Frontend service "%SERVICE_FRONTEND%" (port %FRONTEND_PORT%)...
"%NSSM_PATH%" status %SERVICE_FRONTEND% >nul 2>&1
if %errorlevel% equ 0 (
    "%NSSM_PATH%" stop %SERVICE_FRONTEND% >nul 2>&1
    timeout /t 2 /nobreak >nul
    "%NSSM_PATH%" set %SERVICE_FRONTEND% Application "%NODE_EXE%" >nul
    "%NSSM_PATH%" set %SERVICE_FRONTEND% AppParameters "src\frontend-server.js" >nul
    "%NSSM_PATH%" set %SERVICE_FRONTEND% AppDirectory "%BACKEND_DIR%" >nul
) else (
    "%NSSM_PATH%" install %SERVICE_FRONTEND% "%NODE_EXE%" "src\frontend-server.js" >nul
    "%NSSM_PATH%" set %SERVICE_FRONTEND% AppDirectory "%BACKEND_DIR%" >nul
)

"%NSSM_PATH%" set %SERVICE_FRONTEND% DisplayName "Material Traceability System Frontend" >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% Description "Njoro Canning Factory - Material Traceability Frontend (Port %FRONTEND_PORT%)" >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% Start SERVICE_AUTO_START >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% AppStdout "%LOG_DIR%\frontend-stdout.log" >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% AppStderr "%LOG_DIR%\frontend-stderr.log" >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% AppStdoutCreationDisposition 4 >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% AppStderrCreationDisposition 4 >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% AppRotateFiles 1 >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% AppRotateBytes 5242880 >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% AppExit Default Restart >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% AppRestartDelay 5000 >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% AppEnvironmentExtra "NODE_ENV=production" "FRONTEND_PORT=%FRONTEND_PORT%" >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% AppStopMethodSkip 0 >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% AppStopMethodConsole 5000 >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% AppStopMethodWindow 5000 >nul
"%NSSM_PATH%" set %SERVICE_FRONTEND% AppStopMethodThreads 5000 >nul
echo        Frontend service configured.
echo.

REM === START SERVICES ===
echo [7/7] Starting services...
"%NSSM_PATH%" start %SERVICE_API% >nul 2>&1
"%NSSM_PATH%" start %SERVICE_FRONTEND% >nul 2>&1
timeout /t 5 /nobreak >nul

"%NSSM_PATH%" status %SERVICE_API% 2>nul | findstr /i "SERVICE_RUNNING" >nul
if %errorlevel% equ 0 (
    echo        API service is RUNNING.
) else (
    echo [WARN] API service may not have started. Check %LOG_DIR%\api-stderr.log
)

"%NSSM_PATH%" status %SERVICE_FRONTEND% 2>nul | findstr /i "SERVICE_RUNNING" >nul
if %errorlevel% equ 0 (
    echo        Frontend service is RUNNING.
) else (
    echo [WARN] Frontend service may not have started. Check %LOG_DIR%\frontend-stderr.log
)
echo.

REM === HEALTH CHECK ===
echo Performing health checks...
timeout /t 3 /nobreak >nul
echo.
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://%SERVER_IP%:%API_PORT%/api/health' -UseBasicParsing -TimeoutSec 10; Write-Host '  API     :' $r.Content } catch { Write-Host '  API     : may still be starting...' }"
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://%SERVER_IP%:%FRONTEND_PORT%/' -UseBasicParsing -TimeoutSec 10; Write-Host '  Frontend: Status' $r.StatusCode 'OK' } catch { Write-Host '  Frontend: may still be starting...' }"
echo.

echo ==============================================================
echo   INSTALLATION COMPLETE
echo ==============================================================
echo.
echo   Backend Service  : %SERVICE_API%
echo   Backend URL      : http://%SERVER_IP%:%API_PORT%
echo   Frontend Service : %SERVICE_FRONTEND%
echo   Frontend URL     : http://%SERVER_IP%:%FRONTEND_PORT%
echo   Deploy Dir       : %DEPLOY_DIR%
echo   Logs Dir         : %LOG_DIR%
echo.
echo   Manage with:
echo     service.bat start / stop / restart / status
echo     view-logs.bat
echo.
echo ==============================================================

pause
endlocal
