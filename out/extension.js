"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const accountsStore_1 = __importStar(require("./accountsStore"));
const constants_1 = __importStar(require("./constants"));
const log_1 = __importStar(require("./log"));
const importParser_1 = __importStar(require("./importParser"));
const memoryCreds_1 = __importStar(require("./memoryCreds"));
const dpapi_1 = __importStar(require("./dpapi"));
const seamlessSwitch_1 = __importStar(require("./seamlessSwitch"));
const sidebar_1 = __importStar(require("./sidebar"));
const tokens_1 = __importStar(require("./tokens"));
const windsurfApi_1 = __importStar(require("./windsurfApi"));
const windsurfPatcher_1 = __importStar(require("./windsurfPatcher"));
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const autoSwitch_1 = __importStar(require("./autoSwitch"));
const smartSwitch_1 = __importStar(require("./smartSwitch"));
// ---------------------------------------------------------------------------
// globalState keys for smart switch / Free throttle / current account.
// ---------------------------------------------------------------------------
const GS = {
    currentAccountId: 'wm.currentAccountId',
    activeEmail: 'wm.activeEmail',
    /**
     * Maps Windsurf's session display-name (account.label, e.g. "Ashley Lee")
     * to the corresponding email in accounts.json.  Populated every time we
     * perform a seamless switch (we know both sides at that moment) and by
     * the "claim current session" flow.  Used as the authoritative fallback
     * when Windsurf's session doesn't expose the email (accessToken is opaque).
     */
    sessionLabelMap: 'wm.sessionLabelMap',
    smartHistory: 'wm.smartSwitchHistory',
    refreshAllCounter: 'wm.refreshAllCounter'
};
/** Every 10th refreshAll includes Free accounts; others skip them. */
const FREE_REFRESH_EVERY_N = 10;
// ---------------------------------------------------------------------------
// Cross-window active-account synchronisation.
//
// VSCode's `globalState` (Memento) is *per-window, in-memory-cached*. The
// underlying SQLite is shared across windows but each window's extension host
// doesn't observe writes from sibling hosts — so if the user has multiple
// Windsurf windows open, a `doSwitch` in window A never reaches window B.
//
// To make "current account" consistent across windows we shadow-write it to a
// disk file (`<accountsDir>/active.json`) and fs.watch it for changes. Writes
// carry a per-window `WRITER_TOKEN` so the watcher can skip self-triggered
// events.
// ---------------------------------------------------------------------------
const ACTIVE_FILE_NAME = 'active.json';
/** A per-extension-host random token, so we can tell our own writes apart
 *  from writes issued by a sibling Windsurf window. */
const WRITER_TOKEN = crypto.randomBytes(8).toString('hex');
/** Coalesce bursty disk writes (a single doSwitch calls setCurrentAccountId +
 *  setActiveEmail back-to-back; we want one fs event, not two). */
let activeFileWriteTimer = null;
function getActiveFilePath() {
    return path.join((0, constants_1.getAccountsDir)(), ACTIVE_FILE_NAME);
}
/** Read the cross-window active-account file. Returns null on ENOENT or
 *  unparseable content; otherwise the `{ id, email, writer, updatedAt }`
 *  payload. */
function readActiveFileSync() {
    try {
        const raw = fs.readFileSync(getActiveFilePath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            return {
                id: typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : null,
                email: typeof parsed.email === 'string' && parsed.email.length > 0 ? parsed.email : null,
                writer: typeof parsed.writer === 'string' ? parsed.writer : '',
                updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
            };
        }
    }
    catch (e) {
        if (e?.code !== 'ENOENT') {
            (0, log_1.log)(`active.json read failed: ${e?.message || e}`);
        }
    }
    return null;
}
/** Persist the current memento values to `active.json`. Atomic temp+rename. */
function scheduleActiveFileWrite(ctx) {
    if (activeFileWriteTimer)
        return;
    activeFileWriteTimer = setTimeout(() => {
        activeFileWriteTimer = null;
        try {
            (0, accountsStore_1.ensureAccountsDir)();
            const payload = {
                id: ctx.globalState.get(GS.currentAccountId, null) || null,
                email: ctx.globalState.get(GS.activeEmail, null) || null,
                writer: WRITER_TOKEN,
                updatedAt: Date.now()
            };
            const file = getActiveFilePath();
            const tmp = file + '.tmp.' + process.pid;
            fs.writeFileSync(tmp, JSON.stringify(payload));
            fs.renameSync(tmp, file);
        }
        catch (e) {
            (0, log_1.log)(`active.json write failed: ${e?.message || e}`);
        }
    }, 25);
}
/** Pull from active.json into memento at startup, before any sync() runs. */
async function hydrateFromActiveFile(ctx) {
    const payload = readActiveFileSync();
    if (!payload)
        return;
    const curId = ctx.globalState.get(GS.currentAccountId, null) || null;
    const curEmail = ctx.globalState.get(GS.activeEmail, null) || null;
    // Only overwrite if the shared file has a *newer* / *different* value; we
    // don't want to resurrect a stale entry on top of a fresher local write.
    if (payload.id && payload.id !== curId) {
        await ctx.globalState.update(GS.currentAccountId, payload.id);
        (0, log_1.log)(`hydrate active.json → currentAccountId = ${payload.id}`);
    }
    if (payload.email && payload.email !== curEmail) {
        await ctx.globalState.update(GS.activeEmail, payload.email);
        (0, log_1.log)(`hydrate active.json → activeEmail = ${payload.email}`);
    }
}
/** Watch `active.json` for cross-window updates. Returns a disposable. */
function installActiveFileWatcher(ctx, sidebarProvider) {
    const file = getActiveFilePath();
    try {
        (0, accountsStore_1.ensureAccountsDir)();
    }
    catch { /* best-effort */ }
    let watcher = null;
    const pullFromFile = async () => {
        const payload = readActiveFileSync();
        if (!payload)
            return;
        if (payload.writer === WRITER_TOKEN)
            return; // our own write, already applied
        const curId = ctx.globalState.get(GS.currentAccountId, null) || null;
        const curEmail = ctx.globalState.get(GS.activeEmail, null) || null;
        let changed = false;
        if (payload.id && payload.id !== curId) {
            await ctx.globalState.update(GS.currentAccountId, payload.id);
            changed = true;
        }
        if (payload.email && payload.email !== curEmail) {
            await ctx.globalState.update(GS.activeEmail, payload.email);
            changed = true;
        }
        if (changed) {
            (0, log_1.log)(`active.json changed externally (writer=${payload.writer.slice(0, 4)}…) → id=${payload.id ?? '∅'}, email=${payload.email ?? '∅'}`);
            sidebarProvider?.invalidatePostCache?.();
            void sidebarProvider?.reload?.();
        }
    };
    const start = () => {
        try {
            watcher = fs.watch(file, { persistent: false }, () => { void pullFromFile(); });
            watcher.on('error', (e) => { (0, log_1.log)(`active.json watcher error: ${e?.message || e}`); });
        }
        catch (e) {
            // File may not exist yet; create empty so watch can succeed, then retry.
            if (e?.code === 'ENOENT') {
                try {
                    scheduleActiveFileWrite(ctx);
                    setTimeout(start, 100);
                }
                catch { /* give up */ }
            }
            else {
                (0, log_1.log)(`active.json watcher install failed: ${e?.message || e}`);
            }
        }
    };
    start();
    return {
        dispose() {
            try {
                watcher?.close();
            }
            catch { }
        }
    };
}
function getCurrentAccountId(ctx) {
    return ctx.globalState.get(GS.currentAccountId, null) || null;
}
/**
 * Write the cached current-account id. DEFENSIVELY REJECTS writes of null /
 * empty — clearing the current account must go through `clearCurrentAccount`
 * which takes an explicit reason. This plugs the "mysterious null" bug where
 * some background code path (shared-status reader, VSCode memento namespacing
 * quirk, Windsurf S()-chain re-render, etc.) kept nuking the value we'd just
 * set in doSwitch and leaving the user with a "尚未检测到当前账号" UI.
 *
 * `callerHint` is printed in the log whenever a null slip-through is caught,
 * so we can finally identify what's trying to clear us.
 */
async function setCurrentAccountId(ctx, id, callerHint) {
    if (id === null || id === undefined || id === '') {
        const stack = new Error().stack?.split('\n').slice(2, 6).join(' | ') || '(no stack)';
        (0, log_1.log)(`[guard] blocked null write to currentAccountId via ${callerHint || 'unknown'} — stack: ${stack}`);
        return;
    }
    await ctx.globalState.update(GS.currentAccountId, id);
    scheduleActiveFileWrite(ctx);
}
function getActiveEmail(ctx) {
    return ctx.globalState.get(GS.activeEmail, null) || null;
}
/** Same defensive contract as setCurrentAccountId. See that function's docs. */
async function setActiveEmail(ctx, email, callerHint) {
    if (email === null || email === undefined || email === '') {
        const stack = new Error().stack?.split('\n').slice(2, 6).join(' | ') || '(no stack)';
        (0, log_1.log)(`[guard] blocked null write to activeEmail via ${callerHint || 'unknown'} — stack: ${stack}`);
        return;
    }
    await ctx.globalState.update(GS.activeEmail, email);
    scheduleActiveFileWrite(ctx);
}
/**
 * Explicit clear path. Use this (NOT setCurrentAccountId(ctx, null)) from
 * logout / deleteAccount / any genuine "user is no longer logged in" flow.
 * Writes both keys to null atomically and logs the reason.
 */
async function clearCurrentAccount(ctx, reason) {
    const prevId = ctx.globalState.get(GS.currentAccountId, null) || null;
    const prevEmail = ctx.globalState.get(GS.activeEmail, null) || null;
    await ctx.globalState.update(GS.currentAccountId, null);
    await ctx.globalState.update(GS.activeEmail, null);
    scheduleActiveFileWrite(ctx);
    if (prevId !== null || prevEmail !== null) {
        (0, log_1.log)(`clearCurrentAccount (${reason}): id=${prevId ?? '∅'} email=${prevEmail ?? '∅'} → ∅`);
    }
}
function getSessionLabelMap(ctx) {
    return ctx.globalState.get(GS.sessionLabelMap, {}) || {};
}
function normalizeLabel(label) {
    return (label || '').trim().toLowerCase();
}
/**
 * Record a `session.account.label` → email mapping.  Called whenever we
 * learn both sides (seamless switch, manual claim).  Cheap, idempotent.
 */
async function rememberSessionLabel(ctx, label, email) {
    const key = normalizeLabel(label);
    const val = (email || '').trim().toLowerCase();
    if (!key || !val)
        return;
    const map = getSessionLabelMap(ctx);
    if (map[key] === val)
        return;
    map[key] = val;
    await ctx.globalState.update(GS.sessionLabelMap, map);
    (0, log_1.log)(`sessionLabelMap: learned "${label}" → ${val}`);
}
function lookupEmailByLabel(ctx, label) {
    const key = normalizeLabel(label);
    if (!key)
        return null;
    const map = getSessionLabelMap(ctx);
    return map[key] || null;
}
/**
 * Returns the currently active Windsurf session via VS Code's auth API.
 * Returns undefined on any error or when there's no active session.
 *
 * Note: do NOT rely on session.account.label — Windsurf sets it to the
 * user's display name (e.g. "William Johnson"), not the email. Use
 * `extractEmailFromSession` below to get the real email.
 */
async function resolveActiveSession() {
    try {
        return await vscode.authentication.getSession(constants_1.WINDSURF_AUTH_PROVIDER_ID, ['Login'], { silent: true });
    }
    catch (e) {
        (0, log_1.log)('resolveActiveSession failed:', e?.message || e);
        return undefined;
    }
}
/**
 * Decode a JWT payload without signature validation. We only read claims
 * (`email`) to match against our local account list — verifying the signature
 * isn't necessary for that.
 */
function decodeJwtPayload(token) {
    if (!token || typeof token !== 'string')
        return null;
    const parts = token.split('.');
    if (parts.length < 2)
        return null;
    try {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
        const json = Buffer.from(b64 + pad, 'base64').toString('utf8');
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
}
/** Track sessions we've already diagnosed so the log isn't spammed on heartbeat. */
const _sessionDiagnoseCache = new Set();
/**
 * Pull the logged-in email from a session, trying multiple claim locations.
 * We've seen Windsurf builds that set `account.label` to the display name
 * ("William Johnson") rather than the email, so we go to the JWT directly.
 */
function extractEmailFromSession(session) {
    if (!session)
        return null;
    const payload = decodeJwtPayload(session.accessToken);
    // Known email-bearing claims across common providers:
    //   email         — Firebase / OAuth standard
    //   emails[0]     — Azure AD / Microsoft
    //   preferred_username — OIDC (sometimes email)
    //   upn           — Windows / AD
    const candidates = [];
    if (payload) {
        const pushIfStr = (v) => {
            if (typeof v === 'string' && v.trim())
                candidates.push(v.trim());
        };
        pushIfStr(payload.email);
        const emails = payload.emails;
        if (Array.isArray(emails))
            emails.forEach(pushIfStr);
        pushIfStr(payload.preferred_username);
        pushIfStr(payload.upn);
    }
    pushOnce(candidates, (session.account?.label || '').trim());
    pushOnce(candidates, (session.account?.id || '').trim());
    for (const c of candidates) {
        if (/@/.test(c))
            return c.toLowerCase();
    }
    // One-time diagnostic dump per session.id so the user can share logs if
    // matching fails. Avoid per-heartbeat spam.
    if (session.id && !_sessionDiagnoseCache.has(session.id)) {
        _sessionDiagnoseCache.add(session.id);
        const payloadKeys = payload ? Object.keys(payload).join(',') : '(no jwt)';
        (0, log_1.log)(`session diagnose: id=${session.id.slice(0, 8)}…` +
            ` label="${session.account?.label || ''}"` +
            ` account.id="${session.account?.id || ''}"` +
            ` jwtKeys=[${payloadKeys}]` +
            ` candidates=[${candidates.join('|')}]`);
    }
    return null;
}
function pushOnce(list, v) {
    if (v && !list.includes(v))
        list.push(v);
}
function readSharedJsonObject(context, key) {
    const raw = context.globalState.get(key);
    if (raw === undefined)
        return { exists: false, value: null };
    if (raw === null)
        return { exists: true, value: null };
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return {
                exists: true,
                value: parsed && typeof parsed === 'object'
                    ? parsed
                    : null
            };
        }
        catch {
            return { exists: true, value: null };
        }
    }
    return {
        exists: true,
        value: typeof raw === 'object' ? raw : null
    };
}
function readVarint(buf, offset) {
    let value = 0;
    let shift = 0;
    let i = offset;
    while (i < buf.length && shift <= 35) {
        const byte = buf[i++];
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0)
            return { value, next: i };
        shift += 7;
    }
    return null;
}
function collectProtoStrings(buf, out, depth = 0) {
    if (depth > 6)
        return;
    let offset = 0;
    while (offset < buf.length) {
        const tag = readVarint(buf, offset);
        if (!tag)
            return;
        offset = tag.next;
        const wireType = tag.value & 7;
        if (wireType === 0) {
            const scalar = readVarint(buf, offset);
            if (!scalar)
                return;
            offset = scalar.next;
            continue;
        }
        if (wireType === 1) {
            offset += 8;
            continue;
        }
        if (wireType === 2) {
            const len = readVarint(buf, offset);
            if (!len)
                return;
            offset = len.next;
            const end = offset + len.value;
            if (end > buf.length)
                return;
            const slice = buf.subarray(offset, end);
            offset = end;
            const text = slice.toString('utf8');
            if (/^[\x20-\x7e]{3,}$/.test(text)) {
                out.push(text);
            }
            else {
                collectProtoStrings(slice, out, depth + 1);
            }
            continue;
        }
        if (wireType === 5) {
            offset += 4;
            continue;
        }
        return;
    }
}
function readSharedLastLoginEmail(context) {
    for (const key of ['lastLoginEmail', 'lastLoginEmail.staging']) {
        const value = context.globalState.get(key);
        if (typeof value === 'string' && /@/.test(value)) {
            return value.trim().toLowerCase();
        }
    }
    return null;
}
function extractEmailFromSharedAuthStatus(context, accounts, prevEmail) {
    const shared = readSharedJsonObject(context, 'windsurfAuthStatus');
    if (!shared.value)
        return null;
    const base64 = shared.value.userStatusProtoBinaryBase64;
    if (typeof base64 !== 'string' || !base64)
        return null;
    let decoded;
    try {
        decoded = Buffer.from(base64, 'base64');
    }
    catch {
        return null;
    }
    const strings = [];
    collectProtoStrings(decoded, strings);
    const uniqueAccountEmails = Array.from(new Set(accounts
        .map(a => (a.email || '').trim().toLowerCase())
        .filter(Boolean)));
    const matched = uniqueAccountEmails.filter(email => strings.some(s => s.toLowerCase().includes(email)));
    const prev = (prevEmail || '').trim().toLowerCase();
    if (prev && matched.includes(prev))
        return prev;
    if (matched.length > 0)
        return matched[0];
    const extracted = Array.from(new Set(strings.flatMap(s => {
        const hits = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
        return hits ? hits.map(hit => hit.toLowerCase()) : [];
    })));
    if (prev && extracted.includes(prev))
        return prev;
    return extracted[0] || null;
}
/**
 * Read the authoritative Windsurf session and sync our cached
 * `currentAccountId` / `activeEmail`. Returns the resolved values.
 *
 * This is the single source of truth for "which account is logged in".
 * It's called on activation, on session-change events, and at the start
 * of user-initiated "refresh current" so the UI never drifts from reality.
 */
async function syncCurrentAccountFromSession(context, accountsOverride) {
    // Design rule (post-fix): sync is *purely additive*. It will only upgrade
    // our local currentAccountId / activeEmail when it finds *positive
    // evidence* of a new account. It will NEVER clear our cache.
    //
    // Why: clearing inside sync turned out to be systematically wrong.
    //   (a) `windsurfAuthStatus` is written by Windsurf at the SQLite top
    //       level, and on some builds it isn't exposed to Pro's per-extension
    //       Memento at all — making `context.globalState.get(...)` return
    //       `undefined` or an unexpected shape. Any "clear on unknown" path
    //       then nuked the state we'd JUST set in doSwitch.
    //   (b) Windsurf's own S()-chain intermittently re-writes the status
    //       object in ways that look like logout to a naive reader (missing
    //       keys, transient empty accessToken while a background refresh is
    //       in flight, etc.).
    // The authoritative source of truth for "which account is active in
    // Pro" is therefore the explicit user actions:
    //   - doSwitch writes currentAccountId / activeEmail on success.
    //   - LOGOUT / delete-account commands clear them explicitly.
    // Anything else (heartbeat, window focus, onDidChangeSessions, accounts
    // file watcher) is *best-effort read* that can only overwrite our cache
    // with *better* data, never erase it.
    const prevId = getCurrentAccountId(context);
    const prevEmail = getActiveEmail(context);
    const accounts = accountsOverride && accountsOverride.length > 0
        ? accountsOverride
        : await (0, accountsStore_1.loadManagerAccounts)();
    const sharedAuth = readSharedJsonObject(context, 'windsurfAuthStatus');
    let email = sharedAuth.exists
        ? extractEmailFromSharedAuthStatus(context, accounts, prevEmail) || readSharedLastLoginEmail(context)
        : null;
    let session;
    if (!email) {
        session = await resolveActiveSession();
        email = extractEmailFromSession(session);
        if (!email) {
            email = lookupEmailByLabel(context, session?.account?.label);
            if (email)
                (0, log_1.log)(`session sync: resolved via label map "${session?.account?.label}" → ${email}`);
        }
    }
    if (!email) {
        // Nothing found. Preserve whatever the caller/doSwitch already wrote.
        // (`hint` is only useful when we have zero previous email; we still
        // never wipe an existing one.)
        const hint = (session?.account?.label || '').trim();
        const prevLooksLikeEmail = !!prevEmail && /@/.test(prevEmail);
        if (!prevLooksLikeEmail && !prevEmail && hint) {
            await setActiveEmail(context, hint, 'sync-hint');
        }
        return { id: prevId, email: prevLooksLikeEmail ? prevEmail : (hint || prevEmail) };
    }
    const match = accounts.find(a => (a.email || '').trim().toLowerCase() === email);
    if (!match) {
        // Found an email in the shared status but it isn't in our accounts.
        // Don't touch currentAccountId — the user may have just deleted the
        // account from Pro's side but is still signed into Windsurf with it,
        // or Windsurf's cache is reporting a different (stale) account than
        // the one we just switched to. Preserve prev; just log.
        (0, log_1.log)(`session sync: email ${email} not found in ${accounts.length} accounts; keeping prev id=${prevId ?? '∅'}`);
        return { id: prevId, email: prevEmail };
    }
    const id = match.id;
    if (prevId !== id)
        await setCurrentAccountId(context, id, 'sync-match');
    if (prevEmail !== email)
        await setActiveEmail(context, email, 'sync-match');
    if (prevId !== id || prevEmail !== email) {
        (0, log_1.log)(`session sync: id ${prevId ?? '∅'} → ${id}, email ${prevEmail ?? '∅'} → ${email}`);
    }
    return { id, email };
}
/**
 * Debounced "resync current account + reload sidebar".
 *
 * Called from every cross-window trigger: file-watcher, session-change,
 * window focus, heartbeat.  Multiple calls within SYNC_DEBOUNCE_MS coalesce
 * so we don't hammer the auth provider or disk when, e.g., fs.watch fires
 * many events for a single atomic write.
 */
const SYNC_DEBOUNCE_MS = 250;
let syncScheduleTimer = null;
function scheduleSyncAndReload(context, sidebar, reason) {
    if (syncScheduleTimer)
        return; // coalesce
    syncScheduleTimer = setTimeout(async () => {
        syncScheduleTimer = null;
        try {
            await syncCurrentAccountFromSession(context, sidebar.accounts);
            // sidebar.reload() is cheap when nothing changed: disk read then
            // postState(), whose payload dedup will drop the webview message.
            // We intentionally DON'T log each tick (heartbeat fires every
            // 30s) — the inner sync logs on real state transitions.
            await sidebar.reload();
        }
        catch (e) {
            (0, log_1.log)(`cross-window sync (${reason}) failed:`, e?.message || e);
        }
    }, SYNC_DEBOUNCE_MS);
}
function getSmartHistory(ctx) {
    return ctx.globalState.get(GS.smartHistory, {}) || {};
}
function saveSmartHistory(ctx, h) {
    return ctx.globalState.update(GS.smartHistory, h);
}
function clearSmartHistory(ctx) {
    return ctx.globalState.update(GS.smartHistory, {});
}
let autoSwitch;
let sidebar;
function activate(context) {
    (0, log_1.log)(`Windsurf Switch v${context.extension.packageJSON.version} activating on VS Code ${vscode.version}. Accounts file: ${(0, accountsStore_1.getAccountsFilePath)()}`);
    try {
        (0, accountsStore_1.ensureAccountsDir)();
        // Wire the SecretStorage-backed credential cache. From here on,
        // tokens.ts and friends can pull plaintext without hitting DPAPI
        // on most runs (only the first-ever decrypt or a ciphertext change
        // forces a PowerShell round-trip).
        (0, memoryCreds_1.attachSecretStorage)(context.secrets);
        (0, dpapi_1.attachSecretStorage)(context.secrets);
        const unsubscribe = (0, memoryCreds_1.onStatusChange)(status => {
            if (status.state === 'ready') {
                (0, log_1.log)(`creds cache ready: total=${status.total} hit=${status.hitCount} miss=${status.missCount} in ${status.durationMs}ms`);
            }
            else if (status.state === 'error') {
                (0, log_1.log)(`creds cache error: ${status.message}`);
            }
        });
        context.subscriptions.push({ dispose: unsubscribe });
        (0, memoryCreds_1.kickoffBackgroundDecrypt)(); // fire-and-forget
        sidebar = new sidebar_1.SidebarProvider(context);
        context.subscriptions.push(vscode.window.registerWebviewViewProvider(sidebar_1.SidebarProvider.viewId, sidebar, {
            webviewOptions: { retainContextWhenHidden: true }
        }));
        (0, log_1.log)(`registered webview view provider: ${sidebar_1.SidebarProvider.viewId}`);
        // AutoSwitch controller (polling + log watcher). Starts whichever
        // monitors are currently enabled in globalState; both default to off.
        autoSwitch = new autoSwitch_1.AutoSwitch(context, {
            getCurrentAccountId: () => getCurrentAccountId(context),
            trigger: (trigger) => runSmartSwitch(context, sidebar, { trigger }),
            probeCurrentQuota: () => probeCurrentQuota(context)
        });
        autoSwitch.start();
        context.subscriptions.push(autoSwitch);
        registerCommands(context, sidebar);
        (0, log_1.log)('commands registered. Ready.');
        // Auto-patch Windsurf core on startup so a fresh install doesn't
        // require the user to run "给 Windsurf 打补丁" by hand. Silent-fail:
        // if the app is read-only, or we're on a mismatched Windsurf version,
        // just log and move on; the user can still run the command manually.
        void tryAutoPatchOnStartup(context);
        // Cross-window active-account file — hydrate from the shared file so
        // a window opened AFTER the most recent switch inherits it, then wire
        // a watcher so live updates from sibling windows flow in.
        void (async () => {
            try {
                await hydrateFromActiveFile(context);
            }
            catch (e) {
                (0, log_1.log)('active.json hydrate failed:', e?.message || e);
            }
        })();
        context.subscriptions.push(installActiveFileWatcher(context, sidebar));
        // Initial session sync — trust Windsurf's auth provider over our
        // cached globalState. This fixes the "首次安装时 UI 显示未切号" bug
        // when Windsurf is already logged in.
        void (async () => {
            try {
                await syncCurrentAccountFromSession(context);
                await sidebar.reload();
            }
            catch (e) {
                (0, log_1.log)('initial session sync failed:', e?.message || e);
            }
        })();
        // Multi-window sync strategy: VS Code runs a separate extension host
        // per window.  When window A changes account / refreshes quota,
        // window B's in-memory state is stale.  We wire four redundant
        // triggers so every window converges quickly:
        //
        //   1. accounts.json file watcher  → picks up cross-window writes
        //      (refresh quota / import / delete / switch).
        //   2. onDidChangeSessions          → Windsurf's auth provider event,
        //      if it propagates cross-window.
        //   3. onDidChangeWindowState       → when user refocuses the window,
        //      resync immediately (covers stale globalState cache).
        //   4. 30s heartbeat                → last-resort fallback if all of
        //      the above miss (edge cases, provider quirks).
        //
        // All four go through scheduleSyncAndReload which debounces + coalesces.
        context.subscriptions.push(vscode.authentication.onDidChangeSessions(ev => {
            if (ev.provider.id !== constants_1.WINDSURF_AUTH_PROVIDER_ID)
                return;
            scheduleSyncAndReload(context, sidebar, 'onDidChangeSessions');
        }));
        try {
            const accountsFile = (0, accountsStore_1.getAccountsFilePath)();
            const accountsDir = path.dirname(accountsFile);
            const baseName = path.basename(accountsFile);
            if (fs.existsSync(accountsDir)) {
                const watcher = fs.watch(accountsDir, { persistent: false }, (_ev, filename) => {
                    if (filename && String(filename) === baseName) {
                        scheduleSyncAndReload(context, sidebar, 'accounts.json changed');
                    }
                });
                context.subscriptions.push({
                    dispose: () => {
                        try {
                            watcher.close();
                        }
                        catch { /* ignore */ }
                    }
                });
            }
        }
        catch (e) {
            (0, log_1.log)('accounts.json watcher setup failed:', e?.message || e);
        }
        context.subscriptions.push(vscode.window.onDidChangeWindowState(ev => {
            if (ev.focused) {
                scheduleSyncAndReload(context, sidebar, 'window focused');
            }
        }));
        const heartbeat = setInterval(() => scheduleSyncAndReload(context, sidebar, 'heartbeat'), 30000);
        context.subscriptions.push({ dispose: () => clearInterval(heartbeat) });
    }
    catch (e) {
        (0, log_1.log)('activate() failed:', e?.stack || e?.message || e);
        (0, log_1.getOutputChannel)().show(true);
        vscode.window.showErrorMessage(`Windsurf Switch 激活失败：${e?.message || e}。请查看 Output → Windsurf Switch`);
        throw e;
    }
}
function deactivate() {
    (0, log_1.disposeOutput)();
}
// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------
function registerCommands(context, sidebar) {
    const sub = context.subscriptions;
    sub.push(vscode.commands.registerCommand('windsurfSwitch.reloadSidebar', () => sidebar.reload()));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.openAccountsFile', () => {
        void vscode.env.openExternal(vscode.Uri.file((0, accountsStore_1.getAccountsDir)()));
    }));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.showOutput', () => {
        (0, log_1.getOutputChannel)().show(true);
    }));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.switchAccount', () => pickAndSwitch(context, sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.switchAccountById', (accountId) => switchById(context, sidebar, accountId)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.switchByIdToken', () => cmdSwitchByIdToken()));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.addAccount', () => cmdAddAccount(sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.batchImport', () => cmdBatchImport(sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._submitAddFromModal', (args) => cmdSubmitAddFromModal(sidebar, args)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._submitBatchFromModal', (args) => cmdSubmitBatchFromModal(sidebar, args)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.deleteAccountById', (accountId) => deleteById(context, sidebar, accountId)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.editRemarkById', (accountId) => editRemarkById(sidebar, accountId)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.showCredentials', (accountId) => showCredentials(sidebar, accountId)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.refreshAccount', (accountId) => refreshOne(context, sidebar, accountId)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.refreshAll', () => refreshAll(context, sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.fixCredentialsById', (accountId) => fixCredentialsById(sidebar, accountId)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.listAccounts', () => cmdListAccounts()));
    // --- Smart switch / auto switch ---
    sub.push(vscode.commands.registerCommand('windsurfSwitch.smartSwitch', () => cmdSmartSwitch(context, sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._refreshCurrentSynced', () => cmdRefreshCurrentSynced(context, sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.diagnoseSession', () => cmdDiagnoseSession(context)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._smartSwitchFromSidebar', (args) => cmdSmartSwitchFromSidebar(context, sidebar, args)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.resetSmartCooldown', () => cmdResetSmartCooldown(context, sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.editLogPatterns', () => cmdEditLogPatterns(context)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._toggleAuto', (args) => cmdToggleAuto(context, sidebar, args)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._setPollingInterval', (args) => cmdSetPollingInterval(context, sidebar, args)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._setLowQuotaThreshold', (args) => cmdSetLowQuotaThreshold(context, sidebar, args)));
    // --- Windsurf core patch (no-browser smart switch) ---
    sub.push(vscode.commands.registerCommand('windsurfSwitch.patchWindsurf', () => cmdPatchWindsurf(context)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.unpatchWindsurf', () => cmdUnpatchWindsurf(context)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.checkPatchStatus', () => cmdCheckPatchStatus()));
}
// ---------------------------------------------------------------------------
// Windsurf core patch — apply / restore / status
// ---------------------------------------------------------------------------
/**
 * globalState flags for patcher autopilot.
 *   `wm.patcher.userDisabled` — set to true when the user explicitly unpatches.
 *       Auto-apply skips when this is true so we don't fight the user.
 *   `wm.patcher.lastAutoAppliedVersion` — the `packageJSON.version` of
 *       Windsurf's core extension the last time we auto-applied. When Windsurf
 *       is upgraded the version changes and we'll retry auto-apply once.
 */
const PATCHER_FLAGS = {
    userDisabled: 'wm.patcher.userDisabled',
    lastAutoAppliedVersion: 'wm.patcher.lastAutoAppliedVersion'
};
async function tryAutoPatchOnStartup(context) {
    try {
        const extPath = (0, windsurfPatcher_1.findWindsurfExtensionPath)();
        if (!extPath) {
            (0, log_1.log)('[auto-patch] skipped: Windsurf core extension.js not found');
            return;
        }
        if ((0, windsurfPatcher_1.isPatchApplied)(extPath)) {
            (0, log_1.log)('[auto-patch] already applied, nothing to do');
            return;
        }
        const userDisabled = context.globalState.get(PATCHER_FLAGS.userDisabled, false);
        if (userDisabled) {
            (0, log_1.log)('[auto-patch] skipped: user has explicitly unpatched previously (run "给 Windsurf 打补丁" to re-enable auto)');
            return;
        }
        (0, log_1.log)('[auto-patch] patch missing, attempting silent apply...');
        const r = await (0, windsurfPatcher_1.applyPatch)();
        if (!r.success) {
            (0, log_1.log)(`[auto-patch] failed (user can run "给 Windsurf 打补丁" to retry): ${r.error}`);
            return;
        }
        if (r.alreadyApplied) {
            (0, log_1.log)('[auto-patch] already-applied (concurrent run?)');
            return;
        }
        try {
            const extDir = path.dirname(path.dirname(extPath));
            const pkgPath = path.join(extDir, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const ver = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))?.version;
                if (typeof ver === 'string') {
                    await context.globalState.update(PATCHER_FLAGS.lastAutoAppliedVersion, ver);
                }
            }
        }
        catch { /* best effort */ }
        (0, log_1.log)(`[auto-patch] applied successfully → ${extPath}`);
        // Defer the reload prompt so it doesn't fight with the sidebar's
        // initial render.
        setTimeout(async () => {
            const choice = await vscode.window.showInformationMessage('Windsurf Switch 已自动为 Windsurf 打补丁（启用无浏览器切号）。重载窗口后生效。', '重载窗口', '稍后');
            if (choice === '重载窗口') {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }, 1500);
    }
    catch (e) {
        (0, log_1.log)(`[auto-patch] unexpected error (ignored): ${e?.stack || e?.message || e}`);
    }
}
async function cmdPatchWindsurf(context) {
    const extPath = (0, windsurfPatcher_1.findWindsurfExtensionPath)();
    if (!extPath) {
        vscode.window.showErrorMessage('未找到 Windsurf 核心扩展（codeium.windsurf）的 dist/extension.js');
        return;
    }
    if ((0, windsurfPatcher_1.isPatchApplied)(extPath)) {
        // User explicitly requested patch → clear the "don't auto-apply" flag.
        if (context)
            await context.globalState.update(PATCHER_FLAGS.userDisabled, false);
        vscode.window.showInformationMessage('Windsurf 核心已经是 patch 过的版本，无需重复打补丁。');
        return;
    }
    const consent = await vscode.window.showWarningMessage('将修改 Windsurf 应用本体的 dist/extension.js 以启用「无浏览器切号」（会写一份 .aliu-backup 备份）。继续吗？\n\n注：Windsurf 升级后需要重新打补丁。', { modal: true }, '继续');
    if (consent !== '继续') {
        return;
    }
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在为 Windsurf 打补丁...', cancellable: false }, () => (0, windsurfPatcher_1.applyPatch)());
    if (!r.success) {
        vscode.window.showErrorMessage(`补丁失败：${r.error}`);
        (0, log_1.log)(`patchWindsurf failed: ${r.error}`);
        return;
    }
    // Successful manual patch → re-enable autopilot for future activations.
    if (context)
        await context.globalState.update(PATCHER_FLAGS.userDisabled, false);
    if (r.alreadyApplied) {
        vscode.window.showInformationMessage('已是 patch 过的版本（重载窗口即生效）。');
        return;
    }
    (0, log_1.log)(`patchWindsurf applied → ${extPath}`);
    // showWarningMessage MUST be outside the withProgress callback so the
    // notification dismisses promptly and the user can see / click the prompt.
    const reload = await vscode.window.showWarningMessage('补丁已应用，需要重载窗口才能生效。', '重载窗口', '稍后');
    if (reload === '重载窗口') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}
async function cmdUnpatchWindsurf(context) {
    const extPath = (0, windsurfPatcher_1.findWindsurfExtensionPath)();
    if (!extPath) {
        vscode.window.showErrorMessage('未找到 Windsurf 核心扩展的 dist/extension.js');
        return;
    }
    if (!(0, windsurfPatcher_1.isPatchApplied)(extPath)) {
        // Patch already absent; remember the user's preference so autopilot
        // doesn't silently re-apply on the next activation.
        if (context)
            await context.globalState.update(PATCHER_FLAGS.userDisabled, true);
        vscode.window.showInformationMessage('当前没有 patch（已是原始 Windsurf）。已禁用自动打补丁（再次打补丁将重新启用）。');
        return;
    }
    const consent = await vscode.window.showWarningMessage('将从 .aliu-backup 恢复原始 Windsurf extension.js。继续吗？', { modal: true }, '继续');
    if (consent !== '继续') {
        return;
    }
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在恢复 Windsurf...', cancellable: false }, () => (0, windsurfPatcher_1.restorePatch)());
    if (!r.success) {
        vscode.window.showErrorMessage(`恢复失败：${r.error}`);
        return;
    }
    // User has explicitly unpatched → stop autopilot from re-applying.
    if (context)
        await context.globalState.update(PATCHER_FLAGS.userDisabled, true);
    const reload = await vscode.window.showWarningMessage('Windsurf 已恢复，需要重载窗口才能生效。后续「智能切号」将回退到浏览器登录路径。', '重载窗口', '稍后');
    if (reload === '重载窗口') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}
async function cmdCheckPatchStatus() {
    const extPath = (0, windsurfPatcher_1.findWindsurfExtensionPath)();
    if (!extPath) {
        vscode.window.showErrorMessage('未找到 Windsurf 核心扩展的 dist/extension.js');
        return;
    }
    const applied = (0, windsurfPatcher_1.isPatchApplied)(extPath);
    const cmdAvailable = (await vscode.commands.getCommands(true)).includes(windsurfPatcher_1.PATCH_COMMAND_ID);
    const lines = [
        `Windsurf 核心：${extPath}`,
        `补丁文件：${applied ? '已应用 ✓' : '未应用 ✗'}`,
        `运行时命令：${cmdAvailable ? '已注册 ✓（无浏览器切号可用）' : '未注册 ✗'}`,
    ];
    if (applied && !cmdAvailable) {
        lines.push('');
        lines.push('补丁已写入但运行时命令尚未注册——请重载窗口（Cmd+Shift+P → Developer: Reload Window）。');
    }
    if (!applied) {
        lines.push('');
        lines.push('运行 Windsurf Switch: 给 Windsurf 打补丁 启用无浏览器切号。');
    }
    vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
}
// ---------------------------------------------------------------------------
// Notification helpers — prefer short-lived status bar messages for success
// paths to stop the bottom-right from piling up.
// ---------------------------------------------------------------------------
function statusOk(msg) {
    vscode.window.setStatusBarMessage(`$(check) ${msg}`, 4000);
}
function statusWarn(msg) {
    vscode.window.setStatusBarMessage(`$(warning) ${msg}`, 5000);
}
// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------
async function pickAndSwitch(context, sidebar) {
    const accounts = sidebar.accounts.length > 0 ? sidebar.accounts : await (0, accountsStore_1.loadManagerAccounts)();
    if (!(0, accountsStore_1.accountsFileExists)() || accounts.length === 0) {
        const action = await vscode.window.showInformationMessage('还没有账号。现在添加一个？', '添加账号', '打开 accounts.json 目录');
        if (action === '添加账号') {
            await vscode.commands.executeCommand('windsurfSwitch.addAccount');
        }
        else if (action === '打开 accounts.json 目录') {
            await vscode.commands.executeCommand('windsurfSwitch.openAccountsFile');
        }
        return;
    }
    const usable = accounts.filter(isSwitchable);
    if (usable.length === 0) {
        vscode.window.showWarningMessage('暂无可切换账号：需要密码 / refreshToken / auth1Token 至少一项。可用「修复凭据」补充密码。');
        return;
    }
    const picks = usable
        .slice()
        .sort((a, b) => (b.lastQueryTime || '').localeCompare(a.lastQueryTime || ''))
        .map(a => ({
        label: a.email,
        description: a.remark ? `📝 ${a.remark}` : undefined,
        detail: describeAccount(a),
        account: a
    }));
    const pick = await vscode.window.showQuickPick(picks, {
        title: '切换 Windsurf 账号 (Windsurf 窗口不会关闭)',
        placeHolder: '选择目标账号'
    });
    if (!pick) {
        return;
    }
    await doSwitch(context, sidebar, pick.account);
}
async function switchById(context, sidebar, accountId) {
    const account = sidebar.findAccount(accountId) ?? (await (0, accountsStore_1.loadManagerAccounts)()).find(a => a.id === accountId);
    if (!account) {
        vscode.window.showErrorMessage(`找不到账号 id=${accountId}`);
        return;
    }
    await doSwitch(context, sidebar, account);
}
async function doSwitch(context, sidebar, account) {
    const previousAccountId = (await syncCurrentAccountFromSession(context, sidebar.accounts.length > 0 ? sidebar.accounts : undefined)).id;
    // ProgressLocation.Window = subtle spinner in the status bar, not a big
    // bottom-right toast that lingers.
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: `Windsurf: 切到 ${account.email}`,
        cancellable: false
    }, async (progress) => {
        try {
            progress.report({ message: '获取 IdToken...' });
            const idToken = await (0, tokens_1.ensureFreshIdToken)(context, account);
            progress.report({ message: '通知 Windsurf 切 session...' });
            const session = await (0, seamlessSwitch_1.seamlessSwitch)(idToken, { email: account.email, displayName: account.displayName });
            await setCurrentAccountId(context, account.id, 'doSwitch');
            await setActiveEmail(context, account.email, 'doSwitch');
            // Learn the label → email mapping so future external switches
            // (user logs in again via Windsurf UI, other windows, ...)
            // can be resolved even though the session carries no email.
            await rememberSessionLabel(context, session?.account?.label, account.email);
            // Stop polling from immediately re-triggering on the very next tick.
            autoSwitch?.noteExternalSwitch();
            statusOk(`已切到 ${session?.account?.label ?? account.email}`);
            (0, log_1.log)(`switched to ${session?.account?.label ?? account.email}`);
            if (previousAccountId && previousAccountId !== account.id) {
                void refreshAccountQuotaSilently(context, sidebar, previousAccountId);
            }
        }
        catch (e) {
            (0, log_1.log)('doSwitch failed:', e);
            await (0, tokens_1.invalidateToken)(context, account.id);
            vscode.window.showErrorMessage(`切号失败：${e?.message || e}`);
        }
        finally {
            await sidebar.reload();
        }
    });
}
async function cmdSwitchByIdToken() {
    const token = await vscode.window.showInputBox({
        title: '用 Firebase IdToken 切号 (调试)',
        prompt: '粘贴 Firebase IdToken',
        password: true,
        ignoreFocusOut: true
    });
    if (!token) {
        return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Windsurf: 切 session...' }, async () => {
        try {
            const session = await (0, seamlessSwitch_1.seamlessSwitch)(token);
            statusOk(`已切到 ${session?.account?.label ?? 'account'}`);
        }
        catch (e) {
            (0, log_1.log)('cmdSwitchByIdToken failed:', e);
            vscode.window.showErrorMessage(`切号失败：${e?.message || e}`);
        }
    });
}
// ---------------------------------------------------------------------------
// Add account
// ---------------------------------------------------------------------------
async function cmdAddAccount(sidebar) {
    // Prefer the in-sidebar modal overlay. `openModal` reveals the view
    // container, waits for the webview to resolve, then posts the open
    // message.
    await sidebar.openModal('add');
}
/**
 * Internal command invoked by the sidebar modal's "添加" button.
 * Validates args, runs the login + store flow, and reports back to the
 * webview so the modal can close or show an inline error.
 */
async function cmdSubmitAddFromModal(sidebar, args) {
    const email = (args?.email || '').trim();
    const password = args?.password || '';
    if (!email || !email.includes('@')) {
        sidebar.postModalError('请输入合法邮箱');
        return;
    }
    if (!password) {
        sidebar.postModalError('密码不能为空');
        return;
    }
    try {
        const result = await addOneAccount(email, password);
        sidebar.postModalClose();
        statusOk(`已添加 ${result.email}`);
        (0, log_1.log)(`addAccount(modal): ${result.email}`);
    }
    catch (e) {
        (0, log_1.log)('cmdSubmitAddFromModal failed:', e);
        sidebar.postModalError(String(e?.message || e));
    }
    finally {
        await sidebar.reload();
    }
}
/**
 * Shared helper used both by add single and batch import.
 * Tries Firebase first, falls back to Auth1 — see `windsurfApi.login`.
 */
async function addOneAccount(email, password) {
    const loginResult = await (0, windsurfApi_1.login)(email, password);
    const now = Date.now();
    const account = {
        id: `${now}-${crypto.randomBytes(3).toString('hex')}`,
        email,
        displayName: loginResult.displayName || '',
        authProvider: loginResult.authProvider || constants_1.FIREBASE_PROVIDER,
        accountId: loginResult.accountId || '',
        primaryOrgId: loginResult.primaryOrgId || '',
        password,
        idToken: loginResult.idToken,
        refreshToken: loginResult.refreshToken || '',
        auth1Token: loginResult.auth1Token || '',
        idTokenExpiresAt: now + loginResult.expiresInSeconds * 1000,
        createdAt: new Date().toISOString(),
        planName: 'Free',
        dailyRemainPct: null,
        weeklyRemainPct: null,
        dailyResetUnix: null,
        weeklyResetUnix: null,
        expiresAt: '',
        gracePeriodStatus: '',
        lastQueryTime: '',
        quotaError: false,
        remark: '',
        hasWindsurfSessionSnapshot: false,
        windsurfSessionCapturedAt: '',
        hasCredentials: true
    };
    await (0, accountsStore_1.addAccount)(account);
    // Keep the in-memory + SecretStorage cache in sync so this account works
    // immediately without a full kickoffBackgroundDecrypt pass.
    try {
        await (0, memoryCreds_1.putCreds)(account.id, {
            email: account.email,
            password: account.password,
            idToken: account.idToken,
            refreshToken: account.refreshToken,
            auth1Token: account.auth1Token,
            idTokenExpiresAt: account.idTokenExpiresAt
        });
    }
    catch (e) {
        (0, log_1.log)(`putCreds after addAccount failed for ${email}:`, e?.message || e);
    }
    try {
        const snap = await (0, windsurfApi_1.getPlanStatus)(loginResult.idToken);
        await (0, accountsStore_1.applySnapshot)(account.id, snap);
    }
    catch (e) {
        (0, log_1.log)(`initial getPlanStatus failed for ${email}:`, e?.message || e);
    }
    return account;
}
// ---------------------------------------------------------------------------
// Batch import  (port of desktop BatchImportWindow + MainWindowViewModel.BatchImportAsync)
// ---------------------------------------------------------------------------
async function cmdBatchImport(sidebar) {
    // Prefer the in-sidebar modal overlay; the textarea inside the modal
    // replaces the old openTextDocument + showInformationMessage flow.
    await sidebar.openModal('batch');
}
/**
 * Internal command invoked by the sidebar batch-import modal's
 * "开始导入" button. Parses the raw text with the existing importParser
 * and kicks off the shared progress-tracked import loop.
 */
async function cmdSubmitBatchFromModal(sidebar, args) {
    const text = args?.text || '';
    const pairs = (0, importParser_1.parseBatch)(text);
    if (pairs.length === 0) {
        statusWarn('没解析到任何账号');
        return;
    }
    await runBatchImport(sidebar, pairs);
}
async function runBatchImport(sidebar, pairs) {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `批量导入 0/${pairs.length}`,
        cancellable: true
    }, async (progress, token) => {
        let ok = 0;
        let skip = 0;
        let fail = 0;
        for (let i = 0; i < pairs.length; i++) {
            if (token.isCancellationRequested) {
                break;
            }
            const p = pairs[i];
            progress.report({
                message: `${i + 1}/${pairs.length} · ${p.email}`,
                increment: 100 / pairs.length
            });
            try {
                await addOneAccount(p.email, p.password);
                ok++;
            }
            catch (e) {
                const msg = String(e?.message || e);
                if (msg.includes('已存在')) {
                    skip++;
                }
                else {
                    fail++;
                    (0, log_1.log)(`batchImport failed for ${p.email}: ${msg}`);
                }
            }
        }
        vscode.window.showInformationMessage(`批量导入完成：新增 ${ok} · 跳过 ${skip} · 失败 ${fail}${fail ? ' (详见日志)' : ''}`);
        await sidebar.reload();
    });
}
// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
async function deleteById(context, sidebar, accountId) {
    const account = sidebar.findAccount(accountId);
    const label = account?.email || accountId;
    const confirmed = await vscode.window.showWarningMessage(`确定删除 ${label} 吗？此操作不可撤销。`, { modal: true }, '删除');
    if (confirmed !== '删除') {
        return;
    }
    try {
        await (0, accountsStore_1.deleteAccount)(accountId);
        await (0, tokens_1.invalidateToken)(context, accountId);
        await (0, memoryCreds_1.removeCreds)(accountId);
        statusOk(`已删除 ${label}`);
    }
    catch (e) {
        (0, log_1.log)('deleteById failed:', e);
        vscode.window.showErrorMessage(`删除失败：${e?.message || e}`);
    }
    finally {
        await sidebar.reload();
    }
}
// ---------------------------------------------------------------------------
// Remark
// ---------------------------------------------------------------------------
async function editRemarkById(sidebar, accountId) {
    const account = sidebar.findAccount(accountId);
    if (!account) {
        vscode.window.showErrorMessage('账号不存在，请刷新后重试');
        return;
    }
    const value = await vscode.window.showInputBox({
        title: `备注 - ${account.email}`,
        prompt: '最多 4 个字符',
        value: account.remark,
        ignoreFocusOut: true,
        validateInput: v => (v.length <= 4 ? undefined : '不超过 4 个字符')
    });
    if (value === undefined) {
        return;
    }
    try {
        await (0, accountsStore_1.updateRemark)(accountId, value);
        statusOk(`备注已保存`);
    }
    catch (e) {
        (0, log_1.log)('editRemarkById failed:', e);
        vscode.window.showErrorMessage(`修改失败：${e?.message || e}`);
    }
    finally {
        await sidebar.reload();
    }
}
// ---------------------------------------------------------------------------
// Credentials (解密后显示邮箱/密码，带复制按钮) — port of CredentialsWindow
// ---------------------------------------------------------------------------
async function showCredentials(sidebar, accountId) {
    const account = sidebar.findAccount(accountId);
    if (!account) {
        vscode.window.showErrorMessage('账号不存在，请刷新后重试');
        return;
    }
    await sidebar.openModal('creds', { id: accountId, email: account.email });
}
// ---------------------------------------------------------------------------
// Refresh plan / quota
// ---------------------------------------------------------------------------
function isMigratedPlanStatusError(error) {
    const msg = String(error?.message || error || '');
    return /has been migrated/i.test(msg) || /please log in again/i.test(msg);
}
async function getPlanStatusWithRecovery(context, account) {
    const idToken = await (0, tokens_1.ensureFreshIdToken)(context, account);
    try {
        return await (0, windsurfApi_1.getPlanStatus)(idToken);
    }
    catch (e) {
        if (!isMigratedPlanStatusError(e)) {
            throw e;
        }
        (0, log_1.log)(`getPlanStatus requires re-login for ${account.email}:`, e?.message || e);
        try {
            await (0, tokens_1.invalidateToken)(context, account.id);
        }
        catch {
            // ignore
        }
        const retryToken = await (0, tokens_1.ensureFreshIdToken)(context, account, {
            forceRelogin: true,
            preferAuth1: true
        });
        return await (0, windsurfApi_1.getPlanStatus)(retryToken);
    }
}
async function refreshOne(context, sidebar, accountId) {
    let account = sidebar.findAccount(accountId);
    if (!account) {
        const all = await (0, accountsStore_1.loadManagerAccounts)();
        account = all.find(a => a.id === accountId);
    }
    if (!account) {
        vscode.window.showErrorMessage('账号不存在');
        return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Windsurf: 刷新 ${account.email}...` }, async () => {
        try {
            const snap = await getPlanStatusWithRecovery(context, account);
            await (0, accountsStore_1.applySnapshot)(account.id, snap);
            statusOk(`${account.email}: ${snap.planName} · 日${snap.dailyRemainPct ?? '-'}% · 周${snap.weeklyRemainPct ?? '-'}%`);
        }
        catch (e) {
            (0, log_1.log)('refreshOne failed:', e);
            try {
                await (0, accountsStore_1.markQuotaError)(account.id);
            }
            catch {
                // ignore
            }
            vscode.window.showErrorMessage(`${account.email}: ${e?.message || e}`);
        }
        finally {
            await sidebar.reload();
        }
    });
}
const REFRESH_ALL_CONCURRENCY = 4;
async function refreshAll(context, sidebar) {
    const accounts = await (0, accountsStore_1.loadManagerAccounts)();
    if (accounts.length === 0) {
        return;
    }
    // 按用户要求：刷新全部时总是清空智能切号冷却池。
    await clearSmartHistory(context);
    // Free 账号节流：counter % N === 0 的那一轮才把 Free 纳入刷新。
    const counter = (context.globalState.get(GS.refreshAllCounter) || 0) + 1;
    await context.globalState.update(GS.refreshAllCounter, counter);
    const includeFree = counter % FREE_REFRESH_EVERY_N === 0;
    const switchable = accounts
        .filter(isSwitchable)
        .filter(a => includeFree || (a.planName || '').toLowerCase() !== 'free');
    if (switchable.length === 0) {
        // 只有 Free 且本轮被跳过，或者没有任何可刷账号。
        if (!includeFree && accounts.some(a => (a.planName || '').toLowerCase() === 'free')) {
            statusOk(`本轮跳过 Free 账号（每 ${FREE_REFRESH_EVERY_N} 次刷新 1 次）`);
        }
        else {
            vscode.window.showInformationMessage('没有可刷新的账号');
        }
        // 即使不刷，也通知 sidebar 刷新一下（冷却已清）
        await sidebar.reload();
        return;
    }
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `批量刷新 0/${switchable.length}`,
        cancellable: true
    }, async (progress, token) => {
        const total = switchable.length;
        const results = [];
        let done = 0;
        let failed = 0;
        let index = 0;
        async function worker() {
            while (!token.isCancellationRequested) {
                const i = index++;
                if (i >= total)
                    return;
                const account = switchable[i];
                try {
                    const snap = await getPlanStatusWithRecovery(context, account);
                    results.push({ accountId: account.id, snapshot: snap });
                }
                catch (e) {
                    (0, log_1.log)(`refreshAll: ${account.email} failed -`, e?.message || e);
                    failed++;
                    results.push({ accountId: account.id, error: true });
                }
                done++;
                progress.report({
                    message: `${done}/${total} · ${account.email}`,
                    increment: 100 / total
                });
            }
        }
        const concurrency = Math.min(REFRESH_ALL_CONCURRENCY, total);
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        try {
            await (0, accountsStore_1.applyManySnapshots)(results);
        }
        catch (e) {
            (0, log_1.log)('applyManySnapshots failed:', e?.message || e);
        }
        vscode.window.showInformationMessage(`批量刷新完成：成功 ${done - failed} · 失败 ${failed}`);
        await sidebar.reload();
    });
}
// ---------------------------------------------------------------------------
// Fix credentials: prompt for password, login, and overwrite idToken/refreshToken/password.
// ---------------------------------------------------------------------------
async function fixCredentialsById(sidebar, accountId) {
    const records = await (0, accountsStore_1.loadAccountsEncrypted)();
    const rec = records.find(r => r.id === accountId);
    if (!rec) {
        vscode.window.showErrorMessage('账号不存在');
        return;
    }
    const email = rec.email || '';
    if (!email) {
        vscode.window.showErrorMessage('账号缺失邮箱，无法修复。请先删除后重新添加。');
        return;
    }
    const password = await vscode.window.showInputBox({
        title: `修复凭据 - ${email}`,
        prompt: '输入该账号的密码（用于重新登录并获取 refreshToken）',
        password: true,
        ignoreFocusOut: true
    });
    if (!password) {
        return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Windsurf: 重新登录 ${email}...` }, async () => {
        try {
            const login = await (0, windsurfApi_1.login)(email, password);
            const expiresAt = Date.now() + login.expiresInSeconds * 1000;
            await (0, accountsStore_1.applyLoginTokens)(accountId, login.idToken, login.refreshToken, expiresAt, login.displayName || rec.displayName || '', password, login.authProvider, login.auth1Token || '', login.accountId || '', login.primaryOrgId || '');
            await (0, memoryCreds_1.putCreds)(accountId, {
                email,
                password,
                idToken: login.idToken,
                refreshToken: login.refreshToken || '',
                auth1Token: login.auth1Token || '',
                idTokenExpiresAt: expiresAt
            });
            await (0, memoryCreds_1.updateTokenFields)(accountId, login.idToken, login.refreshToken || '', expiresAt);
            statusOk(`已修复 ${email} 的凭据`);
        }
        catch (e) {
            (0, log_1.log)('fixCredentialsById failed:', e);
            vscode.window.showErrorMessage(`修复失败：${e?.message || e}`);
        }
        finally {
            await sidebar.reload();
        }
    });
}
// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
async function cmdListAccounts() {
    const accounts = await (0, accountsStore_1.loadManagerAccounts)();
    const channel = (0, log_1.getOutputChannel)();
    channel.show(true);
    (0, log_1.log)('--- Accounts ---');
    if (accounts.length === 0) {
        (0, log_1.log)('(empty)');
        return;
    }
    for (const a of accounts) {
        (0, log_1.log)(`- ${a.email}`, `[${a.authProvider}]`, a.displayName ? `(${a.displayName})` : '', `plan=${a.planName}`, `d=${a.dailyRemainPct ?? '-'}%`, `w=${a.weeklyRemainPct ?? '-'}%`, a.remark ? `note=${a.remark}` : '', a.lastQueryTime ? `updated=${a.lastQueryTime}` : '');
    }
}
function isSwitchable(a) {
    if (!a.email) {
        return false;
    }
    const provider = (a.authProvider || constants_1.FIREBASE_PROVIDER).toLowerCase();
    if (provider !== constants_1.FIREBASE_PROVIDER && provider !== constants_1.AUTH1_PROVIDER) {
        return false;
    }
    return a.hasCredentials;
}
function describeAccount(a) {
    const parts = [];
    if (a.planName) {
        parts.push(`plan: ${a.planName}`);
    }
    if (a.dailyRemainPct !== null) {
        parts.push(`日 ${a.dailyRemainPct}%`);
    }
    if (a.weeklyRemainPct !== null) {
        parts.push(`周 ${a.weeklyRemainPct}%`);
    }
    if (a.remark) {
        parts.push(`备注: ${a.remark}`);
    }
    return parts.join(' · ');
}
async function runSmartSwitch(context, sidebar, opts) {
    const allAccounts = sidebar.accounts.length > 0 ? sidebar.accounts : await (0, accountsStore_1.loadManagerAccounts)();
    await syncCurrentAccountFromSession(context, allAccounts.length > 0 ? allAccounts : undefined);
    // Pick the candidate source: explicit > sidebar cache > all.
    let source = allAccounts;
    const ids = opts.filteredIds ?? sidebar.getLastCandidateIds();
    if (ids && ids.length > 0) {
        const set = new Set(ids);
        source = allAccounts.filter(a => set.has(a.id));
    }
    const history = getSmartHistory(context);
    const previousAccountId = getCurrentAccountId(context);
    const decision = (0, smartSwitch_1.decide)({
        accounts: source,
        currentAccountId: previousAccountId,
        history
    });
    if (!decision.picked) {
        const msg = `智能切号：${decision.reason}`;
        if (opts.trigger === 'manual') {
            vscode.window.showWarningMessage(msg);
        }
        else {
            vscode.window.setStatusBarMessage(`$(warning) ${msg}`, 30000);
            (0, log_1.log)(msg);
        }
        return false;
    }
    const tried = [];
    for (const cand of decision.candidates.slice(0, 3)) {
        tried.push(cand.email);
        try {
            const idToken = await (0, tokens_1.ensureFreshIdToken)(context, cand);
            const session = await (0, seamlessSwitch_1.seamlessSwitch)(idToken, { email: cand.email, displayName: cand.displayName });
            await setCurrentAccountId(context, cand.id, 'smartSwitch');
            await setActiveEmail(context, cand.email, 'smartSwitch');
            await rememberSessionLabel(context, session?.account?.label, cand.email);
            const newHistory = (0, smartSwitch_1.recordSwitch)(history, cand.id);
            await saveSmartHistory(context, newHistory);
            autoSwitch?.noteExternalSwitch();
            const label = opts.trigger === 'manual' ? '智能切号' : `自动·${opts.trigger}`;
            const msg = `[${label}] 已切到 ${cand.email} · ${decision.reason}`;
            if (opts.trigger === 'manual') {
                statusOk(msg);
            }
            else {
                vscode.window.showInformationMessage(msg);
            }
            (0, log_1.log)(msg);
            await sidebar.reload();
            // Refresh the previous account's quota so the candidate pool reflects
            // accurate numbers next time. Fire-and-forget: do NOT block the
            // switch UX, and do NOT touch the cooldown history.
            if (previousAccountId && previousAccountId !== cand.id) {
                void refreshAccountQuotaSilently(context, sidebar, previousAccountId);
            }
            return true;
        }
        catch (e) {
            (0, log_1.log)(`smartSwitch: candidate ${cand.email} failed -`, e?.message || e);
            try {
                await (0, tokens_1.invalidateToken)(context, cand.id);
            }
            catch {
                /* ignore */
            }
        }
    }
    const failMsg = `智能切号失败：尝试 ${tried.length} 个候选均失败（${tried.join(', ')}）`;
    vscode.window.showErrorMessage(failMsg);
    (0, log_1.log)(failMsg);
    await sidebar.reload();
    return false;
}
/**
 * Query plan-status for the current account. Returns null if no current account
 * is known. Throws on network / API errors so AutoSwitch can count failures.
 */
async function probeCurrentQuota(context) {
    const synced = await syncCurrentAccountFromSession(context, sidebar && sidebar.accounts.length > 0 ? sidebar.accounts : undefined);
    const id = synced.id ?? getCurrentAccountId(context);
    if (!id)
        return null;
    const accounts = sidebar && sidebar.accounts.length > 0
        ? sidebar.accounts
        : await (0, accountsStore_1.loadManagerAccounts)();
    const acc = accounts.find(a => a.id === id);
    if (!acc)
        return null;
    const snap = await getPlanStatusWithRecovery(context, acc);
    await (0, accountsStore_1.applySnapshot)(id, snap);
    // Fire-and-forget reload so UI reflects the polled values.
    void sidebar?.reload();
    // 触发阈值开关：关闭时 polling 仍然刷新数据，但不触发切号。
    // 默认 true，向后兼容已有用户。
    const thresholdEnabled = context.globalState.get(autoSwitch_1.STATE_KEYS.lowQuotaThresholdEnabled, true);
    if (!thresholdEnabled) {
        return { dailyZero: false, weeklyZero: false, error: false };
    }
    // 触发阈值：Windsurf 后端在余量降到 0% 前就开始拒请求（缓存 + 阈值保护），
    // 等到精确归零才切已经晚。阈值用户可在 sidebar 调整，默认 10%。
    const threshold = context.globalState.get(autoSwitch_1.STATE_KEYS.lowQuotaThreshold, autoSwitch_1.DEFAULT_LOW_QUOTA_THRESHOLD);
    const dailyZero = typeof snap.dailyRemainPct === 'number' && snap.dailyRemainPct < threshold;
    const weeklyZero = typeof snap.weeklyRemainPct === 'number' && snap.weeklyRemainPct < threshold;
    return { dailyZero, weeklyZero, error: false };
}
/**
 * Refresh a single account's plan/quota snapshot without any UI noise.
 * Used right after a smart switch to update the "previous" account so the
 * candidate pool stays fresh. Never touches smartHistory / cooldowns.
 */
async function refreshAccountQuotaSilently(context, sidebar, accountId) {
    try {
        const accounts = await (0, accountsStore_1.loadManagerAccounts)();
        const acc = accounts.find(a => a.id === accountId);
        if (!acc || !isSwitchable(acc))
            return;
        const snap = await getPlanStatusWithRecovery(context, acc);
        await (0, accountsStore_1.applySnapshot)(accountId, snap);
        (0, log_1.log)(`post-switch refresh: ${acc.email} d=${snap.dailyRemainPct ?? '-'}% w=${snap.weeklyRemainPct ?? '-'}%`);
    }
    catch (e) {
        (0, log_1.log)(`post-switch refresh of ${accountId} failed:`, e?.message || e);
        try {
            await (0, accountsStore_1.markQuotaError)(accountId);
        }
        catch { /* ignore */ }
    }
    finally {
        void sidebar.reload();
    }
}
async function cmdSmartSwitch(context, sidebar) {
    await runSmartSwitch(context, sidebar, { trigger: 'manual' });
}
/**
 * Debug helper: dump everything we can learn about the current Windsurf
 * auth session to the Output channel. Invoked via the command palette
 * ("Windsurf: 诊断登录会话") when account identification is misbehaving.
 *
 * Never prints the raw accessToken — only its first 12 characters and the
 * decoded JWT claim keys / values, redacted for long tokens.
 */
async function cmdDiagnoseSession(context) {
    // Clear the diagnose-once cache so extractEmailFromSession re-logs.
    _sessionDiagnoseCache.clear();
    const lines = [];
    lines.push('--- Windsurf session diagnose ---');
    lines.push(`cached currentAccountId = ${getCurrentAccountId(context) ?? '∅'}`);
    lines.push(`cached activeEmail      = ${getActiveEmail(context) ?? '∅'}`);
    const accounts = await (0, accountsStore_1.loadManagerAccounts)();
    const sharedAuth = readSharedJsonObject(context, 'windsurfAuthStatus');
    lines.push(`shared windsurfAuthStatus = ${!sharedAuth.exists ? 'unavailable' : sharedAuth.value ? 'present' : 'null'}`);
    lines.push(`shared extracted email  = ${extractEmailFromSharedAuthStatus(context, accounts, getActiveEmail(context)) ?? '(null)'}`);
    lines.push(`shared lastLoginEmail   = ${readSharedLastLoginEmail(context) ?? '(null)'}`);
    // Silent probe first (the same call we use throughout).
    const silent = await resolveActiveSession();
    lines.push(`silent getSession: ${silent ? 'found' : 'undefined'}`);
    if (silent)
        dumpSession(silent, 'silent', lines);
    // Non-silent as well, in case the extension doesn't have permission yet.
    try {
        const prompted = await vscode.authentication.getSession(constants_1.WINDSURF_AUTH_PROVIDER_ID, ['Login'], { createIfNone: false });
        if (prompted && prompted.id !== silent?.id) {
            dumpSession(prompted, 'prompted', lines);
        }
    }
    catch (e) {
        lines.push(`prompted getSession threw: ${e?.message || e}`);
    }
    lines.push(`accounts.json count = ${accounts.length}`);
    lines.push('accounts emails: ' + accounts.map(a => a.email).join(', '));
    const map = getSessionLabelMap(context);
    const mapEntries = Object.entries(map);
    lines.push(`sessionLabelMap (${mapEntries.length} entries):`);
    for (const [k, v] of mapEntries) {
        lines.push(`  "${k}" → ${v}`);
    }
    lines.push('--- end diagnose ---');
    const channel = (0, log_1.getOutputChannel)();
    for (const l of lines)
        channel.appendLine(l);
    channel.show(true);
}
/**
 * "认领当前登录"：Windsurf 的 session 不带邮箱，所以当用户通过别的方式换号
 * 导致 label 无法对应到 accounts.json 里的账号时，这里让用户手动选一次，
 * 把 "display-name → email" 写进 sessionLabelMap。之后自动识别就能工作。
 */
async function cmdClaimCurrentSession(context, sidebar) {
    const session = await resolveActiveSession();
    if (!session) {
        vscode.window.showWarningMessage('Windsurf 当前没有活动的登录会话。');
        return;
    }
    const label = session.account?.label || session.account?.id || '';
    const accounts = sidebar.accounts.length > 0 ? sidebar.accounts : await (0, accountsStore_1.loadManagerAccounts)();
    if (accounts.length === 0) {
        vscode.window.showWarningMessage('账号列表为空，请先导入账号。');
        return;
    }
    const items = accounts
        .slice()
        .sort((a, b) => a.email.localeCompare(b.email))
        .map(a => ({ label: a.email, description: a.remark || '', detail: a.planName || '', id: a.id }));
    const picked = await vscode.window.showQuickPick(items, {
        title: `Windsurf 登录为 "${label}"，请选择对应的账号（会记住这个映射）`,
        placeHolder: '输入邮箱关键字过滤，回车确认',
        matchOnDescription: true,
        matchOnDetail: true
    });
    if (!picked)
        return;
    await rememberSessionLabel(context, label, picked.label);
    // Now immediately reflect the claim in UI.
    await setCurrentAccountId(context, picked.id, 'claimCurrent');
    await setActiveEmail(context, picked.label, 'claimCurrent');
    await sidebar.reload();
    vscode.window.showInformationMessage(`已认领：${label} → ${picked.label}`);
    (0, log_1.log)(`claim: "${label}" → ${picked.label}`);
}
function dumpSession(session, tag, out) {
    const token = session.accessToken || '';
    out.push(`[${tag}] session.id          = ${session.id}`);
    out.push(`[${tag}] account.id          = ${session.account?.id ?? ''}`);
    out.push(`[${tag}] account.label       = ${session.account?.label ?? ''}`);
    out.push(`[${tag}] scopes              = ${(session.scopes || []).join(',')}`);
    out.push(`[${tag}] accessToken prefix  = ${token.slice(0, 12)}…(len=${token.length})`);
    const payload = decodeJwtPayload(token);
    if (!payload) {
        out.push(`[${tag}] JWT decode          = FAILED (token is likely opaque, not JWT)`);
        return;
    }
    out.push(`[${tag}] JWT claim keys      = ${Object.keys(payload).join(',')}`);
    for (const k of ['email', 'preferred_username', 'upn', 'name', 'user_id', 'sub']) {
        if (k in payload)
            out.push(`[${tag}] jwt.${k} = ${String(payload[k])}`);
    }
    const extracted = extractEmailFromSession(session);
    out.push(`[${tag}] extracted email     = ${extracted ?? '(null)'}`);
}
/**
 * User clicked "刷新" on the current-account card.
 * Flow:
 *   1. Re-probe Windsurf's auth session (authoritative).
 *   2. If it matches our cached id → just refresh that account's quota.
 *   3. If it differs → update the cached id/email first, then refresh the
 *      new account. The user sees the correct card the moment we reload.
 *   4. If the session's email is not in our account list → warn but do not
 *      silently refresh the stale id.
 */
async function cmdRefreshCurrentSynced(context, sidebar) {
    const { id, email } = await syncCurrentAccountFromSession(context, sidebar.accounts.length > 0 ? sidebar.accounts : undefined);
    // Reload immediately so the sidebar reflects any id/email correction
    // before we spend time hitting the plan-status API.
    await sidebar.reload();
    if (!id) {
        const looksLikeEmail = !!email && /@/.test(email);
        if (looksLikeEmail) {
            vscode.window.showWarningMessage(`当前 Windsurf 登录账号 ${email} 不在扩展账号列表里，无法刷新额度。请先导入该账号。`);
        }
        else if (email) {
            vscode.window.showWarningMessage(`Windsurf 当前登录状态尚未同步出可识别的邮箱（当前显示：${email}）。请稍后重试；若持续失败请执行「诊断登录会话（调试）」。`);
        }
        else {
            vscode.window.showWarningMessage('未检测到 Windsurf 当前登录会话。');
        }
        return;
    }
    await vscode.commands.executeCommand('windsurfSwitch.refreshAccount', id);
}
async function cmdSmartSwitchFromSidebar(context, sidebar, args) {
    const ids = Array.isArray(args?.filteredIds) ? args.filteredIds : undefined;
    await runSmartSwitch(context, sidebar, { trigger: 'manual', filteredIds: ids });
}
async function cmdResetSmartCooldown(context, sidebar) {
    await clearSmartHistory(context);
    statusOk('已重置智能切号冷却');
    await sidebar.reload();
}
async function cmdEditLogPatterns(context) {
    const current = context.globalState.get(autoSwitch_1.STATE_KEYS.logWatchPatterns, autoSwitch_1.DEFAULT_LOG_PATTERNS);
    const raw = await vscode.window.showInputBox({
        title: '日志监控关键词（每行 1 个正则；留空恢复默认）',
        value: current.join('\n'),
        prompt: '写入后立即生效。恢复默认留空即可。',
        ignoreFocusOut: true
    });
    if (raw === undefined)
        return;
    const next = raw
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
    const final = next.length > 0 ? next : autoSwitch_1.DEFAULT_LOG_PATTERNS;
    await autoSwitch?.setLogWatchPatterns(final);
    statusOk(`已更新 ${final.length} 条日志关键词`);
}
async function cmdToggleAuto(context, sidebar, args) {
    if (!autoSwitch)
        return;
    if (args?.kind === 'polling') {
        await autoSwitch.setPollingEnabled(!!args.enabled);
    }
    else if (args?.kind === 'logWatch') {
        await autoSwitch.setLogWatchEnabled(!!args.enabled);
    }
    else if (args?.kind === 'threshold') {
        // 阈值开关不影响 timer，只改 globalState。probeCurrentQuota 会读它。
        await context.globalState.update(autoSwitch_1.STATE_KEYS.lowQuotaThresholdEnabled, !!args.enabled);
    }
    await sidebar.reload();
}
async function cmdSetPollingInterval(context, sidebar, args) {
    if (!autoSwitch)
        return;
    const ms = args?.intervalMs;
    if (typeof ms !== 'number' || ms < 15000)
        return;
    await autoSwitch.setPollingInterval(ms);
    await sidebar.reload();
}
// 设置自动切号触发阈值（余量百分比）。由 sidebar 输入框调用。
// 范围 0-99，与前端 UI (input maxlength=2) 对齐。
async function cmdSetLowQuotaThreshold(context, sidebar, args) {
    const v = args?.threshold;
    if (typeof v !== 'number' || v < 0 || v > 99)
        return;
    await context.globalState.update(autoSwitch_1.STATE_KEYS.lowQuotaThreshold, v);
    await sidebar?.reload();
}
//# sourceMappingURL=extension.js.map