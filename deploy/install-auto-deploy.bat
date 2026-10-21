@echo off
REM ================================================================
REM  INSTALL-AUTO-DEPLOY.BAT - Run ONCE on the PRODUCTION server
REM  Registers a scheduled task that checks GitHub every 5 minutes and
REM  deploys new commits on main (see auto-deploy.ps1).
REM  Nothing connects in to this server - it only calls out to GitHub.
REM  Run as Administrator.
REM
REM  Needs: Git and Node.js installed, NSSM at C:\FactoryTrack\API.
REM
REM  PRIVATE repo: create a fine-grained GitHub token (Settings ->
REM  Developer settings -> Fine-grained tokens) with "Contents: Read-only"
REM  on this one repo only, and save it as the single line of
REM     %~dp0.git-token
REM  This script locks that file down to SYSTEM + Administrators.
REM
REM  Remove later:  schtasks /delete /tn "MTS-AutoDeploy" /f
REM ================================================================
setlocal

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Run as Administrator.
    pause
    exit /b 1
)

set "TASK=MTS-AutoDeploy"
set "SCRIPT=%~dp0auto-deploy.ps1"

where git >nul 2>&1
if %errorlevel% neq 0 if not exist "C:\Program Files\Git\cmd\git.exe" (
    echo [ERROR] Git is not installed on this server. Install Git for Windows first.
    pause
    exit /b 1
)
if not exist "C:\Program Files\nodejs\node.exe" (
    echo [ERROR] Node.js not found at C:\Program Files\nodejs.
    pause
    exit /b 1
)
if not exist "C:\FactoryTrack\API\nssm.exe" (
    echo [ERROR] NSSM not found at C:\FactoryTrack\API\nssm.exe.
    pause
    exit /b 1
)

if exist "%~dp0.git-token" (
    icacls "%~dp0.git-token" /inheritance:r /grant:r "SYSTEM:R" "Administrators:F" >nul
    echo       GitHub token file found and locked down.
) else (
    echo       No .git-token file - OK only while the repository is public.
)

echo [1/2] Test run (dry run - changes nothing)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -DryRun
if %errorlevel% neq 0 (
    echo [ERROR] The dry run failed. See %~dp0..\logs\auto-deploy.log
    pause
    exit /b 1
)

echo [2/2] Registering scheduled task "%TASK%" (every 5 minutes, as SYSTEM)...
schtasks /create /tn "%TASK%" /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%SCRIPT%\"" /sc minute /mo 5 /ru SYSTEM /rl HIGHEST /f
if %errorlevel% neq 0 (
    echo [ERROR] Could not create the scheduled task.
    pause
    exit /b 1
)

echo.
echo Done. Every push to main is deployed within ~5 minutes.
echo   Log      : %~dp0..\logs\auto-deploy.log
echo   Run now  : schtasks /run /tn "%TASK%"
echo   Force    : powershell -ExecutionPolicy Bypass -File "%SCRIPT%" -Force
echo.
echo NOTE: SQL changes (the add-*.sql files) are NOT applied automatically -
echo run those in SSMS before pushing code that needs them.
pause
endlocal
