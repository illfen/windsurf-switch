"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dpapiUnprotectBatch = dpapiUnprotectBatch;
exports.dpapiProtectBatch = dpapiProtectBatch;
exports.dpapiUnprotect = dpapiUnprotect;
exports.dpapiProtect = dpapiProtect;
const child_process_1 = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const constants_1 = require("./constants");
const log_1 = require("./log");
// ---------------------------------------------------------------------------
// Cross-platform fallback (macOS / Linux): AES-256-GCM with a local key file.
//
// Windows DPAPI shells out to `powershell.exe` which doesn't exist on POSIX.
// On non-Windows platforms we instead derive a per-user key stored at
// <accountsDir>/.cred.key (mode 0600) and encrypt each value with
// AES-256-GCM. The output is `aesgcm:<base64(iv || tag || cipher)>` — the
// `aesgcm:` prefix lets us distinguish from any DPAPI ciphertext that might
// have been carried over from a Windows install (we'd return '' rather than
// silently mis-decrypt). Same string length category as DPAPI base64, so it
// drops in to the existing PersistedAccountRecord *Protected fields without
// schema changes.
// ---------------------------------------------------------------------------
const NODE_CIPHER_PREFIX = 'aesgcm:';
const NODE_KEY_BYTES = 32; // AES-256
const NODE_IV_BYTES = 12;
const NODE_TAG_BYTES = 16;
let cachedNodeKey = null;
let cachedNodeKeyPath = '';
function nodeKeyFilePath() {
    return path.join((0, constants_1.getAccountsDir)(), '.cred.key');
}
function getOrCreateNodeKey() {
    const keyPath = nodeKeyFilePath();
    if (cachedNodeKey && cachedNodeKeyPath === keyPath) {
        return cachedNodeKey;
    }
    try {
        const buf = fs.readFileSync(keyPath);
        if (buf.length === NODE_KEY_BYTES) {
            cachedNodeKey = buf;
            cachedNodeKeyPath = keyPath;
            return buf;
        }
        (0, log_1.log)(`nodeKey ${keyPath} has unexpected length ${buf.length}, regenerating`);
    }
    catch (e) {
        if (e?.code !== 'ENOENT') {
            (0, log_1.log)(`nodeKey read failed (${e?.message || e}), regenerating`);
        }
    }
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    const fresh = crypto.randomBytes(NODE_KEY_BYTES);
    fs.writeFileSync(keyPath, fresh, { mode: 0o600 });
    try {
        fs.chmodSync(keyPath, 0o600);
    }
    catch {
        // best-effort; some FS (e.g. exFAT) don't honour modes
    }
    cachedNodeKey = fresh;
    cachedNodeKeyPath = keyPath;
    return fresh;
}
function nodeProtect(plain) {
    if (!plain) {
        return '';
    }
    const key = getOrCreateNodeKey();
    const iv = crypto.randomBytes(NODE_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return NODE_CIPHER_PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}
function nodeUnprotect(token) {
    if (!token) {
        return '';
    }
    if (!token.startsWith(NODE_CIPHER_PREFIX)) {
        // Likely DPAPI ciphertext from a Windows install; we cannot decrypt it
        // here. Returning '' matches the Windows fallback for failed items.
        (0, log_1.log)('nodeUnprotect: ciphertext missing aesgcm: prefix, skipping');
        return '';
    }
    let buf;
    try {
        buf = Buffer.from(token.slice(NODE_CIPHER_PREFIX.length), 'base64');
    }
    catch {
        return '';
    }
    if (buf.length < NODE_IV_BYTES + NODE_TAG_BYTES + 1) {
        return '';
    }
    const iv = buf.subarray(0, NODE_IV_BYTES);
    const tag = buf.subarray(NODE_IV_BYTES, NODE_IV_BYTES + NODE_TAG_BYTES);
    const enc = buf.subarray(NODE_IV_BYTES + NODE_TAG_BYTES);
    try {
        const key = getOrCreateNodeKey();
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    }
    catch (e) {
        (0, log_1.log)(`nodeUnprotect failed: ${e?.message || e}`);
        return '';
    }
}
/**
 * DPAPI via PowerShell shell-out. Avoids pulling in a native binding.
 * Uses CurrentUser scope to match the desktop manager's CredentialProtectionService.
 *
 * All calls use a single PowerShell subprocess, with input/output length-prefixed
 * records separated by newlines, so we can protect/unprotect N strings in one shot.
 *
 * Wire format (both directions):
 *   line 1:   count (N)
 *   lines 2..N+1: each is Base64(UTF8(plaintext)) or Base64(ciphertext bytes).
 *                 Empty lines represent empty strings.
 *
 * The wrapper script outputs a single token per line:
 *   - For unprotect: Base64(UTF8(plaintext)), or "__ERR__"
 *   - For protect:   Base64(ciphertext), or "__ERR__"
 */
const POWERSHELL_TIMEOUT_MS = 15000;
const UNPROTECT_SCRIPT = `
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Security
$lines = [Console]::In.ReadToEnd() -split "\`n"
$out = New-Object System.Text.StringBuilder
foreach ($rawLine in $lines) {
    $line = $rawLine.TrimEnd([char]13)
    if ([string]::IsNullOrEmpty($line)) {
        [void]$out.AppendLine("")
        continue
    }
    try {
        $bytes = [Convert]::FromBase64String($line)
        $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
        [void]$out.AppendLine([Convert]::ToBase64String($plain))
    } catch {
        [void]$out.AppendLine("__ERR__")
    }
}
[Console]::Out.Write($out.ToString())
`;
const PROTECT_SCRIPT = `
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Security
$lines = [Console]::In.ReadToEnd() -split "\`n"
$out = New-Object System.Text.StringBuilder
foreach ($rawLine in $lines) {
    $line = $rawLine.TrimEnd([char]13)
    if ([string]::IsNullOrEmpty($line)) {
        [void]$out.AppendLine("")
        continue
    }
    try {
        $plainBytes = [Convert]::FromBase64String($line)
        $cipher = [System.Security.Cryptography.ProtectedData]::Protect($plainBytes, $null, 'CurrentUser')
        [void]$out.AppendLine([Convert]::ToBase64String($cipher))
    } catch {
        [void]$out.AppendLine("__ERR__")
    }
}
[Console]::Out.Write($out.ToString())
`;
function runPowerShell(script, input) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                child.kill();
            }
            catch {
                // ignore
            }
            reject(new Error(`PowerShell DPAPI timeout after ${POWERSHELL_TIMEOUT_MS}ms`));
        }, POWERSHELL_TIMEOUT_MS);
        child.stdout.on('data', d => (stdout += d.toString('utf8')));
        child.stderr.on('data', d => (stderr += d.toString('utf8')));
        child.on('error', err => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', code => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (code === 0) {
                resolve(stdout);
            }
            else {
                reject(new Error(`PowerShell exit ${code}: ${stderr.trim() || '(no stderr)'}`));
            }
        });
        try {
            child.stdin.write(input, 'utf8');
            child.stdin.end();
        }
        catch (e) {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(e);
            }
        }
    });
}
/**
 * Decrypt a batch of base64 DPAPI ciphertexts in one subprocess.
 * Empty inputs map to empty outputs. Failures map to empty strings and are logged.
 */
async function dpapiUnprotectBatch(ciphers) {
    if (ciphers.length === 0) {
        return [];
    }
    if (ciphers.every(c => !c)) {
        return ciphers.map(() => '');
    }
    if (process.platform !== 'win32') {
        return ciphers.map(c => (c ? nodeUnprotect(c) : ''));
    }
    const input = ciphers.map(c => c || '').join('\n');
    const started = Date.now();
    const stdout = await runPowerShell(UNPROTECT_SCRIPT, input);
    (0, log_1.log)(`dpapiUnprotectBatch: ${ciphers.length} item(s) in ${Date.now() - started}ms`);
    const rawLines = stdout.split('\n');
    // Trailing newline produces an extra empty entry; strip to match input length.
    while (rawLines.length > ciphers.length && rawLines[rawLines.length - 1] === '') {
        rawLines.pop();
    }
    const results = [];
    for (let i = 0; i < ciphers.length; i++) {
        const line = (rawLines[i] || '').replace(/\r$/, '');
        if (!ciphers[i]) {
            results.push('');
            continue;
        }
        if (line === '__ERR__' || !line) {
            (0, log_1.log)(`dpapiUnprotectBatch: item ${i} failed`);
            results.push('');
            continue;
        }
        try {
            results.push(Buffer.from(line, 'base64').toString('utf8'));
        }
        catch (e) {
            (0, log_1.log)(`dpapiUnprotectBatch: item ${i} base64 decode failed - ${e?.message || e}`);
            results.push('');
        }
    }
    return results;
}
/**
 * Encrypt a batch of UTF-8 plaintexts to base64 DPAPI ciphertexts in one subprocess.
 * Empty inputs map to empty outputs.
 */
async function dpapiProtectBatch(plaintexts) {
    if (plaintexts.length === 0) {
        return [];
    }
    if (plaintexts.every(p => !p)) {
        return plaintexts.map(() => '');
    }
    if (process.platform !== 'win32') {
        return plaintexts.map(p => (p ? nodeProtect(p) : ''));
    }
    // Encode each plaintext as base64(UTF8(plain)) so multi-line / non-ASCII
    // values can't break the line-based wire format.
    const input = plaintexts
        .map(p => (p ? Buffer.from(p, 'utf8').toString('base64') : ''))
        .join('\n');
    const started = Date.now();
    const stdout = await runPowerShell(PROTECT_SCRIPT, input);
    (0, log_1.log)(`dpapiProtectBatch: ${plaintexts.length} item(s) in ${Date.now() - started}ms`);
    const rawLines = stdout.split('\n');
    while (rawLines.length > plaintexts.length && rawLines[rawLines.length - 1] === '') {
        rawLines.pop();
    }
    const results = [];
    for (let i = 0; i < plaintexts.length; i++) {
        const line = (rawLines[i] || '').replace(/\r$/, '');
        if (!plaintexts[i]) {
            results.push('');
            continue;
        }
        if (line === '__ERR__' || !line) {
            throw new Error(`dpapiProtectBatch: item ${i} failed`);
        }
        results.push(line);
    }
    return results;
}
async function dpapiUnprotect(base64Cipher) {
    const [out] = await dpapiUnprotectBatch([base64Cipher]);
    return out || '';
}
async function dpapiProtect(plaintext) {
    const [out] = await dpapiProtectBatch([plaintext]);
    return out || '';
}
//# sourceMappingURL=dpapi.js.map