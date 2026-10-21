@echo off
REM ================================================================
REM  Uninstall NSSM Services — Removes both API and Frontend services
REM  Run as Administrator. Does NOT delete deployment files.
REM ================================================================
setlocal

set "NSSM_PATH=C:\FactoryTrack\API\nssm.exe"
set "SERVICE_API=FactoryTrack-MTS-API"
set "SERVICE_FRONTEND=FactoryTrack-MTS-Frontend"
pushd "%~dp0.."
set "DEPLOY_DIR=%CD%"
popd

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Run as Administrator.
    pause
    exit /b 1
)

echo Stopping services...
"%NSSM_PATH%" stop %SERVICE_API% >nul 2>&1
"%NSSM_PATH%" stop %SERVICE_FRONTEND% >nul 2>&1
timeout /t 3 /nobreak >nul

echo Removing API service...
"%NSSM_PATH%" remove %SERVICE_API% confirm
echo Removing Frontend service...
"%NSSM_PATH%" remove %SERVICE_FRONTEND% confirm
echo.
echo Services "%SERVICE_API%" and "%SERVICE_FRONTEND%" removed.
echo Deployment files remain at %DEPLOY_DIR%
echo.

pause
endlocal
