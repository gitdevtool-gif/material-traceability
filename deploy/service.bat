@echo off
REM ================================================================
REM  Service Management — Start / Stop / Restart / Status
REM  Usage: service.bat [start|stop|restart|status|logs]
REM  Manages both API and Frontend NSSM services.
REM  Run as Administrator.
REM ================================================================
setlocal

REM === AUTO-DETECT PATHS (script is in deploy\ folder) ===
set "NSSM_PATH=C:\FactoryTrack\API\nssm.exe"
set "SERVICE_API=FactoryTrack-MTS-API"
set "SERVICE_FRONTEND=FactoryTrack-MTS-Frontend"
pushd "%~dp0.."
set "DEPLOY_DIR=%CD%"
popd
set "LOG_DIR=%DEPLOY_DIR%\logs"
set "API_PORT=4008"
set "FRONTEND_PORT=3008"
set "SERVER_IP=192.168.1.9"

if "%~1"=="" goto usage

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Run as Administrator.
    pause
    exit /b 1
)

if /i "%~1"=="start" goto start
if /i "%~1"=="stop" goto stop
if /i "%~1"=="restart" goto restart
if /i "%~1"=="status" goto status
if /i "%~1"=="logs" goto logs
goto usage

:start
echo Starting services...
"%NSSM_PATH%" start %SERVICE_API%
"%NSSM_PATH%" start %SERVICE_FRONTEND%
timeout /t 3 /nobreak >nul
echo.
echo === Service Status ===
"%NSSM_PATH%" status %SERVICE_API%
"%NSSM_PATH%" status %SERVICE_FRONTEND%
echo.
echo Health checks:
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://%SERVER_IP%:%API_PORT%/api/health' -UseBasicParsing -TimeoutSec 10; Write-Host 'API:' $r.Content } catch { Write-Host 'API: may still be starting...' }"
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://%SERVER_IP%:%FRONTEND_PORT%/' -UseBasicParsing -TimeoutSec 10; Write-Host 'Frontend: Status' $r.StatusCode 'OK' } catch { Write-Host 'Frontend: may still be starting...' }"
goto end

:stop
echo Stopping services...
"%NSSM_PATH%" stop %SERVICE_API%
"%NSSM_PATH%" stop %SERVICE_FRONTEND%
timeout /t 2 /nobreak >nul
"%NSSM_PATH%" status %SERVICE_API%
"%NSSM_PATH%" status %SERVICE_FRONTEND%
goto end

:restart
echo Restarting services...
"%NSSM_PATH%" restart %SERVICE_API%
"%NSSM_PATH%" restart %SERVICE_FRONTEND%
timeout /t 4 /nobreak >nul
echo.
echo === Service Status ===
"%NSSM_PATH%" status %SERVICE_API%
"%NSSM_PATH%" status %SERVICE_FRONTEND%
echo.
echo Health checks:
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://%SERVER_IP%:%API_PORT%/api/health' -UseBasicParsing -TimeoutSec 10; Write-Host 'API:' $r.Content } catch { Write-Host 'API: may still be starting...' }"
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://%SERVER_IP%:%FRONTEND_PORT%/' -UseBasicParsing -TimeoutSec 10; Write-Host 'Frontend: Status' $r.StatusCode 'OK' } catch { Write-Host 'Frontend: may still be starting...' }"
goto end

:status
echo.
echo === Service Status ===
echo.
echo --- API Service (%SERVICE_API%) ---
"%NSSM_PATH%" status %SERVICE_API%
echo.
echo --- Frontend Service (%SERVICE_FRONTEND%) ---
"%NSSM_PATH%" status %SERVICE_FRONTEND%
echo.
echo === Process Info ===
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Format-Table Id,CPU,WorkingSet64,StartTime -AutoSize"
echo.
echo === Health Checks ===
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://%SERVER_IP%:%API_PORT%/api/health' -UseBasicParsing -TimeoutSec 5; Write-Host 'API     (%SERVER_IP%:%API_PORT%):' $r.Content } catch { Write-Host 'API: not responding' }"
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://%SERVER_IP%:%FRONTEND_PORT%/' -UseBasicParsing -TimeoutSec 5; Write-Host 'Frontend (%SERVER_IP%:%FRONTEND_PORT%): Status' $r.StatusCode 'OK' } catch { Write-Host 'Frontend: not responding' }"
goto end

:logs
echo Opening logs folder: %LOG_DIR%
explorer "%LOG_DIR%"
goto end

:usage
echo.
echo Usage: service.bat [command]
echo.
echo Commands:
echo   start     Start API and Frontend services
echo   stop      Stop API and Frontend services
echo   restart   Restart API and Frontend services
echo   status    Show service status and health
echo   logs      Open the logs folder
echo.
echo Endpoints:
echo   Backend  : http://%SERVER_IP%:%API_PORT%
echo   Frontend : http://%SERVER_IP%:%FRONTEND_PORT%
echo.

:end
endlocal
