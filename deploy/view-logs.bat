@echo off
REM ================================================================
REM  View Service Logs — Tail the API and Frontend stdout/stderr logs
REM ================================================================
setlocal

pushd "%~dp0.."
set "DEPLOY_DIR=%CD%"
popd
set "LOG_DIR=%DEPLOY_DIR%\logs"

echo.
echo === API stdout (last 50 lines) ===
echo.
powershell -Command "if (Test-Path '%LOG_DIR%\api-stdout.log') { Get-Content '%LOG_DIR%\api-stdout.log' -Tail 50 } else { Write-Host 'No stdout log found.' }"

echo.
echo === API stderr (last 30 lines) ===
echo.
powershell -Command "if (Test-Path '%LOG_DIR%\api-stderr.log') { Get-Content '%LOG_DIR%\api-stderr.log' -Tail 30 } else { Write-Host 'No stderr log found.' }"

echo.
echo === Frontend stdout (last 50 lines) ===
echo.
powershell -Command "if (Test-Path '%LOG_DIR%\frontend-stdout.log') { Get-Content '%LOG_DIR%\frontend-stdout.log' -Tail 50 } else { Write-Host 'No stdout log found.' }"

echo.
echo === Frontend stderr (last 30 lines) ===
echo.
powershell -Command "if (Test-Path '%LOG_DIR%\frontend-stderr.log') { Get-Content '%LOG_DIR%\frontend-stderr.log' -Tail 30 } else { Write-Host 'No stderr log found.' }"

echo.
pause
endlocal
