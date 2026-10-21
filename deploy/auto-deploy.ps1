<#
  AUTO-DEPLOY (production server)

  Run every few minutes by the "MTS-AutoDeploy" scheduled task (see
  install-auto-deploy.bat). Nothing connects IN to the server: it only
  asks GitHub whether `main` has a newer commit, and if so builds and
  deploys it:

    fetch -> build frontend -> back up live code -> stop services ->
    mirror backend\src, backend\public, backend\busy-bridge -> npm install
    (only when package-lock changed) -> migrate -> start services ->
    health check -> (on failure) roll back to the backup.

  Never touched: backend\.env, node_modules (unless dependencies changed),
  logs. A commit that fails to deploy is remembered and not retried until a
  newer commit arrives.

  Needs on the server: Git, Node.js 18+, NSSM at C:\FactoryTrack\API.
  Private repo: put a read-only GitHub token in deploy\.git-token
  (install-auto-deploy.bat explains how).

  Manual run:   powershell -ExecutionPolicy Bypass -File auto-deploy.ps1 [-DryRun] [-Force]
#>
param(
  [string]$RepoUrl = 'https://github.com/gitdevtool-gif/material-traceability.git',
  [string]$Branch = 'main',
  [string]$LiveDir = (Split-Path -Parent $PSScriptRoot),
  [string]$SrcDir = 'C:\FactoryTrack\MaterialTraceability-src',
  [string]$Nssm = 'C:\FactoryTrack\API\nssm.exe',
  [string]$Node = 'C:\Program Files\nodejs\node.exe',
  [string]$HealthUrl = 'http://localhost:4008/api/health',
  [string[]]$Services = @('FactoryTrack-MTS-API', 'FactoryTrack-MTS-Frontend'),
  [switch]$DryRun,       # report what would be deployed, change nothing
  [switch]$Force,        # deploy even if this commit is already live / previously failed
  [switch]$SkipServices, # testing only: don't stop/start Windows services
  [switch]$SkipHealth    # testing only: treat the deploy as healthy without checking
)

$ErrorActionPreference = 'Stop'
$env:Path += ';C:\Program Files\nodejs;C:\Program Files\Git\cmd'
$logDir = Join-Path $LiveDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'auto-deploy.log'
if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 5MB) { Move-Item $logFile "$logFile.old" -Force }

function Log([string]$m) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $logFile -Value $line
  Write-Host $line
}

# Runs a native command; stderr is not treated as an error, only the exit code.
function Run([string]$Exe, [string[]]$ArgList, [string]$Dir) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  if ($Dir) { Push-Location $Dir }
  try { $out = & $Exe @ArgList 2>&1 | ForEach-Object { "$_" }; $code = $LASTEXITCODE }
  finally { if ($Dir) { Pop-Location }; $ErrorActionPreference = $old }
  if ($code -ne 0) { throw "$Exe $($ArgList -join ' ') failed ($code): $(($out | Select-Object -Last 15) -join ' | ')" }
  return $out
}

# robocopy: 0-7 = success
function Mirror([string]$From, [string]$To) {
  if (-not (Test-Path $From)) { return }
  & robocopy $From $To /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $From -> $To failed ($LASTEXITCODE)" }
}

function Hash([string]$Path) { if (Test-Path $Path) { (Get-FileHash $Path -Algorithm SHA256).Hash } else { '' } }

function SetServices([string]$Action) {
  if ($SkipServices) { return }
  foreach ($s in $Services) { & $Nssm $Action $s 2>&1 | Out-Null }
  if ($Action -eq 'stop') { Start-Sleep -Seconds 3 }
}

function WaitHealthy {
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 3
    try { if ((Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) { return $true } } catch { }
  }
  return $false
}

$mutex = New-Object System.Threading.Mutex($false, 'Global\MTS-AutoDeploy')
if (-not $mutex.WaitOne(0)) { exit 0 }   # another run is in progress

try {
  # Private repo: send the token in a header so it is never stored in the clone's config.
  $gitAuth = @()
  $tokenFile = Join-Path $PSScriptRoot '.git-token'
  if (Test-Path $tokenFile) {
    $token = (Get-Content $tokenFile -Raw).Trim()
    $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$token"))
    $gitAuth = @('-c', "http.extraheader=AUTHORIZATION: basic $b64")
  }

  if (-not (Test-Path (Join-Path $SrcDir '.git'))) {
    Log "Cloning $RepoUrl into $SrcDir"
    Run 'git' ($gitAuth + @('clone', '--branch', $Branch, $RepoUrl, $SrcDir)) | Out-Null
  }
  Run 'git' ($gitAuth + @('fetch', 'origin', $Branch, '--prune')) $SrcDir | Out-Null
  $remote = (Run 'git' @('rev-parse', "origin/$Branch") $SrcDir | Select-Object -First 1).Trim()

  $deployedFile = Join-Path $LiveDir '.deployed-commit'
  $failedFile = Join-Path $LiveDir '.deploy-failed-commit'
  $deployed = if (Test-Path $deployedFile) { (Get-Content $deployedFile -Raw).Trim() } else { '' }
  $failed = if (Test-Path $failedFile) { (Get-Content $failedFile -Raw).Trim() } else { '' }

  if (-not $Force) {
    if ($remote -eq $deployed) { exit 0 }
    if ($remote -eq $failed) { exit 0 }
  }
  if ($DryRun) { Log "DRY RUN: would deploy $remote (live: $(if ($deployed) { $deployed } else { 'unknown' }))"; exit 0 }

  Log "Deploying $remote (was: $(if ($deployed) { $deployed } else { 'unknown' }))"
  Run 'git' @('reset', '--hard', "origin/$Branch") $SrcDir | Out-Null
  Run 'git' @('clean', '-fd', '-e', 'node_modules') $SrcDir | Out-Null

  # ---- build the frontend (relative /api URL, same as build.bat) ----
  $feDir = Join-Path $SrcDir 'frontend'
  $feHashFile = Join-Path $SrcDir '.frontend-lock-hash'
  $feHash = Hash (Join-Path $feDir 'package-lock.json')
  if (-not (Test-Path (Join-Path $feDir 'node_modules')) -or $feHash -ne $(if (Test-Path $feHashFile) { (Get-Content $feHashFile -Raw).Trim() } else { '' })) {
    Log 'Installing frontend dependencies...'
    Run 'npm.cmd' @('install', '--legacy-peer-deps', '--no-audit', '--no-fund') $feDir | Out-Null
    Set-Content $feHashFile $feHash
  }
  Log 'Building frontend...'
  $env:REACT_APP_API_URL = '/api'; $env:GENERATE_SOURCEMAP = 'false'; $env:CI = 'false'
  Run 'npm.cmd' @('run', 'build') $feDir | Out-Null

  # ---- back up what is live, for rollback ----
  $liveBackend = Join-Path $LiveDir 'backend'
  $backupRoot = Join-Path $LiveDir 'backups'
  $backup = Join-Path $backupRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
  foreach ($d in 'src', 'public', 'busy-bridge') { Mirror (Join-Path $liveBackend $d) (Join-Path $backup $d) }
  foreach ($f in 'package.json', 'package-lock.json') {
    if (Test-Path (Join-Path $liveBackend $f)) { Copy-Item (Join-Path $liveBackend $f) $backup -Force }
  }
  Get-ChildItem $backupRoot -Directory | Sort-Object Name -Descending | Select-Object -Skip 3 | Remove-Item -Recurse -Force

  # ---- swap in the new version ----
  SetServices 'stop'
  $healthy = $false
  try {
    Mirror (Join-Path $SrcDir 'backend\src') (Join-Path $liveBackend 'src')
    Mirror (Join-Path $feDir 'build') (Join-Path $liveBackend 'public')
    Mirror (Join-Path $SrcDir 'backend\busy-bridge') (Join-Path $liveBackend 'busy-bridge')
    foreach ($f in 'package.json', 'package-lock.json') {
      if (Test-Path (Join-Path $SrcDir "backend\$f")) { Copy-Item (Join-Path $SrcDir "backend\$f") $liveBackend -Force }
    }

    $beHashFile = Join-Path $LiveDir '.backend-lock-hash'
    $beHash = Hash (Join-Path $liveBackend 'package-lock.json')
    $oldBeHash = if (Test-Path $beHashFile) { (Get-Content $beHashFile -Raw).Trim() } else { '' }
    if (-not (Test-Path (Join-Path $liveBackend 'node_modules')) -or $beHash -ne $oldBeHash) {
      Log 'Installing backend dependencies...'
      Run 'npm.cmd' @('install', '--omit=dev', '--no-audit', '--no-fund') $liveBackend | Out-Null
      Set-Content $beHashFile $beHash
    }

    try { Run $Node @('src/db/migrate.js') $liveBackend | Out-Null; Log 'Migrations applied.' }
    catch { Log "WARNING: migration step failed: $($_.Exception.Message)" }

    SetServices 'start'
    $healthy = if ($SkipHealth) { $true } else { WaitHealthy }
  } catch {
    Log "ERROR during deploy: $($_.Exception.Message)"
  }

  if (-not $healthy) {
    Log 'Health check FAILED - rolling back to the previous version.'
    SetServices 'stop'
    foreach ($d in 'src', 'public', 'busy-bridge') { Mirror (Join-Path $backup $d) (Join-Path $liveBackend $d) }
    foreach ($f in 'package.json', 'package-lock.json') {
      if (Test-Path (Join-Path $backup $f)) { Copy-Item (Join-Path $backup $f) $liveBackend -Force }
    }
    SetServices 'start'
    Set-Content $failedFile $remote
    Log "Rolled back. Commit $remote will not be retried until a newer commit is pushed."
    exit 1
  }

  Set-Content $deployedFile $remote
  Remove-Item $failedFile -Force -ErrorAction SilentlyContinue
  # Deployment scripts last, so this script is never overwritten while it is still running.
  Get-ChildItem (Join-Path $SrcDir 'deploy') -Include *.bat, *.ps1 -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item $_.FullName (Join-Path $PSScriptRoot $_.Name) -Force -ErrorAction SilentlyContinue }
  Log "Deployed $remote OK."
}
catch {
  Log "FATAL: $($_.Exception.Message)"
  exit 1
}
finally {
  $mutex.ReleaseMutex()
}
