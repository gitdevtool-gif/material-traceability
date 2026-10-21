<#
  Busy Bridge (2026-10-17)

  Thin wrapper around Busy 21's own integration COM API
  (Busy2L21.CFixedInterface, installed + registered by the Busy client
  setup). Called by backend/src/services/busy-bridge.service.js — one
  request per process: JSON in on stdin, JSON out on stdout.

  Why COM and not SQL inserts: Busy allocates the voucher number
  (AutoVchNo / VchNo), VchCode, Tran3 pending-order RefCodes and the tax
  lines itself on save. The database has no unique constraint on the PO
  number, so writing the tables from outside would race Busy users for
  the same "Pur-NNNN". Going through Busy's own save engine removes that
  race and the number mismatch entirely.

  MUST run under 32-bit PowerShell (the Busy COM server is 32-bit VB6):
    %WINDIR%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe

  Request:
    { "action": "ping" | "addVch" | "getVchXml" | "deleteVch" | "checkUser",
      "busyUser", "busyPassword",                                   # checkUser
      "conn": { "busyPath", "server", "user", "password", "compCode", "fy" },
      "vchType": 13, "xml": "<PurchaseOrder>...</PurchaseOrder>",   # addVch
      "vchCode": 12345 }                                           # getVchXml / deleteVch
  Response:
    { "ok": true, ... } | { "ok": false, "error": "..." }
#>
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Out-Json($obj) {
  [Console]::Out.Write(($obj | ConvertTo-Json -Compress -Depth 5))
}

if ([IntPtr]::Size -ne 4) {
  Out-Json @{ ok = $false; error = 'busy-bridge.ps1 must run under 32-bit PowerShell (SysWOW64).' }
  exit 2
}

$fi = $null
try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $c = $req.conn

  try {
    $fi = New-Object -ComObject Busy2L21.CFixedInterface
  } catch {
    throw "Busy integration component (Busy2L21.CFixedInterface) is not installed on this machine. Install the Busy 21 client here. ($($_.Exception.Message))"
  }

  $opened = $fi.OpenCSDBForYear([string]$c.busyPath, [string]$c.server, [string]$c.user, [string]$c.password, [string]$c.compCode, [int16]$c.fy)
  if (-not $opened) {
    throw "Busy refused to open company '$($c.compCode)' FY $($c.fy) on '$($c.server)'. Check BUSY_COM_* settings."
  }

  switch ([string]$req.action) {
    'ping' {
      Out-Json @{ ok = $true; opened = $true }
    }
    'addVch' {
      $err = ''
      $modifyIfExist = $false
      $modifyKey = ''
      $vchCode = $fi.AddVchFromXML([int16]$req.vchType, [string]$req.xml, [ref]$err, [ref]$modifyIfExist, [ref]$modifyKey)
      if (-not $vchCode -or [int]$vchCode -le 0) {
        if (-not $err) { $err = 'Busy did not save the voucher and returned no reason.' }
        Out-Json @{ ok = $false; error = [string]$err }
      } else {
        $vchNo = [string]$fi.GetVchNoFromVchCode([int]$vchCode)
        Out-Json @{ ok = $true; vchCode = [int]$vchCode; vchNo = $vchNo.Trim(); warning = [string]$err }
      }
    }
    'getVchXml' {
      $partial = $false
      Out-Json @{ ok = $true; xml = [string]$fi.GetVchXML([int]$req.vchCode, [ref]$partial) }
    }
    'deleteVch' {
      $err = ''
      $deleted = $fi.DeleteVchByCode([int]$req.vchCode, [ref]$err)
      Out-Json @{ ok = [bool]$deleted; error = [string]$err }
    }
    'checkUser' {
      # Verifies a person's own Busy login (2026-10-19). Nothing is saved and
      # the password is never echoed back.
      $exists = [bool]$fi.UserNameExists([string]$req.busyUser)
      $valid = $false
      if ($exists) { $valid = [bool]$fi.ValidUserPassword([string]$req.busyUser, [string]$req.busyPassword) }
      Out-Json @{ ok = $true; exists = $exists; valid = $valid }
    }
    default {
      Out-Json @{ ok = $false; error = "Unknown action '$($req.action)'" }
    }
  }
} catch {
  Out-Json @{ ok = $false; error = $_.Exception.Message }
} finally {
  if ($fi) {
    try { $fi.CloseDB() } catch {}
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($fi)
  }
}
