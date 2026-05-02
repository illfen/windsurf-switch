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
exports.AutoSwitch = exports.DEFAULT_LOG_PATTERNS = exports.LOG_WATCH_DEBOUNCE_MS = exports.LOG_SAME_ACCOUNT_DEBOUNCE_MS = exports.AUTO_SWITCH_THROTTLE_MS = exports.DEFAULT_POLLING_INTERVAL_MS = exports.STATE_KEYS = void 0;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const log_1 = require("./log");
/**
 * Keys in globalState.
 * Keep in sync with extension.ts.
 */
exports.STATE_KEYS = {
    pollingEnabled: 'wm.auto.polling.enabled',
    pollingIntervalMs: 'wm.auto.polling.intervalMs',
    logWatchEnabled: 'wm.auto.logWatch.enabled',
    logWatchPatterns: 'wm.auto.logWatch.patterns'
};
exports.DEFAULT_POLLING_INTERVAL_MS = 2 * 60 * 1000;
exports.AUTO_SWITCH_THROTTLE_MS = 10 * 1000; // 10s throttle: auto triggers skip;
// manual switch bypasses this window.
exports.LOG_SAME_ACCOUNT_DEBOUNCE_MS = 30 * 1000; // same-account duplicate match debounce
exports.LOG_WATCH_DEBOUNCE_MS = 200; // fs.watch event coalesce
exports.DEFAULT_LOG_PATTERNS = [
    '"code"\\s*:\\s*"(quota_exhausted|usage_limit_reached|rate_limit_exceeded)"',
    '"status"\\s*:\\s*(402|429)\\b',
    '\\buser_quota_exhausted\\b',
    '\\bplan_quota_exceeded\\b'
];
// ---------------------------------------------------------------------------
// Windsurf log directory resolution
// ---------------------------------------------------------------------------
function getWindsurfLogRoot() {
    // Windows: %APPDATA%\Windsurf\logs
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA;
        return appData ? path.join(appData, 'Windsurf', 'logs') : null;
    }
    // macOS: ~/Library/Application Support/Windsurf/logs
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf', 'logs');
    }
    // Linux: ~/.config/Windsurf/logs
    return path.join(os.homedir(), '.config', 'Windsurf', 'logs');
}
/** Return absolute path to the most recently modified subdirectory under root. */
function findLatestSessionDir(root) {
    try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        let best = null;
        for (const e of entries) {
            if (!e.isDirectory())
                continue;
            const p = path.join(root, e.name);
            try {
                const st = fs.statSync(p);
                if (!best || st.mtimeMs > best.mtime) {
                    best = { path: p, mtime: st.mtimeMs };
                }
            }
            catch {
                // ignore
            }
        }
        return best?.path ?? null;
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// AutoSwitch controller
// ---------------------------------------------------------------------------
class AutoSwitch {
    ctx;
    deps;
    _pollingTimer = null;
    _pollingFailStreak = 0;
    _logRootWatcher = null;
    _logSessionWatcher = null;
    _logSessionDir = null;
    _logFileOffsets = new Map();
    _logMatchPatterns = [];
    _logScanTimer = null;
    _lastLogMatchByAccount = new Map();
    _lastAutoSwitchMs = 0;
    _disposed = false;
    constructor(ctx, deps) {
        this.ctx = ctx;
        this.deps = deps;
    }
    // ----------------- State accessors ------------------
    getState() {
        return {
            polling: {
                enabled: this.ctx.globalState.get(exports.STATE_KEYS.pollingEnabled, false),
                intervalMs: this.ctx.globalState.get(exports.STATE_KEYS.pollingIntervalMs, exports.DEFAULT_POLLING_INTERVAL_MS)
            },
            logWatch: {
                enabled: this.ctx.globalState.get(exports.STATE_KEYS.logWatchEnabled, false),
                patterns: this.ctx.globalState.get(exports.STATE_KEYS.logWatchPatterns, exports.DEFAULT_LOG_PATTERNS)
            }
        };
    }
    /** Start whichever monitors are currently enabled in globalState. */
    start() {
        const s = this.getState();
        if (s.polling.enabled)
            this.startPolling(s.polling.intervalMs);
        if (s.logWatch.enabled)
            this.startLogWatch(s.logWatch.patterns);
    }
    dispose() {
        this._disposed = true;
        this.stopPolling();
        this.stopLogWatch();
    }
    // ----------------- Polling ------------------
    async setPollingEnabled(enabled) {
        await this.ctx.globalState.update(exports.STATE_KEYS.pollingEnabled, enabled);
        if (enabled) {
            const ms = this.ctx.globalState.get(exports.STATE_KEYS.pollingIntervalMs, exports.DEFAULT_POLLING_INTERVAL_MS);
            this.startPolling(ms);
        }
        else {
            this.stopPolling();
        }
    }
    async setPollingInterval(intervalMs) {
        const clean = Math.max(15_000, intervalMs | 0);
        await this.ctx.globalState.update(exports.STATE_KEYS.pollingIntervalMs, clean);
        if (this._pollingTimer) {
            // Restart at new rate.
            this.stopPolling();
            this.startPolling(clean);
        }
    }
    startPolling(intervalMs) {
        this.stopPolling();
        (0, log_1.log)(`autoSwitch: polling started, interval=${intervalMs}ms`);
        // Fire one tick immediately to give quick feedback after user toggles.
        void this.pollTick();
        this._pollingTimer = setInterval(() => void this.pollTick(), intervalMs);
    }
    stopPolling() {
        if (this._pollingTimer) {
            clearInterval(this._pollingTimer);
            this._pollingTimer = null;
        }
    }
    async pollTick() {
        if (this._disposed)
            return;
        const currentId = this.deps.getCurrentAccountId();
        if (!currentId)
            return;
        try {
            const probe = await this.deps.probeCurrentQuota();
            this._pollingFailStreak = 0;
            if (!probe)
                return;
            if (probe.error || probe.dailyZero || probe.weeklyZero) {
                (0, log_1.log)(`autoSwitch: polling triggered switch (daily0=${probe.dailyZero} weekly0=${probe.weeklyZero} err=${probe.error})`);
                await this.runTrigger('polling');
            }
        }
        catch (e) {
            this._pollingFailStreak++;
            (0, log_1.log)(`autoSwitch: poll failed (${this._pollingFailStreak}):`, e?.message || e);
            if (this._pollingFailStreak === 5) {
                vscode.window.setStatusBarMessage('$(warning) 自动切号轮询：连续 5 次失败，请检查网络或 idToken', 60_000);
            }
        }
    }
    // ----------------- Log Watch ------------------
    async setLogWatchEnabled(enabled) {
        await this.ctx.globalState.update(exports.STATE_KEYS.logWatchEnabled, enabled);
        if (enabled) {
            const patterns = this.ctx.globalState.get(exports.STATE_KEYS.logWatchPatterns, exports.DEFAULT_LOG_PATTERNS);
            this.startLogWatch(patterns);
        }
        else {
            this.stopLogWatch();
        }
    }
    async setLogWatchPatterns(patterns) {
        await this.ctx.globalState.update(exports.STATE_KEYS.logWatchPatterns, patterns);
        if (this._logSessionWatcher) {
            // Rebuild compiled patterns.
            this.compilePatterns(patterns);
        }
    }
    compilePatterns(patterns) {
        this._logMatchPatterns = [];
        for (const p of patterns) {
            try {
                this._logMatchPatterns.push(new RegExp(p, 'i'));
            }
            catch (e) {
                (0, log_1.log)(`autoSwitch: invalid log pattern skipped "${p}":`, e?.message || e);
            }
        }
    }
    startLogWatch(patterns) {
        this.stopLogWatch();
        const root = getWindsurfLogRoot();
        if (!root || !fs.existsSync(root)) {
            (0, log_1.log)(`autoSwitch: logWatch root not found: ${root}`);
            return;
        }
        this.compilePatterns(patterns);
        if (this._logMatchPatterns.length === 0) {
            (0, log_1.log)('autoSwitch: logWatch has no valid patterns; not starting');
            return;
        }
        const initialSession = findLatestSessionDir(root);
        if (initialSession) {
            this.attachSessionWatcher(initialSession);
        }
        (0, log_1.log)(`autoSwitch: logWatch started under ${root}, session=${initialSession || 'none'}`);
        // Watch the root to detect new session folders (Windsurf creates a fresh
        // timestamped directory on each launch).
        try {
            this._logRootWatcher = fs.watch(root, { persistent: false }, () => {
                const latest = findLatestSessionDir(root);
                if (latest && latest !== this._logSessionDir) {
                    (0, log_1.log)(`autoSwitch: logWatch session rotated -> ${latest}`);
                    this.attachSessionWatcher(latest);
                }
            });
        }
        catch (e) {
            (0, log_1.log)('autoSwitch: fs.watch root failed:', e?.message || e);
        }
    }
    stopLogWatch() {
        if (this._logRootWatcher) {
            try {
                this._logRootWatcher.close();
            }
            catch { /* ignore */ }
            this._logRootWatcher = null;
        }
        if (this._logSessionWatcher) {
            try {
                this._logSessionWatcher.close();
            }
            catch { /* ignore */ }
            this._logSessionWatcher = null;
        }
        if (this._logScanTimer) {
            clearTimeout(this._logScanTimer);
            this._logScanTimer = null;
        }
        this._logSessionDir = null;
        this._logFileOffsets.clear();
    }
    attachSessionWatcher(dir) {
        if (this._logSessionWatcher) {
            try {
                this._logSessionWatcher.close();
            }
            catch { /* ignore */ }
            this._logSessionWatcher = null;
        }
        this._logSessionDir = dir;
        this._logFileOffsets.clear();
        // Seed offsets to current file sizes — we only care about new data
        // written after watch start, not existing history (which may contain
        // historic quota errors from previous sessions).
        try {
            for (const name of fs.readdirSync(dir)) {
                if (!name.endsWith('.log'))
                    continue;
                const fp = path.join(dir, name);
                try {
                    const st = fs.statSync(fp);
                    this._logFileOffsets.set(fp, st.size);
                }
                catch { /* ignore */ }
            }
        }
        catch { /* ignore */ }
        try {
            this._logSessionWatcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
                if (!filename || !String(filename).endsWith('.log'))
                    return;
                this.scheduleLogScan();
            });
        }
        catch (e) {
            (0, log_1.log)('autoSwitch: fs.watch session dir failed:', e?.message || e);
        }
    }
    scheduleLogScan() {
        if (this._logScanTimer)
            return;
        this._logScanTimer = setTimeout(() => {
            this._logScanTimer = null;
            void this.scanLogs();
        }, exports.LOG_WATCH_DEBOUNCE_MS);
    }
    async scanLogs() {
        const dir = this._logSessionDir;
        if (!dir || this._logMatchPatterns.length === 0)
            return;
        let hit = false;
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.log'))
                continue;
            const fp = path.join(dir, name);
            let st;
            try {
                st = fs.statSync(fp);
            }
            catch {
                continue;
            }
            const prev = this._logFileOffsets.get(fp) ?? 0;
            if (st.size < prev) {
                // file was truncated / rotated
                this._logFileOffsets.set(fp, 0);
            }
            const start = this._logFileOffsets.get(fp) ?? 0;
            if (st.size <= start)
                continue;
            try {
                const fd = fs.openSync(fp, 'r');
                try {
                    const buf = Buffer.alloc(st.size - start);
                    fs.readSync(fd, buf, 0, buf.length, start);
                    const text = buf.toString('utf8');
                    this._logFileOffsets.set(fp, st.size);
                    if (this.textMatchesAnyPattern(text)) {
                        hit = true;
                    }
                }
                finally {
                    fs.closeSync(fd);
                }
            }
            catch (e) {
                (0, log_1.log)(`autoSwitch: read ${fp} failed:`, e?.message || e);
            }
            if (hit)
                break;
        }
        if (hit) {
            const id = this.deps.getCurrentAccountId();
            if (!id)
                return;
            const last = this._lastLogMatchByAccount.get(id) ?? 0;
            if (Date.now() - last < exports.LOG_SAME_ACCOUNT_DEBOUNCE_MS) {
                return;
            }
            this._lastLogMatchByAccount.set(id, Date.now());
            (0, log_1.log)('autoSwitch: logWatch pattern matched, triggering smart switch');
            await this.runTrigger('log');
        }
    }
    textMatchesAnyPattern(text) {
        for (const re of this._logMatchPatterns) {
            if (re.test(text))
                return true;
        }
        return false;
    }
    // ----------------- Trigger ------------------
    async runTrigger(trigger) {
        const now = Date.now();
        if (now - this._lastAutoSwitchMs < exports.AUTO_SWITCH_THROTTLE_MS) {
            (0, log_1.log)(`autoSwitch: throttled (${(now - this._lastAutoSwitchMs) / 1000 | 0}s since last auto switch)`);
            return;
        }
        this._lastAutoSwitchMs = now;
        try {
            const ok = await this.deps.trigger(trigger);
            (0, log_1.log)(`autoSwitch: trigger=${trigger} result=${ok ? 'switched' : 'no-switch'}`);
        }
        catch (e) {
            (0, log_1.log)(`autoSwitch: trigger=${trigger} failed:`, e?.message || e);
        }
    }
    /** Called after any manual switch to avoid immediately re-triggering. */
    noteExternalSwitch() {
        this._lastAutoSwitchMs = Date.now();
    }
}
exports.AutoSwitch = AutoSwitch;
//# sourceMappingURL=autoSwitch.js.map