"use strict";
/**
 * Windsurf core patcher.
 *
 * Injects two snippets into Windsurf's bundled `dist/extension.js`:
 *
 *   1.  A clone of `handleAuthToken(...)` named `handleAuthTokenWithShit(...)`
 *       that takes a fully-resolved `{apiKey, name, apiServerUrl}` object so
 *       the caller can skip the OAuth round-trip / browser open.
 *
 *   2.  A registerCommand call that exposes the new method via the global
 *       VS Code command id `windsurf.provideAuthTokenToAuthProviderWithShit`
 *       so any extension (us) can call it.
 *
 * After patching, our seamlessSwitch can do
 *   await commands.executeCommand(
 *       'windsurf.provideAuthTokenToAuthProviderWithShit',
 *       { apiKey, name, apiServerUrl }
 *   );
 * and Windsurf swaps the active session in-place — no browser, no modal,
 * no auth-provider race — by writing SecretStorage and firing
 * `_sessionChangeEmitter`.
 *
 * Approach borrows heavily from the reverse-engineered "切号器" extension
 * (wf-dialog.wf-dialog-mcp). The clone-and-rename trick (rather than a
 * hard-coded snippet with mangled symbols `s`, `e`, `n`, `B`, ...) keeps the
 * patch resilient to bundler variable renames between Windsurf releases.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.findWindsurfExtensionPath = findWindsurfExtensionPath;
exports.isPatchApplied = isPatchApplied;
exports.applyPatch = applyPatch;
exports.restorePatch = restorePatch;
exports.PATCH_COMMAND_ID = void 0;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const vscode = require("vscode");
const log_1 = require("./log");

const PATCH_METHOD_MARKER = 'handleAuthTokenWithShit';
const PATCH_COMMAND_ID = 'windsurf.provideAuthTokenToAuthProviderWithShit';
exports.PATCH_COMMAND_ID = PATCH_COMMAND_ID;

// ---------------------------------------------------------------------------
// Locate Windsurf core's bundled extension.js
// ---------------------------------------------------------------------------

/**
 * Returns absolute path to Windsurf core's `dist/extension.js`, or null.
 *
 * Tries:
 *   1. vscode.extensions API — finds `codeium.windsurf` (or any
 *      `codeium.windsurf-*` that's not a `-remote` flavour).
 *   2. `vscode.env.appRoot/extensions/windsurf/dist/extension.js` — the
 *      bundled-in-app fallback path used by VS Code-derived editors.
 */
function findWindsurfExtensionPath() {
    try {
        const ext = vscode.extensions.all.find(x =>
            x.id === 'codeium.windsurf'
            || (x.id.startsWith('codeium.windsurf-') && !x.id.includes('remote'))
        );
        if (ext) {
            const p = path.join(ext.extensionPath, 'dist', 'extension.js');
            if (fs.existsSync(p)) {
                return p;
            }
        }
    } catch (e) {
        (0, log_1.log)(`[patcher] vscode.extensions lookup failed: ${e?.message || e}`);
    }
    try {
        const appRoot = vscode.env.appRoot;
        if (appRoot) {
            const p = path.join(appRoot, 'extensions', 'windsurf', 'dist', 'extension.js');
            if (fs.existsSync(p)) {
                return p;
            }
        }
    } catch (e) {
        (0, log_1.log)(`[patcher] appRoot lookup failed: ${e?.message || e}`);
    }
    return null;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** True iff Windsurf core's `extension.js` already contains both markers. */
function isPatchApplied(extPath) {
    const p = extPath || findWindsurfExtensionPath();
    if (!p || !fs.existsSync(p)) {
        return false;
    }
    try {
        // Use Buffer reads + indexOf to avoid loading 16MB strings just to test.
        const buf = fs.readFileSync(p);
        return buf.includes(PATCH_METHOD_MARKER) && buf.includes(PATCH_COMMAND_ID);
    } catch (e) {
        (0, log_1.log)(`[patcher] isPatchApplied read failed: ${e?.message || e}`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// JS validation
// ---------------------------------------------------------------------------

/**
 * Best-effort syntax check via `vm.Script`. Returns `{ok, error}`.
 *
 * Windsurf's bundle is CJS so `vm.Script` works. If the bundle ever ships as
 * native ESM, `new Script` will reject `import` / `export`; we then fall back
 * to ESM-aware paths but those are unlikely to trigger here.
 */
function validateJavaScriptSyntax(content) {
    try {
        // eslint-disable-next-line no-new
        new vm.Script(content);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}

// ---------------------------------------------------------------------------
// Clone-the-original patch generator
// ---------------------------------------------------------------------------

/**
 * Find the position of the matching closing brace for the open `{` at
 * `openIdx`. Naive brace counter that respects strings (single, double,
 * backtick) and escapes. Good enough for the small slice we care about.
 */
function findMatchingBrace(src, openIdx) {
    if (src[openIdx] !== '{') {
        return -1;
    }
    let depth = 0;
    let stringChar = null;
    let escape = false;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (stringChar) {
            if (escape) { escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === stringChar) { stringChar = null; continue; }
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { stringChar = c; continue; }
        if (c === '{') { depth++; continue; }
        if (c === '}') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Build the `handleAuthTokenWithShit` body by cloning the original
 * `handleAuthToken` body verbatim and applying surgical text replacements.
 * Returns the inserted method as a string (no leading newline / spaces).
 *
 * The trick: since we're copying whatever Windsurf's bundle already uses,
 * mangled imports (`s`, `n`, `B`, ...) resolve correctly without us needing
 * to know what they alias.
 */
function buildClonedMethod(src, methodHeaderIdx) {
    // 'async handleAuthToken(' is 22 chars
    const HEADER = 'async handleAuthToken(';
    if (!src.startsWith(HEADER, methodHeaderIdx)) {
        throw new Error(`[patcher] expected "${HEADER}" at offset ${methodHeaderIdx}`);
    }
    const argStart = methodHeaderIdx + HEADER.length;
    const argEnd = src.indexOf(')', argStart);
    if (argEnd < 0) {
        throw new Error('[patcher] could not find arg list closing paren');
    }
    const argName = src.slice(argStart, argEnd).trim();
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(argName)) {
        throw new Error(`[patcher] unexpected arg form "${argName}"`);
    }
    const bodyOpenIdx = src.indexOf('{', argEnd);
    if (bodyOpenIdx < 0) {
        throw new Error('[patcher] could not find body open brace');
    }
    const bodyCloseIdx = findMatchingBrace(src, bodyOpenIdx);
    if (bodyCloseIdx < 0) {
        throw new Error('[patcher] could not find matching close brace');
    }
    let body = src.slice(bodyOpenIdx, bodyCloseIdx + 1); // includes both braces
    // The original body starts with:
    //   const e=await(0,w.registerUser)(A),...
    // We replace the registerUser call with the arg itself, so the caller
    // can pass {apiKey, name, apiServerUrl} directly.
    const REG_CALL_RE = /await\s*\(\s*0\s*,\s*\w+\.registerUser\s*\)\s*\(\s*\w+\s*\)/;
    if (REG_CALL_RE.test(body)) {
        body = body.replace(REG_CALL_RE, argName);
    } else {
        (0, log_1.log)('[patcher] WARN: handleAuthToken body did not contain a recognizable registerUser call; patch may not behave as expected');
    }
    // Defensive: align field names with what callers will pass.
    // Some bundles use the snake_case proto field names directly; harmonize.
    body = body.replace(/\bapi_key\b/g, 'apiKey').replace(/\bapi_server_url\b/g, 'apiServerUrl');
    return `async handleAuthTokenWithShit(${argName})${body}`;
}

/**
 * Build the cloned `registerCommand` line for our new command id by copying
 * Windsurf's existing `registerCommand(t.PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER,
 * async A=>{...})` statement and renaming the command + the inner method.
 *
 * Returns `{cmdLine, insertAt}` where `cmdLine` is the snippet to insert and
 * `insertAt` is the byte offset to splice it in (right after the original
 * registerCommand call's closing paren+comma).
 */
function buildClonedCommand(src) {
    // Find: <ws>.commands.registerCommand(<ws>.PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER,
    const ANCHOR_RE = /(\w+)\.commands\.registerCommand\(\s*(\w+)\.PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER\s*,/;
    const m = ANCHOR_RE.exec(src);
    if (!m) {
        throw new Error('[patcher] could not find registerCommand(t.PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER, ...) anchor');
    }
    const callStart = m.index;
    // Walk from the opening '(' after registerCommand to its matching ')'.
    const parenOpen = src.indexOf('(', callStart);
    if (parenOpen < 0) {
        throw new Error('[patcher] could not find registerCommand open paren');
    }
    let depth = 0;
    let stringChar = null;
    let escape = false;
    let parenClose = -1;
    for (let i = parenOpen; i < src.length; i++) {
        const c = src[i];
        if (stringChar) {
            if (escape) { escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === stringChar) { stringChar = null; continue; }
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { stringChar = c; continue; }
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) { parenClose = i; break; }
        }
    }
    if (parenClose < 0) {
        throw new Error('[patcher] could not balance registerCommand parens');
    }
    // Check for trailing ',' after the closing ')', so the new statement can
    // be inserted right before it without breaking the surrounding
    // subscriptions.push(...) chain.
    const stmt = src.slice(callStart, parenClose + 1);
    const newStmt = stmt
        .replace(/(\w+)\.PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER/, `"${PATCH_COMMAND_ID}"`)
        .replace(/\.handleAuthToken\b/g, '.handleAuthTokenWithShit');
    // Insert as `<original>, <newStmt>` — i.e. paste right after the
    // original close paren. The existing trailing comma in the file (if any)
    // continues to chain to the next subscription.
    return { cmdLine: ', ' + newStmt, insertAt: parenClose + 1 };
}

// ---------------------------------------------------------------------------
// File IO helpers
// ---------------------------------------------------------------------------

function ensureWritable(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.W_OK);
        return { ok: true };
    } catch (e) {
        // Try to chmod u+w
        try {
            const st = fs.statSync(filePath);
            const newMode = (st.mode | 0o200) & 0o7777;
            fs.chmodSync(filePath, newMode);
            fs.accessSync(filePath, fs.constants.W_OK);
            return { ok: true };
        } catch (e2) {
            return { ok: false, error: `${filePath} 不可写：${e2?.message || e2}` };
        }
    }
}

/**
 * Atomic write with verification + rollback. Steps:
 *   1. Write `content` to `<filePath>.tmp`
 *   2. Rename `<filePath>.tmp` over `<filePath>`
 *   3. Read it back; if `verify(readBack) === true`, success. Else restore
 *      `previous` (the prior file content) and return error.
 */
function writeWithRollback(filePath, content, previous, verify) {
    const tmp = filePath + '.tmp';
    try {
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, filePath);
        const readBack = fs.readFileSync(filePath, 'utf8');
        if (verify(readBack)) {
            return { success: true };
        }
        (0, log_1.log)('[patcher] verification failed after write, rolling back');
        fs.writeFileSync(filePath, previous, 'utf8');
        return { success: false, error: 'verification failed; rolled back' };
    } catch (e) {
        // Rollback best-effort.
        try { fs.writeFileSync(filePath, previous, 'utf8'); } catch { /* ignore */ }
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
        return { success: false, error: e?.message || String(e) };
    }
}

// ---------------------------------------------------------------------------
// Public API: applyPatch / restorePatch
// ---------------------------------------------------------------------------

/**
 * Apply the patch to Windsurf's `extension.js`. Idempotent: returns
 * `{success:true, alreadyApplied:true}` if it's already patched.
 *
 * Returns `{success, needsRestart, alreadyApplied?, error?}`.
 */
async function applyPatch() {
    const extPath = findWindsurfExtensionPath();
    if (!extPath) {
        return { success: false, error: '未找到 Windsurf 核心扩展（codeium.windsurf）的 dist/extension.js' };
    }
    if (isPatchApplied(extPath)) {
        return { success: true, alreadyApplied: true };
    }
    const writable = ensureWritable(extPath);
    if (!writable.ok) {
        return { success: false, error: writable.error };
    }
    let original;
    try {
        original = fs.readFileSync(extPath, 'utf8');
    } catch (e) {
        return { success: false, error: `读取失败：${e?.message || e}` };
    }
    // Backup the original (only if no backup exists yet — never overwrite a
    // good backup with an already-patched file).
    const backupPath = extPath + '.aliu-backup';
    if (!fs.existsSync(backupPath)) {
        try {
            fs.writeFileSync(backupPath, original, 'utf8');
            (0, log_1.log)(`[patcher] backup written → ${backupPath}`);
        } catch (e) {
            return { success: false, error: `写备份失败：${e?.message || e}` };
        }
    }
    // 1. Locate `async handleAuthToken(` and clone the body.
    const headerIdx = original.indexOf('async handleAuthToken(');
    if (headerIdx < 0) {
        return { success: false, error: '在 Windsurf extension.js 中未找到 async handleAuthToken(' };
    }
    let clonedMethod;
    try {
        clonedMethod = buildClonedMethod(original, headerIdx);
    } catch (e) {
        return { success: false, error: e?.message || String(e) };
    }
    const methodOpen = original.indexOf('{', headerIdx);
    const methodClose = findMatchingBrace(original, methodOpen);
    if (methodOpen < 0 || methodClose < 0) {
        return { success: false, error: '解析 handleAuthToken 函数体失败' };
    }
    // Insert cloned method right after original's closing brace.
    const insertedAfterMethod =
        original.slice(0, methodClose + 1) +
        clonedMethod +
        original.slice(methodClose + 1);
    // 2. Locate the registerCommand anchor in the post-method buffer and
    // clone it.
    let cmd;
    try {
        cmd = buildClonedCommand(insertedAfterMethod);
    } catch (e) {
        return { success: false, error: e?.message || String(e) };
    }
    const patched =
        insertedAfterMethod.slice(0, cmd.insertAt) +
        cmd.cmdLine +
        insertedAfterMethod.slice(cmd.insertAt);
    // 3. Validate.
    const syn = validateJavaScriptSyntax(patched);
    if (!syn.ok) {
        return { success: false, error: `补丁后语法校验失败：${syn.error}` };
    }
    // 4. Write atomically + verify.
    const verified = writeWithRollback(extPath, patched, original, content =>
        content.includes(PATCH_METHOD_MARKER)
        && content.includes(PATCH_COMMAND_ID)
        && validateJavaScriptSyntax(content).ok
    );
    if (!verified.success) {
        return { success: false, error: verified.error };
    }
    (0, log_1.log)(`[patcher] applied patch to ${extPath}`);
    return { success: true, needsRestart: true };
}

/**
 * Restore Windsurf's `extension.js` from `<extPath>.aliu-backup`. Returns
 * `{success, needsRestart, error?}`.
 */
async function restorePatch() {
    const extPath = findWindsurfExtensionPath();
    if (!extPath) {
        return { success: false, error: '未找到 Windsurf 核心扩展的 dist/extension.js' };
    }
    const backupPath = extPath + '.aliu-backup';
    if (!fs.existsSync(backupPath)) {
        return { success: false, error: `备份文件不存在：${backupPath}` };
    }
    const writable = ensureWritable(extPath);
    if (!writable.ok) {
        return { success: false, error: writable.error };
    }
    let backup;
    let current;
    try {
        backup = fs.readFileSync(backupPath, 'utf8');
        current = fs.readFileSync(extPath, 'utf8');
    } catch (e) {
        return { success: false, error: `读取失败：${e?.message || e}` };
    }
    const syn = validateJavaScriptSyntax(backup);
    if (!syn.ok) {
        return { success: false, error: `备份文件语法异常：${syn.error}` };
    }
    const verified = writeWithRollback(extPath, backup, current, content =>
        content === backup && validateJavaScriptSyntax(content).ok
    );
    if (!verified.success) {
        return { success: false, error: verified.error };
    }
    (0, log_1.log)(`[patcher] restored ${extPath} from backup`);
    return { success: true, needsRestart: true };
}
//# sourceMappingURL=windsurfPatcher.js.map
