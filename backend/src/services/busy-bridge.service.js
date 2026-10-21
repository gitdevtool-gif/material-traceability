/**
 * Busy Bridge Service (2026-10-17)
 *
 * Runs backend/busy-bridge/busy-bridge.ps1 under 32-bit PowerShell to
 * talk to Busy's own COM API (Busy2L21.CFixedInterface). Node can't load
 * the 32-bit VB6 COM server itself, so each call is one short-lived
 * PowerShell process: JSON request on stdin, JSON response on stdout.
 *
 * Calls are serialized — Busy's COM session is single-threaded and two
 * concurrent saves from this API would gain nothing.
 */
const { spawn } = require('child_process');
const path = require('path');
const config = require('../config');
const logger = require('../logger');

const SCRIPT = path.join(__dirname, '..', '..', 'busy-bridge', 'busy-bridge.ps1');
const POWERSHELL_32 = path.join(process.env.WINDIR || 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

let queue = Promise.resolve();

function runBridge(request) {
  const { busyPath, server, user, password, compCode, fy, timeoutMs } = config.busyCom;
  const payload = JSON.stringify({ ...request, conn: { busyPath, server, user, password, compCode, fy } });

  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL_32, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Busy did not respond within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.replace(/^\uFEFF/, '')));
      } catch {
        logger.error(`[BusyBridge] Unreadable bridge output. stdout=${stdout.slice(0, 500)} stderr=${stderr.slice(0, 500)}`);
        reject(new Error('Busy bridge returned an unreadable response'));
      }
    });
    child.stdin.end(payload);
  });
}

/** Queue a bridge call behind any in-flight one. Resolves with the bridge's JSON. */
function callBusy(request) {
  const run = queue.then(() => runBridge(request));
  queue = run.catch(() => {});
  return run;
}

module.exports = {
  ping: () => callBusy({ action: 'ping' }),
  addVoucher: (vchType, xml) => callBusy({ action: 'addVch', vchType, xml }),
  getVoucherXml: (vchCode) => callBusy({ action: 'getVchXml', vchCode }),
  deleteVoucher: (vchCode) => callBusy({ action: 'deleteVch', vchCode }),
  // { exists, valid } for a Busy login — the password goes to Busy only, never stored or logged.
  checkUser: (busyUser, busyPassword) => callBusy({ action: 'checkUser', busyUser, busyPassword }),
};
